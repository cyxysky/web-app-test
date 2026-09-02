import { browserCapabilityToolNames } from '@webpilot/capability-browser';

export const browserStatePrerequisiteToolName = 'browser.state';

export const runtimeToolLoopStopToolNames = [
  'finalResponse',
  'subagent',
] as const;

export const runtimeBrowserSessionToolNames: ReadonlySet<string> = new Set([
  browserCapabilityToolNames.browser,
]);

export function runtimeToolRequiresBrowserSession(toolName: string) {
  return runtimeBrowserSessionToolNames.has(toolName);
}

export function runtimeAllowedToolTypes({
  browserChatMode,
  codexMode,
  nativeToolNames,
  observationToolNames,
}: {
  browserChatMode: boolean;
  codexMode: boolean;
  nativeToolNames: string[];
  observationToolNames: ReadonlySet<string>;
}) {
  const nativeAllowedToolTypes = nativeToolNames;
  void observationToolNames;
  return browserChatMode && codexMode ? [...nativeAllowedToolTypes, 'answer'] : nativeAllowedToolTypes;
}

function actionFromInput(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const action = (input as Record<string, unknown>).action;
  return typeof action === 'string' ? action : undefined;
}

export function requiresBrowserStatePreflight(
  alreadyCompleted: boolean,
  traces: Array<{ name?: string; input?: unknown; result?: unknown }>,
) {
  return !alreadyCompleted
    && !traces.some((trace) => {
      if (
        trace.name === browserCapabilityToolNames.browser
        && actionFromInput(trace.input) === 'state'
        && trace.result !== undefined
      ) return true;
      if (!trace.result || typeof trace.result !== 'object' || !('prerequisiteResults' in trace.result)) return false;
      const prerequisiteResults = trace.result.prerequisiteResults;
      return Array.isArray(prerequisiteResults) && prerequisiteResults.some((entry) => (
        entry
        && typeof entry === 'object'
        && 'toolName' in entry
        && entry.toolName === browserStatePrerequisiteToolName
        && 'result' in entry
        && entry.result !== undefined
      ));
    });
}

export function browserToolPrerequisiteNames(
  toolName: string,
  toolInput: unknown,
  preflightPending: boolean,
  browserToolNames: ReadonlySet<string>,
) {
  return preflightPending
    && toolName === browserCapabilityToolNames.browser
    && actionFromInput(toolInput) !== 'state'
    && browserToolNames.has(toolName)
    ? [browserStatePrerequisiteToolName] as const
    : [] as const;
}

export function isBrowserHumanVerificationCall(toolName: string, toolInput: unknown) {
  return toolName === browserCapabilityToolNames.browser
    && actionFromInput(toolInput) === 'waitForHumanVerification';
}
