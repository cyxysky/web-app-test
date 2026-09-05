import { asRecord, finiteNumber } from '@/lib/unknown-value';

export type BrowserChatLogRecordLike = {
  details?: unknown;
  elapsedMs?: number;
  message?: string;
  phase: string;
};

export type BrowserChatLogSummary = {
  ai: number;
  context: number;
  screenshot: number;
  tool: number;
  total: number;
};

export type BrowserChatExecutionTotals = {
  aiRequestElapsedMs: number;
  toolCallCount: number;
  toolElapsedMs: number;
};

function parsedLogDetails(details: unknown) {
  if (typeof details !== 'string') return asRecord(details);
  try {
    return asRecord(JSON.parse(details));
  } catch {
    return undefined;
  }
}

function runtimeLogTimings(log: BrowserChatLogRecordLike) {
  if (!log.phase.endsWith('ai:runtime:response') && !log.phase.endsWith('ai:runtime:object')) return undefined;
  const details = parsedLogDetails(log.details);
  const payload = asRecord(details?.event) || asRecord(details?.value) || details;
  return asRecord(asRecord(payload?.aiOutput)?.timings)
    || (typeof log.elapsedMs === 'number' ? { aiRequestElapsedMs: log.elapsedMs } : undefined);
}

function phaseMatches(log: BrowserChatLogRecordLike, phase: string) {
  return log.phase === phase || log.phase.endsWith(`:${phase}`);
}

export function summarizeBrowserChatExecutionTotals(logs: BrowserChatLogRecordLike[]): BrowserChatExecutionTotals {
  return logs.reduce<BrowserChatExecutionTotals>((summary, log) => {
    const timings = runtimeLogTimings(log);
    if (!timings) return summary;
    const tools = Array.isArray(timings.tools) ? timings.tools : [];
    const toolElapsedMs = finiteNumber(timings.toolElapsedMs)
      ?? tools.reduce((total, tool) => total + (finiteNumber(asRecord(tool)?.elapsedMs) || 0), 0);
    const toolOverheadElapsedMs = finiteNumber(timings.toolOverheadElapsedMs) || 0;
    return {
      aiRequestElapsedMs: summary.aiRequestElapsedMs + (finiteNumber(timings.aiRequestElapsedMs) || 0),
      toolCallCount: summary.toolCallCount + (finiteNumber(timings.toolCount) ?? tools.length),
      toolElapsedMs: summary.toolElapsedMs + toolElapsedMs + toolOverheadElapsedMs,
    };
  }, { aiRequestElapsedMs: 0, toolCallCount: 0, toolElapsedMs: 0 });
}

export function isBrowserChatAiInputOutputLog(log: BrowserChatLogRecordLike) {
  return phaseMatches(log, 'ai:runtime:request')
    || phaseMatches(log, 'ai:runtime:response')
    || phaseMatches(log, 'ai:runtime:object')
    || phaseMatches(log, 'conversation:context:request')
    || phaseMatches(log, 'conversation:context:response');
}

export function isBrowserChatAiFailureLog(log: BrowserChatLogRecordLike) {
  return isBrowserChatAiTerminalFailureLog(log)
    || phaseMatches(log, 'ai:runtime:attempt-failed')
    || phaseMatches(log, 'ai:runtime:retry')
    || phaseMatches(log, 'ai:runtime:retry-exhausted')
    || phaseMatches(log, 'ai:runtime:retry-skipped')
    || phaseMatches(log, 'ai:runtime:recoverable-error')
    || phaseMatches(log, 'chat:runtime:request-aborted')
    || phaseMatches(log, 'target:plan:validation:retry')
    || phaseMatches(log, 'target:plan:validation:error')
    || phaseMatches(log, 'target:plan:error');
}

