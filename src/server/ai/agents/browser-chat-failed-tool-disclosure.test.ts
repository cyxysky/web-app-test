import assert from 'node:assert/strict';
import test from 'node:test';
import { appendBrowserChatFailedToolDisclosures } from './browser-chat-executor.agent';

test('final reply deterministically discloses every failed tool call without raw inputs', () => {
  const reply = appendBrowserChatFailedToolDisclosures('任务最终完成。', [{
    index: 1,
    action: '执行网页任务',
    expected: '完成',
    actual: '完成',
    status: 'passed',
    tools: [
      {
        name: 'browserCode',
        ok: false,
        reason: '精确选择标题文本',
        input: { code: 'secret implementation details' },
      },
      {
        name: 'browserCode',
        ok: true,
        reason: '修正标题',
      },
      {
        name: 'browserCode',
        ok: false,
        reason: '上传 drag.txt',
        result: 'internal stack trace',
      },
    ],
  }]);

  assert.match(reply, /任务最终完成/);
  assert.match(reply, /本轮未成功的工具尝试/);
  assert.match(reply, /1\. 精确选择标题文本/);
  assert.match(reply, /2\. 上传 drag\.txt/);
  assert.doesNotMatch(reply, /secret implementation details|internal stack trace/);
});

test('final reply is unchanged when every tool call succeeded', () => {
  assert.equal(appendBrowserChatFailedToolDisclosures('已完成。', [{
    index: 1,
    action: '执行网页任务',
    expected: '完成',
    actual: '完成',
    status: 'passed',
    tools: [{ name: 'browserCode', ok: true, reason: '发布页面' }],
  }]), '已完成。');
});
