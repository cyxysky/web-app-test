function restoreCollapsedMarkdownBlocks(value: string) {
  return value
    .replace(/[ \t]+---[ \t]+/g, (match, offset: number, source: string) => {
      const before = source.slice(0, offset).trimEnd();
      const after = source.slice(offset + match.length).trimStart();
      return before.endsWith('|') && after.startsWith('|') ? match : '\n\n---\n\n';
    })
    .replace(/([^\n|])[ \t]+(?=#{1,6}[ \t]+[^|\n])/g, '$1\n\n')
    .replace(/\|[ \t]+\|/g, '|\n|')
    .replace(/(^|\n)([^\n|]*\S)[ \t]+(?=\|[^\n]+\|\n\|[ \t]*:?-{3,})/g, '$1$2\n\n')
    .replace(/(^|\n)(\*\*[^*\n]{1,120}\*\*)[ \t]*(?=\|[^\n]+\|\n\|[ \t]*:?-{3,})/g, '$1$2\n\n')
    .replace(/(^|\n)(#{1,6}[ \t]+[^|\n]+?)(\|[^\n]+\|)\n(?=\|[ \t]*:?-{3,})/g, '$1$2\n\n$3\n')
    .replace(/\|[ \t]+(?=\*\*[^*\n]{1,80}\*\*[ \t]*[:：])/g, '|\n\n');
}

function pipeRowCells(value: string) {
  const trimmed = value.trim().replace(/^[-*+][ \t]+/, '');
  if (!/[|｜]/.test(trimmed)) return undefined;
  const body = trimmed.replace(/^[|｜]/, '').replace(/[|｜]$/, '');
  const cells = body.split(/[|｜]/).map((cell) => cell.trim());
  if (cells.length < 2 || cells.some((cell) => !cell)) return undefined;
  return cells;
}

function isPipeDelimiterRow(cells: string[] | undefined) {
  return Boolean(cells?.length && cells.every((cell) => /^:?-{3,}:?$/.test(cell)));
}

function orderedListHeadersBefore(lines: string[], rowIndex: number, expectedCount: number) {
  const lowerBound = Math.max(0, rowIndex - 30);
  for (let start = rowIndex - 1; start >= lowerBound; start -= 1) {
    if (!/^1[.、)][ \t]+\S/.test(lines[start].trim())) continue;
    const headers: string[] = [];
    for (let cursor = start; cursor < rowIndex; cursor += 1) {
      const match = lines[cursor].trim().match(/^(\d+)[.、)][ \t]+(.+)$/);
      if (!match || Number(match[1]) !== headers.length + 1) break;
      headers.push(match[2].trim());
    }
    if (headers.length === expectedCount) return headers;
  }
  return undefined;
}

function normalizeLoosePipeTables(value: string) {
  const lines = value.split('\n');
  const normalized: string[] = [];
  for (let index = 0; index < lines.length;) {
    const firstCells = pipeRowCells(lines[index]);
    if (!firstCells || isPipeDelimiterRow(firstCells)) {
      normalized.push(lines[index]);
      index += 1;
      continue;
    }
    let delimiterIndex = index + 1;
    while (delimiterIndex < lines.length && !lines[delimiterIndex].trim()) delimiterIndex += 1;
    const delimiterCells = pipeRowCells(lines[delimiterIndex] || '');
    if (delimiterCells?.length === firstCells.length && isPipeDelimiterRow(delimiterCells)) {
      normalized.push(...lines.slice(index, delimiterIndex + 1));
      index = delimiterIndex + 1;
      while (index < lines.length) {
        const cells = pipeRowCells(lines[index]);
        if (!cells || cells.length !== firstCells.length || isPipeDelimiterRow(cells)) break;
        normalized.push(lines[index]);
        index += 1;
      }
      continue;
    }
    const rows: string[][] = [firstCells];
    let cursor = index + 1;
    while (cursor < lines.length) {
      let candidateIndex = cursor;
      while (candidateIndex < lines.length && !lines[candidateIndex].trim()) candidateIndex += 1;
      const cells = candidateIndex < lines.length ? pipeRowCells(lines[candidateIndex]) : undefined;
      if (!cells || cells.length !== firstCells.length || isPipeDelimiterRow(cells)) break;
      rows.push(cells);
      cursor = candidateIndex + 1;
    }
    if (rows.length < 2) {
      normalized.push(lines[index]);
      index += 1;
      continue;
    }
    const inferredHeaders = orderedListHeadersBefore(lines, index, firstCells.length);
    const headers = inferredHeaders || rows[0];
    const bodyRows = inferredHeaders ? rows : rows.slice(1);
    normalized.push(`| ${headers.join(' | ')} |`);
    normalized.push(`| ${headers.map(() => '---').join(' | ')} |`);
    normalized.push(...bodyRows.map((cells) => `| ${cells.join(' | ')} |`));
    index = cursor;
  }
  return normalized.join('\n');
}

function normalizeMarkdownSegment(value: string) {
  return normalizeLoosePipeTables(restoreCollapsedMarkdownBlocks(value))
    .replace(/(^|\n)(#{1,6})(?=[A-Za-z\u3400-\u9fff])/g, '$1$2 ')
    .replace(/\\\*\\\*([^\n]+?)\\\*\\\*/g, '**$1**')
    .replace(/\*\*((?:https?:\/\/)[^\s*<>]+)\*\*/gi, '**<$1>**')
    .replace(/\r\n?/g, '\n')
    .replace(/(^|\n)[ \t]*\$\$([^\n]+?)\$\$[ \t]*(?=\n|$)/g, (_match, prefix: string, formula: string) => (
      `${prefix}$$\n${formula.trim()}\n$$`
    ))
    .replace(/([。！？；;])\s+(?=\*\*[^*\n]{1,40}\*\*\s*[:：])/g, '$1\n\n')
    .replace(/([:：。！？；;])\s+-\s+/g, '$1\n- ')
    .replace(/\n{3,}/g, '\n\n');
}

function normalizeFencedCodeBoundaries(value: string) {
  return value
    .replace(/([^\n])[ \t]*(```(?:[a-z0-9_+-]+)?[ \t]*\n)/gi, '$1\n$2')
    .replace(/([^\n])[ \t]*(```[ \t]*)(?=\n|$)/g, '$1\n$2')
    .replace(/(^|\n)(```[ \t]*)(?=#{1,6}[ \t]+|---(?:[ \t]|$))/g, '$1$2\n\n');
}

type MarkdownAstNode = {
  children?: MarkdownAstNode[];
  type?: string;
  value?: string;
};

function unparsedStrongNodes(value: string) {
  const nodes: MarkdownAstNode[] = [];
  let offset = 0;
  for (const match of value.matchAll(/\*\*([^*\n]+?)\*\*/g)) {
    const index = match.index;
    if (index > offset) nodes.push({ type: 'text', value: value.slice(offset, index) });
    nodes.push({
      type: 'strong',
      children: [{ type: 'text', value: match[1] }],
    });
    offset = index + match[0].length;
  }
  if (!nodes.length) return undefined;
  if (offset < value.length) nodes.push({ type: 'text', value: value.slice(offset) });
  return nodes;
}

function restoreUnparsedStrong(node: MarkdownAstNode) {
  if (!Array.isArray(node.children)) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text' && typeof child.value === 'string') {
      return unparsedStrongNodes(child.value) || [child];
    }
    restoreUnparsedStrong(child);
    return [child];
  });
}

/**
 * CommonMark intentionally leaves some `中文**强调（内容）**中文` delimiter
 * combinations as plain text. Convert only those unresolved text nodes after
 * parsing, while leaving code nodes and already valid Markdown untouched.
 */
export function remarkBrowserChatCjkStrong() {
  return (tree: MarkdownAstNode) => restoreUnparsedStrong(tree);
}

export function normalizeBrowserChatMarkdown(markdown: string) {
  return normalizeFencedCodeBoundaries(markdown)
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part) => (part.startsWith('`') ? part : normalizeMarkdownSegment(part)))
    .join('')
    .trim();
}
