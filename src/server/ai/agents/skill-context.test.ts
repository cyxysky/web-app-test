import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSkillContent, type SkillRecord } from '@/server/ai/schemas/runtime.schema';
import { formatLoadedSkillsForPrompt, formatSkillReferencesForUser, formatSkillSummariesForPrompt, runtimeSkills } from './skill-context';

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

test('explicitly selected Skills stay available across page changes', () => {
  const explicit = { ...skill, id: 'explicit' };
  const automatic = { ...skill, id: 'automatic' };
  assert.deepEqual(
    runtimeSkills([automatic], [explicit]).map((item) => item.id),
    ['explicit', 'automatic'],
  );
});

test('shared Skills remain valid candidates', () => {
  const sharedSkill = { ...skill, id: 'shared-skill', shared: true };
  assert.deepEqual(
    runtimeSkills(
      [sharedSkill],
      [],
      new Set(),
      '请打开指定主播直播间',
    ).map((item) => item.id),
    ['shared-skill'],
  );
  assert.match(formatLoadedSkillsForPrompt([sharedSkill]), /Content:/);
});

test('runtime Skill summaries exclude Skills already read in the current user turn', () => {
  const matching = { ...skill, id: 'matching' };
  assert.deepEqual(
    runtimeSkills([matching], [], new Set(['matching'])),
    [],
  );
});

test('runtime Skill summaries use the current conversation to filter Skills', () => {
  const relevant = { ...skill, id: 'relevant' };
  const unrelated = {
    ...skill,
    id: 'unrelated',
    title: '导出财务报表',
    description: '导出财务数据。',
    triggerPhrases: ['导出报表'],
  };
  assert.deepEqual(
    runtimeSkills(
      [unrelated, relevant],
      [],
      new Set(),
      '请帮我打开指定主播直播间',
    ).map((item) => item.id),
    ['relevant'],
  );
});
