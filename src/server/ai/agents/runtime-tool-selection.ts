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
  const nativeAllowedToolTypes = nativeToolNames.filter((name) => !(browserChatMode && name === 'reportState'));
  void codexMode;
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

export function toolsAllowedBeforeBrowserState(
  allowedToolTypes: string[],
  browserToolNames: ReadonlySet<string>,
) {
  return allowedToolTypes.filter(
    (toolType) => toolType === 'readBrowserState' || !browserToolNames.has(toolType),
  );
}
