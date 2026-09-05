import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { chromium } from 'playwright';
import sharp from 'sharp';
import * as XLSX from 'xlsx';
import { fileFormatForName, officePreviewExtensions, readableFileExtensions } from '../../formats.js';
import { convertOfficeFile } from '../libreoffice.js';
import { inspectRenderedPage, type OfficeArtifactIssue } from './validation.js';
import { officeRenderEnvironmentFingerprint } from './runtime-fingerprint.js';

export type FilePreviewResult = {
  imagePaths: string[];
  pageCount?: number;
  renderedPages: number[];
  renderer: 'image' | 'embedded-media' | 'html-preview' | 'libreoffice-pdf' | 'pdf' | 'unavailable';
  warning?: string;
  automaticChecks?: Array<{ pageNumber: number; width?: number; height?: number; issues: OfficeArtifactIssue[] }>;
};

type VisualCacheManifest = Pick<FilePreviewResult, 'automaticChecks' | 'pageCount' | 'renderer' | 'warning'>;

const defaultPreviewPages = [1, 2, 3, 4];
export const maxFilePreviewPagesPerRead = 8;
const htmlPageWidth = 960;
const htmlPageHeight = 1_358;
const officeExtensions = officePreviewExtensions();
const docxExtensions = new Set(['.docx']);
const spreadsheetExtensions = readableFileExtensions('spreadsheet');
const previewLocks = new Map<string, Promise<unknown>>();

async function writeCacheFile(target: string, data: Buffer | string) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function withPreviewLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = previewLocks.get(key) || Promise.resolve();
  const pending = previous.catch(() => undefined).then(operation);
  previewLocks.set(key, pending);
  try {
    return await pending;
  } finally {
    if (previewLocks.get(key) === pending) previewLocks.delete(key);
  }
}

export function normalizeFilePreviewPages(value: unknown, pageCount?: number) {
  const representative = pageCount && pageCount > maxFilePreviewPagesPerRead
    ? [1, 2, Math.max(3, Math.round(pageCount / 2)), Math.max(1, pageCount - 1), pageCount]
    : pageCount
      ? Array.from({ length: pageCount }, (_, index) => index + 1)
      : defaultPreviewPages;
  const source = Array.isArray(value) && value.length ? value : representative;
  const pages = Array.from(new Set(source
    .map((item) => Number(item))
    .filter((item) => Number.isSafeInteger(item) && item > 0 && (!pageCount || item <= pageCount))))
    .slice(0, maxFilePreviewPagesPerRead);
  if (pages.length) return pages;
  return pageCount ? [1] : defaultPreviewPages;
}

function previewDirectory(input: {
  buffer?: Buffer;
  cacheKey?: string;
  extension: string;
  root?: string;
}) {
  if (!input.buffer && !input.cacheKey) throw new Error('Attachment preview requires a source buffer or stable cache key.');
  const digest = createHash('sha256')
    .update('attachment-visual-v3-1400px\0')
    .update(input.extension)
    .update(input.cacheKey || input.buffer!)
    .digest('hex');
  const defaultRoot = process.env.CAPABILITY_FILE_PREVIEW_ROOT
    || path.join(os.tmpdir(), 'capability-file-previews');
  return path.join(input.root || defaultRoot, digest);
}

function pageImagePath(directory: string, pageNumber: number) {
  return path.join(directory, `page-${String(pageNumber).padStart(4, '0')}.png`);
}

async function existingCache(directory: string, requestedPages: unknown) {
  try {
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')) as VisualCacheManifest;
    const renderedPages = normalizeFilePreviewPages(requestedPages, manifest.pageCount);
    const imagePaths = renderedPages.map((pageNumber) => pageImagePath(directory, pageNumber));
    await Promise.all(imagePaths.map((filePath) => access(filePath, constants.R_OK)));
    return {
      ...manifest,
      automaticChecks: manifest.automaticChecks?.filter((check) => renderedPages.includes(check.pageNumber)),
      imagePaths,
      renderedPages,
    } satisfies FilePreviewResult;
  } catch {
    return undefined;
  }
}

