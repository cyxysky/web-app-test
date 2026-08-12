import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';
import PDFDocument from 'pdfkit';
import PptxGenJS from 'pptxgenjs';
import * as XLSX from 'xlsx';
import { fileFormatForExtension, generatedFileExtensions, normalizedFileExtension } from '@/server/files/file-format-registry';
import { convertOfficeBuffer } from '@/server/files/libreoffice';

export type GeneratedFileCell = string | number | boolean | null;

export type GeneratedFileSheet = {
  name?: string;
  rows: GeneratedFileCell[][];
};

export type GeneratedFileSlide = {
  title?: string;
  content?: string;
  bullets?: string[];
};

export type GeneratedFileInput = {
  content?: string | null;
  fileName: string;
  sheets?: GeneratedFileSheet[];
  slides?: GeneratedFileSlide[];
  title?: string | null;
};

export type GeneratedFileOutput = {
  buffer: Buffer;
  extension: string;
};

export const generatedTextExtensions = generatedFileExtensions('text');
const maxGeneratedTextBytes = 4 * 1024 * 1024;
const maxSpreadsheetCells = 200_000;
const maxXlsRows = 65_536;
const maxXlsColumns = 256;

type DocumentBlock = {
  kind: 'code' | 'heading' | 'list' | 'paragraph';
  level?: number;
  text: string;
};

function normalizeContent(value: string | null | undefined) {
  return String(value || '').replace(/\r\n?/g, '\n').trim();
}

function plainInlineMarkdown(value: string) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(`{1,3}|\*\*|__|~~)/g, '')
    .trim();
}

function documentBlocks(content: string): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  let code = false;
  let paragraph: string[] = [];
  const flushParagraph = () => {
    const text = plainInlineMarkdown(paragraph.join(' '));
    if (text) blocks.push({ kind: 'paragraph', text });
    paragraph = [];
  };

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trimEnd();
    if (/^```/.test(line.trim())) {
      flushParagraph();
      code = !code;
      continue;
    }
    if (code) {
      blocks.push({ kind: 'code', text: line || ' ' });
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: 'heading', level: heading[1].length, text: plainInlineMarkdown(heading[2]) });
      continue;
    }
    const list = line.match(/^\s*(?:[-*+] |\d+[.)]\s+)(.+)$/);
    if (list) {
      flushParagraph();
      blocks.push({ kind: 'list', text: plainInlineMarkdown(list[1]) });
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  return blocks;
}

function requiredContent(input: GeneratedFileInput, format: string) {
  const content = normalizeContent(input.content);
  if (!content) throw new Error(`${format} generation requires non-empty content.`);
  if (Buffer.byteLength(content, 'utf8') > maxGeneratedTextBytes) {
    throw new Error(`Generated content exceeds ${maxGeneratedTextBytes} bytes.`);
  }
  return content;
}

function headingLevel(level = 1) {
  if (level <= 1) return HeadingLevel.HEADING_1;
  if (level === 2) return HeadingLevel.HEADING_2;
  if (level === 3) return HeadingLevel.HEADING_3;
  if (level === 4) return HeadingLevel.HEADING_4;
  if (level === 5) return HeadingLevel.HEADING_5;
  return HeadingLevel.HEADING_6;
}

async function generateWord(input: GeneratedFileInput) {
  const content = requiredContent(input, 'Word');
  const children = documentBlocks(content).map((block) => {
    if (block.kind === 'heading') {
      return new Paragraph({
        children: [new TextRun({ bold: true, text: block.text })],
        heading: headingLevel(block.level),
        spacing: { after: 160, before: 160 },
      });
    }
    if (block.kind === 'list') {
      return new Paragraph({
        bullet: { level: 0 },
        children: [new TextRun({ text: block.text })],
        spacing: { after: 80 },
      });
    }
    return new Paragraph({
      children: [new TextRun({
        font: block.kind === 'code' ? 'Consolas' : 'Microsoft YaHei',
        text: block.text,
      })],
      spacing: { after: block.kind === 'code' ? 20 : 120, line: 360 },
    });
  });
  const document = new Document({
    creator: 'WebPilot',
    description: 'Generated in a WebPilot conversation',
    sections: [{ children }],
    title: String(input.title || path.parse(input.fileName).name),
  });
  return Buffer.from(await Packer.toBuffer(document));
}

type PdfFont = { family?: string; path: string };

