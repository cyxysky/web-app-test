import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { PDFParse } from 'pdf-parse';
import sharp from 'sharp';

export type OfficeArtifactIssue = {
  callColumn?: number;
  callLine?: number;
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
  callColumn?: number;
  callLine?: number;
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
  return mapped ? {
    ...issue,
    elementId: mapped.elementId,
    line: mapped.line,
    column: mapped.column,
    callLine: mapped.callLine,
    callColumn: mapped.callColumn,
    locator: mapped.locator,
  } : issue;
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
      const nativeMediaObject = /<a:videoFile\b|<p14:media\b|ppaction:\/\/media/i.test(block);
      if (requireElementIds && !nativeMediaObject && (!objectName || !objectName.startsWith('wp_'))) {
        issues.push({ code: 'PPTX_ELEMENT_ID_MISSING', message: `${slide.name} contains a generated object without a stable elementId marker.`, severity: 'error', target: slide.name });
      }
      // DrawingML serializes a legal horizontal/vertical line with one zero
      // extent. Requiring both extents to be positive rejects chart axes,
      // ticks, rules, and connectors even though PowerPoint/LibreOffice render
      // them correctly. Keep the strict positive-size rule for every other
      // object and still reject a point-sized line or an out-of-slide line.
      const isLine = /<a:prstGeom\b[^>]*\bprst="line"/i.test(block);
      const invalidSize = isLine ? width < 0 || height < 0 || (width === 0 && height === 0) : width <= 0 || height <= 0;
      if (invalidSize || x < 0 || y < 0 || (slideWidth && x + width > slideWidth) || (slideHeight && y + height > slideHeight)) {
        issues.push(mappedIssue({
          code: 'PPTX_OBJECT_OUT_OF_BOUNDS',
          message: `${slide.name} contains invalid object bounds x=${x}, y=${y}, width=${width}, height=${height}.`,
          severity: 'error',
          target: slide.name,
        }, elementMap, objectName));
      }
    }
    if (requireElementIds) {
      for (const name of [...xml.matchAll(/\bname="(wp_[^"]+)"/g)].map((match) => match[1])) {
        // LibreOffice appends a numeric suffix when a whole slide is
        // duplicated (for example "wp_agenda_title 1"). The duplicated
        // object still carries the stable marker of its source object; treat
        // that serialization suffix as a derived copy, not an unmapped shape.
        const duplicateBaseName = name.replace(/\s+\d+$/, '');
        const mapped = elementMap.find((entry) => (
          entry.artifactName === name || entry.artifactName === duplicateBaseName
        ));
        if (!mapped) issues.push({ code: 'PPTX_UNMAPPED_GENERATED_OBJECT', message: `${name} is embedded in ${slide.name} but absent from the source element map.`, severity: 'error', target: slide.name });
      }
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
    const errorCells = [...xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)].filter((match) => (
      /\bt="e"/i.test(match[1] || '')
      && /<v>\s*#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|GETTING_DATA|SPILL!|CALC!|FIELD!|BLOCKED!|UNKNOWN!|CONNECT!)\s*<\/v>/i.test(match[2] || '')
    ));
    if (errorCells.length) {
      issues.push({ code: 'XLSX_FORMULA_ERROR_LITERAL', message: `${worksheet.name} contains ${errorCells.length} visible spreadsheet error cell(s).`, severity: 'error', target: worksheet.name });
    }
    const dimensions = [...xml.matchAll(/<dimension\b[^>]*\bref="([^"]+)"/gi)].map((match) => match[1]);
    if (dimensions.some((value) => !/^\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?$/.test(value))) {
      issues.push({ code: 'XLSX_DIMENSION_INVALID', message: `${worksheet.name} contains an invalid used-range dimension.`, severity: 'error', target: worksheet.name });
    }
  }
}

