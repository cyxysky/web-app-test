import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserChatAiCycleAnchorsText,
  browserChatAiCycleTextIsAccepted,
  browserChatAssistantMessageHasExecutionMetadata,
  browserChatMessageElapsedMs,
  browserChatMessageIsTextStreaming,
  normalizeBrowserChatMessageRunStates,
  browserChatTerminalAnswerCycleIndex,
  buildBrowserChatAiCycleRenderEntries,
  buildBrowserChatLogIndex,
  buildBrowserChatMessageRenderEntries,
  browserChatAssistantMessageHasVisibleText,
  browserChatLogsForMessage,
  formatBrowserChatElapsedTime,
  isBrowserChatManualVerificationStatusText,
} from './browser-chat-message-model';

test('withholds text-only model cycles until the server accepts the terminal response', () => {
  const textOnly = { id: 'answer', output: { texts: ['premature final'], tools: [] } };
  const withTool = { id: 'progress', output: { texts: ['working'], tools: [{ name: 'file' }] } };

  assert.equal(browserChatAiCycleTextIsAccepted('running', textOnly), false);
  assert.equal(browserChatAiCycleTextIsAccepted('failed', textOnly), false);
  assert.equal(browserChatAiCycleTextIsAccepted('blocked', textOnly), false);
  assert.equal(browserChatAiCycleTextIsAccepted('passed', textOnly), false);
  assert.equal(browserChatAiCycleTextIsAccepted('passed', textOnly, true), true);
  assert.equal(browserChatAiCycleTextIsAccepted(undefined, textOnly), true);
  assert.equal(browserChatAiCycleTextIsAccepted('running', withTool), false);
  assert.equal(browserChatAiCycleTextIsAccepted('passed', withTool), true);
});

test('shows the streaming caret only while model text is actively streaming', () => {
  assert.equal(browserChatMessageIsTextStreaming({
    activity: { phase: 'ai:text:streaming' },
    content: '华',
    id: 'a1',
    role: 'assistant',
    status: 'running',
  }), true);
  assert.equal(browserChatMessageIsTextStreaming({
    activity: { phase: 'browser:tool' },
    content: '华',
    id: 'a1',
    role: 'assistant',
    status: 'running',
  }), false);
});

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

test('treats the last text-only cycle as the terminal answer even when persisted links were rewritten', () => {
  const cycles = [
    {
      id: 'tool-cycle',
      output: {
        texts: ['Generating the document.'],
        tools: [{ name: 'generateFile' }],
      },
    },
    {
      id: 'answer-cycle',
      output: {
        texts: ['[report.docx](/temporary/model-link)'],
        tools: [],
      },
    },
  ];

  assert.equal(browserChatTerminalAnswerCycleIndex(cycles), 1);
  assert.notEqual(cycles[1].output.texts[0], '[report.docx](/canonical/artifact-link)');
});

test('keeps historical message actions available from step metadata before details are lazy-loaded', () => {
  assert.equal(browserChatAssistantMessageHasExecutionMetadata({
    content: 'done',
    id: 'a1',
    role: 'assistant',
    status: 'passed',
    stepIndexes: [19],
  }), true);
  assert.equal(browserChatAssistantMessageHasExecutionMetadata({
    content: 'done',
    id: 'a2',
    role: 'assistant',
    status: 'passed',
  }), false);
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

test('only the current assistant turn remains running in the UI', () => {
  const messages = [
    { content: '', id: 'old-assistant', role: 'assistant' as const, status: 'running', activity: { phase: 'ai:runtime:request' } },
    { content: 'next request', id: 'new-user', role: 'user' as const },
    { content: '', id: 'current-assistant', role: 'assistant' as const, status: 'running', activity: { phase: 'ai:text:streaming' } },
  ];

  const active = normalizeBrowserChatMessageRunStates(messages, {
    currentAssistantMessageId: 'current-assistant',
    sessionBusy: true,
  });
  assert.equal(active[0]?.status, 'interrupted');
  assert.equal(active[0]?.activity, undefined);
  assert.equal(active[2]?.status, 'running');

  const idle = normalizeBrowserChatMessageRunStates(messages, {
    currentAssistantMessageId: 'current-assistant',
    sessionBusy: false,
  });
  assert.equal(idle[0]?.status, 'interrupted');
  assert.equal(idle[2]?.status, 'interrupted');
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
