import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeDiscoveredResearchLinks, mergeTargetResearchBundles, targetResearchDelegationSeeds } from './target-requirement-researcher.agent';
import type { TargetResearchBundle } from '@/server/ai/schemas/target-workflow.schema';

function bundle(overrides: Partial<TargetResearchBundle> = {}): TargetResearchBundle {
  return {
    version: 1,
    status: 'partial',
    summary: 'primary',
    sources: [],
    facts: [],
    unresolved: [],
    stepIndexes: [],
    updatedAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

test('delegates independent discovered links up to the concurrency limit', () => {
  const seeds = targetResearchDelegationSeeds(bundle({
    sources: [
      { id: 'root', kind: 'url', title: 'root', url: 'https://example.com/root', status: 'inspected', evidence: [] },
      { id: 'a', kind: 'axure', title: 'A', url: 'http://10.66.24.125/a', status: 'discovered', evidence: [] },
      { id: 'b', kind: 'url', title: 'B', url: 'https://example.com/b', status: 'discovered', evidence: [] },
      { id: 'c', kind: 'url', title: 'C', url: 'https://example.com/c', status: 'discovered', evidence: [] },
    ],
  }), 2);
  assert.deepEqual(seeds.map((seed) => seed.title), ['A', 'B']);
});

test('groups Axure page links by project and skips a project already inspected', () => {
  const seeds = targetResearchDelegationSeeds(bundle({
    sources: [
      { id: 'a1', kind: 'axure', title: 'A1', url: 'http://10.66.24.125/PROJECT?id=one', status: 'inspected', evidence: [] },
      { id: 'a2', kind: 'axure', title: 'A2', url: 'http://10.66.24.125/PROJECT?id=two', status: 'discovered', evidence: [] },
      { id: 'b1', kind: 'axure', title: 'B1', url: 'http://10.66.24.125/OTHER?id=one', status: 'discovered', evidence: [] },
      { id: 'b2', kind: 'axure', title: 'B2', url: 'http://10.66.24.125/OTHER?id=two', status: 'discovered', evidence: [] },
    ],
  }), 3);
  assert.deepEqual(seeds.map((seed) => seed.title), ['B1']);
});

test('adds external PRD links discovered from the live DOM for child-agent delegation', () => {
  const result = mergeDiscoveredResearchLinks(bundle({
    sources: [{ id: 'root', kind: 'url', title: 'Requirement', url: 'https://domp.example/#/issue/1', status: 'inspected', evidence: [] }],
  }), [
    { title: '考勤原型', url: 'http://10.66.24.125/2LG4RI/index.html?id=abc' },
    { title: '普通站内导航', url: 'https://domp.example/#/home' },
  ], 'https://domp.example/#/issue/1');

  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[1].kind, 'axure');
  assert.equal(result.sources[1].status, 'discovered');
  assert.deepEqual(targetResearchDelegationSeeds(result), [{
    kind: 'axure',
    title: '考勤原型',
    url: 'http://10.66.24.125/2LG4RI/index.html?id=abc',
  }]);
});

test('one child failure does not discard successful sibling research', () => {
  const merged = mergeTargetResearchBundles(bundle({
    sources: [{ id: 'root', kind: 'url', title: 'root', url: 'https://example.com/root', status: 'inspected', evidence: [] }],
  }), [
    { error: 'page unavailable' },
    { bundle: bundle({
      summary: 'child success',
      status: 'complete',
      sources: [{ id: 'prd', kind: 'axure', title: 'PRD', url: 'http://10.66.24.125/prd', status: 'inspected', evidence: ['page tree'] }],
      facts: [{ id: 'fact', statement: 'The PRD contains attendance rules.', sourceIds: ['prd'], confidence: 0.9 }],
      stepIndexes: [2_040_001],
    }) },
  ]);
  assert.equal(merged.sources.some((source) => source.url === 'http://10.66.24.125/prd' && source.status === 'inspected'), true);
  assert.equal(merged.facts.some((fact) => fact.statement.includes('attendance rules')), true);
  assert.equal(merged.unresolved.some((item) => item.includes('page unavailable')), true);
});
