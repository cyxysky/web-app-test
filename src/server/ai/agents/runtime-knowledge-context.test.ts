import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeKnowledgeResolver, knowledgeDigest, runtimeKnowledgeMessage, type RuntimeKnowledgeState } from './runtime-knowledge-context';
import { assembleRuntimeContext, readRuntimeContextMaterial, runtimeContextMessageRef, RuntimeContextBudgetError } from './runtime-context-assembler';
import { normalizeBrowserChatModelContext } from './browser-chat-model-context';
import type { SkillRecord } from '@/server/ai/schemas/runtime.schema';

test('Skill lifecycle preserves nine explicit rules, idempotent reads, version updates, revocation and branch-scoped recovery', async () => {
  let stored: RuntimeKnowledgeState | undefined;
  let revision = 1;
  let catalogReads = 0;
  let bodyReads = 0;
  let memoryReads = 0;
  const skills: SkillRecord[] = Array.from({ length: 9 }, (_, i) => ({
    id: `skill-${i}`, userId: 'user-a', shared: false, title: `Skill ${i}`, description: 'Invoice approval',
    triggerPhrases: ['approve invoice'], status: 'ready', version: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01',
    content: { details: `Rule ${i}: verify invoice identity before approving.`, resources: [{ name: 'Reference', content: 'reference only '.repeat(3000) }] },
  }));
  const options = {
    scopeId: 'session-a:main', query: 'approve invoice', selectedSkillIds: skills.map((skill) => skill.id),
    getState: () => stored, saveState: async (value: RuntimeKnowledgeState) => { stored = JSON.parse(JSON.stringify(value)); },
    revisions: async () => ({ skills: String(revision), memories: '1' }),
    listSkills: async () => { catalogReads++; return skills.filter((skill) => skill.status === 'ready').map((skill) => ({ ...skill, content: { details: '' } })); },
    getSkill: async (id: string) => { bodyReads++; return skills.find((skill) => skill.id === id); },
    searchMemory: async () => { memoryReads++; return []; }, formatMemory: () => '',
  };
  let resolver = createRuntimeKnowledgeResolver(options);
  assert.equal((await resolver.refresh('example.com')).filter((block) => block.kind === 'skill-summary').length, 9);
  for (const skill of skills) assert.equal((await resolver.readSkill(skill.id)).ok, true);
  let blocks = await resolver.refresh('example.com');
  assert.equal(blocks.filter((block) => block.kind === 'skill').length, 9);
  const reads = bodyReads;
  await resolver.refresh('example.com');
  assert.equal(bodyReads, reads);
  assert.equal(catalogReads, 1);
  assert.equal(memoryReads, 1);
  assert.equal(JSON.parse((await resolver.readSkill('skill-8')).actual).alreadyLoaded, true);
  stored = normalizeBrowserChatModelContext({ version: 2, records: {}, history: [], active: [], knowledge: stored }).knowledge;
  resolver = createRuntimeKnowledgeResolver(options);
  blocks = await resolver.refresh('example.com');
  assert.equal(blocks.filter((block) => block.kind === 'skill').length, 9);
  skills[8] = { ...skills[8], version: 2, updatedAt: '2026-02-01', content: { details: 'New approval rule' } };
  revision++;
  blocks = await resolver.refresh('example.com');
  assert.ok(blocks.find((block) => block.id === 'skill-8')?.text.includes('New approval rule'));
  skills[8] = { ...skills[8], status: 'disabled' };
  revision++;
  blocks = await resolver.refresh('example.com');
  assert.ok(blocks.find((block) => block.id === 'skill-8')?.reason.includes('disabled'));
  assert.equal(stored?.skills.length, 8);
  assert.equal((await resolver.readSkill('skill-8')).ok, false);
  const branch = createRuntimeKnowledgeResolver({ ...options, scopeId: 'session-a:child', selectedSkillIds: [] });
  assert.equal((await branch.refresh('example.com')).filter((block) => block.kind === 'skill').length, 0);
});

