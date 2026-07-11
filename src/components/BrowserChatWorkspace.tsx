'use client';

import { createContext, memo, type CSSProperties, type DragEvent as ReactDragEvent, type FormEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, useCallback, useContext, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
  AppWindow,
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BadgeCheck,
  Bot,
  Brain,
  Braces,
  Bug,
  ChevronDown,
  ClipboardCheck,
  Compass,
  CornerDownLeft,
  CheckCircle2,
  Download,
  FileSearch,
  Folder,
  GalleryHorizontalEnd,
  Gauge,
  Globe,
  History,
  ImageUp,
  Loader2,
  Lock,
  MessageSquare,
  MoreHorizontal,
  Moon,
  MousePointer2,
  Network,
  PanelLeft,
  PanelRight,
  PencilLine,
  Plus,
  Power,
  RefreshCw,
  Route,
  ScanSearch,
  ScrollText,
  SendHorizontal,
  Settings,
  SlidersHorizontal,
  Sparkles,
  FilePlus2,
  SquareArrowOutUpRight,
  SquareTerminal,
  Square,
  Star,
  Sun,
  Trash2,
  Volume2,
  VolumeX,
  Waypoints,
  Workflow,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CustomSelect } from '@/components/CustomSelect';
import { BrowserChatLogDialog } from '@/components/BrowserChatLogDialog';
import { BrowserChatToolDialog } from '@/components/BrowserChatToolDialog';
import { DashboardGroupSidebar, DashboardWorkspace, groupPath } from '@/components/DashboardWorkspace';
import { EnvironmentSettings, environmentSettingsTabs } from '@/components/EnvironmentSettings';
import { NewTestCaseModal } from '@/components/NewTestCaseModal';
import {
  buildBrowserChatAiCycleRenderEntries,
  buildBrowserChatLogIndex,
  buildBrowserChatMessageRenderEntries,
  browserChatAssistantMessageHasVisibleText as modelBrowserChatAssistantMessageHasVisibleText,
  browserChatLogsForMessage,
  type BrowserChatLogIndex as BrowserChatLogIndexModel,
} from '@/components/browser-chat-message-model';
import {
  visibleBrowserChatExecutionLogs,
} from '@/components/browser-chat-log-model';
import { type SettingsTab } from '@/config/settings';
import { useI18n } from '@/i18n/I18nProvider';
import { readApiJson } from '@/lib/api-client';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';
import {
  modelSelectionDiagnosticLabel,
  modelSelectionOptionsForConfig,
  modelSelectionValueForConfig,
  normalizeRuntimeModelConfig,
  parseModelSelectionValue,
  resolveRuntimeModelSelection,
  type RuntimeModelConfig,
} from '@/lib/model-selection';
import { subscribeRealtimeRefresh } from '@/lib/realtime-refresh';
import { useTheme } from '@/theme/ThemeProvider';
import type {
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
  kind?: BrowserChatAttachmentKind;
  sourceUrl?: string;
};

type BrowserChatAttachmentKind = 'image' | 'file' | 'tab';

type EmbeddedBrowserTabDragPayload = {
  groupId?: string;
  id?: string;
  sessionId?: string;
  title?: string;
  url?: string;
};

const BROWSER_CHAT_MAX_REFERENCES = 8;
const WEBPILOT_TAB_DRAG_MIME = 'application/x-webpilot-tab';
const BROWSER_CHAT_INLINE_TOKEN_RE = /\[\[(skill|ref):([^\]]+)\]\]/g;

function inlineTokenId(value: string) {
  return encodeURIComponent(value);
}

function readInlineTokenId(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

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

type BrowserChatLogIndex = BrowserChatLogIndexModel<BrowserChatLogRecord>;

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
  model: string;
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
type BrowserChatMode = 'dom';
type BrowserChatSafetyMode = 'strict' | 'full';
type BrowserChatModelConfig = RuntimeModelConfig;
type BrowserChatToolCall = NonNullable<StepExecutionResult['tools']>[number];

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'webpilotqa.sidebarCollapsed';
const EMBEDDED_CHAT_COLLAPSED_STORAGE_KEY = 'webpilotqa.embeddedChatCollapsed';

function readStoredSidebarCollapsed() {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
}

function writeStoredSidebarCollapsed(collapsed: boolean) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? 'true' : 'false');
}

function readStoredEmbeddedChatCollapsed() {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(EMBEDDED_CHAT_COLLAPSED_STORAGE_KEY) === 'true';
}

function writeStoredEmbeddedChatCollapsed(collapsed: boolean) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(EMBEDDED_CHAT_COLLAPSED_STORAGE_KEY, collapsed ? 'true' : 'false');
}

function hasRunningAssistantMessage(session?: Pick<BrowserChatSession, 'messages'> | null) {
  return Boolean(session?.messages?.some((message) => message.role === 'assistant' && message.status === 'running'));
}

function isBrowserChatSessionRunning(session?: BrowserChatSession | null) {
  return Boolean(session && (session.busy || session.status === 'running' || hasRunningAssistantMessage(session)));
}

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
  audioMuted?: boolean;
  bookmarked?: boolean;
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
  canGoBack?: boolean;
  canGoForward?: boolean;
  groups?: EmbeddedBrowserGroup[];
  libraryPanel?: 'bookmarks' | 'history';
  tabs?: EmbeddedBrowserTab[];
  zoomFactor?: number;
};

type SystemDownloadStatus = 'selecting' | 'pending' | 'downloading' | 'completed' | 'cancelled' | 'failed' | string;

type SystemDownloadItem = {
  completedAt?: number;
  error?: string;
  fileName?: string;
  id: string;
  path?: string;
  progress?: number;
  receivedBytes?: number;
  startedAt?: number;
  status?: SystemDownloadStatus;
  totalBytes?: number;
  updatedAt?: number;
  url?: string;
};

type EmbeddedBrowserBridge = {
  activateTab: (input: { id: string }) => Promise<EmbeddedBrowserState>;
  closeActiveTab: () => Promise<EmbeddedBrowserBridgeResult>;
  closeGroup: (input: { id: string }) => Promise<EmbeddedBrowserState>;
  closeTab: (input: { id: string }) => Promise<EmbeddedBrowserState>;
  createTab: (input: { groupId?: string; sessionId?: string; url?: string }) => Promise<EmbeddedBrowserState>;
  getState: () => Promise<EmbeddedBrowserState>;
  goBack: () => Promise<EmbeddedBrowserState>;
  goForward: () => Promise<EmbeddedBrowserState>;
  moveTab: (input: { id: string; position: 'before' | 'after'; targetId: string }) => Promise<EmbeddedBrowserState>;
  navigate: (input: { groupId?: string; sessionId?: string; url: string }) => Promise<EmbeddedBrowserBridgeResult>;
  onStateChange: (listener: (state: EmbeddedBrowserState) => void) => () => void;
  reload: () => Promise<EmbeddedBrowserState>;
  reset: () => Promise<EmbeddedBrowserBridgeResult>;
  setBounds: (bounds: EmbeddedBrowserBounds) => Promise<EmbeddedBrowserBridgeResult>;
  setLibraryPanel: (input: { panel: 'bookmarks' | 'history' | null }) => Promise<EmbeddedBrowserState>;
  setTabMuted: (input: { id: string; muted?: boolean }) => Promise<EmbeddedBrowserState>;
  setVisible: (input: {
    bounds?: EmbeddedBrowserBounds;
    createIfMissing?: boolean;
    groupId?: string;
    id?: string;
    sessionId?: string;
    url?: string;
    visible: boolean;
  }) => Promise<EmbeddedBrowserState>;
  toggleBookmark: () => Promise<EmbeddedBrowserState>;
};

declare global {
  interface Window {
    webPilotEmbeddedBrowser?: EmbeddedBrowserBridge;
  }
}

function statusLabel(status: string) {
  return status === 'running' ? '进行中' : '已完成';
}

function SettingsTabIcon({ tab }: { tab: SettingsTab }) {
  if (tab === 'model') return <Bot size={15} />;
  if (tab === 'browser') return <PanelLeft size={15} />;
  if (tab === 'runtime') return <SquareTerminal size={15} />;
  if (tab === 'skills') return <Braces size={15} />;
  if (tab === 'memory') return <Brain size={15} />;
  if (tab === 'dom-test') return <ScanSearch size={15} />;
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

function asRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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

const BrowserChatReasoningVisibilityContext = createContext(false);

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
    getHttpRequests: '检查请求',
    keyboard: '键盘操作',
    listTabs: '扫描标签页',
    manageVisualContext: '整理视觉上下文',
    mouse: '鼠标操作',
    openPage: '导航页面',
    reportState: '确认状态',
    searchSnapshot: '搜索页面快照',
    selectReferenceScreenshots: '引用截图',
    switchTab: '切换标签',
    takeScreenshot: '截屏取证',
    takeSnapshot: '读取页面快照',
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
  if (name === 'keyboard') return [toolInputValue(record, ['action']), toolInputValue(record, ['text', 'key', 'uid'])].filter(Boolean).join(' · ');
  if (name === 'openPage') return toolInputValue(record, ['url']);
  if (name === 'switchTab') return toolInputValue(record, ['index']);
  if (name === 'waitForPage') return toolInputValue(record, ['ms']);
  if (name === 'waitForHumanVerification') return toolInputValue(record, ['maxMs']);
  if (name === 'mouse') {
    const action = toolInputValue(record, ['action']);
    const target = toolInputValue(record, ['uid', 'x_thousandth']);
    const deltaY = toolInputValue(record, ['deltaY']);
    return [action, target, deltaY ? `Y ${deltaY}` : ''].filter(Boolean).join(' · ');
  }
  if (name === 'takeSnapshot') return toolInputValue(record, ['mode', 'cursor']);
  if (name === 'searchSnapshot') return toolInputValue(record, ['query']);
  if (name === 'takeScreenshot') return toolInputValue(record, ['capture']);
  if (name === 'selectReferenceScreenshots') {
    const ids = Array.isArray(record.ids) ? record.ids : [];
    return ids.length ? `${ids.length} 张` : '';
  }
  if (name === 'manageVisualContext') return toolInputValue(record, ['action', 'manageReason']);
  if (name === 'reportState') return toolInputValue(record, ['action', 'actual', 'status']);
  if (lower.includes('fill')) return summarizeToolFields(record.fields) || toolInputValue(record, ['text', 'content', 'value']);
  if (lower.includes('click') || lower.includes('hover') || lower.includes('drag')) {
    return toolInputValue(record, ['text', 'targetVisual', 'targetText', 'id', 'fromId']);
  }
  if (lower.includes('find')) return toolInputValue(record, ['targetText', 'scopeId']);
  if (lower.includes('text')) return toolInputValue(record, ['text', 'targetText', 'id']);
  return toolInputValue(record, ['url', 'text', 'uid', 'query', 'action', 'status']);
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
  void value;
  return 'dom';
}

function normalizeSafetyMode(value?: string): BrowserChatSafetyMode {
  return value === 'full' ? 'full' : 'strict';
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
  const modelSelection = resolveRuntimeModelSelection(null, { model: session.model, provider: session.modelProvider });
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
    modelProvider: modelSelection.provider,
    model: modelSelection.model,
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

const BROWSER_CHAT_DOWNLOAD_EXTENSIONS = new Set([
  '.7z',
  '.apk',
  '.bin',
  '.bz2',
  '.csv',
  '.deb',
  '.dmg',
  '.doc',
  '.docx',
  '.exe',
  '.gz',
  '.ipa',
  '.msi',
  '.pkg',
  '.ppt',
  '.pptx',
  '.rar',
  '.rpm',
  '.tar',
  '.tgz',
  '.xls',
  '.xlsx',
  '.xz',
  '.zip',
]);

function normalizeBrowserChatMarkdownHref(href: string) {
  const trimmed = href.trim();
  if (!trimmed) return '';
  if (/^[./?#/]/.test(trimmed)) {
    try {
      return new URL(trimmed, typeof window === 'undefined' ? 'http://127.0.0.1/' : window.location.href).toString();
    } catch {
      return '';
    }
  }
  return normalizeEmbeddedBrowserAddress(trimmed);
}

function isBrowserChatDownloadHref(href: string) {
  const normalizedHref = normalizeBrowserChatMarkdownHref(href);
  if (!normalizedHref) return false;
  try {
    const parsed = new URL(normalizedHref);
    const downloadValue = parsed.searchParams.get('download');
    if (downloadValue !== null && !/^(0|false|no)$/i.test(downloadValue)) return true;
    const attachmentValue = [
      parsed.searchParams.get('content-disposition'),
      parsed.searchParams.get('response-content-disposition'),
    ].filter(Boolean).join(' ').toLowerCase();
    if (attachmentValue.includes('attachment')) return true;
    const pathname = decodeURIComponent(parsed.pathname || '').toLowerCase();
    const extension = pathname.match(/\.([a-z0-9]{1,8})$/)?.[0] || '';
    return BROWSER_CHAT_DOWNLOAD_EXTENSIONS.has(extension);
  } catch {
    return false;
  }
}

function handleBrowserChatMarkdownLinkClick(event: ReactMouseEvent<HTMLAnchorElement>, href?: string) {
  const rawHref = String(href || '').trim();
  if (!rawHref || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (rawHref.startsWith('#') || /^(javascript|mailto|tel):/i.test(rawHref)) return;
  const url = normalizeBrowserChatMarkdownHref(rawHref);
  if (!url) return;
  if (isBrowserChatDownloadHref(rawHref)) {
    const systemBridge = typeof window === 'undefined' ? undefined : window.webPilotSystem;
    if (!systemBridge?.downloadUrl) return;
    event.preventDefault();
    systemBridge.downloadUrl({ url }).catch(() => undefined);
    return;
  }
  const bridge = typeof window === 'undefined' ? undefined : window.webPilotEmbeddedBrowser;
  if (!bridge) return;
  event.preventDefault();
  bridge.createTab({ url }).catch(() => undefined);
}

const BrowserChatMarkdown = memo(function BrowserChatMarkdown({ markdown }: { markdown: string }) {
  const normalizedMarkdown = useMemo(() => normalizeChatMarkdown(markdown), [markdown]);
  return (
    <div className="browser-chat-agent-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, href, onClick, ...props }) => (
            <a
              {...props}
              href={href}
              onClick={(event) => {
                onClick?.(event);
                handleBrowserChatMarkdownLinkClick(event, href);
              }}
              target="_blank"
              rel="noopener noreferrer"
            />
          ),
        }}
      >
        {normalizedMarkdown}
      </ReactMarkdown>
    </div>
  );
});

