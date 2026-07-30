function restoreCollapsedMarkdownBlocks(value: string) {
  return value
    .replace(/[ \t]+---[ \t]+/g, '\n\n---\n\n')
    .replace(/([^\n])[ \t]+(?=#{1,6}[ \t]+)/g, '$1\n\n')
    .replace(/\|[ \t]+\|/g, '|\n|')
    .replace(/(^|\n)([^\n|]*\S)[ \t]+(?=\|[^\n]+\|\n\|[ \t]*:?-{3,})/g, '$1$2\n\n')
    .replace(/\|[ \t]+(?=\*\*[^*\n]{1,80}\*\*[ \t]*[:：])/g, '|\n\n');
}

function normalizeMarkdownSegment(value: string) {
  return restoreCollapsedMarkdownBlocks(value)
    .replace(/\r\n?/g, '\n')
    .replace(/([。！？；;])\s+(?=\*\*[^*\n]{1,40}\*\*\s*[:：])/g, '$1\n\n')
    .replace(/([:：。！？；;])\s+-\s+/g, '$1\n- ')
    .replace(/\n{3,}/g, '\n\n');
}

export function normalizeBrowserChatMarkdown(markdown: string) {
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part) => (part.startsWith('`') ? part : normalizeMarkdownSegment(part)))
    .join('')
    .trim();
}