function configuredPdfFont(): PdfFont | undefined {
  const configured = String(process.env.WEBPILOT_DOCUMENT_FONT || '').trim();
  if (configured && existsSync(configured)) {
    return { family: String(process.env.WEBPILOT_DOCUMENT_FONT_FAMILY || '').trim() || undefined, path: configured };
  }
  const candidates: PdfFont[] = [
    { path: 'C:\\Windows\\Fonts\\NotoSansSC-VF.ttf' },
    { path: 'C:\\Windows\\Fonts\\msyh.ttc', family: 'Microsoft YaHei' },
    { path: 'C:\\Windows\\Fonts\\simhei.ttf' },
    { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', family: 'Noto Sans CJK SC' },
    { path: '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc', family: 'Noto Sans CJK SC' },
  ];
  return candidates.find((candidate) => existsSync(candidate.path));
}

function generatePdf(input: GeneratedFileInput) {
  const content = requiredContent(input, 'PDF');
  const font = configuredPdfFont();
  if (!font) {
    throw new Error('PDF generation needs an embeddable font. Set WEBPILOT_DOCUMENT_FONT to a .ttf/.otf/.ttc file.');
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const document = new PDFDocument({
      bufferPages: true,
      // Disable PDFKit's implicit Helvetica initialization. In a bundled Next.js
      // server it resolves Helvetica.afm relative to the vendor chunk instead of
      // the pdfkit package. WebPilot always embeds the explicitly resolved font.
      font: '',
      info: {
        Author: 'WebPilot',
        Creator: 'WebPilot',
        Title: String(input.title || path.parse(input.fileName).name),
      },
      margins: { bottom: 54, left: 58, right: 58, top: 54 },
      size: 'A4',
    });
    document.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    document.on('error', reject);
    document.on('end', () => resolve(Buffer.concat(chunks)));

    document.registerFont('WebPilotBody', font.path, font.family);
    document.font('WebPilotBody');

    for (const block of documentBlocks(content)) {
      if (block.kind === 'heading') {
        const size = block.level === 1 ? 22 : block.level === 2 ? 18 : 15;
        document.fontSize(size).fillColor('#172033').text(block.text, { paragraphGap: 7 });
      } else if (block.kind === 'list') {
        document.fontSize(11).fillColor('#253047').text(`• ${block.text}`, { indent: 12, paragraphGap: 4 });
      } else if (block.kind === 'code') {
        document.fontSize(9.5).fillColor('#3A4354').text(block.text, { indent: 12, paragraphGap: 1 });
      } else {
        document.fontSize(11).fillColor('#253047').text(block.text, { lineGap: 3, paragraphGap: 8 });
      }
    }
    document.end();
  });
}

function normalizedSheetName(value: string | undefined, index: number, used: Set<string>) {
  const base = String(value || `Sheet ${index + 1}`).replace(/[\\/?*:[\]]/g, ' ').trim().slice(0, 31) || `Sheet ${index + 1}`;
  let name = base;
  let suffix = 2;
  while (used.has(name.toLowerCase())) {
    const ending = ` ${suffix}`;
    name = `${base.slice(0, 31 - ending.length)}${ending}`;
    suffix += 1;
  }
  used.add(name.toLowerCase());
  return name;
}

