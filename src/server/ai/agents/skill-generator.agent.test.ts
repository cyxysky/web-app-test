import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGeneratedSkillOutput } from './skill-generator.agent';

test('validates the structured Skill output', () => {
  const generated = parseGeneratedSkillOutput({
    title: '创建产品需求',
    description: '在产品管理页面创建并验证产品需求。',
    triggerPhrases: ['创建产品需求', '新增产品需求'],
    content: { details: '## 操作步骤\n\n1. 打开产品管理页面。\n2. 填写必填字段并提交。' },
  });

  assert.equal(generated.title, '创建产品需求');
  assert.equal(generated.triggerPhrases.length, 2);
});

test('rejects an object that does not match the Skill schema', () => {
  assert.throws(() => parseGeneratedSkillOutput({ title: 'x' }), /Skill model response is invalid/);
});
