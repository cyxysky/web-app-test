import assert from 'node:assert/strict';
import test from 'node:test';
import { browserChatGenerationPreviewText } from './browser-chat-message-generation-preview';

test('renders file and Skill references as a single plain-text generation title', () => {
  const preview = browserChatGenerationPreviewText({
    attachments: [{ id: 'file_report', name: '上半年研发报告.docx' }],
    content: '[[ref:file_report]]，基于 **Jira** 菜单，使用 [[skill:skill_review]] 完成。\n不要提交。',
  }, new Map([['skill_review', { title: '缺陷复盘' }]]), {
    fallbackFileLabel: '文件',
    fallbackSkillLabel: 'Skill',
    max: 200,
  });

  assert.equal(preview, '上半年研发报告.docx，基于 Jira 菜单，使用 缺陷复盘 完成。 不要提交。');
  assert.equal(preview.includes('[[ref:'), false);
  assert.equal(preview.includes('\n'), false);
});

test('uses readable fallbacks for references missing from historical message metadata', () => {
  assert.equal(browserChatGenerationPreviewText({
    content: '读取 [[ref:missing-file]] 并使用 [[skill:missing-skill]]',
  }, new Map(), {
    fallbackFileLabel: '文件',
    fallbackSkillLabel: 'Skill',
    max: 200,
  }), '读取 文件 并使用 Skill');
});
