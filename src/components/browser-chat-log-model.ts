export type BrowserChatLogRecordLike = {
  phase: string;
};

export type BrowserChatLogSummary = {
  ai: number;
  context: number;
  screenshot: number;
  total: number;
};

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
