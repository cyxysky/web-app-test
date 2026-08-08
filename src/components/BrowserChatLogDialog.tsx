'use client';

import { type CSSProperties, useRef } from 'react';
import { X } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { BrowserChatPayloadDetails } from '@/components/BrowserChatPayloadDetails';
import {
  isBrowserChatAiFailureLog,
  isBrowserChatContextCompressionLog,
  isBrowserChatScreenshotPerformanceLog,
  summarizeBrowserChatExecutionTotals,
  summarizeBrowserChatLogs,
} from '@/components/browser-chat-log-model';
import { formatLogTime, formatToolPayload, parseJsonObjectText, phaseLabel } from '@/components/browser-chat-format';
import { useI18n } from '@/i18n/I18nProvider';
import { asRecord, finiteNumber } from '@/lib/unknown-value';
import { useEscapeDismiss } from '@/hooks/useEscapeDismiss';

type Translator = ReturnType<typeof useI18n>['t'];

export type BrowserChatLogDialogRecord = {
  details?: string;
  elapsedMs?: number;
  id: string;
  message: string;
  phase: string;
  stepIndex?: number;
  time: string;
};

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function booleanValue(value: unknown) {
  return typeof value === 'boolean' ? value : undefined;
}

function aiLogRequestPayload(details?: Record<string, unknown>) {
  return details?.aiInput !== undefined ? formatToolPayload(details.aiInput) : '';
}

function aiLogResponsePayload(details?: Record<string, unknown>) {
  return details?.aiOutput !== undefined ? formatToolPayload(details.aiOutput) : '';
}

function aiLogInputTokenCount(log: BrowserChatLogDialogRecord) {
  if (!log.phase.endsWith('ai:runtime:request')) return undefined;
  const details = parseJsonObjectText(log.details);
  const payloadDetails = asRecord(details?.event) || details;
  return finiteNumber(asRecord(payloadDetails?.aiInputTokens)?.estimatedTextTokens);
}

function aiLogTimings(details?: Record<string, unknown>) {
  return asRecord(asRecord(details?.aiOutput)?.timings);
}

function formatElapsedMs(value: unknown) {
  const elapsedMs = finiteNumber(value);
  return elapsedMs === undefined ? undefined : `${Math.round(elapsedMs)}ms`;
}