test('knowledge budget retains complete rules, archives reference bodies, and reports actual selection with exact readback', () => {
  const blocks = [
    { kind: 'skill' as const, id: 'invoice', title: 'Invoice', version: 3, digest: 'd', text: 'Always verify the recipient.', required: true, priority: 100, reason: 'explicit', cacheHit: true },
    { kind: 'memory' as const, id: 'm1', title: 'Long preference', version: 'date', digest: 'm', text: 'x'.repeat(20000), required: false, priority: 50, reason: 'related', cacheHit: true },
    { kind: 'skill-resource' as const, id: 'ref', title: 'Examples', version: 3, digest: 'r', text: 'original\n'.repeat(10000), required: false, priority: 0, reason: 'reference', cacheHit: true, resourceOnly: true },
  ];
  const records = Object.fromEntries(blocks.map((block) => { const message = runtimeKnowledgeMessage(block); return [runtimeContextMessageRef(message), message]; }));
  const input = { records, messages: [{ role: 'user' as const, content: 'Prepare an invoice' }], inputBudgetTokens: 3000, baseTokens: 50, knowledge: blocks };
  const result = assembleRuntimeContext(input);
  assert.ok(JSON.stringify(result.messages).includes('Always verify the recipient.'));
  assert.deepEqual(result.manifest.knowledge?.map((entry) => [entry.id, entry.selected]), [['invoice', true], ['m1', false], ['ref', false]]);
  const ref = result.manifest.knowledge!.find((entry) => entry.id === 'ref')!.ref;
  const first = readRuntimeContextMaterial(records, { ref, pointer: '/content/1/text', offset: 0, limit: 300 });
  assert.equal(first.ok, true);
  assert.equal(first.complete, false);
  assert.equal(first.content, blocks[2].text.slice(0, 300));
  assert.equal(first.digest, knowledgeDigest(blocks[2].text));
  const resumed = assembleRuntimeContext({ ...input, messages: result.messages });
  assert.equal(JSON.stringify(resumed.messages).split('Always verify the recipient.').length - 1, 1);
  assert.throws(() => assembleRuntimeContext({ ...input, inputBudgetTokens: 10 }), RuntimeContextBudgetError);
});

test('a compacted user Skill stays cold across refresh and branch restore until explicitly reread', async () => {
  let saved: RuntimeKnowledgeState | undefined;
  const skill = { id: 'large', userId: 'u', shared: false, title: 'Large workflow', description: 'Prepare reports', triggerPhrases: ['report'], status: 'ready', version: 1,
    createdAt: '2026-01-01', updatedAt: '2026-01-01', content: { details: 'KEEP_FULL_RULES '.repeat(2500) } } as SkillRecord;
  const options = { scopeId: 's', query: 'report', selectedSkillIds: ['large'], getState: () => saved,
    saveState: async (value: RuntimeKnowledgeState) => { saved = structuredClone(value); }, revisions: async () => ({ skills: '1', memories: '1' }),
    listSkills: async () => [skill], getSkill: async () => skill, searchMemory: async () => [], formatMemory: () => '' };
  let resolver = createRuntimeKnowledgeResolver(options);
  await resolver.refresh(''); await resolver.readSkill('large');
  const blocks = await resolver.refresh('');
  const result = assembleRuntimeContext({ messages: [{ role: 'user', content: 'Prepare report' }], records: {}, baseTokens: 1000, inputBudgetTokens: 100000, knowledge: blocks, forceCompaction: true });
  assert.doesNotMatch(JSON.stringify(result.messages), /KEEP_FULL_RULES/);
  await resolver.markSelected(result.manifest.knowledge!);
  assert.equal(saved!.skills[0].bodyAvailable, false);
  resolver = createRuntimeKnowledgeResolver(options);
  assert.equal((await resolver.refresh('')).find((block) => block.kind === 'skill')!.bodyAvailable, false);
  assert.equal(JSON.parse((await resolver.readSkill('large')).actual).alreadyLoaded, false);
  const loaded = await resolver.refresh('');
  const next = assembleRuntimeContext({ messages: [], records: {}, baseTokens: 1000, inputBudgetTokens: 100000, knowledge: loaded });
  assert.match(JSON.stringify(next.messages), /KEEP_FULL_RULES/);
});
