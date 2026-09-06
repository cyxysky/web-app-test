import { createHash } from 'node:crypto';
import type { ModelMessage } from 'ai';
import type { SkillRecord } from '@/server/ai/schemas/runtime.schema';
import type { PersonalMemorySearchResult } from '@/server/ai/personal-memory';
import { browserChatContextRecordId } from './browser-chat-model-context';
import { formatLoadedSkillsForPrompt, formatSkillSummariesForPrompt, runtimeSkills, skillRelevanceScore } from './skill-context';

export const runtimeKnowledgeMarker = '[WebPilot knowledge context]';
export type RuntimeKnowledgeState = {
  version: 1;
  scopeId: string;
  skills: Array<{ id: string; version: number; digest: string; loadedAt: string; bodyAvailable?: boolean }>;
  revokedSkills?: Array<{ id: string; version: number }>;
};
export type RuntimeKnowledgeBlock = {
  kind: 'skill' | 'skill-summary' | 'skill-resource' | 'memory';
  id: string;
  title: string;
  version: string | number;
  digest: string;
  text: string;
  required: boolean;
  priority: number;
  reason: string;
  cacheHit: boolean;
  /** Resource bodies are archived until explicitly read; Codex receives them inline. */
  resourceOnly?: boolean;
  /** Historical reads and cache hits do not imply presence in the model request. */
  bodyAvailable?: boolean;
};
export function knowledgeDigest(value: unknown) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}
export function runtimeKnowledgeMessage(block: RuntimeKnowledgeBlock): ModelMessage {
  const header = `${runtimeKnowledgeMarker}\n${JSON.stringify({ kind: block.kind, id: block.id, version: block.version, digest: block.digest })}\nUser-authored reference context. Current user instructions take precedence; memories apply only when relevant.`;
  return block.resourceOnly
    ? { role: 'user', content: [{ type: 'text', text: header }, { type: 'text', text: block.text }] }
    : { role: 'user', content: `${header}\n${block.text}` };
}