async function officePackageFormatChecks(zip: JSZip, extension: string, featureCounts: Record<string, number> = {}) {
  const fileNames = Object.values(zip.files).filter((entry) => !entry.dir).map((entry) => entry.name);
  if (extension === '.pptx') {
    const slides = Object.values(zip.files).filter((entry) => !entry.dir && /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name));
    const slideXml = await Promise.all(slides.map((entry) => entry.async('string')));
    const nativeChartCount = fileNames.filter((name) => /^ppt\/charts\/chart\d+\.xml$/i.test(name)).length;
    const chartTypeCounts: Record<string, number> = {};
    for (const name of fileNames.filter((entry) => /^ppt\/charts\/chart\d+\.xml$/i.test(entry))) {
      const xml = await zip.file(name)!.async('string');
      for (const match of xml.matchAll(/<c:(barChart|lineChart|areaChart|pieChart|doughnutChart|scatterChart|bubbleChart|radarChart|stockChart)\b[^>]*>([\s\S]*?)<\/c:\1>/g)) {
        const type = match[1] === 'barChart'
          ? (/<c:barDir\b[^>]*\bval="bar"/.test(match[2]) ? 'bar' : 'column')
          : match[1] === 'radarChart'
            ? (/<c:radarStyle\b[^>]*\bval="filled"/.test(match[2]) ? 'filled-radar' : 'radar')
            : match[1] === 'doughnutChart' ? 'donut' : match[1].replace(/Chart$/, '');
        chartTypeCounts[type] = (chartTypeCounts[type] || 0) + 1;
      }
    }
    return {
      presentation: {
        chartTypeCounts,
        animationCount: slideXml.reduce((count, xml) => count + (xml.match(/<p:anim(?:Effect|Motion|Rot|Scale|Clr)?\b/gi) || []).length, 0),
        chartCount: nativeChartCount,
        commentCount: fileNames.filter((name) => /^ppt\/comments\/comment\d+\.xml$/i.test(name)).length,
        customShowCount: ((await zip.file('ppt/presentation.xml')?.async('string')) || '').match(/<p:custShow\b/gi)?.length || 0,
        embeddedObjectCount: fileNames.filter((name) => /^ppt\/embeddings\//i.test(name)).length,
        layoutCount: fileNames.filter((name) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/i.test(name)).length,
        masterCount: fileNames.filter((name) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/i.test(name)).length,
        mediaCount: fileNames.filter((name) => /^ppt\/media\//i.test(name)).length,
        nativeChartCount,
        notesCount: fileNames.filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(name)).length,
        fieldCount: slideXml.reduce((count, xml) => count + (xml.match(/<a:fld\b/gi) || []).length, 0),
        authoredExternalHyperlinkCount: Number(featureCounts.externalHyperlink || 0),
        authoredInternalSlideHyperlinkCount: Number(featureCounts.internalSlideHyperlink || 0),
        serializedHyperlinkCount: slideXml.reduce((count, xml) => count + (xml.match(/<a:hlinkClick\b/gi) || []).length, 0),
        imageCount: fileNames.filter((name) => name.startsWith('ppt/media/')).length,
        slideCount: slides.length,
        tableCount: slideXml.reduce((count, xml) => count + (xml.match(/<a:tbl\b/gi) || []).length, 0),
        transitionCount: slideXml.reduce((count, xml) => count + (xml.match(/<p:transition\b/gi) || []).length, 0),
      },
    };
  }
  if (extension === '.docx') {
    const documentXml = await zip.file('word/document.xml')?.async('string') || '';
    return {
      word: {
        bookmarkCount: (documentXml.match(/<w:bookmarkStart\b/gi) || []).length,
        chartCount: fileNames.filter((name) => /^word\/charts\/chart\d+\.xml$/i.test(name)).length,
        commentCount: fileNames.filter((name) => /^word\/comments\.xml$/i.test(name)).length,
        contentControlCount: (documentXml.match(/<w:sdt\b/gi) || []).length,
        endnoteCount: fileNames.filter((name) => /^word\/endnotes\.xml$/i.test(name)).length,
        fieldCount: (documentXml.match(/<w:(?:fldSimple|instrText)\b/gi) || []).length,
        floatingObjectCount: (documentXml.match(/<wp:anchor\b/gi) || []).length,
        footnoteCount: fileNames.filter((name) => /^word\/footnotes\.xml$/i.test(name)).length,
        hyperlinkCount: (documentXml.match(/<w:hyperlink\b/gi) || []).length,
        imageCount: fileNames.filter((name) => name.startsWith('word/media/')).length,
        inlineObjectCount: (documentXml.match(/<wp:inline\b/gi) || []).length,
        paragraphCount: (documentXml.match(/<w:p\b/gi) || []).length,
        sectionCount: (documentXml.match(/<w:sectPr\b/gi) || []).length,
        tableCount: (documentXml.match(/<w:tbl\b/gi) || []).length,
      },
    };
  }
  if (extension === '.xlsx') {
    const worksheets = Object.values(zip.files).filter((entry) => !entry.dir && /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.name));
    const worksheetXml = await Promise.all(worksheets.map((entry) => entry.async('string')));
    const formulaCount = worksheetXml.reduce((count, xml) => count + (xml.match(/<f\b/gi) || []).length, 0);
    const errorCellCount = worksheetXml.reduce((count, xml) => count + [...xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)].filter((match) => (
      /\bt="e"/i.test(match[1] || '') && /<v>\s*#[^<]+<\/v>/i.test(match[2] || '')
    )).length, 0);
    return {
      spreadsheet: {
        chartCount: fileNames.filter((name) => /^xl\/charts\/chart\d+\.xml$/i.test(name)).length,
        commentCount: fileNames.filter((name) => /^xl\/comments\d+\.xml$/i.test(name)).length,
        conditionalFormatCount: worksheetXml.reduce((count, xml) => count + (xml.match(/<conditionalFormatting\b/gi) || []).length, 0),
        dataValidationCount: worksheetXml.reduce((count, xml) => count + (xml.match(/<dataValidation\b/gi) || []).length, 0),
        drawingCount: fileNames.filter((name) => /^xl\/drawings\/drawing\d+\.xml$/i.test(name)).length,
        errorCellCount,
        filterCount: worksheetXml.reduce((count, xml) => count + (xml.match(/<autoFilter\b/gi) || []).length, 0),
        formulaCount,
        freezePaneCount: worksheetXml.reduce((count, xml) => count + (xml.match(/<pane\b[^>]*\bstate="frozen/i) || []).length, 0),
        hyperlinkCount: worksheetXml.reduce((count, xml) => count + (xml.match(/<hyperlink\b/gi) || []).length, 0),
        imageCount: fileNames.filter((name) => name.startsWith('xl/media/')).length,
        mergedRangeCount: worksheetXml.reduce((count, xml) => count + (xml.match(/<mergeCell\b/gi) || []).length, 0),
        namedRangeCount: (((await zip.file('xl/workbook.xml')?.async('string')) || '').match(/<definedName\b/gi) || []).length,
        outlineCount: worksheetXml.reduce((count, xml) => count + (xml.match(/\boutlineLevel="[1-9]/gi) || []).length, 0),
        pivotTableCount: fileNames.filter((name) => /^xl\/pivotTables\/pivotTable\d+\.xml$/i.test(name)).length,
        protectionCount: worksheetXml.reduce((count, xml) => count + (xml.match(/<sheetProtection\b/gi) || []).length, 0),
        structuredTableCount: fileNames.filter((name) => /^xl\/tables\/table\d+\.xml$/i.test(name)).length,
        subtotalFormulaCount: worksheetXml.reduce((count, xml) => count + (xml.match(/<f\b[^>]*>[^<]*SUBTOTAL\s*\(/gi) || []).length, 0),
        worksheetCount: worksheets.length,
      },
    };
  }
  return { package: { partCount: fileNames.length } };
}

async function preserveOnlyFeatureCounts(zip: JSZip, extension: string) {
  const files = Object.values(zip.files).filter((entry) => !entry.dir);
  const names = files.map((entry) => entry.name);
  const xmlFiles = files.filter((entry) => /\.xml$/i.test(entry.name));
  const xml = (await Promise.all(xmlFiles.map((entry) => entry.async('string')))).join('\n');
  const common = {
    digitalSignatures: names.filter((name) => /^_xmlsignatures\//i.test(name)).length,
    embeddedObjects: names.filter((name) => /\/(?:embeddings|oleObjects)\//i.test(name)).length,
    macros: names.filter((name) => /(?:^|\/)vbaProject\.bin$/i.test(name)).length,
  };
  if (extension === '.pptx') {
    return {
      ...common,
      activeX: names.filter((name) => /^ppt\/activeX\//i.test(name)).length,
      comments: names.filter((name) => /^ppt\/comments\/comment\d+\.xml$/i.test(name)).length,
      customShows: (xml.match(/<p:custShow\b/gi) || []).length,
      morphTransitions: (xml.match(/<(?:p14|p159):morph\b/gi) || []).length,
      smartArt: names.filter((name) => /^ppt\/diagrams\//i.test(name)).length,
    };
  }
  if (extension === '.docx') {
    return {
      ...common,
      comments: names.filter((name) => /^word\/comments(?:Extended)?\.xml$/i.test(name)).length,
      contentControls: (xml.match(/<w:sdt\b/gi) || []).length,
      endnotes: names.filter((name) => /^word\/endnotes\.xml$/i.test(name)).length,
      footnotes: names.filter((name) => /^word\/footnotes\.xml$/i.test(name)).length,
      trackedChanges: (xml.match(/<w:(?:ins|del|moveFrom|moveTo)\b/gi) || []).length,
    };
  }
  if (extension === '.xlsx') {
    return {
      ...common,
      activeX: names.filter((name) => /^xl\/activeX\//i.test(name)).length,
      chartExtensions: names.filter((name) => /^xl\/chartsEx\//i.test(name)).length,
      connections: names.filter((name) => /^xl\/connections\.xml$/i.test(name)).length,
      externalLinks: names.filter((name) => /^xl\/externalLinks\//i.test(name)).length,
      pivotCaches: names.filter((name) => /^xl\/pivotCache\//i.test(name)).length,
      pivotTables: names.filter((name) => /^xl\/pivotTables\//i.test(name)).length,
      slicers: names.filter((name) => /^xl\/slicers\//i.test(name)).length,
      structuredTables: names.filter((name) => /^xl\/tables\/table\d+\.xml$/i.test(name)).length,
      timelines: names.filter((name) => /^xl\/timelines\//i.test(name)).length,
    };
  }
  return common;
}

async function validatePreserveOnlyFeatures(
  sourceAbsolutePath: string,
  outputZip: JSZip,
  extension: string,
  issues: OfficeArtifactIssue[],
) {
  const sourceZip = await JSZip.loadAsync(await readFile(sourceAbsolutePath));
  const [before, after] = await Promise.all([
    preserveOnlyFeatureCounts(sourceZip, extension),
    preserveOnlyFeatureCounts(outputZip, extension),
  ]);
  for (const [feature, beforeCount] of Object.entries(before)) {
    const afterCount = Number(after[feature as keyof typeof after] || 0);
    if (Number(beforeCount) > afterCount) {
      issues.push({
        code: 'OFFICE_PRESERVE_ONLY_FEATURE_LOST',
        message: `Existing-file edit lost preserve-only feature ${feature}: source=${beforeCount}, output=${afterCount}. LibreOffice may open this feature, but the high-level facade does not claim safe recreation.`,
        severity: 'error',
        target: feature,
      });
    }
  }
  return { before, after };
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
  sourceAbsolutePath?: string;
  elementMap?: OfficeElementMapEntry[] | undefined;
  extension: string;
  requireElementIds?: boolean;
  validationProfile?: 'basic' | 'uno-strict';
  featureCounts?: Record<string, number>;
}) {
  const issues: OfficeArtifactIssue[] = [];
  const extension = input.extension.toLowerCase();
  const elementMap = input.elementMap || [];
  if (extension === '.pdf') {
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
  await validateRelationships(zip, issues);
  if (extension === '.pptx') await validatePresentationPackage(zip, issues, elementMap, strictUnoValidation && Boolean(input.requireElementIds));
  if (extension === '.docx') await validateWordPackage(zip, issues, elementMap);
  if (extension === '.xlsx') await validateSpreadsheetPackage(zip, issues);
  const preservation = input.sourceAbsolutePath && ['.pptx', '.docx', '.xlsx'].includes(extension)
    ? await validatePreserveOnlyFeatures(input.sourceAbsolutePath, zip, extension, issues)
    : undefined;
  if (extension === '.docx') {
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
  // Calc cells, ranges, widths, merges, print settings and several other
  // worksheet primitives do not have an OOXML field that can retain the
  // facade's diagnostic artifactName. Requiring those markers made every
  // feature-rich XLSX fail strict validation even though the workbook and its
  // feature counts were valid, and encouraged destructive removal of required
  // elementId arguments. Keep strict serialized-marker enforcement for Writer
  // and Impress, whose bookmarks/drawing names have stable OOXML homes; XLSX
  // remains traceable through the returned elementMap plus semantic checks.
  if (strictUnoValidation && elementMap.length && extension !== '.xlsx') {
    const searchableXml = (await Promise.all(xmlEntries.map((entry) => entry.async('string')))).join('\n');
    const nonSerializedKinds = new Set([
      'alphabetical-index',
      'bookmark',
      'comment',
      'content-control',
      'cross-reference',
      'endnote',
      'existing-shape',
      'field',
      'footnote',
      'formula',
      'mail-merge-field',
      'media',
      'merged-table-cells',
      'paragraph-style',
      'section',
      'slide-comment',
      'slide-transition',
      'speaker-notes',
      'table-of-contents',
      'text-frame',
      'text-replacement',
    ]);
    for (const element of elementMap) {
      if (['presentation', 'word-document', 'workbook', 'page-style', 'slide', 'worksheet'].includes(element.kind)) continue;
      // These entries describe editing operations or OOXML features whose
      // native serialization has no stable drawing-name/bookmark field. They
      // remain traceable in the element map and feature counts, while strict
      // marker checks continue to cover authored shapes, tables, images and
      // Writer flow objects that do have a durable OOXML marker location.
      if (nonSerializedKinds.has(element.kind)) continue;
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
    formatChecks: {
      ...(await officePackageFormatChecks(zip, extension, input.featureCounts)),
      ...(preservation ? { preservation } : {}),
    },
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
