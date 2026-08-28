import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { PDFParse } from 'pdf-parse';
import sharp from 'sharp';

export type OfficeArtifactIssue = {
  code: string;
  column?: number;
  elementId?: string;
  line?: number;
  locator?: Record<string, unknown>;
  message: string;
  severity: 'error' | 'warning';
  target?: string;
};

export type OfficeElementMapEntry = {
  artifactName?: string;
  column?: number;
  elementId: string;
  kind: string;
  line?: number;
  locator?: Record<string, unknown>;
};

function normalizedFontName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, '');
}

const FONT_FILE_ALIASES: Record<string, string[]> = {
  arial: ['Arial'],
  calibri: ['Calibri'],
  deng: ['DengXian'],
  msyh: ['Microsoft YaHei'],
  msyhbd: ['Microsoft YaHei'],
  simfang: ['FangSong'],
  simhei: ['SimHei'],
  simkai: ['KaiTi'],
  simsun: ['SimSun', 'NSimSun', '宋体', '新宋体'],
};

async function installedFontNames() {
  const roots = process.platform === 'win32'
    ? [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')]
    : ['/usr/share/fonts', '/usr/local/share/fonts'];
  const names = new Set<string>();
  for (const root of roots) {
    try {
      for (const entry of await readdir(root, { recursive: true })) {
        const extension = path.extname(String(entry)).toLowerCase();
        if (!['.ttf', '.ttc', '.otf'].includes(extension)) continue;
        const baseName = normalizedFontName(path.basename(String(entry), extension));
        names.add(baseName);
        for (const alias of FONT_FILE_ALIASES[baseName] || []) names.add(normalizedFontName(alias));
      }
    } catch {
      // Font inventory is advisory; file validation must remain available.
    }
  }
  return names;
}

function expectedPackageEntry(extension: string) {
  if (extension === '.pptx') return 'ppt/presentation.xml';
  if (extension === '.docx') return 'word/document.xml';
  if (extension === '.xlsx') return 'xl/workbook.xml';
  if (['.odp', '.ods', '.odt'].includes(extension)) return 'content.xml';
  return undefined;
}

function mediaPrefix(extension: string) {
  if (extension === '.pptx') return 'ppt/media/';
  if (extension === '.docx') return 'word/media/';
  if (extension === '.xlsx') return 'xl/media/';
  if (['.odp', '.ods', '.odt'].includes(extension)) return 'Pictures/';
  return undefined;
}

function xmlAttribute(source: string, name: string) {
  return source.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

function mappedIssue(issue: OfficeArtifactIssue, elementMap: OfficeElementMapEntry[], artifactName?: string) {
  const mapped = artifactName ? elementMap.find((entry) => entry.artifactName === artifactName) : undefined;
  return mapped ? { ...issue, elementId: mapped.elementId, line: mapped.line, column: mapped.column, locator: mapped.locator } : issue;
}

async function validateRelationships(zip: JSZip, issues: OfficeArtifactIssue[]) {
  const relationshipEntries = Object.values(zip.files).filter((entry) => !entry.dir && /_rels\/[^/]+\.rels$/i.test(entry.name));
  for (const entry of relationshipEntries) {
    const xml = await entry.async('string');
    const ownerDirectory = path.posix.dirname(path.posix.dirname(entry.name));
    for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
      const attributes = match[1] || '';
      if (/\bTargetMode="External"/i.test(attributes)) continue;
      const rawTarget = xmlAttribute(attributes, 'Target');
      let target = rawTarget?.replace(/\\/g, '/').split('#')[0];
      try { if (target) target = decodeURIComponent(target); } catch { /* Keep the literal package URI for diagnostics. */ }
      if (!target) continue;
      const resolved = target.startsWith('/')
        ? target.slice(1)
        : path.posix.normalize(path.posix.join(ownerDirectory, target));
      if (!zip.file(resolved)) {
        issues.push({
          code: 'OFFICE_RELATIONSHIP_TARGET_MISSING',
          message: `${entry.name} points to missing package part ${resolved}.`,
          severity: 'error',
          target: entry.name,
        });
      }
    }
  }
}

async function validatePresentationPackage(zip: JSZip, issues: OfficeArtifactIssue[], elementMap: OfficeElementMapEntry[], requireElementIds: boolean) {
  const presentation = await zip.file('ppt/presentation.xml')?.async('string') || '';
  const slideSize = presentation.match(/<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/i);
  const slideWidth = Number(slideSize?.[1] || 0);
  const slideHeight = Number(slideSize?.[2] || 0);
  const slides = Object.values(zip.files).filter((entry) => !entry.dir && /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name));
  if (!slides.length) issues.push({ code: 'PPTX_NO_SLIDES', message: 'Presentation contains no slide parts.', severity: 'error', target: 'ppt/presentation.xml' });
  for (const slide of slides) {
    const xml = await slide.async('string');
    const ids = [...xml.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/gi)].map((match) => match[1]);
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate) issues.push({ code: 'PPTX_DUPLICATE_SHAPE_ID', message: `${slide.name} contains duplicate shape id ${duplicate}.`, severity: 'error', target: slide.name });
    const shapeBlocks = [...xml.matchAll(/<p:(sp|pic|graphicFrame|cxnSp)\b[\s\S]*?<\/p:\1>/gi)].map((match) => match[0]);
    for (const block of shapeBlocks) {
      const objectName = block.match(/<p:cNvPr\b[^>]*\bname="([^"]+)"/i)?.[1];
      if (/<a:tbl\b/i.test(block)) {
        const columnWidths = [...block.matchAll(/<a:gridCol\b[^>]*\bw="(-?\d+)"/gi)].map((match) => Number(match[1]));
        const rowHeights = [...block.matchAll(/<a:tr\b[^>]*\bh="(-?\d+)"/gi)].map((match) => Number(match[1]));
        if (!columnWidths.length || columnWidths.some((width) => width <= 0)) {
          issues.push(mappedIssue({
            code: 'PPTX_TABLE_COLUMN_WIDTH_INVALID',
            message: `${slide.name} contains a table with a missing or non-positive column width.`,
            severity: 'error',
            target: slide.name,
          }, elementMap, objectName));
        }
        if (!rowHeights.length || rowHeights.some((height) => height <= 0)) {
          issues.push(mappedIssue({
            code: 'PPTX_TABLE_ROW_HEIGHT_INVALID',
            message: `${slide.name} contains a table with a missing or non-positive row height.`,
            severity: 'error',
            target: slide.name,
          }, elementMap, objectName));
        }
      }
      const transform = block.match(/<[ap]:xfrm\b[^>]*>[\s\S]*?<[ap]:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"[^>]*\/>[\s\S]*?<[ap]:ext\b[^>]*\bcx="(-?\d+)"[^>]*\bcy="(-?\d+)"[^>]*\/>[\s\S]*?<\/[ap]:xfrm>/i);
      if (!transform) continue;
      const [x, y, width, height] = transform.slice(1).map(Number);
      if (requireElementIds && (!objectName || !objectName.startsWith('wp_'))) {
        issues.push({ code: 'PPTX_ELEMENT_ID_MISSING', message: `${slide.name} contains a generated object without a stable elementId marker.`, severity: 'error', target: slide.name });
      }
      if (width <= 0 || height <= 0 || x < 0 || y < 0 || (slideWidth && x + width > slideWidth) || (slideHeight && y + height > slideHeight)) {
        issues.push(mappedIssue({
          code: 'PPTX_OBJECT_OUT_OF_BOUNDS',
          message: `${slide.name} contains invalid object bounds x=${x}, y=${y}, width=${width}, height=${height}.`,
          severity: 'error',
          target: slide.name,
        }, elementMap, objectName));
      }
    }
    for (const name of [...xml.matchAll(/\bname="(wp_[^"]+)"/g)].map((match) => match[1])) {
      const mapped = elementMap.find((entry) => entry.artifactName === name);
      if (!mapped) issues.push({ code: 'PPTX_UNMAPPED_GENERATED_OBJECT', message: `${name} is embedded in ${slide.name} but absent from the source element map.`, severity: 'error', target: slide.name });
    }
  }
  const charts = Object.values(zip.files).filter((entry) => !entry.dir && /^ppt\/charts\/chart\d+\.xml$/i.test(entry.name));
  for (const chart of charts) {
    const xml = await chart.async('string');
    if (!/<c:ser\b/i.test(xml)) issues.push({ code: 'PPTX_CHART_HAS_NO_SERIES', message: `${chart.name} contains no data series.`, severity: 'error', target: chart.name });
  }
}

