import path from 'node:path';
import { stat } from 'node:fs/promises';
import { fileFormatForExtension, generatedFileExtensions, normalizedFileExtension } from '../formats.js';
import type {
  OfficeCellValue,
  OfficeDocumentSpec,
  OfficeSemanticBlockInput,
  OfficeSemanticDocumentInput,
} from '../office/types.js';
import { generateOfficeJsProgramDocument } from './office/javascript.js';
import { compileOfficeSemanticDocument } from './office/semantic.js';
import { generateUnoProgramDocument } from './office/uno.js';

export type GeneratedFileCell = OfficeCellValue;
export type GeneratedFileInput = OfficeSemanticDocumentInput
  & Required<Pick<OfficeDocumentSpec, 'documentType' | 'fileName'>>;

export type GeneratedFileOutput = {
  buffer: Buffer;
  diagnostics?: unknown;
  extension: string;
  previewPdf?: Buffer;
};

export const generatedTextExtensions = generatedFileExtensions('text');
const wordExtensions = new Set(['.doc', '.docx', '.odt']);
const spreadsheetExtensions = new Set(['.xls', '.xlsx', '.ods']);
const presentationExtensions = new Set(['.ppt', '.pptx', '.odp']);

function childBlocks(block: OfficeSemanticBlockInput) {
  return [
    ...(Array.isArray(block.children) ? block.children : []),
    ...(Array.isArray(block.columns)
      ? block.columns.flatMap((column) => Array.isArray(column.blocks) ? column.blocks : [])
      : []),
  ];
}

function flattenBlocks(blocks: OfficeSemanticBlockInput[]): OfficeSemanticBlockInput[] {
  return blocks.flatMap((block) => [block, ...flattenBlocks(childBlocks(block))]);
}

function blockText(block: OfficeSemanticBlockInput): string {
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
  const semantic = 'blocks' in input && Array.isArray(input.blocks) && input.blocks.length > 0 && !input.program?.trim() && !input.programPath
    ? compileOfficeSemanticDocument(input, input.generator || 'uno')
    : undefined;
  if (!semantic && !input.program?.trim() && !input.programPath) {
    throw new Error('Office document generation requires a saved source draft (program/programPath) or a non-empty semantic document spec.');
  }
  validateOfficeTarget(input, extension);
  const generator = input.generator || (semantic ? 'uno' : 'javascript');
  const source = input.programPath ? { sourcePath: input.programPath } : { sourceCode: semantic?.program || input.program };
  const generated = generator === 'javascript' ? await generateOfficeJsProgramDocument({
    ...source,
    fileName: path.basename(input.fileName),
    documentType: input.documentType,
    assetsPath: input.assetsPath,
    abortSignal: input.abortSignal,
  }) : await generateUnoProgramDocument({
    ...source,
    fileName: path.basename(input.fileName),
    documentType: input.documentType,
    assetsPath: input.assetsPath,
    requiredSourceAssetName: input.requiredSourceAssetName,
    abortSignal: input.abortSignal,
  });
  return {
    buffer: generated.buffer || (() => { throw new Error('Office generator did not return an in-memory artifact.'); })(),
    diagnostics: semantic ? { runtime: generated.report, semantic: semantic.diagnostics } : generated.report,
    extension,
    previewPdf: generated.previewPdf,
  };
}

export async function generateFileToPaths(input: Pick<OfficeDocumentSpec, 'documentType' | 'fileName'> & {
  programPath?: string;
  spec?: OfficeSemanticDocumentInput;
  outputPath: string;
  previewPath: string;
  assetsPath?: string;
  generator?: 'javascript' | 'uno';
  requiredSourceAssetName?: string;
  abortSignal?: AbortSignal;
  onProgress?: (progress: { phase: string; message: string; current?: number; total?: number }) => void | Promise<void>;
}) {
  const extension = supportedGeneratedFileExtension(input.fileName);
  if (!extension || generatedTextExtensions.has(extension)) throw new Error('Path-based generation requires an Office or PDF target.');
  validateOfficeTarget(input, extension);
  if (Boolean(input.programPath) === Boolean(input.spec)) throw new Error('Path-based generation requires exactly one of programPath or spec.');
  const generator = input.generator || (input.spec ? 'uno' : 'javascript');
  if (input.spec?.documentType !== undefined && input.spec.documentType !== input.documentType) {
    throw new Error(`Semantic spec documentType=${input.spec.documentType} does not match output documentType=${input.documentType}.`);
  }
  if (input.spec?.fileName !== undefined && path.basename(input.spec.fileName) !== path.basename(input.fileName)) {
    throw new Error(`Semantic spec fileName=${input.spec.fileName} does not match output fileName=${input.fileName}.`);
  }
  const semantic = input.spec ? compileOfficeSemanticDocument({
    ...input.spec,
    documentType: input.documentType,
    fileName: input.fileName,
  }, generator) : undefined;
  const source = input.programPath ? { sourcePath: input.programPath } : { sourceCode: semantic!.program };
  const generated = generator === 'javascript'
    ? await generateOfficeJsProgramDocument({
        ...source,
        fileName: path.basename(input.fileName),
        documentType: input.documentType,
        assetsPath: input.assetsPath,
        abortSignal: input.abortSignal,
        outputPath: input.outputPath,
        previewPath: input.previewPath,
        onProgress: input.onProgress,
      })
    : await generateUnoProgramDocument({
        ...source,
        fileName: path.basename(input.fileName),
        documentType: input.documentType,
        assetsPath: input.assetsPath,
        requiredSourceAssetName: input.requiredSourceAssetName,
        abortSignal: input.abortSignal,
        outputPath: input.outputPath,
        previewPath: input.previewPath,
        onProgress: input.onProgress,
      });
  return {
    bytes: (await stat(input.outputPath)).size,
    diagnostics: semantic ? { runtime: generated.report, semantic: semantic.diagnostics } : generated.report,
    extension,
    outputPath: input.outputPath,
    previewPath: input.previewPath,
  };
}
