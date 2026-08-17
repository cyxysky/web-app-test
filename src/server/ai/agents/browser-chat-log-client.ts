type BrowserChatClientLog = {
  details?: string;
  id?: string;
  message?: string;
  phase: string;
  stepIndex?: number;
  time?: string;
  toolCallId?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parsedDetails(value: string) {
  const details = asRecord(JSON.parse(value));
  const payload = asRecord(details?.value) || details;
  if (!payload) return undefined;
  return details?.execution && payload.execution === undefined
    ? { ...payload, execution: details.execution }
    : payload;
}

export function compactBrowserChatLogForClient<TLog extends BrowserChatClientLog>(log: TLog): TLog {
  if (!log.details) return log;

  if (log.phase === 'ai:runtime:request') {
    try {
      const details = parsedDetails(log.details);
      const aiInput = asRecord(details?.aiInput);
      const compactedDetails = JSON.stringify({
        aiInput: aiInput ? {
          model: aiInput.model,
          options: aiInput.options,
          provider: aiInput.provider,
          tools: aiInput.tools,
        } : undefined,
        aiInputTokens: details?.aiInputTokens,
        execution: details?.execution,
      });
      return { ...log, details: compactedDetails };
    } catch {
      const compacted = { ...log };
      delete compacted.details;
      return compacted;
    }
  }

  if (log.phase !== 'ai:runtime:response' && log.phase !== 'ai:runtime:object') return log;

  try {
    const details = parsedDetails(log.details);
    const aiOutput = asRecord(details?.aiOutput);
    if (!aiOutput) return log;

    const rawResponse = aiOutput.response;
    const responseRecord = asRecord(rawResponse);
    const response = responseRecord && Object.hasOwn(responseRecord, 'content')
      ? {
          content: responseRecord.content,
          finishReason: responseRecord.finishReason,
          reasoningText: responseRecord.reasoningText,
          text: responseRecord.text,
          toolCalls: responseRecord.toolCalls,
          usage: responseRecord.usage,
        }
      : rawResponse;
    const compactedDetails = JSON.stringify({
      aiOutput: {
        responseType: aiOutput.responseType,
        text: aiOutput.text,
        response,
        timings: aiOutput.timings,
        usage: aiOutput.usage,
      },
      execution: details?.execution,
    });
    return compactedDetails.length < log.details.length
      ? { ...log, details: compactedDetails }
      : log;
  } catch {
    return log;
  }
}

export function compactBrowserChatLogsForClient<TLog extends BrowserChatClientLog>(logs: TLog[]) {
  const compacted = logs.map(compactBrowserChatLogForClient);
  const finalToolLogIndex = new Map<string, number>();
  const finalToolLogKey = (log: TLog) => {
    const isFinalToolLog = log.phase === 'ai:tool'
      && Boolean(log.toolCallId)
      && /\s->\s(?:ok|failed)$/i.test(log.message || '');
    return isFinalToolLog
      ? [log.toolCallId, log.stepIndex ?? '', log.message].join('|')
      : undefined;
  };
  compacted.forEach((log, index) => {
    const key = finalToolLogKey(log);
    if (key) finalToolLogIndex.set(key, index);
  });
  return compacted.filter((log, index) => {
    const key = finalToolLogKey(log);
    return !key || finalToolLogIndex.get(key) === index;
  });
}
