export const runtimeToolLoopStopToolNames = [
  'waitForHumanVerification',
  'subagent',
] as const;

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
    && !traces.some((trace) => trace.name === 'readBrowserState' && trace.result !== undefined);
}

export function browserToolBlockedBeforeBrowserState(
  toolName: string,
  preflightPending: boolean,
  browserToolNames: ReadonlySet<string>,
) {
  return preflightPending
    && toolName !== 'readBrowserState'
    && browserToolNames.has(toolName);
}
