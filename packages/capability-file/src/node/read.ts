import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import sharp from 'sharp';
import { fileFormatForName, normalizedFileExtension } from '../formats.js';
import type { FileVisualToolInput } from '../types.js';
import type {
  OfficeVisualQaDeckChecks,
  OfficeVisualQaPageChecks,
} from '../office/types.js';
import { inspectDocxTemplateBuffer } from './office/docx-template.js';
import { renderFilePreview } from './office/preview.js';
import { extractFileTextInWorker } from './text-extraction.js';

export type FileReadableAttachment = {
  id: string;
  kind?: 'file' | 'image' | 'tab';
  name: string;
  path: string;
  size?: number;
  sourceUrl?: string;
  type: string;
  url: string;
};

export type FileAttachmentReadResult = {
  actual: string;
  ok: boolean;
  referenceImagePaths?: string[];
};

export type FileVisualInput = FileVisualToolInput;

export const FILE_READ_MIN_CHARACTERS = 20_000;
export const FILE_READ_MAX_CHARACTERS = 40_000;

export function normalizeFileReadLimit(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number)
    ? Math.min(FILE_READ_MAX_CHARACTERS, Math.max(FILE_READ_MIN_CHARACTERS, Math.floor(number)))
    : FILE_READ_MIN_CHARACTERS;
}

const visualQaPageCheckNames = [
  'overlap', 'clipping', 'alignment', 'spacing', 'typography', 'contrast',
  'visualHierarchy', 'chartTableLegibility', 'imageQuality',
] as const;
const visualQaDeckCheckNames = [
  'templateConsistency', 'typographyConsistency', 'colorConsistency',
  'spacingRhythm', 'componentConsistency',
] as const;

function assertVisualQaPageChecks(checks: OfficeVisualQaPageChecks | undefined, label: string) {
  if (!checks || typeof checks !== 'object') throw new Error(`${label} requires all visual-quality checks`);
  const failed: string[] = [];
  for (const name of visualQaPageCheckNames) {
    const status = checks[name];
    if (status !== 'passed' && status !== 'failed' && status !== 'not-applicable') throw new Error(`${label} requires check ${name}`);
    if (status === 'not-applicable' && name !== 'chartTableLegibility' && name !== 'imageQuality') throw new Error(`${label} cannot mark ${name} not-applicable`);
    if (status === 'failed') failed.push(name);
  }
  return failed;
}

function assertVisualQaDeckChecks(checks: OfficeVisualQaDeckChecks | undefined) {
  if (!checks || typeof checks !== 'object') throw new Error('deckReview requires all cross-page consistency checks');
  const failed: string[] = [];
  for (const name of visualQaDeckCheckNames) {
    const status = checks[name];
    if (status !== 'passed' && status !== 'failed') throw new Error(`deckReview requires check ${name}`);
    if (status === 'failed') failed.push(name);
  }
  return failed;
}

type AttachmentKind = 'archive' | 'image' | 'pdf' | 'presentation' | 'spreadsheet' | 'tab' | 'text' | 'unknown' | 'word';