async function writeManifest(directory: string, manifest: VisualCacheManifest) {
  const manifestPath = path.join(directory, 'manifest.json');
  let previous: VisualCacheManifest | undefined;
  try {
    previous = JSON.parse(await readFile(manifestPath, 'utf8')) as VisualCacheManifest;
  } catch {
    // A missing or invalid manifest is replaced by the current render result.
  }
  const compatiblePrevious = previous?.renderer === manifest.renderer ? previous : undefined;
  const checksByPage = new Map<number, NonNullable<VisualCacheManifest['automaticChecks']>[number]>();
  for (const check of compatiblePrevious?.automaticChecks || []) checksByPage.set(check.pageNumber, check);
  for (const check of manifest.automaticChecks || []) checksByPage.set(check.pageNumber, check);
  const automaticChecks = [...checksByPage.values()].sort((left, right) => left.pageNumber - right.pageNumber);
  await writeCacheFile(manifestPath, JSON.stringify({
    ...compatiblePrevious,
    ...manifest,
    ...(automaticChecks.length > 0 ? { automaticChecks } : {}),
  } satisfies VisualCacheManifest));
}

async function renderPdfPages(buffer: Buffer, directory: string, requestedPages: unknown, renderer: 'libreoffice-pdf' | 'pdf'): Promise<FilePreviewResult> {
  const cached = await existingCache(directory, requestedPages);
  if (cached && cached.renderer === 'pdf') return { ...cached, renderer };

  const parser = new PDFParse({ data: Buffer.from(buffer) });
  try {
    const info = await parser.getInfo();
    const renderedPages = normalizeFilePreviewPages(requestedPages, info.total);
    const missingPages = (await Promise.all(renderedPages.map(async (page) => (
      await access(pageImagePath(directory, page), constants.R_OK).then(() => undefined, () => page)
    )))).filter((page): page is number => page !== undefined);
    // A new request may overlap earlier batches. Rasterize only missing pages.
    if (!missingPages.length) {
      const automaticChecks = await Promise.all(renderedPages.map(async (pageNumber) => ({
        pageNumber, ...await inspectRenderedPage(pageImagePath(directory, pageNumber)),
      })));
      await writeManifest(directory, { automaticChecks, pageCount: info.total, renderer: 'pdf' });
      return { ...(await existingCache(directory, renderedPages))!, renderer };
    }
    const screenshots = await parser.getScreenshot({
      desiredWidth: 1_400,
      imageBuffer: true,
      imageDataUrl: false,
      partial: missingPages,
    });
    await mkdir(directory, { recursive: true });
    const imagePaths: string[] = [];
    for (const page of screenshots.pages) {
      const target = pageImagePath(directory, page.pageNumber);
      await writeCacheFile(target, Buffer.from(page.data));
      imagePaths.push(target);
    }
    const automaticChecks = await Promise.all(imagePaths.map(async (imagePath, index) => ({
      pageNumber: screenshots.pages[index].pageNumber,
      ...await inspectRenderedPage(imagePath),
    })));
    await writeManifest(directory, { automaticChecks, pageCount: screenshots.total, renderer: 'pdf' });
    const complete = await existingCache(directory, renderedPages);
    if (!complete) throw new Error('PDF renderer did not produce all requested pages.');
    return { ...complete, renderer };
  } finally {
    await parser.destroy();
  }
}

function escapedHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function renderHtmlPages(input: {
  body: string;
  directory: string;
  requestedPages: unknown;
  title: string;
}): Promise<FilePreviewResult> {
  const cached = await existingCache(input.directory, input.requestedPages);
  if (cached && cached.renderer === 'html-preview') return cached;

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
      viewport: { width: htmlPageWidth, height: htmlPageHeight },
    });
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith('data:') || url.startsWith('blob:')) await route.continue();
      else await route.abort();
    });
    const page = await context.newPage();
    await page.setContent(`<!doctype html>
      <html><head><meta charset="utf-8"><style>
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; width: ${htmlPageWidth}px; background: #fff; color: #111; }
        body { font-family: "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif; }
        .document { width: ${htmlPageWidth}px; min-height: ${htmlPageHeight}px; padding: 72px 84px; overflow-wrap: anywhere; }
        h1.document-title { margin: 0 0 28px; font-size: 18px; color: #666; font-weight: 500; }
        p { line-height: 1.65; margin: 0 0 10px; white-space: pre-wrap; }
        table { width: 100%; border-collapse: collapse; margin: 12px 0; break-inside: avoid; }
        td, th { border: 1px solid #777; padding: 6px 8px; vertical-align: top; }
        img, svg { max-width: 100%; height: auto; }
        pre { white-space: pre-wrap; }
      </style></head><body><main class="document">
        <h1 class="document-title">${escapedHtml(input.title)}</h1>${input.body}
      </main></body></html>`, { waitUntil: 'load' });
    await page.evaluate(async () => { await document.fonts.ready; });
    const contentHeight = await page.evaluate(() => Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
    ));
    const pageCount = Math.max(1, Math.ceil(contentHeight / htmlPageHeight));
    const renderedPages = normalizeFilePreviewPages(input.requestedPages, pageCount);
    await page.evaluate((minimumHeight) => { document.body.style.minHeight = `${minimumHeight}px`; }, pageCount * htmlPageHeight);
    await mkdir(input.directory, { recursive: true });
    const imagePaths: string[] = [];
    for (const pageNumber of renderedPages) {
      const target = pageImagePath(input.directory, pageNumber);
      await page.screenshot({
        path: target,
        clip: {
          x: 0,
          y: (pageNumber - 1) * htmlPageHeight,
          width: htmlPageWidth,
          height: htmlPageHeight,
        },
      });
      imagePaths.push(target);
    }
    const warning = '当前环境未配置 LibreOffice；这些页面是保留文字、表格和内嵌图片的 HTML 近似预览，最终版式仍应以原始 Office 文件为准。';
    await writeManifest(input.directory, { pageCount, renderer: 'html-preview', warning });
    await context.close();
    return {
      imagePaths,
      pageCount,
      renderedPages,
      renderer: 'html-preview',
      warning,
    } satisfies FilePreviewResult;
  } finally {
    await browser.close();
  }
}

async function convertOfficeToPdf(absolutePath: string, extension: string, directory: string) {
  const cachedPdfPath = path.join(directory, 'office-preview.pdf');
  try {
    return await readFile(cachedPdfPath);
  } catch {
    const pdf = await convertOfficeFile({ absolutePath, sourceExtension: extension, targetExtension: '.pdf' });
    if (pdf) {
      await mkdir(directory, { recursive: true });
      await writeCacheFile(cachedPdfPath, pdf);
    }
    return pdf;
  }
}

/** Associate an artifact with the PDF already exported by its UNO worker. */
export async function registerOfficePreview(input: {
  absolutePath: string; previewPath: string; extension: string; previewRoot?: string;
}) {
  if (!officeExtensions.has(input.extension.toLowerCase())) return;
  const [buffer, pdf, environment] = await Promise.all([
    readFile(input.absolutePath), readFile(input.previewPath), officeRenderEnvironmentFingerprint(),
  ]);
  const directory = previewDirectory({
    cacheKey: `${createHash('sha256').update(buffer).digest('hex')}:${environment}`,
    extension: input.extension.toLowerCase(), root: input.previewRoot,
  });
  await withPreviewLock(directory, async () => {
    await mkdir(directory, { recursive: true });
    const cachedPath = path.join(directory, 'office-preview.pdf');
    if (!(await readFile(cachedPath).catch(() => undefined))?.equals(pdf)) {
      await writeCacheFile(cachedPath, pdf);
    }
  });
}

