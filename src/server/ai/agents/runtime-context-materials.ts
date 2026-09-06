import { createHash } from 'node:crypto';
import type { ModelMessage } from 'ai';
import { estimateRuntimeTextTokens } from './runtime-context-budget';

export type RuntimeMaterial = {
  ref: string;
  kind: 'source' | 'skill';
  pointer: string;
  identity: Record<string, string | number | boolean>;
  readWith: string;
};

export function contextSkillInlineTokens() {
  const value = Number(process.env.AI_CONTEXT_SKILL_INLINE_TOKENS || 2000);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 2000;
}

export function contextObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return undefined; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function identityOf(value: Record<string, unknown> | undefined) {
  const identity: RuntimeMaterial['identity'] = {};
  for (const key of ['documentId', 'artifactId', 'attachmentId', 'path', 'sourceFileName', 'sourceUnitPath', 'sourceDigest', 'sourceUnitDigest', 'patchBaseDigest', 'version', 'skillId', 'digest', 'startLine', 'endLine', 'coordinateSpace']) {
    const item = value?.[key];
    if (typeof item === 'number' || typeof item === 'boolean' || typeof item === 'string' && item.length < 4000) identity[key] = item;
  }
  const range = contextObject(value?.sourceLineRange);
  for (const key of ['startLine', 'endLine', 'coordinateSpace']) {
    const item = range?.[key];
    if (typeof item === 'string' || typeof item === 'number') identity[key] = item;
  }
  return identity;
}

/** Extract only transport metadata. IDs/ranges are never authored by the summarizer. */
export function runtimeMessageMaterials(message: ModelMessage, ref: string, calls: Map<string, Record<string, unknown>>) {
  const materials: RuntimeMaterial[] = [];
  if (message.role !== 'tool') {
    const texts = typeof message.content === 'string' ? [message.content] : message.content.flatMap((part) => part.type === 'text' ? [part.text] : []);
    if (texts.some((text) => /```(?:python|py|javascript|js|typescript|ts|tsx|jsx|html|css|sql|bash|sh|powershell)\b[\s\S]*?```/i.test(text))) {
      materials.push({ ref, kind: 'source', pointer: '/content', identity: {}, readWith: 'contextRead' });
    }
  }
  if (!Array.isArray(message.content)) return materials;
  message.content.forEach((part, index) => {
    if (part.type === 'tool-call') {
      const input = contextObject(part.input);
      for (const key of ['program', 'code', 'patch', 'replacements']) if (input?.[key] !== undefined) {
        materials.push({ ref, kind: 'source', pointer: `/content/${index}/input/${key}`, identity: identityOf(input), readWith: input.documentId ? 'file.readSource' : 'contextRead' });
      }
      return;
    }
    if (part.type !== 'tool-result' || !('value' in part.output)) return;
    const raw = part.output.value;
    const outer = contextObject(raw);
    const body = outer?.actual ?? raw;
    const sourceFence = typeof body === 'string' && body.includes('\n\nExact source below:');
    const actual = contextObject(sourceFence ? body.split('\n\n', 1)[0] : body) || outer;
    const call = calls.get(part.toolCallId) || {};
    const gate = actual?.code === 'RUNTIME_SKILL_CONTENT_RETURNED';
    const isSkill = part.toolName === 'skill' && outer?.ok === true || gate;
    if (isSkill) {
      const content = gate ? actual?.skillContent : body;
      const id = gate ? actual?.requiredSkillId : actual?.skillId ?? call.skillId;
      materials.push({ ref, kind: 'skill', pointer: '', readWith: 'skill', identity: {
        ...identityOf(actual), ...(typeof id === 'string' ? { skillId: id } : {}),
        ...(typeof content === 'string' ? { estimatedTokens: estimateRuntimeTextTokens(content), digest: createHash('sha256').update(content).digest('hex') } : {}),
      } });
    } else if (actual?.readKind === 'source' || sourceFence || typeof actual?.program === 'string'
      || part.toolName === 'file' && ['generate', 'edit', 'readSource'].includes(String(call.action))) {
      materials.push({ ref, kind: 'source', pointer: `${message.content.length > 1 ? `/${index}` : ''}${outer && 'actual' in outer ? '/actual' : ''}${!sourceFence && typeof actual?.program === 'string' ? '/program' : ''}`,
        identity: { ...identityOf(call), ...identityOf(actual) }, readWith: typeof (actual?.documentId ?? call.documentId) === 'string' ? 'file.readSource' : 'contextRead' });
    }
  });
  return materials;
}

