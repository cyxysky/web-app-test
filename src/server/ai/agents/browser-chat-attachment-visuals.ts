import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { chromium } from 'playwright';
import sharp from 'sharp';
import * as XLSX from 'xlsx';
import { artifactsRoot } from '@/server/storage/paths';

export type BrowserChatAttachmentVisualResult = {
  imagePaths: string[];
  pageCount?: number;
  renderedPages: number[];
  renderer: 'embedded-media' | 'html-preview' | 'libreoffice-pdf' | 'pdf' | 'unavailable';
  warning?: string;
};

type VisualCacheManifest = Pick<BrowserChatAttachmentVisualResult, 'pageCount' | 'renderer' | 'warning'>;

const defaultPreviewPages = [1, 2, 3, 4];
const maxPreviewPagesPerRead = 6;
const htmlPageWidth = 960;
const htmlPageHeight = 1_358;
const officeExtensions = new Set([
  '.doc', '.docx', '.odt',
  '.ppt', '.pptx', '.pps', '.ppsx', '.pot', '.potx', '.odp',
  '.xls', '.xlsx', '.xlsb', '.xlsm', '.ods',
]);
const docxExtensions = new Set(['.docx']);
const spreadsheetExtensions = new Set(['.xls', '.xlsx', '.xlsm', '.xlsb', '.ods']);

function normalizedPages(value: unknown, pageCount?: number) {
  const source = Array.isArray(value) && value.length ? value : defaultPreviewPages;
  const pages = Array.from(new Set(source
    .map((item) => Number(item))
    .filter((item) => Number.isSafeInteger(item) && item > 0 && (!pageCount || item <= pageCount))))
    .slice(0, maxPreviewPagesPerRead);
  if (pages.length) return pages;
  return pageCount ? [1] : defaultPreviewPages;
}

function previewDirectory(buffer: Buffer, extension: string, root = path.join(artifactsRoot(), 'attachment-previews')) {
  const digest = createHash('sha256')
    .update('attachment-visual-v1\0')
    .update(extension)
    .update(buffer)
    .digest('hex');
  return path.join(root, digest);
}

function pageImagePath(directory: string, pageNumber: number) {
  return path.join(directory, `page-${String(pageNumber).padStart(4, '0')}.png`);
}

async function existingCache(directory: string, requestedPages: unknown) {
  try {
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')) as VisualCacheManifest;
    const renderedPages = normalizedPages(requestedPages, manifest.pageCount);
    const imagePaths = renderedPages.map((pageNumber) => pageImagePath(directory, pageNumber));
    await Promise.all(imagePaths.map((filePath) => access(filePath, constants.R_OK)));
    return { ...manifest, imagePaths, renderedPages } satisfies BrowserChatAttachmentVisualResult;
  } catch {
    return undefined;
  }
}

async function writeManifest(directory: string, manifest: VisualCacheManifest) {
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest), 'utf8');
}

async function renderPdfPages(buffer: Buffer, directory: string, requestedPages: unknown, renderer: 'libreoffice-pdf' | 'pdf') {
  const cached = await existingCache(directory, requestedPages);
  if (cached && cached.renderer === renderer) return cached;

  const parser = new PDFParse({ data: Buffer.from(buffer) });
  try {
    const info = await parser.getInfo();
    const renderedPages = normalizedPages(requestedPages, info.total);
    const screenshots = await parser.getScreenshot({
      desiredWidth: 1_400,
      imageBuffer: true,
      imageDataUrl: false,
      partial: renderedPages,
    });
    await mkdir(directory, { recursive: true });
    const imagePaths: string[] = [];
    for (const page of screenshots.pages) {
      const target = pageImagePath(directory, page.pageNumber);
      await writeFile(target, Buffer.from(page.data));
      imagePaths.push(target);
    }
    await writeManifest(directory, { pageCount: screenshots.total, renderer });
    return {
      imagePaths,
      pageCount: screenshots.total,
      renderedPages: screenshots.pages.map((page) => page.pageNumber),
      renderer,
    } satisfies BrowserChatAttachmentVisualResult;
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
}): Promise<BrowserChatAttachmentVisualResult> {
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
    const renderedPages = normalizedPages(input.requestedPages, pageCount);
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
    } satisfies BrowserChatAttachmentVisualResult;
  } finally {
    await browser.close();
  }
}

