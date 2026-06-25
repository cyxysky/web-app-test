'use client';

import { memo, type CSSProperties, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent, type RefObject, useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
  AppWindow,
  BadgeCheck,
  Bot,
  Braces,
  Bug,
  ChevronDown,
  ClipboardCheck,
  Compass,
  CornerDownLeft,
  FileSearch,
  Folder,
  GalleryHorizontalEnd,
  Gauge,
  ImageUp,
  Loader2,
  Maximize2,
  MessageSquare,
  MousePointer2,
  Network,
  PanelLeft,
  PencilLine,
  Plus,
  Power,
  RefreshCw,
  Route,
  ScanSearch,
  ScrollText,
  Send,
  SendHorizontal,
  Settings,
  SlidersHorizontal,
  Sparkles,
  FilePlus2,
  SquareArrowOutUpRight,
  SquareTerminal,
  Square,
  Trash2,
  Waypoints,
  Workflow,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CustomSelect } from '@/components/CustomSelect';
import { DashboardGroupSidebar, DashboardWorkspace, groupPath } from '@/components/DashboardWorkspace';
import { EnvironmentSettings, environmentSettingsTabs } from '@/components/EnvironmentSettings';
import { defaultModelByProvider, modelProviderDefinitions, type SettingsTab } from '@/config/settings';
import { useI18n } from '@/i18n/I18nProvider';
import { domTreeFromToolCall, fullDomSnapshotFromToolCall } from '@/lib/ai-request-inspection';
import { artifactApiUrl as artifactUrl } from '@/lib/artifacts';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';
import { subscribeRealtimeRefresh } from '@/lib/realtime-refresh';
import type {
  ModelConfigRecord,
  ModelProvider,
  RunScheduleRecord,
  SkillRecord,
  StepExecutionResult,
  TestCaseRecord,
  TestGroupRecord,
} from '@/server/ai/schemas/test-case.schema';

type BrowserChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  updatedAt?: string;
  clientMessageId?: string;
  attachments?: BrowserChatAttachment[];
  skillIds?: string[];
  stepIndexes?: number[];
  activity?: {
    phase: string;
    label: string;
    updatedAt: string;
  };
  status?: 'running' | 'passed' | 'failed' | 'blocked' | 'interrupted';
};

type BrowserChatAttachment = {
  id: string;
  name: string;
  type: string;
  size?: number;
  path: string;
  url: string;
};

type BrowserChatLogRecord = {
  id: string;
  time: string;
  phase: string;
  message: string;
  details?: string;
  messageId?: string;
  stepIndex?: number;
  elapsedMs?: number;
};

type BrowserChatToolConfirmation = {
  id: string;
  messageId: string;
  stepIndex?: number;
  toolName: string;
  reason?: string;
  prompt: string;
  requestedAt: string;
};

type BrowserChatToolConfirmationAction = 'confirm' | 'cancel';

type BrowserChatSession = {
  id: string;
  title: string;
  targetUrl: string;
  mode: BrowserChatMode;
  safetyMode: BrowserChatSafetyMode;
  modelProvider: ModelProvider;
  status: 'idle' | 'running' | 'closed' | 'error';
  busy: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  messages: BrowserChatMessage[];
  steps: StepExecutionResult[];
  consoleErrors: string[];
  networkErrors: string[];
  logs: BrowserChatLogRecord[];
  pendingToolConfirmation?: BrowserChatToolConfirmation;
  error?: string;
};

type BrowserChatView = 'chat' | 'target' | 'settings';
type BrowserChatMode = 'dom' | 'visual-markers';
type BrowserChatSafetyMode = 'strict' | 'full';
type BrowserChatModelConfig = Pick<ModelConfigRecord, 'provider' | 'providers' | 'updatedAt'>;
type BrowserChatToolCall = NonNullable<StepExecutionResult['tools']>[number];
type BrowserChatToolDetail = {
  stepIndex: number;
  step: StepExecutionResult;
  toolIndex: number;
  tool: BrowserChatToolCall;
};

type EmbeddedBrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type EmbeddedBrowserBridgeResult = {
  ok: boolean;
  error?: string;
};

type EmbeddedBrowserTab = {
  groupId?: string;
  id: string;
  sessionId?: string;
  title: string;
  url: string;
  loading?: boolean;
};

type EmbeddedBrowserGroup = {
  active?: boolean;
  activeTabId?: string;
  id: string;
  sessionId?: string;
  tabs: EmbeddedBrowserTab[];
};

type EmbeddedBrowserState = EmbeddedBrowserBridgeResult & {
  activeGroupId?: string;
  activeIndex?: number;
  activeTabId?: string;
  groups?: EmbeddedBrowserGroup[];
  tabs?: EmbeddedBrowserTab[];
  zoomFactor?: number;
};

type EmbeddedBrowserBridge = {
  activateTab: (input: { id: string }) => Promise<EmbeddedBrowserState>;
  closeActiveTab: () => Promise<EmbeddedBrowserBridgeResult>;
  closeGroup: (input: { id: string }) => Promise<EmbeddedBrowserState>;
  closeTab: (input: { id: string }) => Promise<EmbeddedBrowserState>;
  createTab: (input: { groupId?: string; sessionId?: string }) => Promise<EmbeddedBrowserState>;
  getState: () => Promise<EmbeddedBrowserState>;
  moveTab: (input: { id: string; position: 'before' | 'after'; targetId: string }) => Promise<EmbeddedBrowserState>;
  navigate: (input: { sessionId?: string; url: string }) => Promise<EmbeddedBrowserBridgeResult>;
  reset: () => Promise<EmbeddedBrowserBridgeResult>;
  setBounds: (bounds: EmbeddedBrowserBounds) => Promise<EmbeddedBrowserBridgeResult>;
  setVisible: (input: {
    bounds?: EmbeddedBrowserBounds;
    createIfMissing?: boolean;
    groupId?: string;
    id?: string;
    sessionId?: string;
    url?: string;
    visible: boolean;
  }) => Promise<EmbeddedBrowserState>;
};

declare global {
  interface Window {
    webPilotEmbeddedBrowser?: EmbeddedBrowserBridge;
  }
}

type BrowserChatLogIndex = {
  byMessageId: Map<string, BrowserChatLogRecord[]>;
  byStepIndex: Map<number, BrowserChatLogRecord[]>;
};

function statusLabel(status: string) {
  return status === 'running' ? '进行中' : '已完成';
}

function SettingsTabIcon({ tab }: { tab: SettingsTab }) {
  if (tab === 'model') return <Bot size={15} />;
  if (tab === 'browser') return <PanelLeft size={15} />;
  if (tab === 'runtime') return <SquareTerminal size={15} />;
  if (tab === 'skills') return <Braces size={15} />;
  if (tab === 'debug') return <Bug size={15} />;
  return <SlidersHorizontal size={15} />;
}

