import { createHash } from 'node:crypto';
import JSZip from 'jszip';

export type DocxTemplateFillTarget = 'nextCell' | 'followingParagraph' | 'replaceText';

export type DocxTemplateFillOperation = {
  anchor: string;
  content: string;
  target: DocxTemplateFillTarget;
  occurrence?: number;
  allowOverwrite?: boolean;
};

export type DocxTemplateFillResult = {
  buffer: Buffer;
  changedParts: string[];
  filledOperations: number;
  preservedParts: number;
};

type XmlRange = {
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
  selfClosing: boolean;
};

const documentPart = 'word/document.xml';

function xmlTagRanges(xml: string, tag: string) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`<${escaped}(?:\\s[^>]*)?\\s*/>|<${escaped}(?:\\s[^>]*)?>|</${escaped}>`, 'g');
  const stack: Array<{ start: number; openEnd: number }> = [];
  const ranges: XmlRange[] = [];
  for (let match = matcher.exec(xml); match; match = matcher.exec(xml)) {
    const token = match[0];
    if (token.startsWith(`</${tag}`)) {
      const open = stack.pop();
      if (open) {
        ranges.push({
          start: open.start,
          openEnd: open.openEnd,
          closeStart: match.index,
          end: match.index + token.length,
          selfClosing: false,
        });
      }
    } else if (token.endsWith('/>')) {
      ranges.push({
        start: match.index,
        openEnd: match.index + token.length,
        closeStart: match.index + token.length,
        end: match.index + token.length,
        selfClosing: true,
      });
    } else {
      stack.push({ start: match.index, openEnd: match.index + token.length });
    }
  }
  return ranges.sort((left, right) => left.start - right.start || right.end - left.end);
}

function decodeXmlText(value: string) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function escapeXmlText(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function visibleText(xml: string) {
  const values: string[] = [];
  const matcher = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  for (let match = matcher.exec(xml); match; match = matcher.exec(xml)) {
    values.push(decodeXmlText(match[1]));
  }
  return values.join('');
}

function selectedRange<T extends XmlRange>(matches: T[], anchor: string, occurrence?: number) {
  if (!matches.length) throw new Error(`DOCX template anchor was not found: ${anchor}`);
  if (occurrence !== undefined) {
    if (!Number.isSafeInteger(occurrence) || occurrence < 1 || occurrence > matches.length) {
      throw new Error(`DOCX template anchor occurrence ${occurrence} is invalid for ${matches.length} match(es): ${anchor}`);
    }
    return matches[occurrence - 1];
  }
  if (matches.length !== 1) {
    throw new Error(`DOCX template anchor is ambiguous (${matches.length} matches); provide occurrence: ${anchor}`);
  }
  return matches[0];
}

function runTextXml(value: string) {
  return value.split(/\r?\n/).map((line, index) => (
    `${index ? '<w:br/>' : ''}<w:t xml:space="preserve">${escapeXmlText(line)}</w:t>`
  )).join('');
}

function setParagraphText(paragraphXml: string, value: string) {
  const textMatcher = /<w:t\b[^>]*>[\s\S]*?<\/w:t>/g;
  const matches = [...paragraphXml.matchAll(textMatcher)];
  if (matches.length) {
    let output = paragraphXml;
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      const match = matches[index];
      const start = match.index!;
      const replacement = index === 0 ? runTextXml(value) : '<w:t></w:t>';
      output = `${output.slice(0, start)}${replacement}${output.slice(start + match[0].length)}`;
    }
    return output;
  }
  if (/\/>$/.test(paragraphXml)) {
    return paragraphXml.replace(/\/>$/, `><w:r>${runTextXml(value)}</w:r></w:p>`);
  }
  return paragraphXml.replace(/<\/w:p>$/, `<w:r>${runTextXml(value)}</w:r></w:p>`);
}

function replaceRange(xml: string, range: XmlRange, replacement: string) {
  return `${xml.slice(0, range.start)}${replacement}${xml.slice(range.end)}`;
}

function directRangesWithin(ranges: XmlRange[], parent: XmlRange) {
  const within = ranges.filter((range) => range.start >= parent.openEnd && range.end <= parent.closeStart);
  return within.filter((candidate) => !within.some((other) => (
    other !== candidate && other.start < candidate.start && other.end > candidate.end
  )));
}

function paragraphMatches(xml: string, anchor: string) {
  return xmlTagRanges(xml, 'w:p').filter((range) => visibleText(xml.slice(range.start, range.end)).includes(anchor));
}

function replaceTextAtAnchor(xml: string, operation: DocxTemplateFillOperation) {
  const paragraph = selectedRange(paragraphMatches(xml, operation.anchor), operation.anchor, operation.occurrence);
  const paragraphXml = xml.slice(paragraph.start, paragraph.end);
  const current = visibleText(paragraphXml);
  const index = current.indexOf(operation.anchor);
  if (index < 0) throw new Error(`DOCX template anchor was not found: ${operation.anchor}`);
  const replacement = `${current.slice(0, index)}${operation.content}${current.slice(index + operation.anchor.length)}`;
  return replaceRange(xml, paragraph, setParagraphText(paragraphXml, replacement));
}

