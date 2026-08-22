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
  input?: unknown,
) {
  // `subagent.read` only returns an already-persisted child result. It neither
  // observes nor changes the live browser, so a browser preflight would turn a
  // harmless result read into a stale-session failure.
  const isSubagentResultRead = toolName === 'subagent'
    && Boolean(input && typeof input === 'object' && 'action' in input && input.action === 'read');
  return preflightPending
    && toolName !== 'readBrowserState'
    && !isSubagentResultRead
    && browserToolNames.has(toolName);
}