export function projectUserSource(message: ModelMessage, ref: string): ModelMessage {
  const replace = (text: string) => text.replace(/```(?:python|py|javascript|js|typescript|ts|tsx|jsx|html|css|sql|bash|sh|powershell)\b[\s\S]*?```/gi, `[Source block archived at ${ref}; use contextRead to retrieve the original before editing.]`);
  if (message.role !== 'user') return message;
  return { ...message, content: typeof message.content === 'string' ? replace(message.content)
    : message.content.map((part) => part.type === 'text' ? { ...part, text: replace(part.text) } : part) };
}

const sourceKeys = new Set(['program', 'patch', 'oldText', 'newText', 'replacements', 'skillContent']);
function omitSource(value: unknown, ref: string): unknown {
  if (typeof value === 'string') {
    if (value.includes('Exact source below:')) return { metadata: omitSource(contextObject(value.split('\n\n', 1)[0]), ref), contextRef: ref, sourceOmitted: true };
    const decoded = contextObject(value);
    if (decoded) return omitSource(decoded, ref);
    return value.replace(/```[\s\S]*?```/g, `[Code/material block archived at ${ref}]`);
  }
  if (Array.isArray(value)) return value.map((item) => omitSource(item, ref));
  const record = contextObject(value);
  if (!record) return value;
  return Object.fromEntries(Object.entries(record).filter(([key]) => !['axTree', 'domSnapshot', 'domChanges'].includes(key)).map(([key, item]) => [key,
    sourceKeys.has(key) || key === 'code' && typeof item === 'string' && !/^[A-Z][A-Z0-9_-]{0,127}$/.test(item)
      || key === 'source' && typeof item === 'string' && !/^[\w.:/@-]{1,256}$/.test(item)
      ? { contextRef: ref, sourceOmitted: true } : omitSource(item, ref),
  ]));
}

/** Summary input only: never rewrite provider signatures in the execution transcript. */
export function runtimeSummaryRecord(message: ModelMessage, ref: string, materials: RuntimeMaterial[]) {
  // A parallel exchange can contain both Skill rules and unrelated results.
  // Remove just the rule body so diagnostics from sibling results survive.
  const projection = message.role === 'tool' ? { ...message, content: message.content.map((part) => {
    if (part.type !== 'tool-result' || !('value' in part.output)) return part;
    const outer = contextObject(part.output.value);
    const actual = contextObject(outer?.actual);
    if (!(part.toolName === 'skill' && outer?.ok === true || actual?.code === 'RUNTIME_SKILL_CONTENT_RETURNED')) return part;
    return { ...part, output: { type: 'json', value: { ok: outer?.ok, bodyOmitted: true, contextRef: ref,
      instruction: 'Use the Skill reference; reread missing rules before governed actions.' } } };
  }) } : message;
  const value = omitSource(projection, ref) as Record<string, unknown>;
  if (Array.isArray(value.content)) value.content = value.content.filter((part) => {
    const type = contextObject(part)?.type;
    return !['reasoning', 'file', 'image'].includes(String(type));
  });
  // Large tool dumps are recoverable data, not an unbounded second model request.
  const serialized = JSON.stringify(value);
  return message.role === 'tool' && estimateRuntimeTextTokens(serialized) > 4000
    ? { ref, role: message.role, complete: false, preview: serialized.slice(0, 8000), materials, readWith: 'contextRead' }
    : { ref, ...value, ...(materials.length ? { materials } : {}) };
}

export function runtimeMaterialReceipt(material: RuntimeMaterial): ModelMessage {
  return { role: 'user', content: `[WebPilot material reference]\n${JSON.stringify(material)}\nHistorical locator only. Source bodies are not present: read the current source before editing. Skill references are not operating rules: reread a missing Skill before its governed action.` };
}
