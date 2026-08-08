import { asRecord, finiteNumber } from '@/lib/unknown-value';

export type BrowserChatLogRecordLike = {
  details?: unknown;
  phase: string;
};

export type BrowserChatLogSummary = {
  ai: number;
  context: number;
  screenshot: number;
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
  const payload = asRecord(details?.event) || details;
  return asRecord(asRecord(payload?.aiOutput)?.timings);
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
  return log.phase === 'ai:runtime:request'
    || log.phase === 'ai:runtime:response'
    || log.phase === 'ai:runtime:object'
    || log.phase === 'conversation:context:request'
    || log.phase === 'conversation:context:response';
}

export function isBrowserChatAiFailureLog(log: BrowserChatLogRecordLike) {
  return log.phase === 'ai:runtime:retry'
    || log.phase === 'ai:runtime:retry-skipped'
    || log.phase === 'ai:runtime:recoverable-error'
    || log.phase === 'chat:runtime:request-aborted'
    || log.phase === 'target:plan:validation:retry'
    || log.phase === 'target:plan:validation:error'
    || log.phase === 'target:plan:error';
}

export function isBrowserChatTargetPlanningLog(log: BrowserChatLogRecordLike) {
  return log.phase.startsWith('target:plan:');
}

export function isBrowserChatAiLog(log: BrowserChatLogRecordLike) {
  return isBrowserChatAiInputOutputLog(log)
    || isBrowserChatAiFailureLog(log)
    || isBrowserChatTargetPlanningLog(log);
}

export function isBrowserChatContextCompressionLog(log: BrowserChatLogRecordLike) {
  return log.phase === 'ai:context-segmented'
    || log.phase === 'conversation:context:request'
    || log.phase === 'conversation:context:response'
    || log.phase === 'conversation:context:error';
}

export function isBrowserChatScreenshotPerformanceLog(log: BrowserChatLogRecordLike) {
  const phase = log.phase.toLowerCase();
  return phase.startsWith('browser:screenshot:')
    || (phase.startsWith('perf:') && phase.includes('screenshot'));
}

export function isBrowserChatVisibleExecutionLog(log: BrowserChatLogRecordLike) {
  return isBrowserChatAiLog(log)
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
    total: summary.total + 1,
  }), { ai: 0, context: 0, screenshot: 0, total: 0 });
}
