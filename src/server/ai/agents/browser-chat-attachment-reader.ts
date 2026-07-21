import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as CFB from 'cfb';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import * as XLSX from 'xlsx';

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
const maxSourceBytes = 64 * 1024 * 1024;
const defaultReadChars = 12_000;
const maxReadChars = 40_000;

function normalizedOffset(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function normalizedLimit(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.min(maxReadChars, Math.max(1, Math.floor(number))) : defaultReadChars;
}

function extensionOf(attachment: BrowserChatReadableAttachment) {
  return path.extname(attachment.name).toLowerCase();
}

function formatSize(size?: number) {
  if (!size || size < 1024) return `${size || 0} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function decodeXml(value: string) {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function officeXmlText(value: string) {
  return decodeXml(value
    .replace(/<a:br\s*\/>/g, '\n')
    .replace(/<a:p[^>]*>/g, '')
    .replace(/<\/a:p>/g, '\n')
    .replace(/<text:line-break\s*\/>/g, '\n')
    .replace(/<text:p[^>]*>/g, '')
    .replace(/<\/text:p>/g, '\n'))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function attachmentKind(attachment: BrowserChatReadableAttachment) {
  const extension = extensionOf(attachment);
  if (attachment.kind === 'image' || attachment.type.startsWith('image/')) return 'image';
  if (attachment.kind === 'tab') return 'tab';
  if (attachment.type === 'application/pdf' || extension === '.pdf') return 'pdf';
  if (wordExtensions.has(extension)) return 'word';
  if (spreadsheetExtensions.has(extension)) return 'spreadsheet';
  if (presentationExtensions.has(extension)) return 'presentation';
  if (archiveExtensions.has(extension)) return 'archive';
  if (attachment.type.startsWith('text/') || textExtensions.has(extension)) return 'text';
  return 'unknown';
}

export function browserChatAttachmentMetadata(attachment: BrowserChatReadableAttachment) {
  return `[文件] ${attachment.name} | ID: ${attachment.id} | 类型: ${attachment.type || 'unknown'} | 大小: ${formatSize(attachment.size)} | 读取方式: 调用 readUploadedFile，按需传入 attachmentId、offset、limit。`;
}

async function extractPdf(buffer: Buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    return (await parser.getText()).text.trim();
  } finally {
    await parser.destroy();
  }
}

async function extractWord(buffer: Buffer) {
  return (await mammoth.extractRawText({ buffer })).value.trim();
}

function extractLegacyOfficeText(buffer: Buffer) {
  const container = CFB.read(buffer, { type: 'buffer' });
  const values = container.FileIndex
    .filter((entry) => entry.content && entry.content.length)
    .map((entry) => Buffer.from(entry.content))
    .flatMap((content) => [content.toString('utf16le'), content.toString('latin1')])
    .flatMap((value) => value.match(/[\p{L}\p{N}][\p{L}\p{N}\p{P}\p{Z}\r\n\t]{2,}/gu) || [])
    .map((value) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((value) => value.length >= 3)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 10_000);
  return values.join('\n').trim();
}

async function extractOpenDocument(buffer: Buffer) {
  const archive = await JSZip.loadAsync(buffer);
  const document = archive.files['content.xml'];
  if (!document) throw new Error('OpenDocument 文件缺少 content.xml。');
  return officeXmlText(await document.async('text'));
}

function extractSpreadsheet(buffer: Buffer) {
  const workbook = XLSX.read(buffer, { cellDates: true, dense: false, type: 'buffer' });
  return workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    return `## 工作表：${sheetName}\n${XLSX.utils.sheet_to_csv(sheet).trim()}`;
  }).join('\n\n').trim();
}

async function extractPresentation(buffer: Buffer) {
  const archive = await JSZip.loadAsync(buffer);
  const slides = Object.keys(archive.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => Number(left.match(/\d+/)?.[0]) - Number(right.match(/\d+/)?.[0]));
  if (!slides.length && archive.files['content.xml']) return officeXmlText(await archive.files['content.xml'].async('text'));
  const values = await Promise.all(slides.map(async (name, index) => {
    const xml = await archive.files[name].async('text');
    return `## 幻灯片 ${index + 1}\n${officeXmlText(xml)}`;
  }));
  return values.join('\n\n').trim();
}

async function extractArchiveListing(buffer: Buffer) {
  const archive = await JSZip.loadAsync(buffer);
  const names = Object.values(archive.files)
    .filter((entry) => !entry.dir)
    .map((entry) => entry.name)
    .slice(0, 2_000);
  return `压缩包文件列表（${names.length} 项）：\n${names.join('\n')}`;
}

function extractText(buffer: Buffer) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!text || buffer.includes(0)) return '';
  return text;
}

async function extractAttachmentText(attachment: BrowserChatReadableAttachment, absolutePath: string) {
  if (attachment.kind === 'tab') return `[标签页引用：${attachment.sourceUrl || attachment.url || attachment.name}]`;
  const buffer = await readFile(absolutePath);
  if (buffer.length > maxSourceBytes) {
    throw new Error(`文件超过 ${formatSize(maxSourceBytes)}，暂不读取。`);
  }
  switch (attachmentKind(attachment)) {
    case 'pdf': return extractPdf(buffer);
    case 'word': {
      const extension = extensionOf(attachment);
      if (extension === '.odt') return extractOpenDocument(buffer);
      if (extension === '.doc') return extractLegacyOfficeText(buffer);
      return extractWord(buffer);
    }
    case 'spreadsheet': return extractSpreadsheet(buffer);
    case 'presentation': {
      const extension = extensionOf(attachment);
      if (extension === '.ppt' || extension === '.pps' || extension === '.pot') return extractLegacyOfficeText(buffer);
      return extractPresentation(buffer);
    }
    case 'archive': return extractArchiveListing(buffer);
    case 'text': return extractText(buffer);
    case 'image': return '[图片附件：模型可在消息中使用图像输入；文本读取工具仅返回图片元信息。]';
    default: {
      const text = extractText(buffer);
      if (text) return text;
      throw new Error('该文件是未知二进制格式，当前没有可用的文本解析器。');
    }
  }
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
    const content = attachment.kind === 'tab'
      ? await extractAttachmentText(attachment, '')
      : await extractAttachmentText(attachment, input.absolutePath!);
    const offset = normalizedOffset(input.offset);
    const limit = normalizedLimit(input.limit);
    const slice = content.slice(offset, offset + limit);
    const nextOffset = offset + slice.length;
    return {
      ok: true,
      actual: [
        `文件：${attachment.name}`,
        `类型：${attachment.type || 'unknown'}；大小：${formatSize(attachment.size)}；解析器：${attachmentKind(attachment)}`,
        `字符区间：${offset}-${nextOffset} / ${content.length}${nextOffset < content.length ? `；仍有内容，下一次 offset=${nextOffset}` : '；已到末尾'}`,
        '',
        slice || '[该区间没有可读文本]',
      ].join('\n'),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法读取文件内容。';
    return { ok: false, actual: `读取文件 ${attachment.name} 失败：${message}` };
  }
}