async function renderSharedPdf(buffer: Buffer, requestedPages: unknown, root: string | undefined, renderer: 'pdf' | 'libreoffice-pdf') {
  const directory = previewDirectory({ buffer, extension: '.pdf', root });
  return withPreviewLock(directory, () => renderPdfPages(buffer, directory, requestedPages, renderer));
}

async function renderDocxFallback(buffer: Buffer, directory: string, requestedPages: unknown, title: string) {
  const converted = await mammoth.convertToHtml({ buffer: Buffer.from(buffer) });
  const warnings = converted.messages.map((message) => message.message).filter(Boolean);
  const result = await renderHtmlPages({ body: converted.value, directory, requestedPages, title });
  if (warnings.length) {
    result.warning = `${result.warning || ''} 转换提示：${warnings.slice(0, 5).join('；')}`.trim();
  }
  return result;
}

async function renderSpreadsheetFallback(buffer: Buffer, directory: string, requestedPages: unknown, title: string) {
  const workbook = XLSX.read(buffer, { cellDates: true, dense: false, type: 'buffer' });
  const body = workbook.SheetNames.map((sheetName) => (
    `<section><h2>${escapedHtml(sheetName)}</h2>${XLSX.utils.sheet_to_html(workbook.Sheets[sheetName])}</section>`
  )).join('<hr>');
  const result = await renderHtmlPages({ body, directory, requestedPages, title });
  result.warning = '当前环境未配置 LibreOffice；这些页面是工作表内容的 HTML 近似预览，不包含完整的 Excel 图表、打印区域和原始分页。';
  return result;
}

function mediaPrefix(extension: string) {
  if (extension === '.docx') return /^word\/media\//i;
  if (['.pptx', '.ppsx', '.potx'].includes(extension)) return /^ppt\/media\//i;
  if (['.xlsx', '.xlsm'].includes(extension)) return /^xl\/media\//i;
  if (['.odt', '.ods', '.odp'].includes(extension)) return /^Pictures\//i;
  return undefined;
}

async function extractEmbeddedMedia(buffer: Buffer, extension: string, directory: string) {
  const prefix = mediaPrefix(extension);
  if (!prefix) return { imagePaths: [], mediaCount: 0 };
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir && prefix.test(entry.name));
  await mkdir(directory, { recursive: true });
  const imagePaths: string[] = [];
  for (const [index, entry] of entries.slice(0, maxFilePreviewPagesPerRead).entries()) {
    try {
      const image = await sharp(await entry.async('nodebuffer'), { failOn: 'none' })
        .rotate()
        .resize({ width: 1_600, withoutEnlargement: true })
        .png()
        .toBuffer();
      const target = path.join(directory, `media-${String(index + 1).padStart(4, '0')}.png`);
      await writeFile(target, image);
      imagePaths.push(target);
    } catch {
      // Unsupported Office image formats such as WMF/EMF remain listed in the semantic manifest.
    }
  }
  return { imagePaths, mediaCount: entries.length };
}

