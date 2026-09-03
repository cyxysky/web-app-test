import { asRecord } from '@/lib/unknown-value';

export type BrowserChatFileToolPresentationKey =
  | 'create-draft'
  | 'download-file'
  | 'edit-draft'
  | 'file-visual-index'
  | 'file-visual-read'
  | 'plan-document'
  | 'read-attachment'
  | 'read-draft'
  | 'read-file'
  | 'read-file-visuals'
  | 'render-file'
  | 'uno-api';

export type BrowserChatFileToolPresentation = {
  key: BrowserChatFileToolPresentationKey;
  label: string;
};

function textValue(value: unknown) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function browserChatFileToolPresentation(
  name: string,
  input: unknown,
): BrowserChatFileToolPresentation | undefined {
  if (name !== 'file') return undefined;
  const record = asRecord(input);
  const action = textValue(record?.action);

  if (action === 'visualIndex') return { key: 'file-visual-index', label: '获取截图列表' };
  if (action === 'visualRead') return { key: 'file-visual-read', label: '查看页面截图' };

  if (action === 'read') {
    if (textValue(record?.documentId)) return { key: 'read-draft', label: '读取草稿' };
    const readsVisualPages = record?.includeVisuals === true
      || textValue(record?.includeVisuals).toLowerCase() === 'true'
      || (Array.isArray(record?.pages) && record.pages.length > 0);
    if (readsVisualPages) return { key: 'read-file-visuals', label: '查看页面截图' };
    if (textValue(record?.attachmentId)) return { key: 'read-attachment', label: '读取附件' };
    return { key: 'read-file', label: '读取文件' };
  }

  const presentations: Record<string, BrowserChatFileToolPresentation> = {
    download: { key: 'download-file', label: '下载文件' },
    edit: { key: 'edit-draft', label: '修改草稿' },
    generate: { key: 'create-draft', label: '创建草稿' },
    plan: { key: 'plan-document', label: '规划文档' },
    render: { key: 'render-file', label: '渲染文件' },
    unoApi: { key: 'uno-api', label: '查询 UNO API' },
  };
  return presentations[action];
}
