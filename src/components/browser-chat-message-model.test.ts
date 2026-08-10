import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserChatAiCycleAnchorsText,
  browserChatMessageElapsedMs,
  buildBrowserChatAiCycleRenderEntries,
  buildBrowserChatLogIndex,
  buildBrowserChatMessageRenderEntries,
  browserChatAssistantMessageHasVisibleText,
  browserChatLogsForMessage,
  formatBrowserChatElapsedTime,
  isBrowserChatManualVerificationStatusText,
} from './browser-chat-message-model';

test('recognizes localized manual-verification status text without duplicating the verification card', () => {
  assert.equal(isBrowserChatManualVerificationStatusText(
    '已暂停自动操作，等待您检查浏览器并完成可能需要的人工验证；完成后点击对话中的“校验完成，继续执行”。',
  ), true);
  assert.equal(isBrowserChatManualVerificationStatusText(
    '已暂停自动操作：页面需要人工完成验证。',
  ), true);
  assert.equal(isBrowserChatManualVerificationStatusText('这里是需要正常展示的最终回答。'), false);
});

test('keeps text anchored to the tool cycle that emitted it', () => {
  assert.equal(browserChatAiCycleAnchorsText({
    id: 'c1',
    output: {
      texts: ['账号密码已填充。 现在提交登录。'],
      tools: [{ name: 'browserCode' }],
    },
  }, '账号密码已填充。 现在提交登录。'), true);

  assert.equal(browserChatAiCycleAnchorsText({
    id: 'c2',
    output: {
      texts: ['最终回答'],
      tools: [],
    },
  }, '最终回答'), false);
});

test('formats the completed assistant processing duration', () => {
  const elapsed = browserChatMessageElapsedMs({
    createdAt: '2026-07-30T10:00:00.000Z',
    updatedAt: '2026-07-30T10:34:09.000Z',
  });

  assert.equal(elapsed, 2_049_000);
  assert.equal(formatBrowserChatElapsedTime(elapsed), '34m 9s');
  assert.equal(formatBrowserChatElapsedTime(9_200), '9s');
  assert.equal(formatBrowserChatElapsedTime(undefined), '');
});

test('uses the live clock for a running assistant instead of the latest interface update', () => {
  const elapsed = browserChatMessageElapsedMs({
    createdAt: '2026-07-30T10:00:00.000Z',
    updatedAt: '2026-07-30T10:00:03.000Z',
  }, Date.parse('2026-07-30T10:00:20.000Z'));

  assert.equal(elapsed, 20_000);
  assert.equal(formatBrowserChatElapsedTime(elapsed), '20s');
});

test('groups consecutive assistant messages without visible text', () => {
  const messages = [
    { content: 'start', id: 'u1', role: 'user' as const },
    { content: '', id: 'a1', role: 'assistant' as const, stepIndexes: [1] },
    { content: '  ', id: 'a2', role: 'assistant' as const, stepIndexes: [2] },
    { content: 'done', id: 'a3', role: 'assistant' as const },
  ];
  const logIndex = buildBrowserChatLogIndex([{ id: 'l1', stepIndex: 1 }, { id: 'l2', stepIndex: 2 }]);
  const entries = buildBrowserChatMessageRenderEntries(
    messages,
    logIndex,
    (message, logs) => browserChatAssistantMessageHasVisibleText(message, logs, () => []),
    (message) => Boolean(message.stepIndexes?.length),
  );

  assert.equal(entries.length, 3);
  assert.equal(entries[1]?.kind, 'executed-group');
  if (entries[1]?.kind !== 'executed-group') return;
  assert.deepEqual(entries[1].items.map((item) => item.id), ['a1', 'a2']);
});

test('drops an empty assistant message when it has no executed tool', () => {
  const messages = [
    { content: '', id: 'a1', role: 'assistant' as const },
    { content: 'done', id: 'a2', role: 'assistant' as const },
  ];
  const entries = buildBrowserChatMessageRenderEntries(
    messages,
    buildBrowserChatLogIndex([]),
    (message, logs) => browserChatAssistantMessageHasVisibleText(message, logs, () => []),
    () => false,
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.kind, 'message');
  if (entries[0]?.kind !== 'message') return;
  assert.equal(entries[0].item.id, 'a2');
});

test('keeps an empty running assistant message so the loading animation remains visible', () => {
  const running = { content: '', id: 'a1', role: 'assistant' as const, status: 'running' };
  const entries = buildBrowserChatMessageRenderEntries(
    [running],
    buildBrowserChatLogIndex([]),
    (message, logs) => browserChatAssistantMessageHasVisibleText(message, logs, () => []),
    () => false,
  );

  assert.deepEqual(entries, [{ item: running, kind: 'message' }]);
});

test('reads message logs only from the direct message id', () => {
  const logIndex = buildBrowserChatLogIndex([
    { id: 'step', stepIndex: 2 },
    { id: 'direct', messageId: 'a1' },
  ]);

  const logs = browserChatLogsForMessage({ content: '', id: 'a1', role: 'assistant', stepIndexes: [2] }, logIndex);

  assert.deepEqual(logs.map((log) => log.id), ['direct']);
});

test('groups ai cycles without text into executed entries', () => {
  const entries = buildBrowserChatAiCycleRenderEntries([
    { id: 'c1', output: { texts: [] } },
    { id: 'c2', output: { texts: ['   '] } },
    { id: 'c3', output: { texts: ['visible'] } },
  ]);

  assert.equal(entries[0]?.kind, 'executed');
  assert.equal(entries[1]?.kind, 'cycle');
});

test('does not render an executed group for an AI tool request without a real execution', () => {
  const entries = buildBrowserChatAiCycleRenderEntries([
    { id: 'c1', output: { texts: [] } },
  ], () => false);

  assert.deepEqual(entries, []);
});

test('keeps reasoning-only cycles out of the executed group', () => {
  const entries = buildBrowserChatAiCycleRenderEntries([
    { id: 'c1', output: { reasoning: ['checking the file'], texts: [] } },
  ], () => false);

  assert.equal(entries[0]?.kind, 'cycle');
});
