function restoreCollapsedMarkdownBlocks(value: string) {
  return value
    .replace(/[ \t]+---[ \t]+/g, '\n\n---\n\n')
    .replace(/([^\n|])[ \t]+(?=#{1,6}[ \t]+[^|\n])/g, '$1\n\n')
    .replace(/\|[ \t]+\|/g, '|\n|')
    .replace(/(^|\n)([^\n|]*\S)[ \t]+(?=\|[^\n]+\|\n\|[ \t]*:?-{3,})/g, '$1$2\n\n')
    .replace(/\|[ \t]+(?=\*\*[^*\n]{1,80}\*\*[ \t]*[:：])/g, '|\n\n');
}

function normalizeMarkdownSegment(value: string) {
  return restoreCollapsedMarkdownBlocks(value)
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
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part) => (part.startsWith('`') ? part : normalizeMarkdownSegment(part)))
    .join('')
    .trim();
}
