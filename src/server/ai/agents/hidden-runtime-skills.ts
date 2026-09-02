import type { BrowserActionResult } from '@/server/browser/browser-session';
import {
  browserCodeRuntimeSkillContent,
  browserCodeRuntimeSkillId,
  browserCodeRuntimeSkillSummary,
} from './browser-code-runtime-skill';
import {
  fileArtifactRuntimeSkillContent,
  fileArtifactRuntimeSkillId,
  fileArtifactRuntimeSkillSummary,
} from './file-artifact-runtime-skill';
import {
  subagentRuntimeSkillContent,
  subagentRuntimeSkillId,
  subagentRuntimeSkillSummary,
} from './subagent-runtime-skill';
import {
  chartRuntimeSkillContent,
  chartRuntimeSkillId,
  chartRuntimeSkillSummary,
} from './chart-runtime-skill';

type HiddenRuntimeSkillPolicy = {
  skillId: string;
  requires: (input: unknown) => boolean;
};

function actionFromInput(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const action = (input as Record<string, unknown>).action;
  return typeof action === 'string' ? action : undefined;
}

export const hiddenRuntimeSkillPolicies: Readonly<Record<string, HiddenRuntimeSkillPolicy>> = Object.freeze({
  browserCode: {
    skillId: browserCodeRuntimeSkillId,
    requires: () => true,
  },
  file: {
    skillId: fileArtifactRuntimeSkillId,
    requires: () => true,
  },
  fileVisual: {
    skillId: fileArtifactRuntimeSkillId,
    requires: () => true,
  },
  chart: {
    skillId: chartRuntimeSkillId,
    requires: () => true,
  },
  subagent: {
    skillId: subagentRuntimeSkillId,
    requires: (input) => actionFromInput(input) === 'spawn',
  },
});

const hiddenRuntimeSkills = Object.freeze({
  [browserCodeRuntimeSkillId]: {
    content: browserCodeRuntimeSkillContent,
    summary: browserCodeRuntimeSkillSummary,
  },
  [fileArtifactRuntimeSkillId]: {
    content: fileArtifactRuntimeSkillContent,
    summary: fileArtifactRuntimeSkillSummary,
  },
  [subagentRuntimeSkillId]: {
    content: subagentRuntimeSkillContent,
    summary: subagentRuntimeSkillSummary,
  },
  [chartRuntimeSkillId]: {
    content: chartRuntimeSkillContent,
    summary: chartRuntimeSkillSummary,
  },
});

export function activeBrowserRuntimeSkillId() {
  return browserCodeRuntimeSkillId;
}

export function hiddenRuntimeSkillSummaries() {
  return [
    hiddenRuntimeSkills[browserCodeRuntimeSkillId].summary,
    hiddenRuntimeSkills[fileArtifactRuntimeSkillId].summary,
    hiddenRuntimeSkills[subagentRuntimeSkillId].summary,
    hiddenRuntimeSkills[chartRuntimeSkillId].summary,
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

export function automaticallyLoadHiddenRuntimeSkill(
  toolName: string,
  input: unknown,
  loadedSkillIds: Set<string>,
): Pick<BrowserActionResult, 'loadedRuntimeSkill'> | BrowserActionResult | undefined {
  const requiredSkillId = requiredHiddenRuntimeSkillId(toolName, input);
  if (!requiredSkillId || loadedSkillIds.has(requiredSkillId)) return undefined;
  const content = hiddenRuntimeSkillContent(requiredSkillId);
  if (!content) {
    return {
      ok: false,
      actual: JSON.stringify({
        ok: false,
        error: `Unable to load required hidden runtime Skill ${requiredSkillId}.`,
        requiredSkillId,
      }, null, 2),
      failureCategory: 'skill-load-failed',
      requiredSkillId,
    };
  }
  loadedSkillIds.add(requiredSkillId);
  return {
    loadedRuntimeSkill: {
      id: requiredSkillId,
      content,
      loadedAutomatically: true,
    },
  };
}

/**
 * Governed tools stay visible. Their first call in one Agent run atomically
 * loads and returns the corresponding hidden Skill before executing the
 * original call, removing the extra model round-trip.
 */
export function runtimeToolTypesWithAutomaticSkills(
  toolTypes: readonly string[],
) {
  return [...toolTypes];
}