async function resolveLibreOfficeExecutable() {
  const configured = String(process.env.LIBREOFFICE_PATH || '').trim();
  const candidates = [
    configured,
    process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'LibreOffice', 'program', 'soffice.exe') : '',
    process.platform === 'win32' ? path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'LibreOffice', 'program', 'soffice.exe') : '',
    ...String(process.env.PATH || '').split(path.delimiter).flatMap((directory) => {
      const clean = directory.replace(/^"|"$/g, '').trim();
      if (!clean) return [];
      return process.platform === 'win32'
        ? [path.join(clean, 'soffice.exe'), path.join(clean, 'libreoffice.exe')]
        : [path.join(clean, 'soffice'), path.join(clean, 'libreoffice')];
    }),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching configured and PATH candidates.
    }
  }
  return undefined;
}

function runExecutable(executable: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    execFile(executable, args, { maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function convertOfficeToPdf(absolutePath: string, extension: string) {
  const executable = await resolveLibreOfficeExecutable();
  if (!executable) return undefined;
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-office-render-'));
  try {
    const sourcePath = path.join(temporaryDirectory, `source${extension}`);
    const outputDirectory = path.join(temporaryDirectory, 'output');
    const profileDirectory = path.join(temporaryDirectory, 'profile');
    await Promise.all([
      copyFile(absolutePath, sourcePath),
      mkdir(outputDirectory, { recursive: true }),
      mkdir(profileDirectory, { recursive: true }),
    ]);
    await runExecutable(executable, [
      '--headless',
      '--nologo',
      '--nodefault',
      '--nolockcheck',
      `-env:UserInstallation=${pathToFileURL(profileDirectory).href}`,
      '--convert-to',
      'pdf',
      '--outdir',
      outputDirectory,
      sourcePath,
    ]);
    const outputName = (await readdir(outputDirectory)).find((name) => path.extname(name).toLowerCase() === '.pdf');
    if (!outputName) throw new Error('LibreOffice did not produce a PDF preview.');
    return await readFile(path.join(outputDirectory, outputName));
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
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
  for (const [index, entry] of entries.slice(0, maxPreviewPagesPerRead).entries()) {
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

export async function renderBrowserChatAttachmentVisuals(input: {
  absolutePath: string;
  buffer: Buffer;
  extension: string;
  name: string;
  pages?: unknown;
  previewRoot?: string;
}): Promise<BrowserChatAttachmentVisualResult> {
  const extension = input.extension.toLowerCase();
  const directory = previewDirectory(input.buffer, extension, input.previewRoot);
  try {
    if (extension === '.pdf') return await renderPdfPages(input.buffer, directory, input.pages, 'pdf');
    if (officeExtensions.has(extension)) {
      const pdf = await convertOfficeToPdf(input.absolutePath, extension);
      if (pdf) return await renderPdfPages(pdf, directory, input.pages, 'libreoffice-pdf');
      if (docxExtensions.has(extension)) {
        return await renderDocxFallback(input.buffer, directory, input.pages, input.name);
      }
      if (spreadsheetExtensions.has(extension)) {
        return await renderSpreadsheetFallback(input.buffer, directory, input.pages, input.name);
      }
      const media = await extractEmbeddedMedia(input.buffer, extension, directory);
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
    const media = await extractEmbeddedMedia(input.buffer, extension, directory).catch(() => ({ imagePaths: [], mediaCount: 0 }));
    const reason = error instanceof Error ? error.message : String(error);
    return {
      imagePaths: media.imagePaths,
      renderedPages: [],
      renderer: media.imagePaths.length ? 'embedded-media' : 'unavailable',
      warning: `附件视觉预览失败：${reason}${media.imagePaths.length ? `；已回退提供 ${media.imagePaths.length}/${media.mediaCount} 个内嵌媒体。` : ''}`,
    };
  }
}
