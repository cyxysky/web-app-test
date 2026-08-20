export type BrowserChatRuntimeLogLike = {
  details?: string;
  message?: string;
  phase?: string;
};

export type BrowserChatRuntimeLogLimits = {
  maxCharacters: number;
  maxCount: number;
  maxDetailCharacters: number;
};

function boundedPositiveInteger(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function compactBrowserChatLogDetails(details: string | undefined, maxCharacters: number) {
  if (!details) return details;
  const limit = boundedPositiveInteger(maxCharacters, 1);
  if (details.length <= limit) return details;

  let previewLength = Math.max(0, limit - 160);
  let compacted = '';
  while (previewLength >= 0) {
    compacted = JSON.stringify({
      truncated: true,
      originalCharacters: details.length,
      preview: details.slice(0, previewLength),
    });
    if (compacted.length <= limit || previewLength === 0) break;
    previewLength = Math.max(0, Math.floor(previewLength * 0.72));
  }
  return compacted.slice(0, limit);
}

function browserChatRuntimeLogCharacters(log: BrowserChatRuntimeLogLike) {
  return (log.details?.length || 0)
    + (log.message?.length || 0)
    + (log.phase?.length || 0)
    + 96;
}

export function trimBrowserChatRuntimeLogs<T extends BrowserChatRuntimeLogLike>(
  logs: readonly T[],
  limits: BrowserChatRuntimeLogLimits,
) {
  const maxCount = boundedPositiveInteger(limits.maxCount, 1);
  const maxCharacters = boundedPositiveInteger(limits.maxCharacters, 1);
  const maxDetailCharacters = boundedPositiveInteger(limits.maxDetailCharacters, 1);
  const normalized = logs.slice(-maxCount).map((log) => {
    const details = compactBrowserChatLogDetails(log.details, maxDetailCharacters);
    return details === log.details ? log : { ...log, details };
  });
  const retained: T[] = [];
  let characters = 0;
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const log = normalized[index];
    const nextCharacters = browserChatRuntimeLogCharacters(log);
    if (retained.length && characters + nextCharacters > maxCharacters) break;
    retained.push(log);
    characters += nextCharacters;
  }
  return retained.reverse();
}

export function trimBrowserChatRuntimeItems<T>(items: readonly T[], maxCount: number) {
  return items.slice(-boundedPositiveInteger(maxCount, 1));
}