async function validateWordPackage(zip: JSZip, issues: OfficeArtifactIssue[], elementMap: OfficeElementMapEntry[]) {
  const xml = await zip.file('word/document.xml')?.async('string') || '';
  if (!/<w:body\b/i.test(xml)) issues.push({ code: 'DOCX_BODY_MISSING', message: 'word/document.xml has no document body.', severity: 'error', target: 'word/document.xml' });
  if (!/<w:sectPr\b/i.test(xml)) issues.push({ code: 'DOCX_SECTION_PROPERTIES_MISSING', message: 'The document has no section properties; pagination is not deterministic.', severity: 'error', target: 'word/document.xml' });
  for (const paragraph of xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/gi)) {
    const extent = paragraph[0].match(/<wp:extent\b[^>]*\bcx="(-?\d+)"[^>]*\bcy="(-?\d+)"/i);
    if (extent && (Number(extent[1]) <= 0 || Number(extent[2]) <= 0)) {
      const bookmarkName = paragraph[0].match(/<w:bookmarkStart\b[^>]*\bw:name="([^"]+)"/i)?.[1];
      issues.push(mappedIssue({ code: 'DOCX_DRAWING_SIZE_INVALID', message: 'A DrawingML object has a non-positive extent.', severity: 'error', target: 'word/document.xml' }, elementMap, bookmarkName));
    }
  }
  const bookmarks = [...xml.matchAll(/<w:bookmarkStart\b[^>]*\bw:name="([^"]+)"/gi)].map((match) => match[1]);
  const duplicate = bookmarks.find((name, index) => bookmarks.indexOf(name) !== index);
  if (duplicate) issues.push({ code: 'DOCX_DUPLICATE_BOOKMARK', message: `Duplicate bookmark ${duplicate} breaks element mapping.`, severity: 'error', target: 'word/document.xml' });
}

