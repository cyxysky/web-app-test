export type BrowserChatTitleAttachment = {
  id?: string;
  kind?: 'image' | 'file' | 'tab';
  name: string;
  type?: string;
};

export type BrowserChatSessionTitleParts = {
  fileName?: string;
  text: string;
};

const inlineReferenceTokenPattern = /\[\[(?:skill|ref):[^\]]+\]\]/g;
const leadingFileReferencePattern = /^\s*\[\[ref:([^\]]+)\]\]\s*/;
const titleSeparatorPattern = /[,，、;；:：|·]/;
const leadingTitleSeparatorPattern = /^[\s,，、;；:：|·\-—–]+/;
const fileNamePattern = /\.(?:7z|apk|bin|bz2|csv|deb|dmg|docx?|exe|gif|gz|html?|ipa|jpe?g|json|log|md|msi|pdf|pkg|png|pptx?|rar|rpm|svg|tar|tgz|txt|webp|xlsx?|xml|xz|ya?ml|zip)$/i;

function compactTitle(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function decodeReferenceId(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function unwrapTitleFileCandidate(value: string) {
  return value
    .replace(/^\[([^\]]+)\]\([^)]*\)$/, '$1')
    .replace(/^["'“”‘’《》【】[\]()（）]+|["'“”‘’《》【】[\]()（）]+$/g, '')
    .trim();
}

function normalizedTitleText(value: string) {
  return value
    .replace(inlineReferenceTokenPattern, ' ')
    .replace(/\s+/g, ' ')
    .replace(leadingTitleSeparatorPattern, '')
    .trim();
}

function titleFileName(attachment: BrowserChatTitleAttachment | undefined) {
  const name = attachment?.name?.trim() || '';
  if (!name || attachment?.kind === 'tab') return '';
  return fileNamePattern.test(name) ? name : '';
}

function referencedFileName(content: string, attachments: BrowserChatTitleAttachment[]) {
  const reference = content.match(leadingFileReferencePattern)?.[1];
  if (reference) {
    const referenceId = decodeReferenceId(reference);
    const matched = attachments.find((attachment) => attachment.id === referenceId);
    const matchedName = titleFileName(matched);
    if (matchedName) return matchedName;
  }
  return attachments.map(titleFileName).find(Boolean) || '';
}

function explicitTitleFile(value: string) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  const separatorIndex = normalized.search(titleSeparatorPattern);
  const leadingSegment = (separatorIndex >= 0 ? normalized.slice(0, separatorIndex) : normalized).trim();
  const fileName = unwrapTitleFileCandidate(leadingSegment);
  if (!fileNamePattern.test(fileName)) return undefined;
  return {
    fileName,
    text: normalizedTitleText(separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : ''),
  } satisfies BrowserChatSessionTitleParts;
}

export function browserChatSessionTitleParts(
  title: string | undefined,
  attachments: BrowserChatTitleAttachment[] = [],
): BrowserChatSessionTitleParts {
  const rawTitle = title || '';
  const explicitFile = explicitTitleFile(rawTitle);
  if (explicitFile) return explicitFile;

  const normalizedText = normalizedTitleText(rawTitle);
  const fileName = normalizedText ? '' : referencedFileName(rawTitle, attachments);
  const text = fileName && normalizedText.startsWith(fileName)
    ? normalizedTitleText(normalizedText.slice(fileName.length))
    : normalizedText;
  return {
    ...(fileName ? { fileName } : {}),
    text,
  };
}

export function browserChatSessionDisplayTitle(
  title: string | undefined,
  maxLength = 38,
  attachments: BrowserChatTitleAttachment[] = [],
) {
  const parts = browserChatSessionTitleParts(title, attachments);
  return compactTitle(parts.text || parts.fileName || '新对话', maxLength);
}

export function browserChatFirstMessageTitle(
  content: string,
  attachments: BrowserChatTitleAttachment[],
  maxLength = 300,
) {
  const text = normalizedTitleText(content);
  const fileName = text ? '' : referencedFileName(content, attachments);
  return compactTitle(text || fileName || '新建对话', maxLength);
}
