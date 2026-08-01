import assert from 'node:assert/strict';
import test from 'node:test';
import { filterDurablePersonalMemoryDrafts } from './personal-memory';

test('rejects one-off page references even when the extractor labels them as confident memory', () => {
  const items = filterDurablePersonalMemoryDrafts([{
    scope: 'domain',
    domain: 'ng.ant.design',
    type: 'domain_fact',
    key: '带icon的滑块的含义',
    aliases: ['带icon的滑块'],
    value: '指页面第二个示例。',
    confidence: 0.95,
    evidence: ['打开带 icon 的滑块'],
    durability: 'explicit_alias',
  }], ['打开带 icon 的滑块']);

  assert.deepEqual(items, []);
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