export async function renderFilePreview(input: {
  absolutePath: string;
  buffer?: Buffer;
  cacheKey?: string;
  extension: string;
  name: string;
  pages?: unknown;
  previewRoot?: string;
}): Promise<FilePreviewResult> {
  const extension = input.extension.toLowerCase();
  // Source bytes, not action names/artifact IDs, determine preview identity.
  let sourceBuffer: Buffer;
  try {
    sourceBuffer = input.buffer || await readFile(input.absolutePath);
  } catch (error) {
    return { imagePaths: [], renderedPages: [], renderer: 'unavailable',
      warning: `附件视觉预览无法读取源文件：${error instanceof Error ? error.message : String(error)}` };
  }
  const environment = officeExtensions.has(extension) ? await officeRenderEnvironmentFingerprint() : '';
  const directory = previewDirectory({
    buffer: sourceBuffer,
    ...(environment ? { cacheKey: `${createHash('sha256').update(sourceBuffer).digest('hex')}:${environment}` } : {}),
    extension,
    root: input.previewRoot,
  });
  const getSourceBuffer = async () => sourceBuffer;
  try {
    if (fileFormatForName(`source${extension}`)?.kind === 'image') {
      return await withPreviewLock(directory, async () => {
        const cached = await existingCache(directory, [1]);
        if (cached?.renderer === 'image') return cached;
        // Send actual pixels, not just dimensions. Preserve the original asset
        // and normalize orientation/resolution only in this content-addressed cache.
        const image = await sharp(sourceBuffer).rotate()
          .resize({ width: 1_600, height: 1_600, fit: 'inside', withoutEnlargement: true })
          .png().toBuffer();
        await mkdir(directory, { recursive: true });
        const target = pageImagePath(directory, 1);
        await writeCacheFile(target, image);
        await writeManifest(directory, { pageCount: 1, renderer: 'image' });
        return { imagePaths: [target], pageCount: 1, renderedPages: [1], renderer: 'image' } satisfies FilePreviewResult;
      });
    }
    if (extension === '.pdf') {
      return await renderSharedPdf(sourceBuffer, input.pages, input.previewRoot, 'pdf');
    }
    if (officeExtensions.has(extension)) {
      const pdf = await withPreviewLock(directory, async () => {
        // Convert the same byte snapshot used for the cache key, even if an
        // upload/caller replaces the original file while this job is queued.
        const snapshotPath = path.join(directory, `source${extension}`);
        await mkdir(directory, { recursive: true });
        try {
          await access(path.join(directory, 'office-preview.pdf'), constants.R_OK);
        } catch {
          await writeCacheFile(snapshotPath, sourceBuffer);
        }
        try {
          return await convertOfficeToPdf(snapshotPath, extension, directory);
        } finally {
          await unlink(snapshotPath).catch(() => undefined);
        }
      });
      if (pdf) return await renderSharedPdf(pdf, input.pages, input.previewRoot, 'libreoffice-pdf');
      if (docxExtensions.has(extension)) {
        return await renderDocxFallback(await getSourceBuffer(), directory, input.pages, input.name);
      }
      if (spreadsheetExtensions.has(extension)) {
        return await renderSpreadsheetFallback(await getSourceBuffer(), directory, input.pages, input.name);
      }
      const media = await extractEmbeddedMedia(await getSourceBuffer(), extension, directory);
      return {
        imagePaths: media.imagePaths,
        renderedPages: [],
        renderer: media.imagePaths.length ? 'embedded-media' : 'unavailable',
        warning: media.imagePaths.length
          ? `当前环境未配置 LibreOffice，无法还原原始页面版式；已将 ${media.imagePaths.length}/${media.mediaCount} 个可解码内嵌媒体交给视觉模型。`
          : '当前环境未配置 LibreOffice，且附件中没有可直接交给视觉模型的可解码内嵌媒体。',
      };
    }
    return { imagePaths: [], renderedPages: [], renderer: 'unavailable' };
  } catch (error) {
    const media = await getSourceBuffer()
      .then((buffer) => extractEmbeddedMedia(buffer, extension, directory))
      .catch(() => ({ imagePaths: [], mediaCount: 0 }));
    const reason = error instanceof Error ? error.message : String(error);
    return {
      imagePaths: media.imagePaths,
      renderedPages: [],
      renderer: media.imagePaths.length ? 'embedded-media' : 'unavailable',
      warning: `附件视觉预览失败：${reason}${media.imagePaths.length ? `；已回退提供 ${media.imagePaths.length}/${media.mediaCount} 个内嵌媒体。` : ''}`,
    };
  }
}
