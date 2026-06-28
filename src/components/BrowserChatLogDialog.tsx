'use client';

import { type CSSProperties, useRef } from 'react';
import { X } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { BrowserChatPayloadDetails } from '@/components/BrowserChatPayloadDetails';
import {
  isBrowserChatContextCompressionLog,
  isBrowserChatScreenshotPerformanceLog,
  summarizeBrowserChatLogs,
} from '@/components/browser-chat-log-model';
import { formatLogTime, formatToolPayload, parseJsonObjectText, phaseLabel } from '@/components/browser-chat-format';

export type BrowserChatLogDialogRecord = {
  details?: string;
  elapsedMs?: number;
  id: string;
  message: string;
  phase: string;
  stepIndex?: number;
  time: string;
};

function asRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNumber(value: unknown) {
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

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

function aiLogTimings(details?: Record<string, unknown>) {
  return asRecord(asRecord(details?.aiOutput)?.timings);
}

function formatElapsedMs(value: unknown) {
  const elapsedMs = finiteNumber(value);
  return elapsedMs === undefined ? undefined : `${Math.round(elapsedMs)}ms`;
}

function formatPostprocessTimings(value: unknown) {
  const timings = asRecord(value);
  if (!timings) return '';
  const fields = [
    'desktopBeforeMs',
    'desktopAfterMs',
    'notifyStartMs',
    'notifyResultMs',
    'visualAfterMs',
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

function aiLogTimingInline(log: BrowserChatLogDialogRecord) {
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
    tool ? `工具 ${tool}` : '',
    overhead && overhead !== '0ms' ? `后处理 ${overhead}` : '',
    total ? `总 ${total}` : '',
  ].filter(Boolean).join(' · ');
}

function aiLogTimingPayload(details?: Record<string, unknown>) {
  const timings = aiLogTimings(details);
  if (!timings) return '';
  const lines: string[] = [];
  const total = formatElapsedMs(timings.totalElapsedMs);
  if (total) lines.push(`总耗时: ${total}`);
  const ai = formatElapsedMs(timings.aiRequestElapsedMs);
  if (ai) lines.push(`AI 请求耗时: ${ai}`);
  const tool = formatElapsedMs(timings.toolElapsedMs);
  if (tool) lines.push(`工具动作耗时: ${tool}`);
  const overhead = formatElapsedMs(timings.toolOverheadElapsedMs);
  if (overhead && overhead !== '0ms') lines.push(`工具后处理耗时: ${overhead}`);
  const other = formatElapsedMs(timings.otherElapsedMs);
  if (other && other !== '0ms') lines.push(`其他耗时: ${other}`);
  const toolCount = finiteNumber(timings.toolCount);
  if (toolCount !== undefined) lines.push(`工具数量: ${toolCount}`);
  const tools = Array.isArray(timings.tools) ? timings.tools : [];
  if (tools.length) {
    lines.push('工具明细:');
    tools.forEach((toolItem, index) => {
      const record = asRecord(toolItem);
      if (!record) return;
      const name = stringValue(record.name) || `tool ${index + 1}`;
      const action = formatElapsedMs(record.actionElapsedMs) || formatElapsedMs(record.elapsedMs) || '-';
      const overhead = formatElapsedMs(record.overheadElapsedMs);
      const total = formatElapsedMs(record.traceElapsedMs);
      const parts = [`动作 ${action}`];
      if (overhead && overhead !== '0ms') parts.push(`后处理 ${overhead}`);
      if (total && total !== action) parts.push(`总计 ${total}`);
      const postprocess = formatPostprocessTimings(record.postprocessTimings);
      if (postprocess) parts.push(`明细 ${postprocess}`);
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

function BrowserChatLogDetails({ log }: { log: BrowserChatLogDialogRecord }) {
  if (!log.details) return null;
  const parsed = parseJsonObjectText(log.details);
  const isAiRequestLog = log.phase === 'ai:runtime:request';
  const isAiResponseLog = log.phase === 'ai:runtime:response' || log.phase === 'ai:runtime:object';
  const isConversationSummaryRequest = log.phase === 'conversation:context:request';
  const isConversationSummaryResponse = log.phase === 'conversation:context:response';
  if (!parsed) return null;
  const requestPayload = isAiRequestLog
    ? aiLogRequestPayload(parsed)
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
    ? aiLogResponsePayload(parsed)
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
  const timingPayload = isAiResponseLog ? aiLogTimingPayload(parsed) : '';
  const performancePayload = isBrowserChatScreenshotPerformanceLog(log) ? screenshotPerformancePayload(parsed) : '';
  if (!requestPayload && !responsePayload && !timingPayload && !performancePayload) return null;
  return (
    <div className="browser-chat-log-details">
      <BrowserChatPayloadDetails className="browser-chat-log-detail-block is-timing" payload={timingPayload} title="耗时明细" />
      <BrowserChatPayloadDetails className="browser-chat-log-detail-block" payload={requestPayload} title="AI input JSON" />
      <BrowserChatPayloadDetails className="browser-chat-log-detail-block is-response" payload={responsePayload} title="AI output JSON" />
      <BrowserChatPayloadDetails className="browser-chat-log-detail-block is-performance" payload={performancePayload} title="Screenshot performance" />
    </div>
  );
}

const logVirtualRowEstimate = 104;

function BrowserChatLogEntry({
  log,
  measureRef,
  style,
  virtualIndex,
}: {
  log: BrowserChatLogDialogRecord;
  measureRef?: (node: HTMLLIElement | null) => void;
  style?: CSSProperties;
  virtualIndex?: number;
}) {
  const compressionLabel = contextCompressionLabel(log);
  const timingLabel = aiLogTimingInline(log);
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
          <strong>{compressionLabel}</strong>
          <span>--------------------------</span>
        </div>
      ) : null}
      <span>{phaseLabel(log.phase)}</span>
      <div>
        <strong>{log.message}</strong>
        <small>
          {formatLogTime(log.time)}
          {log.stepIndex ? ` · 步骤 ${log.stepIndex}` : ''}
          {timingLabel ? ` ? ${timingLabel}` : typeof log.elapsedMs === 'number' ? ` ? ${log.elapsedMs}ms` : ''}
        </small>
        <BrowserChatLogDetails log={log} />
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
}: {
  entries: BrowserChatLogDialogRecord[];
  messageContent?: string;
  onClose: () => void;
}) {
  const summary = summarizeBrowserChatLogs(entries);
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <section className="browser-chat-log-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="执行日志">
        <header>
          <div>
            <h2>执行日志</h2>
            <p>{messageContent || '当前 AI 消息'}</p>
          </div>
          <button className="icon-button" onClick={onClose} type="button" aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        {entries.length ? (
          <div className="browser-chat-log-summary" aria-label="log summary">
            <span>AI {summary.ai}</span>
            <span>Context {summary.context}</span>
            <span>Screenshot {summary.screenshot}</span>
            <span>Total {summary.total}</span>
          </div>
        ) : null}
        {entries.length ? (
          <BrowserChatVirtualLogList entries={entries} />
        ) : (
          <p className="browser-chat-log-empty">暂无日志</p>
        )}
      </section>
    </div>
  );
}