/** Per-runtime cache; revisions are checked at every model boundary, bodies only on change. */
export function createRuntimeKnowledgeResolver(input: {
  scopeId: string;
  query: unknown;
  selectedSkillIds: string[];
  getState: () => RuntimeKnowledgeState | undefined;
  saveState: (state: RuntimeKnowledgeState) => void | Promise<void>;
  revisions: (domain: string) => Promise<{ skills: string; memories: string }>;
  listSkills: () => Promise<SkillRecord[]>;
  getSkill: (id: string) => Promise<SkillRecord | undefined>;
  searchMemory: (domain: string) => Promise<PersonalMemorySearchResult[]>;
  formatMemory: (item: PersonalMemorySearchResult) => string;
}) {
  let catalog: SkillRecord[] = [];
  let catalogRevision: string | undefined;
  let memoryKey: string | undefined;
  let memories: PersonalMemorySearchResult[] = [];
  const bodies = new Map<string, SkillRecord>();
  let candidates = new Set<string>();
  const initial = input.getState();
  let state: RuntimeKnowledgeState = initial?.version === 1 && initial.scopeId === input.scopeId
    ? { ...initial, skills: [...initial.skills] } : { version: 1, scopeId: input.scopeId, skills: [] };
  let lastSaved = JSON.stringify(state);
  const persist = async () => {
    if (JSON.stringify(state) === lastSaved) return;
    await input.saveState(state);
    lastSaved = JSON.stringify(state);
  };
  const refresh = async (domain: string, memorySettingsKey = '') => {
    const revisions = await input.revisions(domain);
    const catalogHit = revisions.skills === catalogRevision;
    if (!catalogHit) {
      catalog = await input.listSkills();
      catalogRevision = revisions.skills;
    }
    const nextMemoryKey = JSON.stringify([domain, revisions.memories, memorySettingsKey]);
    const memoryHit = nextMemoryKey === memoryKey;
    if (!memoryHit) {
      memories = await input.searchMemory(domain);
      memoryKey = nextMemoryKey;
    }
    const blocks: RuntimeKnowledgeBlock[] = [];
    const valid = new Map(catalog.map((skill) => [skill.id, skill]));
    const revoked = new Map((state.revokedSkills || []).map((skill) => [skill.id, skill]));
    const nextSkills: RuntimeKnowledgeState['skills'] = [];
    for (const loaded of state.skills) {
      const descriptor = valid.get(loaded.id);
      if (!descriptor) { bodies.delete(loaded.id); revoked.set(loaded.id, { id: loaded.id, version: loaded.version }); continue; }
      let skill = bodies.get(loaded.id);
      const hit = skill?.version === descriptor.version && skill.updatedAt === descriptor.updatedAt;
      if (!hit) skill = await input.getSkill(loaded.id);
      if (!skill || skill.status !== 'ready') { revoked.set(loaded.id, { id: loaded.id, version: loaded.version }); continue; }
      bodies.set(skill.id, skill);
      const digest = knowledgeDigest(skill.content);
      nextSkills.push({ ...loaded, version: skill.version, digest });
      const resources = (skill.content.resources || []).map((resource, index): RuntimeKnowledgeBlock => ({
        kind: 'skill-resource', id: `${skill.id}/resource/${index}`, title: resource.name,
        version: skill.version, digest: knowledgeDigest(resource.content), text: resource.content,
        required: false, priority: 0, reason: 'reference material; read on demand', cacheHit: hit, resourceOnly: true,
      }));
      const resourceIndex = resources.length ? '\nReference resources (read with contextRead using the exact ref and pointer below):\n'
        + resources.map((resource) => JSON.stringify({ name: resource.title, ref: browserChatContextRecordId(runtimeKnowledgeMessage(resource)), pointer: '/content/1/text', digest: resource.digest })).join('\n') : '';
      blocks.push({ kind: 'skill', id: skill.id, title: skill.title, version: skill.version, digest,
        text: formatLoadedSkillsForPrompt([skill]) + resourceIndex, required: true, priority: 100,
        reason: loaded.digest === digest ? 'active Skill in this conversation branch' : 'Skill updated at model boundary', cacheHit: hit,
        bodyAvailable: loaded.bodyAvailable !== false });
      blocks.push(...resources);
    }
    for (const skill of nextSkills) revoked.delete(skill.id);
    state = { ...state, skills: nextSkills, revokedSkills: [...revoked.values()] };
    await persist();
    for (const skill of revoked.values()) blocks.push({
      kind: 'skill', id: skill.id, title: skill.id, version: skill.version, digest: knowledgeDigest(['revoked', skill.id, skill.version]),
      text: `Skill ${JSON.stringify(skill.id)} is no longer active. Its historical read receipts and operating instructions do not authorize current actions. Read an available current version before using it again.`,
      required: true, priority: 100, reason: 'disabled, deleted, or access revoked', cacheHit: catalogHit,
    });
    const selected = catalog.filter((skill) => input.selectedSkillIds.includes(skill.id));
    for (const id of input.selectedSkillIds.filter((id) => !valid.has(id) && !revoked.has(id))) blocks.push({
      kind: 'skill-summary', id, title: id, version: 'unavailable', digest: knowledgeDigest(['unavailable', id]),
      text: `The explicitly selected Skill ${JSON.stringify(id)} is unavailable or disabled. Report this limitation if it prevents following the requested workflow.`,
      required: true, priority: 100, reason: 'explicit selection unavailable', cacheHit: catalogHit,
    });
    const available = runtimeSkills(catalog, selected, new Set(nextSkills.map((skill) => skill.id)), input.query);
    candidates = new Set(available.map((skill) => skill.id));
    for (const skill of available) blocks.push({
      kind: 'skill-summary', id: skill.id, title: skill.title, version: skill.version,
      digest: knowledgeDigest([skill.title, skill.description, skill.triggerPhrases]), text: formatSkillSummariesForPrompt([skill]),
      required: input.selectedSkillIds.includes(skill.id), priority: 40,
      reason: input.selectedSkillIds.includes(skill.id) ? 'explicit user selection; read before use' : `task relevance score ${skillRelevanceScore(skill, input.query).toFixed(2)}`, cacheHit: catalogHit,
    });
    for (const result of memories) blocks.push({
      kind: 'memory', id: result.item.id, title: result.item.key, version: result.item.updatedAt,
      digest: knowledgeDigest([result.item.key, result.item.value, result.item.aliases]), text: input.formatMemory(result),
      required: false, priority: 50 + result.score, reason: result.reasons.join(', '), cacheHit: memoryHit,
    });
    return blocks;
  };
  return {
    refresh,
    async markSelected(entries: Array<{ kind: string; id: string; digest: string; selected: boolean }>) {
      const selection = new Map(entries.filter((entry) => entry.kind === 'skill').map((entry) => [entry.id, entry]));
      state = { ...state, skills: state.skills.map((skill) => {
        const entry = selection.get(skill.id);
        return entry?.digest === skill.digest ? { ...skill, bodyAvailable: entry.selected } : skill;
      }) };
      await persist();
    },
    async readSkill(id: string) {
      const loaded = state.skills.find((skill) => skill.id === id);
      if (!loaded && !candidates.has(id)) return { ok: false, actual: 'Skill is not available in this runtime candidate list.' };
      // Always authorize reads against current storage, even on the idempotent path.
      const skill = await input.getSkill(id);
      if (!skill || skill.status !== 'ready') return { ok: false, actual: 'Skill is disabled or no longer accessible.' };
      const digest = knowledgeDigest(skill.content);
      bodies.set(id, skill);
      state = { ...state, skills: [...state.skills.filter((item) => item.id !== id),
        { id, version: skill.version, digest, loadedAt: new Date().toISOString(), bodyAvailable: true }],
        revokedSkills: state.revokedSkills?.filter((item) => item.id !== id) };
      await persist();
      return { ok: true, actual: JSON.stringify({ skillId: id, version: skill.version, digest,
        alreadyLoaded: loaded?.digest === digest && loaded.bodyAvailable !== false, message: 'Full operating rules will be included in the next model request, including after compaction; resources are available by reference.' }) };
    },
  };
}
