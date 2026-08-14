import path from 'node:path';
import { fileFormatForExtension, generatedFileExtensions, normalizedFileExtension } from '@/server/files/file-format-registry';
import { generateOfficeDocument } from '@/server/files/libreoffice';
import type {
  OfficeCellValue,
  OfficeDocumentSpec,
  OfficeSheetSpec,
  OfficeSlideSpec,
} from '@/server/files/office-document-spec';

export type GeneratedFileCell = OfficeCellValue;
export type GeneratedFileSheet = OfficeSheetSpec;
export type GeneratedFileSlide = OfficeSlideSpec;
export type GeneratedFileInput = OfficeDocumentSpec;

export type GeneratedFileOutput = {
  buffer: Buffer;
  extension: string;
};

export const generatedTextExtensions = generatedFileExtensions('text');
const maxGeneratedTextBytes = 4 * 1024 * 1024;
const maxSpreadsheetCells = 200_000;
const maxXlsRows = 65_536;
const maxXlsColumns = 256;
const wordExtensions = new Set(['.doc', '.docx', '.odt']);
const spreadsheetExtensions = new Set(['.xls', '.xlsx', '.ods']);
const presentationExtensions = new Set(['.ppt', '.pptx', '.odp']);

function normalizeContent(value: string | null | undefined) {
  return String(value || '').replace(/\r\n?/g, '\n').trim();
}

function requiredContent(input: GeneratedFileInput, format: string) {
  const content = normalizeContent(input.content);
  if (!content) throw new Error(`${format} generation requires non-empty content.`);
  if (Buffer.byteLength(content, 'utf8') > maxGeneratedTextBytes) {
    throw new Error(`Generated content exceeds ${maxGeneratedTextBytes} bytes.`);
  }
  return content;
}

function quotedDelimitedCell(value: GeneratedFileCell, delimiter: string) {
  const text = value === null ? '' : String(value);
  if (!text.includes(delimiter) && !/["\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function generateDelimitedText(input: GeneratedFileInput, extension: '.csv' | '.tsv') {
  const content = normalizeContent(input.content);
  if (content) return Buffer.from(`${content}\n`, 'utf8');
  const sheet = input.sheets?.find((candidate) => Array.isArray(candidate.rows) && candidate.rows.length);
  if (!sheet) throw new Error(`${extension.toUpperCase()} generation requires content or one non-empty sheet.`);
  const delimiter = extension === '.tsv' ? '\t' : ',';
  const value = sheet.rows
    .map((row) => row.map((cell) => quotedDelimitedCell(cell, delimiter)).join(delimiter))
    .join('\n');
  return Buffer.from(`${value}\n`, 'utf8');
}

function validateSpreadsheet(input: GeneratedFileInput, extension: string) {
  const sheets = input.sheets?.filter((sheet) => Array.isArray(sheet.rows) && sheet.rows.length) || [];
  if (!sheets.length) throw new Error('Spreadsheet generation requires at least one non-empty sheet.');
  const cellCount = sheets.reduce((total, sheet) => total + sheet.rows.reduce((sum, row) => sum + row.length, 0), 0);
  if (cellCount > maxSpreadsheetCells) throw new Error(`Spreadsheet generation exceeds ${maxSpreadsheetCells} cells.`);
  if (extension !== '.xls') return;
  for (const [index, sheet] of sheets.entries()) {
    if (sheet.rows.length > maxXlsRows) {
      throw new Error(`Excel .xls sheet ${index + 1} exceeds the ${maxXlsRows} row BIFF8 limit.`);
    }
    const columnCount = sheet.rows.reduce((max, row) => Math.max(max, row.length), 0);
    if (columnCount > maxXlsColumns) {
      throw new Error(`Excel .xls sheet ${index + 1} exceeds the ${maxXlsColumns} column BIFF8 limit.`);
    }
  }
}

function validateOfficeSpec(input: GeneratedFileInput, extension: string) {
  if (wordExtensions.has(extension)) {
    requiredContent(input, 'Word');
    return;
  }
  if (spreadsheetExtensions.has(extension)) {
    validateSpreadsheet(input, extension);
    return;
  }
  if (presentationExtensions.has(extension)) {
    const slides = input.slides?.filter((slide) => slide.title || slide.subtitle || slide.content || slide.bullets?.length) || [];
    if (!slides.length && !normalizeContent(input.content)) {
      throw new Error('PowerPoint generation requires at least one slide or non-empty content.');
    }
    return;
  }
  if (extension === '.pdf') {
    if (input.documentType === 'spreadsheet' || (!input.documentType && input.sheets?.length)) {
      validateSpreadsheet(input, '.xlsx');
    } else if (input.documentType === 'presentation' || (!input.documentType && input.slides?.length)) {
      const slides = input.slides?.filter((slide) => slide.title || slide.subtitle || slide.content || slide.bullets?.length) || [];
      if (!slides.length && !normalizeContent(input.content)) {
        throw new Error('Presentation PDF generation requires at least one slide or non-empty content.');
      }
    } else {
      requiredContent(input, 'PDF');
    }
  }
}

export function supportedGeneratedFileExtension(fileName: string) {
  const extension = normalizedFileExtension(fileName);
  const format = fileFormatForExtension(extension);
  return format?.canGenerate ? format.extension : undefined;
}

export async function generateFileBuffer(input: GeneratedFileInput): Promise<GeneratedFileOutput> {
  const extension = supportedGeneratedFileExtension(input.fileName);
  if (!extension) {
    throw new Error('Unsupported output extension. Use a supported text/data format, PDF, Word, Excel, PowerPoint, or OpenDocument extension.');
  }
  if (generatedTextExtensions.has(extension)) {
    if (extension === '.csv' || extension === '.tsv') {
      return { buffer: generateDelimitedText(input, extension), extension };
    }
    const content = `${requiredContent(input, 'Text file')}\n`;
    return { buffer: Buffer.from(content, 'utf8'), extension };
  }

  validateOfficeSpec(input, extension);
  return {
    buffer: await generateOfficeDocument({
      ...input,
      fileName: path.basename(input.fileName),
    }),
    extension,
  };
}
