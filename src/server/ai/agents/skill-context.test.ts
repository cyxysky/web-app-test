import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSkillContent, type SkillRecord } from '@/server/ai/schemas/test-case.schema';
import { formatSkillReferencesForUser, formatSkillsForPrompt } from './skill-context';

const skill: SkillRecord = {
  id: 'skill-search-room',
  title: '进入指定直播间',
  description: '通过主播名进入指定直播间。',
  tags: ['内部管理标签'],
  triggerPhrases: ['打开指定主播直播间'],
  content: {
    workflow: ['打开直播平台并定位主播搜索入口', '输入主播名并选择匹配结果'],
    recovery: ['搜索建议未出现时改用房间号'],
    verification: ['地址和页面标题均对应目标主播'],
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
  assert.doesNotMatch(reference, /内部管理标签|打开指定主播直播间|Workflow/);
});

test('detailed Skill prompt injects operating content once and omits matching metadata', () => {
  const prompt = formatSkillsForPrompt([skill]);
  assert.equal((prompt.match(/通过主播名进入指定直播间/g) || []).length, 1);
  assert.equal((prompt.match(/打开直播平台并定位主播搜索入口/g) || []).length, 1);
  assert.equal((prompt.match(/搜索建议未出现时改用房间号/g) || []).length, 1);
  assert.equal((prompt.match(/地址和页面标题均对应目标主播/g) || []).length, 1);
  assert.doesNotMatch(prompt, /内部管理标签|打开指定主播直播间|Trigger phrases|Tags:/);
});

test('legacy cautions migrate into the compact recovery section', () => {
  const content = parseSkillContent({
    workflow: ['执行操作'],
    cautions: ['失败时使用备用入口'],
    verification: ['页面显示成功状态'],
  });
  assert.deepEqual(content, {
    workflow: ['执行操作'],
    recovery: ['失败时使用备用入口'],
    verification: ['页面显示成功状态'],
  });
});