function compactText(value?: unknown, max = 160) {
  const text = stringFromUnknown(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function embeddedSessionGroupLabel(sessionId?: string) {
  const normalized = (sessionId || 'browser-session')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const parts = normalized.split('_');
  const shortId = (parts.at(-1) || normalized || 'session').slice(-6).toLowerCase();
  return `ai-${shortId}`;
}

function embeddedGroupIdForSession(sessionId?: string) {
  const normalized = (sessionId || '').trim();
  return normalized ? `session:${normalized}` : 'default';
}

function embeddedSessionIdFromGroupId(groupId?: string) {
  const normalized = (groupId || '').trim();
  return normalized.startsWith('session:') ? normalized.slice('session:'.length) : '';
}

function embeddedGroupIdForTab(tab: EmbeddedBrowserTab, fallbackGroupId: string) {
  if (tab.groupId) return tab.groupId;
  if (tab.sessionId) return embeddedGroupIdForSession(tab.sessionId);
  return fallbackGroupId;
}

function parseJsonObjectText(value?: string) {
  const text = (value || '').trim();
  if (!text || !text.startsWith('{') || !text.endsWith('}')) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function stripAnsiControlCodes(value: string) {
  return value.replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function formatToolPayload(value: unknown) {
  if (value === undefined || value === null || value === '') return '无';
  if (typeof value === 'string') return stripAnsiControlCodes(value);
  try {
    return stripAnsiControlCodes(JSON.stringify(value, null, 2));
  } catch {
    return stripAnsiControlCodes(String(value));
  }
}

const logVirtualRowEstimate = 104;

function BrowserChatLogEntry({ log, style, measureRef, virtualIndex }: {
  log: BrowserChatLogRecord;
  measureRef?: (node: HTMLLIElement | null) => void;
  style?: CSSProperties;
  virtualIndex?: number;
}) {
  return (
    <li
      className={contextCompressionLabel(log) ? 'has-context-compression' : ''}
      data-index={virtualIndex}
      ref={measureRef}
      style={style}
    >
      {contextCompressionLabel(log) ? (
        <div className="browser-chat-context-compression-marker">
          <span>--------------------------</span>
          <strong>{contextCompressionLabel(log)}</strong>
          <span>--------------------------</span>
        </div>
      ) : null}
      <span>{phaseLabel(log.phase)}</span>
      <div>
        <strong>{log.message}</strong>
        <small>
          {formatLogTime(log.time)}
          {log.stepIndex ? ` · 步骤 ${log.stepIndex}` : ''}
          {typeof log.elapsedMs === 'number' ? ` · ${log.elapsedMs}ms` : ''}
        </small>
        <BrowserChatLogDetails log={log} />
      </div>
    </li>
  );
}

function BrowserChatVirtualLogList({ entries }: { entries: BrowserChatLogRecord[] }) {
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

function asRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function aiLogRequestPayload(details?: Record<string, unknown>) {
  return details?.aiInput !== undefined ? formatToolPayload(details.aiInput) : '';
}

function aiLogResponsePayload(details?: Record<string, unknown>) {
  return details?.aiOutput !== undefined ? formatToolPayload(details.aiOutput) : '';
}

type BrowserChatAiOutputTool = {
  id: string;
  input?: unknown;
  name: string;
  reason?: string;
};

type BrowserChatAiOutputView = {
  reasoning: string[];
  texts: string[];
  tools: BrowserChatAiOutputTool[];
};

type BrowserChatAiOutputCycle = {
  id: string;
  output: BrowserChatAiOutputView;
  stepIndex?: number;
};

function stringFromUnknown(value: unknown): string {
  if (typeof value === 'string') return stripAnsiControlCodes(value).trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => stringFromUnknown(item))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return stringFromUnknown(record.text ?? record.content ?? record.reasoning);
  }
  return '';
}

function arrayFromUnknown(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function textFromAiContentPart(part: Record<string, unknown>) {
  return stringFromUnknown(part.text)
    || stringFromUnknown(part.content)
    || stringFromUnknown(part.reasoning);
}

function toolReasonFromInput(input: unknown) {
  const record = asRecord(input);
  return stringFromUnknown(record?.reason)
    || stringFromUnknown(record?.targetVisual)
    || stringFromUnknown(record?.url)
    || stringFromUnknown(record?.text)
    || stringFromUnknown(record?.action);
}

function normalizeAiContentPart(part: unknown): BrowserChatAiOutputView {
  const record = asRecord(part);
  if (!record) return { reasoning: [], texts: [], tools: [] };
  const type = String(record.type || '').toLowerCase();
  if (type === 'reasoning') {
    const text = textFromAiContentPart(record);
    return { reasoning: text ? [text] : [], texts: [], tools: [] };
  }
  if (type === 'text') {
    const text = textFromAiContentPart(record);
    return { reasoning: [], texts: text ? [text] : [], tools: [] };
  }
  if (type === 'tool-call' || type === 'tool_call') {
    const name = stringFromUnknown(record.toolName) || stringFromUnknown(record.name) || stringFromUnknown(record.tool);
    if (!name) return { reasoning: [], texts: [], tools: [] };
    const input = record.input ?? record.args ?? record.arguments;
    return {
      reasoning: [],
      texts: [],
      tools: [{
        id: stringFromUnknown(record.toolCallId) || stringFromUnknown(record.id) || name,
        input,
        name,
        reason: toolReasonFromInput(input),
      }],
    };
  }
  return { reasoning: [], texts: [], tools: [] };
}

function mergeAiOutputView(target: BrowserChatAiOutputView, source: BrowserChatAiOutputView) {
  target.reasoning.push(...source.reasoning);
  target.texts.push(...source.texts);
  target.tools.push(...source.tools);
}

function aiOutputViewFromContentParts(parts: unknown[]) {
  const output: BrowserChatAiOutputView = { reasoning: [], texts: [], tools: [] };
  for (const part of parts) {
    mergeAiOutputView(output, normalizeAiContentPart(part));
  }
  return output;
}

function aiOutputViewFromResponse(response: unknown) {
  const record = asRecord(response);
  if (!record) return { reasoning: [], texts: [], tools: [] };
  const output: BrowserChatAiOutputView = { reasoning: [], texts: [], tools: [] };
  mergeAiOutputView(output, aiOutputViewFromContentParts(arrayFromUnknown(record.content)));
  if (!output.reasoning.length && !output.texts.length) {
    const reasoningText = stringFromUnknown(record.reasoningText);
    if (reasoningText) output.reasoning.push(reasoningText);
    const text = stringFromUnknown(record.text);
    if (text) output.texts.push(text);
  }
  for (const toolCall of arrayFromUnknown(record.toolCalls)) {
    mergeAiOutputView(output, normalizeAiContentPart({ ...asRecord(toolCall), type: 'tool-call' }));
  }
  const steps = arrayFromUnknown(record.steps);
  if (steps.length && !output.reasoning.length && !output.tools.length) {
    mergeAiOutputView(output, aiOutputViewFromResponse(steps.at(-1)));
  }
  const result = asRecord(record.result);
  if (result && !output.reasoning.length && !output.tools.length && !output.texts.length) {
    mergeAiOutputView(output, aiOutputViewFromResponse(result));
  }
  return output;
}

function dedupeStrings(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function dedupeAiOutputTools(tools: BrowserChatAiOutputTool[]) {
  const seen = new Set<string>();
  return tools.filter((tool) => {
    const key = `${tool.name}:${formatToolPayload(tool.input)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compactAiOutputView(output: BrowserChatAiOutputView): BrowserChatAiOutputView {
  return {
    reasoning: dedupeStrings(output.reasoning),
    texts: dedupeStrings(output.texts),
    tools: dedupeAiOutputTools(output.tools),
  };
}

function hasAiOutputView(output: BrowserChatAiOutputView) {
  return Boolean(output.reasoning.length || output.texts.length || output.tools.length);
}

function aiOutputCyclesFromLogs(logs: BrowserChatLogRecord[]): BrowserChatAiOutputCycle[] {
  const cycles: BrowserChatAiOutputCycle[] = [];
  logs.forEach((log, index) => {
    if (log.phase !== 'ai:runtime:response' && log.phase !== 'ai:runtime:object') return;
    const parsed = parseJsonObjectText(log.details);
    const aiOutput = asRecord(parsed?.aiOutput);
    if (!aiOutput) return;
    const output = aiOutputViewFromResponse(aiOutput.response);
    const fallbackText = stringFromUnknown(aiOutput.text);
    if (fallbackText) output.texts.push(fallbackText);
    const compacted = compactAiOutputView(output);
    if (!hasAiOutputView(compacted)) return;
    cycles.push({
      id: log.id || `${log.phase}-${log.stepIndex || 0}-${index}`,
      output: compacted,
      stepIndex: log.stepIndex,
    });
  });
  return cycles;
}

function aiOutputTextSetFromCycles(cycles: BrowserChatAiOutputCycle[]) {
  return new Set(cycles.flatMap((cycle) => cycle.output.texts).map((text) => text.replace(/\s+/g, ' ').trim()));
}

function aiCycleToolKey(cycleId: string, toolIndex: number) {
  return `${cycleId}:${toolIndex}`;
}

function toolInputSignature(value: unknown) {
  return formatToolPayload(value).replace(/\s+/g, ' ').trim();
}

function buildAiCycleToolDetailMap(cycles: BrowserChatAiOutputCycle[], steps: StepExecutionResult[]) {
  const details = new Map<string, BrowserChatToolDetail>();
  const usedStepTools = new Set<string>();

  cycles.forEach((cycle) => {
    const candidateSteps = cycle.stepIndex
      ? steps.filter((step) => step.index === cycle.stepIndex)
      : steps;

    cycle.output.tools.forEach((aiTool, aiToolIndex) => {
      const exactInput = toolInputSignature(aiTool.input);
      let fallback: BrowserChatToolDetail | undefined;

      for (const step of candidateSteps) {
        const toolCalls = step.tools || [];
        for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex += 1) {
          const tool = toolCalls[toolIndex];
          if (!tool) continue;
          const usedKey = `${step.index}:${toolIndex}`;
          if (usedStepTools.has(usedKey) || tool.name !== aiTool.name) continue;

          const detail = { stepIndex: step.index, step, toolIndex, tool };
          if (!fallback) fallback = detail;
          if (!exactInput || toolInputSignature(tool.input) === exactInput) {
            details.set(aiCycleToolKey(cycle.id, aiToolIndex), detail);
            usedStepTools.add(usedKey);
            return;
          }
        }
      }

      if (fallback) {
        details.set(aiCycleToolKey(cycle.id, aiToolIndex), fallback);
        usedStepTools.add(`${fallback.step.index}:${fallback.toolIndex}`);
      }
    });
  });

  return details;
}

function isAiInputOutputLog(log: BrowserChatLogRecord) {
  return log.phase === 'ai:runtime:request'
    || log.phase === 'ai:runtime:response'
    || log.phase === 'ai:runtime:object'
    || log.phase === 'conversation:context:request'
    || log.phase === 'conversation:context:response';
}

function isContextCompressionLog(log: BrowserChatLogRecord) {
  return log.phase === 'ai:context-segmented'
    || log.phase === 'conversation:context:request'
    || log.phase === 'conversation:context:response'
    || log.phase === 'conversation:context:error';
}

function isScreenshotPerformanceLog(log: BrowserChatLogRecord) {
  const phase = log.phase.toLowerCase();
  return phase.startsWith('browser:screenshot:')
    || (phase.startsWith('perf:') && phase.includes('screenshot'));
}

function visibleExecutionLog(log: BrowserChatLogRecord) {
  return isAiInputOutputLog(log) || isContextCompressionLog(log) || isScreenshotPerformanceLog(log);
}

function contextCompressionLabel(log: BrowserChatLogRecord) {
  if (log.phase === 'ai:context-segmented') return 'Agent Loop 上下文在这里压缩';
  if (log.phase === 'conversation:context:request') return '历史对话上下文开始压缩';
  if (log.phase === 'conversation:context:response') return '历史对话上下文压缩完成';
  if (log.phase === 'conversation:context:error') return '历史对话上下文压缩失败';
  return '';
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

function BrowserChatLogDetails({ log }: { log: BrowserChatLogRecord }) {
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
  const performancePayload = isScreenshotPerformanceLog(log) ? screenshotPerformancePayload(parsed) : '';
  if (!requestPayload && !responsePayload && !performancePayload) return null;
  return (
    <div className="browser-chat-log-details">
      {requestPayload ? (
        <section className="browser-chat-log-detail-block">
          <strong>AI input JSON</strong>
          <pre>{requestPayload}</pre>
        </section>
      ) : null}
      {responsePayload ? (
        <section className="browser-chat-log-detail-block is-response">
          <strong>AI output JSON</strong>
          <pre>{responsePayload}</pre>
        </section>
      ) : null}
      {performancePayload ? (
        <section className="browser-chat-log-detail-block is-performance">
          <strong>Screenshot performance</strong>
          <pre>{performancePayload}</pre>
        </section>
      ) : null}
    </div>
  );
}

function toolStatusLabel(tool: BrowserChatToolCall) {
  if (tool.ok === true) return '完成';
  if (tool.ok === false) return '失败';
  return '运行中';
}

function toolStringValue(value: unknown) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function toolInputValue(record: Record<string, unknown> | undefined, keys: string[]) {
  if (!record) return '';
  for (const key of keys) {
    const value = toolStringValue(record[key]);
    if (value) return value;
  }
  return '';
}

function summarizeToolFields(fields: unknown) {
  if (!Array.isArray(fields) || !fields.length) return '';
  const textValues = fields
    .map((field) => toolInputValue(asRecord(field), ['text', 'value', 'content']))
    .filter(Boolean);
  if (fields.length === 1) return textValues[0] || '1 项';
  return `${fields.length} 项${textValues[0] ? `，${textValues[0]}` : ''}`;
}

function browserChatToolLabel(name: string, t: (value: string) => string) {
  const labels: Record<string, string> = {
    clickCandidate: '点选目标',
    clickDomNode: '点选节点',
    clickLocator: '点选定位器',
    doubleClickCandidate: '双击目标',
    doubleClickDomNode: '双击节点',
    dragCandidate: '拖拽元素',
    dragDomNode: '拖拽节点',
    fillCandidates: '填写表单',
    fillDomNodes: '填写节点',
    findByText: '定位文本',
    getDomNodeText: '读取节点',
    getHttpRequests: '检查请求',
    hoverDomNode: '悬停节点',
    listTabs: '扫描标签页',
    manageVisualContext: '整理视觉上下文',
    openPage: '导航页面',
    pressKey: '发送按键',
    reportState: '确认状态',
    rightClickCandidate: '右键目标',
    scrollArea: '移动视窗',
    selectReferenceScreenshots: '引用截图',
    switchTab: '切换标签',
    typeText: '键入内容',
    waitForHumanVerification: '等待人工验证',
    waitForPage: '等待页面稳定',
  };
  if (labels[name]) return t(labels[name]);

  const lower = name.toLowerCase();
  if (lower.includes('screenshot') || lower.includes('capture')) return t('截屏取证');
  if (lower.includes('snapshot') || lower.includes('context')) return t('读取页面状态');
  if (lower.includes('clickat') || lower.includes('coordinate')) return t('点选坐标');
  if (lower.includes('click')) return t('点选目标');
  if (lower.includes('fill') || lower.includes('type')) return t('键入内容');
  if (lower.includes('hover')) return t('悬停元素');
  if (lower.includes('drag')) return t('拖拽元素');
  if (lower.includes('scroll')) return t('移动视窗');
  if (lower.includes('wait')) return t('等待页面稳定');
  if (lower.includes('open') || lower.includes('page')) return t('导航页面');
  if (lower.includes('request')) return t('检查请求');
  if (lower.includes('report') || lower.includes('state')) return t('确认状态');
  return name;
}

function browserChatToolMeta(name: string, input: unknown) {
  const record = asRecord(input);
  if (!record) return toolStringValue(input);

  const lower = name.toLowerCase();
  if (name === 'typeText') return toolInputValue(record, ['text', 'content', 'value']);
  if (name === 'pressKey') return toolInputValue(record, ['key']);
  if (name === 'openPage') return toolInputValue(record, ['url']);
  if (name === 'switchTab') return toolInputValue(record, ['index']);
  if (name === 'waitForPage') return toolInputValue(record, ['ms']);
  if (name === 'waitForHumanVerification') return toolInputValue(record, ['maxMs']);
  if (name === 'scrollArea') {
    const area = toolInputValue(record, ['areaId']);
    const deltaY = toolInputValue(record, ['deltaY']);
    return [area, deltaY ? `Y ${deltaY}` : ''].filter(Boolean).join(' · ');
  }
  if (name === 'selectReferenceScreenshots') {
    const ids = Array.isArray(record.ids) ? record.ids : [];
    return ids.length ? `${ids.length} 张` : '';
  }
  if (name === 'manageVisualContext') return toolInputValue(record, ['action', 'manageReason']);
  if (name === 'reportState') return toolInputValue(record, ['action', 'actual', 'status']);
  if (lower.includes('fill')) return summarizeToolFields(record.fields) || toolInputValue(record, ['text', 'content', 'value']);
  if (lower.includes('click') || lower.includes('hover') || lower.includes('drag')) {
    return toolInputValue(record, ['text', 'targetVisual', 'targetText', 'id', 'locatorId', 'fromId']);
  }
  if (lower.includes('find')) return toolInputValue(record, ['targetText', 'scopeId']);
  if (lower.includes('text')) return toolInputValue(record, ['text', 'targetText', 'id']);
  return toolInputValue(record, ['url', 'text', 'targetVisual', 'targetText', 'id', 'areaId', 'action', 'status']);
}

function BrowserChatToolIcon({ name }: { name: string }) {
  const lower = name.toLowerCase();
  if (lower.includes('screenshot') || lower.includes('capture')) return <GalleryHorizontalEnd size={13} />;
  if (lower.includes('snapshot') || lower.includes('context')) return <Braces size={13} />;
  if (lower.includes('type') || lower.includes('fill')) return <PencilLine size={13} />;
  if (lower.includes('press') || lower.includes('key')) return <CornerDownLeft size={13} />;
  if (lower.includes('clickat') || lower.includes('coordinate')) return <Compass size={13} />;
  if (lower.includes('click') || lower.includes('hover') || lower.includes('drag')) return <MousePointer2 size={13} />;
  if (lower.includes('request')) return <Network size={13} />;
  if (lower.includes('find') || lower.includes('dom')) return <FileSearch size={13} />;
  if (lower.includes('list')) return <ScanSearch size={13} />;
  if (lower.includes('report') || lower.includes('state')) return <BadgeCheck size={13} />;
  if (lower.includes('reference')) return <ClipboardCheck size={13} />;
  if (lower.includes('visual') || lower.includes('manage')) return <Waypoints size={13} />;
  if (lower.includes('scroll')) return <Route size={13} />;
  if (lower.includes('wait')) return <Gauge size={13} />;
  if (lower.includes('switch')) return <SendHorizontal size={13} />;
  if (lower.includes('open')) return <SquareArrowOutUpRight size={13} />;
  if (lower.includes('page') || lower.includes('tab')) return <AppWindow size={13} />;
  if (lower.includes('move')) return <Compass size={13} />;
  return <Workflow size={13} />;
}

function screenshotKindLabel(kind?: string) {
  if (kind === 'original') return '原始图';
  if (kind === 'marker') return '标识图';
  if (kind === 'current' || kind === 'pinned' || kind === 'after') return '操作后';
  if (kind === 'history') return '操作前';
  return '截图';
}

function temporaryId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeMode(value?: string): BrowserChatMode {
  return value === 'dom' ? 'dom' : 'visual-markers';
}

function normalizeSafetyMode(value?: string): BrowserChatSafetyMode {
  return value === 'full' ? 'full' : 'strict';
}

function normalizeModelProvider(value?: string): ModelProvider {
  const provider = String(value || '').trim().toLowerCase();
  if (provider === 'azure' || provider === 'azure-openai') return 'azure-openai';
  if (provider === 'codex' || provider === 'codex-cli') return 'codex';
  if (provider === 'gemini' || provider === 'gemini-cli') return 'google';
  if (provider === 'lm-studio' || provider === 'local') return 'lmstudio';
  return modelProviderDefinitions.some((item) => item.value === provider) ? provider as ModelProvider : 'openrouter';
}

function normalizeToolConfirmation(value?: BrowserChatToolConfirmation): BrowserChatToolConfirmation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const messageId = typeof value.messageId === 'string' ? value.messageId.trim() : '';
  const toolName = typeof value.toolName === 'string' ? value.toolName.trim() : '';
  const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : '';
  if (!id || !messageId || !toolName || !prompt) return undefined;
  return {
    id,
    messageId,
    stepIndex: typeof value.stepIndex === 'number' && Number.isFinite(value.stepIndex) ? Math.floor(value.stepIndex) : undefined,
    toolName,
    reason: typeof value.reason === 'string' && value.reason.trim() ? compactText(value.reason, 300) : undefined,
    prompt: compactText(prompt, 500),
    requestedAt: typeof value.requestedAt === 'string' ? value.requestedAt : '',
  };
}

function normalizeSession(session: BrowserChatSession): BrowserChatSession {
  return {
    ...session,
    consoleErrors: session.consoleErrors || [],
    logs: session.logs || [],
    messages: (session.messages || []).map((message) => ({
      ...message,
      attachments: message.attachments || [],
      content: stringFromUnknown(message.content),
      role: message.role === 'assistant' ? 'assistant' : 'user',
      stepIndexes: Array.isArray(message.stepIndexes) ? message.stepIndexes : [],
    })),
    mode: normalizeMode(session.mode),
    safetyMode: normalizeSafetyMode(session.safetyMode),
    modelProvider: normalizeModelProvider(session.modelProvider),
    networkErrors: session.networkErrors || [],
    pendingToolConfirmation: normalizeToolConfirmation(session.pendingToolConfirmation),
    steps: session.steps || [],
  };
}

function sessionSortTime(session: BrowserChatSession) {
  return session.updatedAt || session.createdAt || '';
}

function sessionTimeValue(session: BrowserChatSession) {
  const timestamp = Date.parse(sessionSortTime(session));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isOlderSessionSnapshot(incoming: BrowserChatSession, existing?: BrowserChatSession | null) {
  if (!existing || incoming.id !== existing.id) return false;
  const incomingTime = sessionTimeValue(incoming);
  const existingTime = sessionTimeValue(existing);
  if (incomingTime < existingTime) return true;
  if (incomingTime > existingTime) return false;
  return (incoming.messages?.length || 0) < (existing.messages?.length || 0)
    || (incoming.steps?.length || 0) < (existing.steps?.length || 0)
    || (incoming.logs?.length || 0) < (existing.logs?.length || 0);
}

function sessionDisplayTitle(session: BrowserChatSession) {
  const firstUserMessage = session.messages.find((item) => item.role === 'user')?.content;
  return compactText(firstUserMessage || '新对话', 38);
}

function formatLogTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function buildBrowserChatLogIndex(logs: BrowserChatLogRecord[]): BrowserChatLogIndex {
  const byMessageId = new Map<string, BrowserChatLogRecord[]>();
  const byStepIndex = new Map<number, BrowserChatLogRecord[]>();

  for (const log of logs) {
    if (log.messageId) {
      const entries = byMessageId.get(log.messageId) || [];
      entries.push(log);
      byMessageId.set(log.messageId, entries);
      continue;
    }
    if (typeof log.stepIndex === 'number') {
      const entries = byStepIndex.get(log.stepIndex) || [];
      entries.push(log);
      byStepIndex.set(log.stepIndex, entries);
    }
  }

  return { byMessageId, byStepIndex };
}

function browserChatLogsForMessage(message: BrowserChatMessage, logIndex: BrowserChatLogIndex) {
  const directLogs = logIndex.byMessageId.get(message.id) || [];
  const stepLogs = (message.stepIndexes || []).flatMap((stepIndex) => logIndex.byStepIndex.get(stepIndex) || []);
  return directLogs.length || stepLogs.length ? [...directLogs, ...stepLogs] : [];
}

function messageUpdateTime(message: BrowserChatMessage) {
  return message.updatedAt || message.createdAt;
}

function phaseLabel(phase: string) {
  if (phase.startsWith('browser:')) return '浏览器';
  if (phase.startsWith('ai:')) return 'AI';
  if (phase.startsWith('chat:')) return '对话';
  if (phase.startsWith('perf:')) return '性能';
  return phase;
}

function normalizeMarkdownSegment(value: string) {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/([。！？；;])\s+(?=\*\*[^*\n]{1,40}\*\*\s*[:：])/g, '$1\n\n')
    .replace(/([:：。！？；;])\s+-\s+/g, '$1\n- ')
    .replace(/\n{3,}/g, '\n\n');
}

function normalizeChatMarkdown(markdown: string) {
  return markdown
    .split(/(```[\s\S]*?```)/g)
    .map((part) => (part.startsWith('```') ? part : normalizeMarkdownSegment(part)))
    .join('')
    .trim();
}

const BrowserChatMarkdown = memo(function BrowserChatMarkdown({ markdown }: { markdown: string }) {
  const normalizedMarkdown = useMemo(() => normalizeChatMarkdown(markdown), [markdown]);
  return (
    <div className="browser-chat-agent-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {normalizedMarkdown}
      </ReactMarkdown>
    </div>
  );
});

function formatAttachmentSize(size?: number) {
  if (!size || !Number.isFinite(size)) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / 1024 / 102.4) / 10} MB`;
}

const BrowserChatImageGrid = memo(function BrowserChatImageGrid({
  attachments,
  editable = false,
  onPreview,
  onRemove,
}: {
  attachments?: BrowserChatAttachment[];
  editable?: boolean;
  onPreview: (attachment: BrowserChatAttachment) => void;
  onRemove?: (id: string) => void;
}) {
  if (!attachments?.length) return null;
  return (
    <div className={editable ? 'browser-chat-image-grid editable' : 'browser-chat-image-grid'}>
      {attachments.map((attachment) => (
        <figure className="browser-chat-image-thumb" key={attachment.id}>
          <button
            aria-label={`放大查看 ${attachment.name}`}
            className="browser-chat-image-preview-button"
            onClick={() => onPreview(attachment)}
            type="button"
          >
            <img alt={attachment.name} src={attachment.url} />
            <span><Maximize2 size={13} /></span>
          </button>
          <figcaption>
            <span>{compactText(attachment.name, 34)}</span>
            {formatAttachmentSize(attachment.size) ? <small>{formatAttachmentSize(attachment.size)}</small> : null}
          </figcaption>
          {editable && onRemove ? (
            <button
              aria-label={`删除 ${attachment.name}`}
              className="browser-chat-image-remove"
              onClick={() => onRemove(attachment.id)}
              type="button"
            >
              <X size={13} />
            </button>
          ) : null}
        </figure>
      ))}
    </div>
  );
});

function pendingConfirmationForTool(input: {
  pending?: BrowserChatToolConfirmation;
  stepIndex?: number;
  toolName: string;
  toolOk?: boolean;
}) {
  const { pending, stepIndex, toolName, toolOk } = input;
  if (!pending || toolOk !== undefined) return undefined;
  if (pending.toolName !== toolName) return undefined;
  if (pending.stepIndex !== undefined && stepIndex !== pending.stepIndex) return undefined;
  return pending;
}

function toolUserActionForTool(logs: BrowserChatLogRecord[], stepIndex: number | undefined, toolName: string) {
  if (stepIndex === undefined) return undefined;
  for (const log of [...logs].reverse()) {
    if (log.stepIndex !== stepIndex) continue;
    if (log.phase !== 'tool:confirmation:confirmed' && log.phase !== 'tool:confirmation:cancelled') continue;
    const details = parseJsonObjectText(log.details);
    const loggedToolName = typeof details?.toolName === 'string' ? details.toolName : '';
    if (loggedToolName && loggedToolName !== toolName) continue;
    return log.phase === 'tool:confirmation:confirmed'
      ? { className: 'is-confirmed', label: '用户已确认' }
      : { className: 'is-cancelled', label: '用户已取消' };
  }
  return undefined;
}

function BrowserChatToolUserActionTag({ action }: { action?: ReturnType<typeof toolUserActionForTool> }) {
  if (!action) return null;
  return <span className={`browser-chat-tool-user-action-tag ${action.className}`}>{action.label}</span>;
}

const BrowserChatToolConfirmationActions = memo(function BrowserChatToolConfirmationActions({
  pending,
  resolvingConfirmationAction,
  resolvingConfirmationId,
  onResolveToolConfirmation,
}: {
  pending?: BrowserChatToolConfirmation;
  resolvingConfirmationAction?: BrowserChatToolConfirmationAction | null;
  resolvingConfirmationId?: string | null;
  onResolveToolConfirmation?: (confirmationId: string, action: BrowserChatToolConfirmationAction) => void | Promise<void>;
}) {
  if (!pending || !onResolveToolConfirmation) return null;
  const resolving = resolvingConfirmationId === pending.id;
  const resolvingConfirm = resolving && resolvingConfirmationAction === 'confirm';
  const resolvingCancel = resolving && resolvingConfirmationAction === 'cancel';
  return (
    <div className="browser-chat-tool-confirmation" role="group" aria-label="工具调用确认">
      <span>{pending.prompt}</span>
      <div className="browser-chat-tool-confirmation-actions">
        <button
          className="browser-chat-tool-confirm"
          disabled={resolving}
          onClick={() => void onResolveToolConfirmation(pending.id, 'confirm')}
          type="button"
        >
          {resolvingConfirm ? <Loader2 className="spin" size={13} /> : <BadgeCheck size={13} />}
          {resolvingConfirm ? '确认中' : '确认'}
        </button>
        <button
          className="browser-chat-tool-cancel"
          disabled={resolving}
          onClick={() => void onResolveToolConfirmation(pending.id, 'cancel')}
          type="button"
        >
          {resolvingCancel ? <Loader2 className="spin" size={13} /> : <X size={13} />}
          {resolvingCancel ? '取消中' : '取消'}
        </button>
      </div>
    </div>
  );
});

const BrowserChatStepToolCards = memo(function BrowserChatStepToolCards({
  logs,
  onSelectTool,
  onResolveToolConfirmation,
  onlyPendingConfirmation = false,
  pendingToolConfirmation,
  resolvingConfirmationAction,
  resolvingConfirmationId,
  running,
  step,
}: {
  logs: BrowserChatLogRecord[];
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  onResolveToolConfirmation?: (confirmationId: string, action: BrowserChatToolConfirmationAction) => void | Promise<void>;
  onlyPendingConfirmation?: boolean;
  pendingToolConfirmation?: BrowserChatToolConfirmation;
  resolvingConfirmationAction?: BrowserChatToolConfirmationAction | null;
  resolvingConfirmationId?: string | null;
  running: boolean;
  step: StepExecutionResult;
}) {
  const { t } = useI18n();
  const toolCalls = step.tools || [];
  if (!running && !toolCalls.length) return null;
  if (onlyPendingConfirmation && !toolCalls.some((tool) => pendingConfirmationForTool({
    pending: pendingToolConfirmation,
    stepIndex: step.index,
    toolName: tool.name,
    toolOk: tool.ok,
  }))) return null;
  if (running && !toolCalls.length) {
    if (onlyPendingConfirmation) return null;
    return (
      <div className="browser-chat-tool-card is-waiting">
        <span className="browser-chat-tool-icon" aria-hidden="true">
          <Loader2 className="spin" size={13} />
        </span>
        <span className="browser-chat-tool-content">
          <span className="browser-chat-tool-label">
            <span className="browser-chat-tool-name">准备工具</span>
            <span className="browser-chat-tool-state">运行中</span>
          </span>
          <small className="browser-chat-tool-meta">正在选择下一步浏览器动作</small>
        </span>
      </div>
    );
  }

  return (
    <>
      {toolCalls.map((tool, toolIndex) => {
        const label = browserChatToolLabel(tool.name, t);
        const meta = compactText(browserChatToolMeta(tool.name, tool.input), 56);
        const status = toolStatusLabel(tool);
        const displayText = `${label}${meta ? `: ${meta}` : ''}`;
        const stateClass = tool.ok === false ? ' is-failed' : tool.ok === undefined ? ' is-running' : '';
        const pendingConfirmation = pendingConfirmationForTool({
          pending: pendingToolConfirmation,
          stepIndex: step.index,
          toolName: tool.name,
          toolOk: tool.ok,
        });
        if (onlyPendingConfirmation && !pendingConfirmation) return null;
        const userAction = toolUserActionForTool(logs, step.index, tool.name);
        return (
          <div className="browser-chat-tool-call" key={`${step.index}-${toolIndex}-${tool.name}`}>
            {tool.reason ? <p className="browser-chat-tool-reason">{tool.reason}</p> : null}
            <button
              aria-label={`${displayText}，${status}`}
              className={`browser-chat-tool-card${stateClass}`}
              onClick={() => onSelectTool({ stepIndex: step.index, step, toolIndex, tool })}
              title={`${displayText} · ${status}`}
              type="button"
            >
              <span className="browser-chat-tool-icon" aria-hidden="true">
                <BrowserChatToolIcon name={tool.name} />
              </span>
              <span className="browser-chat-tool-content">
                <span className="browser-chat-tool-label">
                  <span className="browser-chat-tool-name">{label}</span>
                  <BrowserChatToolUserActionTag action={userAction} />
                </span>
                {meta ? <small className="browser-chat-tool-meta">{meta}</small> : null}
              </span>
            </button>
            <BrowserChatToolConfirmationActions
              pending={pendingConfirmation}
              resolvingConfirmationAction={resolvingConfirmationAction}
              resolvingConfirmationId={resolvingConfirmationId}
              onResolveToolConfirmation={onResolveToolConfirmation}
            />
          </div>
        );
      })}
    </>
  );
});

const BrowserChatAiCycleLine = memo(function BrowserChatAiCycleLine({
  cycle,
  logs,
  onResolveToolConfirmation,
  onSelectTool,
  pendingToolConfirmation,
  resolvingConfirmationAction,
  resolvingConfirmationId,
  toolDetails,
}: {
  cycle: BrowserChatAiOutputCycle;
  logs: BrowserChatLogRecord[];
  onResolveToolConfirmation?: (confirmationId: string, action: BrowserChatToolConfirmationAction) => void | Promise<void>;
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  pendingToolConfirmation?: BrowserChatToolConfirmation;
  resolvingConfirmationAction?: BrowserChatToolConfirmationAction | null;
  resolvingConfirmationId?: string | null;
  toolDetails: Map<string, BrowserChatToolDetail>;
}) {
  const { output } = cycle;
  if (!hasAiOutputView(output)) return null;
  const firstTool = output.tools[0];
  const firstToolLabel = firstTool ? browserChatToolLabel(firstTool.name, (value) => value) : '';
  const firstToolMeta = firstTool ? browserChatToolMeta(firstTool.name, firstTool.input) || firstTool.reason : '';
  const toolTitle = compactText([firstToolLabel, firstToolMeta].filter(Boolean).join(': '), 160);
  const toolSummary = output.tools.length === 1 ? '执行一个工具' : `执行 ${output.tools.length} 个工具`;
  const hasPendingConfirmation = output.tools.some((tool, index) => {
    const toolDetail = toolDetails.get(aiCycleToolKey(cycle.id, index));
    return Boolean(pendingConfirmationForTool({
      pending: pendingToolConfirmation,
      stepIndex: toolDetail?.stepIndex ?? cycle.stepIndex,
      toolName: tool.name,
      toolOk: toolDetail?.tool.ok,
    }));
  });
  return (
    <div className="browser-chat-ai-cycle">
      {output.reasoning.length ? (
        <details className="browser-chat-ai-line-collapse">
          <summary className="browser-chat-ai-collapse-summary">
            <Sparkles size={14} />
            <span>思维链</span>
            <ChevronDown className="browser-chat-ai-tool-chevron" size={14} />
          </summary>
          <div className="browser-chat-ai-reasoning-text">
            {output.reasoning.map((item, index) => (
              <p key={`${index}-${item.slice(0, 16)}`}>{item}</p>
            ))}
          </div>
        </details>
      ) : null}
      {output.tools.length ? (
        <details className="browser-chat-ai-line-collapse" open={hasPendingConfirmation || undefined}>
          <summary className="browser-chat-ai-collapse-summary" title={toolTitle}>
            <SquareTerminal size={14} />
            <span>{toolSummary}</span>
            <ChevronDown className="browser-chat-ai-tool-chevron" size={14} />
          </summary>
          <div className="browser-chat-ai-cycle-tools">
            {output.tools.map((tool, index) => {
              const label = browserChatToolLabel(tool.name, (value) => value);
              const meta = browserChatToolMeta(tool.name, tool.input) || tool.reason;
              const toolDetail = toolDetails.get(aiCycleToolKey(cycle.id, index));
              const stateClass = toolDetail?.tool.ok === false ? ' is-failed' : toolDetail?.tool.ok === undefined ? ' is-running' : '';
              const pendingConfirmation = pendingConfirmationForTool({
                pending: pendingToolConfirmation,
                stepIndex: toolDetail?.stepIndex ?? cycle.stepIndex,
                toolName: tool.name,
                toolOk: toolDetail?.tool.ok,
              });
              const userAction = toolUserActionForTool(logs, toolDetail?.stepIndex ?? cycle.stepIndex, tool.name);
              const card = (
                <>
                  <span className="browser-chat-tool-icon" aria-hidden="true">
                    <BrowserChatToolIcon name={tool.name} />
                  </span>
                  <span className="browser-chat-tool-content">
                    <span className="browser-chat-tool-label">
                      <span className="browser-chat-tool-name">{label}</span>
                      <BrowserChatToolUserActionTag action={userAction} />
                    </span>
                    {meta ? <small className="browser-chat-tool-meta">{compactText(meta, 150)}</small> : null}
                  </span>
                </>
              );
              return (
                <div className="browser-chat-tool-call" key={`${tool.id}-${index}`}>
                  {toolDetail ? (
                    <button
                      className={`browser-chat-tool-card browser-chat-ai-call-card${stateClass}`}
                      onClick={() => onSelectTool(toolDetail)}
                      title={`${label}${meta ? ` - ${meta}` : ''}`}
                      type="button"
                    >
                      {card}
                    </button>
                  ) : (
                    <div className="browser-chat-tool-card browser-chat-ai-call-card" title={`${label}${meta ? ` - ${meta}` : ''}`}>
                      {card}
                    </div>
                  )}
                  <BrowserChatToolConfirmationActions
                    pending={pendingConfirmation}
                    resolvingConfirmationAction={resolvingConfirmationAction}
                    resolvingConfirmationId={resolvingConfirmationId}
                    onResolveToolConfirmation={onResolveToolConfirmation}
                  />
                </div>
              );
            })}
          </div>
        </details>
      ) : null}
      {output.texts.length ? (
        <div className="browser-chat-ai-cycle-text">
          {output.texts.map((text, index) => (
            <BrowserChatMarkdown key={`${index}-${text.slice(0, 16)}`} markdown={text} />
          ))}
        </div>
      ) : null}
    </div>
  );
});

const BrowserChatAssistantTimeline = memo(function BrowserChatAssistantTimeline({
  logs,
  message,
  onResolveToolConfirmation,
  onSelectTool,
  pendingToolConfirmation,
  resolvingConfirmationAction,
  resolvingConfirmationId,
  running,
  steps,
}: {
  logs: BrowserChatLogRecord[];
  message: BrowserChatMessage;
  onResolveToolConfirmation?: (confirmationId: string, action: BrowserChatToolConfirmationAction) => void | Promise<void>;
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  pendingToolConfirmation?: BrowserChatToolConfirmation;
  resolvingConfirmationAction?: BrowserChatToolConfirmationAction | null;
  resolvingConfirmationId?: string | null;
  running: boolean;
  steps: StepExecutionResult[];
}) {
  const autoExpandedToolsRef = useRef(false);
  const [toolsExpanded, setToolsExpanded] = useState(() => running);
  const finalText = stringFromUnknown(message.content);
  const aiOutputCycles = useMemo(() => aiOutputCyclesFromLogs(logs), [logs]);
  const aiOutputTextSet = useMemo(() => aiOutputTextSetFromCycles(aiOutputCycles), [aiOutputCycles]);
  const aiCycleToolDetails = useMemo(() => buildAiCycleToolDetailMap(aiOutputCycles, steps), [aiOutputCycles, steps]);
  const seenTexts = new Set<string>();
  const toolCount = steps.reduce((count, step) => count + (step.tools || []).length, 0);
  const failedToolCount = steps.reduce((count, step) => count + (step.tools || []).filter((tool) => tool.ok === false).length, 0);
  const waitingForTool = running && steps.some((step) => step.status === 'running' && !(step.tools || []).length);
  const timelineSteps = steps.filter((step) => (step.tools || []).length || (running && step.status === 'running'));
  const hasPendingConfirmation = Boolean(pendingToolConfirmation);
  const aiCyclesContainPendingConfirmation = hasPendingConfirmation && aiOutputCycles.some((cycle) => (
    cycle.output.tools.some((tool, index) => {
      const toolDetail = aiCycleToolDetails.get(aiCycleToolKey(cycle.id, index));
      return Boolean(pendingConfirmationForTool({
        pending: pendingToolConfirmation,
        stepIndex: toolDetail?.stepIndex ?? cycle.stepIndex,
        toolName: tool.name,
        toolOk: toolDetail?.tool.ok,
      }));
    })
  ));
  const pendingTimelineSteps = hasPendingConfirmation
    ? steps.filter((step) => (step.tools || []).some((tool) => pendingConfirmationForTool({
      pending: pendingToolConfirmation,
      stepIndex: step.index,
      toolName: tool.name,
      toolOk: tool.ok,
    })))
    : [];
  const showPendingTimelineFallback = hasPendingConfirmation && !aiCyclesContainPendingConfirmation;
  const timelineStepsToRender = showPendingTimelineFallback ? pendingTimelineSteps : timelineSteps;
  const shouldShowStepTimeline = (!aiOutputCycles.length && (toolCount > 0 || waitingForTool))
    || (showPendingTimelineFallback && pendingTimelineSteps.length > 0);
  const hasFinalText = Boolean(finalText.trim());
  const toolSummary = failedToolCount
    ? failedToolCount === 1
      ? '工具调用失败'
      : `${failedToolCount} 个工具调用失败`
    : showPendingTimelineFallback
      ? '等待用户确认工具调用'
      : toolCount
        ? toolCount === 1
          ? `${running ? '正在执行' : '执行'}一个工具`
          : `${running ? '正在执行' : '执行'} ${toolCount} 个工具`
        : waitingForTool
          ? '准备工具'
          : '暂无工具';
  const renderText = (text: string, key: string) => {
    const normalized = text;
    if (!normalized || seenTexts.has(normalized)) return null;
    seenTexts.add(normalized);
    return (
      <BrowserChatMarkdown key={key} markdown={normalized} />
    );
  };

  useEffect(() => {
    if (showPendingTimelineFallback) {
      setToolsExpanded(true);
      return;
    }
    if (!running || !shouldShowStepTimeline || autoExpandedToolsRef.current) return;
    autoExpandedToolsRef.current = true;
    setToolsExpanded(true);
  }, [running, shouldShowStepTimeline, showPendingTimelineFallback]);

  return (
    <div className="browser-chat-agent-timeline">
      {aiOutputCycles.map((cycle) => (
        <BrowserChatAiCycleLine
          cycle={cycle}
          key={cycle.id}
          logs={logs}
          onResolveToolConfirmation={onResolveToolConfirmation}
          onSelectTool={onSelectTool}
          pendingToolConfirmation={pendingToolConfirmation}
          resolvingConfirmationAction={resolvingConfirmationAction}
          resolvingConfirmationId={resolvingConfirmationId}
          toolDetails={aiCycleToolDetails}
        />
      ))}
      {shouldShowStepTimeline ? (
        <div className="browser-chat-tool-stack">
          <button
            aria-expanded={toolsExpanded}
            className={`browser-chat-tool-summary${toolsExpanded ? ' is-expanded' : ''}${failedToolCount ? ' has-failed' : ''}`}
            onClick={() => setToolsExpanded((value) => !value)}
            type="button"
          >
            <SquareTerminal size={14} />
            <span>{toolSummary}</span>
            <ChevronDown className="browser-chat-tool-summary-chevron" size={14} />
          </button>
          {toolsExpanded ? timelineStepsToRender.map((step) => (
            <div className="browser-chat-agent-step" key={step.index}>
              <BrowserChatStepToolCards
                logs={logs}
                onResolveToolConfirmation={onResolveToolConfirmation}
                onSelectTool={onSelectTool}
                onlyPendingConfirmation={showPendingTimelineFallback}
                pendingToolConfirmation={pendingToolConfirmation}
                resolvingConfirmationAction={resolvingConfirmationAction}
                resolvingConfirmationId={resolvingConfirmationId}
                running={running && step.status === 'running'}
                step={step}
              />
            </div>
          )) : null}
        </div>
      ) : null}
      {hasFinalText && !aiOutputTextSet.has(finalText.replace(/\s+/g, ' ').trim()) ? renderText(finalText, 'final-text') : null}
      {!hasFinalText && !shouldShowStepTimeline ? (
        <p className="browser-chat-agent-empty">{running ? 'AI 正在处理当前请求。' : 'AI 已完成本轮操作，未返回额外文本。'}</p>
      ) : null}
    </div>
  );
});

const BrowserChatMessageItem = memo(function BrowserChatMessageItem({
  availableSkills,
  exportingMessageId,
  exportingSelectedMessages,
  generatingSkillMessageId,
  generatingSkillSelectedMessages,
  item,
  itemLogs,
  itemSteps,
  lastAssistantMessageId,
  onExportMessage,
  onGenerateSkill,
  onPreviewImage,
  onResolveToolConfirmation,
  onSelectTool,
  onShowLogs,
  onToggleExportSelection,
  pendingToolConfirmation,
  resolvingConfirmationAction,
  resolvingConfirmationId,
  selectedForExport,
  sessionBusy,
  totalStepCount,
}: {
  availableSkills: SkillRecord[];
  exportingMessageId: string | null;
  exportingSelectedMessages: boolean;
  generatingSkillMessageId: string | null;
  generatingSkillSelectedMessages: boolean;
  item: BrowserChatMessage;
  itemLogs: BrowserChatLogRecord[];
  itemSteps: StepExecutionResult[];
  lastAssistantMessageId?: string;
  onExportMessage: (messageId: string) => void | Promise<void>;
  onGenerateSkill: (messageId: string) => void | Promise<void>;
  onPreviewImage: (attachment: BrowserChatAttachment) => void;
  onResolveToolConfirmation?: (confirmationId: string, action: BrowserChatToolConfirmationAction) => void | Promise<void>;
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  onShowLogs: (messageId: string) => void;
  onToggleExportSelection: (messageId: string, selected: boolean) => void;
  pendingToolConfirmation?: BrowserChatToolConfirmation;
  resolvingConfirmationAction?: BrowserChatToolConfirmationAction | null;
  resolvingConfirmationId?: string | null;
  selectedForExport: boolean;
  sessionBusy: boolean;
  totalStepCount: number;
}) {
  const operationRunning = item.role === 'assistant' && (item.status === 'running' || Boolean(sessionBusy && item.id === lastAssistantMessageId));
  const operationLabel = operationRunning ? '进行中' : '已完成';
  const canExportMessage = item.role === 'assistant' && item.status !== 'running' && (itemSteps.length > 0 || totalStepCount > 0);
  const actionDisabled = Boolean(exportingMessageId || generatingSkillMessageId) || exportingSelectedMessages || generatingSkillSelectedMessages;
  const messageSkills = useMemo(() => {
    const byId = new Map(availableSkills.map((skill) => [skill.id, skill]));
    return Array.from(new Set(item.skillIds || [])).map((skillId) => {
      const skill = byId.get(skillId);
      return {
        id: skillId,
        title: skill?.title || skillId,
        description: skill?.description || 'Skill',
      };
    });
  }, [availableSkills, item.skillIds]);

  return (
    <article className={`browser-chat-message ${item.role}`}>
      <div>
        {item.role === 'assistant' ? (
          <>
            <div className="browser-chat-agent-meta">
              <span className="browser-chat-agent-status">
                {operationRunning ? <span aria-hidden="true" className="browser-chat-message-loading" /> : null}
                <span>{operationLabel}</span>
              </span>
              <time dateTime={messageUpdateTime(item)}>最后更新 {formatLogTime(messageUpdateTime(item))}</time>
            </div>
            <BrowserChatAssistantTimeline
              logs={itemLogs}
              message={item}
              onResolveToolConfirmation={onResolveToolConfirmation}
              onSelectTool={onSelectTool}
              pendingToolConfirmation={pendingToolConfirmation?.messageId === item.id ? pendingToolConfirmation : undefined}
              resolvingConfirmationAction={resolvingConfirmationAction}
              resolvingConfirmationId={resolvingConfirmationId}
              running={operationRunning}
              steps={itemSteps}
            />
          </>
        ) : (
          <>
            {item.content ?
              <p>
                {item.content}
                {messageSkills.length ? (
                  <span className="browser-chat-message-skills" aria-label="已选择 Skills">
                    {messageSkills.map((skill) => (
                      <span className="browser-chat-message-skill" key={skill.id} title={skill.description}>
                        <span>{skill.title}</span>
                      </span>
                    ))}
                  </span>
                ) : null}
              </p> : null}
            <BrowserChatImageGrid attachments={item.attachments} onPreview={onPreviewImage} />
            <time className="browser-chat-message-time" dateTime={messageUpdateTime(item)}>
              最后更新 {formatLogTime(messageUpdateTime(item))}
            </time>
          </>
        )}
        {item.role === 'assistant' ? (
          <div className="browser-chat-message-actions">
            {canExportMessage ? (
              <label className="browser-chat-message-select">
                <input
                  checked={selectedForExport}
                  disabled={actionDisabled}
                  onChange={(event) => onToggleExportSelection(item.id, event.currentTarget.checked)}
                  type="checkbox"
                />
                <span>选择</span>
              </label>
            ) : null}
            {itemLogs.length ? (
              <button className="browser-chat-log-button" onClick={() => onShowLogs(item.id)} type="button">
                <ScrollText size={14} />
                查看日志
              </button>
            ) : null}
            {canExportMessage ? (
              <button
                className="browser-chat-log-button"
                disabled={actionDisabled}
                onClick={() => void onGenerateSkill(item.id)}
                type="button"
              >
                {generatingSkillMessageId === item.id ? <Loader2 className="spin" size={14} /> : <Sparkles size={14} />}
                生成 Skill
              </button>
            ) : null}
            {canExportMessage ? (
              <button
                className="browser-chat-log-button"
                disabled={actionDisabled}
                onClick={() => void onExportMessage(item.id)}
                type="button"
              >
                {exportingMessageId === item.id ? <Loader2 className="spin" size={14} /> : <FilePlus2 size={14} />}
                导出用例
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
});

const BrowserChatMessageList = memo(function BrowserChatMessageList({
  availableSkills,
  exportingMessageId,
  exportingSelectedMessages,
  generatingSkillMessageId,
  generatingSkillSelectedMessages,
  lastAssistantMessageId,
  logIndex,
  messages,
  onBulkExportMessages,
  onBulkGenerateSkillMessages,
  onClearExportSelection,
  onExportMessage,
  onGenerateSkill,
  onPreviewImage,
  onResolveToolConfirmation,
  onSelectTool,
  onShowLogs,
  onToggleExportSelection,
  pendingToolConfirmation,
  resolvingConfirmationAction,
  resolvingConfirmationId,
  selectedExportMessageIdSet,
  selectedExportMessageIds,
  sessionId,
  sessionBusy,
  stepsByIndex,
  totalStepCount,
}: {
  availableSkills: SkillRecord[];
  exportingMessageId: string | null;
  exportingSelectedMessages: boolean;
  generatingSkillMessageId: string | null;
  generatingSkillSelectedMessages: boolean;
  lastAssistantMessageId?: string;
  logIndex: BrowserChatLogIndex;
  messages: BrowserChatMessage[];
  onBulkExportMessages: () => void | Promise<void>;
  onBulkGenerateSkillMessages: () => void | Promise<void>;
  onClearExportSelection: () => void;
  onExportMessage: (messageId: string) => void | Promise<void>;
  onGenerateSkill: (messageId: string) => void | Promise<void>;
  onPreviewImage: (attachment: BrowserChatAttachment) => void;
  onResolveToolConfirmation?: (confirmationId: string, action: BrowserChatToolConfirmationAction) => void | Promise<void>;
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  onShowLogs: (messageId: string) => void;
  onToggleExportSelection: (messageId: string, selected: boolean) => void;
  pendingToolConfirmation?: BrowserChatToolConfirmation;
  resolvingConfirmationAction?: BrowserChatToolConfirmationAction | null;
  resolvingConfirmationId?: string | null;
  selectedExportMessageIdSet: Set<string>;
  selectedExportMessageIds: string[];
  sessionId?: string;
  sessionBusy: boolean;
  stepsByIndex: Map<number, StepExecutionResult>;
  totalStepCount: number;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const actionDisabled = Boolean(exportingMessageId || generatingSkillMessageId) || exportingSelectedMessages || generatingSkillSelectedMessages;
  const lastMessage = messages[messages.length - 1];
  const scrollKey = [
    sessionId || '',
    messages.length,
    lastMessage?.id || '',
    lastMessage?.updatedAt || '',
    pendingToolConfirmation?.id || '',
    sessionBusy ? 'busy' : 'idle',
  ].join(':');

  useEffect(() => {
    let frame = 0;
    let nextFrame = 0;
    const scrollToBottom = () => {
      const container = scrollRef.current;
      if (!container) return;
      container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    };
    frame = requestAnimationFrame(() => {
      scrollToBottom();
      nextFrame = requestAnimationFrame(scrollToBottom);
    });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      if (nextFrame) cancelAnimationFrame(nextFrame);
    };
  }, [scrollKey]);

  return (
    <div className="browser-chat-message-list" ref={scrollRef}>
      {selectedExportMessageIds.length ? (
        <div className="browser-chat-message-export-bar">
          <span>已选 {selectedExportMessageIds.length} 轮</span>
          <button
            className="browser-chat-log-button"
            disabled={actionDisabled}
            onClick={() => void onBulkExportMessages()}
            type="button"
          >
            {exportingSelectedMessages ? <Loader2 className="spin" size={14} /> : <FilePlus2 size={14} />}
            导出为用例
          </button>
          <button
            className="browser-chat-log-button"
            disabled={actionDisabled}
            onClick={() => void onBulkGenerateSkillMessages()}
            type="button"
          >
            {generatingSkillSelectedMessages ? <Loader2 className="spin" size={14} /> : <Sparkles size={14} />}
            生成 Skill
          </button>
          <button
            className="browser-chat-log-button"
            disabled={actionDisabled}
            onClick={onClearExportSelection}
            type="button"
          >
            <X size={14} />
            清空
          </button>
        </div>
      ) : null}
      {messages.map((item) => {
        const itemSteps = (item.stepIndexes || [])
          .map((stepIndex) => stepsByIndex.get(stepIndex))
          .filter((step): step is StepExecutionResult => Boolean(step));
        const itemLogs = item.role === 'assistant' ? browserChatLogsForMessage(item, logIndex) : [];
        return (
          <BrowserChatMessageItem
            availableSkills={availableSkills}
            exportingMessageId={exportingMessageId}
            exportingSelectedMessages={exportingSelectedMessages}
            generatingSkillMessageId={generatingSkillMessageId}
            generatingSkillSelectedMessages={generatingSkillSelectedMessages}
            item={item}
            itemLogs={itemLogs}
            itemSteps={itemSteps}
            key={item.id}
            lastAssistantMessageId={lastAssistantMessageId}
            onExportMessage={onExportMessage}
            onGenerateSkill={onGenerateSkill}
            onPreviewImage={onPreviewImage}
            onResolveToolConfirmation={onResolveToolConfirmation}
            onSelectTool={onSelectTool}
            onShowLogs={onShowLogs}
            onToggleExportSelection={onToggleExportSelection}
            pendingToolConfirmation={pendingToolConfirmation}
            resolvingConfirmationAction={resolvingConfirmationAction}
            resolvingConfirmationId={resolvingConfirmationId}
            selectedForExport={selectedExportMessageIdSet.has(item.id)}
            sessionBusy={sessionBusy}
            totalStepCount={totalStepCount}
          />
        );
      })}
      <div aria-hidden="true" className="browser-chat-message-list-end" />
    </div>
  );
});

const BrowserChatComposer = memo(function BrowserChatComposer({
  attachments,
  availableSkills,
  busy,
  currentBusy,
  imageInputRef,
  interrupting,
  loading,
  mode,
  modeLocked,
  modelProvider,
  modelProviderOptions,
  safetyMode,
  onInterrupt,
  onModelProviderChange,
  onModeChange,
  onPreviewAttachment,
  onRemoveAttachment,
  onSubmitMessage,
  onSafetyModeChange,
  onUploadImages,
  resetToken,
  showStop,
  uploadingImage,
}: {
  attachments: BrowserChatAttachment[];
  availableSkills: SkillRecord[];
  busy: boolean;
  currentBusy: boolean;
  imageInputRef: RefObject<HTMLInputElement | null>;
  interrupting: boolean;
  loading: boolean;
  mode: BrowserChatMode;
  modeLocked: boolean;
  modelProvider: ModelProvider;
  modelProviderOptions: Array<{ label: string; value: string }>;
  safetyMode: BrowserChatSafetyMode;
  onInterrupt: () => void | Promise<void>;
  onModelProviderChange: (provider: ModelProvider) => void;
  onModeChange: (mode: BrowserChatMode) => void;
  onPreviewAttachment: (attachment: BrowserChatAttachment) => void;
  onRemoveAttachment: (id: string) => void;
  onSubmitMessage: (content: string, skillIds: string[]) => Promise<boolean>;
  onSafetyModeChange: (mode: BrowserChatSafetyMode) => void;
  onUploadImages: (files: File[]) => void | Promise<void>;
  resetToken: number;
  showStop: boolean;
  uploadingImage: boolean;
}) {
  const { t } = useI18n();
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState('');
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [dismissedSlashDraft, setDismissedSlashDraft] = useState('');
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);

  useEffect(() => {
    setDraft('');
    setSelectedSkillIds([]);
    setDismissedSlashDraft('');
    setActiveSkillIndex(0);
    if (editorRef.current) editorRef.current.innerHTML = '';
  }, [resetToken]);

  const editorPlainText = useCallback((root: HTMLElement | null) => {
    if (!root) return '';
    const walk = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
      if (!(node instanceof HTMLElement)) return '';
      if (node.dataset.skillId) return ' ';
      if (node.tagName === 'BR') return '\n';
      return Array.from(node.childNodes).map(walk).join('');
    };
    return Array.from(root.childNodes).map(walk).join('').replace(/\u00A0/g, ' ');
  }, []);

  const syncEditorState = useCallback((options: { scrollToBottom?: boolean } = {}) => {
    const editor = editorRef.current;
    const skillIds = editor
      ? Array.from(editor.querySelectorAll<HTMLElement>('[data-skill-id]')).map((node) => node.dataset.skillId || '').filter(Boolean)
      : [];
    setDraft(editorPlainText(editor));
    setSelectedSkillIds(Array.from(new Set(skillIds)));
    if (options.scrollToBottom && editor) {
      requestAnimationFrame(() => {
        editor.scrollTop = editor.scrollHeight;
      });
    }
  }, [editorPlainText]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || typeof MutationObserver === 'undefined') return undefined;
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        syncEditorState();
      });
    });
    observer.observe(editor, { childList: true, characterData: true, subtree: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [syncEditorState]);

  useEffect(() => {
    const readySkillIds = new Set(availableSkills.filter((skill) => skill.status === 'ready').map((skill) => skill.id));
    let removed = false;
    editorRef.current?.querySelectorAll<HTMLElement>('[data-skill-id]').forEach((node) => {
      if (!readySkillIds.has(node.dataset.skillId || '')) {
        node.remove();
        removed = true;
      }
    });
    if (removed) syncEditorState();
    setSelectedSkillIds((current) => current.filter((skillId) => readySkillIds.has(skillId)));
  }, [availableSkills, syncEditorState]);

  const selectedSkills = useMemo(() => (
    selectedSkillIds
      .map((skillId) => availableSkills.find((skill) => skill.id === skillId))
      .filter((skill): skill is SkillRecord => Boolean(skill))
  ), [availableSkills, selectedSkillIds]);
  const composerText = useMemo(() => draft.replace(/\s+/g, ' ').trim(), [draft]);
  const slashMatch = draft.match(/(?:^|\s)\/([^\s/]*)$/);
  const skillQuery = slashMatch?.[1]?.toLowerCase() || '';
  const skillMenuOpen = Boolean(slashMatch && dismissedSlashDraft !== draft);
  const skillSuggestions = useMemo(() => {
    if (!skillMenuOpen) return [];
    const selected = new Set(selectedSkillIds);
    return availableSkills
      .filter((skill) => skill.status === 'ready' && !selected.has(skill.id))
      .filter((skill) => {
        if (!skillQuery) return true;
        return [
          skill.title,
          skill.description,
          ...skill.tags,
          ...skill.triggerPhrases,
        ].some((value) => value.toLowerCase().includes(skillQuery));
      })
      .slice(0, 8);
  }, [availableSkills, selectedSkillIds, skillMenuOpen, skillQuery]);

  useEffect(() => {
    setActiveSkillIndex(0);
  }, [skillMenuOpen, skillQuery, selectedSkillIds.length]);

  useEffect(() => {
    if (activeSkillIndex >= skillSuggestions.length) setActiveSkillIndex(Math.max(0, skillSuggestions.length - 1));
  }, [activeSkillIndex, skillSuggestions.length]);

  const submitDraft = useCallback(async () => {
    const content = composerText;
    if ((!content && !attachments.length && !selectedSkillIds.length) || currentBusy || loading || uploadingImage) return;
    const sent = await onSubmitMessage(content, selectedSkillIds);
    if (sent) {
      setDraft('');
      setSelectedSkillIds([]);
      if (editorRef.current) editorRef.current.innerHTML = '';
    }
  }, [attachments.length, composerText, currentBusy, loading, onSubmitMessage, selectedSkillIds, uploadingImage]);

  function chooseSkill(skill: SkillRecord) {
    insertSkillToken(skill);
    setSelectedSkillIds((current) => current.includes(skill.id) ? current : [...current, skill.id]);
    setDismissedSlashDraft('');
    requestAnimationFrame(() => editorRef.current?.focus());
  }

  function removeSkill(skillId: string) {
    editorRef.current?.querySelectorAll<HTMLElement>(`[data-skill-id="${CSS.escape(skillId)}"]`).forEach((node) => node.remove());
    setSelectedSkillIds((current) => current.filter((id) => id !== skillId));
    syncEditorState();
  }

  function isSkillToken(node: Node | null): node is HTMLElement {
    return node instanceof HTMLElement && Boolean(node.dataset.skillId);
  }

  function isBlankText(value: string) {
    return value.replace(/\u00A0/g, ' ').trim() === '';
  }

  function setEditorSelection(container: Node, offset: number) {
    const selection = window.getSelection();
    if (!selection) return;
    const maxOffset = container.nodeType === Node.TEXT_NODE
      ? (container as Text).data.length
      : container.childNodes.length;
    const range = document.createRange();
    range.setStart(container, Math.max(0, Math.min(offset, maxOffset)));
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function clearEditorIfBlank() {
    const editor = editorRef.current;
    if (!editor || editor.querySelector('[data-skill-id]') || !isBlankText(editorPlainText(editor))) return false;
    editor.innerHTML = '';
    setEditorSelection(editor, 0);
    return true;
  }

  function removeSkillTokenNode(token: HTMLElement, selectionTarget?: { container: Node; offset: number }) {
    const editor = editorRef.current;
    token.remove();
    if (!clearEditorIfBlank()) {
      if (selectionTarget?.container.isConnected && editor?.contains(selectionTarget.container)) {
        setEditorSelection(selectionTarget.container, selectionTarget.offset);
      } else if (editor) {
        setEditorSelection(editor, editor.childNodes.length);
      }
    }
    setDismissedSlashDraft('');
    syncEditorState();
  }

  function removeAdjacentSkillByKeyboard(key: string) {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.rangeCount) return false;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return false;

    if (!range.collapsed) {
      const fragment = range.cloneContents();
      if (!fragment.querySelector('[data-skill-id]')) return false;
      range.deleteContents();
      setEditorSelection(range.startContainer, range.startOffset);
      clearEditorIfBlank();
      setDismissedSlashDraft('');
      syncEditorState();
      return true;
    }

    const container = range.startContainer;
    const offset = range.startOffset;

    if (key === 'Backspace') {
      if (container.nodeType === Node.TEXT_NODE) {
        const textNode = container as Text;
        const beforeCaret = textNode.data.slice(0, offset);
        const previous = textNode.previousSibling;
        if (isSkillToken(previous) && isBlankText(beforeCaret)) {
          textNode.data = textNode.data.slice(offset);
          removeSkillTokenNode(previous, { container: textNode, offset: 0 });
          return true;
        }
      } else {
        const before = container.childNodes[offset - 1];
        if (isSkillToken(before)) {
          removeSkillTokenNode(before, { container, offset: offset - 1 });
          return true;
        }
        if (before?.nodeType === Node.TEXT_NODE && isBlankText(before.textContent || '') && isSkillToken(before.previousSibling)) {
          const token = before.previousSibling;
          before.remove();
          removeSkillTokenNode(token, { container, offset: offset - 2 });
          return true;
        }
      }
    }

    if (key === 'Delete') {
      if (container.nodeType === Node.TEXT_NODE) {
        const textNode = container as Text;
        const afterCaret = textNode.data.slice(offset);
        const next = textNode.nextSibling;
        if (isSkillToken(next) && isBlankText(afterCaret)) {
          textNode.data = textNode.data.slice(0, offset);
          removeSkillTokenNode(next, { container: textNode, offset });
          return true;
        }
      } else {
        const after = container.childNodes[offset];
        if (isSkillToken(after)) {
          removeSkillTokenNode(after, { container, offset });
          return true;
        }
        if (after?.nodeType === Node.TEXT_NODE && isBlankText(after.textContent || '') && isSkillToken(after.nextSibling)) {
          const token = after.nextSibling;
          after.remove();
          removeSkillTokenNode(token, { container, offset });
          return true;
        }
      }
    }

    return false;
  }

  function editorRange() {
    const editor = editorRef.current;
    if (!editor) return undefined;
    editor.focus();
    const selection = window.getSelection();
    if (selection?.rangeCount) {
      const range = selection.getRangeAt(0);
      if (editor.contains(range.commonAncestorContainer)) return range;
    }
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return range;
  }

  function removeSlashTrigger(range: Range) {
    if (!range.collapsed || range.startContainer.nodeType !== Node.TEXT_NODE) return range;
    const node = range.startContainer as Text;
    const before = node.data.slice(0, range.startOffset);
    const match = before.match(/(^|\s)\/[^\s/]*$/);
    if (!match) return range;
    const deleteFrom = before.length - match[0].length + match[1].length;
    node.data = `${node.data.slice(0, deleteFrom)}${node.data.slice(range.startOffset)}`;
    const nextRange = document.createRange();
    nextRange.setStart(node, deleteFrom);
    nextRange.collapse(true);
    return nextRange;
  }

  function insertSkillToken(skill: SkillRecord) {
    const editor = editorRef.current;
    if (!editor) return;
    const range = removeSlashTrigger(editorRange() || document.createRange());
    range.deleteContents();

    const token = document.createElement('span');
    token.className = 'browser-chat-inline-skill';
    token.contentEditable = 'false';
    token.dataset.skillId = skill.id;
    token.title = skill.description;
    token.innerHTML = `<span class="browser-chat-inline-skill-title"></span>`;
    token.querySelector('.browser-chat-inline-skill-title')!.textContent = skill.title;

    range.insertNode(token);
    const trailingText = document.createTextNode('\u00A0');
    token.after(trailingText);
    const nextRange = document.createRange();
    nextRange.setStart(trailingText, trailingText.data.length);
    nextRange.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(nextRange);
    syncEditorState();
  }

  return (
    <>
      <BrowserChatImageGrid
        attachments={attachments}
        editable
        onPreview={onPreviewAttachment}
        onRemove={onRemoveAttachment}
      />
      {selectedSkills.length ? (
        <div className="browser-chat-skill-chips">
          {selectedSkills.map((skill) => (
            <button key={skill.id} onClick={() => removeSkill(skill.id)} title={skill.description} type="button">
              <span>{skill.title}</span>
              <X size={13} />
            </button>
          ))}
        </div>
      ) : null}
      {skillMenuOpen ? (
        <div className="browser-chat-skill-menu" role="listbox" aria-label="Skills">
          <div className="browser-chat-skill-menu-head">
            <b>Skills</b>
            {skillQuery ? <span>/{skillQuery}</span> : null}
          </div>
          {skillSuggestions.length ? skillSuggestions.map((skill, index) => (
            <button
              aria-selected={activeSkillIndex === index}
              className={activeSkillIndex === index ? 'active' : undefined}
              key={skill.id}
              onClick={() => chooseSkill(skill)}
              onMouseDown={(event) => event.preventDefault()}
              role="option"
              type="button"
            >
              <b>{skill.title}</b>
              <span>{skill.description}</span>
            </button>
          )) : (
            <div className="browser-chat-skill-empty">
              {availableSkills.some((skill) => skill.status === 'ready') ? '没有匹配的 Skills' : '暂无可用 Skills'}
            </div>
          )}
        </div>
      ) : null}
      <form
        className="browser-chat-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void submitDraft();
        }}
      >
        <input
          ref={imageInputRef}
          className="browser-chat-image-input"
          type="file"
          accept="image/*"
          multiple
          onChange={(event) => {
            const files = event.currentTarget.files;
            if (files?.length) void onUploadImages(Array.from(files));
          }}
        />
        {(selectedSkills.length || skillMenuOpen) ? (
          <div className="browser-chat-compose-context">
            {selectedSkills.length ? (
              <div className="browser-chat-skill-chips">
                {selectedSkills.map((skill) => (
                  <button key={skill.id} onClick={() => removeSkill(skill.id)} title={skill.description} type="button">
                    <Braces size={14} />
                    <span>{skill.title}</span>
                    <X size={13} />
                  </button>
                ))}
              </div>
            ) : null}
            {skillMenuOpen ? (
              <div className="browser-chat-skill-menu" role="listbox" aria-label="Skills">
                <div className="browser-chat-skill-menu-head">
                  <b>Skills</b>
                  {skillQuery ? <span>/{skillQuery}</span> : <span>/</span>}
                </div>
                {skillSuggestions.length ? skillSuggestions.map((skill, index) => (
                  <button
                    aria-selected={activeSkillIndex === index}
                    className={activeSkillIndex === index ? 'active' : undefined}
                    key={skill.id}
                    onClick={() => chooseSkill(skill)}
                    onMouseDown={(event) => event.preventDefault()}
                    role="option"
                    type="button"
                  >
                    <Braces size={15} />
                    <span>
                      <b>{skill.title}</b>
                      <small>{skill.description}</small>
                    </span>
                  </button>
                )) : (
                  <div className="browser-chat-skill-empty">
                    {availableSkills.some((skill) => skill.status === 'ready') ? '没有匹配的 Skills' : '暂无可用 Skills'}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
        <div
          ref={editorRef}
          className="browser-chat-inline-editor"
          contentEditable={!currentBusy && !loading}
          data-placeholder={t('有问题，尽管问')}
          onClick={(event) => {
            const remove = (event.target as HTMLElement).closest<HTMLElement>('[data-skill-remove]');
            const token = remove?.closest<HTMLElement>('[data-skill-id]');
            if (token?.dataset.skillId) {
              event.preventDefault();
              removeSkill(token.dataset.skillId);
            }
          }}
          onInput={() => syncEditorState({ scrollToBottom: true })}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Backspace' || event.key === 'Delete') {
              if (removeAdjacentSkillByKeyboard(event.key)) {
                event.preventDefault();
                return;
              }
              requestAnimationFrame(() => syncEditorState({ scrollToBottom: true }));
            }
            if (skillMenuOpen && event.key === 'ArrowDown') {
              event.preventDefault();
              setActiveSkillIndex((current) => skillSuggestions.length ? (current + 1) % skillSuggestions.length : 0);
              return;
            }
            if (skillMenuOpen && event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveSkillIndex((current) => skillSuggestions.length ? (current - 1 + skillSuggestions.length) % skillSuggestions.length : 0);
              return;
            }
            if (skillMenuOpen && event.key === 'Escape') {
              event.preventDefault();
              setDismissedSlashDraft(draft);
              return;
            }
            if (skillMenuOpen && (event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
              event.preventDefault();
              const skill = skillSuggestions[activeSkillIndex];
              if (skill) chooseSkill(skill);
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submitDraft();
            }
          }}
          onKeyUp={(event) => {
            if (event.key === 'Backspace' || event.key === 'Delete') syncEditorState({ scrollToBottom: true });
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData('text/plain');
            if (!text) return;
            const range = editorRange();
            range?.deleteContents();
            range?.insertNode(document.createTextNode(text));
            range?.collapse(false);
            syncEditorState({ scrollToBottom: true });
          }}
          role="textbox"
          suppressContentEditableWarning
        />
        <div className="browser-chat-compose-actions">
          <div className="browser-chat-compose-tools">
            <button
              aria-label={t('上传图片')}
              className="browser-chat-attach"
              disabled={currentBusy || uploadingImage || attachments.length >= 8}
              onClick={() => imageInputRef.current?.click()}
              title={t('上传图片')}
              type="button"
            >
              {uploadingImage ? <Loader2 className="spin" size={17} /> : <ImageUp size={17} />}
            </button>
            <div className="browser-chat-mode-toggle" role="radiogroup" aria-label={t('操作模式')}>
              <button
                aria-pressed={mode === 'visual-markers'}
                className={mode === 'visual-markers' ? 'active' : undefined}
                disabled={currentBusy || loading || modeLocked}
                onClick={() => onModeChange('visual-markers')}
                type="button"
              >
                {t('视觉')}
              </button>
              <button
                aria-pressed={mode === 'dom'}
                className={mode === 'dom' ? 'active' : undefined}
                disabled={currentBusy || loading || modeLocked}
                onClick={() => onModeChange('dom')}
                type="button"
              >
                {t('DOM')}
              </button>
            </div>
            <div className="browser-chat-safety-toggle" role="radiogroup" aria-label={t('安全性')}>
              <button
                aria-pressed={safetyMode === 'strict'}
                className={safetyMode === 'strict' ? 'active' : undefined}
                disabled={currentBusy || loading}
                onClick={() => onSafetyModeChange('strict')}
                title={t('严格模式下，一些模型认为重要的操作需要用户手动确认执行')}
                type="button"
              >
                {t('严格')}
              </button>
              <button
                aria-pressed={safetyMode === 'full'}
                className={safetyMode === 'full' ? 'active' : undefined}
                disabled={currentBusy || loading}
                onClick={() => onSafetyModeChange('full')}
                title={t('完全模式下，模型不需要征求用户手动确认执行')}
                type="button"
              >
                {t('完全')}
              </button>
            </div>
            <CustomSelect
              className="browser-chat-provider-select"
              disabled={currentBusy || loading}
              onChange={(value) => onModelProviderChange(normalizeModelProvider(value))}
              options={modelProviderOptions}
              value={modelProvider}
            />
          </div>
          <div className="browser-chat-compose-submit">
            {showStop ? (
              <button
                className="browser-chat-stop"
                disabled={interrupting}
                onClick={() => void onInterrupt()}
                type="button"
                aria-label={t('中断本轮对话')}
                title={t('中断本轮对话')}
              >
                {interrupting ? <Loader2 className="spin" size={18} /> : <Square size={16} />}
              </button>
            ) : (
              <button
                className="browser-chat-send"
                disabled={(!composerText && !attachments.length && !selectedSkillIds.length) || currentBusy || loading || uploadingImage}
                type="submit"
                aria-label={t('发送')}
              >
                {busy ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
              </button>
            )}
          </div>
        </div>
      </form>
    </>
  );
});

function embeddedBoundsFromElement(element: HTMLElement, options: { leftInset?: number } = {}): EmbeddedBrowserBounds {
  const rect = element.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const leftInset = Math.max(0, Math.min(Math.round(options.leftInset || 0), width - 1));
  return {
    x: Math.max(0, Math.round(rect.left) + leftInset),
    y: Math.max(0, Math.round(rect.top)),
    width: Math.max(1, width - leftInset),
    height: Math.max(1, Math.round(rect.height)),
  };
}

function embeddedBoundsKey(bounds?: EmbeddedBrowserBounds) {
  return bounds ? `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}` : '';
}

const BrowserChatEmbeddedBrowser = memo(function BrowserChatEmbeddedBrowser({
  active,
  enabled,
  leftOverlayInset = 0,
  onSelectSession,
  sessionId,
}: {
  active: boolean;
  enabled: boolean;
  leftOverlayInset?: number;
  onSelectSession?: (sessionId: string) => void;
  sessionId?: string;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const embeddedBrowserSyncRef = useRef({ boundsKey: '', groupId: '', sessionId: '', visible: false });
  const draggingGroupIdRef = useRef('');
  const draggingTabIdRef = useRef('');
  const [bridgeAvailable, setBridgeAvailable] = useState(false);
  const [bridgeError, setBridgeError] = useState('');
  const [browserGroups, setBrowserGroups] = useState<EmbeddedBrowserGroup[]>([]);
  const [browserTabs, setBrowserTabs] = useState<EmbeddedBrowserTab[]>([]);
  const [activeGroupId, setActiveGroupId] = useState('');
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const [activeTabId, setActiveTabId] = useState('');
  const [closedGroupIds, setClosedGroupIds] = useState<string[]>([]);
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<string[]>([]);
  const [draggingTabId, setDraggingTabId] = useState('');
  const [dragDropTarget, setDragDropTarget] = useState<{ position: 'before' | 'after'; tabId: string } | null>(null);

  const applyEmbeddedBrowserState = useCallback((result: EmbeddedBrowserState) => {
    if (!result.ok) {
      setBridgeError(result.error || '嵌入浏览器状态不可用');
      return;
    }
    setBridgeError('');
    setBrowserGroups(Array.isArray(result.groups) ? result.groups : []);
    setBrowserTabs(Array.isArray(result.tabs) ? result.tabs : []);
    setActiveGroupId(result.activeGroupId || '');
    setActiveTabIndex(typeof result.activeIndex === 'number' && result.activeIndex >= 0 ? result.activeIndex : 0);
    setActiveTabId(result.activeTabId || '');
  }, []);

  const loadEmbeddedBrowserState = useCallback(async () => {
    const bridge = window.webPilotEmbeddedBrowser;
    setBridgeAvailable(Boolean(bridge));
    if (!bridge) {
      setBrowserGroups([]);
      setBrowserTabs([]);
      setActiveGroupId('');
      setActiveTabIndex(0);
      setActiveTabId('');
      return;
    }

    try {
      const result = await bridge.getState();
      applyEmbeddedBrowserState(result);
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : '嵌入浏览器状态不可用');
    }
  }, [applyEmbeddedBrowserState]);

  const syncEmbeddedBrowser = useCallback(async () => {
    const bridge = window.webPilotEmbeddedBrowser;
    const viewport = viewportRef.current;
    const visible = enabled && active && Boolean(viewport);
    const groupId = embeddedGroupIdForSession(sessionId);
    const bounds = visible && viewport ? embeddedBoundsFromElement(viewport, { leftInset: leftOverlayInset }) : undefined;
    const boundsKey = embeddedBoundsKey(bounds);
    const previous = embeddedBrowserSyncRef.current;
    setBridgeAvailable(Boolean(bridge));
    if (!bridge) return;
    try {
      if (!visible) {
        if (!previous.visible) return;
        embeddedBrowserSyncRef.current = { boundsKey: '', groupId: '', sessionId: '', visible: false };
        const result = await bridge.setVisible({ visible: false });
        setBridgeError(result.ok ? '' : result.error || '嵌入浏览器不可用');
        if (result.ok) applyEmbeddedBrowserState(result);
        return;
      }

      if (!previous.visible || previous.groupId !== groupId || previous.sessionId !== (sessionId || '')) {
        embeddedBrowserSyncRef.current = { boundsKey, groupId, sessionId: sessionId || '', visible: true };
        const result = await bridge.setVisible({
          bounds,
          createIfMissing: false,
          groupId,
          sessionId,
          visible: true,
        });
        setBridgeError(result.ok ? '' : result.error || '嵌入浏览器不可用');
        if (result.ok) applyEmbeddedBrowserState(result);
        return;
      }

      if (bounds && previous.boundsKey !== boundsKey) {
        embeddedBrowserSyncRef.current = { boundsKey, groupId, sessionId: sessionId || '', visible: true };
        const result = await bridge.setBounds(bounds);
        setBridgeError(result.ok ? '' : result.error || '嵌入浏览器不可用');
      }
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : '嵌入浏览器不可用');
    }
  }, [active, applyEmbeddedBrowserState, enabled, leftOverlayInset, sessionId]);

  useEffect(() => {
    void syncEmbeddedBrowser();
    const viewport = viewportRef.current;
    if (!enabled || !active || !viewport) {
      return () => {
        embeddedBrowserSyncRef.current = { boundsKey: '', groupId: '', sessionId: '', visible: false };
        void window.webPilotEmbeddedBrowser?.setVisible({ visible: false }).catch(() => undefined);
      };
    }

    const update = () => {
      void syncEmbeddedBrowser();
    };
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(viewport);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      embeddedBrowserSyncRef.current = { boundsKey: '', groupId: '', sessionId: '', visible: false };
      void window.webPilotEmbeddedBrowser?.setVisible({ visible: false }).catch(() => undefined);
    };
  }, [active, enabled, syncEmbeddedBrowser]);

  async function resetEmbeddedBrowser() {
    const bridge = window.webPilotEmbeddedBrowser;
    if (!bridge) return;
    const result = await bridge.reset().catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : '重置嵌入浏览器失败',
    }));
    setBridgeError(result.ok ? '' : result.error || '重置嵌入浏览器失败');
    void syncEmbeddedBrowser();
    void loadEmbeddedBrowserState();
  }

  async function activateEmbeddedBrowserTab(tab: EmbeddedBrowserTab) {
    const bridge = window.webPilotEmbeddedBrowser;
    if (!bridge) return;
    const result = await bridge.activateTab({ id: tab.id }).catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : '切换嵌入浏览器标签失败',
    }));
    applyEmbeddedBrowserState(result);
    if (result.ok && tab.sessionId && tab.sessionId !== sessionId) onSelectSession?.(tab.sessionId);
  }

  async function closeEmbeddedBrowserTab(tab: EmbeddedBrowserTab) {
    const bridge = window.webPilotEmbeddedBrowser;
    if (!bridge) return;
    const result = await bridge.closeTab({ id: tab.id }).catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : '关闭嵌入浏览器标签失败',
    }));
    applyEmbeddedBrowserState(result);
    void syncEmbeddedBrowser();
  }

  async function closeEmbeddedBrowserGroup(group: EmbeddedBrowserGroup) {
    const bridge = window.webPilotEmbeddedBrowser;
    if (!bridge) return;
    const result = await bridge.closeGroup({ id: group.id }).catch((error: unknown): EmbeddedBrowserState => ({
      ok: false,
      error: error instanceof Error ? error.message : '关闭嵌入浏览器标签组失败',
    }));
    applyEmbeddedBrowserState(result);
    if (result.ok) {
      setClosedGroupIds((current) => (current.includes(group.id) ? current : [...current, group.id]));
      setCollapsedGroupIds((current) => current.filter((item) => item !== group.id));
      const nextActiveGroup = result.groups?.find((item) => item.active) || result.groups?.find((item) => item.tabs.length);
      const nextSessionId = nextActiveGroup?.sessionId || nextActiveGroup?.tabs.find((tab) => tab.sessionId)?.sessionId;
      if (nextSessionId && nextSessionId !== sessionId) onSelectSession?.(nextSessionId);
      void syncEmbeddedBrowser();
    }
  }

  async function createEmbeddedBrowserTab(group: EmbeddedBrowserGroup) {
    const bridge = window.webPilotEmbeddedBrowser;
    if (!bridge) return;
    const groupSessionId = embeddedSessionIdFromGroupId(group.id) || group.sessionId || sessionId;
    const result = await bridge.createTab({ groupId: group.id, sessionId: groupSessionId }).catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : '创建嵌入浏览器标签失败',
    }));
    applyEmbeddedBrowserState(result);
    if (result.ok) {
      setClosedGroupIds((current) => current.filter((item) => item !== group.id));
      setCollapsedGroupIds((current) => current.filter((item) => item !== group.id));
      if (groupSessionId && groupSessionId !== sessionId) onSelectSession?.(groupSessionId);
    }
  }

  function embeddedTabDragPosition(event: ReactDragEvent<HTMLElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX > rect.left + rect.width / 2 ? 'after' : 'before';
  }

  async function moveEmbeddedBrowserTab(tabId: string, targetId: string, position: 'before' | 'after') {
    const bridge = window.webPilotEmbeddedBrowser;
    if (!bridge || !tabId || !targetId || tabId === targetId) return;
    const result = await bridge.moveTab({ id: tabId, position, targetId }).catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : '移动嵌入浏览器标签失败',
    }));
    applyEmbeddedBrowserState(result);
  }

  function clearEmbeddedTabDrag() {
    draggingGroupIdRef.current = '';
    draggingTabIdRef.current = '';
    setDraggingTabId('');
    setDragDropTarget(null);
  }

  function toggleEmbeddedBrowserGroup(groupId: string) {
    setCollapsedGroupIds((current) => (
      current.includes(groupId)
        ? current.filter((item) => item !== groupId)
        : [...current, groupId]
    ));
  }

  const selectedGroupId = embeddedGroupIdForSession(sessionId);
  const visibleGroups = useMemo<EmbeddedBrowserGroup[]>(() => {
    const groupsById = new Map<string, EmbeddedBrowserGroup>();
    const orderedIds: string[] = [];
    const resolvedActiveGroupId = activeGroupId || browserGroups.find((group) => group.active)?.id || selectedGroupId;

    function ensureGroup(id: string, input: Partial<EmbeddedBrowserGroup> = {}) {
      const normalizedId = id || selectedGroupId;
      let group = groupsById.get(normalizedId);
      if (!group) {
        group = {
          active: normalizedId === resolvedActiveGroupId,
          activeTabId: input.activeTabId,
          id: normalizedId,
          sessionId: input.sessionId,
          tabs: [],
        };
        groupsById.set(normalizedId, group);
        orderedIds.push(normalizedId);
      }
      group.active = Boolean(group.active || input.active || normalizedId === resolvedActiveGroupId);
      group.activeTabId = group.activeTabId || input.activeTabId;
      group.sessionId = group.sessionId || input.sessionId;
      return group;
    }

    for (const group of browserGroups) {
      const hydrated = ensureGroup(group.id, group);
      for (const tab of Array.isArray(group.tabs) ? group.tabs : []) {
        if (!hydrated.tabs.some((item) => item.id === tab.id)) hydrated.tabs.push(tab);
      }
    }

    for (const tab of browserTabs) {
      const groupId = embeddedGroupIdForTab(tab, resolvedActiveGroupId || selectedGroupId);
      const hydrated = ensureGroup(groupId, {
        active: groupId === resolvedActiveGroupId || tab.id === activeTabId,
        sessionId: tab.sessionId || (groupId.startsWith('session:') ? groupId.slice('session:'.length) : undefined),
      });
      if (!hydrated.tabs.some((item) => item.id === tab.id)) hydrated.tabs.push(tab);
    }

    if ((!groupsById.size || (sessionId && !groupsById.has(selectedGroupId))) && !closedGroupIds.includes(selectedGroupId)) {
      ensureGroup(selectedGroupId, { active: true, sessionId });
    }

    return orderedIds.map((id) => groupsById.get(id)!).filter(Boolean);
  }, [activeGroupId, activeTabId, browserGroups, browserTabs, closedGroupIds, selectedGroupId, sessionId]);
  return (
    <section className="browser-chat-embedded-browser" aria-label="嵌入浏览器">
      <header>
        <div className="browser-chat-embedded-tab-list" role="tablist" aria-label="嵌入浏览器标签">
          {visibleGroups.map((group) => {
            const groupSessionId = group.sessionId
              || group.tabs.find((tab) => tab.sessionId)?.sessionId
              || (group.id.startsWith('session:') ? group.id.slice('session:'.length) : sessionId);
            const isActiveGroup = Boolean(group.active || group.id === selectedGroupId);
            const isCollapsedGroup = collapsedGroupIds.includes(group.id);
            return (
              <div
                className={[
                  'browser-chat-embedded-tab-group-shell',
                  isActiveGroup ? 'active' : '',
                  isCollapsedGroup ? 'collapsed' : '',
                  group.tabs.length ? '' : 'empty',
                ].filter(Boolean).join(' ')}
                key={group.id}
              >
                <div className="browser-chat-embedded-tab-group-tag">
                  <button
                    aria-expanded={!isCollapsedGroup}
                    className="browser-chat-embedded-tab-group-label"
                    onClick={() => toggleEmbeddedBrowserGroup(group.id)}
                    title={embeddedSessionGroupLabel(groupSessionId)}
                    type="button"
                  >
                    <Folder size={14} />
                    <span>{embeddedSessionGroupLabel(groupSessionId)}</span>
                  </button>
                  <button
                    aria-label={`关闭 ${embeddedSessionGroupLabel(groupSessionId)} 标签组`}
                    className="browser-chat-embedded-tab-group-close"
                    onClick={(event) => {
                      event.stopPropagation();
                      void closeEmbeddedBrowserGroup(group);
                    }}
                    title={`关闭 ${embeddedSessionGroupLabel(groupSessionId)} 标签组`}
                    type="button"
                  >
                    <X size={13} />
                  </button>
                </div>
                <div className="browser-chat-embedded-tab-stack" hidden={isCollapsedGroup}>
                  {group.tabs.map((tab) => {
                    const tabIndex = browserTabs.findIndex((item) => item.id === tab.id);
                    const isActiveTab = activeTabId ? tab.id === activeTabId : tabIndex === activeTabIndex;
                    const dragPosition = dragDropTarget?.tabId === tab.id ? dragDropTarget.position : undefined;
                    return (
                      <div
                        aria-selected={isActiveTab}
                        className={[
                          'browser-chat-embedded-tab',
                          isActiveTab ? 'active' : '',
                          tab.loading ? 'loading' : '',
                          draggingTabId === tab.id ? 'dragging' : '',
                          dragPosition ? `drop-${dragPosition}` : '',
                        ].filter(Boolean).join(' ')}
                        draggable
                        key={tab.id || `${tab.url}-${tabIndex}`}
                        onClick={() => void activateEmbeddedBrowserTab(tab)}
                        onDragEnd={clearEmbeddedTabDrag}
                        onDragOver={(event) => {
                          const sourceTabId = draggingTabIdRef.current || draggingTabId;
                          if (!sourceTabId || sourceTabId === tab.id) return;
                          if (draggingGroupIdRef.current && draggingGroupIdRef.current !== group.id) return;
                          event.preventDefault();
                          event.dataTransfer.dropEffect = 'move';
                          setDragDropTarget({ position: embeddedTabDragPosition(event), tabId: tab.id });
                        }}
                        onDragStart={(event) => {
                          draggingGroupIdRef.current = group.id;
                          draggingTabIdRef.current = tab.id;
                          setDraggingTabId(tab.id);
                          event.dataTransfer.effectAllowed = 'move';
                          event.dataTransfer.setData('application/x-webpilot-tab-id', tab.id);
                          event.dataTransfer.setData('text/plain', tab.id);
                        }}
                        onDrop={(event) => {
                          const droppedTabId = draggingTabIdRef.current || draggingTabId || event.dataTransfer.getData('application/x-webpilot-tab-id') || event.dataTransfer.getData('text/plain');
                          if (!droppedTabId || droppedTabId === tab.id) return;
                          if (draggingGroupIdRef.current && draggingGroupIdRef.current !== group.id) return;
                          event.preventDefault();
                          const position = dragDropTarget?.tabId === tab.id ? dragDropTarget.position : embeddedTabDragPosition(event);
                          clearEmbeddedTabDrag();
                          void moveEmbeddedBrowserTab(droppedTabId, tab.id, position);
                        }}
                        role="tab"
                        title={tab.url || tab.title}
                      >
                        <span className="browser-chat-embedded-tab-icon">
                          <AppWindow size={14} />
                        </span>
                        <span className="browser-chat-embedded-tab-text">
                          <strong>{compactText(tab.title || tab.url || '新标签页', 56)}</strong>
                        </span>
                        {tab.loading ? (
                          <span className="browser-chat-embedded-tab-loading" aria-label="页面加载中">
                            <Loader2 className="spin" size={12} />
                          </span>
                        ) : null}
                        <button
                          aria-label="关闭当前标签页"
                          className="browser-chat-embedded-tab-close"
                          onClick={(event) => {
                            event.stopPropagation();
                            void closeEmbeddedBrowserTab(tab);
                          }}
                          title="关闭当前标签页"
                          type="button"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    );
                  })}
                </div>
                <button
                  aria-label={`在 ${embeddedSessionGroupLabel(groupSessionId)} 中新建标签页`}
                  className="browser-chat-embedded-new-tab-button browser-chat-embedded-group-new-tab-button"
                  onClick={() => void createEmbeddedBrowserTab(group)}
                  title={`在 ${embeddedSessionGroupLabel(groupSessionId)} 中新建标签页`}
                  type="button"
                >
                  <Plus size={18} />
                </button>
              </div>
            );
          })}
        </div>
        <div className="browser-chat-embedded-toolbar">
          <button className="browser-chat-embedded-tool-button" onClick={() => void resetEmbeddedBrowser()} title="重置浏览器视图" type="button" aria-label="重置浏览器视图">
            <RefreshCw size={15} />
          </button>
        </div>
      </header>
      <div className="browser-chat-embedded-viewport" ref={viewportRef}>
        {!bridgeAvailable ? (
          <div className="browser-chat-embedded-state">
            <AppWindow size={24} />
            <strong>仅桌面端可用</strong>
            <span>请使用 Electron 开发壳或桌面版打开。</span>
          </div>
        ) : bridgeError ? (
          <div className="browser-chat-embedded-state">
            <Bug size={24} />
            <strong>嵌入浏览器未就绪</strong>
            <span>{bridgeError}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
});

export function BrowserChatWorkspace({
  testCases,
  groups,
  schedules,
  initialView = 'chat',
}: {
  testCases: TestCaseRecord[];
  groups: TestGroupRecord[];
  schedules: RunScheduleRecord[];
  initialView?: BrowserChatView;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const [, startTransition] = useTransition();
  const sendingRef = useRef(false);
  const loadingSessionRef = useRef<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const embeddedWorkspaceRef = useRef<HTMLDivElement | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const sessionVersionsRef = useRef(new Map<string, number>());
  const sessionRefreshTimersRef = useRef(new Map<string, number>());
  const sessionListRefreshTimerRef = useRef<number | undefined>(undefined);
  const [activeView, setActiveView] = useState<BrowserChatView>(initialView);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [session, setSession] = useState<BrowserChatSession | null>(null);
  const [sessions, setSessions] = useState<BrowserChatSession[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [mode, setMode] = useState<BrowserChatMode>('visual-markers');
  const [safetyMode, setSafetyMode] = useState<BrowserChatSafetyMode>('strict');
  const [modelProvider, setModelProvider] = useState<ModelProvider>('openrouter');
  const [modelConfig, setModelConfig] = useState<BrowserChatModelConfig | null>(null);
  const [targetGroupId, setTargetGroupId] = useState<string | undefined>();
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [groupName, setGroupName] = useState('');
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [attachments, setAttachments] = useState<BrowserChatAttachment[]>([]);
  const [composerResetToken, setComposerResetToken] = useState(0);
  const [busy, setBusy] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [embeddedBrowserEnabled, setEmbeddedBrowserEnabled] = useState(false);
  const [embeddedChatWidth, setEmbeddedChatWidth] = useState(420);
  const [, setEmbeddedChatResizing] = useState(false);
  const [historyTooltipActive, setHistoryTooltipActive] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [deletingSelectedSessions, setDeletingSelectedSessions] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [exportingMessageId, setExportingMessageId] = useState<string | null>(null);
  const [exportingSelectedMessages, setExportingSelectedMessages] = useState(false);
  const [generatingSkillMessageId, setGeneratingSkillMessageId] = useState<string | null>(null);
  const [generatingSkillSelectedMessages, setGeneratingSkillSelectedMessages] = useState(false);
  const [selectedExportMessageIds, setSelectedExportMessageIds] = useState<string[]>([]);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [logDialogMessageId, setLogDialogMessageId] = useState<string | null>(null);
  const [toolDialog, setToolDialog] = useState<BrowserChatToolDetail | null>(null);
  const [resolvingConfirmationId, setResolvingConfirmationId] = useState<string | null>(null);
  const [resolvingConfirmationAction, setResolvingConfirmationAction] = useState<BrowserChatToolConfirmationAction | null>(null);
  const [imagePreview, setImagePreview] = useState<BrowserChatAttachment | null>(null);
  const [error, setError] = useState('');
  const selectedRunningSession = session?.busy ? session : undefined;
  const selectedSessionBusy = Boolean(session?.busy);
  const currentBusy = busy || selectedSessionBusy;
  const modeLocked = Boolean(session && session.status !== 'closed' && (session.messages.length || session.steps.length || session.busy));
  const messages = useMemo(() => session?.messages || [], [session?.messages]);
  const steps = useMemo(() => session?.steps || [], [session?.steps]);
  const logs = useMemo(() => session?.logs || [], [session?.logs]);
  const visibleMessages = messages;
  const lastAssistantMessageId = useMemo(
    () => [...visibleMessages].reverse().find((item) => item.role === 'assistant')?.id,
    [visibleMessages],
  );
  const hasMessages = visibleMessages.length > 0;
  const stepsByIndex = useMemo(() => new Map(steps.map((step) => [step.index, step])), [steps]);
  const selectedExportMessageIdSet = useMemo(() => new Set(selectedExportMessageIds), [selectedExportMessageIds]);
  const logIndex = useMemo(() => buildBrowserChatLogIndex(logs), [logs]);
  const logDialogMessage = useMemo(
    () => messages.find((item) => item.id === logDialogMessageId),
    [logDialogMessageId, messages],
  );
  const logDialogEntries = useMemo(() => {
    if (!logDialogMessage) return [];
    return browserChatLogsForMessage(logDialogMessage, logIndex).filter(visibleExecutionLog);
  }, [logDialogMessage, logIndex]);
  const previewAttachment = useCallback((attachment: BrowserChatAttachment) => {
    setImagePreview(attachment);
  }, []);
  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }, []);
  const showMessageLogs = useCallback((messageId: string) => {
    setLogDialogMessageId(messageId);
  }, []);
  const toggleExportMessageSelection = useCallback((messageId: string, selected: boolean) => {
    setSelectedExportMessageIds((current) => {
      const next = new Set(current);
      if (selected) next.add(messageId);
      else next.delete(messageId);
      return [...next];
    });
  }, []);
  const clearExportMessageSelection = useCallback(() => {
    setSelectedExportMessageIds([]);
  }, []);
  const recentSessions = useMemo(() => {
    const merged = new Map<string, BrowserChatSession>();
    for (const item of sessions) merged.set(item.id, item);
    if (session) merged.set(session.id, session);
    return [...merged.values()]
      .filter((item) => item.messages.length || item.id === session?.id)
      .sort((a, b) => sessionSortTime(b).localeCompare(sessionSortTime(a)))
      .slice(0, 14);
  }, [session, sessions]);
  const selectedSessionIdSet = useMemo(() => new Set(selectedSessionIds), [selectedSessionIds]);
  const selectableRecentSessionIds = useMemo(
    () => recentSessions.filter((item) => !item.busy).map((item) => item.id),
    [recentSessions],
  );
  const selectableRecentSessionIdSet = useMemo(() => new Set(selectableRecentSessionIds), [selectableRecentSessionIds]);
  const selectedDeletableSessionIds = useMemo(
    () => selectedSessionIds.filter((id) => selectableRecentSessionIdSet.has(id)),
    [selectableRecentSessionIdSet, selectedSessionIds],
  );
  const allSelectableRecentSessionsSelected = selectableRecentSessionIds.length > 0
    && selectableRecentSessionIds.every((id) => selectedSessionIdSet.has(id));
  const toolDialogDomTree = useMemo(
    () => domTreeFromToolCall(toolDialog?.tool, toolDialog?.step.aiRequest),
    [toolDialog],
  );
  const toolDialogFullDomSnapshot = useMemo(
    () => fullDomSnapshotFromToolCall(toolDialog?.tool),
    [toolDialog],
  );
  const embeddedBrowserActive = embeddedBrowserEnabled && activeView === 'chat';
  const embeddedBrowserCovered = Boolean(toolDialog || logDialogMessageId || imagePreview || groupDialogOpen);
  const embeddedBrowserViewActive = embeddedBrowserActive && !embeddedBrowserCovered;
  const embeddedBrowserLeftOverlayInset = embeddedBrowserActive && historyTooltipActive && sidebarCollapsed ? 300 : 0;
  const modelProviderOptions = useMemo(() => modelProviderDefinitions.map((provider) => {
    const configuredModel = modelConfig?.providers?.[provider.value]?.model?.trim() || defaultModelByProvider[provider.value];
    return {
      label: configuredModel ? `${provider.label} - ${configuredModel}` : provider.label,
      value: provider.value,
    };
  }), [modelConfig]);

  const loadBrowserRuntimeSettings = useCallback(async () => {
    const response = await fetch('/api/settings/env', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '加载浏览器配置失败');
    const saved = Array.isArray(data.saved) ? data.saved as Array<{ key?: string; value?: string }> : [];
    const embeddedSetting = saved.find((item) => item.key === 'ELECTRON_EMBEDDED_BROWSER');
    setEmbeddedBrowserEnabled(embeddedSetting?.value === 'true');
  }, []);

  const loadSkills = useCallback(async () => {
    const response = await fetch('/api/skills', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '加载 Skills 失败');
    setSkills(Array.isArray(data.skills) ? data.skills : []);
  }, []);

  const loadModelConfig = useCallback(async () => {
    const response = await fetch('/api/settings/model', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '加载模型配置失败');
    const config = data.config as Partial<BrowserChatModelConfig> | undefined;
    if (!config) return;
    setModelConfig({
      provider: normalizeModelProvider(config.provider),
      providers: config.providers || {},
      updatedAt: typeof config.updatedAt === 'string' ? config.updatedAt : '',
    });
  }, []);

  const beginEmbeddedChatResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const workspace = embeddedWorkspaceRef.current;
    if (!workspace) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const rect = workspace.getBoundingClientRect();
    const minChatWidth = 320;
    const minBrowserWidth = 380;
    const maxChatWidth = Math.max(minChatWidth, Math.min(760, rect.width - minBrowserWidth - 8));
    setEmbeddedChatResizing(true);

    function nextWidth(clientX: number) {
      return Math.round(Math.max(minChatWidth, Math.min(maxChatWidth, rect.right - clientX)));
    }

    setEmbeddedChatWidth(nextWidth(event.clientX));
    const onPointerMove = (moveEvent: PointerEvent) => {
      setEmbeddedChatWidth(nextWidth(moveEvent.clientX));
    };
    const onPointerUp = () => {
      setEmbeddedChatResizing(false);
      document.body.classList.remove('browser-chat-resizing');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
    document.body.classList.add('browser-chat-resizing');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
  }, []);

  useEffect(() => {
    if (!sidebarCollapsed || activeView !== 'chat') setHistoryTooltipActive(false);
  }, [activeView, sidebarCollapsed]);

  useEffect(() => {
    activeSessionIdRef.current = session?.id || null;
  }, [session?.id]);

  useEffect(() => {
    setSelectedExportMessageIds([]);
  }, [session?.id]);

  const upsertSession = useCallback((nextSession: BrowserChatSession, options: { activate?: boolean; version?: number } = {}) => {
    const normalized = normalizeSession(nextSession);
    const lastVersion = sessionVersionsRef.current.get(normalized.id) || 0;
    if (typeof options.version === 'number') {
      if (options.version < lastVersion) return normalized;
      sessionVersionsRef.current.set(normalized.id, options.version);
    }
    const shouldActivate = options.activate ?? activeSessionIdRef.current === normalized.id;
    if (shouldActivate) {
      setSession((current) => (isOlderSessionSnapshot(normalized, current) ? current : normalized));
    }
    setSessions((current) => {
      const existing = current.find((item) => item.id === normalized.id);
      const accepted = isOlderSessionSnapshot(normalized, existing) ? existing || normalized : normalized;
      const next = [accepted, ...current.filter((item) => item.id !== normalized.id)];
      return next.sort((a, b) => sessionSortTime(b).localeCompare(sessionSortTime(a)));
    });
    return normalized;
  }, []);

  const loadSessions = useCallback(async () => {
    const response = await fetch('/api/browser-chat', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '加载对话历史失败');
    const nextSessions = Array.isArray(data.sessions) ? data.sessions.map((item: BrowserChatSession) => normalizeSession(item)) : [];
    setSessions(nextSessions);
  }, []);

  const refreshSession = useCallback(async (sessionId: string, options: { activate?: boolean } = {}) => {
    const response = await fetch(`/api/browser-chat/${sessionId}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '加载对话失败');
    const shouldActivate = options.activate ?? activeSessionIdRef.current === sessionId;
    const loadedSession = upsertSession(data.session as BrowserChatSession, { activate: shouldActivate });
    if (shouldActivate) {
      setMode(normalizeMode(loadedSession.mode));
      setSafetyMode(normalizeSafetyMode(loadedSession.safetyMode));
      setModelProvider(normalizeModelProvider(loadedSession.modelProvider));
    }
    return loadedSession;
  }, [upsertSession]);

  const scheduleLoadSessions = useCallback((delay = 80) => {
    if (sessionListRefreshTimerRef.current) window.clearTimeout(sessionListRefreshTimerRef.current);
    sessionListRefreshTimerRef.current = window.setTimeout(() => {
      sessionListRefreshTimerRef.current = undefined;
      void loadSessions().catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : '加载对话历史失败');
      });
    }, delay);
  }, [loadSessions]);

  const scheduleSessionRefresh = useCallback((sessionId: string, delay = 30) => {
    const timers = sessionRefreshTimersRef.current;
    const existing = timers.get(sessionId);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      timers.delete(sessionId);
      void refreshSession(sessionId, { activate: activeSessionIdRef.current === sessionId }).catch((refreshError) => {
        if (activeSessionIdRef.current === sessionId) {
          setError(refreshError instanceof Error ? refreshError.message : '加载对话失败');
        }
      });
    }, delay);
    timers.set(sessionId, timer);
  }, [refreshSession]);

  useEffect(() => {
    void loadSessions().catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : '加载对话历史失败');
    });
  }, [loadSessions]);

  useEffect(() => {
    void loadSkills().catch(() => undefined);
  }, [loadSkills]);

  useEffect(() => {
    void loadModelConfig().catch(() => undefined);
  }, [loadModelConfig]);

  useEffect(() => {
    if (session?.id || !modelConfig?.provider) return;
    setModelProvider(normalizeModelProvider(modelConfig.provider));
  }, [modelConfig?.provider, session?.id]);

  useEffect(() => {
    void loadBrowserRuntimeSettings().catch(() => undefined);
  }, [loadBrowserRuntimeSettings]);

  useEffect(() => {
    return subscribeRealtimeRefresh((event) => {
      if (event.entityType !== 'browserChatSession') return;
      const lastVersion = sessionVersionsRef.current.get(event.id) || 0;
      if (event.version < lastVersion) return;
      sessionVersionsRef.current.set(event.id, event.version);
      if (event.deleted) {
        setSessions((current) => current.filter((item) => item.id !== event.id));
        setSession((current) => (current?.id === event.id ? null : current));
        setSelectedSessionIds((current) => current.filter((id) => id !== event.id));
        return;
      }
      if (activeSessionIdRef.current === event.id) scheduleSessionRefresh(event.id);
      scheduleLoadSessions();
    }, { onStatus: setRealtimeConnected });
  }, [scheduleLoadSessions, scheduleSessionRefresh]);

  useEffect(() => () => {
    for (const timer of sessionRefreshTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    sessionRefreshTimersRef.current.clear();
    if (sessionListRefreshTimerRef.current) window.clearTimeout(sessionListRefreshTimerRef.current);
  }, []);

  useEffect(() => {
    if (!session?.id || !session.busy || realtimeConnected) return undefined;
    const sessionId = session.id;
    const timer = window.setInterval(() => {
      void refreshSession(sessionId, { activate: activeSessionIdRef.current === sessionId }).catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [realtimeConnected, refreshSession, session?.busy, session?.id]);

  async function createGroup(parentId?: string) {
    const name = groupName.trim();
    if (!name || creatingGroup) return;
    setCreatingGroup(true);
    startGlobalLoading('正在创建分组');
    try {
      await fetch('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parentId }),
      });
      setGroupName('');
      setGroupDialogOpen(false);
      startTransition(() => router.refresh());
    } finally {
      setCreatingGroup(false);
      stopGlobalLoading();
    }
  }

  async function createSession() {
    const response = await fetch('/api/browser-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, safetyMode, modelProvider }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '创建对话会话失败');
    return upsertSession(data.session as BrowserChatSession, { activate: true });
  }

  async function ensureSession() {
    if (session && session.status !== 'closed') return session;
    return createSession();
  }

  async function postMessageToSession(sessionId: string, content: string, clientMessageId: string, nextAttachments: BrowserChatAttachment[], skillIds: string[]) {
    const response = await fetch(`/api/browser-chat/${sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachments: nextAttachments, clientMessageId, content, mode, safetyMode, modelProvider, skillIds }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '发送消息失败');
    return data.session as BrowserChatSession;
  }

  async function ensureEmbeddedBrowserSessionTab(sessionId: string) {
    if (!embeddedBrowserEnabled || typeof window === 'undefined') return;
    const bridge = window.webPilotEmbeddedBrowser;
    if (!bridge) return;
    const groupId = embeddedGroupIdForSession(sessionId);
    const result = await bridge.setVisible({
      createIfMissing: true,
      groupId,
      sessionId,
      visible: true,
    });
    if (!result.ok) throw new Error(result.error || '嵌入浏览器标签创建失败');
    const groupTabs = [
      ...(result.groups?.find((group) => group.id === groupId)?.tabs || []),
      ...(result.tabs || []).filter((tab) => tab.groupId === groupId),
    ];
    if (groupTabs.length) return;
    const created = await bridge.createTab({ groupId, sessionId });
    if (!created.ok) throw new Error(created.error || '嵌入浏览器标签创建失败');
  }

  async function uploadChatImages(files: FileList | File[]) {
    const selectedFiles = Array.from(files).filter((file) => file.type.startsWith('image/'));
    const remainingSlots = Math.max(0, 8 - attachments.length);
    if (!selectedFiles.length || !remainingSlots || uploadingImage || currentBusy) return;
    setUploadingImage(true);
    setError('');
    try {
      const uploaded: BrowserChatAttachment[] = [];
      for (const file of selectedFiles.slice(0, remainingSlots)) {
        const form = new FormData();
        form.append('file', file);
        const response = await fetch('/api/uploads', { method: 'POST', body: form });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '图片上传失败');
        uploaded.push({
          id: String(data.imageId || temporaryId('image')),
          name: String(data.name || file.name),
          type: String(data.type || file.type || 'image/*'),
          size: typeof data.size === 'number' ? data.size : file.size,
          path: String(data.path || `uploads/${data.imageId}`),
          url: String(data.url || `/api/artifacts/uploads/${encodeURIComponent(String(data.imageId))}`),
        });
      }
      if (uploaded.length) setAttachments((current) => [...current, ...uploaded].slice(0, 8));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : '图片上传失败');
    } finally {
      setUploadingImage(false);
      if (imageInputRef.current) imageInputRef.current.value = '';
    }
  }

  async function sendMessage(content: string, skillIds: string[] = []) {
    const trimmedContent = content.trim();
    const nextAttachments = attachments;
    if ((!trimmedContent && !nextAttachments.length && !skillIds.length) || currentBusy || loadingSessionId || sendingRef.current || uploadingImage) return false;
    sendingRef.current = true;
    const clientMessageId = temporaryId('client_msg');
    setError('');
    setBusy(true);
    setActiveView('chat');
    try {
      let active = await ensureSession();
      await ensureEmbeddedBrowserSessionTab(active.id);
      let posted: BrowserChatSession;
      try {
        posted = await postMessageToSession(active.id, trimmedContent, clientMessageId, nextAttachments, skillIds);
      } catch (firstError) {
        const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
        if (!/Browser chat session not found/i.test(firstMessage)) throw firstError;
        active = await createSession();
        await ensureEmbeddedBrowserSessionTab(active.id);
        posted = await postMessageToSession(active.id, trimmedContent, clientMessageId, nextAttachments, skillIds);
      }
      upsertSession(posted, { activate: true });
      setAttachments([]);
      return true;
    } catch (sendError) {
      const sendMessageText = sendError instanceof Error ? sendError.message : '发送消息失败';
      setError(sendMessageText);
      setAttachments(nextAttachments);
      return false;
    } finally {
      sendingRef.current = false;
      setBusy(false);
    }
  }

  async function interruptConversation() {
    const target = selectedRunningSession;
    if (!target?.id || interrupting || !target.busy) return;
    setInterrupting(true);
    setError('');
    try {
      const response = await fetch(`/api/browser-chat/${target.id}/interrupt`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '中断对话失败');
      upsertSession(data.session as BrowserChatSession, { activate: activeSessionIdRef.current === target.id });
    } catch (interruptError) {
      setError(interruptError instanceof Error ? interruptError.message : '中断对话失败');
    } finally {
      setInterrupting(false);
    }
  }

  async function resolveToolConfirmation(confirmationId: string, action: BrowserChatToolConfirmationAction) {
    const sessionId = session?.id;
    if (!sessionId || resolvingConfirmationId) return;
    setResolvingConfirmationId(confirmationId);
    setResolvingConfirmationAction(action);
    setError('');
    try {
      const response = await fetch(`/api/browser-chat/${sessionId}/tool-confirmation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, confirmationId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '工具确认失败');
      upsertSession(data.session as BrowserChatSession, { activate: activeSessionIdRef.current === sessionId });
      scheduleSessionRefresh(sessionId, 120);
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : '工具确认失败');
    } finally {
      setResolvingConfirmationId(null);
      setResolvingConfirmationAction(null);
    }
  }

  async function closeSession() {
    if (!session || busy) return;
    setBusy(true);
    startGlobalLoading('正在结束浏览器对话');
    try {
      const response = await fetch(`/api/browser-chat/${session.id}`, { method: 'DELETE' });
      const data = await response.json();
      if (response.ok) {
        upsertSession(data.session, { activate: true });
        await loadSessions().catch(() => undefined);
      }
    } finally {
      setBusy(false);
      stopGlobalLoading();
    }
  }

  async function deleteSessionHistory(sessionId: string) {
    if (deletingSessionId || deletingSelectedSessions) return;
    setDeletingSessionId(sessionId);
    setError('');
    try {
      const response = await fetch(`/api/browser-chat/${sessionId}/delete`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '删除历史对话失败');
      setSessions((current) => current.filter((item) => item.id !== sessionId));
      setSelectedSessionIds((current) => current.filter((id) => id !== sessionId));
      if (session?.id === sessionId) setSession(null);
      await loadSessions().catch(() => undefined);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除历史对话失败');
    } finally {
      setDeletingSessionId(null);
    }
  }

  function toggleSessionSelection(sessionId: string, selected: boolean) {
    setSelectedSessionIds((current) => {
      const next = new Set(current);
      if (selected) next.add(sessionId);
      else next.delete(sessionId);
      return [...next];
    });
  }

  function toggleAllRecentSelections() {
    setSelectedSessionIds((current) => {
      const next = new Set(current);
      if (allSelectableRecentSessionsSelected) {
        for (const id of selectableRecentSessionIds) next.delete(id);
      } else {
        for (const id of selectableRecentSessionIds) next.add(id);
      }
      return [...next];
    });
  }

  async function deleteSelectedSessionHistory() {
    if (!selectedDeletableSessionIds.length || deletingSelectedSessions) return;
    const deletingIds = selectedDeletableSessionIds;
    const deletingIdSet = new Set(deletingIds);
    setDeletingSelectedSessions(true);
    setError('');
    try {
      const response = await fetch('/api/browser-chat/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: deletingIds }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '批量删除历史对话失败');
      setSessions((current) => current.filter((item) => !deletingIdSet.has(item.id)));
      setSelectedSessionIds((current) => current.filter((id) => !deletingIdSet.has(id)));
      if (session?.id && deletingIdSet.has(session.id)) setSession(null);
      await loadSessions().catch(() => undefined);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '批量删除历史对话失败');
    } finally {
      setDeletingSelectedSessions(false);
    }
  }

  const exportSelectedMessagesToTestCase = useCallback(async () => {
    const sessionId = session?.id;
    if (!sessionId || !selectedExportMessageIds.length || exportingMessageId || exportingSelectedMessages || generatingSkillMessageId || generatingSkillSelectedMessages) return;
    const messageIds = selectedExportMessageIds;
    setExportingSelectedMessages(true);
    setError('');
    startGlobalLoading('正在导出选中对话轮次');
    try {
      const response = await fetch(`/api/browser-chat/${sessionId}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageIds }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '导出测试用例失败');
      setSelectedExportMessageIds([]);
      startTransition(() => router.push(`/test-cases/${data.testCaseId}`));
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : '导出测试用例失败');
    } finally {
      setExportingSelectedMessages(false);
      stopGlobalLoading();
    }
  }, [exportingMessageId, exportingSelectedMessages, generatingSkillMessageId, generatingSkillSelectedMessages, router, selectedExportMessageIds, session?.id, startTransition]);

  const exportMessageToTestCase = useCallback(async (messageId: string) => {
    const sessionId = session?.id;
    if (!sessionId || exportingMessageId || exportingSelectedMessages || generatingSkillMessageId || generatingSkillSelectedMessages) return;
    setExportingMessageId(messageId);
    setError('');
    try {
      const response = await fetch(`/api/browser-chat/${sessionId}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '导出测试用例失败');
      startTransition(() => router.push(`/test-cases/${data.testCaseId}`));
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : '导出测试用例失败');
    } finally {
      setExportingMessageId(null);
    }
  }, [exportingMessageId, exportingSelectedMessages, generatingSkillMessageId, generatingSkillSelectedMessages, router, session?.id, startTransition]);

  const generateSelectedMessagesSkill = useCallback(async () => {
    const sessionId = session?.id;
    if (!sessionId || !selectedExportMessageIds.length || exportingMessageId || exportingSelectedMessages || generatingSkillMessageId || generatingSkillSelectedMessages) return;
    const messageIds = selectedExportMessageIds;
    setGeneratingSkillSelectedMessages(true);
    setError('');
    startGlobalLoading('正在生成 Skill');
    try {
      const response = await fetch(`/api/browser-chat/${sessionId}/skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageIds }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '生成 Skill 失败');
      setSelectedExportMessageIds([]);
      await loadSkills();
    } catch (skillError) {
      setError(skillError instanceof Error ? skillError.message : '生成 Skill 失败');
    } finally {
      setGeneratingSkillSelectedMessages(false);
      stopGlobalLoading();
    }
  }, [exportingMessageId, exportingSelectedMessages, generatingSkillMessageId, generatingSkillSelectedMessages, loadSkills, selectedExportMessageIds, session?.id]);

  const generateMessageSkill = useCallback(async (messageId: string) => {
    const sessionId = session?.id;
    if (!sessionId || exportingMessageId || exportingSelectedMessages || generatingSkillMessageId || generatingSkillSelectedMessages) return;
    setGeneratingSkillMessageId(messageId);
    setError('');
    startGlobalLoading('正在生成 Skill');
    try {
      const response = await fetch(`/api/browser-chat/${sessionId}/skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '生成 Skill 失败');
      await loadSkills();
    } catch (skillError) {
      setError(skillError instanceof Error ? skillError.message : '生成 Skill 失败');
    } finally {
      setGeneratingSkillMessageId(null);
      stopGlobalLoading();
    }
  }, [exportingMessageId, exportingSelectedMessages, generatingSkillMessageId, generatingSkillSelectedMessages, loadSkills, session?.id]);

  async function startNewConversation() {
    setActiveView('chat');
    if (busy || loadingSessionId) return;
    setError('');
    setComposerResetToken((current) => current + 1);
    setAttachments([]);
    setSession(null);
    if (!embeddedBrowserEnabled) return;
    setBusy(true);
    try {
      const active = await createSession();
      await ensureEmbeddedBrowserSessionTab(active.id);
    } catch (newConversationError) {
      setError(newConversationError instanceof Error ? newConversationError.message : '创建新对话失败');
    } finally {
      setBusy(false);
    }
  }

  async function loadSession(sessionId: string) {
    if (loadingSessionRef.current === sessionId) return;
    loadingSessionRef.current = sessionId;
    setLoadingSessionId(sessionId);
    setActiveView('chat');
    setError('');
    setComposerResetToken((current) => current + 1);
    setAttachments([]);
    try {
      const loadedSession = await refreshSession(sessionId, { activate: true });
      setMode(normalizeMode(loadedSession.mode));
      setSafetyMode(normalizeSafetyMode(loadedSession.safetyMode));
      setModelProvider(normalizeModelProvider(loadedSession.modelProvider));
      void loadSessions().catch(() => undefined);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载对话失败');
      void loadSessions().catch(() => undefined);
    } finally {
      if (loadingSessionRef.current === sessionId) {
        loadingSessionRef.current = null;
        setLoadingSessionId(null);
      }
    }
  }

  async function openChatEntry() {
    await startNewConversation();
  }

  function renderSidebarDetail() {
    if (activeView === 'target') {
      return (
        <DashboardGroupSidebar
          className="browser-chat-sub-sidebar"
          groups={groups}
          selectedGroupId={targetGroupId}
          onCreateGroup={() => setGroupDialogOpen(true)}
          onSelect={setTargetGroupId}
        />
      );
    }

    if (activeView === 'settings') {
      return (
        <section className="browser-chat-sidebar-section browser-chat-settings-section">
          <h2>设置</h2>
          <nav className="browser-chat-subnav" aria-label="环境配置分类">
            {environmentSettingsTabs.map((tab) => (
              <button className={settingsTab === tab.id ? 'active' : undefined} key={tab.id} onClick={() => setSettingsTab(tab.id)} title={tab.label} type="button">
                <SettingsTabIcon tab={tab.id} />
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>
        </section>
      );
    }

    return (
      <section className="browser-chat-sidebar-section browser-chat-recent-section">
        <div className="browser-chat-recent-header">
          <h2>最近</h2>
          {recentSessions.length ? (
            <div>
              <label className="browser-chat-recent-select-all">
                <input
                  aria-label="选择全部历史对话"
                  checked={allSelectableRecentSessionsSelected}
                  disabled={!selectableRecentSessionIds.length || deletingSelectedSessions}
                  onChange={() => toggleAllRecentSelections()}
                  type="checkbox"
                />
                <span>全选</span>
              </label>
              <button
                aria-label="批量删除历史对话"
                className="browser-chat-recent-bulk-delete"
                disabled={!selectedDeletableSessionIds.length || deletingSelectedSessions}
                onClick={() => void deleteSelectedSessionHistory()}
                title="批量删除历史对话"
                type="button"
              >
                {deletingSelectedSessions ? <Loader2 className="spin" size={13} /> : <Trash2 size={14} />}
              </button>
            </div>
          ) : null}
        </div>
        {recentSessions.length ? (
          <ol className="browser-chat-recent-list">
            {recentSessions.map((item) => (
              <li key={item.id}>
                <div
                  className={session?.id === item.id ? 'browser-chat-recent-item active' : 'browser-chat-recent-item'}
                  onBlurCapture={() => setHistoryTooltipActive(false)}
                  onFocusCapture={() => {
                    if (sidebarCollapsed) setHistoryTooltipActive(true);
                  }}
                  onMouseEnter={() => {
                    if (sidebarCollapsed) setHistoryTooltipActive(true);
                  }}
                  onMouseLeave={() => setHistoryTooltipActive(false)}
                  onPointerDownCapture={() => {
                    if (sidebarCollapsed) setHistoryTooltipActive(true);
                  }}
                >
                  <input
                    aria-label={`选择 ${sessionDisplayTitle(item)}`}
                    checked={selectedSessionIdSet.has(item.id)}
                    className="browser-chat-recent-check"
                    disabled={item.busy || deletingSelectedSessions}
                    onChange={(event) => toggleSessionSelection(item.id, event.currentTarget.checked)}
                    type="checkbox"
                  />
                  <button
                    className="browser-chat-recent-open"
                    data-title={sessionDisplayTitle(item)}
                    disabled={Boolean(loadingSessionId && loadingSessionId !== item.id)}
                    onClick={() => {
                      void loadSession(item.id);
                    }}
                    title={sessionDisplayTitle(item)}
                    type="button"
                  >
                    <MessageSquare className="browser-chat-recent-icon" size={15} />
                    <span>{sessionDisplayTitle(item)}</span>
                    <small>
                      {loadingSessionId === item.id ? <Loader2 className="spin" size={11} /> : null}
                      <span>{loadingSessionId === item.id ? '加载中' : statusLabel(item.status)}</span>
                      {sessionSortTime(item) ? <time dateTime={sessionSortTime(item)}>{formatLogTime(sessionSortTime(item))}</time> : null}
                    </small>
                  </button>
                  <button
                    aria-label="删除历史对话"
                    className="browser-chat-recent-delete"
                    disabled={item.busy || deletingSessionId === item.id || deletingSelectedSessions}
                    onClick={() => void deleteSessionHistory(item.id)}
                    title={item.busy ? '执行中不能删除' : '删除历史对话'}
                    type="button"
                  >
                    {deletingSessionId === item.id ? <Loader2 className="spin" size={13} /> : <Trash2 size={14} />}
                  </button>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p>暂无记录</p>
        )}
      </section>
    );
  }

  const renderChatPane = () => (
    <div className={`${hasMessages ? 'browser-chat-chat-pane has-messages' : 'browser-chat-chat-pane'}${embeddedBrowserActive ? ' embedded-chat' : ''}`}>
      {loadingSessionId ? (
        <div className="browser-chat-inline-loading">
          <Loader2 className="spin" size={15} />
          <span>正在加载对话</span>
        </div>
      ) : null}
      {session ? (
        <button className="browser-chat-close" disabled={session.status === 'closed' || busy} onClick={closeSession} title="结束会话" type="button">
          <Power size={17} />
        </button>
      ) : null}

      {hasMessages ? (
        <BrowserChatMessageList
          availableSkills={skills}
          exportingMessageId={exportingMessageId}
          exportingSelectedMessages={exportingSelectedMessages}
          generatingSkillMessageId={generatingSkillMessageId}
          generatingSkillSelectedMessages={generatingSkillSelectedMessages}
          lastAssistantMessageId={lastAssistantMessageId}
          logIndex={logIndex}
          messages={visibleMessages}
          onBulkExportMessages={exportSelectedMessagesToTestCase}
          onBulkGenerateSkillMessages={generateSelectedMessagesSkill}
          onClearExportSelection={clearExportMessageSelection}
          onExportMessage={exportMessageToTestCase}
          onGenerateSkill={generateMessageSkill}
          onPreviewImage={previewAttachment}
          onResolveToolConfirmation={resolveToolConfirmation}
          onSelectTool={setToolDialog}
          onShowLogs={showMessageLogs}
          onToggleExportSelection={toggleExportMessageSelection}
          pendingToolConfirmation={session?.pendingToolConfirmation}
          resolvingConfirmationAction={resolvingConfirmationAction}
          resolvingConfirmationId={resolvingConfirmationId}
          selectedExportMessageIdSet={selectedExportMessageIdSet}
          selectedExportMessageIds={selectedExportMessageIds}
          sessionId={session?.id}
          sessionBusy={Boolean(session?.busy)}
          stepsByIndex={stepsByIndex}
          totalStepCount={steps.length}
        />
      ) : (
        <div className="browser-chat-hero">
          <h1>今天要做什么？</h1>
        </div>
      )}

      <div className="browser-chat-composer-shell">
        {error || session?.error ? <div className="error">{stripAnsiControlCodes(error || session?.error || '')}</div> : null}
        <BrowserChatComposer
          attachments={attachments}
          availableSkills={skills}
          busy={busy}
          currentBusy={currentBusy}
          imageInputRef={imageInputRef}
          interrupting={interrupting}
          loading={Boolean(loadingSessionId)}
          mode={mode}
          modeLocked={modeLocked}
          modelProvider={modelProvider}
          modelProviderOptions={modelProviderOptions}
          safetyMode={safetyMode}
          onInterrupt={interruptConversation}
          onModelProviderChange={setModelProvider}
          onModeChange={setMode}
          onPreviewAttachment={previewAttachment}
          onRemoveAttachment={removeAttachment}
          onSubmitMessage={sendMessage}
          onSafetyModeChange={setSafetyMode}
          onUploadImages={uploadChatImages}
          resetToken={composerResetToken}
          showStop={Boolean(selectedRunningSession)}
          uploadingImage={uploadingImage}
        />
      </div>
    </div>
  );

  return (
    <section className={sidebarCollapsed ? 'browser-chat-layout sidebar-collapsed' : 'browser-chat-layout'}>
      <aside className="browser-chat-sidebar">
        <div className="browser-chat-brand">
          <strong>WebPilot QA</strong>
          <button
            className="icon-button"
            onClick={() => setSidebarCollapsed((current) => !current)}
            type="button"
            aria-label={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
          >
            <PanelLeft size={17} />
          </button>
        </div>

        <nav className="browser-chat-nav" aria-label="工作模式">
          <button
            aria-label="新对话"
            className={activeView === 'chat' ? 'browser-chat-nav-item active' : 'browser-chat-nav-item'}
            onClick={() => void openChatEntry()}
            title="新对话"
            type="button"
          >
            <MessageSquare size={17} />
            <span>新对话</span>
          </button>
          <button className={activeView === 'target' ? 'browser-chat-nav-item active' : 'browser-chat-nav-item'} onClick={() => setActiveView('target')} type="button">
            <Folder size={17} />
            <span>目标模式</span>
          </button>
          <button className={activeView === 'settings' ? 'browser-chat-nav-item active' : 'browser-chat-nav-item'} onClick={() => setActiveView('settings')} type="button">
            <Settings size={17} />
            <span>设置</span>
          </button>
        </nav>

        {renderSidebarDetail()}

      </aside>

      <main className="browser-chat-main">
        {activeView === 'target' ? (
          <div className="browser-chat-cases-pane">
            <DashboardWorkspace
              groups={groups}
              schedules={schedules}
              selectedGroupId={targetGroupId}
              showBrowserChatAction={false}
              showGroupSidebar={false}
              showSettingsAction={false}
              onSelectedGroupIdChange={setTargetGroupId}
              testCases={testCases}
            />
          </div>
        ) : activeView === 'settings' ? (
          <div className="browser-chat-settings-pane">
            <EnvironmentSettings
              activeTab={settingsTab}
              embedded
              showTabs={false}
              onActiveTabChange={setSettingsTab}
              onRuntimeEnvSaved={() => void loadBrowserRuntimeSettings()}
              onSkillsChanged={() => void loadSkills()}
            />
          </div>
        ) : embeddedBrowserActive ? (
          <div
            className="browser-chat-embedded-workspace"
            ref={embeddedWorkspaceRef}
            style={{ '--embedded-chat-width': `${embeddedChatWidth}px` } as CSSProperties}
          >
            <BrowserChatEmbeddedBrowser
              active={embeddedBrowserViewActive}
              enabled={embeddedBrowserEnabled}
              leftOverlayInset={embeddedBrowserLeftOverlayInset}
              onSelectSession={(nextSessionId) => {
                if (nextSessionId !== activeSessionIdRef.current) void loadSession(nextSessionId);
              }}
              sessionId={session?.id}
            />
            <div
              aria-label="调整对话栏宽度"
              aria-orientation="vertical"
              aria-valuemax={760}
              aria-valuemin={320}
              aria-valuenow={embeddedChatWidth}
              className="browser-chat-embedded-resizer"
              onPointerDown={beginEmbeddedChatResize}
              role="separator"
              title="拖拽调整对话栏宽度"
            >
              <span />
            </div>
            <aside className="browser-chat-embedded-chat-column">
              {renderChatPane()}
            </aside>
          </div>
        ) : (
          <div className={hasMessages ? 'browser-chat-chat-pane has-messages' : 'browser-chat-chat-pane'}>
            {loadingSessionId ? (
              <div className="browser-chat-inline-loading">
                <Loader2 className="spin" size={15} />
                <span>正在加载对话</span>
              </div>
            ) : null}
            {session ? (
              <button className="browser-chat-close" disabled={session.status === 'closed' || busy} onClick={closeSession} title="结束会话" type="button">
                <Power size={17} />
              </button>
            ) : null}

            {hasMessages ? (
              <BrowserChatMessageList
                availableSkills={skills}
                exportingMessageId={exportingMessageId}
                exportingSelectedMessages={exportingSelectedMessages}
                generatingSkillMessageId={generatingSkillMessageId}
                generatingSkillSelectedMessages={generatingSkillSelectedMessages}
                lastAssistantMessageId={lastAssistantMessageId}
                logIndex={logIndex}
                messages={visibleMessages}
                onBulkExportMessages={exportSelectedMessagesToTestCase}
                onBulkGenerateSkillMessages={generateSelectedMessagesSkill}
                onClearExportSelection={clearExportMessageSelection}
                onExportMessage={exportMessageToTestCase}
                onGenerateSkill={generateMessageSkill}
                onPreviewImage={previewAttachment}
                onResolveToolConfirmation={resolveToolConfirmation}
                onSelectTool={setToolDialog}
                onShowLogs={showMessageLogs}
                onToggleExportSelection={toggleExportMessageSelection}
                pendingToolConfirmation={session?.pendingToolConfirmation}
                resolvingConfirmationAction={resolvingConfirmationAction}
                resolvingConfirmationId={resolvingConfirmationId}
                selectedExportMessageIdSet={selectedExportMessageIdSet}
                selectedExportMessageIds={selectedExportMessageIds}
                sessionId={session?.id}
                sessionBusy={Boolean(session?.busy)}
                stepsByIndex={stepsByIndex}
                totalStepCount={steps.length}
              />
            ) : (
              <div className="browser-chat-hero">
                <h1>今天要做什么？</h1>
              </div>
            )}

            <div className="browser-chat-composer-shell">
              {error || session?.error ? <div className="error">{stripAnsiControlCodes(error || session?.error || '')}</div> : null}
              <BrowserChatComposer
                attachments={attachments}
                availableSkills={skills}
                busy={busy}
                currentBusy={currentBusy}
                imageInputRef={imageInputRef}
                interrupting={interrupting}
                loading={Boolean(loadingSessionId)}
                mode={mode}
                modeLocked={modeLocked}
                modelProvider={modelProvider}
                modelProviderOptions={modelProviderOptions}
                safetyMode={safetyMode}
                onInterrupt={interruptConversation}
                onModelProviderChange={setModelProvider}
                onModeChange={setMode}
                onPreviewAttachment={previewAttachment}
                onRemoveAttachment={removeAttachment}
                onSubmitMessage={sendMessage}
                onSafetyModeChange={setSafetyMode}
                onUploadImages={uploadChatImages}
                resetToken={composerResetToken}
                showStop={Boolean(selectedRunningSession)}
                uploadingImage={uploadingImage}
              />
            </div>
          </div>
        )}
      </main>

      {toolDialog ? (
        <div className="modal-overlay" onClick={() => setToolDialog(null)} role="presentation">
          <section className="browser-chat-tool-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="工具调用详情">
            <header>
              <div>
                <h2 title={toolDialog.tool.name}>{browserChatToolLabel(toolDialog.tool.name, t)}</h2>
                <p>步骤 {toolDialog.stepIndex} · 工具调用 {toolDialog.toolIndex + 1}</p>
              </div>
              <button className="icon-button" onClick={() => setToolDialog(null)} type="button" aria-label="关闭">
                <X size={18} />
              </button>
            </header>
            <div className="browser-chat-tool-detail-grid">
              <div>
                <span>状态</span>
                <strong>{toolStatusLabel(toolDialog.tool)}</strong>
              </div>
              <div>
                <span>工具名</span>
                <strong title={toolDialog.tool.name}>{browserChatToolLabel(toolDialog.tool.name, t)}</strong>
              </div>
            </div>
            {toolDialog.tool.reason ? (
              <section className="browser-chat-tool-detail-section">
                <h3>调用理由</h3>
                <p>{toolDialog.tool.reason}</p>
              </section>
            ) : null}
            <section className="browser-chat-tool-detail-section">
              <h3>输入参数</h3>
              <pre>{formatToolPayload(toolDialog.tool.input)}</pre>
            </section>
            <section className="browser-chat-tool-detail-section">
              <h3>输出结果</h3>
              <pre>{formatToolPayload(toolDialog.tool.result)}</pre>
            </section>
            {/* {toolDialogFullDomSnapshot ? (
              <section className="browser-chat-tool-detail-section is-full-dom">
                <h3>
                  完整 DOM 快照
                  {typeof toolDialog.tool.debug?.fullDomSnapshotCharLength === 'number'
                    ? `（${toolDialog.tool.debug.fullDomSnapshotCharLength} 字符）`
                    : ''}
                </h3>
                <pre>{toolDialogFullDomSnapshot}</pre>
              </section>
            ) : null} */}
            {toolDialogDomTree ? (
              <section className="browser-chat-tool-detail-section">
                <h3>
                  模型上下文 DOM 树
                  {toolDialog.tool.debug?.domSnapshotTruncatedForModel ? '（已按上下文限制截断）' : ''}
                </h3>
                <pre>{toolDialogDomTree}</pre>
              </section>
            ) : null}
            {toolDialog.tool.visualAfter ? (
              <section className="browser-chat-tool-detail-section">
                <h3>视觉截图参数</h3>
                <pre>{formatToolPayload(toolDialog.tool.visualAfter)}</pre>
              </section>
            ) : null}
            {toolDialog.tool.screenshots?.length ? (
              <section className="browser-chat-tool-detail-section">
                <h3>截图记录</h3>
                <div className="browser-chat-tool-shot-grid">
                  {toolDialog.tool.screenshots.map((shot, index) => {
                    const url = artifactUrl(shot.path);
                    return (
                      <a
                        className="browser-chat-tool-shot-card"
                        href={url || '#'}
                        key={`${shot.path}-${index}-preview`}
                        onClick={(event) => {
                          if (!url) event.preventDefault();
                        }}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {url ? <img alt={shot.title || screenshotKindLabel(shot.kind)} src={url} /> : null}
                        <span>
                          <strong>{screenshotKindLabel(shot.kind)} · {shot.title || `截图 ${index + 1}`}</strong>
                          <code>{shot.path}</code>
                        </span>
                      </a>
                    );
                  })}
                </div>
                <ol className="browser-chat-tool-shot-list">
                  {toolDialog.tool.screenshots.map((shot, index) => (
                    <li key={`${shot.path}-${index}`}>
                      <strong>{shot.title || shot.kind || `截图 ${index + 1}`}</strong>
                      <code>{shot.path}</code>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}
          </section>
        </div>
      ) : null}

      {logDialogMessageId ? (
        <div className="modal-overlay" onClick={() => setLogDialogMessageId(null)} role="presentation">
          <section className="browser-chat-log-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="执行日志">
            <header>
              <div>
                <h2>执行日志</h2>
                <p>{logDialogMessage ? compactText(logDialogMessage.content, 80) : '当前 AI 消息'}</p>
              </div>
              <button className="icon-button" onClick={() => setLogDialogMessageId(null)} type="button" aria-label="关闭">
                <X size={18} />
              </button>
            </header>
            {logDialogEntries.length ? (
              <BrowserChatVirtualLogList entries={logDialogEntries} />
            ) : (
              <p className="browser-chat-log-empty">暂无日志</p>
            )}
          </section>
        </div>
      ) : null}

      {imagePreview ? (
        <div className="fullscreen-image-viewer" onClick={() => setImagePreview(null)} role="presentation">
          <div className="image-viewer-toolbar" onClick={(event) => event.stopPropagation()}>
            <strong>{imagePreview.name}</strong>
            <button className="icon-button" onClick={() => setImagePreview(null)} type="button" aria-label="关闭">
              <X size={18} />
            </button>
          </div>
          <div className="image-viewer-stage">
            <img alt={imagePreview.name} src={imagePreview.url} onClick={(event) => event.stopPropagation()} />
          </div>
        </div>
      ) : null}

      {groupDialogOpen ? (
        <div className="modal-overlay" onClick={() => setGroupDialogOpen(false)} role="presentation">
          <section className="group-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="创建分组">
            <header>
              <div>
                <h2>{targetGroupId ? '创建子组' : '创建组'}</h2>
                <p>{targetGroupId ? `父级：${groupPath(groups, targetGroupId)}` : '创建根分组'}</p>
              </div>
              <button className="icon-button" onClick={() => setGroupDialogOpen(false)} type="button" aria-label="关闭">
                <X size={18} />
              </button>
            </header>
            <label className="modal-field">
              分组名称
              <input autoFocus className="input" value={groupName} onChange={(event) => setGroupName(event.target.value)} />
            </label>
            <button className="button full-width" disabled={creatingGroup} onClick={() => createGroup(targetGroupId)} type="button">
              {creatingGroup ? <Loader2 className="spin" size={16} /> : null}
              {creatingGroup ? '创建中' : '创建'}
            </button>
          </section>
        </div>
      ) : null}
    </section>
  );
}
