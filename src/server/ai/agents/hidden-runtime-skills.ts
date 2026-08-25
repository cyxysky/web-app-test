import type { BrowserActionResult } from '@/server/browser/browser-session';
import {
  resolveBrowserCodeRuntimeMode,
  type BrowserCodeRuntimeMode,
} from '@/server/browser/browser-code-runtime-mode';
import {
  browserApiRuntimeSkillContent,
  browserApiRuntimeSkillId,
  browserApiRuntimeSkillSummary,
} from './browser-api-runtime-skill';
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

type HiddenRuntimeSkillPolicy = {
  skillId: string;
  requires: (input: unknown) => boolean;
};

function actionFromInput(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const action = (input as Record<string, unknown>).action;
  return typeof action === 'string' ? action : undefined;
}

const governedFileActions = new Set([
  'plan',
  'generate',
  'edit',
  'render',
  'convert',
  'jsApi',
  'unoApi',
]);

export const hiddenRuntimeSkillPolicies: Readonly<Record<string, HiddenRuntimeSkillPolicy>> = Object.freeze({
  browserCode: {
    skillId: browserCodeRuntimeSkillId,
    requires: () => true,
  },
  file: {
    skillId: fileArtifactRuntimeSkillId,
    requires: (input) => governedFileActions.has(actionFromInput(input) || ''),
  },
  fileVisual: {
    skillId: fileArtifactRuntimeSkillId,
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
  [browserApiRuntimeSkillId]: {
    content: browserApiRuntimeSkillContent,
    summary: browserApiRuntimeSkillSummary,
  },
  [fileArtifactRuntimeSkillId]: {
    content: fileArtifactRuntimeSkillContent,
    summary: fileArtifactRuntimeSkillSummary,
  },
  [subagentRuntimeSkillId]: {
    content: subagentRuntimeSkillContent,
    summary: subagentRuntimeSkillSummary,
  },
});

export function activeBrowserRuntimeSkillId(
  mode: BrowserCodeRuntimeMode = resolveBrowserCodeRuntimeMode(),
) {
  return mode === 'restricted' ? browserApiRuntimeSkillId : browserCodeRuntimeSkillId;
}

export function hiddenRuntimeSkillSummariesForMode(
  mode: BrowserCodeRuntimeMode = resolveBrowserCodeRuntimeMode(),
) {
  const browserSkillId = activeBrowserRuntimeSkillId(mode);
  return [
    hiddenRuntimeSkills[browserSkillId].summary,
    hiddenRuntimeSkills[fileArtifactRuntimeSkillId].summary,
    hiddenRuntimeSkills[subagentRuntimeSkillId].summary,
  ].join('\n');
}

export function hiddenRuntimeSkillContent(skillId: string) {
  return hiddenRuntimeSkills[skillId as keyof typeof hiddenRuntimeSkills]?.content;
}

export function requiredHiddenRuntimeSkillId(
  toolName: string,
  input: unknown,
  mode: BrowserCodeRuntimeMode = resolveBrowserCodeRuntimeMode(),
) {
  const policy = hiddenRuntimeSkillPolicies[toolName];
  if (!policy?.requires(input)) return undefined;
  return toolName === 'browserCode' ? activeBrowserRuntimeSkillId(mode) : policy.skillId;
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

export function hiddenRuntimeSkillGateResult(
  toolName: string,
  input: unknown,
  loadedSkillIds: ReadonlySet<string>,
  mode: BrowserCodeRuntimeMode = resolveBrowserCodeRuntimeMode(),
): BrowserActionResult | undefined {
  const requiredSkillId = requiredHiddenRuntimeSkillId(toolName, input, mode);
  if (!requiredSkillId || loadedSkillIds.has(requiredSkillId)) return undefined;
  const requiredNextAction = `先通过 skill action=read 读取隐藏运行规范 ${requiredSkillId}，再重新调用原工具。`;
  return {
    ok: false,
    actual: JSON.stringify({
      ok: false,
      requiredSkillId,
      requiredNextAction,
    }, null, 2),
    requiredSkillId,
    requiredNextAction,
  };
}

/**
 * browserCode always requires the active browser runtime Skill, so do not
 * advertise that tool to the model until the read has completed. The
 * execution-time gate remains as a defense for stale/replayed tool calls.
 */
export function runtimeToolTypesAfterHiddenSkillGate(
  toolTypes: readonly string[],
  loadedSkillIds: ReadonlySet<string>,
  mode: BrowserCodeRuntimeMode = resolveBrowserCodeRuntimeMode(),
) {
  const browserSkillId = activeBrowserRuntimeSkillId(mode);
  return loadedSkillIds.has(browserSkillId)
    ? [...toolTypes]
    : toolTypes.filter((toolType) => toolType !== 'browserCode');
}
