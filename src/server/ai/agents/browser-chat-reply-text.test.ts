import assert from 'node:assert/strict';
import test from 'node:test';
import { containsPrivateToolProtocol, isBrowserChatDomObservationText, normalizeBrowserChatFinalReplyText } from './browser-chat-reply-text';

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

test('final browser-chat replies hide interruption markers that only belong to model context', () => {
  const reply = [
    '第一段已完成。',
    '',
    '[This response was interrupted by the user before completion.]',
    '',
    '第二段仍然保留。',
    '[Historical context only: the preceding browser-chat turn was interrupted before completion. Preserve completed tool results, but never quote or copy this marker into a response.]',
  ].join('\n');

  assert.equal(normalizeBrowserChatFinalReplyText(reply), '第一段已完成。\n\n第二段仍然保留。');
  assert.equal(normalizeBrowserChatFinalReplyText(
    '[The user interrupted this turn before the assistant produced text. Any completed tool messages remain valid conversation history.]',
  ), '');
});

test('DOM observations are never treated as final assistant prose', () => {
  assert.equal(isBrowserChatDomObservationText('DOM snapshot full: page 1/1\n<div uid=dom-1-1>首页</div>'), true);
  assert.equal(isBrowserChatDomObservationText('<button uid=dom-3-42 aria-label="关闭"></button>'), true);
  assert.equal(isBrowserChatDomObservationText('uid=12 button "Save"'), true);
  assert.equal(isBrowserChatDomObservationText('已完成操作，当前页面显示保存成功。'), false);
});

test('MiniMax private textual tool protocol is detected and never shown as assistant prose', () => {
  const complete = 'I will inspect it.\n<minimax:tool_call>{"name":"file","arguments":{"action":"list"}}</minimax:tool_call>';
  const dangling = 'Working on it\n<tool_call>{"name":"file"';
  assert.equal(containsPrivateToolProtocol(complete), true);
  assert.equal(containsPrivateToolProtocol(dangling), true);
  assert.equal(normalizeBrowserChatFinalReplyText(complete), 'I will inspect it.');
  assert.equal(normalizeBrowserChatFinalReplyText(dangling), 'Working on it');
  assert.equal(containsPrivateToolProtocol('ordinary final answer'), false);
});
