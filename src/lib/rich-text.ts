const entityMap: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntity(entity: string) {
  if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
  if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
  return entityMap[entity] ?? `&${entity};`;
}

export function richTextToPlainText(value?: string) {
  if (!value) return '';

  return value
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[\s\S]*?>/gi, '\n- ')
    .replace(/<\/(p|div|section|article|h[1-6]|blockquote|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&([a-zA-Z]+|#\d+|#x[\da-fA-F]+);/g, (_match, entity: string) => {
      try {
        return decodeEntity(entity);
      } catch {
        return _match;
      }
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
