import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGeneratedSkillText } from './skill-generator.agent';

test('parses plain JSON text without requiring model response_format support', () => {
  const generated = parseGeneratedSkillText(JSON.stringify({
    title: '创建产品需求',
    description: '在产品管理页面创建并验证产品需求。',
    triggerPhrases: ['创建产品需求', '新增产品需求'],
    content: { details: '## 操作步骤\n\n1. 打开产品管理页面。\n2. 填写必填字段并提交。' },
  }));

  assert.equal(generated.title, '创建产品需求');
  assert.equal(generated.triggerPhrases.length, 2);
});

test('accepts JSON inside a markdown fence and validates the Skill shape', () => {
  const generated = parseGeneratedSkillText(`\`\`\`json
{"title":"查询版本信息","description":"查询指定产品的可用版本并确认结果。","triggerPhrases":["查询产品版本","查看可用版本"],"content":{"details":"## 操作步骤\\n\\n打开产品详情，并检查版本列表中的目标版本。"}}
\`\`\``);

  assert.equal(generated.content.details.includes('版本列表'), true);
  assert.throws(() => parseGeneratedSkillText('{"title":"x"}'), /Skill model response is invalid/);
});