async function validateSpreadsheetPackage(zip: JSZip, issues: OfficeArtifactIssue[]) {
  const workbook = await zip.file('xl/workbook.xml')?.async('string') || '';
  const names = [...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]+)"/gi)].map((match) => match[1]);
  if (!names.length) issues.push({ code: 'XLSX_NO_WORKSHEETS', message: 'Workbook contains no worksheets.', severity: 'error', target: 'xl/workbook.xml' });
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) issues.push({ code: 'XLSX_DUPLICATE_SHEET_NAME', message: `Workbook contains duplicate worksheet name ${duplicate}.`, severity: 'error', target: 'xl/workbook.xml' });
  const worksheets = Object.values(zip.files).filter((entry) => !entry.dir && /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.name));
  for (const worksheet of worksheets) {
    const xml = await worksheet.async('string');
    if (/<f\b[^>]*>[\s\S]*?#(?:REF|VALUE|NAME|DIV\/0|N\/A|NUM|NULL)!/i.test(xml)) {
      issues.push({ code: 'XLSX_FORMULA_ERROR_LITERAL', message: `${worksheet.name} contains a formula error literal.`, severity: 'error', target: worksheet.name });
    }
    const dimensions = [...xml.matchAll(/<dimension\b[^>]*\bref="([^"]+)"/gi)].map((match) => match[1]);
    if (dimensions.some((value) => !/^\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?$/.test(value))) {
      issues.push({ code: 'XLSX_DIMENSION_INVALID', message: `${worksheet.name} contains an invalid used-range dimension.`, severity: 'error', target: worksheet.name });
    }
  }
}

async function validatePdf(absolutePath: string, issues: OfficeArtifactIssue[]) {
  const buffer = await readFile(absolutePath);
  if (buffer.length < 64 || !buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    issues.push({ code: 'PDF_HEADER_INVALID', message: 'Output is not a readable PDF byte stream.', severity: 'error' });
    return { pages: 0, textCharacters: 0 };
  }
  const parser = new PDFParse({ data: buffer });
  try {
    const info = await parser.getInfo();
    const text = await parser.getText();
    if (!info.total) issues.push({ code: 'PDF_HAS_NO_PAGES', message: 'PDF contains no pages.', severity: 'error' });
    return { pages: info.total, textCharacters: text.text.length };
  } catch (error) {
    issues.push({ code: 'PDF_PARSE_FAILED', message: `PDF parser could not reopen the output: ${error instanceof Error ? error.message : String(error)}`, severity: 'error' });
    return { pages: 0, textCharacters: 0 };
  } finally {
    await parser.destroy();
  }
}

