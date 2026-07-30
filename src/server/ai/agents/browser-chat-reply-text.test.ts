import assert from 'node:assert/strict';
import test from 'node:test';
import { isBrowserChatDomObservationText, normalizeBrowserChatFinalReplyText } from './browser-chat-reply-text';

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

test('DOM observations are never treated as final assistant prose', () => {
  assert.equal(isBrowserChatDomObservationText('DOM snapshot full: page 1/1\n<div uid=dom-1>首页</div>'), true);
  assert.equal(isBrowserChatDomObservationText('<button uid=dom-42 aria-label="关闭"></button>'), true);
  assert.equal(isBrowserChatDomObservationText('uid=12 button "Save"'), true);
  assert.equal(isBrowserChatDomObservationText('已完成操作，当前页面显示保存成功。'), false);
});
