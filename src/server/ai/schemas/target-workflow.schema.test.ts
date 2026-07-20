import assert from 'node:assert/strict';
import test from 'node:test';
import { repairNullableTargetPlanText, targetWorkflowRunSchema, validateTargetPlanStructure } from './target-workflow.schema';

test('repairs an empty top-level plan id from structured model output', () => {
  const repaired = repairNullableTargetPlanText(JSON.stringify({ id: '', optional: null }));
  assert.deepEqual(JSON.parse(repaired || '{}'), { id: 'plan_repaired' });
});

test('accepts persisted Axure research evidence and criterion source citations', () => {
  const parsed = targetWorkflowRunSchema.parse({
    id: 'run_1',
    status: 'synthesizing_requirements',
    research: {
      version: 1,
      status: 'complete',
      summary: '已读取 Axure 页面树、交互说明和原型图片。',
      sources: [{
        id: 'source_axure',
        kind: 'axure',
        title: '订单审批原型',
        url: 'https://example.axshare.com/#id=page_1',
        status: 'inspected',
        summary: '审批页包含通过和驳回两个入口。',
        evidence: ['step:1'],
      }],
      facts: [{
        id: 'fact_1',
        statement: '审批人可以通过或驳回订单。',
        sourceIds: ['source_axure'],
        confidence: 0.95,
      }],
      unresolved: [],
      stepIndexes: [1],
      updatedAt: '2026-07-20T00:00:00.000Z',
    },
    plan: {
      id: 'plan_1',
      version: 1,
      locale: 'zh',
      title: '订单审批测试',
      requirementSummary: '验证审批人可以通过或驳回订单。',
      actors: [],
      requirements: [],
      rootNodeId: 'target_1',
      nodes: [{
        id: 'target_1',
        type: 'target',
        title: '验证审批操作',
        objective: '检查通过和驳回操作。',
        preconditions: [],
        successCriteria: [{
          id: 'criterion_1',
          description: '通过和驳回入口均可用。',
          evidenceRequirement: '保存操作前后的页面证据。',
          sourceIds: ['source_axure'],
        }],
        inputs: [],
        outputs: [],
        resources: [],
      }],
      assumptions: [],
      risks: [],
      analysisComplete: true,
    },
    results: {},
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
  });

  assert.equal(parsed.research?.sources[0]?.kind, 'axure');
  assert.deepEqual(parsed.plan?.nodes[0]?.type === 'target'
    ? parsed.plan.nodes[0].successCriteria[0]?.sourceIds
    : [], ['source_axure']);
  assert.deepEqual(parsed.plan ? validateTargetPlanStructure(parsed.plan) : ['missing plan'], []);
});