function fillNextCell(xml: string, operation: DocxTemplateFillOperation) {
  const cells = xmlTagRanges(xml, 'w:tc');
  const anchorCell = selectedRange(
    cells.filter((range) => visibleText(xml.slice(range.start, range.end)).includes(operation.anchor)),
    operation.anchor,
    operation.occurrence,
  );
  const row = xmlTagRanges(xml, 'w:tr')
    .filter((range) => range.start < anchorCell.start && range.end > anchorCell.end)
    .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0];
  if (!row) throw new Error(`DOCX template anchor is not inside a table row: ${operation.anchor}`);
  const rowCells = directRangesWithin(cells, row);
  const anchorIndex = rowCells.findIndex((range) => range.start === anchorCell.start && range.end === anchorCell.end);
  const targetCell = rowCells[anchorIndex + 1];
  if (!targetCell) throw new Error(`DOCX template anchor has no following cell: ${operation.anchor}`);
  const targetXml = xml.slice(targetCell.start, targetCell.end);
  const currentText = visibleText(targetXml).trim();
  if (currentText && !operation.allowOverwrite) {
    throw new Error(`DOCX target cell is not empty for anchor "${operation.anchor}"; set allowOverwrite only when replacement is intentional.`);
  }
  const paragraphs = directRangesWithin(xmlTagRanges(xml, 'w:p'), targetCell);
  const paragraph = paragraphs.find((range) => !visibleText(xml.slice(range.start, range.end)).trim()) || paragraphs[0];
  if (!paragraph) {
    const replacement = targetXml.replace(/<\/w:tc>$/, `<w:p><w:r>${runTextXml(operation.content)}</w:r></w:p></w:tc>`);
    return replaceRange(xml, targetCell, replacement);
  }
  return replaceRange(xml, paragraph, setParagraphText(xml.slice(paragraph.start, paragraph.end), operation.content));
}

function fillFollowingParagraph(xml: string, operation: DocxTemplateFillOperation) {
  const anchorParagraph = selectedRange(paragraphMatches(xml, operation.anchor), operation.anchor, operation.occurrence);
  const cells = xmlTagRanges(xml, 'w:tc');
  const containingCell = cells
    .filter((range) => range.start < anchorParagraph.start && range.end > anchorParagraph.end)
    .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0];
  const paragraphPool = containingCell
    ? directRangesWithin(xmlTagRanges(xml, 'w:p'), containingCell)
    : xmlTagRanges(xml, 'w:p');
  const target = paragraphPool.find((range) => (
    range.start > anchorParagraph.end && !visibleText(xml.slice(range.start, range.end)).trim()
  ));
  if (target) return replaceRange(xml, target, setParagraphText(xml.slice(target.start, target.end), operation.content));
  const insertion = `<w:p><w:r>${runTextXml(operation.content)}</w:r></w:p>`;
  return `${xml.slice(0, anchorParagraph.end)}${insertion}${xml.slice(anchorParagraph.end)}`;
}

function applyOperation(xml: string, operation: DocxTemplateFillOperation) {
  const anchor = operation.anchor.trim();
  if (!anchor) throw new Error('DOCX template fill operation requires a non-empty anchor.');
  const normalized = { ...operation, anchor };
  if (operation.target === 'nextCell') return fillNextCell(xml, normalized);
  if (operation.target === 'followingParagraph') return fillFollowingParagraph(xml, normalized);
  return replaceTextAtAnchor(xml, normalized);
}

async function zipPartDigests(zip: JSZip) {
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  const digests = new Map<string, { bytes: number; sha256: string }>();
  let totalBytes = 0;
  for (const entry of entries) {
    const buffer = await entry.async('nodebuffer');
    totalBytes += buffer.byteLength;
    if (totalBytes > 256 * 1024 * 1024) {
      throw new Error('DOCX package expands beyond the 256 MB validation limit.');
    }
    digests.set(entry.name, {
      bytes: buffer.byteLength,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    });
  }
  return digests;
}

export async function fillDocxTemplateBuffer(
  template: Buffer,
  operations: DocxTemplateFillOperation[],
): Promise<DocxTemplateFillResult> {
  if (!operations.length) throw new Error('At least one DOCX template fill operation is required.');
  const zip = await JSZip.loadAsync(template);
  const originalParts = await zipPartDigests(zip);
  const documentEntry = zip.file(documentPart);
  if (!documentEntry) throw new Error('The DOCX template is missing word/document.xml.');
  let xml = await documentEntry.async('string');
  for (const operation of operations) xml = applyOperation(xml, operation);
  zip.file(documentPart, xml);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  const outputZip = await JSZip.loadAsync(buffer);
  const outputParts = await zipPartDigests(outputZip);
  if (originalParts.size !== outputParts.size || [...originalParts.keys()].some((name) => !outputParts.has(name))) {
    throw new Error('DOCX package validation failed because the output part inventory changed.');
  }
  for (const [name, original] of originalParts) {
    if (name === documentPart) continue;
    const output = outputParts.get(name);
    if (!output || original.bytes !== output.bytes || original.sha256 !== output.sha256) {
      throw new Error(`DOCX package validation failed because an unrelated part changed: ${name}`);
    }
  }
  return {
    buffer,
    changedParts: [documentPart],
    filledOperations: operations.length,
    preservedParts: originalParts.size - 1,
  };
}

