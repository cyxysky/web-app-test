import JSZip from 'jszip';

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

function visibleText(xml: string) {
  const values: string[] = [];
  const matcher = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  for (let match = matcher.exec(xml); match; match = matcher.exec(xml)) {
    values.push(decodeXmlText(match[1]));
  }
  return values.join('');
}

function directRangesWithin(ranges: XmlRange[], parent: XmlRange) {
  const within = ranges.filter((range) => range.start >= parent.openEnd && range.end <= parent.closeStart);
  return within.filter((candidate) => !within.some((other) => (
    other !== candidate && other.start < candidate.start && other.end > candidate.end
  )));
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