export async function validateOfficeArtifact(input: {
  absolutePath: string;
  elementMap?: OfficeElementMapEntry[] | undefined;
  extension: string;
  requireElementIds?: boolean;
  validationProfile?: 'basic' | 'uno-strict';
}) {
  const issues: OfficeArtifactIssue[] = [];
  const extension = input.extension.toLowerCase();
  const elementMap = input.elementMap || [];
  if (extension === '.pdf') {
    if (input.validationProfile !== 'uno-strict') {
      return { issues, passed: true, requestedFonts: [], missingFonts: [], media: [], platform: process.platform };
    }
    const pdf = await validatePdf(input.absolutePath, issues);
    return { issues, passed: !issues.some((issue) => issue.severity === 'error'), requestedFonts: [], missingFonts: [], media: [], platform: process.platform, formatChecks: { pdf } };
  }
  if (!['.pptx', '.docx', '.xlsx', '.odp', '.ods', '.odt'].includes(extension)) {
    return { issues, passed: true, requestedFonts: [], missingFonts: [], media: [], platform: process.platform };
  }
  const zip = await JSZip.loadAsync(await readFile(input.absolutePath));
  const expectedEntry = expectedPackageEntry(extension)!;
  if (!zip.file(expectedEntry)) {
    issues.push({ code: 'OFFICE_PACKAGE_ENTRY_MISSING', message: `Required package entry ${expectedEntry} is missing.`, severity: 'error' });
  }
  const xmlEntries = Object.values(zip.files).filter((entry) => !entry.dir && /\.xml$/i.test(entry.name));
  const requestedFonts = new Set<string>();
  for (const entry of xmlEntries) {
    const xml = await entry.async('string');
    // Word reuses attributes such as w:eastAsia for language metadata
    // (for example w:lang w:eastAsia="zh-CN"). Only treat those attributes
    // as fonts when they occur on w:rFonts. DrawingML/ODF font attributes
    // remain safe to scan directly.
    for (const tag of xml.matchAll(/<w:rFonts\b[^>]*>/gi)) {
      for (const match of tag[0].matchAll(/\bw:(?:ascii|hAnsi|eastAsia|cs)="([^"]+)"/gi)) {
        const name = match[1].trim();
        if (name && !name.startsWith('+')) requestedFonts.add(name);
      }
    }
    for (const match of xml.matchAll(/(?:\btypeface|\bfont-name|\bfont-family)="([^"]+)"/gi)) {
      const name = match[1].trim();
      if (name && !name.startsWith('+')) requestedFonts.add(name);
    }
  }
  const strictUnoValidation = input.validationProfile === 'uno-strict';
  if (strictUnoValidation) await validateRelationships(zip, issues);
  if (strictUnoValidation && extension === '.pptx') await validatePresentationPackage(zip, issues, elementMap, Boolean(input.requireElementIds));
  if (strictUnoValidation && extension === '.docx') await validateWordPackage(zip, issues, elementMap);
  if (strictUnoValidation && extension === '.xlsx') await validateSpreadsheetPackage(zip, issues);
  if (strictUnoValidation && extension === '.docx') {
    const documentXml = await zip.file('word/document.xml')?.async('string') || '';
    const floatingObjectCount = (documentXml.match(/<wp:anchor\b/g) || []).length;
    const textFrameCount = (documentXml.match(/<w:framePr\b/g) || []).length;
    const fixedHeightRows = [...documentXml.matchAll(/<w:trHeight\b([^>]*)\/>/g)]
      .filter((match) => /w:hRule="exact"/.test(match[1] || ''));
    if (floatingObjectCount) {
      issues.push({
        code: 'DOCX_FLOATING_OBJECTS_REQUIRE_VISUAL_QA',
        message: `${floatingObjectCount} floating DrawingML object(s) were preserved. They are supported for freeform authoring but require visual confirmation because they do not participate in normal text flow.`,
        severity: 'warning',
        target: 'word/document.xml',
      });
    }
    if (textFrameCount) {
      issues.push({
        code: 'DOCX_TEXT_FRAMES_REQUIRE_VISUAL_QA',
        message: `${textFrameCount} positioned text frame(s) were preserved. Confirm their anchors, wrapping, and overlap in the rendered pages.`,
        severity: 'warning',
        target: 'word/document.xml',
      });
    }
    if (fixedHeightRows.length) {
      issues.push({
        code: 'DOCX_FIXED_TABLE_ROWS_REQUIRE_VISUAL_QA',
        message: `${fixedHeightRows.length} table row(s) use exact height. Confirm that wrapped text is not clipped after font substitution.`,
        severity: 'warning',
        target: 'word/document.xml',
      });
    }
  }
  const installed = await installedFontNames();
  const missingFonts = [...requestedFonts].filter((font) => {
    const normalized = normalizedFontName(font);
    return normalized && ![...installed].some((candidate) => candidate.includes(normalized) || normalized.includes(candidate));
  });
  for (const font of missingFonts) {
    issues.push({ code: 'FONT_NOT_FOUND', message: `Requested font "${font}" was not matched in the ${process.platform} font inventory; verify LibreOffice substitution.`, severity: 'warning', target: font });
  }
  const prefix = mediaPrefix(extension)!;
  const media: Array<{ name: string; width?: number; height?: number; format?: string }> = [];
  for (const entry of Object.values(zip.files).filter((item) => !item.dir && item.name.startsWith(prefix))) {
    try {
      const metadata = await sharp(await entry.async('nodebuffer'), { failOn: 'none' }).metadata();
      media.push({ name: entry.name, width: metadata.width, height: metadata.height, format: metadata.format });
      if (metadata.width && metadata.height && metadata.width * metadata.height > 40_000_000) {
        issues.push({ code: 'OVERSIZED_EMBEDDED_IMAGE', message: `${entry.name} contains ${metadata.width}x${metadata.height} pixels and may unnecessarily increase file size.`, severity: 'warning', target: entry.name });
      }
    } catch {
      issues.push({ code: 'UNREADABLE_EMBEDDED_IMAGE', message: `Embedded image ${entry.name} could not be decoded.`, severity: 'warning', target: entry.name });
    }
  }
  if (strictUnoValidation && elementMap.length) {
    const searchableXml = (await Promise.all(xmlEntries.map((entry) => entry.async('string')))).join('\n');
    for (const element of elementMap) {
      if (['presentation', 'word-document', 'workbook', 'page-style', 'slide', 'worksheet'].includes(element.kind)) continue;
      if (element.artifactName && !searchableXml.includes(element.artifactName)) {
        issues.push(mappedIssue({
          code: 'ELEMENT_MAPPING_NOT_EMBEDDED',
          message: `elementId ${element.elementId} is registered in source but its artifact marker was not found after serialization.`,
          severity: input.requireElementIds ? 'error' : 'warning',
          target: element.artifactName,
        }, elementMap, element.artifactName));
      }
    }
  }
  return {
    issues,
    passed: !issues.some((issue) => issue.severity === 'error'),
    requestedFonts: [...requestedFonts],
    missingFonts,
    media,
    platform: process.platform,
  };
}

export async function inspectRenderedPage(imagePath: string) {
  const image = sharp(imagePath, { failOn: 'none' });
  const [metadata, stats] = await Promise.all([image.metadata(), image.stats()]);
  const channels = stats.channels.slice(0, 3);
  const dynamicRange = channels.length
    ? Math.max(...channels.map((channel) => channel.max)) - Math.min(...channels.map((channel) => channel.min))
    : 0;
  const issues: OfficeArtifactIssue[] = [];
  if (!metadata.width || !metadata.height) {
    issues.push({ code: 'PAGE_IMAGE_EMPTY', message: 'Rendered page has no measurable dimensions.', severity: 'error' });
  } else if (stats.isOpaque && dynamicRange < 4) {
    issues.push({ code: 'PAGE_APPEARS_BLANK', message: 'Rendered page is nearly uniform and may be blank.', severity: 'warning' });
  }
  return { width: metadata.width, height: metadata.height, issues };
}
