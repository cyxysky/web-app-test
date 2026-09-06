import assert from 'node:assert/strict';
import test from 'node:test';
import { fuzzyRetrievalScore } from './fuzzy-retrieval';

const bilingualCases = [
  ['download the report', '导出报表'],
  ['find a customer', '查询客户'],
  ['create project', '新建项目'],
  ['update delivery date', '修改交付日期'],
  ['remove this ticket', '删除工单'],
  ['submit contract', '提交合同'],
  ['upload attachment', '上传附件'],
  ['sign in', '登录系统'],
  ['browser tab group', '浏览器标签组'],
  ['search memory', '检索记忆'],
  ['choose a skill', '选择技能'],
  ['filter order list', '筛选订单列表'],
  ['open issue details', '打开问题详情'],
  ['refresh dashboard', '刷新看板'],
  ['verify status', '验证状态'],
  ['input employee', '填写员工'],
  ['copy document', '复制文档'],
  ['spreadsheet file', '表格文件'],
  ['presentation slides', '演示文稿'],
  ['error log', '错误日志'],
] as const;

test('bilingual fuzzy retrieval reaches at least 95 percent on the regression corpus', () => {
  const matched = bilingualCases.filter(([query, candidate]) => fuzzyRetrievalScore(query, [candidate]) >= 0.38);
  assert.ok(matched.length / bilingualCases.length >= 0.95, `${matched.length}/${bilingualCases.length} matched`);
});

test('fuzzy retrieval tolerates punctuation, spacing, and minor wording differences', () => {
  assert.ok(fuzzyRetrievalScore('project-status!', ['Project status workflow']) >= 0.8);
  assert.ok(fuzzyRetrievalScore('交 付 日 期', ['修改交付日期']) >= 0.8);
});

test('a shared generic action does not match unrelated business entities', () => {
  assert.ok(fuzzyRetrievalScore('open financial report', ['open music player']) < 0.38);
  assert.ok(fuzzyRetrievalScore('open financial report', ['open']) < 0.38);
  assert.ok(fuzzyRetrievalScore('修改客户地址', ['修改音乐播放列表']) < 0.38);
  assert.ok(fuzzyRetrievalScore('download financial report', ['导出财务报表']) >= 0.38);
});