function formatDownloadBytes(value?: number) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
  return `${Math.round(bytes / 1024 / 1024 / 102.4) / 10} GB`;
}

function browserChatDownloadStatusLabel(status?: SystemDownloadStatus) {
  if (status === 'selecting') return '选择保存目录';
  if (status === 'pending') return '准备下载';
  if (status === 'downloading') return '下载中';
  if (status === 'completed') return '已完成';
  if (status === 'cancelled') return '已取消';
  if (status === 'failed') return '下载失败';
  return '下载';
}

function browserChatDownloadPercent(download: SystemDownloadItem) {
  if (typeof download.progress === 'number' && Number.isFinite(download.progress)) {
    return Math.max(0, Math.min(100, Math.round(download.progress * 100)));
  }
  if (download.status === 'completed') return 100;
  return undefined;
}

function BrowserChatDownloadStatusIcon({ status }: { status?: SystemDownloadStatus }) {
  if (status === 'completed') return <CheckCircle2 size={15} />;
  if (status === 'failed') return <AlertCircle size={15} />;
  if (status === 'downloading' || status === 'pending' || status === 'selecting') return <Loader2 className="spin" size={15} />;
  return <Download size={15} />;
}

const BrowserChatDownloadCenter = memo(function BrowserChatDownloadCenter({
  downloads,
  open,
  onClose,
  onToggle,
}: {
  downloads: SystemDownloadItem[];
  open: boolean;
  onClose: () => void;
  onToggle: () => void;
}) {
  const activeCount = downloads.filter((download) => download.status === 'selecting' || download.status === 'pending' || download.status === 'downloading').length;
  const recentDownloads = downloads.slice(0, 12);
  return (
    <div className="browser-chat-download-center">
      <button
        aria-expanded={open}
        aria-label="下载"
        className={activeCount ? 'ui-icon-button browser-chat-download-button active' : 'ui-icon-button browser-chat-download-button'}
        onClick={onToggle}
        title="下载"
        type="button"
      >
        <Download size={17} />
        {activeCount ? <span className="browser-chat-download-badge">{activeCount}</span> : null}
      </button>
      {open ? (
        <div className="browser-chat-download-popover" role="dialog" aria-label="下载进度">
          <header>
            <strong>下载</strong>
            <button className="ui-icon-button" onClick={onClose} type="button" aria-label="关闭下载面板">
              <X size={15} />
            </button>
          </header>
          {recentDownloads.length ? (
            <ol className="browser-chat-download-list">
              {recentDownloads.map((download) => {
                const percent = browserChatDownloadPercent(download);
                const received = formatDownloadBytes(download.receivedBytes);
                const total = formatDownloadBytes(download.totalBytes);
                const progressWidth = percent === undefined ? (download.status === 'downloading' ? 18 : 0) : percent;
                return (
                  <li className={`browser-chat-download-item ${download.status || 'pending'}`} key={download.id}>
                    <div className="browser-chat-download-item-head">
                      <span className="browser-chat-download-status-icon">
                        <BrowserChatDownloadStatusIcon status={download.status} />
                      </span>
                      <div>
                        <strong>{download.fileName || 'download'}</strong>
                        <span>{browserChatDownloadStatusLabel(download.status)}{percent !== undefined ? ` · ${percent}%` : ''}</span>
                      </div>
                    </div>
                    <div className="browser-chat-download-progress" aria-hidden="true">
                      <span style={{ width: `${progressWidth}%` }} />
                    </div>
                    <div className="browser-chat-download-meta">
                      <span>{total ? `${received || '0 B'} / ${total}` : (received || '')}</span>
                      {download.error ? <span className="error">{download.error}</span> : null}
                      {download.path ? <span title={download.path}>{download.path}</span> : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="browser-chat-download-empty">暂无下载</div>
          )}
        </div>
      ) : null}
    </div>
  );
});

function formatAttachmentSize(size?: number) {
  if (!size || !Number.isFinite(size)) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / 1024 / 102.4) / 10} MB`;
}

function browserChatAttachmentKind(attachment: BrowserChatAttachment): BrowserChatAttachmentKind {
  if (attachment.kind === 'tab' || attachment.type === WEBPILOT_TAB_DRAG_MIME) return 'tab';
  if (attachment.kind === 'image' || attachment.type.startsWith('image/')) return 'image';
  return 'file';
}

function browserChatReferenceLabel(kind: BrowserChatAttachmentKind) {
  if (kind === 'image') return '图片';
  if (kind === 'tab') return '标签页';
  return '文件';
}

function browserChatReferenceMeta(attachment: BrowserChatAttachment, kind: BrowserChatAttachmentKind) {
  if (kind === 'tab') return compactText(attachment.sourceUrl || attachment.url || '标签页', 58);
  return formatAttachmentSize(attachment.size) || browserChatReferenceLabel(kind);
}

function BrowserChatReferenceIcon({ kind }: { kind: BrowserChatAttachmentKind }) {
  if (kind === 'image') return <ImageUp size={14} />;
  if (kind === 'tab') return <AppWindow size={14} />;
  return <FileSearch size={14} />;
}

function inlineTokenSvg(paths: string) {
  return `<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">${paths}</svg>`;
}

function inlineSkillIconSvg() {
  return inlineTokenSvg('<path d="M8 3 4 7l4 4"/><path d="m16 3 4 4-4 4"/><path d="M14 21l4-18"/><path d="M10 21 6 3"/>');
}

function inlineReferenceIconSvg(kind: BrowserChatAttachmentKind) {
  if (kind === 'image') {
    return inlineTokenSvg('<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>');
  }
  if (kind === 'tab') {
    return inlineTokenSvg('<rect width="18" height="14" x="3" y="5" rx="2"/><path d="M3 9h18"/><path d="M8 5v4"/>');
  }
  return inlineTokenSvg('<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6"/><path d="m9 15 2 2 4-4"/>');
}

function browserChatReferenceKey(attachment: BrowserChatAttachment) {
  const kind = browserChatAttachmentKind(attachment);
  if (kind === 'tab') return `tab:${attachment.sourceUrl || attachment.url || attachment.id}`;
  if (attachment.path) return `path:${attachment.path}`;
  return `${kind}:${attachment.name}:${attachment.url}`;
}

function parseEmbeddedBrowserTabDragPayload(value: string): EmbeddedBrowserTabDragPayload | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as EmbeddedBrowserTabDragPayload;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    return undefined;
  }
  return undefined;
}

function browserChatTabReferenceFromDataTransfer(dataTransfer: DataTransfer) {
  const payload = parseEmbeddedBrowserTabDragPayload(dataTransfer.getData(WEBPILOT_TAB_DRAG_MIME));
  if (!payload?.id && !payload?.url && !payload?.title) return undefined;
  const rawUrl = String(payload.url || '').trim();
  const sourceUrl = rawUrl && !/^data:text\/html/i.test(rawUrl) ? rawUrl : '';
  const title = String(payload.title || '').trim();
  const name = title && !/^WebPilot Embedded Browser$/i.test(title) ? title : (sourceUrl || '新建标签页');
  return {
    id: temporaryId('tab_ref'),
    kind: 'tab' as const,
    name: compactText(name, 120),
    path: '',
    sourceUrl,
    type: WEBPILOT_TAB_DRAG_MIME,
    url: sourceUrl,
  };
}

function dataTransferHasBrowserChatReferences(dataTransfer: DataTransfer) {
  const types = Array.from(dataTransfer.types || []);
  return types.includes(WEBPILOT_TAB_DRAG_MIME) || Array.from(dataTransfer.items || []).some((item) => item.kind === 'file');
}

const BrowserChatReferenceChip = memo(function BrowserChatReferenceChip({
  attachment,
  className = '',
  onPreview,
}: {
  attachment: BrowserChatAttachment;
  className?: string;
  onPreview: (attachment: BrowserChatAttachment) => void;
}) {
  const kind = browserChatAttachmentKind(attachment);
  const label = browserChatReferenceLabel(kind);
  const children = (
    <>
      <span className={`browser-chat-reference-icon ${kind}`}>
        <BrowserChatReferenceIcon kind={kind} />
      </span>
      <span className="browser-chat-reference-name">{attachment.name || label}</span>
    </>
  );
  return (
    <span className={`browser-chat-reference-chip ${kind}${className ? ` ${className}` : ''}`} title={browserChatReferenceMeta(attachment, kind)}>
      {kind === 'image' ? (
        <button
          aria-label={`放大查看 ${attachment.name}`}
          className="browser-chat-reference-main"
          onClick={() => onPreview(attachment)}
          type="button"
        >
          {children}
        </button>
      ) : attachment.url ? (
        <a
          className="browser-chat-reference-main"
          href={attachment.url}
          onClick={(event) => handleBrowserChatMarkdownLinkClick(event, attachment.url)}
          rel="noopener noreferrer"
          target="_blank"
          title={attachment.sourceUrl || attachment.url}
        >
          {children}
        </a>
      ) : (
        <span className="browser-chat-reference-main">{children}</span>
      )}
    </span>
  );
});

function BrowserChatSkillChip({ skill }: { skill: { description: string; id: string; title: string } }) {
  return (
    <span className="browser-chat-message-skill" title={skill.description}>
      <Braces size={13} />
      <span>{skill.title}</span>
    </span>
  );
}

function BrowserChatInlineMessageContent({
  attachments,
  content,
  onPreviewImage,
  skills,
}: {
  attachments?: BrowserChatAttachment[];
  content: string;
  onPreviewImage: (attachment: BrowserChatAttachment) => void;
  skills: Array<{ description: string; id: string; title: string }>;
}) {
  const attachmentsById = useMemo(() => new Map((attachments || []).map((attachment) => [attachment.id, attachment])), [attachments]);
  const skillsById = useMemo(() => new Map(skills.map((skill) => [skill.id, skill])), [skills]);
  const usedAttachmentIds = new Set<string>();
  const usedSkillIds = new Set<string>();
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let matchIndex = 0;
  BROWSER_CHAT_INLINE_TOKEN_RE.lastIndex = 0;
  for (const match of content.matchAll(BROWSER_CHAT_INLINE_TOKEN_RE)) {
    const start = match.index ?? 0;
    if (start > lastIndex) nodes.push(content.slice(lastIndex, start));
    const type = match[1];
    const id = readInlineTokenId(match[2] || '');
    if (type === 'ref') {
      const attachment = attachmentsById.get(id);
      if (attachment) {
        usedAttachmentIds.add(id);
        nodes.push(<BrowserChatReferenceChip attachment={attachment} className="inline" key={`ref-${id}-${matchIndex}`} onPreview={onPreviewImage} />);
      }
    } else {
      const skill = skillsById.get(id);
      if (skill) {
        usedSkillIds.add(id);
        nodes.push(<BrowserChatSkillChip key={`skill-${id}-${matchIndex}`} skill={skill} />);
      }
    }
    lastIndex = start + match[0].length;
    matchIndex += 1;
  }
  if (lastIndex < content.length) nodes.push(content.slice(lastIndex));
  for (const skill of skills) {
    if (!usedSkillIds.has(skill.id)) nodes.push(' ', <BrowserChatSkillChip key={`skill-fallback-${skill.id}`} skill={skill} />);
  }
  for (const attachment of attachments || []) {
    if (!usedAttachmentIds.has(attachment.id)) nodes.push(' ', <BrowserChatReferenceChip attachment={attachment} className="inline" key={`ref-fallback-${attachment.id}`} onPreview={onPreviewImage} />);
  }
  if (!nodes.length) return null;
  return <p className="browser-chat-message-inline-content">{nodes}</p>;
}

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
  const showReasoning = useContext(BrowserChatReasoningVisibilityContext);
  const { output } = cycle;
  if (!output.tools.length && !output.texts.length && (!showReasoning || !output.reasoning.length)) return null;
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
      {showReasoning && output.reasoning.length ? (
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

const BrowserChatExecutedCycleGroup = memo(function BrowserChatExecutedCycleGroup({
  cycles,
  logs,
  onResolveToolConfirmation,
  onSelectTool,
  pendingToolConfirmation,
  resolvingConfirmationAction,
  resolvingConfirmationId,
  toolDetails,
}: {
  cycles: BrowserChatAiOutputCycle[];
  logs: BrowserChatLogRecord[];
  onResolveToolConfirmation?: (confirmationId: string, action: BrowserChatToolConfirmationAction) => void | Promise<void>;
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  pendingToolConfirmation?: BrowserChatToolConfirmation;
  resolvingConfirmationAction?: BrowserChatToolConfirmationAction | null;
  resolvingConfirmationId?: string | null;
  toolDetails: Map<string, BrowserChatToolDetail>;
}) {
  const showReasoning = useContext(BrowserChatReasoningVisibilityContext);
  const toolCount = cycles.reduce((count, cycle) => count + cycle.output.tools.length, 0);
  const reasoningCount = showReasoning ? cycles.reduce((count, cycle) => count + cycle.output.reasoning.length, 0) : 0;
  const hasPendingConfirmation = cycles.some((cycle) => (
    cycle.output.tools.some((tool, index) => {
      const toolDetail = toolDetails.get(aiCycleToolKey(cycle.id, index));
      return Boolean(pendingConfirmationForTool({
        pending: pendingToolConfirmation,
        stepIndex: toolDetail?.stepIndex ?? cycle.stepIndex,
        toolName: tool.name,
        toolOk: toolDetail?.tool.ok,
      }));
    })
  ));
  const meta = [
    toolCount ? `${toolCount} 个工具` : '',
    reasoningCount ? `${reasoningCount} 条思维链` : '',
  ].filter(Boolean).join(' · ');

  return (
    <details className="browser-chat-ai-line-collapse browser-chat-executed-collapse" open={hasPendingConfirmation || undefined}>
      <summary className="browser-chat-ai-collapse-summary" title={meta || undefined}>
        <SquareTerminal size={14} />
        <span>已执行</span>
        {meta ? <small>{meta}</small> : null}
        <ChevronDown className="browser-chat-ai-tool-chevron" size={14} />
      </summary>
      <div className="browser-chat-executed-body">
        {cycles.map((cycle) => (
          <div className="browser-chat-executed-entry" key={cycle.id}>
            <BrowserChatAiCycleLine
              cycle={cycle}
              logs={logs}
              onResolveToolConfirmation={onResolveToolConfirmation}
              onSelectTool={onSelectTool}
              pendingToolConfirmation={pendingToolConfirmation}
              resolvingConfirmationAction={resolvingConfirmationAction}
              resolvingConfirmationId={resolvingConfirmationId}
              toolDetails={toolDetails}
            />
          </div>
        ))}
      </div>
    </details>
  );
});

function isManualVerificationStatusText(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return /^AI requested a manual verification pause\. Ask the user to inspect the browser and continue after completing any required verification\.$/i.test(normalized)
    || /^Manual verification is visible \(.+\)\. The run UI should pause and wait for the user to complete it\.$/i.test(normalized)
    || /^已暂停自动操作[：:]/.test(normalized)
    || /^已暂停，等待您检查浏览器/.test(normalized);
}

const BrowserChatManualVerificationCard = memo(function BrowserChatManualVerificationCard() {
  return (
    <section className="browser-chat-manual-verification" role="status">
      <span aria-hidden="true" className="browser-chat-manual-verification-icon"><Lock size={18} /></span>
      <div>
        <strong>需要人工完成验证</strong>
        <p>请在浏览器中完成验证码、登录/安全验证或其他需要本人确认的步骤。</p>
        <small>完成后发送“验证已完成”，我会重新读取当前页面并继续。</small>
      </div>
    </section>
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
  const showReasoning = useContext(BrowserChatReasoningVisibilityContext);
  const autoExpandedToolsRef = useRef(false);
  const [toolsExpanded, setToolsExpanded] = useState(() => running);
  const finalText = stringFromUnknown(message.content);
  const aiOutputCycles = useMemo(() => aiOutputCyclesFromLogs(logs)
    .map((cycle) => (showReasoning ? cycle : {
      ...cycle,
      output: { ...cycle.output, reasoning: [] },
    }))
    .filter((cycle) => hasAiOutputView(cycle.output)), [logs, showReasoning]);
  const aiOutputCycleEntries = useMemo(() => buildBrowserChatAiCycleRenderEntries(aiOutputCycles), [aiOutputCycles]);
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
  const manualVerificationPaused = steps.some((step) => (step.tools || []).some((tool) => tool.name === 'waitForHumanVerification'))
    || aiOutputCycles.some((cycle) => cycle.output.tools.some((tool) => tool.name === 'waitForHumanVerification'));
  const hasFinalText = Boolean(finalText.trim());
  const hideManualVerificationStatusText = manualVerificationPaused && isManualVerificationStatusText(finalText);
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
      {aiOutputCycleEntries.map((entry) => (
        entry.kind === 'executed' ? (
          <BrowserChatExecutedCycleGroup
            cycles={entry.cycles}
            key={entry.id}
            logs={logs}
            onResolveToolConfirmation={onResolveToolConfirmation}
            onSelectTool={onSelectTool}
            pendingToolConfirmation={pendingToolConfirmation}
            resolvingConfirmationAction={resolvingConfirmationAction}
            resolvingConfirmationId={resolvingConfirmationId}
            toolDetails={aiCycleToolDetails}
          />
        ) : (
          <BrowserChatAiCycleLine
            cycle={entry.cycle}
            key={entry.cycle.id}
            logs={logs}
            onResolveToolConfirmation={onResolveToolConfirmation}
            onSelectTool={onSelectTool}
            pendingToolConfirmation={pendingToolConfirmation}
            resolvingConfirmationAction={resolvingConfirmationAction}
            resolvingConfirmationId={resolvingConfirmationId}
            toolDetails={aiCycleToolDetails}
          />
        )
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
      {manualVerificationPaused ? <BrowserChatManualVerificationCard /> : null}
      {hasFinalText && !hideManualVerificationStatusText && !aiOutputTextSet.has(finalText.replace(/\s+/g, ' ').trim()) ? renderText(finalText, 'final-text') : null}
      {!hasFinalText && !shouldShowStepTimeline ? (
        <p className="browser-chat-agent-empty">{running ? 'AI 正在处理当前请求。' : 'AI 已完成本轮操作，未返回额外文本。'}</p>
      ) : null}
    </div>
  );
});

const BrowserChatMessageItem = memo(function BrowserChatMessageItem({
  skillsById,
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
  skillsById: Map<string, SkillRecord>;
  totalStepCount: number;
}) {
  const operationRunning = item.role === 'assistant' && (item.status === 'running' || Boolean(sessionBusy && item.id === lastAssistantMessageId));
  const canExportMessage = item.role === 'assistant' && item.status !== 'running' && (itemSteps.length > 0 || totalStepCount > 0);
  const actionDisabled = Boolean(exportingMessageId || generatingSkillMessageId) || exportingSelectedMessages || generatingSkillSelectedMessages;
  const messageSkills = useMemo(() => {
    return Array.from(new Set(item.skillIds || [])).map((skillId) => {
      const skill = skillsById.get(skillId);
      return {
        id: skillId,
        title: skill?.title || skillId,
        description: skill?.description || 'Skill',
      };
    });
  }, [item.skillIds, skillsById]);

  return (
    <article className={`browser-chat-message ${item.role}`}>
      <div>
        {item.role === 'assistant' ? (
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
        ) : (
          <>
            <BrowserChatInlineMessageContent
              attachments={item.attachments}
              content={item.content}
              onPreviewImage={onPreviewImage}
              skills={messageSkills}
            />
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

function browserChatAssistantMessageHasVisibleText(message: BrowserChatMessage, logs: BrowserChatLogRecord[]) {
  return modelBrowserChatAssistantMessageHasVisibleText(
    message,
    logs,
    (sourceLogs) => aiOutputCyclesFromLogs(sourceLogs).flatMap((cycle) => cycle.output.texts),
  );
}

const BrowserChatExecutedGroup = memo(function BrowserChatExecutedGroup({
  items,
  lastAssistantMessageId,
  logIndex,
  onResolveToolConfirmation,
  onSelectTool,
  pendingToolConfirmation,
  resolvingConfirmationAction,
  resolvingConfirmationId,
  sessionBusy,
  stepsByIndex,
}: {
  items: BrowserChatMessage[];
  lastAssistantMessageId?: string;
  logIndex: BrowserChatLogIndex;
  onResolveToolConfirmation?: (confirmationId: string, action: BrowserChatToolConfirmationAction) => void | Promise<void>;
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  pendingToolConfirmation?: BrowserChatToolConfirmation;
  resolvingConfirmationAction?: BrowserChatToolConfirmationAction | null;
  resolvingConfirmationId?: string | null;
  sessionBusy: boolean;
  stepsByIndex: Map<number, StepExecutionResult>;
}) {
  const itemViews = items.map((item) => {
    const steps = (item.stepIndexes || [])
      .map((stepIndex) => stepsByIndex.get(stepIndex))
      .filter((step): step is StepExecutionResult => Boolean(step));
    return {
      item,
      logs: browserChatLogsForMessage(item, logIndex),
      running: item.status === 'running' || Boolean(sessionBusy && item.id === lastAssistantMessageId),
      steps,
    };
  });
  const groupRunning = itemViews.some((item) => item.running);
  const groupHasPendingConfirmation = Boolean(pendingToolConfirmation && items.some((item) => item.id === pendingToolConfirmation.messageId));
  const toolCount = itemViews.reduce((count, item) => (
    count + item.steps.reduce((stepCount, step) => stepCount + (step.tools || []).length, 0)
  ), 0);
  const summaryMeta = toolCount ? `${toolCount} 个工具` : `${items.length} 轮`;

  return (
    <article className="browser-chat-message assistant browser-chat-executed-message">
      <div>
        <details className="browser-chat-ai-line-collapse browser-chat-executed-collapse" open={groupRunning || groupHasPendingConfirmation || undefined}>
          <summary className="browser-chat-ai-collapse-summary">
            <SquareTerminal size={14} />
            <span>已执行</span>
            <small>{summaryMeta}</small>
            <ChevronDown className="browser-chat-ai-tool-chevron" size={14} />
          </summary>
          <div className="browser-chat-executed-body">
            {itemViews.map(({ item, logs, running, steps }) => (
              <div className="browser-chat-executed-entry" key={item.id}>
                <BrowserChatAssistantTimeline
                  logs={logs}
                  message={item}
                  onResolveToolConfirmation={onResolveToolConfirmation}
                  onSelectTool={onSelectTool}
                  pendingToolConfirmation={pendingToolConfirmation?.messageId === item.id ? pendingToolConfirmation : undefined}
                  resolvingConfirmationAction={resolvingConfirmationAction}
                  resolvingConfirmationId={resolvingConfirmationId}
                  running={running}
                  steps={steps}
                />
              </div>
            ))}
          </div>
        </details>
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
  const skillsById = useMemo(() => new Map(availableSkills.map((skill) => [skill.id, skill])), [availableSkills]);
  const renderEntries = useMemo(
    () => buildBrowserChatMessageRenderEntries(messages, logIndex, browserChatAssistantMessageHasVisibleText),
    [logIndex, messages],
  );
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
      {renderEntries.map((entry) => {
        if (entry.kind === 'executed-group') {
          return (
            <BrowserChatExecutedGroup
              items={entry.items}
              key={entry.id}
              lastAssistantMessageId={lastAssistantMessageId}
              logIndex={logIndex}
              onResolveToolConfirmation={onResolveToolConfirmation}
              onSelectTool={onSelectTool}
              pendingToolConfirmation={pendingToolConfirmation}
              resolvingConfirmationAction={resolvingConfirmationAction}
              resolvingConfirmationId={resolvingConfirmationId}
              sessionBusy={sessionBusy}
              stepsByIndex={stepsByIndex}
            />
          );
        }
        const item = entry.item;
        const itemSteps = (item.stepIndexes || [])
          .map((stepIndex) => stepsByIndex.get(stepIndex))
          .filter((step): step is StepExecutionResult => Boolean(step));
        const itemLogs = item.role === 'assistant' ? browserChatLogsForMessage(item, logIndex) : [];
        return (
          <BrowserChatMessageItem
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
            skillsById={skillsById}
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
  modelSelection,
  modelSelectionTitle,
  modelSelectionOptions,
  safetyMode,
  onInterrupt,
  onModelSelectionChange,
  onModeChange,
  onRemoveAttachment,
  onSubmitMessage,
  onSafetyModeChange,
  onAddReferences,
  onUploadFiles,
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
  modelSelection: string;
  modelSelectionTitle: string;
  modelSelectionOptions: Array<{ description?: string; group?: string; label: string; selectedLabel?: string; value: string }>;
  safetyMode: BrowserChatSafetyMode;
  onInterrupt: () => void | Promise<void>;
  onModelSelectionChange: (selection: { provider: ModelProvider; model: string }) => void;
  onModeChange: (mode: BrowserChatMode) => void;
  onRemoveAttachment: (id: string) => void;
  onSubmitMessage: (content: string, skillIds: string[], attachments: BrowserChatAttachment[]) => Promise<boolean>;
  onSafetyModeChange: (mode: BrowserChatSafetyMode) => void;
  onAddReferences: (attachments: BrowserChatAttachment[]) => BrowserChatAttachment[];
  onUploadFiles: (files: File[]) => Promise<BrowserChatAttachment[]>;
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
  const attachmentsById = useMemo(() => new Map(attachments.map((attachment) => [attachment.id, attachment])), [attachments]);

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
      if (node.dataset.skillId || node.dataset.attachmentId) return ' ';
      if (node.tagName === 'BR') return '\n';
      return Array.from(node.childNodes).map(walk).join('');
    };
    return Array.from(root.childNodes).map(walk).join('').replace(/\u00A0/g, ' ');
  }, []);

  const attachmentFromToken = useCallback((node: HTMLElement) => {
    const attachmentId = node.dataset.attachmentId || '';
    if (!attachmentId) return undefined;
    const existing = attachmentsById.get(attachmentId);
    if (existing) return existing;
    const raw = node.dataset.attachmentJson;
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as BrowserChatAttachment;
      return parsed?.id ? parsed : undefined;
    } catch {
      return undefined;
    }
  }, [attachmentsById]);

  const editorContentForSubmit = useCallback((root: HTMLElement | null) => {
    if (!root) return '';
    const walk = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
      if (!(node instanceof HTMLElement)) return '';
      if (node.dataset.skillId) return ` [[skill:${inlineTokenId(node.dataset.skillId)}]] `;
      if (node.dataset.attachmentId) return ` [[ref:${inlineTokenId(node.dataset.attachmentId)}]] `;
      if (node.tagName === 'BR') return '\n';
      return Array.from(node.childNodes).map(walk).join('');
    };
    return Array.from(root.childNodes).map(walk).join('').replace(/\u00A0/g, ' ');
  }, []);

  const editorAttachmentsForSubmit = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return [];
    const seen = new Set<string>();
    const next: BrowserChatAttachment[] = [];
    editor.querySelectorAll<HTMLElement>('[data-attachment-id]').forEach((node) => {
      const attachment = attachmentFromToken(node);
      if (!attachment || seen.has(attachment.id)) return;
      seen.add(attachment.id);
      next.push(attachment);
    });
    return next;
  }, [attachmentFromToken]);

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
    const content = editorContentForSubmit(editorRef.current).trim();
    const nextAttachments = editorAttachmentsForSubmit();
    if ((!content && !nextAttachments.length && !selectedSkillIds.length) || currentBusy || loading || uploadingImage) return;
    const sent = await onSubmitMessage(content, selectedSkillIds, nextAttachments);
    if (sent) {
      setDraft('');
      setSelectedSkillIds([]);
      if (editorRef.current) editorRef.current.innerHTML = '';
    }
  }, [currentBusy, editorAttachmentsForSubmit, editorContentForSubmit, loading, onSubmitMessage, selectedSkillIds, uploadingImage]);

  function handleReferenceDragOver(event: ReactDragEvent<HTMLElement>) {
    if (!dataTransferHasBrowserChatReferences(event.dataTransfer) || currentBusy || loading || uploadingImage || attachments.length >= BROWSER_CHAT_MAX_REFERENCES) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  function handleReferenceDrop(event: ReactDragEvent<HTMLElement>) {
    if (!dataTransferHasBrowserChatReferences(event.dataTransfer) || currentBusy || loading || uploadingImage || attachments.length >= BROWSER_CHAT_MAX_REFERENCES) return;
    event.preventDefault();
    event.stopPropagation();
    placeEditorCaretFromPoint(event.clientX, event.clientY);
    const tabReference = browserChatTabReferenceFromDataTransfer(event.dataTransfer);
    if (tabReference) onAddReferences([tabReference]).forEach(insertReferenceToken);
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length) void onUploadFiles(files).then((uploaded) => uploaded.forEach(insertReferenceToken));
  }

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

  function isInlineToken(node: Node | null): node is HTMLElement {
    return node instanceof HTMLElement && Boolean(node.dataset.skillId || node.dataset.attachmentId);
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
    if (!editor || editor.querySelector('[data-skill-id],[data-attachment-id]') || !isBlankText(editorPlainText(editor))) return false;
    editor.innerHTML = '';
    setEditorSelection(editor, 0);
    return true;
  }

  function removeInlineTokenNode(token: HTMLElement, selectionTarget?: { container: Node; offset: number }) {
    const editor = editorRef.current;
    const attachmentId = token.dataset.attachmentId || '';
    const skillId = token.dataset.skillId || '';
    token.remove();
    if (attachmentId) onRemoveAttachment(attachmentId);
    if (skillId) setSelectedSkillIds((current) => current.filter((id) => id !== skillId));
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

  function removeAdjacentTokenByKeyboard(key: string) {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.rangeCount) return false;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return false;

    if (!range.collapsed) {
      const fragment = range.cloneContents();
      const removedAttachmentIds = Array.from(fragment.querySelectorAll<HTMLElement>('[data-attachment-id]'))
        .map((node) => node.dataset.attachmentId || '')
        .filter(Boolean);
      if (!fragment.querySelector('[data-skill-id],[data-attachment-id]')) return false;
      range.deleteContents();
      removedAttachmentIds.forEach(onRemoveAttachment);
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
        if (isInlineToken(previous) && isBlankText(beforeCaret)) {
          textNode.data = textNode.data.slice(offset);
          removeInlineTokenNode(previous, { container: textNode, offset: 0 });
          return true;
        }
      } else {
        const before = container.childNodes[offset - 1];
        if (isInlineToken(before)) {
          removeInlineTokenNode(before, { container, offset: offset - 1 });
          return true;
        }
        if (before?.nodeType === Node.TEXT_NODE && isBlankText(before.textContent || '') && isInlineToken(before.previousSibling)) {
          const token = before.previousSibling;
          before.remove();
          removeInlineTokenNode(token, { container, offset: offset - 2 });
          return true;
        }
      }
    }

    if (key === 'Delete') {
      if (container.nodeType === Node.TEXT_NODE) {
        const textNode = container as Text;
        const afterCaret = textNode.data.slice(offset);
        const next = textNode.nextSibling;
        if (isInlineToken(next) && isBlankText(afterCaret)) {
          textNode.data = textNode.data.slice(0, offset);
          removeInlineTokenNode(next, { container: textNode, offset });
          return true;
        }
      } else {
        const after = container.childNodes[offset];
        if (isInlineToken(after)) {
          removeInlineTokenNode(after, { container, offset });
          return true;
        }
        if (after?.nodeType === Node.TEXT_NODE && isBlankText(after.textContent || '') && isInlineToken(after.nextSibling)) {
          const token = after.nextSibling;
          after.remove();
          removeInlineTokenNode(token, { container, offset });
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

  function placeEditorCaretFromPoint(clientX: number, clientY: number) {
    const editor = editorRef.current;
    if (!editor || typeof document === 'undefined') return;
    const doc = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offset: number; offsetNode: Node } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const range = doc.caretRangeFromPoint?.(clientX, clientY) || (() => {
      const position = doc.caretPositionFromPoint?.(clientX, clientY);
      if (!position) return null;
      const nextRange = document.createRange();
      nextRange.setStart(position.offsetNode, position.offset);
      return nextRange;
    })();
    if (!range || !editor.contains(range.commonAncestorContainer)) return;
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
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
    token.innerHTML = `<span class="browser-chat-inline-skill-icon">${inlineSkillIconSvg()}</span><span class="browser-chat-inline-skill-title"></span>`;
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

  function insertReferenceToken(attachment: BrowserChatAttachment) {
    const editor = editorRef.current;
    if (!editor) return;
    const kind = browserChatAttachmentKind(attachment);
    const range = editorRange() || document.createRange();
    range.deleteContents();

    const token = document.createElement('span');
    token.className = `browser-chat-inline-reference ${kind}`;
    token.contentEditable = 'false';
    token.dataset.attachmentId = attachment.id;
    token.dataset.attachmentJson = JSON.stringify(attachment);
    token.dataset.attachmentKind = kind;
    token.title = `${browserChatReferenceLabel(kind)}: ${attachment.name}`;
    token.innerHTML = `<span class="browser-chat-inline-reference-icon">${inlineReferenceIconSvg(kind)}</span><span class="browser-chat-inline-reference-title"></span>`;
    token.querySelector('.browser-chat-inline-reference-title')!.textContent = attachment.name || browserChatReferenceLabel(kind);

    range.insertNode(token);
    const trailingText = document.createTextNode('\u00A0');
    token.after(trailingText);
    const nextRange = document.createRange();
    nextRange.setStart(trailingText, trailingText.data.length);
    nextRange.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(nextRange);
    syncEditorState({ scrollToBottom: true });
  }

  return (
    <>
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
      <form
        className="browser-chat-compose browser-chat-compose--reference"
        onDragOver={handleReferenceDragOver}
        onDrop={handleReferenceDrop}
        onSubmit={(event) => {
          event.preventDefault();
          void submitDraft();
        }}
      >
        <input
          ref={imageInputRef}
          className="browser-chat-image-input"
          type="file"
          multiple
          onChange={(event) => {
            const files = event.currentTarget.files;
            if (files?.length) void onUploadFiles(Array.from(files)).then((uploaded) => uploaded.forEach(insertReferenceToken));
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
          onInput={() => syncEditorState({ scrollToBottom: true })}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Backspace' || event.key === 'Delete') {
              if (removeAdjacentTokenByKeyboard(event.key)) {
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
              aria-label="上传文件"
              className="browser-chat-attach"
              disabled={currentBusy || uploadingImage || attachments.length >= BROWSER_CHAT_MAX_REFERENCES}
              onClick={() => imageInputRef.current?.click()}
              title="上传文件"
              type="button"
            >
              {uploadingImage ? <Loader2 className="spin" size={17} /> : <Plus size={19} />}
            </button>
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
          </div>
          <div className="browser-chat-compose-submit">
            <div className="browser-chat-model-control">
              <CustomSelect
                className="browser-chat-provider-select"
                disabled={currentBusy || loading}
                onChange={(value) => onModelSelectionChange(parseModelSelectionValue(value))}
                options={modelSelectionOptions}
                title={modelSelectionTitle}
                value={modelSelection}
              />
            </div>
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
                {busy ? <Loader2 className="spin" size={18} /> : <ArrowUp size={20} strokeWidth={2.2} />}
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
  const height = Math.max(1, Math.round(rect.height));
  const leftInset = Math.max(0, Math.min(Math.round(options.leftInset || 0), width - 1));
  return {
    x: Math.max(0, Math.round(rect.left) + leftInset),
    y: Math.max(0, Math.round(rect.top)),
    width: Math.max(1, width - leftInset),
    height,
  };
}

function EmbeddedBrowserFavoritesIcon({ size = 18 }: { size?: number }) {
  return (
    <svg aria-hidden="true" fill="none" height={size} viewBox="0 0 24 24" width={size}>
      <path d="m7.1 3.2 1.45 2.95 3.25.47-2.35 2.3.56 3.23-2.91-1.53-2.91 1.53.56-3.23-2.35-2.3 3.25-.47L7.1 3.2Z" />
      <path d="M13.4 6.25h7.1M13.8 10.7h6.7M12.2 15.15h8.3" />
    </svg>
  );
}

function embeddedBoundsKey(bounds?: EmbeddedBrowserBounds) {
  return bounds ? `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}` : '';
}

function embeddedBrowserDisplayUrl(tab?: EmbeddedBrowserTab) {
  const url = tab?.url || '';
  if (!url || /^data:text\/html/i.test(url)) return '';
  return url;
}

function normalizeEmbeddedBrowserAddress(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^(about|data|file|blob):/i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(trimmed)) return `http://${trimmed}`;
  return `https://${trimmed}`;
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
  const addressFocusedRef = useRef(false);
  const draggingGroupIdRef = useRef('');
  const draggingTabIdRef = useRef('');
  const [bridgeAvailable, setBridgeAvailable] = useState(false);
  const [bridgeError, setBridgeError] = useState('');
  const [browserGroups, setBrowserGroups] = useState<EmbeddedBrowserGroup[]>([]);
  const [browserTabs, setBrowserTabs] = useState<EmbeddedBrowserTab[]>([]);
  const [activeGroupId, setActiveGroupId] = useState('');
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const [activeTabId, setActiveTabId] = useState('');
  const [addressValue, setAddressValue] = useState('');
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<string[]>([]);
  const [closedGroupIds, setClosedGroupIds] = useState<string[]>([]);
  const [draggingTabId, setDraggingTabId] = useState('');
  const [dragDropTarget, setDragDropTarget] = useState<{ position: 'before' | 'after'; tabId: string } | null>(null);
  const [libraryPanel, setLibraryPanel] = useState<'bookmarks' | 'history' | null>(null);

  const applyEmbeddedBrowserState = useCallback((result: EmbeddedBrowserState) => {
    if (!result.ok) {
      setBridgeError(result.error || '嵌入浏览器状态不可用');
      return;
    }
    setBridgeError('');
    setBrowserGroups(Array.isArray(result.groups) ? result.groups : []);
    setBrowserTabs(Array.isArray(result.tabs) ? result.tabs : []);
    setLibraryPanel(result.libraryPanel === 'bookmarks' || result.libraryPanel === 'history' ? result.libraryPanel : null);
    setActiveGroupId(result.activeGroupId || '');
    setActiveTabIndex(typeof result.activeIndex === 'number' && result.activeIndex >= 0 ? result.activeIndex : 0);
    setActiveTabId(result.activeTabId || '');
    setCanGoBack(Boolean(result.canGoBack));
    setCanGoForward(Boolean(result.canGoForward));
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
      setAddressValue('');
      setCanGoBack(false);
      setCanGoForward(false);
      setLibraryPanel(null);
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
    const bounds = visible && viewport
      ? embeddedBoundsFromElement(viewport, { leftInset: leftOverlayInset })
      : undefined;
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

  useEffect(() => {
    if (!enabled || !active) return undefined;
    void loadEmbeddedBrowserState();
    const bridge = window.webPilotEmbeddedBrowser;
    return bridge?.onStateChange?.((result) => applyEmbeddedBrowserState(result)) || undefined;
  }, [active, applyEmbeddedBrowserState, enabled, loadEmbeddedBrowserState]);

  async function goEmbeddedBrowserBack() {
    const bridge = window.webPilotEmbeddedBrowser;
    if (!bridge || !canGoBack) return;
    const result = await bridge.goBack().catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : 'Browser back failed',
    }));
    applyEmbeddedBrowserState(result);
  }

  async function goEmbeddedBrowserForward() {
    const bridge = window.webPilotEmbeddedBrowser;
    if (!bridge || !canGoForward) return;
    const result = await bridge.goForward().catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : 'Browser forward failed',
    }));
    applyEmbeddedBrowserState(result);
  }

  async function reloadEmbeddedBrowser() {
    const bridge = window.webPilotEmbeddedBrowser;
    if (!bridge) return;
    const result = await bridge.reload().catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : 'Browser reload failed',
    }));
    applyEmbeddedBrowserState(result);
  }

  async function toggleEmbeddedBrowserBookmark() {
    const bridge = window.webPilotEmbeddedBrowser;
    if (!bridge) return;
    const result = await bridge.toggleBookmark().catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : '收藏操作失败',
    }));
    applyEmbeddedBrowserState(result);
  }

  async function setEmbeddedBrowserTabMuted(tab: EmbeddedBrowserTab) {
    const bridge = window.webPilotEmbeddedBrowser;
    if (!bridge) return;
    const result = await bridge.setTabMuted({ id: tab.id, muted: !tab.audioMuted }).catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : '标签静音操作失败',
    }));
    applyEmbeddedBrowserState(result);
  }

  async function toggleEmbeddedBrowserLibraryPanel(panel: 'bookmarks' | 'history') {
    const bridge = window.webPilotEmbeddedBrowser;
    if (!bridge) return;
    const result = await bridge.setLibraryPanel({ panel: libraryPanel === panel ? null : panel }).catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : '打开收藏与历史记录失败',
    }));
    applyEmbeddedBrowserState(result);
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

  function toggleEmbeddedBrowserGroupCollapsed(groupId: string) {
    setCollapsedGroupIds((current) => (
      current.includes(groupId)
        ? current.filter((item) => item !== groupId)
        : [...current, groupId]
    ));
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

  async function navigateEmbeddedBrowserAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const bridge = window.webPilotEmbeddedBrowser;
    const url = normalizeEmbeddedBrowserAddress(addressValue);
    if (!bridge || !url) return;
    const groupId = embeddedGroupIdForSession(sessionId);
    const result = await bridge.navigate({ groupId, sessionId, url }).catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : 'Browser navigation failed',
    }));
    if (!result.ok) {
      setBridgeError(result.error || 'Browser navigation failed');
      return;
    }
    setBridgeError('');
    addressFocusedRef.current = false;
    setAddressValue(url);
    void loadEmbeddedBrowserState();
  }

  function clearEmbeddedTabDrag() {
    draggingGroupIdRef.current = '';
    draggingTabIdRef.current = '';
    setDraggingTabId('');
    setDragDropTarget(null);
  }

  const selectedGroupId = embeddedGroupIdForSession(sessionId);
  const visibleGroups = useMemo<EmbeddedBrowserGroup[]>(() => {
    if (!sessionId) return [];
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

    if (sessionId && (!groupsById.size || !groupsById.has(selectedGroupId)) && !closedGroupIds.includes(selectedGroupId)) {
      ensureGroup(selectedGroupId, { active: true, sessionId });
    }

    return orderedIds.map((id) => groupsById.get(id)!).filter(Boolean);
  }, [activeGroupId, activeTabId, browserGroups, browserTabs, closedGroupIds, selectedGroupId, sessionId]);

  const activeEmbeddedTab = useMemo(() => {
    if (!sessionId) return undefined;
    const groupedTabs = visibleGroups.flatMap((group) => group.tabs);
    return groupedTabs.find((tab) => tab.id === activeTabId)
      || browserTabs.find((tab) => tab.id === activeTabId)
      || browserTabs[activeTabIndex]
      || groupedTabs[activeTabIndex]
      || groupedTabs[0];
  }, [activeTabId, activeTabIndex, browserTabs, sessionId, visibleGroups]);
  const isEmbeddedBrowserLoading = Boolean(activeEmbeddedTab?.loading);

  useEffect(() => {
    const visibleIds = new Set(visibleGroups.map((group) => group.id));
    setCollapsedGroupIds((current) => {
      const next = current.filter((groupId) => visibleIds.has(groupId));
      return next.length === current.length ? current : next;
    });
  }, [visibleGroups]);

  useEffect(() => {
    if (!addressFocusedRef.current) setAddressValue(embeddedBrowserDisplayUrl(activeEmbeddedTab));
  }, [activeEmbeddedTab?.id, activeEmbeddedTab?.url]);

  return (
    <section
      className={[
        'browser-chat-embedded-browser',
        isEmbeddedBrowserLoading ? 'loading' : '',
      ].filter(Boolean).join(' ')}
      aria-label="嵌入浏览器"
    >
      <header className="browser-chat-embedded-chrome">
        <div className="browser-chat-embedded-tab-strip">
          <div className="browser-chat-embedded-tab-list" role="tablist" aria-label="Embedded browser tabs">
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
                    onClick={() => toggleEmbeddedBrowserGroupCollapsed(group.id)}
                    title={`${isCollapsedGroup ? '展开' : '收起'} ${embeddedSessionGroupLabel(groupSessionId)} 标签组`}
                    type="button"
                  >
                    <Folder size={14} />
                    <ChevronDown className="browser-chat-embedded-tab-group-chevron" size={11} />
                  </button>
                  <button
                    aria-label={`关闭 ${embeddedSessionGroupLabel(groupSessionId)} 标签组`}
                    className="browser-chat-embedded-tab-group-action browser-chat-embedded-tab-group-close"
                    onClick={(event) => {
                      event.stopPropagation();
                      void closeEmbeddedBrowserGroup(group);
                    }}
                    title={`关闭 ${embeddedSessionGroupLabel(groupSessionId)} 标签组`}
                    type="button"
                  >
                    <X size={13} />
                  </button>
                  <button
                    aria-label={`在 ${embeddedSessionGroupLabel(groupSessionId)} 中新建标签页`}
                    className="browser-chat-embedded-tab-group-action browser-chat-embedded-tab-group-add"
                    onClick={(event) => {
                      event.stopPropagation();
                      void createEmbeddedBrowserTab(group);
                    }}
                    title={`在 ${embeddedSessionGroupLabel(groupSessionId)} 中新建标签页`}
                    type="button"
                  >
                    <Plus size={14} />
                  </button>
                </div>
                <div className="browser-chat-embedded-tab-stack">
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
                          const tabDragPayload: EmbeddedBrowserTabDragPayload = {
                            groupId: group.id,
                            id: tab.id,
                            sessionId: tab.sessionId || groupSessionId,
                            title: tab.title,
                            url: embeddedBrowserDisplayUrl(tab) || tab.url,
                          };
                          event.dataTransfer.effectAllowed = 'copyMove';
                          event.dataTransfer.setData(WEBPILOT_TAB_DRAG_MIME, JSON.stringify(tabDragPayload));
                          event.dataTransfer.setData('application/x-webpilot-tab-id', tab.id);
                          if (tabDragPayload.url) event.dataTransfer.setData('text/uri-list', tabDragPayload.url);
                          event.dataTransfer.setData('text/plain', tabDragPayload.url || tabDragPayload.title || tab.id);
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
                          <strong>{compactText(tab.title || tab.url || '新建标签页', 56)}</strong>
                        </span>
                        {tab.loading ? (
                          <span className="browser-chat-embedded-tab-loading" aria-label="页面加载中">
                            <Loader2 className="spin" size={12} />
                          </span>
                        ) : null}
                        <button
                          aria-label={tab.audioMuted ? '取消静音标签页' : '静音标签页'}
                          className={tab.audioMuted ? 'browser-chat-embedded-tab-mute is-muted' : 'browser-chat-embedded-tab-mute'}
                          onClick={(event) => {
                            event.stopPropagation();
                            void setEmbeddedBrowserTabMuted(tab);
                          }}
                          title={tab.audioMuted ? '取消静音' : '静音'}
                          type="button"
                        >
                          {tab.audioMuted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                        </button>
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
              </div>
            );
          })}
          </div>
        </div>
        <div className="browser-chat-embedded-toolbar">
          <div className="browser-chat-embedded-nav-controls">
            <button className="browser-chat-embedded-tool-button" disabled={!canGoBack} onClick={() => void goEmbeddedBrowserBack()} title="Back" type="button" aria-label="Back">
              <ArrowLeft size={16} />
            </button>
            <button className="browser-chat-embedded-tool-button" disabled={!canGoForward} onClick={() => void goEmbeddedBrowserForward()} title="Forward" type="button" aria-label="Forward">
              <ArrowRight size={16} />
            </button>
            <button className="browser-chat-embedded-tool-button" disabled={!activeEmbeddedTab} onClick={() => void reloadEmbeddedBrowser()} title="Reload" type="button" aria-label="Reload">
              <RefreshCw size={15} />
            </button>
          </div>
          <form className="browser-chat-embedded-address-bar" onSubmit={navigateEmbeddedBrowserAddress}>
            <span className="browser-chat-embedded-address-icon" aria-hidden="true">
              {addressValue.startsWith('https://') ? <Lock size={14} /> : <Globe size={14} />}
            </span>
            <input
              aria-label="Address"
              disabled={!bridgeAvailable || !activeEmbeddedTab}
              onBlur={() => {
                addressFocusedRef.current = false;
                setAddressValue(embeddedBrowserDisplayUrl(activeEmbeddedTab));
              }}
              onChange={(event) => setAddressValue(event.currentTarget.value)}
              onFocus={() => {
                addressFocusedRef.current = true;
              }}
              spellCheck={false}
              value={addressValue}
            />
            <button
              aria-label={activeEmbeddedTab?.bookmarked ? '取消收藏当前页面' : '收藏当前页面'}
              className={activeEmbeddedTab?.bookmarked ? 'browser-chat-embedded-address-action active' : 'browser-chat-embedded-address-action'}
              disabled={!activeEmbeddedTab}
              onClick={() => void toggleEmbeddedBrowserBookmark()}
              title={activeEmbeddedTab?.bookmarked ? '取消收藏' : '收藏此页面'}
              type="button"
            >
              <Star fill={activeEmbeddedTab?.bookmarked ? 'currentColor' : 'none'} size={18} />
            </button>
          </form>
          <div className="browser-chat-embedded-library-actions">
            <button
              aria-expanded={libraryPanel === 'bookmarks'}
              aria-label="收藏夹"
              className={libraryPanel === 'bookmarks' ? 'browser-chat-embedded-tool-button active' : 'browser-chat-embedded-tool-button'}
              onClick={() => void toggleEmbeddedBrowserLibraryPanel('bookmarks')}
              title="收藏夹"
              type="button"
            >
              <EmbeddedBrowserFavoritesIcon size={19} />
            </button>
            <button
              aria-expanded={libraryPanel === 'history'}
              aria-label="历史记录"
              className={libraryPanel === 'history' ? 'browser-chat-embedded-tool-button active' : 'browser-chat-embedded-tool-button'}
              onClick={() => void toggleEmbeddedBrowserLibraryPanel('history')}
              title="历史记录"
              type="button"
            >
              <History size={18} />
            </button>
          </div>
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
  initialTargetDetailCaseId,
  initialTargetRunId,
}: {
  testCases: TestCaseRecord[];
  groups: TestGroupRecord[];
  schedules: RunScheduleRecord[];
  initialView?: BrowserChatView;
  initialTargetDetailCaseId?: string;
  initialTargetRunId?: string;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const { mode: themeMode, toggleMode } = useTheme();
  const [, startTransition] = useTransition();
  const initialModelSelection = resolveRuntimeModelSelection(null);
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
  const [mode, setMode] = useState<BrowserChatMode>('dom');
  const [safetyMode, setSafetyMode] = useState<BrowserChatSafetyMode>('strict');
  const [modelProvider, setModelProvider] = useState<ModelProvider>(() => initialModelSelection.provider);
  const [modelId, setModelId] = useState(() => initialModelSelection.model);
  const [modelConfig, setModelConfig] = useState<BrowserChatModelConfig | null>(null);
  const [targetGroupId, setTargetGroupId] = useState<string | undefined>();
  const [targetDetailCaseId, setTargetDetailCaseId] = useState<string | null>(initialTargetDetailCaseId || null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [groupName, setGroupName] = useState('');
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [deletingTargetGroupId, setDeletingTargetGroupId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<BrowserChatAttachment[]>([]);
  const attachmentsRef = useRef<BrowserChatAttachment[]>([]);
  const [composerResetToken, setComposerResetToken] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pendingMessageSessionId, setPendingMessageSessionId] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [embeddedBrowserEnabled, setEmbeddedBrowserEnabled] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);
  const [embeddedChatWidth, setEmbeddedChatWidth] = useState(420);
  const [embeddedChatCollapsed, setEmbeddedChatCollapsed] = useState(false);
  const [, setEmbeddedChatResizing] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [deletingSelectedSessions, setDeletingSelectedSessions] = useState(false);
  const [recentSelectionMode, setRecentSelectionMode] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [exportingMessageId, setExportingMessageId] = useState<string | null>(null);
  const [exportingSelectedMessages, setExportingSelectedMessages] = useState(false);
  const [generatingSkillMessageId, setGeneratingSkillMessageId] = useState<string | null>(null);
  const [generatingSkillSelectedMessages, setGeneratingSkillSelectedMessages] = useState(false);
  const [selectedExportMessageIds, setSelectedExportMessageIds] = useState<string[]>([]);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [logDialogMessageId, setLogDialogMessageId] = useState<string | null>(null);
  const fullLogSessionIdsRef = useRef(new Set<string>());
  const [toolDialog, setToolDialog] = useState<BrowserChatToolDetail | null>(null);
  const [resolvingConfirmationId, setResolvingConfirmationId] = useState<string | null>(null);
  const [resolvingConfirmationAction, setResolvingConfirmationAction] = useState<BrowserChatToolConfirmationAction | null>(null);
  const [imagePreview, setImagePreview] = useState<BrowserChatAttachment | null>(null);
  const [error, setError] = useState('');
  const [downloads, setDownloads] = useState<SystemDownloadItem[]>([]);
  const [downloadCenterOpen, setDownloadCenterOpen] = useState(false);
  const selectedSessionRunning = isBrowserChatSessionRunning(session);
  const selectedRunningSession = selectedSessionRunning ? session : undefined;
  const currentBusy = busy || selectedSessionRunning;
  const interruptSessionId = selectedRunningSession?.id || (busy ? pendingMessageSessionId || session?.id : undefined);
  const canInterruptConversation = Boolean(interruptSessionId && (busy || selectedSessionRunning));
  const modeLocked = Boolean(session && session.status !== 'closed' && (session.messages.length || session.steps.length || selectedSessionRunning));
  const messages = useMemo(() => session?.messages || [], [session?.messages]);
  const steps = useMemo(() => session?.steps || [], [session?.steps]);
  const logs = useMemo(() => session?.logs || [], [session?.logs]);
  const visibleMessages = messages;
  const lastAssistantMessageId = useMemo(
    () => [...visibleMessages].reverse().find((item) => item.role === 'assistant')?.id,
    [visibleMessages],
  );
  const hasMessages = visibleMessages.length > 0;
  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((current) => {
      const next = !current;
      writeStoredSidebarCollapsed(next);
      return next;
    });
  }, []);
  const toggleEmbeddedChatCollapsed = useCallback(() => {
    setEmbeddedChatCollapsed((current) => {
      const next = !current;
      writeStoredEmbeddedChatCollapsed(next);
      if (next) setDownloadCenterOpen(false);
      return next;
    });
  }, []);

  useEffect(() => {
    setSidebarCollapsed(readStoredSidebarCollapsed());
    setEmbeddedChatCollapsed(readStoredEmbeddedChatCollapsed());
  }, []);

  useEffect(() => {
    function closeSidebarMenus(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      document.querySelectorAll<HTMLDetailsElement>('.browser-chat-overflow[open]').forEach((menu) => {
        if (!menu.contains(target)) menu.removeAttribute('open');
      });
    }
    document.addEventListener('pointerdown', closeSidebarMenus);
    return () => document.removeEventListener('pointerdown', closeSidebarMenus);
  }, []);

  useEffect(() => {
    const bridge = typeof window === 'undefined' ? undefined : window.webPilotSystem;
    if (!bridge) return undefined;
    let mounted = true;
    const applyDownload = (download: SystemDownloadItem) => {
      if (!download?.id) return;
      setDownloads((current) => {
        const next = [download, ...current.filter((item) => item.id !== download.id)];
        return next.sort((left, right) => Number(right.startedAt || right.updatedAt || 0) - Number(left.startedAt || left.updatedAt || 0));
      });
    };
    bridge.getDownloads?.()
      .then((result) => {
        if (!mounted || !result?.ok || !Array.isArray(result.downloads)) return;
        setDownloads(result.downloads);
      })
      .catch(() => undefined);
    const unsubscribe = bridge.onDownloadProgress?.(applyDownload);
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  const stepsByIndex = useMemo(() => new Map(steps.map((step) => [step.index, step])), [steps]);
  const selectedExportMessageIdSet = useMemo(() => new Set(selectedExportMessageIds), [selectedExportMessageIds]);
  const logIndex = useMemo(() => buildBrowserChatLogIndex(logs), [logs]);
  const logDialogMessage = useMemo(
    () => messages.find((item) => item.id === logDialogMessageId),
    [logDialogMessageId, messages],
  );
  const logDialogEntries = useMemo(() => {
    if (!logDialogMessage) return [];
    return visibleBrowserChatExecutionLogs(browserChatLogsForMessage(logDialogMessage, logIndex));
  }, [logDialogMessage, logIndex]);
  const previewAttachment = useCallback((attachment: BrowserChatAttachment) => {
    setImagePreview(attachment);
  }, []);
  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => {
      const next = current.filter((attachment) => attachment.id !== id);
      attachmentsRef.current = next;
      return next;
    });
  }, []);
  const addReferenceAttachments = useCallback((nextReferences: BrowserChatAttachment[]) => {
    const current = attachmentsRef.current;
    const keys = new Set(current.map(browserChatReferenceKey));
    const next = [...current];
    const added: BrowserChatAttachment[] = [];
    for (const reference of nextReferences) {
      if (next.length >= BROWSER_CHAT_MAX_REFERENCES) break;
      const normalized: BrowserChatAttachment = {
        ...reference,
        id: reference.id || temporaryId('ref'),
        kind: reference.kind || browserChatAttachmentKind(reference),
      };
      const key = browserChatReferenceKey(normalized);
      if (keys.has(key)) continue;
      keys.add(key);
      next.push(normalized);
      added.push(normalized);
    }
    if (added.length) {
      attachmentsRef.current = next;
      setAttachments(next);
    }
    return added;
  }, []);
  const showMessageLogs = useCallback((messageId: string) => {
    setLogDialogMessageId(messageId);
    const sessionId = activeSessionIdRef.current;
    if (!sessionId || fullLogSessionIdsRef.current.has(sessionId)) return;
    fullLogSessionIdsRef.current.add(sessionId);
    void fetch(`/api/browser-chat/${sessionId}/logs`, { cache: 'no-store' })
      .then((response) => readApiJson<{ logs?: BrowserChatLogRecord[] }>(response, '加载对话日志失败'))
      .then((data) => {
        if (!Array.isArray(data.logs)) return;
        setSession((current) => current?.id === sessionId ? { ...current, logs: data.logs || [] } : current);
      })
      .catch(() => {
        fullLogSessionIdsRef.current.delete(sessionId);
      });
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
  const embeddedBrowserActive = embeddedBrowserEnabled && activeView === 'chat';
  const embeddedBrowserCovered = Boolean(toolDialog || logDialogMessageId || imagePreview || groupDialogOpen);
  const embeddedBrowserViewActive = embeddedBrowserActive && !embeddedBrowserCovered;
  const modelSelection = modelSelectionValueForConfig(modelConfig, { model: modelId, provider: modelProvider });
  const modelSelectionDiagnostic = modelSelectionDiagnosticLabel(modelConfig, { model: modelId, provider: modelProvider });
  const modelSelectionOptions = useMemo(() => modelSelectionOptionsForConfig(modelConfig), [modelConfig]);
  const downloadPanelWidth = embeddedBrowserActive
    ? Math.max(260, Math.min(360, embeddedChatWidth - 36))
    : 380;
  const chatPaneStyle = useMemo(() => ({
    '--browser-chat-download-panel-width': `${downloadPanelWidth}px`,
  }) as CSSProperties, [downloadPanelWidth]);
  const toggleDownloadCenter = useCallback(() => setDownloadCenterOpen((current) => !current), []);

  const changeModelSelection = useCallback((selection: { provider: ModelProvider; model: string }) => {
    const next = resolveRuntimeModelSelection(modelConfig, selection);
    setModelProvider(next.provider);
    setModelId(next.model);
  }, [modelConfig]);

  const loadBrowserRuntimeSettings = useCallback(async () => {
    const response = await fetch('/api/settings/env', { cache: 'no-store' });
    const data = await readApiJson<any>(response, '加载浏览器配置失败');
    const saved = Array.isArray(data.saved) ? data.saved as Array<{ key?: string; value?: string }> : [];
    const embeddedSetting = saved.find((item) => item.key === 'ELECTRON_EMBEDDED_BROWSER');
    const reasoningSetting = saved.find((item) => item.key === 'BROWSER_CHAT_SHOW_REASONING');
    setEmbeddedBrowserEnabled(embeddedSetting?.value === 'true');
    setShowReasoning(reasoningSetting?.value === 'true');
  }, []);

  const loadSkills = useCallback(async () => {
    const response = await fetch('/api/skills', { cache: 'no-store' });
    const data = await readApiJson<any>(response, '加载 Skills 失败');
    setSkills(Array.isArray(data.skills) ? data.skills : []);
  }, []);

  const loadModelConfig = useCallback(async () => {
    const response = await fetch('/api/settings/model', { cache: 'no-store' });
    const data = await readApiJson<any>(response, '加载模型配置失败');
    const config = normalizeRuntimeModelConfig(data.config as Partial<BrowserChatModelConfig> | undefined);
    if (config) setModelConfig(config);
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
      moveEvent.preventDefault();
      setEmbeddedChatWidth(nextWidth(moveEvent.clientX));
    };
    const onPointerUp = () => {
      setEmbeddedChatResizing(false);
      document.body.classList.remove('browser-chat-resizing');
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('pointercancel', onPointerUp, true);
    };
    document.body.classList.add('browser-chat-resizing');
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onPointerUp, true);
  }, []);

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
    const data = await readApiJson<any>(response, '加载对话历史失败');
    const nextSessions = Array.isArray(data.sessions) ? data.sessions.map((item: BrowserChatSession) => normalizeSession(item)) : [];
    setSessions(nextSessions);
  }, []);

  const refreshSession = useCallback(async (sessionId: string, options: { activate?: boolean } = {}) => {
    const response = await fetch(`/api/browser-chat/${sessionId}`, { cache: 'no-store' });
    const data = await readApiJson<any>(response, '加载对话失败');
    const shouldActivate = options.activate ?? activeSessionIdRef.current === sessionId;
    const loadedSession = upsertSession(data.session as BrowserChatSession, { activate: shouldActivate });
    if (shouldActivate) {
      setMode(normalizeMode(loadedSession.mode));
      setSafetyMode(normalizeSafetyMode(loadedSession.safetyMode));
      const nextModel = resolveRuntimeModelSelection(modelConfig, {
        model: loadedSession.model,
        provider: loadedSession.modelProvider,
      });
      setModelProvider(nextModel.provider);
      setModelId(nextModel.model);
    }
    return loadedSession;
  }, [modelConfig, upsertSession]);

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
    const nextModel = resolveRuntimeModelSelection(modelConfig);
    setModelProvider(nextModel.provider);
    setModelId(nextModel.model);
  }, [modelConfig, session?.id]);

  useEffect(() => {
    setModelId((current) => resolveRuntimeModelSelection(modelConfig, { model: current, provider: modelProvider }).model);
  }, [modelConfig, modelProvider]);

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
      else scheduleLoadSessions();
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
    if (!session?.id || !selectedSessionRunning || realtimeConnected) return undefined;
    const sessionId = session.id;
    const timer = window.setInterval(() => {
      void refreshSession(sessionId, { activate: activeSessionIdRef.current === sessionId }).catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [realtimeConnected, refreshSession, selectedSessionRunning, session?.id]);

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

  async function deleteTargetGroup(group: TestGroupRecord) {
    if (deletingTargetGroupId) return;
    const descendantIds = new Set<string>([group.id]);
    const collect = (groupId: string) => {
      groups.filter((item) => item.parentId === groupId).forEach((child) => {
        if (descendantIds.has(child.id)) return;
        descendantIds.add(child.id);
        collect(child.id);
      });
    };
    collect(group.id);
    const childCount = descendantIds.size - 1;
    const message = childCount
      ? `确定删除分组“${group.name}”及其 ${childCount} 个子分组吗？这些分组下的测试用例会移回未分组。`
      : `确定删除分组“${group.name}”吗？这个分组下的测试用例会移回未分组。`;
    if (!window.confirm(message)) return;
    setDeletingTargetGroupId(group.id);
    startGlobalLoading('正在删除分组');
    try {
      const response = await fetch(`/api/groups/${group.id}`, { method: 'DELETE' });
      const data = await readApiJson<any>(response, '删除分组失败');
      if (targetGroupId && descendantIds.has(targetGroupId)) setTargetGroupId(undefined);
      startTransition(() => router.refresh());
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '删除分组失败');
    } finally {
      setDeletingTargetGroupId(null);
      stopGlobalLoading();
    }
  }

  async function createSession() {
    const response = await fetch('/api/browser-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, safetyMode, modelProvider, model: modelId }),
    });
    const data = await readApiJson<any>(response, '创建对话会话失败');
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
      body: JSON.stringify({ attachments: nextAttachments, clientMessageId, content, mode, safetyMode, modelProvider, model: modelId, skillIds }),
    });
    const data = await readApiJson<any>(response, '发送消息失败');
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

  async function uploadChatFiles(files: FileList | File[]) {
    const selectedFiles = Array.from(files);
    const remainingSlots = Math.max(0, BROWSER_CHAT_MAX_REFERENCES - attachmentsRef.current.length);
    if (!selectedFiles.length || !remainingSlots || uploadingImage || currentBusy) return [];
    setUploadingImage(true);
    setError('');
    try {
      const uploaded: BrowserChatAttachment[] = [];
      for (const file of selectedFiles.slice(0, remainingSlots)) {
        const form = new FormData();
        form.append('file', file);
        const response = await fetch('/api/uploads', { method: 'POST', body: form });
        const data = await readApiJson<any>(response, '文件上传失败');
        const fileId = String(data.fileId || data.imageId || temporaryId(file.type.startsWith('image/') ? 'image' : 'file'));
        const kind: BrowserChatAttachmentKind = String(data.type || file.type || '').startsWith('image/') ? 'image' : 'file';
        uploaded.push({
          id: fileId,
          kind,
          name: String(data.name || file.name),
          type: String(data.type || file.type || 'application/octet-stream'),
          size: typeof data.size === 'number' ? data.size : file.size,
          path: String(data.path || `uploads/${fileId}`),
          url: String(data.url || `/api/artifacts/uploads/${encodeURIComponent(fileId)}`),
        });
      }
      return uploaded.length ? addReferenceAttachments(uploaded) : [];
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : '文件上传失败');
      return [];
    } finally {
      setUploadingImage(false);
      if (imageInputRef.current) imageInputRef.current.value = '';
    }
  }

  async function sendMessage(content: string, skillIds: string[] = [], messageAttachments?: BrowserChatAttachment[]) {
    const trimmedContent = content.trim();
    const nextAttachments = messageAttachments ?? attachments;
    if ((!trimmedContent && !nextAttachments.length && !skillIds.length) || currentBusy || loadingSessionId || sendingRef.current || uploadingImage) return false;
    sendingRef.current = true;
    const clientMessageId = temporaryId('client_msg');
    setError('');
    setBusy(true);
    setActiveView('chat');
    try {
      let active = await ensureSession();
      setPendingMessageSessionId(active.id);
      await ensureEmbeddedBrowserSessionTab(active.id);
      let posted: BrowserChatSession;
      try {
        posted = await postMessageToSession(active.id, trimmedContent, clientMessageId, nextAttachments, skillIds);
      } catch (firstError) {
        const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
        if (!/Browser chat session not found/i.test(firstMessage)) throw firstError;
        active = await createSession();
        setPendingMessageSessionId(active.id);
        await ensureEmbeddedBrowserSessionTab(active.id);
        posted = await postMessageToSession(active.id, trimmedContent, clientMessageId, nextAttachments, skillIds);
      }
      upsertSession(posted, { activate: true });
      attachmentsRef.current = [];
      setAttachments([]);
      return true;
    } catch (sendError) {
      const sendMessageText = sendError instanceof Error ? sendError.message : '发送消息失败';
      setError(sendMessageText);
      attachmentsRef.current = nextAttachments;
      setAttachments(nextAttachments);
      return false;
    } finally {
      sendingRef.current = false;
      setPendingMessageSessionId(null);
      setBusy(false);
    }
  }

  async function interruptConversation() {
    const targetId = interruptSessionId;
    if (!targetId || interrupting) return;
    setInterrupting(true);
    setError('');
    try {
      const response = await fetch(`/api/browser-chat/${targetId}/interrupt`, { method: 'POST' });
      const data = await readApiJson<any>(response, '中断对话失败');
      upsertSession(data.session as BrowserChatSession, { activate: activeSessionIdRef.current === targetId });
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
      const data = await readApiJson<any>(response, '工具确认失败');
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
      if (response.ok) {
        const data = await readApiJson<any>(response, '??????');
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
      const data = await readApiJson<any>(response, '删除历史对话失败');
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
      const data = await readApiJson<any>(response, '批量删除历史对话失败');
      setSessions((current) => current.filter((item) => !deletingIdSet.has(item.id)));
      setSelectedSessionIds((current) => current.filter((id) => !deletingIdSet.has(id)));
      if (session?.id && deletingIdSet.has(session.id)) setSession(null);
      await loadSessions().catch(() => undefined);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '批量删除历史对话失败');
    } finally {
      setDeletingSelectedSessions(false);
      setRecentSelectionMode(false);
    }
  }

  function closeSidebarOverflowMenu(event: ReactMouseEvent<HTMLButtonElement>) {
    event.currentTarget.closest('details')?.removeAttribute('open');
  }

  const openTargetCaseDetail = useCallback((testCaseId: string) => {
    setActiveView('target');
    setTargetDetailCaseId(testCaseId);
    startTransition(() => router.refresh());
  }, [router, startTransition]);

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
      const data = await readApiJson<any>(response, '导出测试用例失败');
      setSelectedExportMessageIds([]);
      if (typeof data.testCaseId === 'string') openTargetCaseDetail(data.testCaseId);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : '导出测试用例失败');
    } finally {
      setExportingSelectedMessages(false);
      stopGlobalLoading();
    }
  }, [exportingMessageId, exportingSelectedMessages, generatingSkillMessageId, generatingSkillSelectedMessages, openTargetCaseDetail, selectedExportMessageIds, session?.id]);

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
      const data = await readApiJson<any>(response, '导出测试用例失败');
      if (typeof data.testCaseId === 'string') openTargetCaseDetail(data.testCaseId);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : '导出测试用例失败');
    } finally {
      setExportingMessageId(null);
    }
  }, [exportingMessageId, exportingSelectedMessages, generatingSkillMessageId, generatingSkillSelectedMessages, openTargetCaseDetail, session?.id]);

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
      const data = await readApiJson<any>(response, '生成 Skill 失败');
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
      const data = await readApiJson<any>(response, '生成 Skill 失败');
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
    attachmentsRef.current = [];
    setAttachments([]);
    setSession(null);
  }

  async function loadSession(sessionId: string) {
    if (loadingSessionRef.current === sessionId) return;
    loadingSessionRef.current = sessionId;
    setLoadingSessionId(sessionId);
    setActiveView('chat');
    setError('');
    setComposerResetToken((current) => current + 1);
    attachmentsRef.current = [];
    setAttachments([]);
    try {
      const loadedSession = await refreshSession(sessionId, { activate: true });
      setMode(normalizeMode(loadedSession.mode));
      setSafetyMode(normalizeSafetyMode(loadedSession.safetyMode));
      const nextModel = resolveRuntimeModelSelection(modelConfig, {
        model: loadedSession.model,
        provider: loadedSession.modelProvider,
      });
      setModelProvider(nextModel.provider);
      setModelId(nextModel.model);
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

  function renderSidebarDetail() {
    if (activeView === 'target') {
      return (
        <DashboardGroupSidebar
          className="browser-chat-sub-sidebar"
          deletingGroupId={deletingTargetGroupId}
          groups={groups}
          headerAction={(
            <NewTestCaseModal
              groupId={targetGroupId}
              icon={<Plus size={16} />}
              iconOnly
              onCreated={openTargetCaseDetail}
            />
          )}
          headerLabel="目标"
          selectedGroupId={targetGroupId}
          onDeleteGroup={deleteTargetGroup}
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
          <h2>对话</h2>
          <div className="browser-chat-recent-header-actions">
            <button
              aria-label={t('新建对话')}
              className="ui-icon-button browser-chat-section-create"
              disabled={busy || Boolean(loadingSessionId)}
              onClick={() => void startNewConversation()}
              title={t('新建对话')}
              type="button"
            >
              <Plus size={16} />
            </button>
            <details className="browser-chat-overflow browser-chat-recent-actions">
              <summary aria-label="对话操作" title="对话操作">
                <MoreHorizontal size={16} />
              </summary>
              <div className="browser-chat-overflow-menu">
                {recentSessions.length ? (
                  <button
                    onClick={(event) => {
                      closeSidebarOverflowMenu(event);
                      setRecentSelectionMode((current) => !current);
                      if (recentSelectionMode) setSelectedSessionIds([]);
                    }}
                    type="button"
                  >
                    <Square size={14} />
                    <span>{recentSelectionMode ? '退出选择' : '选择对话'}</span>
                  </button>
                ) : null}
                {recentSelectionMode ? (
                  <button
                    onClick={(event) => {
                      closeSidebarOverflowMenu(event);
                      toggleAllRecentSelections();
                    }}
                    type="button"
                  >
                    <CheckCircle2 size={15} />
                    <span>{allSelectableRecentSessionsSelected ? '取消全选' : '全选'}</span>
                  </button>
                ) : null}
                {recentSelectionMode && selectedDeletableSessionIds.length ? (
                  <button
                    className="danger"
                    disabled={deletingSelectedSessions}
                    onClick={(event) => {
                      closeSidebarOverflowMenu(event);
                      void deleteSelectedSessionHistory();
                    }}
                    type="button"
                  >
                    {deletingSelectedSessions ? <Loader2 className="spin" size={14} /> : <Trash2 size={15} />}
                    <span>删除已选（{selectedDeletableSessionIds.length}）</span>
                  </button>
                ) : null}
              </div>
            </details>
          </div>
        </div>
        <button
          aria-label={t('新建对话')}
          className="ui-button ui-button--neutral browser-chat-new-chat-button"
          disabled={busy || Boolean(loadingSessionId)}
          onClick={() => void startNewConversation()}
          title={t('新建对话')}
          type="button"
        >
          <Plus size={16} />
          <span>{t('新建对话')}</span>
        </button>
        {recentSessions.length ? (
          <ol className="browser-chat-recent-list">
            {recentSessions.map((item) => (
              <li key={item.id}>
                <div
                  className={`${session?.id === item.id ? 'browser-chat-recent-item active' : 'browser-chat-recent-item'}${recentSelectionMode ? ' selecting' : ''}`}
                >
                  {recentSelectionMode ? (
                    <input
                      aria-label={`选择 ${sessionDisplayTitle(item)}`}
                      checked={selectedSessionIdSet.has(item.id)}
                      className="browser-chat-recent-check"
                      disabled={item.busy || deletingSelectedSessions}
                      onChange={(event) => toggleSessionSelection(item.id, event.currentTarget.checked)}
                      type="checkbox"
                    />
                  ) : null}
                  <button
                    className="browser-chat-recent-open"
                    disabled={Boolean(loadingSessionId && loadingSessionId !== item.id)}
                    onClick={() => {
                      void loadSession(item.id);
                    }}
                    title={sessionDisplayTitle(item)}
                    type="button"
                  >
                    {sidebarCollapsed ? <MessageSquare className="browser-chat-recent-icon" size={17} /> : null}
                    <span>{sessionDisplayTitle(item)}</span>
                  </button>
                  <details className="browser-chat-overflow browser-chat-recent-row-menu">
                    <summary aria-label={`${sessionDisplayTitle(item)} 操作`} title="更多操作">
                      {deletingSessionId === item.id ? <Loader2 className="spin" size={13} /> : <MoreHorizontal size={16} />}
                    </summary>
                    <div className="browser-chat-overflow-menu">
                      <button
                        className="danger"
                        disabled={item.busy || deletingSessionId === item.id || deletingSelectedSessions}
                        onClick={(event) => {
                          closeSidebarOverflowMenu(event);
                          void deleteSessionHistory(item.id);
                        }}
                        type="button"
                      >
                        <Trash2 size={15} />
                        <span>{item.busy ? '执行中，无法删除' : '删除对话'}</span>
                      </button>
                    </div>
                  </details>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p>{t('暂无记录')}</p>
        )}
      </section>
    );
  }

  const renderChatPaneActions = () => (
    <div className="browser-chat-pane-actions">
      {session ? (
        <button className="browser-chat-close" disabled={session.status === 'closed' || currentBusy} onClick={closeSession} title="结束会话" type="button">
          <Power size={17} />
        </button>
      ) : null}
      <BrowserChatDownloadCenter
        downloads={downloads}
        open={downloadCenterOpen}
        onClose={() => setDownloadCenterOpen(false)}
        onToggle={toggleDownloadCenter}
      />
    </div>
  );

  const renderChatPane = () => (
    <div className={`${hasMessages ? 'browser-chat-chat-pane has-messages' : 'browser-chat-chat-pane'}${embeddedBrowserActive ? ' embedded-chat' : ''}`} style={chatPaneStyle}>
      {loadingSessionId ? (
        <div className="browser-chat-inline-loading">
          <span aria-hidden="true" className="ui-loading-spinner ui-loading-spinner--small" />
          <span>正在加载对话</span>
        </div>
      ) : null}
      {renderChatPaneActions()}

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
          sessionBusy={selectedSessionRunning}
          stepsByIndex={stepsByIndex}
          totalStepCount={steps.length}
        />
      ) : null}

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
          modelSelection={modelSelection}
          modelSelectionTitle={modelSelectionDiagnostic}
          modelSelectionOptions={modelSelectionOptions}
          safetyMode={safetyMode}
          onInterrupt={interruptConversation}
          onModelSelectionChange={changeModelSelection}
          onModeChange={setMode}
          onRemoveAttachment={removeAttachment}
          onSubmitMessage={sendMessage}
          onSafetyModeChange={setSafetyMode}
          onAddReferences={addReferenceAttachments}
          onUploadFiles={uploadChatFiles}
          resetToken={composerResetToken}
          showStop={canInterruptConversation}
          uploadingImage={uploadingImage}
        />
      </div>
    </div>
  );

  return (
    <BrowserChatReasoningVisibilityContext.Provider value={showReasoning}>
    <section className={sidebarCollapsed ? 'browser-chat-layout sidebar-collapsed' : 'browser-chat-layout'}>
      <aside className="browser-chat-sidebar">
        <div className="browser-chat-brand">
          <strong>WebPilot QA</strong>
          <button
            className="ui-icon-button"
            onClick={toggleSidebarCollapsed}
            type="button"
            aria-label={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
          >
            <PanelLeft size={17} />
          </button>
        </div>

        <nav className="browser-chat-nav" aria-label="工作模式">
          <button
            aria-label={t('对话模式')}
            className={activeView === 'chat' ? 'browser-chat-nav-item active' : 'browser-chat-nav-item'}
            onClick={() => setActiveView('chat')}
            title={t('对话模式')}
            type="button"
          >
            <MessageSquare size={17} />
            <span>{t('对话模式')}</span>
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

        <div className="browser-chat-sidebar-footer">
          <button
            aria-label={themeMode === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
            className="browser-chat-theme-toggle"
            onClick={toggleMode}
            title={themeMode === 'dark' ? '浅色模式' : '深色模式'}
            type="button"
          >
            {themeMode === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          </button>
        </div>
      </aside>

      <main className="browser-chat-main">
        {activeView === 'target' ? (
          <div className="browser-chat-cases-pane">
            <div className="browser-chat-target-model-bar">
              <div className="browser-chat-target-copy">
                <strong>{t('目标模式模型')}</strong>
                <span>{t('当前目标模式运行将使用这个模型。')}</span>
              </div>
              <div className="browser-chat-target-model-controls">
                <CustomSelect
                  className="browser-chat-target-model-select"
                  disabled={currentBusy}
                  onChange={(value) => changeModelSelection(parseModelSelectionValue(value))}
                  options={modelSelectionOptions}
                  title={modelSelectionDiagnostic}
                  value={modelSelection}
                />
                <div className="browser-chat-target-actions" id="browser-chat-target-actions" />
              </div>
            </div>
            <DashboardWorkspace
              actionsPortalId="browser-chat-target-actions"
              activeDetailCaseId={targetDetailCaseId}
              groups={groups}
              hideListHeader
              initialActiveRunId={initialTargetRunId}
              model={modelId}
              modelProvider={modelProvider}
              onActiveDetailCaseIdChange={setTargetDetailCaseId}
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
              onModelSaved={() => void loadModelConfig()}
              onRuntimeEnvSaved={() => void loadBrowserRuntimeSettings()}
              onSkillsChanged={() => void loadSkills()}
            />
          </div>
        ) : embeddedBrowserActive ? (
          <div
            className={embeddedChatCollapsed ? 'browser-chat-embedded-workspace chat-collapsed' : 'browser-chat-embedded-workspace'}
            ref={embeddedWorkspaceRef}
            style={{ '--embedded-chat-width': `${embeddedChatWidth}px` } as CSSProperties}
          >
            <BrowserChatEmbeddedBrowser
              active={embeddedBrowserViewActive}
              enabled={embeddedBrowserEnabled}
              onSelectSession={(nextSessionId) => {
                if (nextSessionId !== activeSessionIdRef.current) void loadSession(nextSessionId);
              }}
              sessionId={session?.id}
            />
            {embeddedChatCollapsed ? null : (
              <div
                aria-label={t('调整对话栏宽度')}
                aria-orientation="vertical"
                aria-valuemax={760}
                aria-valuemin={320}
                aria-valuenow={embeddedChatWidth}
                className="browser-chat-embedded-resizer"
                onPointerDown={beginEmbeddedChatResize}
                role="separator"
                title={t('拖拽调整对话栏宽度')}
              >
                <span />
              </div>
            )}
            <aside className="browser-chat-embedded-chat-column">
              <button
                aria-label={embeddedChatCollapsed ? t('展开对话栏') : t('折叠对话栏')}
                className="ui-icon-button browser-chat-embedded-chat-toggle"
                onClick={toggleEmbeddedChatCollapsed}
                title={embeddedChatCollapsed ? t('展开对话栏') : t('折叠对话栏')}
                type="button"
              >
                <PanelRight size={17} />
              </button>
              <div className="browser-chat-embedded-chat-content">
                {renderChatPane()}
              </div>
            </aside>
          </div>
        ) : (
          <div className={hasMessages ? 'browser-chat-chat-pane has-messages' : 'browser-chat-chat-pane'} style={chatPaneStyle}>
            {loadingSessionId ? (
              <div className="browser-chat-inline-loading">
                <span aria-hidden="true" className="ui-loading-spinner ui-loading-spinner--small" />
                <span>正在加载对话</span>
              </div>
            ) : null}
            {renderChatPaneActions()}

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
                sessionBusy={selectedSessionRunning}
                stepsByIndex={stepsByIndex}
                totalStepCount={steps.length}
              />
            ) : null}

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
                modelSelection={modelSelection}
                modelSelectionTitle={modelSelectionDiagnostic}
                modelSelectionOptions={modelSelectionOptions}
                safetyMode={safetyMode}
                onInterrupt={interruptConversation}
                onModelSelectionChange={changeModelSelection}
                onModeChange={setMode}
                onRemoveAttachment={removeAttachment}
                onSubmitMessage={sendMessage}
                onSafetyModeChange={setSafetyMode}
                onAddReferences={addReferenceAttachments}
                onUploadFiles={uploadChatFiles}
                resetToken={composerResetToken}
                showStop={canInterruptConversation}
                uploadingImage={uploadingImage}
              />
            </div>
          </div>
        )}
      </main>

      {toolDialog ? (
        <BrowserChatToolDialog
          detail={toolDialog}
          onClose={() => setToolDialog(null)}
          toolLabel={(name) => browserChatToolLabel(name, t)}
        />
      ) : null}

      {logDialogMessageId ? (
        <BrowserChatLogDialog
          entries={logDialogEntries}
          messageContent={logDialogMessage ? compactText(logDialogMessage.content, 80) : undefined}
          onClose={() => setLogDialogMessageId(null)}
        />
      ) : null}

      {imagePreview ? (
        <div className="fullscreen-image-viewer" onClick={() => setImagePreview(null)} role="presentation">
          <div className="image-viewer-toolbar" onClick={(event) => event.stopPropagation()}>
            <strong>{imagePreview.name}</strong>
            <button className="ui-icon-button" onClick={() => setImagePreview(null)} type="button" aria-label="关闭">
              <X size={18} />
            </button>
          </div>
          <div className="image-viewer-stage">
            <img alt={imagePreview.name} src={imagePreview.url} onClick={(event) => event.stopPropagation()} />
          </div>
        </div>
      ) : null}

      {groupDialogOpen ? (
        <div className="ui-modal-overlay" onClick={() => setGroupDialogOpen(false)} role="presentation">
          <section className="ui-modal ui-modal--compact" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="创建分组">
            <header className="ui-modal-header">
              <div className="ui-modal-heading">
                <h2 className="ui-modal-title">{targetGroupId ? '创建子组' : '创建组'}</h2>
                <p className="ui-modal-subtitle">{targetGroupId ? `父级：${groupPath(groups, targetGroupId)}` : '创建根分组'}</p>
              </div>
              <button className="ui-icon-button ui-modal-close" onClick={() => setGroupDialogOpen(false)} type="button" aria-label="关闭">
                <X size={18} />
              </button>
            </header>
            <div className="ui-modal-body">
              <label className="modal-field">
                分组名称
                <input autoFocus className="input" value={groupName} onChange={(event) => setGroupName(event.target.value)} />
              </label>
            </div>
            <footer className="ui-modal-footer">
              <button className="ui-button ui-button--primary" disabled={creatingGroup} onClick={() => createGroup(targetGroupId)} type="button">
                {creatingGroup ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}
                {creatingGroup ? '创建中' : '创建'}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </section>
    </BrowserChatReasoningVisibilityContext.Provider>
  );
}
