type BrowserChatClientLog = {
  details?: string;
  phase: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function compactBrowserChatLogForClient<TLog extends BrowserChatClientLog>(log: TLog): TLog {
  if (!log.details) return log;

  if (log.phase === 'ai:runtime:request') {
    const compacted = { ...log };
    delete compacted.details;
    return compacted;
  }

  if (log.phase !== 'ai:runtime:response' && log.phase !== 'ai:runtime:object') return log;

  try {
    const details = asRecord(JSON.parse(log.details));
    const aiOutput = asRecord(details?.aiOutput);
    if (!aiOutput) return log;

    const rawResponse = aiOutput.response;
    const responseRecord = asRecord(rawResponse);
    const response = responseRecord && Object.hasOwn(responseRecord, 'content')
      ? { content: responseRecord.content }
      : rawResponse;
    const compactedDetails = JSON.stringify({
      aiOutput: {
        responseType: aiOutput.responseType,
        text: aiOutput.text,
        response,
      },
    });
    return compactedDetails.length < log.details.length
      ? { ...log, details: compactedDetails }
      : log;
  } catch {
    return log;
  }
}

export function compactBrowserChatLogsForClient<TLog extends BrowserChatClientLog>(logs: TLog[]) {
  return logs.map(compactBrowserChatLogForClient);
}