function normalizedOffset(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function extensionOf(attachment: FileReadableAttachment) {
  return normalizedFileExtension(attachment.name);
}

function formatSize(size?: number) {
  if (!size || size < 1024) return `${size || 0} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentKind(attachment: FileReadableAttachment): AttachmentKind {
  const format = fileFormatForName(attachment.name);
  if (attachment.kind === 'image' || attachment.type.startsWith('image/') || format?.kind === 'image') return 'image';
  if (attachment.kind === 'tab') return 'tab';
  if (attachment.type === 'application/pdf' || format?.kind === 'pdf') return 'pdf';
  if (format?.canRead && format.kind !== 'binary') return format.kind;
  if (attachment.type.startsWith('text/')) return 'text';
  return 'unknown';
}

export function isImageFileAttachment(attachment: FileReadableAttachment) {
  return attachmentKind(attachment) === 'image';
}

export function fileAttachmentMetadata(attachment: FileReadableAttachment) {
  return `[文件] ${attachment.name} | attachmentId: ${attachment.id} | 类型: ${attachment.type || 'unknown'} | 大小: ${formatSize(attachment.size)} | 仅在任务需要分析文件内容时调用 file action=read；纯上传不要读取或重建内容，使用浏览器运行时提供的受控附件上传接口。`;
}

async function extractAttachmentText(attachment: FileReadableAttachment, absolutePath?: string, reusableBuffer?: Buffer) {
  const kind = attachmentKind(attachment);
  if (kind === 'image') {
    if (!absolutePath) throw new Error('Could not locate the saved image artifact.');
    const buffer = reusableBuffer || await readFile(absolutePath);
    const metadata = await sharp(buffer, { failOn: 'none' }).metadata();
    const rawWidth = metadata.width || 0;
    const rawHeight = metadata.height || 0;
    const swapsAxes = [5, 6, 7, 8].includes(metadata.orientation || 0);
    const width = swapsAxes ? rawHeight : rawWidth;
    const height = swapsAxes ? rawWidth : rawHeight;
    return [
      '[Image artifact metadata]',
      `Name: ${attachment.name}`,
      `Saved bytes: ${buffer.byteLength}`,
      `Format: ${metadata.format || extensionOf(attachment).replace(/^\./, '') || 'unknown'}`,
      `Dimensions: ${width || 'unknown'} x ${height || 'unknown'} px`,
      `Aspect ratio: ${width && height ? (width / height).toFixed(6) : 'unknown'}`,
      ...(metadata.orientation ? [`EXIF orientation: ${metadata.orientation}`] : []),
      'These values were read from the exact saved artifact bytes. Use them for Office layout instead of probing the remote source URL in browserCode.',
    ].join('\n');
  }
  if (kind === 'tab') return `[标签页引用：${attachment.sourceUrl || attachment.url || attachment.name}]`;
  if (!absolutePath) throw new Error('无法定位文件，无法解析。');
  const extracted = await extractFileTextInWorker({ extension: extensionOf(attachment), kind, path: absolutePath });
  if (extensionOf(attachment) !== '.docx') return extracted;
  const buffer = reusableBuffer || await readFile(absolutePath);
  if (!buffer.byteLength) throw new Error('文件内容为空，无法解析。');
  const structure = await inspectDocxTemplateBuffer(buffer);
  const rows = structure.rows.map((row) => (
    `表格行 ${row.index}: ${row.cells.map((cell, index) => `单元格${index + 1}=${cell ? JSON.stringify(cell) : '[空]'}`).join(' | ')}`
  ));
  return [
    '[DOCX 模板结构]',
    `包部件 ${structure.partCount}；节 ${structure.sectionCount}；表格 ${structure.tableCount}；段落 ${structure.paragraphCount}；样式 ${structure.styleCount}；关系 ${structure.relationshipCount}`,
    `视觉对象：绘图 ${structure.drawingCount}；文本框 ${structure.textBoxCount}；内容控件 ${structure.contentControlCount}；内嵌媒体 ${structure.mediaCount}`,
    `扩展内容：页眉 ${structure.headerCount}；页脚 ${structure.footerCount}；批注 ${structure.commentCount}；脚注 ${structure.footnoteCount}；尾注 ${structure.endnoteCount}`,
    ...(structure.mediaParts.length ? [`媒体部件：${structure.mediaParts.join(' | ')}`] : []),
    ...(structure.headerTexts.length ? [`页眉文本：${structure.headerTexts.map((text) => JSON.stringify(text)).join(' | ')}`] : []),
    ...(structure.footerTexts.length ? [`页脚文本：${structure.footerTexts.map((text) => JSON.stringify(text)).join(' | ')}`] : []),
    ...(structure.commentTexts.length ? [`批注文本：${structure.commentTexts.map((text) => JSON.stringify(text)).join(' | ')}`] : []),
    ...(structure.footnoteTexts.length ? [`脚注文本：${structure.footnoteTexts.map((text) => JSON.stringify(text)).join(' | ')}`] : []),
    ...(structure.endnoteTexts.length ? [`尾注文本：${structure.endnoteTexts.map((text) => JSON.stringify(text)).join(' | ')}`] : []),
    '原始 DOCX 包会一直保留；file action=read 只提取结构和预览，不会改写原文件。',
    ...rows,
    ...(structure.followingParagraphAnchors.length ? [
      `标题后空段落候选：${structure.followingParagraphAnchors.map((anchor) => JSON.stringify(anchor)).join(' | ')}`,
    ] : []),
    '',
    '[DOCX 正文文本]',
    extracted,
  ].join('\n');
}

export async function readFileAttachment(input: {
  attachment: FileReadableAttachment;
  absolutePath?: string;
  includeVisuals?: boolean;
  limit?: unknown;
  offset?: unknown;
  pages?: unknown;
  previewRoot?: string;
}): Promise<FileAttachmentReadResult> {
  const { attachment } = input;
  if (!input.absolutePath && attachment.kind !== 'tab') {
    return { ok: false, actual: `无法定位上传文件：${attachment.name}` };
  }
  try {
    const size = attachment.kind === 'tab' ? attachment.size : (await stat(input.absolutePath!)).size;
    const resolvedAttachment = size === attachment.size ? attachment : { ...attachment, size };
    if (attachment.kind !== 'tab' && size === 0) throw new Error('文件内容为空，无法解析。');
    const kind = attachmentKind(resolvedAttachment);
    const buffer = input.includeVisuals && kind !== 'tab' && kind !== 'image'
      ? await readFile(input.absolutePath!)
      : undefined;
    const [content, visuals] = await Promise.all([
      extractAttachmentText(resolvedAttachment, input.absolutePath, buffer),
      input.includeVisuals && buffer
        ? renderFilePreview({
            absolutePath: input.absolutePath!,
            buffer,
            extension: extensionOf(resolvedAttachment),
            name: resolvedAttachment.name,
            pages: input.pages,
            previewRoot: input.previewRoot,
          })
        : undefined,
    ]);
    const offset = normalizedOffset(input.offset);
    const limit = normalizeFileReadLimit(input.limit);
    const slice = content.slice(offset, offset + limit);
    const nextOffset = offset + slice.length;
    const visualSummary = visuals ? [
      `视觉内容：渲染器=${visuals.renderer}${visuals.pageCount ? `；总页数=${visuals.pageCount}` : ''}${visuals.renderedPages.length ? `；本次页面=${visuals.renderedPages.join(',')}` : ''}${visuals.imagePaths.length ? `；已向下一轮模型请求附加 ${visuals.imagePaths.length} 张图像` : ''}`,
      visuals.warning || '',
    ].filter(Boolean) : [];
    return {
      ok: true,
      actual: [
        `文件：${resolvedAttachment.name}`,
        `类型：${resolvedAttachment.type || 'unknown'}；大小：${formatSize(resolvedAttachment.size)}；解析器：${attachmentKind(resolvedAttachment)}`,
        '原始附件：服务器保留原始字节；文本、结构和视觉预览均从该原件按需派生。',
        ...visualSummary,
        `字符区间：${offset}-${nextOffset} / ${content.length}${nextOffset < content.length ? `；仍有内容，下次 offset=${nextOffset}` : '；已到末尾'}`,
        '',
        slice || '[该区间没有可读文本]',
      ].join('\n'),
      referenceImagePaths: visuals?.imagePaths.length ? visuals.imagePaths : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法读取文件内容。';
    return { ok: false, actual: `读取文件 ${attachment.name} 失败：${message}` };
  }
}

function screenshotId(pageNumber: number) {
  return `screenshot-${String(pageNumber).padStart(4, '0')}`;
}

function screenshotPage(value: string) {
  const match = /^screenshot-(\d{1,8})$/i.exec(value.trim());
  if (!match) return undefined;
  const pageNumber = Number(match[1]);
  return Number.isSafeInteger(pageNumber) && pageNumber > 0 ? pageNumber : undefined;
}

/**
 * Lazily indexes or reads rendered pages for one conversation artifact.
 * Indexing returns stable screenshot ids without attaching images. Reading a
 * bounded id batch returns image paths that the executor adds to the next
 * model request.
 */
export async function readFileVisuals(input: {
  attachment: FileReadableAttachment;
  absolutePath?: string;
  request: FileVisualInput;
  previewRoot?: string;
}): Promise<FileAttachmentReadResult> {
  const { attachment, request } = input;
  if (!input.absolutePath) {
    return { ok: false, actual: `file action=visualIndex could not locate artifact ${request.artifactId}.` };
  }
  if (attachmentKind(attachment) === 'image' || attachmentKind(attachment) === 'tab') {
    return { ok: false, actual: 'File visual actions support paged PDF and Office artifacts, not standalone images or tab references.' };
  }

  try {
    const metadata = await stat(input.absolutePath);
    if (!metadata.size) throw new Error('artifact is empty');
    if (request.action === 'report') {
      if (!request.reviews?.length) return { ok: false, actual: 'file action=visualReport requires at least one page review.' };
      const reviews = request.reviews.map((review) => {
        const pageNumber = screenshotPage(review.screenshotId);
        if (!pageNumber) throw new Error(`invalid screenshotId in visual review: ${review.screenshotId}`);
        const issues = (review.issues || []).map((issue) => ({
          type: String(issue.type || '').trim(),
          description: String(issue.description || '').trim(),
          ...(issue.region ? { region: String(issue.region).trim() } : {}),
          ...(issue.severity ? { severity: issue.severity } : {}),
        })).filter((issue) => issue.type && issue.description);
        const observation = String(review.observation || '').trim();
        if (observation.length < 20) throw new Error(`review ${review.screenshotId} requires a concrete visual observation of at least 20 characters`);
        const failedChecks = assertVisualQaPageChecks(review.checks, `review ${review.screenshotId}`);
        if (review.status === 'passed' && issues.length) throw new Error(`passed review ${review.screenshotId} cannot contain issues`);
        if (review.status === 'failed' && !issues.length) throw new Error(`failed review ${review.screenshotId} requires at least one issue`);
        if (review.status === 'passed' && failedChecks.length) throw new Error(`passed review ${review.screenshotId} cannot contain failed checks`);
        if (review.status === 'failed' && !failedChecks.length) throw new Error(`failed review ${review.screenshotId} requires at least one failed check`);
        return { screenshotId: review.screenshotId, pageNumber, status: review.status, observation, checks: review.checks, issues };
      });
      const deckReview = request.deckReview ? {
        status: request.deckReview.status,
        observation: String(request.deckReview.observation || '').trim(),
        checks: request.deckReview.checks,
        issues: (request.deckReview.issues || []).map((issue) => ({
          type: String(issue.type || '').trim(),
          description: String(issue.description || '').trim(),
          ...(issue.region ? { region: String(issue.region).trim() } : {}),
          ...(issue.severity ? { severity: issue.severity } : {}),
        })).filter((issue) => issue.type && issue.description),
      } : undefined;
      if (deckReview && deckReview.observation.length < 30) throw new Error('deckReview requires a concrete cross-page observation of at least 30 characters');
      const failedDeckChecks = deckReview ? assertVisualQaDeckChecks(deckReview.checks) : [];
      if (deckReview?.status === 'passed' && deckReview.issues.length) throw new Error('passed deckReview cannot contain issues');
      if (deckReview?.status === 'failed' && !deckReview.issues.length) throw new Error('failed deckReview requires at least one issue');
      if (deckReview?.status === 'passed' && failedDeckChecks.length) throw new Error('passed deckReview cannot contain failed checks');
      if (deckReview?.status === 'failed' && !failedDeckChecks.length) throw new Error('failed deckReview requires at least one failed check');
      return {
        ok: true,
        actual: JSON.stringify({
          kind: 'file-visual-report',
          artifactId: request.artifactId,
          fileName: attachment.name,
          reviews,
          ...(deckReview ? { deckReview } : {}),
          instruction: reviews.some((review) => review.status === 'failed') || deckReview?.status === 'failed'
            ? 'Fix every reported issue, render a replacement artifact, and restart visual QA from index.'
            : 'Continue reading and reporting unreviewed pages until every indexed page has an evidence-backed passed review, then submit a passed deckReview comparing cross-page consistency.',
        }),
      };
    }
    const requestedScreenshotIds = Array.from(new Set((request.screenshotIds || []).map((value) => value.trim()).filter(Boolean)));
    if (request.action === 'read' && !requestedScreenshotIds.length) {
      return { ok: false, actual: 'file action=visualRead requires at least one screenshotId returned by action=visualIndex.' };
    }
    if (requestedScreenshotIds.length > 8) {
      return { ok: false, actual: 'file action=visualRead accepts at most 8 screenshotIds per call. Read larger documents in ordered batches.' };
    }
    const requestedPages = requestedScreenshotIds.map(screenshotPage);
    if (request.action === 'read' && requestedPages.some((page) => page === undefined)) {
      return { ok: false, actual: 'file action=visualRead received an invalid screenshotId. Use the exact screenshot-NNNN ids returned by action=visualIndex.' };
    }

    const visuals = await renderFilePreview({
      absolutePath: input.absolutePath,
      cacheKey: `${request.artifactId}\0${metadata.size}\0${metadata.mtimeMs}`,
      extension: extensionOf(attachment),
      name: attachment.name,
      pages: request.action === 'read' ? requestedPages : [1],
      previewRoot: input.previewRoot,
    });
    const screenshotCount = visuals.pageCount;
    if (typeof screenshotCount !== 'number' || !Number.isSafeInteger(screenshotCount) || screenshotCount < 1) {
      return {
        ok: false,
        actual: `File visual inspection could not create a paged preview for ${attachment.name}.${visuals.warning ? ` ${visuals.warning}` : ''}`,
      };
    }

    if (request.action === 'index') {
      const offset = Math.min(Math.max(0, Math.floor(request.offset || 0)), screenshotCount);
      const limit = Math.min(Math.max(1, Math.floor(request.limit || 100)), 200);
      const end = Math.min(screenshotCount, offset + limit);
      const screenshots = Array.from({ length: end - offset }, (_, index) => {
        const pageNumber = offset + index + 1;
        return { screenshotId: screenshotId(pageNumber), pageNumber };
      });
      return {
        ok: true,
        actual: JSON.stringify({
          kind: 'file-visual-index',
          artifactId: request.artifactId,
          fileName: attachment.name,
          screenshotCount,
          screenshots,
          offset,
          nextOffset: end < screenshotCount ? end : null,
          renderer: visuals.renderer,
          warning: visuals.warning,
          automaticChecks: visuals.automaticChecks || [],
          automaticCheckScope: 'render-integrity-only: dimensions and near-blank detection; this is not a visual-quality verdict',
          instruction: 'Call file action=visualRead with one to eight exact screenshotIds. Continue in ordered batches until every required page has been inspected.',
        }),
      };
    }

    const imagePathByPage = new Map(visuals.renderedPages.map((pageNumber, index) => [pageNumber, visuals.imagePaths[index]]));
    const missing = (requestedPages as number[]).filter((pageNumber) => !imagePathByPage.get(pageNumber));
    const orderedImagePaths = (requestedPages as number[]).map((pageNumber) => imagePathByPage.get(pageNumber)).filter((value): value is string => Boolean(value));
    if (missing.length || orderedImagePaths.length !== requestedPages.length) {
      return {
        ok: false,
        actual: `file action=visualRead could not render requested screenshot pages: ${missing.length ? missing.join(', ') : 'renderer returned an incomplete image set'}.`,
      };
    }
    const screenshotRecords = await Promise.all((requestedPages as number[]).map(async (pageNumber) => {
      const imagePath = imagePathByPage.get(pageNumber)!;
      return {
        screenshotId: screenshotId(pageNumber),
        pageNumber,
        screenshotDigest: createHash('sha256').update(await readFile(imagePath)).digest('hex'),
      };
    }));
    return {
      ok: true,
      actual: JSON.stringify({
        kind: 'file-visual-read',
        artifactId: request.artifactId,
        fileName: attachment.name,
        screenshotCount,
        screenshots: screenshotRecords,
        renderer: visuals.renderer,
        warning: visuals.warning,
        automaticChecks: visuals.automaticChecks || [],
        automaticCheckScope: 'render-integrity-only: dimensions and near-blank detection; this is not a visual-quality verdict',
        instruction: 'The requested screenshots are attached to the next model request. Inspect the actual pixels at a useful size: overlap, clipping, alignment, spacing, typography, contrast, hierarchy, composition, chart/table legibility, and image quality. Every chart must identify what each mark represents; reject 1/2/3 placeholder categories, generic-only series names, and missing or unreadable legends, axes, or data labels. Images must be contextually identified or captioned and carry alt/source attribution when required. A known visible defect cannot be waived as a compatibility limitation, and a bare passed result is invalid.',
      }),
      referenceImagePaths: orderedImagePaths,
    };
  } catch (error) {
    return {
      ok: false,
      actual: `File visual inspection failed for ${attachment.name}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
