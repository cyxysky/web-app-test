import path from 'node:path';
import { fileFormatForExtension, generatedFileExtensions, normalizedFileExtension } from '@/server/files/file-format-registry';
import { generateOfficeDocument } from '@/server/files/libreoffice';
import type { OfficeBlock, OfficeCellValue, OfficeDocumentSpec } from '@/server/files/office-document-spec';

export type GeneratedFileCell = OfficeCellValue;
export type GeneratedFileInput = OfficeDocumentSpec;

export type GeneratedFileOutput = {
  buffer: Buffer;
  extension: string;
};

export const generatedTextExtensions = generatedFileExtensions('text');
const maxXlsRows = 65_536;
const maxXlsColumns = 256;
const wordExtensions = new Set(['.doc', '.docx', '.odt']);
const spreadsheetExtensions = new Set(['.xls', '.xlsx', '.ods']);
const presentationExtensions = new Set(['.ppt', '.pptx', '.odp']);

function childBlocks(block: OfficeBlock) {
  return [
    ...(Array.isArray(block.children) ? block.children : []),
    ...(Array.isArray(block.columns)
      ? block.columns.flatMap((column) => Array.isArray(column.blocks) ? column.blocks : [])
      : []),
  ];
}

function flattenBlocks(blocks: OfficeBlock[]): OfficeBlock[] {
  return blocks.flatMap((block) => [block, ...flattenBlocks(childBlocks(block))]);
}

function blockText(block: OfficeBlock): string {
  if (block.type === 'table' && Array.isArray(block.rows)) {
    return block.rows.map((row) => row.map((cell) => cell === null ? '' : String(cell)).join('\t')).join('\n');
  }
  if (block.type === 'list' && Array.isArray(block.items)) {
    return block.items.map((item) => typeof item === 'object' && item && 'text' in item
      ? String((item as { text?: unknown }).text || '')
      : String(item ?? '')).join('\n');
  }
  const own = String(block.markdown ?? block.text ?? block.title ?? '').trim();
  const nested = childBlocks(block).map(blockText).filter(Boolean).join('\n');
  return [own, nested].filter(Boolean).join('\n');
}

function documentText(input: GeneratedFileInput) {
  return input.blocks.map(blockText).filter(Boolean).join('\n\n').replace(/\r\n?/g, '\n').trim();
}

function firstTableRows(input: GeneratedFileInput) {
  return flattenBlocks(input.blocks).find((block) => block.type === 'table' && Array.isArray(block.rows) && block.rows.length)?.rows;
}

function quotedDelimitedCell(value: GeneratedFileCell, delimiter: string) {
  const cell = value === null ? '' : String(value);
  if (!cell.includes(delimiter) && !/["\r\n]/.test(cell)) return cell;
  return `"${cell.replace(/"/g, '""')}"`;
}

function generateDelimitedText(input: GeneratedFileInput, extension: '.csv' | '.tsv') {
  const rows = firstTableRows(input);
  if (!rows?.length) throw new Error(`${extension.toUpperCase()} generation requires a non-empty table block.`);
  const delimiter = extension === '.tsv' ? '\t' : ',';
  return Buffer.from(`${rows.map((row) => row.map((cell) => quotedDelimitedCell(cell, delimiter)).join(delimiter)).join('\n')}\n`, 'utf8');
}

function validateXlsLimits(input: GeneratedFileInput) {
  const tables = flattenBlocks(input.blocks).filter((block) => block.type === 'table' && Array.isArray(block.rows));
  for (const [index, table] of tables.entries()) {
    const rows = table.rows || [];
    if (rows.length > maxXlsRows) throw new Error(`Excel .xls table ${index + 1} exceeds the ${maxXlsRows} row BIFF8 limit.`);
    if (rows.reduce((maximum, row) => Math.max(maximum, row.length), 0) > maxXlsColumns) {
      throw new Error(`Excel .xls table ${index + 1} exceeds the ${maxXlsColumns} column BIFF8 limit.`);
    }
  }
}

function validateOfficeSpec(input: GeneratedFileInput, extension: string) {
  if (!Array.isArray(input.blocks) || !input.blocks.length) throw new Error('Document generation requires at least one block.');
  if (wordExtensions.has(extension) && input.documentType !== 'word') throw new Error(`${extension} requires documentType=word.`);
  if (spreadsheetExtensions.has(extension) && input.documentType !== 'spreadsheet') throw new Error(`${extension} requires documentType=spreadsheet.`);
  if (presentationExtensions.has(extension) && input.documentType !== 'presentation') throw new Error(`${extension} requires documentType=presentation.`);
  if (extension === '.xls') validateXlsLimits(input);
}

export function supportedGeneratedFileExtension(fileName: string) {
  const extension = normalizedFileExtension(fileName);
  const format = fileFormatForExtension(extension);
  return format?.canGenerate ? format.extension : undefined;
}

export async function generateFileBuffer(input: GeneratedFileInput): Promise<GeneratedFileOutput> {
  const extension = supportedGeneratedFileExtension(input.fileName);
  if (!extension) throw new Error('Unsupported output extension. Use a supported text/data format, PDF, Word, Excel, PowerPoint, or OpenDocument extension.');
  if (generatedTextExtensions.has(extension)) {
    if (extension === '.csv' || extension === '.tsv') return { buffer: generateDelimitedText(input, extension), extension };
    const content = documentText(input);
    if (!content) throw new Error('Text file generation requires at least one textual block.');
    return { buffer: Buffer.from(`${content}\n`, 'utf8'), extension };
  }
  validateOfficeSpec(input, extension);
  return {
    buffer: await generateOfficeDocument({ ...input, fileName: path.basename(input.fileName) }),
    extension,
  };
}
