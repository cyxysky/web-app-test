import type { CapabilitySkill } from '@webpilot/capability-sdk';
export const dataRuntimeSkillId = 'system-data-runtime';
export const dataRuntimeSkill = Object.freeze({
  id: dataRuntimeSkillId,
  title: 'Structured Data Runtime',
  summary: `<system_skill id="${dataRuntimeSkillId}">Inspect the exact source schema before querying, prefer bounded read-only statements, and never infer meaning from column names alone.</system_skill>`,
  content: `# Structured Data Runtime\n\n- List sources and inspect schema before the first query.\n- Prefer explicit columns, deterministic ordering, parameters, and bounded result sets.\n- Do not expose secrets or unrelated personal data.\n- Writes are disabled by default and require both host configuration and approval.\n- Validate units, time zones, null handling, joins, and aggregation semantics before presenting conclusions.`,
  required: true,
  activation: [{ toolName: 'data', actions: ['sources', 'schema', 'query'] }],
} satisfies CapabilitySkill);
