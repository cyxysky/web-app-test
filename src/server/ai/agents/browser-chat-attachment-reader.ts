import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { extractAttachmentTextInWorker } from '@/server/runtime/cpu-worker-pool';
import { normalizeBrowserChatFileReadLimit } from './browser-chat-file-read';

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
};

type AttachmentKind = 'archive' | 'image' | 'pdf' | 'presentation' | 'spreadsheet' | 'tab' | 'text' | 'unknown' | 'word';

const textExtensions = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.csv', '.env', '.go', '.graphql', '.h', '.html', '.htm',
  '.ini', '.java', '.js', '.json', '.jsx', '.kt', '.log', '.lua', '.md', '.mdx', '.mjs', '.php',
  '.py', '.rb', '.rs', '.rst', '.scss', '.sh', '.sql', '.svg', '.text', '.toml', '.ts', '.tsx',
  '.txt', '.vue', '.xml', '.yaml', '.yml',
]);
const spreadsheetExtensions = new Set(['.xls', '.xlsx', '.xlsb', '.xlsm', '.ods']);
const wordExtensions = new Set(['.doc', '.docx', '.odt']);
const presentationExtensions = new Set(['.ppt', '.pptx', '.pps', '.ppsx', '.pot', '.potx', '.odp']);
const archiveExtensions = new Set(['.zip', '.jar', '.epub']);
const imageExtensions = new Set(['.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.tif', '.tiff', '.webp']);
const maxSourceBytes = 64 * 1024 * 1024;

function normalizedOffset(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function extensionOf(attachment: BrowserChatReadableAttachment) {
  return path.extname(attachment.name).toLowerCase();
}

function formatSize(size?: number) {
  if (!size || size < 1024) return `${size || 0} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentKind(attachment: BrowserChatReadableAttachment): AttachmentKind {
  const extension = extensionOf(attachment);
  if (attachment.kind === 'image' || attachment.type.startsWith('image/') || imageExtensions.has(extension)) return 'image';
  if (attachment.kind === 'tab') return 'tab';
  if (attachment.type === 'application/pdf' || extension === '.pdf') return 'pdf';
  if (wordExtensions.has(extension)) return 'word';
  if (spreadsheetExtensions.has(extension)) return 'spreadsheet';
  if (presentationExtensions.has(extension)) return 'presentation';
  if (archiveExtensions.has(extension)) return 'archive';
  if (attachment.type.startsWith('text/') || textExtensions.has(extension)) return 'text';
  return 'unknown';
}

export function isBrowserChatImageAttachment(attachment: BrowserChatReadableAttachment) {
  return attachmentKind(attachment) === 'image';
}

export function browserChatAttachmentMetadata(attachment: BrowserChatReadableAttachment) {
  return `[文件] ${attachment.name} | ID: ${attachment.id} | 类型: ${attachment.type || 'unknown'} | 大小: ${formatSize(attachment.size)} | 读取方式: 调用 readFile，首次只传 attachmentId；续读时使用上次返回的 next offset。`;
}

async function extractAttachmentText(attachment: BrowserChatReadableAttachment, absolutePath: string) {
  const kind = attachmentKind(attachment);
  if (kind === 'tab') return `[标签页引用：${attachment.sourceUrl || attachment.url || attachment.name}]`;
  if (kind === 'image') return '[图片附件：模型可在消息中使用图像输入；文本读取工具仅返回图片元信息。]';
  const metadata = await stat(absolutePath);
  if (metadata.size > maxSourceBytes) throw new Error(`文件超过 ${formatSize(maxSourceBytes)}，暂不读取。`);
  const buffer = await readFile(absolutePath);
  return extractAttachmentTextInWorker({ buffer, extension: extensionOf(attachment), kind });
}

export async function readBrowserChatAttachment(input: {
  attachment: BrowserChatReadableAttachment;
  absolutePath?: string;
  limit?: unknown;
  offset?: unknown;
}): Promise<BrowserChatAttachmentReadResult> {
  const { attachment } = input;
  if (!input.absolutePath && attachment.kind !== 'tab') {
    return { ok: false, actual: `无法定位上传文件：${attachment.name}` };
  }
  try {
    const size = attachment.kind === 'tab' ? attachment.size : (await stat(input.absolutePath!)).size;
    const resolvedAttachment = size === attachment.size ? attachment : { ...attachment, size };
    const content = await extractAttachmentText(resolvedAttachment, input.absolutePath || '');
    const offset = normalizedOffset(input.offset);
    const limit = normalizeBrowserChatFileReadLimit(input.limit);
    const slice = content.slice(offset, offset + limit);
    const nextOffset = offset + slice.length;
    return {
      ok: true,
      actual: [
        `文件：${resolvedAttachment.name}`,
        `类型：${resolvedAttachment.type || 'unknown'}；大小：${formatSize(resolvedAttachment.size)}；解析器：${attachmentKind(resolvedAttachment)}`,
        `字符区间：${offset}-${nextOffset} / ${content.length}${nextOffset < content.length ? `；仍有内容，下次 offset=${nextOffset}` : '；已到末尾'}`,
        '',
        slice || '[该区间没有可读文本]',
      ].join('\n'),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法读取文件内容。';
    return { ok: false, actual: `读取文件 ${attachment.name} 失败：${message}` };
  }
}
