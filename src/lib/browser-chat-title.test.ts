import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserChatSessionDisplayTitle,
  browserChatSessionTitleParts,
} from './browser-chat-title';

test('parses a historical leading file name but displays the meaningful text', () => {
  assert.deepEqual(
    browserChatSessionTitleParts('研发部员工年中工作总结报告.docx，基于我上半年的 Jira 故事单'),
    {
      fileName: '研发部员工年中工作总结报告.docx',
      text: '基于我上半年的 Jira 故事单',
    },
  );
  assert.equal(
    browserChatSessionDisplayTitle('研发部员工年中工作总结报告.docx，基于我上半年的 Jira 故事单', 120),
    '基于我上半年的 Jira 故事单',
  );
});

test('does not prepend a first-message attachment to a meaningful title', () => {
  const attachments = [{ id: 'file_1', name: '需求文档.pdf', kind: 'file' as const }];
  assert.deepEqual(browserChatSessionTitleParts('，分析主要风险', attachments), {
    text: '分析主要风险',
  });
  assert.equal(browserChatSessionDisplayTitle('分析主要风险', 120, attachments), '分析主要风险');
  assert.equal(browserChatSessionDisplayTitle('', 120, attachments), '需求文档.pdf');
});
