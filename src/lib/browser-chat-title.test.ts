import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserChatSessionDisplayTitle,
  browserChatSessionTitleParts,
} from './browser-chat-title';

test('keeps a leading file name in historical conversation titles', () => {
  assert.deepEqual(
    browserChatSessionTitleParts('研发部员工年中工作总结报告.docx，基于我上半年的 Jira 故事单'),
    {
      fileName: '研发部员工年中工作总结报告.docx',
      text: '基于我上半年的 Jira 故事单',
    },
  );
  assert.equal(
    browserChatSessionDisplayTitle('研发部员工年中工作总结报告.docx，基于我上半年的 Jira 故事单', 120),
    '研发部员工年中工作总结报告.docx · 基于我上半年的 Jira 故事单',
  );
});

test('restores a historical file title from the first-message attachment', () => {
  const attachments = [{ id: 'file_1', name: '需求文档.pdf', kind: 'file' as const }];
  assert.deepEqual(browserChatSessionTitleParts('，分析主要风险', attachments), {
    fileName: '需求文档.pdf',
    text: '分析主要风险',
  });
  assert.equal(browserChatSessionDisplayTitle('', 120, attachments), '需求文档.pdf');
});
