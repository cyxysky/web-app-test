import { asRecord } from '@/lib/unknown-value';

export type BrowserChatFileToolPresentationKey =
  | 'create-draft'
  | 'download-file'
  | 'edit-draft'
  | 'file-visual-index'
  | 'file-visual-read'
  | 'file-visual-report'
  | 'convert-file'
  | 'list-drafts'
  | 'js-api'
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
  if (action === 'readSource') return { key: 'read-draft', label: '读取生成源码' };
  if (action === 'readContent') return { key: 'read-file', label: '读取文件内容' };

  if (action === 'read') {
    if (textValue(record?.documentId)) return { key: 'read-draft', label: '读取生成源码' };
    const readsVisualPages = record?.includeVisuals === true
      || textValue(record?.includeVisuals).toLowerCase() === 'true'
      || (Array.isArray(record?.pages) && record.pages.length > 0);
    if (readsVisualPages) return { key: 'read-file-visuals', label: '查看页面截图' };
    if (textValue(record?.attachmentId)) return { key: 'read-attachment', label: '读取附件' };
    return { key: 'read-file', label: '读取文件' };
  }

  const presentations: Record<string, BrowserChatFileToolPresentation> = {
    list: { key: 'list-drafts', label: '列出文档草稿' },
    convert: { key: 'convert-file', label: '转换文件格式' },
    jsApi: { key: 'js-api', label: '查询 JavaScript API' },
    visualReport: { key: 'file-visual-report', label: '提交视觉检查' },
    download: { key: 'download-file', label: '下载文件' },
    edit: { key: 'edit-draft', label: '修改草稿' },
    generate: { key: 'create-draft', label: '创建草稿' },
    plan: { key: 'plan-document', label: '规划文档' },
    render: { key: 'render-file', label: '渲染文件' },
    unoApi: { key: 'uno-api', label: '查询 UNO API' },
  };
  return presentations[action];
}