function formatTotalElapsedMs(value: number) {
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1).replace(/\.0+$/, '')}s`;
  const totalSeconds = Math.round(value / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function formatPostprocessTimings(value: unknown) {
  const timings = asRecord(value);
  if (!timings) return '';
  const fields = [
    'desktopBeforeMs',
    'desktopAfterMs',
    'notifyStartMs',
    'notifyResultMs',
    'visualContextMs',
    'notifyCompleteMs',
  ];
  return fields
    .map((field) => {
      const elapsed = formatElapsedMs(timings[field]);
      return elapsed ? `${field} ${elapsed}` : '';
    })
    .filter(Boolean)
    .join('，');
}

function aiLogTimingInline(log: BrowserChatLogDialogRecord, t: Translator) {
  if (log.phase !== 'ai:runtime:response' && log.phase !== 'ai:runtime:object') return '';
  const parsed = parseJsonObjectText(log.details);
  const timings = aiLogTimings(parsed);
  if (!timings) return '';
  const ai = formatElapsedMs(timings.aiRequestElapsedMs);
  const tool = formatElapsedMs(timings.toolElapsedMs);
  const overhead = formatElapsedMs(timings.toolOverheadElapsedMs);
  const total = formatElapsedMs(timings.totalElapsedMs);
  return [
    ai ? `AI ${ai}` : '',
    tool ? t('工具 {time}', { time: tool }) : '',
    overhead && overhead !== '0ms' ? t('后处理 {time}', { time: overhead }) : '',
    total ? t('总计 {time}', { time: total }) : '',
  ].filter(Boolean).join(' · ');
}

function aiLogTimingPayload(details: Record<string, unknown> | undefined, t: Translator) {
  const timings = aiLogTimings(details);
  if (!timings) return '';
  const lines: string[] = [];
  const total = formatElapsedMs(timings.totalElapsedMs);
  if (total) lines.push(t('总耗时：{time}', { time: total }));
  const ai = formatElapsedMs(timings.aiRequestElapsedMs);
  if (ai) lines.push(t('AI 请求耗时：{time}', { time: ai }));
  const tool = formatElapsedMs(timings.toolElapsedMs);
  if (tool) lines.push(t('工具动作耗时：{time}', { time: tool }));
  const overhead = formatElapsedMs(timings.toolOverheadElapsedMs);
  if (overhead && overhead !== '0ms') lines.push(t('工具后处理耗时：{time}', { time: overhead }));
  const other = formatElapsedMs(timings.otherElapsedMs);
  if (other && other !== '0ms') lines.push(t('其他耗时：{time}', { time: other }));
  const toolCount = finiteNumber(timings.toolCount);
  if (toolCount !== undefined) lines.push(t('工具数量：{count}', { count: toolCount }));
  const tools = Array.isArray(timings.tools) ? timings.tools : [];
  if (tools.length) {
    lines.push(t('工具明细：'));
    tools.forEach((toolItem, index) => {
      const record = asRecord(toolItem);
      if (!record) return;
      const name = stringValue(record.name) || `tool ${index + 1}`;
      const action = formatElapsedMs(record.actionElapsedMs) || formatElapsedMs(record.elapsedMs) || '-';
      const overhead = formatElapsedMs(record.overheadElapsedMs);
      const total = formatElapsedMs(record.traceElapsedMs);
      const parts = [t('动作 {time}', { time: action })];
      if (overhead && overhead !== '0ms') parts.push(t('后处理 {time}', { time: overhead }));
      if (total && total !== action) parts.push(t('总计 {time}', { time: total }));
      const postprocess = formatPostprocessTimings(record.postprocessTimings);
      if (postprocess) parts.push(t('明细 {details}', { details: postprocess }));
      lines.push(`  ${index + 1}. ${name}: ${parts.join('，')}`);
    });
  }
  return lines.join('\n');
}

function contextCompressionLabel(log: BrowserChatLogDialogRecord) {
  if (!isBrowserChatContextCompressionLog(log)) return '';
  if (log.phase === 'ai:context-segmented') return 'Agent Loop 上下文压缩';
  if (log.phase === 'conversation:context:request') return '历史对话上下文开始压缩';
  if (log.phase === 'conversation:context:response') return '历史对话上下文压缩完成';
  if (log.phase === 'conversation:context:error') return '历史对话上下文压缩失败';
  return '';
}

function formatScreenshotTimingStep(step: unknown, index: number) {
  const record = asRecord(step);
  if (!record) return '';
  const name = stringValue(record.name) || `step ${index + 1}`;
  const elapsedMs = finiteNumber(record.elapsedMs);
  const parts = [`${index + 1}. ${name}`];
  if (elapsedMs !== undefined) parts.push(`${elapsedMs}ms`);
  const count = finiteNumber(record.count);
  if (count !== undefined) parts.push(`count=${count}`);
  if (booleanValue(record.skipped)) parts.push('skipped');
  const path = stringValue(record.path);
  if (path) parts.push(`path=${path}`);
  const error = stringValue(record.error);
  if (error) parts.push(`error=${error}`);
  return parts.join(' | ');
}

function screenshotPerformancePayload(details: Record<string, unknown>) {
  const timings = asRecord(details.timings);
  const lines: string[] = [];
  const totalMs = finiteNumber(timings?.totalMs) ?? finiteNumber(details.elapsedMs);
  if (totalMs !== undefined) lines.push(`totalMs: ${totalMs}`);
  const capture = stringValue(timings?.capture);
  if (capture) lines.push(`capture: ${capture}`);
  const path = stringValue(timings?.path) || stringValue(details.path) || stringValue(details.screenshotPath);
  if (path) lines.push(`path: ${path}`);
  const markerPath = stringValue(timings?.markerPath);
  if (markerPath) lines.push(`markerPath: ${markerPath}`);
  const originalPath = stringValue(timings?.originalPath);
  if (originalPath) lines.push(`originalPath: ${originalPath}`);
  const candidateCount = finiteNumber(timings?.candidateCount);
  if (candidateCount !== undefined) lines.push(`candidateCount: ${candidateCount}`);
  const scrollAreaCount = finiteNumber(timings?.scrollAreaCount);
  if (scrollAreaCount !== undefined) lines.push(`scrollAreaCount: ${scrollAreaCount}`);
  const separateMarkerMap = booleanValue(timings?.separateMarkerMap);
  if (separateMarkerMap !== undefined) lines.push(`separateMarkerMap: ${separateMarkerMap}`);
  const rawSteps = timings?.steps;
  const steps = Array.isArray(rawSteps)
    ? rawSteps.map(formatScreenshotTimingStep).filter(Boolean)
    : [];
  if (steps.length) {
    lines.push('steps:');
    lines.push(...steps.map((step) => `  ${step}`));
  }
  return lines.join('\n');
}

function BrowserChatLogDetails({ log, nextAiInputTokens }: { log: BrowserChatLogDialogRecord; nextAiInputTokens?: number }) {
  const { t } = useI18n();
  if (!log.details) return null;
  const parsed = parseJsonObjectText(log.details);
  const isAiRequestLog = log.phase.endsWith('ai:runtime:request');
  const isAiResponseLog = log.phase.endsWith('ai:runtime:response') || log.phase.endsWith('ai:runtime:object');
  const isAiFailureLog = isBrowserChatAiFailureLog(log);
  const isConversationSummaryRequest = log.phase === 'conversation:context:request';
  const isConversationSummaryResponse = log.phase === 'conversation:context:response';
  if (!parsed) return null;
  const payloadDetails = asRecord(parsed.event) || parsed;
  const requestPayload = isAiRequestLog
    ? aiLogRequestPayload(payloadDetails)
    : isConversationSummaryRequest
      ? formatToolPayload({
          provider: parsed.provider,
          model: parsed.model,
          estimatedTokens: parsed.estimatedTokens,
          thresholdTokens: parsed.thresholdTokens,
          prompt: parsed.prompt,
        })
      : '';
  const responsePayload = isAiResponseLog
    ? aiLogResponsePayload(payloadDetails)
    : isConversationSummaryResponse
      ? formatToolPayload({
          provider: parsed.provider,
          model: parsed.model,
          estimatedTokensBefore: parsed.estimatedTokensBefore,
          estimatedTokensAfter: parsed.estimatedTokensAfter,
          thresholdTokens: parsed.thresholdTokens,
          context: parsed.context,
        })
      : '';
  const timingPayload = isAiResponseLog ? aiLogTimingPayload(payloadDetails, t) : '';
  const errorPayload = isAiFailureLog ? formatToolPayload(parsed) : '';
  const performancePayload = isBrowserChatScreenshotPerformanceLog(log) ? screenshotPerformancePayload(parsed) : '';
  const requestTokens = isAiRequestLog ? finiteNumber(asRecord(payloadDetails.aiInputTokens)?.estimatedTextTokens) : undefined;
  if (!requestPayload && !responsePayload && !timingPayload && !performancePayload && !errorPayload) return null;
  return (
    <div className="browser-chat-log-details">
      <BrowserChatPayloadDetails className="browser-chat-log-detail-block is-timing" payload={timingPayload} title={t('耗时明细')} />
      <BrowserChatPayloadDetails className="browser-chat-log-detail-block" payload={requestPayload} title={t('AI 输入 JSON')} />
      {isAiRequestLog ? (
        <p className="browser-chat-log-token-count">{t('此次发送给 AI 的文本：{tokens}', {
          tokens: requestTokens === undefined ? t('无法估算') : t('约 {count} tokens', { count: Math.round(requestTokens).toLocaleString() }),
        })}</p>
      ) : null}
      <BrowserChatPayloadDetails className="browser-chat-log-detail-block is-response" payload={responsePayload} title={t('AI 输出 JSON')} />
      {isAiResponseLog ? (
        <p className="browser-chat-log-token-count">{t('下次发送给 AI 的内容：{tokens}', {
          tokens: nextAiInputTokens === undefined ? t('尚未生成') : t('约 {count} tokens', { count: Math.round(nextAiInputTokens).toLocaleString() }),
        })}</p>
      ) : null}
      <BrowserChatPayloadDetails className="browser-chat-log-detail-block is-error" payload={errorPayload} title={t('错误详情')} />
      <BrowserChatPayloadDetails className="browser-chat-log-detail-block is-performance" payload={performancePayload} title={t('截图性能')} />
    </div>
  );
}

const logVirtualRowEstimate = 104;

function BrowserChatLogEntry({
  log,
  measureRef,
  style,
  virtualIndex,
  nextAiInputTokens,
}: {
  log: BrowserChatLogDialogRecord;
  measureRef?: (node: HTMLLIElement | null) => void;
  style?: CSSProperties;
  virtualIndex?: number;
  nextAiInputTokens?: number;
}) {
  const { t } = useI18n();
  const compressionLabel = contextCompressionLabel(log);
  const timingLabel = aiLogTimingInline(log, t);
  return (
    <li
      className={compressionLabel ? 'has-context-compression' : ''}
      data-index={virtualIndex}
      ref={measureRef}
      style={style}
    >
      {compressionLabel ? (
        <div className="browser-chat-context-compression-marker">
          <span>--------------------------</span>
          <strong>{t(compressionLabel)}</strong>
          <span>--------------------------</span>
        </div>
      ) : null}
      <span>{t(phaseLabel(log.phase))}</span>
      <div>
        <strong>{t(log.message)}</strong>
        <small>
          {formatLogTime(log.time)}
          {log.stepIndex ? ` · ${t('步骤 {index}', { index: log.stepIndex })}` : ''}
          {timingLabel ? ` · ${timingLabel}` : typeof log.elapsedMs === 'number' ? ` · ${log.elapsedMs}ms` : ''}
        </small>
        <BrowserChatLogDetails log={log} nextAiInputTokens={nextAiInputTokens} />
      </div>
    </li>
  );
}

function BrowserChatVirtualLogList({ entries }: { entries: BrowserChatLogDialogRecord[] }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: entries.length,
    estimateSize: () => logVirtualRowEstimate,
    getScrollElement: () => scrollRef.current,
    overscan: 8,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();
  const nextInputTokensByIndex = new Map<number, number>();
  let nextInputTokens: number | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const log = entries[index];
    if (!log) continue;
    if (log.phase.endsWith('ai:runtime:response') || log.phase.endsWith('ai:runtime:object')) {
      if (nextInputTokens !== undefined) nextInputTokensByIndex.set(index, nextInputTokens);
    }
    const currentInputTokens = aiLogInputTokenCount(log);
    if (currentInputTokens !== undefined) nextInputTokens = currentInputTokens;
  }

  return (
    <div className="browser-chat-log-modal-list" ref={scrollRef}>
      <ol
        className="browser-chat-log-virtual-inner"
        style={{ height: rowVirtualizer.getTotalSize() }}
      >
        {virtualItems.map((virtualRow) => {
          const log = entries[virtualRow.index];
          if (!log) return null;
          return (
            <BrowserChatLogEntry
              key={log.id}
              log={log}
              measureRef={rowVirtualizer.measureElement}
              style={{
                position: 'absolute',
                transform: `translateY(${virtualRow.start}px)`,
                width: '100%',
              }}
              virtualIndex={virtualRow.index}
              nextAiInputTokens={nextInputTokensByIndex.get(virtualRow.index)}
            />
          );
        })}
      </ol>
    </div>
  );
}

export function BrowserChatLogDialog({
  entries,
  messageContent,
  onClose,
  summaryEntries,
}: {
  entries: BrowserChatLogDialogRecord[];
  messageContent?: string;
  onClose: () => void;
  summaryEntries: BrowserChatLogDialogRecord[];
}) {
  const { t } = useI18n();
  useEscapeDismiss(true, onClose);
  const summary = summarizeBrowserChatLogs(entries);
  const totals = summarizeBrowserChatExecutionTotals(summaryEntries);
  return (
    <div className="ui-modal-overlay" onClick={onClose} role="presentation">
      <section aria-labelledby="browser-chat-log-dialog-title" aria-modal="true" className="ui-modal ui-modal--wide" onClick={(event) => event.stopPropagation()} role="dialog">
        <header className="ui-modal-header">
          <div className="ui-modal-heading">
            <h2 className="ui-modal-title" id="browser-chat-log-dialog-title">{t('执行日志')}</h2>
            <p className="ui-modal-subtitle">{messageContent || t('当前 AI 消息')}</p>
          </div>
          <button className="ui-icon-button ui-modal-close" onClick={onClose} type="button" aria-label={t('关闭')}>
            <X size={18} />
          </button>
        </header>
        <div className="ui-modal-body browser-chat-log-modal-body">
        <div className="browser-chat-log-totals" aria-label={t('执行总计')}>
          <div>
            <span>{t('工具调用总计')}</span>
            <strong>{t('{count} 次调用', { count: totals.toolCallCount })}</strong>
          </div>
          <div>
            <span>{t('工具调用总耗时')}</span>
            <strong>{formatTotalElapsedMs(totals.toolElapsedMs)}</strong>
          </div>
          <div>
            <span>{t('AI 请求总耗时')}</span>
            <strong>{formatTotalElapsedMs(totals.aiRequestElapsedMs)}</strong>
          </div>
        </div>
        {entries.length ? (
          <div className="browser-chat-log-summary" aria-label={t('日志摘要')}>
            <span>AI {summary.ai}</span>
            <span>{t('上下文')} {summary.context}</span>
            <span>{t('截图')} {summary.screenshot}</span>
            <span>{t('总计')} {summary.total}</span>
          </div>
        ) : null}
        {entries.length ? (
          <BrowserChatVirtualLogList entries={entries} />
        ) : (
          <p className="browser-chat-log-empty">{t('暂无日志')}</p>
        )}
        </div>
      </section>
    </div>
  );
}
