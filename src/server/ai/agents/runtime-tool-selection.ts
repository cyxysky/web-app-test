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
