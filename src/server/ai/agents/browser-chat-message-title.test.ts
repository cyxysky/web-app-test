import assert from 'node:assert/strict';
import test from 'node:test';
import { browserChatFirstMessageTitle } from './browser-chat-message-title';

test('uses visible user text when a file reference is the first message content', () => {
  const title = browserChatFirstMessageTitle(
    '[[ref:file_1784688463530_initial]] 这个文件是什么',
    [{ name: '薪酬管理1期-考勤管理模块_测试用例.md' }],
  );

  assert.equal(title, '这个文件是什么');
  assert.doesNotMatch(title, /\[\[ref:/);
});

test('uses the file name when the first message contains only a file reference', () => {
  assert.equal(
    browserChatFirstMessageTitle('[[ref:file_1]]', [{ name: '需求文档.md' }]),
    '需求文档.md',
  );
});
