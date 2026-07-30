import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBrowserChatFinalReplyText } from './browser-chat-reply-text';

test('final browser-chat replies preserve Markdown block boundaries', () => {
  const markdown = [
    '已找到目标需求！',
    '',
    '## 找到需求',
    '',
    '| 字段 | 内容 |',
    '|------|------|',
    '| **编号** | **31465** |',
  ].join('\r\n');

  assert.equal(normalizeBrowserChatFinalReplyText(markdown), markdown.replace(/\r\n/g, '\n'));
});
