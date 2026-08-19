import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeDurablePersonalMemoryDrafts,
  filterDurablePersonalMemoryDrafts,
  formatPersonalMemoryForPrompt,
  normalizePersonalMemoryValue,
  parsePersonalMemoryExtractionOutput,
  type PersonalMemoryItem,
} from './personal-memory';

test('parses plain or fenced personal-memory JSON and treats an empty response as no candidates', () => {
  const item = {
    scope: 'global',
    type: 'preference',
    key: '页面语言',
    value: '默认使用中文页面。',
    evidence: ['以后页面默认用中文'],
    durability: 'explicit_preference',
  };
  assert.deepEqual(parsePersonalMemoryExtractionOutput(JSON.stringify({ items: [item] })), { items: [item] });
  assert.deepEqual(parsePersonalMemoryExtractionOutput(`\`\`\`json\n${JSON.stringify({ items: [item] })}\n\`\`\``), { items: [item] });
  assert.deepEqual(parsePersonalMemoryExtractionOutput(''), { items: [] });
  assert.throws(() => parsePersonalMemoryExtractionOutput('{"items":['), /invalid JSON|no JSON object/);
});

test('keeps complete personal memory text and normalizes line endings without collapsing lines', () => {
  const longLine = '长'.repeat(400);
  assert.equal(
    normalizePersonalMemoryValue(`\r\n第一行\r\n\r\n第二行 ${longLine}\r\n`),
    `第一行\n\n第二行 ${longLine}`,
  );
});

test('formats multiline personal memory for prompts and applies only a prompt-time budget', () => {
  const previousLimit = process.env.AI_PERSONAL_MEMORY_PROMPT_MAX_CHARS;
  const item: PersonalMemoryItem = {
    id: 'memory_multiline',
    userId: '0',
    shared: false,
    scope: 'global',
    domain: '',
    type: 'workflow',
    key: '发布步骤',
    aliases: [],
    value: `第一行\n第二行\n${'长'.repeat(1200)}`,
    text: '',
    confidence: 0.9,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    useCount: 0,
    status: 'active',
  };
  try {
    process.env.AI_PERSONAL_MEMORY_PROMPT_MAX_CHARS = '1000';
    const prompt = formatPersonalMemoryForPrompt([item]);
    assert.match(prompt, /<memory id="memory_multiline" scope="global" type="workflow">/);
    assert.match(prompt, /第一行\n第二行/);
    assert.match(prompt, /stored memory remains complete/);
    assert.match(prompt, /<\/memory>/);
    assert.ok(prompt.length <= 1000);
    assert.equal(normalizePersonalMemoryValue(item.value), item.value);
  } finally {
    if (previousLimit === undefined) delete process.env.AI_PERSONAL_MEMORY_PROMPT_MAX_CHARS;
    else process.env.AI_PERSONAL_MEMORY_PROMPT_MAX_CHARS = previousLimit;
  }
});

test('rejects one-off page references even when the extractor labels them as confident memory', () => {
  const candidates = [{
    scope: 'domain',
    domain: 'ng.ant.design',
    type: 'domain_fact',
    key: '带icon的滑块的含义',
    aliases: ['带icon的滑块'],
    value: '指页面第二个示例。',
    confidence: 0.95,
    evidence: ['打开带 icon 的滑块'],
    durability: 'explicit_alias',
  }];
  const analysis = analyzeDurablePersonalMemoryDrafts(candidates, ['打开带 icon 的滑块']);

  assert.deepEqual(analysis.items, []);
  assert.equal(analysis.rejected.length, 1);
  assert.equal(analysis.rejected[0]?.reason, 'missing_explicit_durability_cue');
});

test('keeps an explicitly durable user preference with exact user evidence', () => {
  const draft = {
    scope: 'global',
    type: 'preference',
    key: '获取页面信息方式',
    aliases: ['不要截屏'],
    value: '默认通过 DOM 获取页面信息。',
    confidence: 0.9,
    evidence: ['以后不要截图，默认用 DOM'],
    durability: 'explicit_preference',
  };
  const items = filterDurablePersonalMemoryDrafts([draft], ['以后不要截图，默认用 DOM']);

  assert.deepEqual(items, [draft]);
});

test('keeps a user habit only when two different user messages provide exact evidence', () => {
  const draft = {
    scope: 'global',
    type: 'workflow',
    key: '页面信息读取方式',
    aliases: ['先看 DOM'],
    value: '操作网页时先读取 DOM，再决定是否截图。',
    confidence: 0.82,
    evidence: ['先读取 DOM 看一下', '这次也先看 DOM'],
    durability: 'repeated_user_behavior',
  };

  assert.deepEqual(filterDurablePersonalMemoryDrafts(
    [draft],
    ['先读取 DOM 看一下，再操作页面', '这次也先看 DOM，找不到再截图'],
  ), [draft]);
  assert.deepEqual(filterDurablePersonalMemoryDrafts(
    [draft],
    ['先读取 DOM 看一下，这次也先看 DOM'],
  ), []);
});

test('returns multiple independent durable memories from one extraction result', () => {
  const preferences = [{
    scope: 'global',
    type: 'preference',
    key: '页面语言',
    value: '默认使用中文页面。',
    evidence: ['以后页面默认用中文'],
    durability: 'explicit_preference',
  }, {
    scope: 'global',
    type: 'workflow',
    key: '提交表单前确认',
    value: '提交表单前先进行确认。',
    evidence: ['每次提交表单前都要先问我'],
    durability: 'explicit_workflow',
  }];

  assert.deepEqual(filterDurablePersonalMemoryDrafts(preferences, [
    '以后页面默认用中文',
    '每次提交表单前都要先问我',
  ]), preferences);
});
