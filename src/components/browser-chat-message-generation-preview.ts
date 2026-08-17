const INLINE_REFERENCE_RE = /\[\[(skill|ref):([^\]]+)\]\]/g;

type GenerationPreviewMessage = {
  attachments?: Array<{ id: string; name: string }>;
  content: string;
};

function readInlineTokenId(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function browserChatGenerationPreviewText(
  message: GenerationPreviewMessage,
  skillsById: ReadonlyMap<string, { title: string }>,
  options: { fallbackFileLabel: string; fallbackSkillLabel: string; max: number },
) {
  const attachmentsById = new Map((message.attachments || []).map((attachment) => [attachment.id, attachment]));
  const content = message.content.replace(INLINE_REFERENCE_RE, (_token, type: string, encodedId: string) => {
    const id = readInlineTokenId(encodedId);
    if (type === 'ref') return attachmentsById.get(id)?.name || options.fallbackFileLabel;
    return skillsById.get(id)?.title || options.fallbackSkillLabel;
  });
  const plainText = content
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plainText.length > options.max ? `${plainText.slice(0, options.max)}...` : plainText;
}
