import path from 'node:path';
import { fileFormatForExtension, generatedFileExtensions, normalizedFileExtension } from '@/server/files/file-format-registry';
import { generateUnoProgramDocument } from '@/server/files/uno-program';
import { generateOfficeJsProgramDocument } from '@/server/files/office-js-program';
import type { OfficeBlock, OfficeCellValue, OfficeDocumentSpec } from '@/server/files/office-document-spec';

export type GeneratedFileCell = OfficeCellValue;
export type GeneratedFileInput = OfficeDocumentSpec;

export type GeneratedFileOutput = {
  buffer: Buffer;
  diagnostics?: unknown;
  extension: string;
  previewPdf?: Buffer;
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

function validateOfficeTarget(input: Pick<OfficeDocumentSpec, 'documentType'>, extension: string) {
  if (wordExtensions.has(extension) && input.documentType !== 'word') throw new Error(`${extension} requires documentType=word.`);
  if (spreadsheetExtensions.has(extension) && input.documentType !== 'spreadsheet') throw new Error(`${extension} requires documentType=spreadsheet.`);
  if (presentationExtensions.has(extension) && input.documentType !== 'presentation') throw new Error(`${extension} requires documentType=presentation.`);
}

export function supportedGeneratedFileExtension(fileName: string) {
  const extension = normalizedFileExtension(fileName);
  const format = fileFormatForExtension(extension);
  return format?.canGenerate ? format.extension : undefined;
}

export async function generateFileBuffer(input: (GeneratedFileInput | Pick<OfficeDocumentSpec, 'documentType' | 'fileName'>) & {
  program?: string;
  programPath?: string;
  assetsPath?: string;
  generator?: 'javascript' | 'uno';
  requiredSourceAssetName?: string;
  abortSignal?: AbortSignal;
}): Promise<GeneratedFileOutput> {
  const extension = supportedGeneratedFileExtension(input.fileName);
  if (!extension) throw new Error('Unsupported output extension. Use a supported text/data format, PDF, Word, Excel, PowerPoint, or OpenDocument extension.');
  if (generatedTextExtensions.has(extension)) {
    if (!('blocks' in input)) throw new Error('Text file generation requires semantic text blocks.');
    if (extension === '.csv' || extension === '.tsv') return { buffer: generateDelimitedText(input, extension), extension };
    const content = documentText(input);
    if (!content) throw new Error('Text file generation requires at least one textual block.');
    return { buffer: Buffer.from(`${content}\n`, 'utf8'), extension };
  }
  if (!input.program?.trim() && !input.programPath) throw new Error('Office document generation requires a saved source draft from file action=generate or action=edit.');
  validateOfficeTarget(input, extension);
  const generator = input.generator || 'uno';
  const generated = generator === 'javascript' ? await generateOfficeJsProgramDocument({
    ...(input.programPath ? { sourcePath: input.programPath } : { sourceCode: input.program }),
    fileName: path.basename(input.fileName),
    documentType: input.documentType,
    assetsPath: input.assetsPath,
    abortSignal: input.abortSignal,
  }) : await generateUnoProgramDocument({
    ...(input.programPath ? { sourcePath: input.programPath } : { sourceCode: input.program }),
    fileName: path.basename(input.fileName),
    documentType: input.documentType,
    assetsPath: input.assetsPath,
    requiredSourceAssetName: input.requiredSourceAssetName,
    abortSignal: input.abortSignal,
  });
  return {
    buffer: generated.buffer,
    diagnostics: generated.report,
    extension,
    previewPdf: generated.previewPdf,
  };
}
