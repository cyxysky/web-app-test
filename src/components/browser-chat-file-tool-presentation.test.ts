import assert from 'node:assert/strict';
import test from 'node:test';
import { browserChatFileToolPresentation } from './browser-chat-file-tool-presentation';

test('distinguishes draft source, ordinary file, attachment, and visual page reads', () => {
  assert.deepEqual(browserChatFileToolPresentation('file', {
    action: 'read', documentId: 'solar-ppt',
  }), { key: 'read-draft', label: '读取生成源码' });
  assert.deepEqual(browserChatFileToolPresentation('file', {
    action: 'readSource', documentId: 'solar-ppt',
  }), { key: 'read-draft', label: '读取生成源码' });
  assert.deepEqual(browserChatFileToolPresentation('file', {
    action: 'readContent', artifactId: 'generated/solar-ppt/deadbeef/file.pptx',
  }), { key: 'read-file', label: '读取文件内容' });
  assert.deepEqual(browserChatFileToolPresentation('file', {
    action: 'read', artifactId: 'generated/solar-ppt/deadbeef/file.pptx',
  }), { key: 'read-file', label: '读取文件' });
  assert.deepEqual(browserChatFileToolPresentation('file', {
    action: 'read', attachmentId: 'attachment-1',
  }), { key: 'read-attachment', label: '读取附件' });
  assert.deepEqual(browserChatFileToolPresentation('file', {
    action: 'read', artifactId: 'generated/solar-ppt/deadbeef/file.pptx', pages: [3, 4, 5, 6, 7, 8],
  }), { key: 'read-file-visuals', label: '查看页面截图' });
});

test('gives unified file visual actions distinct names', () => {
  assert.deepEqual(browserChatFileToolPresentation('file', {
    action: 'visualIndex', artifactId: 'generated/solar-ppt/deadbeef/file.pptx',
  }), { key: 'file-visual-index', label: '获取截图列表' });
  assert.deepEqual(browserChatFileToolPresentation('file', {
    action: 'visualRead', artifactId: 'generated/solar-ppt/deadbeef/file.pptx', screenshotIds: ['screenshot-0003'],
  }), { key: 'file-visual-read', label: '查看页面截图' });
});

test('keeps document authoring actions semantically named', () => {
  assert.equal(browserChatFileToolPresentation('file', { action: 'plan' })?.label, '规划文档');
  assert.equal(browserChatFileToolPresentation('file', { action: 'generate' })?.label, '创建草稿');
  assert.equal(browserChatFileToolPresentation('file', { action: 'edit' })?.label, '修改草稿');
  assert.equal(browserChatFileToolPresentation('file', { action: 'render' })?.label, '渲染文件');
  assert.equal(browserChatFileToolPresentation('file', { action: 'unoApi' })?.label, '查询 UNO API');
  assert.equal(browserChatFileToolPresentation('file', { action: 'download' })?.label, '下载文件');
});