export async function inspectDocxTemplateBuffer(template: Buffer) {
  const zip = await JSZip.loadAsync(template);
  const documentEntry = zip.file(documentPart);
  if (!documentEntry) throw new Error('The DOCX template is missing word/document.xml.');
  const xml = await documentEntry.async('string');
  const packageEntries = Object.values(zip.files).filter((entry) => !entry.dir);
  const matchingEntries = (pattern: RegExp) => packageEntries.filter((entry) => pattern.test(entry.name));
  const visiblePartTexts = async (pattern: RegExp) => Promise.all(
    matchingEntries(pattern).map(async (entry) => visibleText(await entry.async('string')).replace(/\s+/g, ' ').trim()),
  );
  const headerTexts = (await visiblePartTexts(/^word\/header\d+\.xml$/i)).filter(Boolean);
  const footerTexts = (await visiblePartTexts(/^word\/footer\d+\.xml$/i)).filter(Boolean);
  const commentTexts = (await visiblePartTexts(/^word\/comments\.xml$/i)).filter(Boolean);
  const footnoteTexts = (await visiblePartTexts(/^word\/footnotes\.xml$/i)).filter(Boolean);
  const endnoteTexts = (await visiblePartTexts(/^word\/endnotes\.xml$/i)).filter(Boolean);
  const stylesXml = await zip.file('word/styles.xml')?.async('string') || '';
  const relationshipXml = await Promise.all(
    matchingEntries(/\.rels$/i).map((entry) => entry.async('string')),
  );
  const mediaParts = matchingEntries(/^word\/media\//i).map((entry) => entry.name);
  const cells = xmlTagRanges(xml, 'w:tc');
  const rows = xmlTagRanges(xml, 'w:tr').map((row, index) => ({
    index: index + 1,
    cells: directRangesWithin(cells, row).map((cell) => visibleText(xml.slice(cell.start, cell.end)).replace(/\s+/g, ' ').trim()),
  }));
  const followingParagraphAnchors: string[] = [];
  const paragraphs = xmlTagRanges(xml, 'w:p');
  const paragraphGroups = [
    ...cells.map((cell) => paragraphs.filter((paragraph) => paragraph.start >= cell.openEnd && paragraph.end <= cell.closeStart)),
    paragraphs.filter((paragraph) => !cells.some((cell) => paragraph.start >= cell.openEnd && paragraph.end <= cell.closeStart)),
  ];
  for (const group of paragraphGroups) {
    for (let index = 0; index < group.length - 1; index += 1) {
      const current = visibleText(xml.slice(group[index].start, group[index].end)).replace(/\s+/g, ' ').trim();
      const next = visibleText(xml.slice(group[index + 1].start, group[index + 1].end)).trim();
      if (current && !next) followingParagraphAnchors.push(current);
    }
  }
  return {
    partCount: packageEntries.length,
    paragraphCount: paragraphs.length,
    tableCount: xmlTagRanges(xml, 'w:tbl').length,
    sectionCount: Math.max(1, (xml.match(/<w:sectPr\b/g) || []).length),
    styleCount: (stylesXml.match(/<w:style\b/g) || []).length,
    relationshipCount: relationshipXml.reduce((total, value) => total + (value.match(/<Relationship\b/g) || []).length, 0),
    drawingCount: (xml.match(/<w:(?:drawing|pict)\b/g) || []).length,
    textBoxCount: (xml.match(/<w:txbxContent\b/g) || []).length,
    contentControlCount: (xml.match(/<w:sdt\b/g) || []).length,
    headerCount: matchingEntries(/^word\/header\d+\.xml$/i).length,
    footerCount: matchingEntries(/^word\/footer\d+\.xml$/i).length,
    commentCount: (await zip.file('word/comments.xml')?.async('string') || '').match(/<w:comment\b/g)?.length || 0,
    footnoteCount: (await zip.file('word/footnotes.xml')?.async('string') || '').match(/<w:footnote\b/g)?.length || 0,
    endnoteCount: (await zip.file('word/endnotes.xml')?.async('string') || '').match(/<w:endnote\b/g)?.length || 0,
    mediaCount: mediaParts.length,
    mediaParts: mediaParts.slice(0, 100),
    headerTexts: headerTexts.slice(0, 20),
    footerTexts: footerTexts.slice(0, 20),
    commentTexts: commentTexts.slice(0, 50),
    footnoteTexts: footnoteTexts.slice(0, 50),
    endnoteTexts: endnoteTexts.slice(0, 50),
    rows: rows.filter((row) => row.cells.some(Boolean)).slice(0, 100),
    followingParagraphAnchors: [...new Set(followingParagraphAnchors)].slice(0, 100),
  };
}
