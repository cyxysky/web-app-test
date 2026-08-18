import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSkillContent, type SkillRecord } from '@/server/ai/schemas/runtime.schema';
import { formatLoadedSkillsForPrompt, formatSkillReferencesForUser, formatSkillSummariesForPrompt, runtimeSkillsForUrl, skillMatchesUrl } from './skill-context';

const skill: SkillRecord = {
  id: 'skill-search-room',
  userId: '0',
  shared: false,
  title: '进入指定直播间',
  description: '通过主播名进入指定直播间。',
  triggerPhrases: ['打开指定主播直播间'],
  content: {
    details: [
      '1. 打开直播平台并定位主播搜索入口。',
      '2. 输入主播名并选择匹配结果；搜索建议未出现时改用房间号。',
      '3. 确认地址和页面标题均对应目标主播。',
    ].join('\n'),
  },
  status: 'ready',
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

test('compact user Skill references contain only the id mapping and title', () => {
  const reference = formatSkillReferencesForUser([skill]);
  assert.match(reference, /<skills id="1">/);
  assert.match(reference, /Title: 进入指定直播间/);
  assert.doesNotMatch(reference, /通过主播名/);
  assert.doesNotMatch(reference, /打开指定主播直播间|Workflow/);
});

test('Skill prompt exposes tagged summaries without injecting full content', () => {
  const prompt = formatSkillSummariesForPrompt([skill]);
  assert.match(prompt, /<skill id="skill-search-room" version="1" index="1">/);
  assert.equal((prompt.match(/通过主播名进入指定直播间/g) || []).length, 1);
  assert.match(prompt, /Triggers: 打开指定主播直播间/);
  assert.match(prompt, /call skill with action="read"/);
  assert.doesNotMatch(prompt, /打开直播平台并定位主播搜索入口/);
  assert.doesNotMatch(prompt, /搜索建议未出现时改用房间号/);
  assert.doesNotMatch(prompt, /地址和页面标题均对应目标主播/);
  assert.match(prompt, /<\/skill>/);
});

test('Skill content keeps the detailed Markdown block intact', () => {
  const content = parseSkillContent({
    details: '## 操作\n\n1. 执行操作\n2. 页面显示成功状态',
  });
  assert.deepEqual(content, {
    details: '## 操作\n\n1. 执行操作\n2. 页面显示成功状态',
  });
});

test('domain-scoped skills only match their configured host', () => {
  const domainSkill = { ...skill, id: 'domain-skill', domains: ['10.10.0.90'] };
  assert.equal(skillMatchesUrl(domainSkill, 'https://10.10.0.90/ipd'), true);
  assert.equal(skillMatchesUrl(domainSkill, 'https://example.com'), false);
});

test('runtime skills drop explicit domain Skills after leaving their domain and keep global matches', () => {
  const explicit = { ...skill, id: 'explicit', domains: ['other.example'] };
  const global = { ...skill, id: 'global', domains: [] };
  const matching = { ...skill, id: 'matching', domains: ['*.example.com'] };
  const unrelated = { ...skill, id: 'unrelated', domains: ['unrelated.example'] };
  assert.deepEqual(
    runtimeSkillsForUrl([global, matching, unrelated], [explicit], 'https://app.example.com/path').map((item) => item.id),
    ['global', 'matching'],
  );
});

test('shared global Skills remain valid candidates without domain matching', () => {
  const sharedGlobal = { ...skill, id: 'shared-global', shared: true, domains: [] };
  assert.deepEqual(
    runtimeSkillsForUrl(
      [sharedGlobal],
      [],
      'https://wiki.example.com/path',
      new Set(),
      '请打开指定主播直播间',
    ).map((item) => item.id),
    ['shared-global'],
  );
  assert.match(formatLoadedSkillsForPrompt([sharedGlobal]), /Content:/);
});

test('runtime Skill summaries exclude Skills already read in the current user turn', () => {
  const matching = { ...skill, id: 'matching', domains: ['example.com'] };
  assert.deepEqual(
    runtimeSkillsForUrl([matching], [], 'https://example.com/path', new Set(['matching'])),
    [],
  );
});

test('runtime Skill summaries use the current conversation to filter global Skills', () => {
  const relevant = { ...skill, id: 'relevant', domains: [] };
  const unrelated = {
    ...skill,
    id: 'unrelated',
    title: '导出财务报表',
    description: '导出财务数据。',
    triggerPhrases: ['导出报表'],
    domains: [],
  };
  assert.deepEqual(
    runtimeSkillsForUrl(
      [unrelated, relevant],
      [],
      'https://example.com/path',
      new Set(),
      '请帮我打开指定主播直播间',
    ).map((item) => item.id),
    ['relevant'],
  );
});
