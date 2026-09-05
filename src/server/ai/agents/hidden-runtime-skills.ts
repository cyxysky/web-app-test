import type { BrowserActionResult } from '@webpilot/capability-browser/node';
import type { CapabilitySkill } from '@webpilot/capability-sdk';
import { browserCapabilityManifest } from '@webpilot/capability-browser';
import { fileCapabilityManifest } from '@webpilot/capability-file';
import { chartCapabilityManifest } from '@webpilot/capability-chart';
import { codeSandboxCapabilityManifest } from '@webpilot/capability-code-sandbox';
import { communicationCapabilityManifest } from '@webpilot/capability-communication';
import { computerCapabilityManifest } from '@webpilot/capability-computer';
import { connectorsCapabilityManifest } from '@webpilot/capability-connectors';
import { dataCapabilityManifest } from '@webpilot/capability-data';
import { gitCapabilityManifest } from '@webpilot/capability-git';
import { knowledgeCapabilityManifest } from '@webpilot/capability-knowledge';
import { mediaCapabilityManifest } from '@webpilot/capability-media';
import { researchCapabilityManifest } from '@webpilot/capability-research';
import { workflowCapabilityManifest } from '@webpilot/capability-workflow';
import { subagentRuntimeSkill } from './subagent-runtime-skill';

function manifestRuntimeSkill(manifest: { id: string; skills?: readonly CapabilitySkill[] }) {
  const skill = manifest.skills?.[0];
  if (!skill) throw new Error(`Capability ${manifest.id} does not export a runtime Skill.`);
  return skill;
}

const browserRuntimeSkill = manifestRuntimeSkill(browserCapabilityManifest);
const fileRuntimeSkill = manifestRuntimeSkill(fileCapabilityManifest);
const chartCapabilityRuntimeSkill = manifestRuntimeSkill(chartCapabilityManifest);
const infrastructureRuntimeSkills = [
  codeSandboxCapabilityManifest,
  researchCapabilityManifest,
  connectorsCapabilityManifest,
  knowledgeCapabilityManifest,
  dataCapabilityManifest,
  mediaCapabilityManifest,
  communicationCapabilityManifest,
  gitCapabilityManifest,
  computerCapabilityManifest,
  workflowCapabilityManifest,
].map(manifestRuntimeSkill);

// These capability tools are always visible to the model. Skill enforcement is
// owned by the Agent runtime below, not by the capability packages themselves.
const defaultVisibleCapabilityToolNames: ReadonlySet<string> = new Set([
  browserRuntimeSkill,
  fileRuntimeSkill,
  chartCapabilityRuntimeSkill,
  ...infrastructureRuntimeSkills,
].flatMap((skill) => (skill.activation || []).map((activation) => activation.toolName)));

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
  ...infrastructureRuntimeSkills,
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
    ...infrastructureRuntimeSkills.map((skill) => skill.summary),
  ].join('\n');
}

export function hiddenRuntimeSkillIds() {
  return Object.keys(hiddenRuntimeSkills);
}

export function hiddenRuntimeSkillContent(skillId: string) {
  return hiddenRuntimeSkills[skillId as keyof typeof hiddenRuntimeSkills]?.content;
}

/** Reuse only full, current-version Skill text still present in tool evidence.
 * A summary, user assertion or previous read ID is not sufficient after compaction. */
export function hiddenRuntimeSkillIdsInModelContext(messages: ReadonlyArray<{ role: string; content: unknown }>) {
  const loaded = new Set<string>();
  const record = (value: unknown): Record<string, unknown> | undefined => {
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return undefined; } }
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  };
  for (const message of messages) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type !== 'tool-result') continue;
      const output = record(part.output);
      const result = record(output?.value);
      if (!result) continue;
      if (part.toolName === 'skill' && result.ok === true) {
        for (const [id, skill] of Object.entries(hiddenRuntimeSkills)) {
          if (result.actual === skill.content) loaded.add(id);
        }
      }
      const gate = record(result.actual);
      if (result.ok === false && gate?.code === 'RUNTIME_SKILL_CONTENT_RETURNED'
        && typeof gate.requiredSkillId === 'string'
        && gate.skillContent === hiddenRuntimeSkillContent(gate.requiredSkillId)
        && typeof gate.skillContent === 'string') loaded.add(gate.requiredSkillId);
    }
  }
  return loaded;
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
  const skillContent = hiddenRuntimeSkillContent(requiredSkillId);
  if (skillContent) loadedSkillIds.add(requiredSkillId);
  return {
    ok: false,
    actual: JSON.stringify({
      ok: false,
      code: skillContent ? 'RUNTIME_SKILL_CONTENT_RETURNED' : 'RUNTIME_SKILL_READ_REQUIRED',
      error: skillContent
        ? `The Agent returned required runtime Skill ${requiredSkillId} instead of executing ${toolName}. Read it, then retry the tool in the next model step.`
        : `Read required runtime Skill ${requiredSkillId} before calling ${toolName}. The governed operation was not executed.`,
      requiredSkillId,
      ...(skillContent ? { skillContent } : {}),
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
    if (defaultVisibleCapabilityToolNames.has(toolName)) return true;
    // subagent action=read must remain available for collecting a result after
    // a resume. action=spawn is still rejected by requireHiddenRuntimeSkillRead.
    if (toolName === 'subagent' && options.allowSubagentRead) return true;
    const policy = hiddenRuntimeSkillPolicies[toolName];
    return !policy || loadedSkillIds.has(policy.skillId);
  });
}
