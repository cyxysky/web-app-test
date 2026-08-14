import { readFile, stat } from 'node:fs/promises';
import { extractAttachmentTextInWorker } from '@/server/runtime/cpu-worker-pool';
import { fileFormatForName, normalizedFileExtension } from '@/server/files/file-format-registry';
import { normalizeBrowserChatFileReadLimit } from './browser-chat-file-read';
import { renderBrowserChatAttachmentVisuals } from './browser-chat-attachment-visuals';
import { inspectDocxTemplateBuffer } from './docx-template-filler';

export type BrowserChatReadableAttachment = {
  id: string;
  kind?: 'file' | 'image' | 'tab';
  name: string;
  path: string;
  size?: number;
  sourceUrl?: string;
  type: string;
  url: string;
};

export type BrowserChatAttachmentReadResult = {
  actual: string;
  ok: boolean;
  referenceImagePaths?: string[];
};

type AttachmentKind = 'archive' | 'image' | 'pdf' | 'presentation' | 'spreadsheet' | 'tab' | 'text' | 'unknown' | 'word';

const maxSourceBytes = 64 * 1024 * 1024;

function normalizedOffset(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function extensionOf(attachment: BrowserChatReadableAttachment) {
  return normalizedFileExtension(attachment.name);
}

function formatSize(size?: number) {
  if (!size || size < 1024) return `${size || 0} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentKind(attachment: BrowserChatReadableAttachment): AttachmentKind {
  const format = fileFormatForName(attachment.name);
  if (attachment.kind === 'image' || attachment.type.startsWith('image/') || format?.kind === 'image') return 'image';
  if (attachment.kind === 'tab') return 'tab';
  if (attachment.type === 'application/pdf' || format?.kind === 'pdf') return 'pdf';
  if (format?.canRead && format.kind !== 'binary') return format.kind;
  if (attachment.type.startsWith('text/')) return 'text';
  return 'unknown';
}

export function isBrowserChatImageAttachment(attachment: BrowserChatReadableAttachment) {
  return attachmentKind(attachment) === 'image';
}

export function browserChatAttachmentMetadata(attachment: BrowserChatReadableAttachment) {
  return `[文件] ${attachment.name} | attachmentId: ${attachment.id} | 类型: ${attachment.type || 'unknown'} | 大小: ${formatSize(attachment.size)} | 仅在任务需要分析文件内容时调用 readFile；纯上传不要读取或重建内容，使用浏览器运行时提供的受控附件上传接口。`;
}

async function extractAttachmentText(attachment: BrowserChatReadableAttachment, buffer?: Buffer) {
  const kind = attachmentKind(attachment);
  if (kind === 'tab') return `[标签页引用：${attachment.sourceUrl || attachment.url || attachment.name}]`;
  if (kind === 'image') return '[图片附件：原始图片会作为图像输入交给支持视觉的模型。]';
  if (!buffer?.byteLength) throw new Error('文件内容为空，无法解析。');
  const extracted = await extractAttachmentTextInWorker({ buffer, extension: extensionOf(attachment), kind });
  if (extensionOf(attachment) !== '.docx') return extracted;
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
    '原始 DOCX 包会一直保留；如需基于此模板填充，必须使用 fillDocumentTemplate，不能使用 generateFile 重建文档。表格标签后的空单元格使用 target=nextCell；标题后的空段落使用 target=followingParagraph；精确占位文本或日期使用 target=replaceText。',
    ...rows,
    ...(structure.followingParagraphAnchors.length ? [
      `标题后空段落候选：${structure.followingParagraphAnchors.map((anchor) => JSON.stringify(anchor)).join(' | ')}`,
    ] : []),
    '',
    '[DOCX 正文文本]',
    extracted,
  ].join('\n');
}

export async function readBrowserChatAttachment(input: {
  attachment: BrowserChatReadableAttachment;
  absolutePath?: string;
  includeVisuals?: boolean;
  limit?: unknown;
  offset?: unknown;
  pages?: unknown;
  previewRoot?: string;
}): Promise<BrowserChatAttachmentReadResult> {
  const { attachment } = input;
  if (!input.absolutePath && attachment.kind !== 'tab') {
    return { ok: false, actual: `无法定位上传文件：${attachment.name}` };
  }
  try {
    const size = attachment.kind === 'tab' ? attachment.size : (await stat(input.absolutePath!)).size;
    const resolvedAttachment = size === attachment.size ? attachment : { ...attachment, size };
    if (attachment.kind !== 'tab' && size === 0) throw new Error('文件内容为空，无法解析。');
    if (size && size > maxSourceBytes) throw new Error(`文件超过 ${formatSize(maxSourceBytes)}，暂不读取。`);
    const kind = attachmentKind(resolvedAttachment);
    const buffer = kind === 'tab' || kind === 'image' ? undefined : await readFile(input.absolutePath!);
    const [content, visuals] = await Promise.all([
      extractAttachmentText(resolvedAttachment, buffer),
      input.includeVisuals && buffer
        ? renderBrowserChatAttachmentVisuals({
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
    const limit = normalizeBrowserChatFileReadLimit(input.limit);
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