function generateSpreadsheet(input: GeneratedFileInput, extension: '.xls' | '.xlsx') {
  const sheets = input.sheets?.filter((sheet) => Array.isArray(sheet.rows) && sheet.rows.length) || [];
  if (!sheets.length) throw new Error('Excel generation requires at least one non-empty sheet.');
  const cellCount = sheets.reduce((total, sheet) => total + sheet.rows.reduce((sum, row) => sum + row.length, 0), 0);
  if (cellCount > maxSpreadsheetCells) throw new Error(`Excel generation exceeds ${maxSpreadsheetCells} cells.`);
  if (extension === '.xls') {
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

  const workbook = XLSX.utils.book_new();
  const used = new Set<string>();
  for (const [index, sheet] of sheets.entries()) {
    const worksheet = XLSX.utils.aoa_to_sheet(sheet.rows);
    const widths = sheet.rows.reduce<number[]>((current, row) => {
      row.forEach((cell, cellIndex) => {
        current[cellIndex] = Math.min(60, Math.max(current[cellIndex] || 8, String(cell ?? '').length + 2));
      });
      return current;
    }, []);
    worksheet['!cols'] = widths.map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(workbook, worksheet, normalizedSheetName(sheet.name, index, used));
  }
  return Buffer.from(XLSX.write(workbook, {
    bookType: extension === '.xls' ? 'biff8' : 'xlsx',
    compression: extension === '.xlsx',
    type: 'buffer',
  }));
}

function generateDelimitedText(input: GeneratedFileInput, extension: '.csv' | '.tsv') {
  const content = normalizeContent(input.content);
  if (content) return Buffer.from(`${content}\n`, 'utf8');
  const sheet = input.sheets?.find((candidate) => Array.isArray(candidate.rows) && candidate.rows.length);
  if (!sheet) throw new Error(`${extension.toUpperCase()} generation requires content or one non-empty sheet.`);
  const worksheet = XLSX.utils.aoa_to_sheet(sheet.rows);
  const value = XLSX.utils.sheet_to_csv(worksheet, {
    FS: extension === '.tsv' ? '\t' : ',',
    RS: '\n',
  });
  return Buffer.from(value.endsWith('\n') ? value : `${value}\n`, 'utf8');
}

async function convertGeneratedOffice(buffer: Buffer, sourceExtension: string, targetExtension: string) {
  const converted = await convertOfficeBuffer({ buffer, sourceExtension, targetExtension });
  if (!converted) {
    throw new Error(`Generating ${targetExtension} requires LibreOffice, but no LibreOffice executable is available.`);
  }
  return converted;
}

function slidesFromContent(input: GeneratedFileInput): GeneratedFileSlide[] {
  const content = requiredContent(input, 'PowerPoint');
  const slides: GeneratedFileSlide[] = [];
  let current: GeneratedFileSlide = { title: String(input.title || path.parse(input.fileName).name), bullets: [] };
  for (const block of documentBlocks(content)) {
    if (block.kind === 'heading' && block.level && block.level <= 2) {
      if (current.bullets?.length || current.content) slides.push(current);
      current = { title: block.text, bullets: [] };
      continue;
    }
    current.bullets!.push(block.text);
  }
  if (current.bullets?.length || current.title) slides.push(current);
  return slides;
}

function splitSlideLines(slide: GeneratedFileSlide) {
  const source = [
    ...(slide.content ? slide.content.split(/\n+/) : []),
    ...(slide.bullets || []),
  ].map((line) => plainInlineMarkdown(line)).filter(Boolean);
  return source.length ? source : [''];
}

async function generatePowerPoint(input: GeneratedFileInput) {
  const sourceSlides = input.slides?.filter((slide) => slide.title || slide.content || slide.bullets?.length) || slidesFromContent(input);
  if (!sourceSlides.length) throw new Error('PowerPoint generation requires at least one slide.');
  const presentation = new PptxGenJS();
  presentation.layout = 'LAYOUT_WIDE';
  presentation.author = 'WebPilot';
  presentation.company = 'WebPilot';
  presentation.subject = 'Generated in a WebPilot conversation';
  presentation.title = String(input.title || path.parse(input.fileName).name);

  for (const sourceSlide of sourceSlides) {
    const lines = splitSlideLines(sourceSlide);
    const groups = Array.from({ length: Math.ceil(lines.length / 9) }, (_, index) => lines.slice(index * 9, index * 9 + 9));
    for (const [groupIndex, group] of groups.entries()) {
      const slide = presentation.addSlide();
      slide.background = { color: 'F7F8FC' };
      slide.addShape(presentation.ShapeType.rect, { fill: { color: '2F6FED' }, h: 7.5, line: { color: '2F6FED' }, w: 0.14, x: 0, y: 0 });
      slide.addText(`${sourceSlide.title || presentation.title}${groupIndex ? '（续）' : ''}`, {
        bold: true,
        color: '172033',
        fontFace: 'Microsoft YaHei',
        fontSize: 25,
        h: 0.65,
        margin: 0,
        w: 11.8,
        x: 0.78,
        y: 0.58,
      });
      slide.addShape(presentation.ShapeType.line, { h: 0, line: { color: 'D7DDEA', width: 1 }, w: 11.8, x: 0.78, y: 1.42 });
      const fontSize = group.length > 7 ? 18 : group.length > 5 ? 20 : 22;
      group.forEach((line, index) => {
        slide.addText(line ? `•  ${line}` : '', {
          breakLine: false,
          color: '28344A',
          fontFace: 'Microsoft YaHei',
          fontSize,
          h: 0.55,
          margin: 0,
          valign: 'middle',
          w: 11.25,
          x: 1.02,
          y: 1.75 + index * 0.58,
        });
      });
      slide.addText('WebPilot', { color: '8892A5', fontFace: 'Aptos', fontSize: 9, h: 0.2, margin: 0, w: 1, x: 11.55, y: 7.05 });
    }
  }
  const output = await presentation.write({ compression: true, outputType: 'nodebuffer' });
  return Buffer.from(output as Uint8Array);
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
  if (extension === '.docx') return { buffer: await generateWord(input), extension };
  if (extension === '.doc' || extension === '.odt') {
    return { buffer: await convertGeneratedOffice(await generateWord(input), '.docx', extension), extension };
  }
  if (extension === '.pdf') return { buffer: await generatePdf(input), extension };
  if (extension === '.xls' || extension === '.xlsx') {
    return { buffer: generateSpreadsheet(input, extension), extension };
  }
  if (extension === '.ods') {
    return { buffer: await convertGeneratedOffice(generateSpreadsheet(input, '.xlsx'), '.xlsx', extension), extension };
  }
  if (extension === '.pptx') return { buffer: await generatePowerPoint(input), extension };
  return { buffer: await convertGeneratedOffice(await generatePowerPoint(input), '.pptx', extension), extension };
}
