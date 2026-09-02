export const runtimeToolLoopStopToolNames = [
  'finalResponse',
  'waitForHumanVerification',
  'subagent',
] as const;

export const runtimeBrowserSessionToolNames: ReadonlySet<string> = new Set([
  'readBrowserState',
  'browserCode',
  'waitForHumanVerification',
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
  const baseAllowedToolTypes = nativeAllowedToolTypes;

  return browserChatMode && codexMode ? [...baseAllowedToolTypes, 'answer'] : baseAllowedToolTypes;
}

export function requiresBrowserStatePreflight(
  alreadyCompleted: boolean,
  traces: Array<{ name?: string; result?: unknown }>,
) {
  return !alreadyCompleted
    && !traces.some((trace) => {
      if (trace.name === 'readBrowserState' && trace.result !== undefined) return true;
      if (!trace.result || typeof trace.result !== 'object' || !('prerequisiteResults' in trace.result)) return false;
      const prerequisiteResults = trace.result.prerequisiteResults;
      return Array.isArray(prerequisiteResults) && prerequisiteResults.some((entry) => (
        entry
        && typeof entry === 'object'
        && 'toolName' in entry
        && entry.toolName === 'readBrowserState'
        && 'result' in entry
        && entry.result !== undefined
      ));
    });
}

export function browserToolPrerequisiteNames(
  toolName: string,
  preflightPending: boolean,
  browserToolNames: ReadonlySet<string>,
) {
  return preflightPending
    && toolName !== 'readBrowserState'
    && browserToolNames.has(toolName)
    ? ['readBrowserState'] as const
    : [] as const;
}