export function isBrowserChatAiTerminalFailureLog(log: BrowserChatLogRecordLike) {
  if (!phaseMatches(log, 'ai:runtime:attempt-succeeded')) return false;
  const details = parsedLogDetails(log.details);
  const payload = asRecord(details?.event) || asRecord(details?.value) || details;
  return payload?.responseStatus === 'failed'
    || payload?.responseStatus === 'blocked'
    || ['length', 'content-filter', 'error'].includes(String(payload?.finishReason || ''));
}

export function isBrowserChatAiAttemptLog(log: BrowserChatLogRecordLike) {
  return phaseMatches(log, 'ai:runtime:attempt')
    || phaseMatches(log, 'ai:runtime:attempt-succeeded')
    || isBrowserChatAiFailureLog(log);
}

export function isBrowserChatDocumentVisualQaLog(log: BrowserChatLogRecordLike) {
  return phaseMatches(log, 'ai:document-visual-qa:queued')
    || phaseMatches(log, 'ai:document-visual-qa:unavailable');
}

export function isBrowserChatTargetPlanningLog(log: BrowserChatLogRecordLike) {
  return log.phase.startsWith('target:plan:') || log.phase.includes(':target:plan:');
}

export function isBrowserChatAiLog(log: BrowserChatLogRecordLike) {
  return isBrowserChatAiInputOutputLog(log)
    || phaseMatches(log, 'ai:runtime:response-headers')
    || phaseMatches(log, 'ai:runtime:receiving')
    || isBrowserChatAiAttemptLog(log)
    || isBrowserChatDocumentVisualQaLog(log)
    || isBrowserChatTargetPlanningLog(log);
}

export function isBrowserChatContextCompressionLog(log: BrowserChatLogRecordLike) {
  return phaseMatches(log, 'ai:context-compression:start')
    || phaseMatches(log, 'ai:context-compression:complete')
    || phaseMatches(log, 'ai:context-segmented')
    || phaseMatches(log, 'conversation:context:request')
    || phaseMatches(log, 'conversation:context:response')
    || phaseMatches(log, 'conversation:context:error');
}

export function isBrowserChatToolLifecycleLog(log: BrowserChatLogRecordLike) {
  return log.phase === 'ai:tool' || log.phase.endsWith(':ai:tool');
}

export function isBrowserChatToolStartLog(log: BrowserChatLogRecordLike) {
  return isBrowserChatToolLifecycleLog(log) && /\s->\sstarted\s*$/i.test(log.message || '');
}

export function isBrowserChatScreenshotPerformanceLog(log: BrowserChatLogRecordLike) {
  const phase = log.phase.toLowerCase();
  return phase.startsWith('browser:screenshot:')
    || phase.includes(':browser:screenshot:')
    || ((phase.startsWith('perf:') || phase.includes(':perf:')) && phase.includes('screenshot'));
}

export function isBrowserChatVisibleExecutionLog(log: BrowserChatLogRecordLike) {
  return isBrowserChatAiLog(log)
    || (isBrowserChatToolLifecycleLog(log) && !isBrowserChatToolStartLog(log))
    || isBrowserChatContextCompressionLog(log)
    || isBrowserChatScreenshotPerformanceLog(log);
}

export function visibleBrowserChatExecutionLogs<TLog extends BrowserChatLogRecordLike>(logs: TLog[]) {
  return logs.filter(isBrowserChatVisibleExecutionLog);
}

export function summarizeBrowserChatLogs(logs: BrowserChatLogRecordLike[]): BrowserChatLogSummary {
  return logs.reduce<BrowserChatLogSummary>((summary, log) => ({
    ai: summary.ai + (isBrowserChatAiLog(log) ? 1 : 0),
    context: summary.context + (isBrowserChatContextCompressionLog(log) ? 1 : 0),
    screenshot: summary.screenshot + (isBrowserChatScreenshotPerformanceLog(log) ? 1 : 0),
    tool: summary.tool + (isBrowserChatToolLifecycleLog(log) ? 1 : 0),
    total: summary.total + 1,
  }), { ai: 0, context: 0, screenshot: 0, tool: 0, total: 0 });
}
