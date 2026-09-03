import type { BrowserActionResult } from '@webpilot/capability-browser/node';
import type { CapabilitySkill } from '@webpilot/capability-sdk';
import { browserCapabilityManifest } from '@webpilot/capability-browser';
import { fileCapabilityManifest } from '@webpilot/capability-file';
import { chartCapabilityManifest } from '@webpilot/capability-chart';
import { subagentRuntimeSkill } from './subagent-runtime-skill';

function manifestRuntimeSkill(manifest: { id: string; skills?: readonly CapabilitySkill[] }) {
  const skill = manifest.skills?.[0];
  if (!skill) throw new Error(`Capability ${manifest.id} does not export a runtime Skill.`);
  return skill;
}

const browserRuntimeSkill = manifestRuntimeSkill(browserCapabilityManifest);
const fileRuntimeSkill = manifestRuntimeSkill(fileCapabilityManifest);
const chartCapabilityRuntimeSkill = manifestRuntimeSkill(chartCapabilityManifest);

type HiddenRuntimeSkillPolicy = {
  skillId: string;
  requires: (input: unknown) => boolean;
};

function actionFromInput(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const action = (input as Record<string, unknown>).action;
  return typeof action === 'string' ? action : undefined;
}

const hiddenRuntimeSkills: Readonly<Record<string, CapabilitySkill>> = Object.freeze(Object.fromEntries([
  browserRuntimeSkill,
  fileRuntimeSkill,
  subagentRuntimeSkill,
  chartCapabilityRuntimeSkill,
].map((skill) => [skill.id, skill])));

export const hiddenRuntimeSkillPolicies: Readonly<Record<string, HiddenRuntimeSkillPolicy>> = Object.freeze(
  Object.fromEntries(Object.values(hiddenRuntimeSkills).flatMap((skill) => (
    (skill.activation || []).map((activation) => [activation.toolName, {
      skillId: skill.id,
      requires: activation.actions?.length
        ? (input: unknown) => activation.actions!.includes(actionFromInput(input) || '')
        : () => true,
    } satisfies HiddenRuntimeSkillPolicy])
  ))),
);

export function activeBrowserRuntimeSkillId() {
  return browserRuntimeSkill.id;
}

export function hiddenRuntimeSkillSummaries() {
  return [
    browserRuntimeSkill.summary,
    fileRuntimeSkill.summary,
    subagentRuntimeSkill.summary,
    chartCapabilityRuntimeSkill.summary,
  ].join('\n');
}

export function hiddenRuntimeSkillContent(skillId: string) {
  return hiddenRuntimeSkills[skillId as keyof typeof hiddenRuntimeSkills]?.content;
}

export function requiredHiddenRuntimeSkillId(
  toolName: string,
  input: unknown,
) {
  const policy = hiddenRuntimeSkillPolicies[toolName];
  if (!policy?.requires(input)) return undefined;
  return policy.skillId;
}

export function hiddenRuntimeSkillIdsReadFromTraces(traces: ReadonlyArray<{
  name?: string;
  input?: unknown;
  result?: { ok?: boolean };
}>) {
  const loaded = new Set<string>();
  for (const trace of traces) {
    if (trace.name !== 'skill' || trace.result?.ok !== true) continue;
    if (!trace.input || typeof trace.input !== 'object' || Array.isArray(trace.input)) continue;
    const input = trace.input as Record<string, unknown>;
    if (input.action !== undefined && input.action !== 'read') continue;
    if (typeof input.skillId === 'string' && hiddenRuntimeSkillContent(input.skillId)) {
      loaded.add(input.skillId);
    }
  }
  return loaded;
}

export function requireHiddenRuntimeSkillRead(
  toolName: string,
  input: unknown,
  loadedSkillIds: Set<string>,
): BrowserActionResult | undefined {
  const requiredSkillId = requiredHiddenRuntimeSkillId(toolName, input);
  if (!requiredSkillId || loadedSkillIds.has(requiredSkillId)) return undefined;
  return {
    ok: false,
    actual: JSON.stringify({
      ok: false,
      code: 'RUNTIME_SKILL_READ_REQUIRED',
      error: `Read required runtime Skill ${requiredSkillId} before calling ${toolName}. The governed operation was not executed.`,
      requiredSkillId,
    }, null, 2),
    failureCategory: 'skill-read-required',
    requiredSkillId,
  };
}

export function runtimeToolTypesWithLoadedSkills(
  toolTypes: readonly string[],
  loadedSkillIds: ReadonlySet<string>,
  options: { allowSubagentRead?: boolean } = {},
) {
  return toolTypes.filter((toolName) => {
    // subagent action=read must remain available for collecting a result after
    // a resume. action=spawn is still rejected by requireHiddenRuntimeSkillRead.
    if (toolName === 'subagent' && options.allowSubagentRead) return true;
    const policy = hiddenRuntimeSkillPolicies[toolName];
    return !policy || loadedSkillIds.has(policy.skillId);
  });
}
