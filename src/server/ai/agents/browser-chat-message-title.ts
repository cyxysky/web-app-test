type BrowserChatTitleAttachment = {
  name: string;
};

const inlineReferenceTokenPattern = /\[\[(?:skill|ref):[^\]]+\]\]/g;

export function browserChatFirstMessageTitle(
  content: string,
  attachments: BrowserChatTitleAttachment[],
  maxLength = 42,
) {
  const visibleText = content
    .replace(inlineReferenceTokenPattern, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const attachmentNames = attachments
    .map((attachment) => attachment.name.trim())
    .filter(Boolean)
    .join('、');
  const title = visibleText || attachmentNames || '新建对话';
  return title.length > maxLength ? `${title.slice(0, maxLength)}...` : title;
}
