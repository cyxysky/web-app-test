import assert from 'node:assert/strict';
import test from 'node:test';
import { browserChatFirstMessageTitle } from './browser-chat-message-title';

test('uses meaningful message text instead of prepending an inline file name', () => {
  const title = browserChatFirstMessageTitle(
    '[[ref:file_1784688463530_initial]]，基于上半年的 Jira 故事单生成总结',
    [{ id: 'file_1784688463530_initial', name: '薪酬管理1期-考勤管理模块_测试用例.md' }],
  );

  assert.equal(title, '基于上半年的 Jira 故事单生成总结');
  assert.doesNotMatch(title, /\[\[ref:/);
});

test('does not prepend an uploaded image name to meaningful message text', () => {
  assert.equal(
    browserChatFirstMessageTitle('从零完成一次 UNO 全能力文档生成', [
      { id: 'image_1', kind: 'image', name: 'jwst-nirspec.jpg' },
    ]),
    '从零完成一次 UNO 全能力文档生成',
  );
});

test('uses the file name when the first message only contains a file reference', () => {
  assert.equal(
    browserChatFirstMessageTitle('[[ref:file_1]]', [{ id: 'file_1', name: '需求文档.md' }]),
    '需求文档.md',
  );
});
