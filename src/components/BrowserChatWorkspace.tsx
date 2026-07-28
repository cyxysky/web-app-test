'use client';

import { createContext, memo, type ClipboardEvent as ReactClipboardEvent, type CSSProperties, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, type WheelEvent as ReactWheelEvent, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Modifier,
} from '@dnd-kit/core';
import {
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS as DndCss } from '@dnd-kit/utilities';
import { createPortal } from 'react-dom';
import {
  AppWindow,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BadgeCheck,
  Bot,
  Brain,
  Braces,
  Bug,
  Check,
  CircleAlert,
  ChevronDown,
  ClipboardCheck,
  Compass,
  CornerDownLeft,
  CheckCircle2,
  Download,
  FileSearch,
  Folder,
  FolderOpen,
  GalleryHorizontalEnd,
  Gauge,
  Globe,
  ImageUp,
  Library,
  KeyRound,
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
  Pin,
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
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CustomSelect } from '@/components/CustomSelect';
import { BrowserChatLogDialog } from '@/components/BrowserChatLogDialog';
import { BrowserChatToolDialog } from '@/components/BrowserChatToolDialog';
import {
  browserChatDownloadPercent,
  browserChatDownloadStatusLabel,
  formatDownloadBytes,
  type SystemDownloadItem,
} from '@/components/browser-chat-download-model';
import { EnvironmentSettings, environmentSettingsTabsForUser, type EnvironmentSettingsInitialData } from '@/components/EnvironmentSettings';
import { LiquidGlassLoader } from '@/components/LiquidGlassLoader';
import {
  buildBrowserChatAiCycleRenderEntries,
  buildBrowserChatLogIndex,
  buildBrowserChatMessageRenderEntries,
  browserChatAssistantMessageHasVisibleText as modelBrowserChatAssistantMessageHasVisibleText,
  browserChatLogsForMessage,
  type BrowserChatLogIndex as BrowserChatLogIndexModel,
} from '@/components/browser-chat-message-model';
import { loadRequestedBrowserChatSessionDetail } from '@/components/browser-chat-session-selection';
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
import { withWebPilotBasePath, withoutWebPilotBasePath } from '@/lib/webpilot-base-path';
import { useTheme } from '@/theme/ThemeProvider';
import type {
  ModelProvider,
  SkillRecord,
  StepExecutionResult,
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
  inputSignature: string;
  reason?: string;
  prompt: string;
  requestedAt: string;
};

type BrowserChatToolConfirmationAction = 'confirm' | 'cancel';

type BrowserChatSession = {
  id: string;
  userId?: string;
  title: string;
  browserGroupId: string;
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

type BrowserChatView = 'chat' | 'settings';
type BrowserChatMode = 'dom';
type BrowserChatSafetyMode = 'strict' | 'full';
type BrowserChatModelConfig = RuntimeModelConfig;
type BrowserChatToolCall = NonNullable<StepExecutionResult['tools']>[number];

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'webpilotqa.sidebarCollapsed';
const EMBEDDED_CHAT_COLLAPSED_STORAGE_KEY = 'webpilotqa.embeddedChatCollapsed';

function browserChatViewForPathname(pathname: string, fallback: BrowserChatView): BrowserChatView {
  pathname = withoutWebPilotBasePath(pathname);
  if (pathname === '/settings' || pathname.startsWith('/settings/')) return 'settings';
  if (pathname === '/dashboard' || pathname.startsWith('/runs/')) return 'chat';
  if (pathname === '/browser-chat' || pathname.startsWith('/browser-chat/')) return 'chat';
  return fallback;
}

function navigateBrowserChatView(href: string) {
  const targetHref = withWebPilotBasePath(href);
  if (window.location.pathname === targetHref) return;
  window.history.pushState(null, '', targetHref);
}

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
  const lastMessage = session?.messages?.[session.messages.length - 1];
  return Boolean(lastMessage?.role === 'assistant' && lastMessage.status === 'running');
}

function isBrowserChatSessionRunning(session?: BrowserChatSession | null) {
  return Boolean(session && (session.busy || session.status === 'running' || hasRunningAssistantMessage(session)));
}

function interruptBrowserChatSessionOptimistically(session: BrowserChatSession, timestamp: string): BrowserChatSession {
  return {
    ...session,
    busy: false,
    error: undefined,
    status: session.status === 'closed' ? 'closed' : 'idle',
    // Keep the server timestamp so the authoritative interrupt response is
    // never rejected as "older" when the Web client clock is ahead.
    updatedAt: session.updatedAt,
    messages: session.messages.map((message) => (
      message.role === 'assistant' && message.status === 'running'
        ? { ...message, activity: undefined, status: 'interrupted', updatedAt: timestamp }
        : message
    )),
    steps: session.steps.map((step) => (
      step.status === 'queued' || step.status === 'running'
        ? { ...step, status: 'blocked' }
        : step
    )),
  };
}

type BrowserChatToolDetail = {
  stepIndex: number;
  step: StepExecutionResult;
  toolIndex: number;
  tool: BrowserChatToolCall;
};

type BrowserChatTimelineStepEntry = {
  step: StepExecutionResult;
  visibleToolIndexes?: readonly number[];
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
  faviconUrl?: string;
  groupId?: string;
  id: string;
  pinned?: boolean;
  sessionId?: string;
  title: string;
  url: string;
  loading?: boolean;
};

type EmbeddedBrowserGroup = {
  active?: boolean;
  activeTabId?: string;
  collapsed?: boolean;
  id: string;
  label?: string;
  sessionId?: string;
  tabs: EmbeddedBrowserTab[];
};

type EmbeddedBrowserTabDndData = {
  groupId: string;
  tabId: string;
  type: 'embedded-browser-tab';
};

type EmbeddedBrowserGroupDndData = {
  groupId: string;
  type: 'embedded-browser-group';
};

type EmbeddedBrowserTabDragPreview = Record<string, string[]>;

type EmbeddedBrowserTabDropTarget =
  | { groupId: string; type: 'embedded-browser-group' }
  | { groupId: string; position: 'before' | 'after'; tabId: string; type: 'embedded-browser-tab' };

const EMBEDDED_BROWSER_TAB_DND_PREFIX = 'embedded-browser-tab:';
const EMBEDDED_BROWSER_GROUP_DND_PREFIX = 'embedded-browser-group:';
const EMBEDDED_BROWSER_TAB_COLLISION_Y_TOLERANCE = 36;
const EMBEDDED_BROWSER_TAB_VERTICAL_DAMPING_RANGE = 36;
const EMBEDDED_BROWSER_TAB_VERTICAL_DAMPING = 0.22;
const embeddedBrowserTabTrackModifier: Modifier = ({ transform }) => {
  const verticalDistance = Math.abs(transform.y);
  const dampedDistance = Math.min(verticalDistance, EMBEDDED_BROWSER_TAB_VERTICAL_DAMPING_RANGE)
    * EMBEDDED_BROWSER_TAB_VERTICAL_DAMPING;
  return {
    ...transform,
    y: Math.sign(transform.y) * (
      dampedDistance + Math.max(0, verticalDistance - EMBEDDED_BROWSER_TAB_VERTICAL_DAMPING_RANGE)
    ),
  };
};
const embeddedBrowserTabModifiers = [embeddedBrowserTabTrackModifier];

function embeddedBrowserTabDndId(tabId: string) {
  return `${EMBEDDED_BROWSER_TAB_DND_PREFIX}${tabId}`;
}

function embeddedBrowserGroupDndId(groupId: string) {
  return `${EMBEDDED_BROWSER_GROUP_DND_PREFIX}${groupId}`;
}

function embeddedBrowserGroupEndDndId(groupId: string) {
  return `${embeddedBrowserGroupDndId(groupId)}:end`;
}

const embeddedBrowserTabCollisionDetection: CollisionDetection = (input) => {
  const collisions = pointerWithin(input);
  if (!collisions.length) {
    if (!input.pointerCoordinates) return closestCenter(input);
    const tabContainers = input.droppableContainers.filter((container) => {
      const data = container.data.current as EmbeddedBrowserTabDndData | undefined;
      return data?.type === 'embedded-browser-tab' && container.rect.current;
    });
    const tabRects = tabContainers.flatMap((container) => container.rect.current ? [container.rect.current] : []);
    const tabTrackTop = tabRects.length ? Math.min(...tabRects.map((rect) => rect.top)) : 0;
    const tabTrackBottom = tabRects.length ? Math.max(...tabRects.map((rect) => rect.bottom)) : 0;
    const pointerNearTabTrack = tabRects.length > 0
      && input.pointerCoordinates.y >= tabTrackTop - EMBEDDED_BROWSER_TAB_COLLISION_Y_TOLERANCE
      && input.pointerCoordinates.y <= tabTrackBottom + EMBEDDED_BROWSER_TAB_COLLISION_Y_TOLERANCE;
    return pointerNearTabTrack
      ? closestCenter({ ...input, droppableContainers: tabContainers })
      : [];
  }
  const tabCollisions = collisions.filter((collision) => (
    collision.id !== input.active.id
    && String(collision.id).startsWith(EMBEDDED_BROWSER_TAB_DND_PREFIX)
  ));
  if (tabCollisions.length) return tabCollisions;
  const activeCollision = collisions.find((collision) => collision.id === input.active.id);
  if (activeCollision) return [activeCollision];
  const groupCollision = collisions.find((collision) => String(collision.id).startsWith(EMBEDDED_BROWSER_GROUP_DND_PREFIX));
  const groupData = groupCollision?.data?.droppableContainer.data.current as EmbeddedBrowserGroupDndData | undefined;
  if (!groupData) return collisions;
  const groupTabs = input.droppableContainers.filter((container) => {
    const data = container.data.current as EmbeddedBrowserTabDndData | undefined;
    return data?.type === 'embedded-browser-tab' && data.groupId === groupData.groupId;
  });
  return groupTabs.length ? closestCenter({ ...input, droppableContainers: groupTabs }) : groupCollision ? [groupCollision] : collisions;
};

type EmbeddedBrowserState = EmbeddedBrowserBridgeResult & {
  activeGroupId?: string;
  activeIndex?: number;
  activeTabId?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  groups?: EmbeddedBrowserGroup[];
  libraryPanel?: 'library';
  tabs?: EmbeddedBrowserTab[];
  zoomFactor?: number;
};

type EmbeddedBrowserBridge = {
  activateTab: (input: { id: string }) => Promise<EmbeddedBrowserState>;
  closeActiveTab: () => Promise<EmbeddedBrowserBridgeResult>;
  closeGroup: (input: { id: string }) => Promise<EmbeddedBrowserState>;
  discardGroup?: (input: { clearStorage?: boolean; id: string }) => Promise<EmbeddedBrowserState>;
  closeTab: (input: { id: string }) => Promise<EmbeddedBrowserState>;
  createGroup: (input: { label?: string }) => Promise<EmbeddedBrowserState>;
  createTab: (input: { groupId?: string; sessionId?: string; userId?: string; url?: string }) => Promise<EmbeddedBrowserState>;
  getState: () => Promise<EmbeddedBrowserState>;
  goBack: () => Promise<EmbeddedBrowserState>;
  goForward: () => Promise<EmbeddedBrowserState>;
  moveTab: (input: { id: string; position?: 'before' | 'after' | 'end'; targetGroupId?: string; targetId?: string; targetSessionId?: string }) => Promise<EmbeddedBrowserState>;
  navigate: (input: { groupId?: string; id?: string; sessionId?: string; url: string }) => Promise<EmbeddedBrowserBridgeResult>;
  onFocusAddress: (listener: () => void) => () => void;
  onStateChange: (listener: (state: EmbeddedBrowserState) => void) => () => void;
  reload: () => Promise<EmbeddedBrowserState>;
  reset: () => Promise<EmbeddedBrowserBridgeResult>;
  setBounds: (bounds: EmbeddedBrowserBounds) => Promise<EmbeddedBrowserBridgeResult>;
  setGroupCollapsed: (input: { collapsed: boolean; id: string }) => Promise<EmbeddedBrowserState>;
  setLibraryPanel: (input: { panel: 'library' | null }) => Promise<EmbeddedBrowserState>;
  toggleLibraryPanel?: (input: { panel: 'library' }) => Promise<EmbeddedBrowserState>;
  setTabMuted: (input: { id: string; muted?: boolean }) => Promise<EmbeddedBrowserState>;
  showTabContextMenu: (input: { groups: Array<{ id: string; label: string }>; id: string }) => Promise<EmbeddedBrowserBridgeResult>;
  setVisible: (input: {
    bounds?: EmbeddedBrowserBounds;
    createIfMissing?: boolean;
    groupId?: string;
    id?: string;
    sessionId?: string;
    userId?: string;
    url?: string;
    visible: boolean;
  }) => Promise<EmbeddedBrowserState>;
  stop?: () => Promise<EmbeddedBrowserState>;
  toggleBookmark: () => Promise<EmbeddedBrowserState>;
};

declare global {
  interface Window {
    webPilotEmbeddedBrowser?: EmbeddedBrowserBridge;
  }
}


function SettingsTabIcon({ tab }: { tab: SettingsTab }) {
  if (tab === 'model') return <Bot size={15} />;
  if (tab === 'browser') return <PanelLeft size={15} />;
  if (tab === 'runtime') return <SquareTerminal size={15} />;
  if (tab === 'skills') return <Braces size={15} />;
  if (tab === 'memory') return <Brain size={15} />;
  if (tab === 'accounts') return <KeyRound size={15} />;
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

const EMBEDDED_BROWSER_GROUP_ICON_COLORS = ['#10a37f', '#4f8cff', '#9b6fe8', '#e38b2d', '#d85b7d', '#27a9b2', '#7aa83e', '#c65ed0', '#e05b45', '#3978c5'];

function embeddedBrowserGroupIconColorIndex(groupId: string) {
  let hash = 0;
  for (const character of groupId) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return Math.abs(hash) % EMBEDDED_BROWSER_GROUP_ICON_COLORS.length;
}

function embeddedBrowserGroupIconColor(groupId?: string) {
  return EMBEDDED_BROWSER_GROUP_ICON_COLORS[embeddedBrowserGroupIconColorIndex(groupId || 'default')];
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

type BrowserChatAiOutputPart =
  | { index: number; kind: 'reasoning' }
  | { index: number; kind: 'text' }
  | { index: number; kind: 'tool' };

type BrowserChatAiOutputView = {
  parts: BrowserChatAiOutputPart[];
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
  if (!record) return { parts: [], reasoning: [], texts: [], tools: [] };
  const type = String(record.type || '').toLowerCase();
  if (type === 'reasoning') {
    const text = textFromAiContentPart(record);
    return { parts: text ? [{ index: 0, kind: 'reasoning' }] : [], reasoning: text ? [text] : [], texts: [], tools: [] };
  }
  if (type === 'text') {
    const text = textFromAiContentPart(record);
    return { parts: text ? [{ index: 0, kind: 'text' }] : [], reasoning: [], texts: text ? [text] : [], tools: [] };
  }
  if (type === 'tool-call' || type === 'tool_call') {
    const name = stringFromUnknown(record.toolName) || stringFromUnknown(record.name) || stringFromUnknown(record.tool);
    if (!name) return { parts: [], reasoning: [], texts: [], tools: [] };
    const input = record.input ?? record.args ?? record.arguments;
    return {
      parts: [{ index: 0, kind: 'tool' }],
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
  return { parts: [], reasoning: [], texts: [], tools: [] };
}

function mergeAiOutputView(target: BrowserChatAiOutputView, source: BrowserChatAiOutputView) {
  const offsets = {
    reasoning: target.reasoning.length,
    text: target.texts.length,
    tool: target.tools.length,
  };
  target.parts.push(...source.parts.map((part) => ({
    ...part,
    index: part.index + offsets[part.kind],
  })));
  target.reasoning.push(...source.reasoning);
  target.texts.push(...source.texts);
  target.tools.push(...source.tools);
}

function aiOutputViewFromContentParts(parts: unknown[]) {
  const output: BrowserChatAiOutputView = { parts: [], reasoning: [], texts: [], tools: [] };
  for (const part of parts) {
    mergeAiOutputView(output, normalizeAiContentPart(part));
  }
  return output;
}

export function aiOutputViewFromResponse(response: unknown) {
  const record = asRecord(response);
  if (!record) return { parts: [], reasoning: [], texts: [], tools: [] };
  const output: BrowserChatAiOutputView = { parts: [], reasoning: [], texts: [], tools: [] };
  mergeAiOutputView(output, aiOutputViewFromContentParts(arrayFromUnknown(record.content)));
  if (!output.reasoning.length && !output.texts.length) {
    const reasoningText = stringFromUnknown(record.reasoningText);
    if (reasoningText) mergeAiOutputView(output, normalizeAiContentPart({ type: 'reasoning', text: reasoningText }));
    const text = stringFromUnknown(record.text);
    if (text) mergeAiOutputView(output, normalizeAiContentPart({ type: 'text', text }));
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

function compactAiOutputView(output: BrowserChatAiOutputView): BrowserChatAiOutputView {
  const compacted: BrowserChatAiOutputView = { parts: [], reasoning: [], texts: [], tools: [] };
  const seenReasoning = new Set<string>();
  const seenTexts = new Set<string>();
  const seenTools = new Set<string>();
  for (const part of output.parts) {
    if (part.kind === 'reasoning') {
      const value = output.reasoning[part.index];
      const key = value?.replace(/\s+/g, ' ').trim();
      if (!key || seenReasoning.has(key)) continue;
      seenReasoning.add(key);
      mergeAiOutputView(compacted, normalizeAiContentPart({ type: 'reasoning', text: value }));
      continue;
    }
    if (part.kind === 'text') {
      const value = output.texts[part.index];
      const key = value?.replace(/\s+/g, ' ').trim();
      if (!key || seenTexts.has(key)) continue;
      seenTexts.add(key);
      mergeAiOutputView(compacted, normalizeAiContentPart({ type: 'text', text: value }));
      continue;
    }
    const tool = output.tools[part.index];
    if (!tool) continue;
    const key = `${tool.name}:${formatToolPayload(tool.input)}`;
    if (seenTools.has(key)) continue;
    seenTools.add(key);
    compacted.parts.push({ index: compacted.tools.length, kind: 'tool' });
    compacted.tools.push(tool);
  }
  return compacted;
}

function hasAiOutputView(output: BrowserChatAiOutputView) {
  return Boolean(output.reasoning.length || output.texts.length || output.tools.length);
}

function isCodexRuntimeObjectEnvelope(value: string) {
  const parsed = parseJsonObjectText(value);
  if (!parsed) return false;
  if (typeof parsed.type !== 'string' || !parsed.type.trim()) return false;
  const hasMessage = typeof parsed.message === 'string';
  const hasParams = parsed.params !== null
    && typeof parsed.params === 'object'
    && !Array.isArray(parsed.params);
  return hasMessage || hasParams;
}

function embeddedGroupIdsForChatSession(session?: BrowserChatSession, includeSessionGroup = true) {
  if (!session) return [];
  return Array.from(new Set([
    ...(includeSessionGroup ? [embeddedGroupIdForSession(session.id)] : []),
  ]));
}

async function discardEmbeddedBrowserDataForSessions(
  targetSessions: BrowserChatSession[],
  options: { includeSessionGroups?: boolean } = {},
) {
  const bridge = typeof window === 'undefined' ? undefined : window.webPilotEmbeddedBrowser;
  if (!bridge?.discardGroup) return;
  const groupIds = new Set(targetSessions.flatMap((session) => (
    embeddedGroupIdsForChatSession(session, options.includeSessionGroups !== false)
  )));
  for (const groupId of groupIds) {
    await bridge.discardGroup({ clearStorage: true, id: groupId }).catch(() => undefined);
  }
}

function aiOutputCyclesFromLogs(logs: BrowserChatLogRecord[]): BrowserChatAiOutputCycle[] {
  const cycles: BrowserChatAiOutputCycle[] = [];
  logs.forEach((log, index) => {
    if (log.phase.startsWith('subagent:')) return;
    if (log.phase !== 'ai:runtime:response' && log.phase !== 'ai:runtime:object') return;
    const parsed = parseJsonObjectText(log.details);
    const aiOutput = asRecord(parsed?.aiOutput);
    if (!aiOutput) return;
    const output = aiOutputViewFromResponse(aiOutput.response);
    const fallbackText = stringFromUnknown(aiOutput.text);
    if (fallbackText) mergeAiOutputView(output, normalizeAiContentPart({ type: 'text', text: fallbackText }));
    if (log.phase === 'ai:runtime:object') {
      output.parts = output.parts.filter((part) => (
        part.kind !== 'text' || !isCodexRuntimeObjectEnvelope(output.texts[part.index] || '')
      ));
    }
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
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (!input || typeof input !== 'object') return input;
    const record = input as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record)
      .filter((key) => key !== 'reason' && key !== 'requiresConfirmation' && key !== 'confirmationMessage')
      .sort()
      .map((key) => [key, canonicalize(record[key])]));
  };
  try {
    return JSON.stringify(canonicalize(value)) || '';
  } catch {
    return '';
  }
}

export function buildAiCycleToolDetailMap(cycles: BrowserChatAiOutputCycle[], steps: StepExecutionResult[]) {
  const details = new Map<string, BrowserChatToolDetail>();
  const usedStepTools = new Set<string>();

  cycles.forEach((cycle) => {
    const candidateSteps = typeof cycle.stepIndex === 'number'
      ? steps.filter((step) => step.index === cycle.stepIndex)
      : steps;

    cycle.output.tools.forEach((aiTool, aiToolIndex) => {
      const exactInput = toolInputSignature(aiTool.input);
      const sameNameCandidates: BrowserChatToolDetail[] = [];

      for (const step of candidateSteps) {
        const toolCalls = step.tools || [];
        for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex += 1) {
          const tool = toolCalls[toolIndex];
          if (!tool) continue;
          const usedKey = `${step.index}:${toolIndex}`;
          if (usedStepTools.has(usedKey) || tool.name !== aiTool.name) continue;

          const detail = { stepIndex: step.index, step, toolIndex, tool };
          sameNameCandidates.push(detail);
          if (aiTool.id && tool.id === aiTool.id) {
            details.set(aiCycleToolKey(cycle.id, aiToolIndex), detail);
            usedStepTools.add(usedKey);
            return;
          }
          if (!exactInput || toolInputSignature(tool.input) === exactInput) {
            details.set(aiCycleToolKey(cycle.id, aiToolIndex), detail);
            usedStepTools.add(usedKey);
            return;
          }
        }
      }

      // Tool inputs are normalized before execution (for example readFile adds
      // its default limit), so the persisted input is not always byte-for-byte
      // equal to the model request. Within one step both sources are ordered;
      // prefer the matching reason, then consume the next unused same-name call.
      const normalizedReason = aiTool.reason?.replace(/\s+/g, ' ').trim();
      const detail = sameNameCandidates.find((candidate) => (
        normalizedReason
        && candidate.tool.reason?.replace(/\s+/g, ' ').trim() === normalizedReason
      )) || sameNameCandidates[0];
      if (detail) {
        details.set(aiCycleToolKey(cycle.id, aiToolIndex), detail);
        usedStepTools.add(`${detail.step.index}:${detail.toolIndex}`);
      }
    });
  });

  return details;
}

function isRecoveredTransientTool(tool: BrowserChatToolCall | undefined) {
  return tool?.recovered === true && tool.transient === true;
}

function toolStatusLabel(tool: BrowserChatToolCall) {
  if (isRecoveredTransientTool(tool)) return '已恢复';
  if (tool.ok === true) return '已完成';
  if (tool.ok === false) return '失败';
  return '执行中';
}

function browserChatToolPresentation(
  tool: BrowserChatToolCall | undefined,
  step: StepExecutionResult | undefined,
  turnRunning: boolean,
) {
  if (!tool || !step) return { isActive: false, stateClass: '', status: '已请求' };
  const isActive = turnRunning && step.status === 'running' && tool.ok === undefined;
  const inferredFailed = !isActive && tool.ok === undefined && step.status === 'failed';
  const failed = (tool.ok === false && !isRecoveredTransientTool(tool)) || inferredFailed;
  return {
    isActive,
    stateClass: failed ? ' is-failed' : isActive ? ' is-running' : '',
    status: tool.ok !== undefined
      ? toolStatusLabel(tool)
      : isActive ? '执行中' : inferredFailed ? '失败' : step.status === 'blocked' ? '已暂停' : '已完成',
  };
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
    browserCode: '执行浏览器代码',
    readSubagent: '读取子 Agent',
    reportState: '确认状态',
    spawnSubagents: '并行子 Agent',
    waitForHumanVerification: '等待人工验证',
  };
  if (labels[name]) return t(labels[name]);

  const lower = name.toLowerCase();
  if (lower.includes('screenshot') || lower.includes('capture')) return t('截屏取证');
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
  if (name === 'browserCode') return toolInputValue(record, ['reason']) || 'Playwright';
  if (name === 'readSubagent') return toolInputValue(record, ['uuid']);
  if (name === 'waitForHumanVerification') return toolInputValue(record, ['maxMs']);
  if (name === 'spawnSubagents') return Array.isArray(record.tasks) ? `${record.tasks.length} 个任务` : '';
  if (name === 'reportState') return toolInputValue(record, ['action', 'actual', 'status']);
  if (lower.includes('fill')) return summarizeToolFields(record.fields) || toolInputValue(record, ['text', 'content', 'value']);
  if (lower.includes('click') || lower.includes('hover') || lower.includes('drag')) {
    return toolInputValue(record, ['text', 'targetVisual', 'targetText', 'id', 'fromId']);
  }
  if (lower.includes('find')) return toolInputValue(record, ['targetText', 'scopeId']);
  if (lower.includes('text')) return toolInputValue(record, ['text', 'targetText', 'id']);
  return toolInputValue(record, ['url', 'text', 'query', 'action', 'status']);
}

function BrowserChatToolIcon({ name }: { name: string }) {
  const lower = name.toLowerCase();
  if (name === 'browserCode') return <Braces size={13} />;
  if (lower.includes('subagent')) return <Waypoints size={13} />;
  if (lower.includes('screenshot') || lower.includes('capture')) return <GalleryHorizontalEnd size={13} />;
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

type ToolTailRain = {
  alpha: number;
  head: boolean;
  length: number;
  phase: number;
  speed: number;
  width: number;
  wobble: number;
  x: number;
  y: number;
};

type ToolTailDust = {
  alpha: number;
  blur: number;
  drift: number;
  phase: number;
  radius: number;
  speed: number;
  twinkle: number;
  x: number;
  y: number;
};

type ToolTailBeam = {
  alpha: number;
  drift: number;
  height: number;
  phase: number;
  y: number;
};

type ToolTailSourceSpark = {
  alpha: number;
  delay: number;
  distance: number;
  duration: number;
  life: number;
  localY: number;
  width: number;
};

type ToolTailFlowParticle = {
  createdAt: number;
  distance: number;
  duration: number;
  expiresAt: number;
  id: number;
  start: number;
  width: number;
  y: number;
};

function toolTailClamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

const BrowserChatToolTailParticles = memo(function BrowserChatToolTailParticles() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [flowParticles, setFlowParticles] = useState<ToolTailFlowParticle[]>([]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const context = canvas.getContext('2d');
    if (!context) return undefined;

    let beams: ToolTailBeam[] = [];
    let dust: ToolTailDust[] = [];
    let frame = 0;
    let elapsed = 0;
    let lastTimestamp = 0;
    let rain: ToolTailRain[] = [];
    let sourceSparks: ToolTailSourceSpark[] = [];
    let width = 0;
    let height = 0;
    let emitterRadius = 15;
    let lightTheme = true;
    let canvasVisible = true;
    let documentVisible = document.visibilityState !== 'hidden';
    let pixelRatio = 1;
    const emitterOverlap = 20;
    const random = (minimum: number, maximum: number) => minimum + Math.random() * (maximum - minimum);

    const updateTheme = () => {
      const theme = document.documentElement.dataset.theme;
      lightTheme = theme ? theme !== 'dark' : !window.matchMedia('(prefers-color-scheme: dark)').matches;
    };
    const emitterX = (localY: number) => {
      const y = Math.min(emitterRadius, Math.abs(localY));
      return emitterOverlap - emitterRadius + Math.sqrt(Math.max(0, emitterRadius ** 2 - y ** 2));
    };

    const makeRain = (initial = false): ToolTailRain => ({
      alpha: random(0.16, 0.72),
      head: Math.random() < 0.46,
      length: random(12, 68) * random(0.72, 1.25),
      phase: random(0, Math.PI * 2),
      speed: random(52, 170),
      width: random(0.4, 1.2),
      wobble: random(0.4, 2),
      x: initial ? random(-width * 0.25, width) : random(-width * 0.34, -8),
      y: random(5, Math.max(6, height - 5)),
    });
    const makeDust = (initial = false): ToolTailDust => {
      const depth = Math.random();
      return {
        alpha: random(0.16, 0.92) * (0.52 + depth * 0.48),
        blur: random(0, 5) * (1 - depth),
        drift: random(-7, 7),
        phase: random(0, Math.PI * 2),
        radius: random(0.45, 2.4) * (0.55 + depth),
        speed: random(8, 31) * (0.55 + depth),
        twinkle: random(1.1, 4.2),
        x: initial ? random(-10, width + 10) : random(-20, -2),
        y: random(3, Math.max(4, height - 3)),
      };
    };
    const makeSourceSpark = (initial = false): ToolTailSourceSpark => ({
      alpha: random(0.22, 0.9),
      delay: random(0, 2.2),
      distance: random(12, Math.max(13, width * 0.28)),
      duration: random(0.75, 2.8),
      life: initial ? random(0, 1) : 0,
      localY: random(-emitterRadius * 0.94, emitterRadius * 0.94),
      width: random(0.45, 1.5),
    });
    const buildScene = () => {
      const areaScale = Math.sqrt((width * height) / (500 * 280));
      beams = Array.from({ length: Math.max(7, Math.round(14 * areaScale)) }, () => ({
        alpha: random(0.018, 0.075),
        drift: random(-4, 4),
        height: random(1, 7),
        phase: random(0, Math.PI * 2),
        y: random(0, height),
      }));
      rain = Array.from({ length: Math.max(32, Math.round(43 * areaScale)) }, () => makeRain(true));
      dust = Array.from({ length: Math.max(78, Math.round(104 * areaScale)) }, () => makeDust(true));
      sourceSparks = Array.from({ length: Math.max(14, Math.round(18 * areaScale)) }, () => makeSourceSpark(true));
    };
    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const nextWidth = Math.max(1, bounds.width);
      const nextHeight = Math.max(1, bounds.height);
      const nextPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const sizeChanged = Math.abs(width - nextWidth) > 0.5
        || Math.abs(height - nextHeight) > 0.5
        || pixelRatio !== nextPixelRatio;
      width = nextWidth;
      height = nextHeight;
      pixelRatio = nextPixelRatio;
      const toolHeight = canvas.parentElement?.getBoundingClientRect().height || 32;
      emitterRadius = Math.max(8, Math.min(20, (toolHeight - 2) / 2));
      updateTheme();
      if (!sizeChanged) return;
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.imageSmoothingEnabled = true;
      buildScene();
    };

    const update = (deltaSeconds: number) => {
      elapsed += deltaSeconds;
      for (let index = 0; index < rain.length; index += 1) {
        const drop = rain[index];
        drop.x += drop.speed * deltaSeconds;
        drop.y += Math.sin(elapsed * drop.wobble + drop.phase) * 0.06;
        if (drop.x - drop.length > width + 10) rain[index] = makeRain(false);
      }
      for (let index = 0; index < dust.length; index += 1) {
        const particle = dust[index];
        particle.x += particle.speed * deltaSeconds;
        particle.y += (particle.drift + Math.sin(elapsed * 0.7 + particle.phase) * 4) * deltaSeconds;
        if (particle.x - particle.radius > width + 12 || particle.y < -24 || particle.y > height + 24) {
          dust[index] = makeDust(false);
        }
      }
      for (let index = 0; index < sourceSparks.length; index += 1) {
        const spark = sourceSparks[index];
        if (spark.delay > 0) spark.delay -= deltaSeconds;
        else {
          spark.life += deltaSeconds / spark.duration;
          if (spark.life >= 1) sourceSparks[index] = makeSourceSpark(false);
        }
      }
    };

    const drawAtmosphere = () => {
      context.save();
      context.globalCompositeOperation = lightTheme ? 'source-over' : 'lighter';
      context.translate(emitterOverlap, height / 2);
      context.scale(1, 0.56);
      const haze = context.createRadialGradient(0, 0, 0, 0, 0, width * 0.72);
      haze.addColorStop(0, lightTheme ? 'rgba(0, 166, 214, 0.08)' : 'rgba(0, 146, 255, 0.13)');
      haze.addColorStop(0.46, lightTheme ? 'rgba(0, 137, 197, 0.035)' : 'rgba(0, 87, 169, 0.055)');
      haze.addColorStop(1, 'rgba(0, 105, 255, 0)');
      context.fillStyle = haze;
      context.fillRect(-20, -height, width + 40, height * 2);
      context.restore();

      context.save();
      context.globalCompositeOperation = lightTheme ? 'source-over' : 'lighter';
      context.filter = `blur(${Math.max(2, width / 180)}px)`;
      for (const beam of beams) {
        const y = beam.y + Math.sin(elapsed * 0.18 + beam.phase) * beam.drift;
        const gradient = context.createLinearGradient(0, y, width, y);
        gradient.addColorStop(0, 'rgba(0, 156, 255, 0)');
        gradient.addColorStop(0.28, lightTheme
          ? `rgba(0, 135, 190, ${beam.alpha * 0.28})`
          : `rgba(0, 156, 255, ${beam.alpha * 0.34})`);
        gradient.addColorStop(0.74, lightTheme
          ? `rgba(0, 162, 205, ${beam.alpha * 0.72})`
          : `rgba(0, 188, 255, ${beam.alpha})`);
        gradient.addColorStop(1, 'rgba(0, 225, 255, 0)');
        context.fillStyle = gradient;
        context.fillRect(0, y - beam.height / 2, width, beam.height);
      }
      context.restore();
    };

    const drawRain = () => {
      context.save();
      context.globalCompositeOperation = lightTheme ? 'source-over' : 'lighter';
      context.lineCap = 'round';
      context.filter = 'blur(2px)';
      for (const drop of rain) {
        const x0 = drop.x - drop.length;
        const gradient = context.createLinearGradient(x0, drop.y, drop.x, drop.y);
        gradient.addColorStop(0, 'rgba(0, 118, 255, 0)');
        gradient.addColorStop(0.7, lightTheme
          ? `rgba(0, 137, 193, ${drop.alpha * 0.14})`
          : `rgba(0, 173, 255, ${drop.alpha * 0.22})`);
        gradient.addColorStop(1, lightTheme
          ? `rgba(0, 176, 211, ${drop.alpha * 0.34})`
          : `rgba(74, 235, 255, ${drop.alpha * 0.5})`);
        context.strokeStyle = gradient;
        context.lineWidth = drop.width * 3.4;
        context.beginPath();
        context.moveTo(x0, drop.y);
        context.lineTo(drop.x, drop.y);
        context.stroke();
      }
      context.restore();

      context.save();
      context.globalCompositeOperation = lightTheme ? 'source-over' : 'lighter';
      context.lineCap = 'round';
      for (const drop of rain) {
        const x0 = drop.x - drop.length;
        const gradient = context.createLinearGradient(x0, drop.y, drop.x, drop.y);
        gradient.addColorStop(0, 'rgba(0, 113, 232, 0)');
        gradient.addColorStop(0.55, lightTheme
          ? `rgba(0, 117, 174, ${drop.alpha * 0.26})`
          : `rgba(0, 146, 255, ${drop.alpha * 0.32})`);
        gradient.addColorStop(1, lightTheme
          ? `rgba(0, 156, 201, ${drop.alpha * 0.88})`
          : `rgba(106, 246, 255, ${drop.alpha})`);
        context.strokeStyle = gradient;
        context.lineWidth = drop.width;
        context.beginPath();
        context.moveTo(x0, drop.y);
        context.lineTo(drop.x, drop.y);
        context.stroke();
        if (drop.head) {
          context.fillStyle = lightTheme
            ? `rgba(0, 151, 197, ${drop.alpha * 0.92})`
            : `rgba(138, 250, 255, ${drop.alpha * 0.92})`;
          context.beginPath();
          context.arc(drop.x, drop.y, Math.max(0.55, drop.width * 0.76), 0, Math.PI * 2);
          context.fill();
        }
      }
      context.restore();
    };

    const drawDust = () => {
      context.save();
      context.globalCompositeOperation = lightTheme ? 'source-over' : 'lighter';
      for (const particle of dust) {
        const pulse = 0.58 + 0.42 * Math.sin(elapsed * particle.twinkle + particle.phase);
        const alpha = toolTailClamp(particle.alpha * (0.72 + pulse * 0.42), 0, 1);
        const radius = particle.radius * (1 + pulse * 0.12);
        if (particle.blur > 1.6) {
          context.filter = `blur(${particle.blur}px)`;
          context.fillStyle = lightTheme
            ? `rgba(0, 145, 194, ${alpha * 0.18})`
            : `rgba(0, 176, 255, ${alpha * 0.28})`;
          context.beginPath();
          context.arc(particle.x, particle.y, radius * 2.15, 0, Math.PI * 2);
          context.fill();
        }
        context.filter = 'none';
        const glow = context.createRadialGradient(particle.x, particle.y, 0, particle.x, particle.y, radius * 3.5);
        glow.addColorStop(0, lightTheme
          ? `rgba(0, 135, 180, ${alpha * 0.95})`
          : `rgba(169, 255, 255, ${alpha})`);
        glow.addColorStop(0.18, lightTheme
          ? `rgba(0, 177, 210, ${alpha * 0.68})`
          : `rgba(57, 225, 255, ${alpha * 0.86})`);
        glow.addColorStop(0.56, lightTheme
          ? `rgba(0, 139, 202, ${alpha * 0.18})`
          : `rgba(0, 143, 255, ${alpha * 0.24})`);
        glow.addColorStop(1, 'rgba(0, 105, 255, 0)');
        context.fillStyle = glow;
        context.beginPath();
        context.arc(particle.x, particle.y, radius * 3.5, 0, Math.PI * 2);
        context.fill();
      }
      context.restore();
    };

    const drawSourceSparks = () => {
      context.save();
      context.globalCompositeOperation = lightTheme ? 'source-over' : 'lighter';
      context.lineCap = 'round';
      for (const spark of sourceSparks) {
        if (spark.delay > 0) continue;
        const progress = toolTailClamp(spark.life, 0, 1);
        const travel = 1 - (1 - Math.min(progress * 2.1, 1)) ** 3;
        const fade = progress < 0.18 ? progress / 0.18 : 1 - (progress - 0.18) / 0.82;
        const alpha = Math.max(0, fade) * spark.alpha;
        const sourceX = emitterX(spark.localY) + 1;
        const y = height / 2 + spark.localY;
        const headX = sourceX + spark.distance * travel;

        context.filter = 'blur(3px)';
        const soft = context.createLinearGradient(sourceX, y, headX, y);
        soft.addColorStop(0, lightTheme
          ? `rgba(0, 160, 204, ${alpha * 0.42})`
          : `rgba(0, 229, 255, ${alpha * 0.7})`);
        soft.addColorStop(0.65, lightTheme
          ? `rgba(0, 126, 191, ${alpha * 0.12})`
          : `rgba(0, 156, 255, ${alpha * 0.18})`);
        soft.addColorStop(1, 'rgba(0, 118, 255, 0)');
        context.strokeStyle = soft;
        context.lineWidth = spark.width * 5;
        context.beginPath();
        context.moveTo(sourceX, y);
        context.lineTo(headX, y);
        context.stroke();

        context.filter = 'none';
        const core = context.createLinearGradient(sourceX, y, headX, y);
        core.addColorStop(0, lightTheme
          ? `rgba(0, 137, 183, ${alpha * 0.9})`
          : `rgba(181, 255, 255, ${alpha})`);
        core.addColorStop(0.45, lightTheme
          ? `rgba(0, 181, 211, ${alpha * 0.64})`
          : `rgba(29, 223, 255, ${alpha * 0.75})`);
        core.addColorStop(1, 'rgba(0, 158, 255, 0)');
        context.strokeStyle = core;
        context.lineWidth = spark.width;
        context.beginPath();
        context.moveTo(sourceX, y);
        context.lineTo(headX, y);
        context.stroke();

        const orb = context.createRadialGradient(headX, y, 0, headX, y, 5 + spark.width * 2);
        orb.addColorStop(0, lightTheme
          ? `rgba(0, 139, 180, ${alpha * 0.95})`
          : `rgba(210, 255, 255, ${alpha})`);
        orb.addColorStop(0.22, lightTheme
          ? `rgba(0, 185, 213, ${alpha * 0.58})`
          : `rgba(53, 236, 255, ${alpha * 0.72})`);
        orb.addColorStop(1, 'rgba(0, 130, 255, 0)');
        context.fillStyle = orb;
        context.beginPath();
        context.arc(headX, y, 5 + spark.width * 2, 0, Math.PI * 2);
        context.fill();
      }
      context.restore();
    };

    const drawEmitter = () => {
      context.save();
      context.globalCompositeOperation = lightTheme ? 'source-over' : 'lighter';
      context.lineCap = 'round';
      const traceArc = () => {
        context.beginPath();
        let first = true;
        for (let y = -emitterRadius + 0.5; y <= emitterRadius - 0.5; y += 0.75) {
          const x = emitterX(y) + 1.5;
          if (first) {
            context.moveTo(x, height / 2 + y);
            first = false;
          } else context.lineTo(x, height / 2 + y);
        }
      };
      traceArc();
      context.strokeStyle = lightTheme
        ? 'rgba(0, 143, 190, 0.07)'
        : 'rgba(0, 118, 255, 0.2)';
      context.lineWidth = 14;
      context.shadowBlur = lightTheme ? 8 : 16;
      context.shadowColor = lightTheme ? 'rgba(0, 166, 210, 0.3)' : 'rgba(0, 198, 255, 0.82)';
      context.stroke();
      traceArc();
      context.strokeStyle = lightTheme
        ? 'rgba(0, 154, 197, 0.2)'
        : 'rgba(0, 218, 255, 0.58)';
      context.lineWidth = 5.5;
      context.shadowBlur = lightTheme ? 4 : 7;
      context.stroke();
      traceArc();
      context.strokeStyle = lightTheme
        ? 'rgba(0, 126, 173, 0.92)'
        : 'rgba(209, 255, 255, 0.98)';
      context.lineWidth = 1.4;
      context.shadowBlur = lightTheme ? 1 : 3;
      context.stroke();
      context.restore();
    };

    const clipParticleFieldOutsideCapsule = () => {
      context.beginPath();
      context.moveTo(emitterX(-emitterRadius) + 1, 0);
      for (let y = -emitterRadius; y <= emitterRadius; y += 0.75) {
        context.lineTo(emitterX(y) + 1, height / 2 + y);
      }
      context.lineTo(width, height);
      context.lineTo(width, 0);
      context.closePath();
      context.clip();
    };

    const fadeParticleFieldEdges = () => {
      const fadeStart = Math.max(0, width - 38);
      const startRatio = fadeStart / Math.max(1, width);
      context.save();
      context.globalCompositeOperation = 'destination-in';
      const rightMask = context.createLinearGradient(0, 0, width, 0);
      rightMask.addColorStop(0, 'rgba(0, 0, 0, 1)');
      rightMask.addColorStop(startRatio, 'rgba(0, 0, 0, 1)');
      rightMask.addColorStop(startRatio + (1 - startRatio) * 0.5, 'rgba(0, 0, 0, 0.72)');
      rightMask.addColorStop(startRatio + (1 - startRatio) * 0.78, 'rgba(0, 0, 0, 0.3)');
      rightMask.addColorStop(1, 'rgba(0, 0, 0, 0)');
      context.fillStyle = rightMask;
      context.fillRect(0, 0, width, height);
      const verticalMask = context.createLinearGradient(0, 0, 0, height);
      verticalMask.addColorStop(0, 'rgba(0, 0, 0, 0)');
      verticalMask.addColorStop(0.18, 'rgba(0, 0, 0, 0.72)');
      verticalMask.addColorStop(0.34, 'rgba(0, 0, 0, 1)');
      verticalMask.addColorStop(0.66, 'rgba(0, 0, 0, 1)');
      verticalMask.addColorStop(0.82, 'rgba(0, 0, 0, 0.72)');
      verticalMask.addColorStop(1, 'rgba(0, 0, 0, 0)');
      context.fillStyle = verticalMask;
      context.fillRect(0, 0, width, height);
      context.restore();
    };

    const draw = (timestamp: number) => {
      frame = 0;
      if (!canvasVisible || !documentVisible) return;
      const deltaSeconds = lastTimestamp ? Math.min((timestamp - lastTimestamp) / 1000, 0.034) : 0;
      lastTimestamp = timestamp;
      context.clearRect(0, 0, width, height);
      update(deltaSeconds);
      context.save();
      clipParticleFieldOutsideCapsule();
      drawAtmosphere();
      drawRain();
      drawDust();
      drawSourceSparks();
      context.restore();
      fadeParticleFieldEdges();
      drawEmitter();
      frame = window.requestAnimationFrame(draw);
    };

    const requestDraw = () => {
      if (!canvasVisible || !documentVisible || frame) return;
      lastTimestamp = 0;
      frame = window.requestAnimationFrame(draw);
    };
    const setAnimationActive = () => {
      if (canvasVisible && documentVisible) {
        requestDraw();
        return;
      }
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      lastTimestamp = 0;
    };

    const resizeObserver = new ResizeObserver(resize);
    const intersectionObserver = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(([entry]) => {
        canvasVisible = entry?.isIntersecting !== false;
        setAnimationActive();
      })
      : undefined;
    const themeObserver = new MutationObserver(updateTheme);
    const handleVisibilityChange = () => {
      documentVisible = document.visibilityState !== 'hidden';
      setAnimationActive();
    };
    resizeObserver.observe(canvas);
    intersectionObserver?.observe(canvas);
    themeObserver.observe(document.documentElement, { attributeFilter: ['data-theme'], attributes: true });
    document.addEventListener('visibilitychange', handleVisibilityChange);
    resize();
    // Draw synchronously in the same layout commit that inserts the running
    // tool card, then continue on RAF. This prevents a visible blank interval.
    draw(performance.now());
    return () => {
      resizeObserver.disconnect();
      intersectionObserver?.disconnect();
      themeObserver.disconnect();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const lanes = [2, 5, 8, 11, 14, 17, 20, 23, 26];
    let nextId = 0;
    let timeoutId: number | undefined;
    const random = (minimum: number, maximum: number) => minimum + Math.random() * (maximum - minimum);

    const emit = () => {
      const timestamp = Date.now();
      setFlowParticles((current) => {
        const active = current.filter((particle) => particle.expiresAt > timestamp);
        const occupiedLanes = new Set(active
          .filter((particle) => timestamp - particle.createdAt < particle.duration * 0.55)
          .map((particle) => particle.y));
        const availableLanes = lanes.filter((lane) => !occupiedLanes.has(lane));
        const emitted = Array.from({ length: Math.min(availableLanes.length, 1) }, () => {
          const laneIndex = Math.floor(Math.random() * availableLanes.length);
          const y = availableLanes.splice(laneIndex, 1)[0];
          const width = Math.round(random(27, 47));
          const duration = Math.round(random(2700, 3350));
          return {
            createdAt: timestamp,
            distance: Math.round(random(160, 178)),
            duration,
            expiresAt: timestamp + duration,
            id: nextId++,
            start: -(width + 5),
            width,
            y,
          };
        });
        return [...active, ...emitted];
      });
      timeoutId = window.setTimeout(emit, Math.round(random(200, 400)));
    };

    emit();
    return () => window.clearTimeout(timeoutId);
  }, []);

  return (
    <span
      aria-hidden="true"
      className="browser-chat-tool-tail-particles"
    >
      {flowParticles.map((particle) => (
        <i
          className="browser-chat-tool-tail-comet"
          key={particle.id}
          style={{
            '--distance': `${particle.distance}px`,
            '--duration': `${particle.duration}ms`,
            '--start': `${particle.start}px`,
            '--width': `${particle.width}px`,
            '--y': `${particle.y}px`,
          } as CSSProperties}
        />
      ))}
    </span>
  );
});


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
  const inputSignature = typeof value.inputSignature === 'string' ? value.inputSignature : '';
  const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : '';
  if (!id || !messageId || !toolName || !prompt) return undefined;
  return {
    id,
    messageId,
    stepIndex: typeof value.stepIndex === 'number' && Number.isFinite(value.stepIndex) ? Math.floor(value.stepIndex) : undefined,
    toolName,
    inputSignature,
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
  return compactText(session.title || '新对话', 38);
}

function formatLogTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function messageUpdateTime(message: BrowserChatMessage) {
  return message.updatedAt || message.createdAt;
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
          a: ({ href, onClick, ...props }) => (
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

const BrowserChatDownloadCenter = memo(function BrowserChatDownloadCenter({
  downloads,
  open,
  onClose,
  onRemove,
  onToggle,
}: {
  downloads: SystemDownloadItem[];
  open: boolean;
  onClose: () => void;
  onRemove: (id: string) => void;
  onToggle: () => void;
}) {
  const activeCount = downloads.filter((download) => download.status === 'selecting' || download.status === 'pending' || download.status === 'downloading').length;
  const recentDownloads = downloads.slice(0, 12);
  const [downloadDirectory, setDownloadDirectory] = useState('');
  const [downloadDirectoryError, setDownloadDirectoryError] = useState('');
  const [downloadActionError, setDownloadActionError] = useState('');
  const [removingDownloadIds, setRemovingDownloadIds] = useState<Set<string>>(() => new Set());
  const [selectingDownloadDirectory, setSelectingDownloadDirectory] = useState(false);

  useEffect(() => {
    const bridge = typeof window === 'undefined' ? undefined : window.webPilotSystem;
    if (!bridge?.getDownloads) return undefined;
    let mounted = true;
    bridge.getDownloads()
      .then((result) => {
        if (!mounted) return;
        if (!result.ok) {
          setDownloadDirectoryError(result.error || '读取下载位置失败');
          return;
        }
        setDownloadDirectory(result.directory || '');
      })
      .catch((reason: unknown) => {
        if (mounted) setDownloadDirectoryError(reason instanceof Error ? reason.message : '读取下载位置失败');
      });
    return () => {
      mounted = false;
    };
  }, []);

  async function chooseDownloadLocation() {
    const bridge = typeof window === 'undefined' ? undefined : window.webPilotSystem;
    if (!bridge?.chooseDownloadDirectory || selectingDownloadDirectory) return;
    setSelectingDownloadDirectory(true);
    setDownloadDirectoryError('');
    try {
      const result = await bridge.chooseDownloadDirectory({ defaultPath: downloadDirectory || undefined });
      if (!result.ok) setDownloadDirectoryError(result.error || '修改下载位置失败');
      else if (result.path) setDownloadDirectory(result.path);
    } catch (reason) {
      setDownloadDirectoryError(reason instanceof Error ? reason.message : '修改下载位置失败');
    } finally {
      setSelectingDownloadDirectory(false);
    }
  }

  async function removeDownload(id: string) {
    const bridge = typeof window === 'undefined' ? undefined : window.webPilotSystem;
    if (!bridge?.removeDownload || removingDownloadIds.has(id)) return;
    const download = downloads.find((item) => item.id === id);
    if (!window.confirm(`确定删除“${download?.fileName || '该文件'}”吗？文件将移入回收站。`)) return;
    setDownloadActionError('');
    setRemovingDownloadIds((current) => new Set(current).add(id));
    try {
      const result = await bridge.removeDownload({ id });
      if (!result.ok) {
        setDownloadActionError(result.error || '删除文件失败');
        return;
      }
      onRemove(id);
    } catch (reason) {
      setDownloadActionError(reason instanceof Error ? reason.message : '删除文件失败');
    } finally {
      setRemovingDownloadIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  async function showDownloadInFolder(id: string) {
    const bridge = typeof window === 'undefined' ? undefined : window.webPilotSystem;
    if (!bridge?.showDownloadInFolder) return;
    setDownloadActionError('');
    try {
      const result = await bridge.showDownloadInFolder({ id });
      if (!result.ok) setDownloadActionError(result.error || '打开文件所在位置失败');
    } catch (reason) {
      setDownloadActionError(reason instanceof Error ? reason.message : '打开文件所在位置失败');
    }
  }

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
            <div className="browser-chat-download-header-actions">
              <button
                aria-label="设置下载位置"
                className="ui-icon-button"
                disabled={selectingDownloadDirectory}
                onClick={() => void chooseDownloadLocation()}
                title={downloadDirectory ? `下载位置：${downloadDirectory}` : '设置下载位置'}
                type="button"
              >
                {selectingDownloadDirectory ? <Loader2 className="spin" size={15} /> : <Settings size={15} />}
              </button>
              <button className="ui-icon-button" onClick={onClose} type="button" aria-label="关闭下载面板" title="关闭">
                <X size={15} />
              </button>
            </div>
          </header>
          {downloadDirectoryError ? <div className="browser-chat-download-location-error">{downloadDirectoryError}</div> : null}
          {downloadActionError ? <div className="browser-chat-download-location-error">{downloadActionError}</div> : null}
          {recentDownloads.length ? (
            <ol className="browser-chat-download-list">
              {recentDownloads.map((download) => {
                const percent = browserChatDownloadPercent(download);
                const received = formatDownloadBytes(download.receivedBytes);
                const total = formatDownloadBytes(download.totalBytes);
                const progressWidth = percent === undefined ? (download.status === 'downloading' ? 18 : 0) : percent;
                const sizeLabel = total ? `${received || '0 B'} / ${total}` : received;
                const statusLine = [
                  browserChatDownloadStatusLabel(download.status),
                  percent !== undefined ? `${percent}%` : '',
                  sizeLabel,
                ].filter(Boolean).join(' · ');
                const removable = !['selecting', 'pending', 'downloading', 'paused', 'interrupted'].includes(download.status || '');
                const revealable = download.status === 'completed' && Boolean(download.path);
                return (
                  <li className={`browser-chat-download-item ${download.status || 'pending'}`} key={download.id}>
                    <div className="browser-chat-download-item-head">
                      <div className="browser-chat-download-copy">
                        <strong>{download.fileName || 'download'}</strong>
                        <span>{statusLine}</span>
                      </div>
                      {revealable || removable ? (
                        <div className="browser-chat-download-actions">
                          {revealable ? (
                            <button
                              aria-label="在文件夹中显示"
                              className="browser-chat-download-item-action browser-chat-download-reveal"
                              onClick={() => void showDownloadInFolder(download.id)}
                              title="在文件夹中显示"
                              type="button"
                            >
                              <FolderOpen size={14} />
                            </button>
                          ) : null}
                          {removable ? (
                            <button
                              aria-label="删除下载文件"
                              className="browser-chat-download-item-action browser-chat-download-remove"
                              disabled={removingDownloadIds.has(download.id)}
                              onClick={() => void removeDownload(download.id)}
                              title="删除文件"
                              type="button"
                            >
                              {removingDownloadIds.has(download.id) ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    <div className="browser-chat-download-progress" aria-hidden="true">
                      <span style={{ width: `${progressWidth}%` }} />
                    </div>
                    {download.error ? <div className="browser-chat-download-error">{download.error}</div> : null}
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

const BrowserChatGroupBindingCenter = memo(function BrowserChatGroupBindingCenter({
  disabled,
  groupId,
  onClose,
  onSelect,
  onToggle,
  open,
}: {
  disabled?: boolean;
  groupId?: string;
  onClose: () => void;
  onSelect: (groupId: string) => void | Promise<void>;
  onToggle: () => void;
  open: boolean;
}) {
  const [groups, setGroups] = useState<EmbeddedBrowserGroup[]>([]);
  const [error, setError] = useState('');
  const [pendingGroupId, setPendingGroupId] = useState('');

  const loadGroups = useCallback(async () => {
    const bridge = window.webPilotEmbeddedBrowser;
    if (!bridge) {
      setGroups([]);
      return;
    }
    const state = await bridge.getState();
    if (!state.ok) throw new Error(state.error || '无法读取浏览器标签组');
    setGroups(Array.isArray(state.groups) ? state.groups : []);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    void loadGroups().catch((loadError) => setError(loadError instanceof Error ? loadError.message : '无法读取浏览器标签组'));
    return window.webPilotEmbeddedBrowser?.onStateChange?.((state) => {
      if (state.ok) setGroups(Array.isArray(state.groups) ? state.groups : []);
    }) || undefined;
  }, [loadGroups, open]);

  async function selectGroup(nextGroupId: string) {
    if (pendingGroupId || nextGroupId === groupId) return;
    setError('');
    setPendingGroupId(nextGroupId);
    try {
      await onSelect(nextGroupId);
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : '切换标签组失败');
    } finally {
      setPendingGroupId('');
    }
  }

  const displayedGroupId = pendingGroupId || groupId;

  return (
    <div className="browser-chat-group-binding-center">
      <button
        aria-expanded={open}
        aria-label="绑定浏览器标签组"
        className="ui-icon-button browser-chat-group-binding-button"
        disabled={disabled}
        onClick={onToggle}
        style={{ '--browser-chat-bound-group-color': embeddedBrowserGroupIconColor(displayedGroupId) } as CSSProperties}
        title="绑定浏览器标签组"
        type="button"
      >
        {pendingGroupId ? <Loader2 className="spin" size={17} /> : <Folder size={17} />}
      </button>
      {open ? (
        <div className="browser-chat-group-binding-popover" role="dialog" aria-label="选择浏览器标签组">
          <header>
            <strong>绑定标签组</strong>
            <button className="ui-icon-button" onClick={onClose} type="button" aria-label="关闭标签组面板">
              <X size={15} />
            </button>
          </header>
          {error ? <p className="browser-chat-group-binding-error">{error}</p> : null}
          {groups.length ? (
            <ol className="browser-chat-group-binding-list">
              {groups.map((group) => {
                const label = group.label || embeddedSessionGroupLabel(group.sessionId || embeddedSessionIdFromGroupId(group.id));
                const selected = group.id === groupId;
                const switching = group.id === pendingGroupId;
                return (
                  <li key={group.id}>
                    <button
                      aria-pressed={selected}
                      className={selected ? 'selected' : ''}
                      disabled={Boolean(pendingGroupId)}
                      onClick={() => void selectGroup(group.id)}
                      type="button"
                    >
                      <Folder size={16} style={{ color: embeddedBrowserGroupIconColor(group.id) }} />
                      <span>{label}</span>
                      {switching ? <Loader2 className="spin" size={16} /> : selected ? <CheckCircle2 size={16} /> : null}
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="browser-chat-group-binding-empty">暂无可绑定的标签组</div>
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
  return inlineTokenSvg('<rect x="3.5" y="4" width="17" height="16" rx="3"/><circle cx="9" cy="9.5" r="1.25"/><path d="m5.5 17 4.2-4.2 3.1 3 2.2-2.2 3.5 3.4"/>');
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

function browserChatTabReferenceFromPayload(payload?: EmbeddedBrowserTabDragPayload) {
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

function browserChatTabReferenceFromDataTransfer(dataTransfer: DataTransfer) {
  return browserChatTabReferenceFromPayload(parseEmbeddedBrowserTabDragPayload(dataTransfer.getData(WEBPILOT_TAB_DRAG_MIME)));
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
  toolInput: unknown;
  toolOk?: boolean;
}) {
  const { pending, stepIndex, toolName, toolInput, toolOk } = input;
  if (!pending || toolOk !== undefined) return undefined;
  if (pending.toolName !== toolName) return undefined;
  if (pending.stepIndex !== undefined && stepIndex !== pending.stepIndex) return undefined;
  if (!pending.inputSignature || pending.inputSignature !== toolInputSignature(toolInput)) return undefined;
  return pending;
}

function toolUserActionForTool(logs: BrowserChatLogRecord[], stepIndex: number | undefined, toolName: string, toolInput: unknown) {
  if (stepIndex === undefined) return undefined;
  const inputSignature = toolInputSignature(toolInput);
  for (const log of [...logs].reverse()) {
    if (log.stepIndex !== stepIndex) continue;
    if (log.phase !== 'tool:confirmation:confirmed' && log.phase !== 'tool:confirmation:cancelled') continue;
    const details = parseJsonObjectText(log.details);
    const loggedToolName = typeof details?.toolName === 'string' ? details.toolName : '';
    if (loggedToolName && loggedToolName !== toolName) continue;
    const loggedInputSignature = typeof details?.inputSignature === 'string' ? details.inputSignature : '';
    if (!loggedInputSignature || loggedInputSignature !== inputSignature) continue;
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

const BrowserChatSubagentToolDisclosure = memo(function BrowserChatSubagentToolDisclosure({
  cardContent,
  className,
  isActive,
  logs,
  onResume,
  onSelectTool,
  resuming,
  running,
  title,
  toolInput,
  toolResult,
}: {
  cardContent: ReactNode;
  className: string;
  isActive: boolean;
  logs: BrowserChatLogRecord[];
  onResume?: () => void | Promise<void>;
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  resuming?: boolean;
  running: boolean;
  title: string;
  toolInput: unknown;
  toolResult?: unknown;
}) {
  const subagents = useMemo(() => browserChatSubagentsFromLogs(logs, toolInput, toolResult), [logs, toolInput, toolResult]);
  const hasProblem = subagents.some((subagent) => subagent.status === 'failed' || subagent.status === 'blocked');
  return (
    <details className="browser-chat-ai-line-collapse browser-chat-subagent-tool" open={isActive || hasProblem || undefined}>
      <summary aria-label={title} className={`browser-chat-tool-card browser-chat-ai-tool-summary-card${className}`} title={title}>
        {cardContent}
        <ChevronDown className="browser-chat-ai-tool-chevron" size={13} />
        {isActive ? <BrowserChatToolTailParticles /> : null}
      </summary>
      <BrowserChatSubagentList
        logs={logs}
        onResume={onResume}
        onSelectTool={onSelectTool}
        resuming={resuming}
        running={running}
        subagents={subagents}
        toolInput={toolInput}
      />
    </details>
  );
});

const BrowserChatStepToolCards = memo(function BrowserChatStepToolCards({
  logs,
  onSelectTool,
  onResumeHumanVerification,
  onResolveToolConfirmation,
  onlyPendingConfirmation = false,
  pendingToolConfirmation,
  resolvingConfirmationAction,
  resolvingConfirmationId,
  resumingHumanVerification,
  running,
  step,
  visibleToolIndexes,
}: {
  logs: BrowserChatLogRecord[];
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  onResumeHumanVerification?: () => void | Promise<void>;
  onResolveToolConfirmation?: (confirmationId: string, action: BrowserChatToolConfirmationAction) => void | Promise<void>;
  onlyPendingConfirmation?: boolean;
  pendingToolConfirmation?: BrowserChatToolConfirmation;
  resolvingConfirmationAction?: BrowserChatToolConfirmationAction | null;
  resolvingConfirmationId?: string | null;
  resumingHumanVerification?: boolean;
  running: boolean;
  step: StepExecutionResult;
  visibleToolIndexes?: readonly number[];
}) {
  const { t } = useI18n();
  const allToolCalls = step.tools || [];
  const visibleToolIndexSet = visibleToolIndexes ? new Set(visibleToolIndexes) : undefined;
  const toolCalls = allToolCalls
    .map((tool, toolIndex) => ({ tool, toolIndex }))
    .filter(({ toolIndex }) => !visibleToolIndexSet || visibleToolIndexSet.has(toolIndex));
  if (!running && !toolCalls.length) return null;
  if (onlyPendingConfirmation && !toolCalls.some(({ tool }) => pendingConfirmationForTool({
    pending: pendingToolConfirmation,
    stepIndex: step.index,
    toolName: tool.name,
    toolInput: tool.input,
    toolOk: tool.ok,
  }))) return null;
  if (running && !toolCalls.length) {
    if (allToolCalls.length) return null;
    if (onlyPendingConfirmation) return null;
    return (
      <div className="browser-chat-tool-card is-waiting">
        <span className="browser-chat-tool-icon" aria-hidden="true">
          <Loader2 className="spin" size={13} />
        </span>
        <span className="browser-chat-tool-content">
          <span className="browser-chat-tool-label">
            <span className="browser-chat-tool-name">准备工具</span>
          </span>
          <small className="browser-chat-tool-meta">正在选择下一步浏览器动作</small>
        </span>
      </div>
    );
  }

  return (
    <>
      {toolCalls.map(({ tool, toolIndex }) => {
        const label = browserChatToolLabel(tool.name, t);
        const meta = compactText(browserChatToolMeta(tool.name, tool.input), 56);
        const displayText = `${label}${meta ? `: ${meta}` : ''}`;
        const presentation = browserChatToolPresentation(tool, step, running);
        const { isActive: isActiveTool, stateClass, status } = presentation;
        const pendingConfirmation = pendingConfirmationForTool({
          pending: pendingToolConfirmation,
          stepIndex: step.index,
          toolName: tool.name,
          toolInput: tool.input,
          toolOk: tool.ok,
        });
        if (onlyPendingConfirmation && !pendingConfirmation) return null;
        const userAction = pendingConfirmation
          ? undefined
          : toolUserActionForTool(logs, step.index, tool.name, tool.input);
        return (
          <div
            className={`browser-chat-tool-call${tool.name === 'spawnSubagents' ? ' has-subagents' : ''}`}
            key={`${step.index}-${toolIndex}-${tool.name}`}
          >
            {tool.reason ? <p className="browser-chat-tool-reason">{tool.reason}</p> : null}
            {tool.name === 'spawnSubagents' ? (
              <BrowserChatSubagentToolDisclosure
                cardContent={(
                  <>
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
                  </>
                )}
                className={stateClass}
                isActive={isActiveTool}
                logs={logs}
                onResume={onResumeHumanVerification}
                onSelectTool={onSelectTool}
                resuming={resumingHumanVerification}
                running={running}
                title={`${displayText} · ${status}`}
                toolInput={tool.input}
                toolResult={tool.rawResult ?? tool.result}
              />
            ) : (
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
                {isActiveTool ? <BrowserChatToolTailParticles /> : null}
              </button>
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
    </>
  );
});

const BrowserChatAiCycleLine = memo(function BrowserChatAiCycleLine({
  cycle,
  logs,
  onResolveToolConfirmation,
  onResumeHumanVerification,
  onSelectTool,
  pendingToolConfirmation,
  resolvingConfirmationAction,
  resolvingConfirmationId,
  resumingHumanVerification,
  running,
  toolDetails,
}: {
  cycle: BrowserChatAiOutputCycle;
  logs: BrowserChatLogRecord[];
  onResolveToolConfirmation?: (confirmationId: string, action: BrowserChatToolConfirmationAction) => void | Promise<void>;
  onResumeHumanVerification?: () => void | Promise<void>;
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  pendingToolConfirmation?: BrowserChatToolConfirmation;
  resolvingConfirmationAction?: BrowserChatToolConfirmationAction | null;
  resolvingConfirmationId?: string | null;
  resumingHumanVerification?: boolean;
  running: boolean;
  toolDetails: Map<string, BrowserChatToolDetail>;
}) {
  const showReasoning = useContext(BrowserChatReasoningVisibilityContext);
  const { output } = cycle;
  const orderedParts: Array<
    | { kind: 'reasoning'; part: BrowserChatAiOutputPart; text: string }
    | { kind: 'text'; part: BrowserChatAiOutputPart; text: string }
    | { kind: 'tool'; part: BrowserChatAiOutputPart; tool: BrowserChatAiOutputTool; toolDetail: BrowserChatToolDetail }
  > = [];
  for (const part of output.parts) {
    if (part.kind === 'reasoning') {
      const text = output.reasoning[part.index];
      if (showReasoning && text) orderedParts.push({ kind: 'reasoning', part, text });
      continue;
    }
    if (part.kind === 'text') {
      const text = output.texts[part.index];
      if (text) orderedParts.push({ kind: 'text', part, text });
      continue;
    }
    const tool = output.tools[part.index];
    const toolDetail = toolDetails.get(aiCycleToolKey(cycle.id, part.index));
    if (tool && toolDetail) orderedParts.push({ kind: 'tool', part, tool, toolDetail });
  }
  if (!orderedParts.length) return null;
  return (
    <div className="browser-chat-ai-cycle">
      {orderedParts.map((entry, orderedIndex) => {
        if (entry.kind === 'reasoning') {
          return (
            <details className="browser-chat-ai-line-collapse" key={`reasoning-${entry.part.index}-${orderedIndex}`}>
              <summary className="browser-chat-ai-collapse-summary">
                <Sparkles size={14} />
                <span>思维链</span>
                <ChevronDown className="browser-chat-ai-tool-chevron" size={14} />
              </summary>
              <div className="browser-chat-ai-reasoning-text"><p>{entry.text}</p></div>
            </details>
          );
        }
        if (entry.kind === 'text') {
          return (
            <div className="browser-chat-ai-cycle-text" key={`text-${entry.part.index}-${orderedIndex}`}>
              <BrowserChatMarkdown markdown={entry.text} />
            </div>
          );
        }
        const { tool, toolDetail } = entry;
        const label = browserChatToolLabel(tool.name, (value) => value);
        const meta = browserChatToolMeta(tool.name, tool.input) || tool.reason;
        const presentation = browserChatToolPresentation(toolDetail.tool, toolDetail.step, running);
        const { isActive, stateClass } = presentation;
        const pendingConfirmation = pendingConfirmationForTool({
          pending: pendingToolConfirmation,
          stepIndex: toolDetail.stepIndex,
          toolName: tool.name,
          toolInput: toolDetail.tool.input,
          toolOk: toolDetail.tool.ok,
        });
        const userAction = pendingConfirmation
          ? undefined
          : toolUserActionForTool(logs, toolDetail.stepIndex, tool.name, toolDetail.tool.input);
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
          <details
            className="browser-chat-ai-line-collapse"
            key={`tool-${tool.id}-${entry.part.index}-${orderedIndex}`}
            open={Boolean(pendingConfirmation) || undefined}
          >
            <summary className="browser-chat-ai-collapse-summary" title={compactText([label, meta].filter(Boolean).join(': '), 160)}>
              <SquareTerminal size={14} />
              <span>执行一个工具</span>
              <ChevronDown className="browser-chat-ai-tool-chevron" size={14} />
            </summary>
            <div className="browser-chat-ai-cycle-tools">
              <div className={`browser-chat-tool-call${tool.name === 'spawnSubagents' ? ' has-subagents' : ''}`}>
                {tool.name === 'spawnSubagents' ? (
                  <BrowserChatSubagentToolDisclosure
                    cardContent={card}
                    className={stateClass}
                    isActive={isActive}
                    logs={logs}
                    onResume={onResumeHumanVerification}
                    onSelectTool={onSelectTool}
                    resuming={resumingHumanVerification}
                    running={running}
                    title={`${label}${meta ? ` - ${meta}` : ''}`}
                    toolInput={toolDetail.tool.input}
                    toolResult={toolDetail.tool.rawResult ?? toolDetail.tool.result}
                  />
                ) : (
                  <button
                    className={`browser-chat-tool-card browser-chat-ai-call-card${stateClass}`}
                    onClick={() => onSelectTool(toolDetail)}
                    title={`${label}${meta ? ` - ${meta}` : ''}`}
                    type="button"
                  >
                    {card}
                    {isActive ? <BrowserChatToolTailParticles /> : null}
                  </button>
                )}
                <BrowserChatToolConfirmationActions
                  pending={pendingConfirmation}
                  resolvingConfirmationAction={resolvingConfirmationAction}
                  resolvingConfirmationId={resolvingConfirmationId}
                  onResolveToolConfirmation={onResolveToolConfirmation}
                />
              </div>
            </div>
          </details>
        );
      })}
    </div>
  );
});

const BrowserChatExecutedCycleGroup = memo(function BrowserChatExecutedCycleGroup({
  cycles,
  logs,
  onResolveToolConfirmation,
  onResumeHumanVerification,
  onSelectTool,
  pendingToolConfirmation,
  resolvingConfirmationAction,
  resolvingConfirmationId,
  resumingHumanVerification,
  running,
  toolDetails,
}: {
  cycles: BrowserChatAiOutputCycle[];
  logs: BrowserChatLogRecord[];
  onResolveToolConfirmation?: (confirmationId: string, action: BrowserChatToolConfirmationAction) => void | Promise<void>;
  onResumeHumanVerification?: () => void | Promise<void>;
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  pendingToolConfirmation?: BrowserChatToolConfirmation;
  resolvingConfirmationAction?: BrowserChatToolConfirmationAction | null;
  resolvingConfirmationId?: string | null;
  resumingHumanVerification?: boolean;
  running: boolean;
  toolDetails: Map<string, BrowserChatToolDetail>;
}) {
  const showReasoning = useContext(BrowserChatReasoningVisibilityContext);
  const toolCount = cycles.reduce((count, cycle) => (
    count + cycle.output.tools.filter((_tool, index) => toolDetails.has(aiCycleToolKey(cycle.id, index))).length
  ), 0);
  const reasoningCount = showReasoning ? cycles.reduce((count, cycle) => count + cycle.output.reasoning.length, 0) : 0;
  const hasPendingConfirmation = cycles.some((cycle) => (
    cycle.output.tools.some((tool, index) => {
      const toolDetail = toolDetails.get(aiCycleToolKey(cycle.id, index));
      if (!toolDetail) return false;
      return Boolean(pendingConfirmationForTool({
        pending: pendingToolConfirmation,
        stepIndex: toolDetail.stepIndex,
        toolName: tool.name,
        toolInput: toolDetail.tool.input,
        toolOk: toolDetail.tool.ok,
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
              onResumeHumanVerification={onResumeHumanVerification}
              onSelectTool={onSelectTool}
              pendingToolConfirmation={pendingToolConfirmation}
              resolvingConfirmationAction={resolvingConfirmationAction}
              resolvingConfirmationId={resolvingConfirmationId}
              resumingHumanVerification={resumingHumanVerification}
              running={running}
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

const BrowserChatManualVerificationCard = memo(function BrowserChatManualVerificationCard({
  onResume,
  resuming,
}: {
  onResume?: () => void | Promise<void>;
  resuming?: boolean;
}) {
  return (
    <section className="browser-chat-manual-verification" role="status">
      <span aria-hidden="true" className="browser-chat-manual-verification-icon"><Lock size={18} /></span>
      <div>
        <strong>需要人工完成验证</strong>
        <p>请在浏览器中完成验证码、登录/安全验证或其他需要本人确认的步骤。</p>
        <small>完成后点击按钮，AI 会从当前浏览器和当前对话回合继续执行。</small>
        {onResume ? (
          <button className="primary-button browser-chat-verification-resume" disabled={resuming} onClick={() => void onResume()} type="button">
            {resuming ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
            {resuming ? '正在继续' : '校验完成，继续执行'}
          </button>
        ) : null}
      </div>
    </section>
  );
});

type BrowserChatSubagentView = {
  id: string;
  title: string;
  status: 'running' | 'passed' | 'blocked' | 'failed';
  summary?: string;
  resumable: boolean;
  toolCount: number;
  logs: BrowserChatLogRecord[];
  steps: StepExecutionResult[];
  taskKey: string;
};

function browserChatSubagentTaskKey(value: unknown) {
  const task = asRecord(value);
  if (!task) return '';
  const url = stringFromUnknown(task.url).trim().toLowerCase();
  if (url) return `url:${url}`;
  const title = stringFromUnknown(task.title);
  const instruction = stringFromUnknown(task.instruction);
  return `task:${title}\n${instruction}`.replace(/\s+/g, ' ').trim().toLowerCase();
}

function browserChatSubagentTaskListSignature(values: unknown[]) {
  return values.map(browserChatSubagentTaskKey).filter(Boolean).sort().join('\u0000');
}

function browserChatSubagentToolResultRecord(value: unknown) {
  const resultRecord = asRecord(value);
  const rawActual = typeof resultRecord?.actual === 'string' ? resultRecord.actual : typeof value === 'string' ? value : '';
  return parseJsonObjectText(rawActual);
}

function browserChatSubagentBatchIdFromToolResult(value: unknown) {
  return stringFromUnknown(browserChatSubagentToolResultRecord(value)?.batchId).trim();
}

function browserChatNestedLogDetails(value: unknown) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function browserChatSubagentsFromLogs(logs: BrowserChatLogRecord[], toolInput: unknown, toolResult?: unknown) {
  type MutableSubagentView = BrowserChatSubagentView & { stepMap: Map<number, StepExecutionResult>; taskIndex?: number };
  const toolRecord = asRecord(toolInput);
  const toolTasks = Array.isArray(toolRecord?.tasks) ? toolRecord.tasks : [];
  const requestedSignature = browserChatSubagentTaskListSignature(toolTasks);
  let batchId = browserChatSubagentBatchIdFromToolResult(toolResult);
  let loggedTasks: unknown[] = [];
  let matchedBatchStart = false;
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    if (logs[index]?.phase !== 'subagents:start') continue;
    const details = parseJsonObjectText(logs[index].details);
    const candidateBatchId = stringFromUnknown(details?.batchId).trim();
    if (batchId && candidateBatchId !== batchId) continue;
    const requestedTasks = Array.isArray(details?.requestedTasks) ? details.requestedTasks : [];
    if (!batchId && requestedSignature && requestedTasks.length
      && browserChatSubagentTaskListSignature(requestedTasks) !== requestedSignature) continue;
    if (!batchId && candidateBatchId) batchId = candidateBatchId;
    if (Array.isArray(details?.tasks)) loggedTasks = details.tasks;
    matchedBatchStart = true;
    break;
  }
  const tasks = matchedBatchStart ? loggedTasks : toolTasks;
  const taskKeys = tasks.map(browserChatSubagentTaskKey).filter(Boolean);
  if (!taskKeys.length) return [];
  const taskKeySet = new Set(taskKeys);
  const runs = new Map<string, MutableSubagentView>();
  for (const log of logs) {
    const match = /^subagent:([^:]+):(.+)$/.exec(log.phase);
    if (!match) continue;
    const [, id, phase] = match;
    const details = parseJsonObjectText(log.details);
    if (batchId && stringFromUnknown(details?.batchId).trim() !== batchId) continue;
    const explicitTitle = stringFromUnknown(details?.title);
    const eventTaskKey = browserChatSubagentTaskKey(details);
    const detailIndex = Number(details?.index);
    const taskIndex = Number.isInteger(detailIndex) && detailIndex >= 0 && detailIndex < taskKeys.length
      ? detailIndex
      : undefined;
    const indexedTaskKey = taskIndex === undefined ? '' : taskKeys[taskIndex];
    const indexedTaskTitle = taskIndex === undefined ? '' : stringFromUnknown(asRecord(tasks[taskIndex])?.title);
    const canUseIndexedTask = Boolean(indexedTaskKey) && (
      !eventTaskKey
      || eventTaskKey === 'task:'
      || Boolean(explicitTitle && indexedTaskTitle && explicitTitle === indexedTaskTitle)
    );
    const resolvedTaskKey = taskKeySet.has(eventTaskKey)
      ? eventTaskKey
      : canUseIndexedTask ? indexedTaskKey : eventTaskKey;
    const current = runs.get(id) || {
      id,
      title: explicitTitle || `子 Agent ${runs.size + 1}`,
      status: 'running' as const,
      toolCount: 0,
      resumable: false,
      logs: [],
      steps: [],
      stepMap: new Map<number, StepExecutionResult>(),
      taskKey: resolvedTaskKey,
      taskIndex,
    };
    if (explicitTitle) current.title = explicitTitle;
    if (current.taskIndex === undefined && taskIndex !== undefined) current.taskIndex = taskIndex;
    if (!current.taskKey && indexedTaskKey) current.taskKey = indexedTaskKey;
    if (phase === 'start') {
      if (resolvedTaskKey && resolvedTaskKey !== 'task:') current.taskKey = resolvedTaskKey;
    }
    if (phase === 'done') {
      const status = stringFromUnknown(details?.status);
      current.status = status === 'blocked' || status === 'failed' ? status : 'passed';
      current.summary = stringFromUnknown(details?.summary);
      current.resumable = details?.resumable === true;
      if (Array.isArray(details?.steps)) {
        current.stepMap.clear();
        for (const value of details.steps) {
          const step = asRecord(value);
          const stepIndex = Number(step?.index);
          if (Number.isFinite(stepIndex)) current.stepMap.set(stepIndex, step as unknown as StepExecutionResult);
        }
      }
    } else if (phase === 'failed') {
      current.status = 'failed';
      current.summary = stringFromUnknown(details?.summary || details?.error);
      if (Array.isArray(details?.steps)) {
        current.stepMap.clear();
        for (const value of details.steps) {
          const step = asRecord(value);
          const stepIndex = Number(step?.index);
          if (Number.isFinite(stepIndex)) current.stepMap.set(stepIndex, step as unknown as StepExecutionResult);
        }
      }
    } else if (phase === 'progress') {
      const step = asRecord(details?.step);
      const stepIndex = Number(step?.index);
      if (Number.isFinite(stepIndex)) current.stepMap.set(stepIndex, step as unknown as StepExecutionResult);
    }
    if (details && Object.prototype.hasOwnProperty.call(details, 'event')) {
      const childStepIndex = Number(details.childStepIndex);
      current.logs.push({
        ...log,
        phase,
        stepIndex: Number.isFinite(childStepIndex) ? childStepIndex : undefined,
        details: browserChatNestedLogDetails(details.event),
      });
    }
    current.steps = [...current.stepMap.values()].sort((left, right) => left.index - right.index);
    current.toolCount = current.steps.reduce((sum, step) => sum + (step.tools || []).length, 0);
    runs.set(id, current);
  }
  const loggedViews = [...runs.values()]
    .filter((item) => taskKeySet.has(item.taskKey) || item.taskIndex !== undefined)
    .sort((left, right) => (
      (taskKeys.indexOf(left.taskKey) >= 0 ? taskKeys.indexOf(left.taskKey) : left.taskIndex ?? Number.MAX_SAFE_INTEGER)
      - (taskKeys.indexOf(right.taskKey) >= 0 ? taskKeys.indexOf(right.taskKey) : right.taskIndex ?? Number.MAX_SAFE_INTEGER)
    ));
  const toolResultRecord = browserChatSubagentToolResultRecord(toolResult);
  const resultItems = Array.isArray(toolResultRecord?.results) ? toolResultRecord.results : toolResultRecord?.subagents;
  if (!Array.isArray(resultItems)) return loggedViews;
  const merged = new Map<string, BrowserChatSubagentView>(loggedViews.map((item) => [item.id, item]));
  resultItems.forEach((value, index) => {
    const result = asRecord(value);
    if (!result) return;
    const id = stringFromUnknown(result.uuid || result.id).trim() || `result-${batchId || 'subagent'}-${index}`;
    const statusValue = stringFromUnknown(result.status);
    const status: BrowserChatSubagentView['status'] = statusValue === 'failed' || statusValue === 'blocked'
      ? statusValue
      : 'passed';
    const evidence = Array.isArray(result.evidence)
      ? result.evidence.flatMap((item) => {
        const step = asRecord(item);
        return Number.isFinite(Number(step?.index)) ? [step as unknown as StepExecutionResult] : [];
      })
      : [];
    const existing = merged.get(id);
    const resultTaskKey = browserChatSubagentTaskKey(result.task);
    const taskKey = resultTaskKey || taskKeys[index] || existing?.taskKey || '';
    const steps = evidence.length ? evidence : existing?.steps || [];
    merged.set(id, {
      id,
      title: stringFromUnknown(result.title).trim() || existing?.title || `子 Agent ${index + 1}`,
      status,
      summary: stringFromUnknown(result.content || result.summary || result.error) || existing?.summary,
      resumable: existing?.resumable || false,
      toolCount: steps.reduce((sum, step) => sum + (step.tools || []).length, 0),
      logs: existing?.logs || [],
      steps,
      taskKey,
    });
  });
  return [...merged.values()].sort((left, right) => (
    (taskKeys.indexOf(left.taskKey) >= 0 ? taskKeys.indexOf(left.taskKey) : Number.MAX_SAFE_INTEGER)
    - (taskKeys.indexOf(right.taskKey) >= 0 ? taskKeys.indexOf(right.taskKey) : Number.MAX_SAFE_INTEGER)
  ));
}

const BrowserChatSubagentList = memo(function BrowserChatSubagentList({
  logs,
  onResume,
  onSelectTool,
  resuming,
  running,
  subagents: providedSubagents,
  toolInput,
}: {
  logs: BrowserChatLogRecord[];
  onResume?: () => void | Promise<void>;
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  resuming?: boolean;
  running: boolean;
  subagents?: BrowserChatSubagentView[];
  toolInput: unknown;
}) {
  const derivedSubagents = useMemo(() => browserChatSubagentsFromLogs(logs, toolInput), [logs, toolInput]);
  const subagents = providedSubagents || derivedSubagents;
  if (!subagents.length) return null;
  return (
    <div className="browser-chat-executed-body browser-chat-subagent-list">
      {subagents.map((subagent) => {
        const cycles = aiOutputCyclesFromLogs(subagent.logs);
        const toolDetails = buildAiCycleToolDetailMap(cycles, subagent.steps);
        const representedTools = new Set([...toolDetails.values()].map((detail) => `${detail.stepIndex}:${detail.toolIndex}`));
        const remainingSteps = subagent.steps.flatMap((step) => {
          const visibleToolIndexes = (step.tools || []).flatMap((_tool, toolIndex) => (
            representedTools.has(`${step.index}:${toolIndex}`) ? [] : [toolIndex]
          ));
          return visibleToolIndexes.length ? [{ step, visibleToolIndexes }] : [];
        });
        const renderedText = aiOutputTextSetFromCycles(cycles);
        const normalizedSummary = subagent.summary?.replace(/\s+/g, ' ').trim();
        const statusClass = subagent.status === 'passed'
          ? 'status-passed'
          : subagent.status === 'failed' ? 'status-failed' : subagent.status === 'blocked' ? 'status-blocked' : 'status-running';
        const statusLabel = subagent.status === 'running'
          ? '正在执行'
          : subagent.status === 'passed' ? '已完成' : subagent.status === 'blocked' ? '等待处理' : '执行失败';
        return (
          <details
            className="browser-chat-ai-line-collapse browser-chat-executed-entry"
            key={subagent.id}
            open={subagent.status === 'running' || subagent.status === 'failed' || subagent.status === 'blocked' || undefined}
          >
            <summary className="browser-chat-ai-collapse-summary">
              <span className={`browser-chat-tool-icon ${statusClass}`} aria-hidden="true">
                {subagent.status === 'running' ? <Loader2 className="spin" size={13} /> : subagent.status === 'passed' ? <CheckCircle2 size={13} /> : <CircleAlert size={13} />}
              </span>
              <span className="browser-chat-tool-content">
                <span className="browser-chat-tool-label">
                  <span className="browser-chat-tool-name">{subagent.title}</span>
                  <small className="browser-chat-tool-meta">{statusLabel} · {subagent.toolCount} 个工具</small>
                </span>
              </span>
              <ChevronDown className="browser-chat-ai-tool-chevron" size={13} />
            </summary>
            <div className="browser-chat-executed-body">
              {cycles.map((cycle) => (
                <div className="browser-chat-executed-entry" key={cycle.id}>
                  <BrowserChatAiCycleLine
                    cycle={cycle}
                    logs={subagent.logs}
                    onSelectTool={onSelectTool}
                    resumingHumanVerification={resuming}
                    running={subagent.status === 'running'}
                    toolDetails={toolDetails}
                  />
                </div>
              ))}
              {remainingSteps.map(({ step, visibleToolIndexes }) => (
                <div className="browser-chat-executed-entry" key={step.index}>
                  <BrowserChatStepToolCards
                    logs={subagent.logs}
                    onSelectTool={onSelectTool}
                    resumingHumanVerification={resuming}
                    running={subagent.status === 'running' && step.status === 'running'}
                    step={step}
                    visibleToolIndexes={visibleToolIndexes}
                  />
                </div>
              ))}
              {subagent.summary && (!normalizedSummary || !renderedText.has(normalizedSummary)) ? (
                <div className="browser-chat-executed-entry">
                  <BrowserChatMarkdown markdown={subagent.summary} />
                </div>
              ) : null}
              {subagent.status === 'blocked' && subagent.resumable && onResume ? (
                <button className="primary-button browser-chat-verification-resume" disabled={running || resuming} onClick={() => void onResume()} type="button">
                  {resuming ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
                  {resuming ? '正在继续' : '校验完成，继续执行'}
                </button>
              ) : null}
            </div>
          </details>
        );
      })}
    </div>
  );
});

const BrowserChatAssistantTimeline = memo(function BrowserChatAssistantTimeline({
  logs,
  message,
  onResolveToolConfirmation,
  onResumeHumanVerification,
  onSelectTool,
  pendingToolConfirmation,
  resolvingConfirmationAction,
  resolvingConfirmationId,
  resumingHumanVerification,
  running,
  steps,
}: {
  logs: BrowserChatLogRecord[];
  message: BrowserChatMessage;
  onResolveToolConfirmation?: (confirmationId: string, action: BrowserChatToolConfirmationAction) => void | Promise<void>;
  onResumeHumanVerification?: () => void | Promise<void>;
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  pendingToolConfirmation?: BrowserChatToolConfirmation;
  resolvingConfirmationAction?: BrowserChatToolConfirmationAction | null;
  resolvingConfirmationId?: string | null;
  resumingHumanVerification?: boolean;
  running: boolean;
  steps: StepExecutionResult[];
}) {
  const showReasoning = useContext(BrowserChatReasoningVisibilityContext);
  const finalText = stringFromUnknown(message.content);
  const aiOutputCycles = useMemo(() => aiOutputCyclesFromLogs(logs)
    .map((cycle) => (showReasoning ? cycle : {
      ...cycle,
      output: {
        ...cycle.output,
        parts: cycle.output.parts.filter((part) => part.kind !== 'reasoning'),
        reasoning: [],
      },
    }))
    .filter((cycle) => hasAiOutputView(cycle.output)), [logs, showReasoning]);
  const aiOutputTextSet = useMemo(() => aiOutputTextSetFromCycles(aiOutputCycles), [aiOutputCycles]);
  const aiCycleToolDetails = useMemo(() => buildAiCycleToolDetailMap(aiOutputCycles, steps), [aiOutputCycles, steps]);
  const aiOutputCycleEntries = useMemo(() => buildBrowserChatAiCycleRenderEntries(
    aiOutputCycles,
    (cycle) => cycle.output.tools.some((_tool, index) => aiCycleToolDetails.has(aiCycleToolKey(cycle.id, index))),
  ), [aiCycleToolDetails, aiOutputCycles]);
  const aiCycleRepresentedToolKeys = new Set([...aiCycleToolDetails.values()].map((detail) => (
    `${detail.stepIndex}:${detail.toolIndex}`
  )));
  const seenTexts = new Set<string>();
  const toolCount = steps.reduce((count, step) => count + (step.tools || []).length, 0);
  const waitingForTool = running && steps.some((step) => step.status === 'running' && !(step.tools || []).length);
  const timelineSteps = steps.filter((step) => (step.tools || []).length || (running && step.status === 'running'));
  // Persisted step traces are the source of truth. Keep every trace that could not
  // be matched to an AI output cycle, including tools that have only just started,
  // so the card is rendered before execution finishes.
  const unrepresentedTimelineEntries = timelineSteps.flatMap((step): BrowserChatTimelineStepEntry[] => {
    const visibleToolIndexes = (step.tools || []).flatMap((tool, toolIndex) => (
      !aiCycleRepresentedToolKeys.has(`${step.index}:${toolIndex}`) ? [toolIndex] : []
    ));
    if (visibleToolIndexes.length) return [{ step, visibleToolIndexes }];
    return [];
  });
  const hasPendingConfirmation = Boolean(pendingToolConfirmation);
  const aiCyclesContainPendingConfirmation = hasPendingConfirmation && aiOutputCycles.some((cycle) => (
    cycle.output.tools.some((tool, index) => {
      const toolDetail = aiCycleToolDetails.get(aiCycleToolKey(cycle.id, index));
      return Boolean(pendingConfirmationForTool({
        pending: pendingToolConfirmation,
        stepIndex: toolDetail?.stepIndex ?? cycle.stepIndex,
        toolName: tool.name,
        toolInput: toolDetail?.tool.input ?? tool.input,
        toolOk: toolDetail?.tool.ok,
      }));
    })
  ));
  const pendingTimelineEntries: BrowserChatTimelineStepEntry[] = hasPendingConfirmation
    ? steps.filter((step) => (step.tools || []).some((tool) => pendingConfirmationForTool({
      pending: pendingToolConfirmation,
      stepIndex: step.index,
      toolName: tool.name,
      toolInput: tool.input,
      toolOk: tool.ok,
    }))).map((step) => ({ step }))
    : [];
  const showPendingTimelineFallback = hasPendingConfirmation && !aiCyclesContainPendingConfirmation;
  const timelineEntriesToRender: BrowserChatTimelineStepEntry[] = showPendingTimelineFallback
    ? pendingTimelineEntries
    : aiOutputCycles.length
      ? unrepresentedTimelineEntries
      : timelineSteps.map((step) => ({ step }));
  const shouldShowStepTimeline = (!aiOutputCycles.length && (toolCount > 0 || waitingForTool))
    || unrepresentedTimelineEntries.length > 0
    || (showPendingTimelineFallback && pendingTimelineEntries.length > 0);
  const manualVerificationPaused = steps.some((step) => (step.tools || []).some((tool) => tool.name === 'waitForHumanVerification'))
    || aiOutputCycles.some((cycle) => cycle.output.tools.some((tool) => tool.name === 'waitForHumanVerification'));
  const hasFinalText = Boolean(finalText.trim());
  const hideManualVerificationStatusText = manualVerificationPaused && isManualVerificationStatusText(finalText);
  const renderText = (text: string, key: string) => {
    const normalized = text;
    if (!normalized || seenTexts.has(normalized)) return null;
    seenTexts.add(normalized);
    return (
      <BrowserChatMarkdown key={key} markdown={normalized} />
    );
  };

  return (
    <div className="browser-chat-agent-timeline">
      {aiOutputCycleEntries.map((entry) => (
        entry.kind === 'executed' ? (
          <BrowserChatExecutedCycleGroup
            cycles={entry.cycles}
            key={entry.id}
            logs={logs}
            onResolveToolConfirmation={onResolveToolConfirmation}
            onResumeHumanVerification={onResumeHumanVerification}
            onSelectTool={onSelectTool}
            pendingToolConfirmation={pendingToolConfirmation}
            resolvingConfirmationAction={resolvingConfirmationAction}
            resolvingConfirmationId={resolvingConfirmationId}
            resumingHumanVerification={resumingHumanVerification}
            running={running}
            toolDetails={aiCycleToolDetails}
          />
        ) : (
          <BrowserChatAiCycleLine
            cycle={entry.cycle}
            key={entry.cycle.id}
            logs={logs}
            onResolveToolConfirmation={onResolveToolConfirmation}
            onResumeHumanVerification={onResumeHumanVerification}
            onSelectTool={onSelectTool}
            pendingToolConfirmation={pendingToolConfirmation}
            resolvingConfirmationAction={resolvingConfirmationAction}
            resolvingConfirmationId={resolvingConfirmationId}
            resumingHumanVerification={resumingHumanVerification}
            running={running}
            toolDetails={aiCycleToolDetails}
          />
        )
      ))}
      {shouldShowStepTimeline ? (
        <div className="browser-chat-tool-stack">
          {timelineEntriesToRender.map(({ step, visibleToolIndexes }) => (
            <div className={`browser-chat-agent-step${running && step.status === 'running' ? ' is-running' : ''}`} key={step.index}>
              <BrowserChatStepToolCards
                logs={logs}
                onResolveToolConfirmation={onResolveToolConfirmation}
                onResumeHumanVerification={onResumeHumanVerification}
                onSelectTool={onSelectTool}
                onlyPendingConfirmation={showPendingTimelineFallback}
                pendingToolConfirmation={pendingToolConfirmation}
                resolvingConfirmationAction={resolvingConfirmationAction}
                resolvingConfirmationId={resolvingConfirmationId}
                running={running && step.status === 'running'}
                step={step}
                visibleToolIndexes={visibleToolIndexes}
              />
            </div>
          ))}
        </div>
      ) : null}
      {manualVerificationPaused ? (
        <BrowserChatManualVerificationCard
          onResume={!running && message.status === 'blocked' ? onResumeHumanVerification : undefined}
          resuming={resumingHumanVerification}
        />
      ) : null}
      {hasFinalText && !hideManualVerificationStatusText && !aiOutputTextSet.has(finalText.replace(/\s+/g, ' ').trim()) ? renderText(finalText, 'final-text') : null}
      {!hasFinalText && !shouldShowStepTimeline ? (
        running ? (
          <div aria-live="polite" className="browser-chat-agent-empty browser-chat-agent-thinking" role="status">
            <span aria-hidden="true" className="browser-chat-agent-thinking-mark"><i /><i /><i /></span>
            <span className="browser-chat-agent-thinking-copy">
              <strong>AI 正在处理当前请求<span className="browser-chat-agent-thinking-ellipsis">...</span></strong>
              <small>正在分析页面状态并准备下一步操作</small>
            </span>
          </div>
        ) : <p className="browser-chat-agent-empty">AI 已完成本轮操作，未返回额外文本。</p>
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
  onGenerateSkill,
  onPreviewImage,
  onResolveToolConfirmation,
  onResumeHumanVerification,
  onSelectTool,
  onShowLogs,
  pendingToolConfirmation,
  resolvingConfirmationAction,
  resolvingConfirmationId,
  resumingHumanVerification,
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
  onResumeHumanVerification?: () => void | Promise<void>;
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  onShowLogs: (messageId: string) => void;
  onToggleExportSelection: (messageId: string, selected: boolean) => void;
  pendingToolConfirmation?: BrowserChatToolConfirmation;
  resolvingConfirmationAction?: BrowserChatToolConfirmationAction | null;
  resolvingConfirmationId?: string | null;
  resumingHumanVerification?: boolean;
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
    <article className={`browser-chat-message ${item.role}${operationRunning ? ' is-running' : ''}`}>
      <div>
        {item.role === 'assistant' ? (
          <BrowserChatAssistantTimeline
            logs={itemLogs}
            message={item}
            onResolveToolConfirmation={onResolveToolConfirmation}
            onResumeHumanVerification={onResumeHumanVerification}
            onSelectTool={onSelectTool}
            pendingToolConfirmation={pendingToolConfirmation?.messageId === item.id ? pendingToolConfirmation : undefined}
            resolvingConfirmationAction={resolvingConfirmationAction}
            resolvingConfirmationId={resolvingConfirmationId}
            resumingHumanVerification={resumingHumanVerification}
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
  onResumeHumanVerification,
  onSelectTool,
  pendingToolConfirmation,
  resolvingConfirmationAction,
  resolvingConfirmationId,
  resumingHumanVerification,
  sessionBusy,
  stepsByIndex,
}: {
  items: BrowserChatMessage[];
  lastAssistantMessageId?: string;
  logIndex: BrowserChatLogIndex;
  onResolveToolConfirmation?: (confirmationId: string, action: BrowserChatToolConfirmationAction) => void | Promise<void>;
  onResumeHumanVerification?: () => void | Promise<void>;
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  pendingToolConfirmation?: BrowserChatToolConfirmation;
  resolvingConfirmationAction?: BrowserChatToolConfirmationAction | null;
  resolvingConfirmationId?: string | null;
  resumingHumanVerification?: boolean;
  sessionBusy: boolean;
  stepsByIndex: Map<number, StepExecutionResult>;
}) {
  const itemViews = items.map((item) => {
    const steps = (item.stepIndexes || [])
      .map((stepIndex) => stepsByIndex.get(stepIndex))
      .filter((step): step is StepExecutionResult => step?.messageId === item.id);
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
                  onResumeHumanVerification={onResumeHumanVerification}
                  onSelectTool={onSelectTool}
                  pendingToolConfirmation={pendingToolConfirmation?.messageId === item.id ? pendingToolConfirmation : undefined}
                  resolvingConfirmationAction={resolvingConfirmationAction}
                  resolvingConfirmationId={resolvingConfirmationId}
                  resumingHumanVerification={resumingHumanVerification}
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
  onResumeHumanVerification,
  onSelectTool,
  onShowLogs,
  onToggleExportSelection,
  pendingToolConfirmation,
  resolvingConfirmationAction,
  resolvingConfirmationId,
  resumingHumanVerification,
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
  onResumeHumanVerification?: () => void | Promise<void>;
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  onShowLogs: (messageId: string) => void;
  onToggleExportSelection: (messageId: string, selected: boolean) => void;
  pendingToolConfirmation?: BrowserChatToolConfirmation;
  resolvingConfirmationAction?: BrowserChatToolConfirmationAction | null;
  resolvingConfirmationId?: string | null;
  resumingHumanVerification?: boolean;
  selectedExportMessageIdSet: Set<string>;
  selectedExportMessageIds: string[];
  sessionId?: string;
  sessionBusy: boolean;
  stepsByIndex: Map<number, StepExecutionResult>;
  totalStepCount: number;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followLatestRef = useRef(true);
  const previousSessionIdRef = useRef(sessionId);
  const actionDisabled = Boolean(exportingMessageId || generatingSkillMessageId) || exportingSelectedMessages || generatingSkillSelectedMessages;
  const lastMessage = messages[messages.length - 1];
  const skillsById = useMemo(() => new Map(availableSkills.map((skill) => [skill.id, skill])), [availableSkills]);
  const renderEntries = useMemo(
    () => buildBrowserChatMessageRenderEntries(
      messages,
      logIndex,
      browserChatAssistantMessageHasVisibleText,
      (message) => (message.stepIndexes || []).some((stepIndex) => {
        const step = stepsByIndex.get(stepIndex);
        return step?.messageId === message.id && Boolean(step.tools?.length);
      }),
    ),
    [logIndex, messages, stepsByIndex],
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
    const sessionChanged = previousSessionIdRef.current !== sessionId;
    previousSessionIdRef.current = sessionId;
    if (!sessionChanged && !followLatestRef.current) return undefined;
    let frame = 0;
    let nextFrame = 0;
    const scrollToBottom = () => {
      const container = scrollRef.current;
      if (!container) return;
      container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      followLatestRef.current = true;
    };
    frame = requestAnimationFrame(() => {
      scrollToBottom();
      nextFrame = requestAnimationFrame(scrollToBottom);
    });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      if (nextFrame) cancelAnimationFrame(nextFrame);
    };
  }, [scrollKey, sessionId]);

  const trackScrollPosition = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    followLatestRef.current = distanceFromBottom <= 96;
  }, []);

  return (
    <div className="browser-chat-message-list" onScroll={trackScrollPosition} ref={scrollRef}>
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
              onResumeHumanVerification={onResumeHumanVerification}
              onSelectTool={onSelectTool}
              pendingToolConfirmation={pendingToolConfirmation}
              resolvingConfirmationAction={resolvingConfirmationAction}
              resolvingConfirmationId={resolvingConfirmationId}
              resumingHumanVerification={resumingHumanVerification}
              sessionBusy={sessionBusy}
              stepsByIndex={stepsByIndex}
            />
          );
        }
        const item = entry.item;
        const itemSteps = (item.stepIndexes || [])
          .map((stepIndex) => stepsByIndex.get(stepIndex))
          .filter((step): step is StepExecutionResult => step?.messageId === item.id);
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
            onResumeHumanVerification={onResumeHumanVerification}
            onSelectTool={onSelectTool}
            onShowLogs={onShowLogs}
            onToggleExportSelection={onToggleExportSelection}
            pendingToolConfirmation={pendingToolConfirmation}
            resolvingConfirmationAction={resolvingConfirmationAction}
            resolvingConfirmationId={resolvingConfirmationId}
            resumingHumanVerification={resumingHumanVerification}
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

function BrowserChatSessionLoading({ label }: { label: string }) {
  return (
    <div className="browser-chat-session-loading" role="status" aria-live="polite" aria-label={label}>
      <LiquidGlassLoader />
      <span>{label}</span>
    </div>
  );
}

function BrowserChatModeSelector({
  disabled,
  onSafetyModeChange,
  safetyMode,
}: {
  disabled: boolean;
  onSafetyModeChange: (mode: BrowserChatSafetyMode) => void;
  safetyMode: BrowserChatSafetyMode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const safetyLabel = safetyMode === 'full' ? t('完全') : t('严谨');

  useEffect(() => {
    if (!disabled) return;
    setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div className="browser-chat-mode-selector" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`执行权限：${safetyLabel}`}
        className="browser-chat-mode-selector-trigger"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span>{safetyLabel}</span>
        <ChevronDown aria-hidden="true" className={open ? 'is-open' : undefined} size={14} />
      </button>

      {open ? (
        <div aria-label="执行权限" className="browser-chat-mode-selector-menu" role="dialog">
          <section className="browser-chat-mode-selector-section">
            <header>
              <strong>执行权限</strong>
            </header>
            <div aria-label={t('安全性')} className="browser-chat-mode-selector-options" role="radiogroup">
              <button
                aria-checked={safetyMode === 'strict'}
                className={safetyMode === 'strict' ? 'active' : undefined}
                onClick={() => onSafetyModeChange('strict')}
                role="radio"
                title={t('严谨模式下，一些模型认为重要的操作需要用户手动确认执行')}
                type="button"
              >
                <span>{t('严谨')}</span>
                {safetyMode === 'strict' ? <Check aria-hidden="true" size={14} /> : null}
              </button>
              <button
                aria-checked={safetyMode === 'full'}
                className={safetyMode === 'full' ? 'active' : undefined}
                onClick={() => onSafetyModeChange('full')}
                role="radio"
                title={t('完全模式下，模型不需要征求用户手动确认执行')}
                type="button"
              >
                <span>{t('完全')}</span>
                {safetyMode === 'full' ? <Check aria-hidden="true" size={14} /> : null}
              </button>
            </div>
          </section>

        </div>
      ) : null}
    </div>
  );
}

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
  void mode;
  void modeLocked;
  void onModeChange;
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
          data-placeholder="有问题，尽管问；需要时可并行调用子 Agent"
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
            const itemFiles = Array.from(event.clipboardData.items || [])
              .filter((item) => item.kind === 'file')
              .map((item) => item.getAsFile())
              .filter((file): file is File => Boolean(file));
            const pastedFiles = itemFiles.length ? itemFiles : Array.from(event.clipboardData.files || []);
            if (pastedFiles.length) {
              event.preventDefault();
              if (currentBusy || loading || uploadingImage || attachments.length >= BROWSER_CHAT_MAX_REFERENCES) return;
              const pastedAt = editorRange()?.cloneRange();
              void onUploadFiles(pastedFiles).then((uploaded) => {
                const editor = editorRef.current;
                if (editor && pastedAt && editor.contains(pastedAt.commonAncestorContainer)) {
                  const selection = window.getSelection();
                  selection?.removeAllRanges();
                  selection?.addRange(pastedAt);
                }
                uploaded.forEach(insertReferenceToken);
              });
              return;
            }
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
            <BrowserChatModeSelector
              disabled={currentBusy || loading}
              onSafetyModeChange={onSafetyModeChange}
              safetyMode={safetyMode}
            />
          </div>
          <div className="browser-chat-compose-submit">
            <div className="browser-chat-model-control">
              <CustomSelect
                className="browser-chat-provider-select"
                disabled={currentBusy || loading}
                onChange={(value) => onModelSelectionChange(parseModelSelectionValue(value))}
                options={modelSelectionOptions}
                searchable
                searchPlaceholder={t('搜索模型')}
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

function EmbeddedBrowserTabFavicon({ faviconUrl }: { faviconUrl?: string }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [faviconUrl]);

  if (!faviconUrl || failed) return <AppWindow aria-hidden="true" size={14} />;
  return (
    <img
      alt=""
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
      referrerPolicy="no-referrer"
      src={faviconUrl}
    />
  );
}

function EmbeddedBrowserTabContent({ tab }: { tab: EmbeddedBrowserTab }) {
  return (
    <>
      <span className="browser-chat-embedded-tab-icon">
        <EmbeddedBrowserTabFavicon faviconUrl={tab.faviconUrl} />
      </span>
      {tab.pinned ? <Pin aria-label="已固定" className="browser-chat-embedded-tab-pin" size={11} /> : null}
      <span className="browser-chat-embedded-tab-text">
        <strong>{compactText(tab.title || tab.url || '新建标签页', 56)}</strong>
      </span>
      {tab.loading ? (
        <span className="browser-chat-embedded-tab-loading" aria-label="页面加载中">
          <Loader2 className="spin" size={12} />
        </span>
      ) : null}
    </>
  );
}

function EmbeddedBrowserSortableTab({
  active,
  dragging,
  groupId,
  onActivate,
  onClose,
  onContextMenu,
  onToggleMute,
  tab,
}: {
  active: boolean;
  dragging: boolean;
  groupId: string;
  onActivate: () => void;
  onClose: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onToggleMute: () => void;
  tab: EmbeddedBrowserTab;
}) {
  const {
    attributes,
    isDragging,
    isSorting,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    data: {
      groupId,
      tabId: tab.id,
      type: 'embedded-browser-tab',
    } satisfies EmbeddedBrowserTabDndData,
    id: embeddedBrowserTabDndId(tab.id),
    transition: {
      duration: 160,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
    },
  });
  const sortableStyle = {
    transform: DndCss.Transform.toString(transform),
    transition: [
      transition,
      'background-color 160ms ease',
      'border-color 160ms ease',
      'box-shadow 160ms ease',
      'color 160ms ease',
    ].filter(Boolean).join(', '),
    visibility: dragging || isDragging ? 'hidden' : undefined,
  } satisfies CSSProperties;

  return (
    <div
      {...attributes}
      {...listeners}
      aria-selected={active}
      className={[
        'browser-chat-embedded-tab',
        active ? 'active' : '',
        tab.pinned ? 'pinned' : '',
        tab.loading ? 'loading' : '',
        dragging || isDragging ? 'dragging' : '',
        isSorting ? 'sorting' : '',
      ].filter(Boolean).join(' ')}
      onClick={onActivate}
      onContextMenu={onContextMenu}
      ref={setNodeRef}
      role="tab"
      style={sortableStyle}
      title={tab.url || tab.title}
    >
      <EmbeddedBrowserTabContent tab={tab} />
      <button
        aria-label={tab.audioMuted ? '取消静音标签页' : '静音标签页'}
        className={tab.audioMuted ? 'browser-chat-embedded-tab-mute is-muted' : 'browser-chat-embedded-tab-mute'}
        onClick={(event) => {
          event.stopPropagation();
          onToggleMute();
        }}
        onPointerDown={(event) => event.stopPropagation()}
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
          onClose();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        title="关闭当前标签页"
        type="button"
      >
        <X size={13} />
      </button>
    </div>
  );
}

function EmbeddedBrowserTabGroupDropZone({
  children,
  className,
  endDropActive,
  groupId,
  style,
}: {
  children: ReactNode;
  className: string;
  endDropActive: boolean;
  groupId: string;
  style?: CSSProperties;
}) {
  const { setNodeRef } = useDroppable({
    data: {
      groupId,
      type: 'embedded-browser-group',
    } satisfies EmbeddedBrowserGroupDndData,
    id: embeddedBrowserGroupDndId(groupId),
  });
  const { setNodeRef: setEndDropNodeRef } = useDroppable({
    data: {
      groupId,
      type: 'embedded-browser-group',
    } satisfies EmbeddedBrowserGroupDndData,
    disabled: !endDropActive,
    id: embeddedBrowserGroupEndDndId(groupId),
  });

  return (
    <div className={className} ref={setNodeRef} style={style}>
      {children}
      <span aria-hidden="true" className="browser-chat-embedded-tab-group-end-drop-zone" ref={setEndDropNodeRef} />
    </div>
  );
}

type BrowserChatPreviewTab = {
  id: string;
  index: number;
  url: string;
  active: boolean;
};

type BrowserChatPreviewFrame = {
  capturedAt: string;
  contentType: 'image/jpeg' | 'image/png';
  data: string;
  tabs: BrowserChatPreviewTab[];
  url: string;
  viewport: { width: number; height: number };
};

type BrowserChatPreviewInput =
  | { kind: 'move'; xRatio: number; yRatio: number }
  | { kind: 'click'; xRatio: number; yRatio: number; button: 'left' | 'right' | 'middle'; clickCount: number }
  | { kind: 'drag'; xRatio: number; yRatio: number; toXRatio: number; toYRatio: number; button: 'left' | 'right' | 'middle' }
  | { kind: 'scroll'; xRatio: number; yRatio: number; deltaX: number; deltaY: number }
  | { kind: 'key'; key: string }
  | { kind: 'text'; text: string };

function BrowserChatWebPreviewModal({
  onClose,
  sessionId,
  userId,
}: {
  onClose: () => void;
  sessionId: string;
  userId: string;
}) {
  const streamRef = useRef<WebSocket | null>(null);
  const previewImageRef = useRef<HTMLImageElement | null>(null);
  const pendingFrameRef = useRef<BrowserChatPreviewFrame | null>(null);
  const frameRenderRequestRef = useRef<number | undefined>(undefined);
  const pendingMoveRef = useRef<Extract<BrowserChatPreviewInput, { kind: 'move' }> | null>(null);
  const pointerGestureRef = useRef<{
    button: 'left' | 'middle';
    clickCount: number;
    current: { xRatio: number; yRatio: number };
    dragged: boolean;
    pointerId: number;
    start: { xRatio: number; yRatio: number };
    startClientX: number;
    startClientY: number;
  } | null>(null);
  const moveFlushTimerRef = useRef<number | undefined>(undefined);
  const pendingScrollRef = useRef<Extract<BrowserChatPreviewInput, { kind: 'scroll' }> | null>(null);
  const scrollFlushTimerRef = useRef<number | undefined>(undefined);
  const [frame, setFrame] = useState<BrowserChatPreviewFrame | null>(null);
  const [status, setStatus] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const [streamError, setStreamError] = useState('');
  const [inputError, setInputError] = useState('');

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | undefined;
    const connect = async () => {
      try {
        const response = await fetch(withWebPilotBasePath('/api/browser-chat/preview-stream'), { cache: 'no-store' });
        const data = await response.json() as { error?: string; url?: string };
        if (!response.ok || !data.url) throw new Error(data.error || '实时界面连接失败');
        if (disposed) return;
        const url = new URL(data.url);
        url.searchParams.set('sessionId', sessionId);
        url.searchParams.set('userId', userId);
        const stream = new WebSocket(url);
        streamRef.current = stream;
        stream.onopen = () => setStreamError('');
        stream.onmessage = (event) => {
          try {
            const message = JSON.parse(String(event.data)) as BrowserChatPreviewFrame & { error?: string; type?: string };
            if (message.type === 'frame') {
              pendingFrameRef.current = message;
              if (frameRenderRequestRef.current === undefined) {
                frameRenderRequestRef.current = window.requestAnimationFrame(() => {
                  frameRenderRequestRef.current = undefined;
                  const nextFrame = pendingFrameRef.current;
                  pendingFrameRef.current = null;
                  if (!nextFrame) return;
                  setFrame(nextFrame);
                  setStatus('live');
                  setStreamError('');
                });
              }
            } else if (message.type === 'activeTabChanged') {
              setStatus('reconnecting');
            } else if (message.type === 'ready') {
              setStatus((current) => current === 'reconnecting' ? 'connecting' : current);
              setStreamError('');
            } else if (message.type === 'inputError') {
              setInputError(message.error || '实时界面操作失败');
            } else if (message.type === 'error') {
              setStreamError(message.error || '实时界面连接失败');
            }
          } catch {
            setStreamError('实时画面数据无效');
          }
        };
        stream.onerror = () => setStreamError((current) => current || '实时界面连接中断，正在重连');
        stream.onclose = () => {
          if (streamRef.current === stream) streamRef.current = null;
          if (disposed) return;
          setStatus('reconnecting');
          reconnectTimer = window.setTimeout(() => void connect(), 600);
        };
      } catch (error) {
        if (disposed) return;
        setStatus('reconnecting');
        setStreamError(error instanceof Error ? error.message : '实时界面连接失败');
        reconnectTimer = window.setTimeout(() => void connect(), 600);
      }
    };
    void connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      const stream = streamRef.current;
      streamRef.current = null;
      stream?.close();
    };
  }, [sessionId, userId]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  useEffect(() => () => {
    pendingFrameRef.current = null;
    pendingMoveRef.current = null;
    pointerGestureRef.current = null;
    if (frameRenderRequestRef.current !== undefined) window.cancelAnimationFrame(frameRenderRequestRef.current);
    if (moveFlushTimerRef.current !== undefined) window.clearTimeout(moveFlushTimerRef.current);
    if (scrollFlushTimerRef.current !== undefined) window.clearTimeout(scrollFlushTimerRef.current);
  }, []);

  const postInput = useCallback((input: BrowserChatPreviewInput, reportError: boolean) => {
    const stream = streamRef.current;
    if (!stream || stream.readyState !== WebSocket.OPEN) {
      if (reportError) setInputError('实时界面正在重连，请稍后重试');
      return false;
    }
    stream.send(JSON.stringify({ event: input, type: 'input' }));
    return true;
  }, []);

  const sendInput = useCallback((input: BrowserChatPreviewInput) => {
    setInputError('');
    return postInput(input, true);
  }, [postInput]);

  const hasFrame = frame !== null;

  const relativePoint = useCallback((clientX: number, clientY: number, element: HTMLElement, clamp = false) => {
    if (!frame) return undefined;
    const rect = previewImageRef.current?.getBoundingClientRect() || element.getBoundingClientRect();
    if (!rect.width || !rect.height) return undefined;
    if (!clamp && (
      clientX < rect.left
      || clientX > rect.right
      || clientY < rect.top
      || clientY > rect.bottom
    )) return undefined;
    return {
      xRatio: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      yRatio: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
    };
  }, [frame]);

  const beginPreviewPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    const point = relativePoint(event.clientX, event.clientY, event.currentTarget);
    if (!point) return;
    event.currentTarget.focus();
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointerGestureRef.current = {
      button: event.button === 1 ? 'middle' : 'left',
      clickCount: Math.min(2, Math.max(1, event.detail || 1)),
      current: point,
      dragged: false,
      pointerId: event.pointerId,
      start: point,
      startClientX: event.clientX,
      startClientY: event.clientY,
    };
  }, [relativePoint]);

  const movePreviewPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = pointerGestureRef.current;
    if (!gesture && event.pointerType === 'touch') return;
    const point = relativePoint(event.clientX, event.clientY, event.currentTarget, Boolean(gesture));
    if (!point) return;
    if (gesture && gesture.pointerId === event.pointerId) {
      gesture.current = point;
      if (Math.hypot(event.clientX - gesture.startClientX, event.clientY - gesture.startClientY) >= 4) {
        gesture.dragged = true;
      }
      return;
    }
    pendingMoveRef.current = { kind: 'move', ...point };
    if (moveFlushTimerRef.current !== undefined) return;
    moveFlushTimerRef.current = window.setTimeout(() => {
      moveFlushTimerRef.current = undefined;
      const input = pendingMoveRef.current;
      pendingMoveRef.current = null;
      if (input) postInput(input, false);
    }, 16);
  }, [postInput, relativePoint]);

  const endPreviewPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = pointerGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const point = relativePoint(event.clientX, event.clientY, event.currentTarget, true) || gesture.current;
    pointerGestureRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    event.preventDefault();
    if (gesture.dragged) {
      sendInput({
        kind: 'drag',
        ...gesture.start,
        toXRatio: point.xRatio,
        toYRatio: point.yRatio,
        button: gesture.button,
      });
      return;
    }
    sendInput({
      kind: 'click',
      ...point,
      button: gesture.button,
      clickCount: gesture.clickCount,
    });
  }, [relativePoint, sendInput]);

  const cancelPreviewPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerGestureRef.current?.pointerId !== event.pointerId) return;
    pointerGestureRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  }, []);

  const openPreviewContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const point = relativePoint(event.clientX, event.clientY, event.currentTarget);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.focus();
    sendInput({ kind: 'click', ...point, button: 'right', clickCount: 1 });
  }, [relativePoint, sendInput]);

  const scrollPreview = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const point = relativePoint(event.clientX, event.clientY, event.currentTarget);
    if (!point) return;
    event.preventDefault();
    const current = pendingScrollRef.current;
    pendingScrollRef.current = {
      kind: 'scroll',
      ...point,
      deltaX: (current?.deltaX || 0) + event.deltaX,
      deltaY: (current?.deltaY || 0) + event.deltaY,
    };
    if (scrollFlushTimerRef.current !== undefined) return;
    scrollFlushTimerRef.current = window.setTimeout(() => {
      scrollFlushTimerRef.current = undefined;
      const input = pendingScrollRef.current;
      pendingScrollRef.current = null;
      if (input) sendInput(input);
    }, 16);
  }, [relativePoint, sendInput]);

  const pressPreviewKey = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.key === 'Process') return;
    const modifierShortcut = event.ctrlKey || event.metaKey || event.altKey;
    let key = event.key;
    if (modifierShortcut) {
      const parts = [
        event.ctrlKey ? 'Control' : '',
        event.metaKey ? 'Meta' : '',
        event.altKey ? 'Alt' : '',
        event.shiftKey ? 'Shift' : '',
        key.length === 1 ? key.toUpperCase() : key,
      ].filter(Boolean);
      key = parts.join('+');
    } else if (event.shiftKey && key.length > 1) {
      key = `Shift+${key}`;
    } else if (key === ' ') {
      key = 'Space';
    }
    event.preventDefault();
    event.stopPropagation();
    sendInput({ kind: 'key', key });
  }, [sendInput]);

  const pastePreviewText = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
    const text = event.clipboardData.getData('text');
    if (!text) return;
    event.preventDefault();
    sendInput({ kind: 'text', text });
  }, [sendInput]);

  const switchPreviewTab = useCallback(async (tabId: string) => {
    try {
      const response = await fetch(withWebPilotBasePath(`/api/browser-chat/${encodeURIComponent(sessionId)}/tabs/${encodeURIComponent(tabId)}?userId=${encodeURIComponent(userId)}`), {
        method: 'POST',
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || '切换标签页失败');
      setStatus((current) => current === 'live' ? current : 'connecting');
    } catch (error) {
      setInputError(error instanceof Error ? error.message : '切换标签页失败');
    }
  }, [sessionId, userId]);

  const statusLabel = status === 'live' ? '实时' : status === 'reconnecting' ? '正在重连' : '正在连接';

  return (
    <div className="ui-modal-overlay browser-chat-web-preview-overlay" onClick={onClose} role="presentation">
      <div
        aria-label="实时界面"
        aria-modal="true"
        className="ui-modal browser-chat-web-preview-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="ui-modal-header browser-chat-web-preview-header" style={{ padding: '0px 16px'}}>
          <div className="ui-modal-heading">
            <div className="browser-chat-web-preview-title-row">
              <h2 className="ui-modal-title">实时界面</h2>
              <span className={`browser-chat-web-preview-status is-${status}`}>
                <span />
                {statusLabel}
              </span>
              <span className="browser-chat-web-preview-url" title={frame?.url || ''}>
                {frame?.url || '等待会话浏览器启动'}
              </span>
            </div>
          </div>
          <button aria-label="关闭实时界面" className="ui-icon-button ui-modal-close" onClick={onClose} title="关闭" type="button">
            <X size={18} />
          </button>
        </header>

        {frame?.tabs?.length ? (
          <div className="browser-chat-web-preview-tabs">
            {frame.tabs.map((tab) => (
              <button
                className={tab.active ? 'active' : ''}
                key={tab.id}
                onClick={() => void switchPreviewTab(tab.id)}
                title={tab.url}
                type="button"
              >
                <Globe size={13} />
                <span>{tab.url || `标签页 ${tab.index + 1}`}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="browser-chat-web-preview-body">
          <div
            aria-label="可操作的浏览器实时画面"
            className={frame ? 'browser-chat-web-preview-stage has-frame' : 'browser-chat-web-preview-stage'}
            onContextMenu={openPreviewContextMenu}
            onKeyDown={pressPreviewKey}
            onPaste={pastePreviewText}
            onPointerCancel={cancelPreviewPointer}
            onPointerDown={beginPreviewPointer}
            onPointerMove={movePreviewPointer}
            onPointerUp={endPreviewPointer}
            onWheel={scrollPreview}
            role="application"
            tabIndex={0}
          >
            {frame ? (
              <img alt="浏览器实时画面" draggable={false} ref={previewImageRef} src={`data:${frame.contentType};base64,${frame.data}`} />
            ) : (
              <div className="browser-chat-web-preview-empty">
                <Loader2 className="spin" size={22} />
                <strong>{streamError || '正在等待浏览器画面'}</strong>
                <span>发送一条需要访问网页的消息后，画面会自动出现。</span>
              </div>
            )}
          </div>
          {streamError && frame ? <div className="browser-chat-web-preview-alert">{streamError}</div> : null}
          {inputError ? <div className="browser-chat-web-preview-alert">{inputError}</div> : null}
        </div>

      </div>
    </div>
  );
}

const BrowserChatEmbeddedBrowser = memo(function BrowserChatEmbeddedBrowser({
  active,
  activationRequestId,
  browserGroupId,
  enabled,
  leftOverlayInset = 0,
  onAddTabReference,
  onDialogOpenChange,
  onSelectSession,
  sessionId,
  userId,
}: {
  active: boolean;
  activationRequestId?: string;
  browserGroupId?: string;
  enabled: boolean;
  leftOverlayInset?: number;
  onAddTabReference?: (reference: BrowserChatAttachment) => void;
  onDialogOpenChange?: (open: boolean) => void;
  onSelectSession?: (sessionId: string) => void;
  sessionId?: string;
  userId?: string;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const embeddedBrowserSyncRef = useRef({ boundsKey: '', groupId: '', sessionId: '', visible: false });
  const addressFocusedRef = useRef(false);
  const tabDragCommitTargetRef = useRef<EmbeddedBrowserTabDropTarget | null>(null);
  const tabDragCurrentGroupRef = useRef('');
  const tabDragSourceGroupRef = useRef('');
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
  const [closedGroupIds, setClosedGroupIds] = useState<string[]>([]);
  const [draggingTabId, setDraggingTabId] = useState('');
  const [dragDropGroupId, setDragDropGroupId] = useState('');
  const [tabDragPreview, setTabDragPreview] = useState<EmbeddedBrowserTabDragPreview | null>(null);
  const [tabDragPortalTarget, setTabDragPortalTarget] = useState<HTMLElement | null>(null);
  const [tabListWidth, setTabListWidth] = useState(0);
  const [libraryPanel, setLibraryPanel] = useState<'library' | null>(null);
  const [newGroupDialogOpen, setNewGroupDialogOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('新建标签组');
  const [creatingNewGroup, setCreatingNewGroup] = useState(false);
  const [runtimeActivatedSessionId, setRuntimeActivatedSessionId] = useState('');
  const requestedGroupId = browserGroupId
    || (!sessionId && activeGroupId)
    || embeddedGroupIdForSession(sessionId);
  const requestedGroupAvailable = useMemo(() => (
    browserGroups.some((group) => group.id === requestedGroupId && group.tabs.length > 0)
    || browserTabs.some((tab) => (
      tab.groupId === requestedGroupId
      || (!tab.groupId && tab.sessionId && embeddedGroupIdForSession(tab.sessionId) === requestedGroupId)
      || (!tab.groupId && !tab.sessionId && requestedGroupId === 'default')
    ))
  ), [browserGroups, browserTabs, requestedGroupId]);
  // Historical conversations do not have a fresh browser:start/browser:reuse
  // log entry, but their persisted tab group is still safe to reattach. Keep
  // the runtime gate only for creating a missing group; otherwise selecting a
  // historical conversation detaches the native WebContentsView and leaves the
  // React-rendered tab strip above an empty browser surface.
  const runtimeAuthorized = !sessionId
    || requestedGroupAvailable
    || runtimeActivatedSessionId === sessionId;

  useEffect(() => {
    if (!sessionId) {
      setRuntimeActivatedSessionId('');
      return;
    }
    setRuntimeActivatedSessionId((current) => (
      activationRequestId ? sessionId : current === sessionId ? current : ''
    ));
  }, [activationRequestId, sessionId]);
  const embeddedTabSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 3 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const applyEmbeddedBrowserState = useCallback((result: EmbeddedBrowserState) => {
    if (!result.ok) {
      setBridgeError(result.error || '嵌入浏览器状态不可用');
      return;
    }
    setBridgeError('');
    setBrowserGroups(Array.isArray(result.groups) ? result.groups : []);
    setBrowserTabs(Array.isArray(result.tabs) ? result.tabs : []);
    setLibraryPanel(result.libraryPanel === 'library' ? result.libraryPanel : null);
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

  const syncEmbeddedBrowser = useCallback(async (options: { forceAttach?: boolean } = {}) => {
    const bridge = window.webPilotEmbeddedBrowser;
    const viewport = viewportRef.current;
    const canCreateRequestedGroup = Boolean(activationRequestId && runtimeAuthorized);
    const visible = enabled && active && Boolean(viewport) && runtimeAuthorized
      && (requestedGroupAvailable || canCreateRequestedGroup);
    const groupId = requestedGroupId;
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

      if (options.forceAttach || !previous.visible || previous.groupId !== groupId || previous.sessionId !== (sessionId || '')) {
        embeddedBrowserSyncRef.current = { boundsKey, groupId, sessionId: sessionId || '', visible: true };
        const result = await bridge.setVisible({
          bounds,
          createIfMissing: canCreateRequestedGroup && !requestedGroupAvailable,
          groupId,
          sessionId,
          userId,
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
  }, [activationRequestId, active, applyEmbeddedBrowserState, enabled, leftOverlayInset, requestedGroupAvailable, requestedGroupId, runtimeAuthorized, sessionId, userId]);

  useEffect(() => {
    void syncEmbeddedBrowser();
    const viewport = viewportRef.current;
    if (!enabled || !active || !viewport) return undefined;

    const update = () => {
      void syncEmbeddedBrowser();
    };
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(viewport);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);

    const restoreNativeView = () => {
      if (document.visibilityState === 'hidden') return;
      void syncEmbeddedBrowser({ forceAttach: true });
    };
    // The native WebContentsView can be removed by Electron while the React
    // shell remains mounted. Reconfirm it after mount and whenever this window
    // becomes visible again, rather than trusting the renderer-side cache.
    const restoreTimer = window.setTimeout(restoreNativeView, 250);
    window.addEventListener('focus', restoreNativeView);
    window.addEventListener('pageshow', restoreNativeView);
    document.addEventListener('visibilitychange', restoreNativeView);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.clearTimeout(restoreTimer);
      window.removeEventListener('focus', restoreNativeView);
      window.removeEventListener('pageshow', restoreNativeView);
      document.removeEventListener('visibilitychange', restoreNativeView);
    };
  }, [active, enabled, syncEmbeddedBrowser]);

  useEffect(() => () => {
    embeddedBrowserSyncRef.current = { boundsKey: '', groupId: '', sessionId: '', visible: false };
    void window.webPilotEmbeddedBrowser?.setVisible({ visible: false }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!enabled || !active) return undefined;
    void loadEmbeddedBrowserState();
    const bridge = window.webPilotEmbeddedBrowser;
    return bridge?.onStateChange?.((result) => applyEmbeddedBrowserState(result)) || undefined;
  }, [active, applyEmbeddedBrowserState, enabled, loadEmbeddedBrowserState, sessionId]);

  useEffect(() => {
    const tabList = tabListRef.current;
    if (!tabList) return undefined;
    const updateWidth = () => {
      const nextWidth = Math.round(tabList.getBoundingClientRect().width);
      setTabListWidth((current) => current === nextWidth ? current : nextWidth);
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(tabList);
    return () => observer.disconnect();
  }, []);

  const handleEmbeddedTabListWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const tabList = event.currentTarget;
    if (tabList.scrollWidth <= tabList.clientWidth) return;

    const rawDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ? event.deltaX
      : event.deltaY;
    if (!rawDelta) return;

    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? tabList.clientWidth : 1;
    const maximumScrollLeft = tabList.scrollWidth - tabList.clientWidth;
    const nextScrollLeft = Math.min(
      maximumScrollLeft,
      Math.max(0, tabList.scrollLeft + rawDelta * unit),
    );
    if (nextScrollLeft === tabList.scrollLeft) return;

    tabList.scrollLeft = nextScrollLeft;
    event.preventDefault();
  }, []);

  useEffect(() => {
    if (!enabled || !active) return undefined;
    return window.webPilotEmbeddedBrowser?.onFocusAddress?.(() => {
      window.requestAnimationFrame(() => {
        addressInputRef.current?.focus();
        addressInputRef.current?.select();
      });
    }) || undefined;
  }, [active, enabled]);

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

  async function stopEmbeddedBrowserLoading() {
    const bridge = window.webPilotEmbeddedBrowser;
    if (!bridge?.stop) return;
    const result = await bridge.stop().catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : '停止页面加载失败',
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

  async function toggleEmbeddedBrowserLibraryPanel() {
    const bridge = window.webPilotEmbeddedBrowser;
    if (!bridge) return;
    const request = bridge.toggleLibraryPanel
      ? bridge.toggleLibraryPanel({ panel: 'library' })
      : bridge.setLibraryPanel({ panel: libraryPanel === 'library' ? null : 'library' });
    const result = await request.catch((error: unknown) => ({
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
    if (result.ok && tab.sessionId && tab.sessionId !== sessionId) {
      onSelectSession?.(tab.sessionId);
    }
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
      const nextActiveGroup = result.groups?.find((item) => item.active) || result.groups?.find((item) => item.tabs.length);
      const nextSessionId = nextActiveGroup?.sessionId || nextActiveGroup?.tabs.find((tab) => tab.sessionId)?.sessionId;
      if (nextSessionId && nextSessionId !== sessionId) {
        onSelectSession?.(nextSessionId);
      }
      void syncEmbeddedBrowser();
    }
  }

  async function createEmbeddedBrowserTab(group: EmbeddedBrowserGroup) {
    const bridge = window.webPilotEmbeddedBrowser;
    if (!bridge) return;
    const groupSessionId = embeddedSessionIdFromGroupId(group.id)
      || (group.id.startsWith('session:') ? group.sessionId : sessionId)
      || sessionId;
    const result = await bridge.createTab({ groupId: group.id, sessionId: groupSessionId, userId }).catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : '创建嵌入浏览器标签失败',
    }));
    applyEmbeddedBrowserState(result);
    if (result.ok) {
      setClosedGroupIds((current) => current.filter((item) => item !== group.id));
      if (groupSessionId && groupSessionId !== sessionId) {
        onSelectSession?.(groupSessionId);
      }
    }
  }

  async function createEmbeddedBrowserGroup() {
    const bridge = window.webPilotEmbeddedBrowser;
    if (!bridge) return;
    const label = newGroupName.trim() || '新建标签组';
    if (!label) return;
    setCreatingNewGroup(true);
    try {
      const result = await bridge.createGroup({ label }).catch((error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : '创建嵌入浏览器标签组失败',
      }));
      applyEmbeddedBrowserState(result);
      if (!result.ok) return;
      setNewGroupDialogOpen(false);
      onDialogOpenChange?.(false);
      setNewGroupName('新建标签组');
    } finally {
      setCreatingNewGroup(false);
    }
  }

  async function toggleEmbeddedBrowserGroupCollapsed(group: EmbeddedBrowserGroup) {
    const bridge = window.webPilotEmbeddedBrowser;
    if (!bridge) return;
    const result = await bridge.setGroupCollapsed({ collapsed: !group.collapsed, id: group.id }).catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : '更新标签组状态失败',
    }));
    applyEmbeddedBrowserState(result);
  }

  async function moveEmbeddedBrowserTab(tabId: string, options: { position?: 'before' | 'after' | 'end'; targetGroupId?: string; targetId?: string; targetSessionId?: string }) {
    const bridge = window.webPilotEmbeddedBrowser;
    if (!bridge || !tabId || (options.targetId && tabId === options.targetId)) return;
    const result = await bridge.moveTab({ id: tabId, ...options }).catch((error: unknown): EmbeddedBrowserState => ({
      ok: false,
      error: error instanceof Error ? error.message : '移动嵌入浏览器标签失败',
    }));
    applyEmbeddedBrowserState(result);
    if (result.ok && result.activeTabId === tabId) {
      const movedTab = result.tabs?.find((item) => item.id === tabId);
      if (movedTab?.sessionId && movedTab.sessionId !== sessionId) {
        onSelectSession?.(movedTab.sessionId);
      }
    }
  }

  function showEmbeddedBrowserTabContextMenu(event: ReactMouseEvent<HTMLElement>, tab: EmbeddedBrowserTab) {
    event.preventDefault();
    event.stopPropagation();
    const bridge = window.webPilotEmbeddedBrowser;
    if (!bridge) return;
    void bridge.showTabContextMenu({
      groups: visibleGroups.map((group) => ({
        id: group.id,
        label: embeddedSessionGroupLabel(group.sessionId || embeddedSessionIdFromGroupId(group.id)),
      })),
      id: tab.id,
    }).catch(() => undefined);
  }

  async function navigateEmbeddedBrowserAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const bridge = window.webPilotEmbeddedBrowser;
    const url = normalizeEmbeddedBrowserAddress(addressValue);
    if (!bridge || !url) return;
    const groupId = activeEmbeddedTab?.groupId || activeGroupId || browserGroupId || undefined;
    const targetSessionId = activeEmbeddedTab?.sessionId
      || (groupId?.startsWith('session:') ? embeddedSessionIdFromGroupId(groupId) : undefined)
      || (groupId === browserGroupId ? sessionId : undefined);
    const result = await bridge.navigate({
      groupId,
      id: activeEmbeddedTab?.id,
      sessionId: targetSessionId,
      url,
    }).catch((error: unknown) => ({
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

  function clearEmbeddedTabDrag({ keepPreview = false }: { keepPreview?: boolean } = {}) {
    if (typeof document !== 'undefined') document.body.classList.remove('is-dragging-embedded-tab');
    tabDragCommitTargetRef.current = null;
    tabDragCurrentGroupRef.current = '';
    tabDragSourceGroupRef.current = '';
    setDraggingTabId('');
    setDragDropGroupId('');
    if (!keepPreview) setTabDragPreview(null);
  }

  const selectedGroupId = browserGroupId || embeddedGroupIdForSession(sessionId);
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
          collapsed: Boolean(input.collapsed),
          id: normalizedId,
          label: input.label,
          sessionId: input.sessionId,
          tabs: [],
        };
        groupsById.set(normalizedId, group);
        orderedIds.push(normalizedId);
      }
      group.active = Boolean(group.active || input.active || normalizedId === resolvedActiveGroupId);
      group.activeTabId = group.activeTabId || input.activeTabId;
      group.label = group.label || input.label;
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

  const visibleGroupIconColors = useMemo(() => {
    return new Map(visibleGroups.map((group) => [group.id, embeddedBrowserGroupIconColor(group.id)]));
  }, [visibleGroups]);
  const renderedVisibleGroups = useMemo(() => {
    if (!tabDragPreview) return visibleGroups;
    const tabsById = new Map(visibleGroups.flatMap((group) => group.tabs).map((tab) => [tab.id, tab]));
    return visibleGroups.map((group) => ({
      ...group,
      tabs: (tabDragPreview[group.id] || group.tabs.map((tab) => tab.id))
        .map((tabId) => tabsById.get(tabId))
        .filter((tab): tab is EmbeddedBrowserTab => Boolean(tab)),
    }));
  }, [tabDragPreview, visibleGroups]);
  const embeddedTabLayoutStyle = useMemo(() => {
    const expandedGroups = renderedVisibleGroups.filter((group) => !group.collapsed);
    const tabCount = expandedGroups.reduce((total, group) => total + group.tabs.length, 0);
    const groupCount = renderedVisibleGroups.length;
    const groupGapWidth = Math.max(0, groupCount - 1) * 4;
    const tagToTabGapWidth = expandedGroups.length * 4;
    const tabGapWidth = expandedGroups.reduce((total, group) => total + Math.max(0, group.tabs.length - 1) * 6, 0);
    const fixedWidth = groupCount * 36
      + groupGapWidth
      + tagToTabGapWidth
      + tabGapWidth;
    const requestedWidth = tabListWidth > 0 && tabCount > 0
      ? Math.floor((tabListWidth - fixedWidth) / tabCount)
      : 210;
    const tabWidth = Math.min(210, Math.max(0, requestedWidth));
    return { '--embedded-tab-width': `${tabWidth}px` } as CSSProperties;
  }, [renderedVisibleGroups, tabListWidth]);

  const activeEmbeddedTab = useMemo(() => {
    const groupedTabs = visibleGroups.flatMap((group) => group.tabs);
    const activeGroup = visibleGroups.find((group) => group.id === activeGroupId)
      || visibleGroups.find((group) => group.active);
    const activeGroupTabs = activeGroup?.tabs || [];
    if (activeTabId) {
      return activeGroupTabs.find((tab) => tab.id === activeTabId)
        || groupedTabs.find((tab) => tab.id === activeTabId);
    }
    if (activeGroup) return activeGroupTabs[0];
    return browserTabs[activeTabIndex] || groupedTabs[activeTabIndex] || groupedTabs[0];
  }, [activeGroupId, activeTabId, activeTabIndex, browserTabs, visibleGroups]);
  const isEmbeddedBrowserLoading = Boolean(activeEmbeddedTab?.loading);
  const draggedEmbeddedTab = useMemo(() => (
    draggingTabId
      ? visibleGroups.flatMap((group) => group.tabs).find((tab) => tab.id === draggingTabId)
      : undefined
  ), [draggingTabId, visibleGroups]);

  function embeddedBrowserDropTarget(event: DragOverEvent | DragEndEvent): EmbeddedBrowserTabDropTarget | undefined {
    const over = event.over;
    if (!over) return undefined;
    const overData = over.data.current as EmbeddedBrowserTabDndData | EmbeddedBrowserGroupDndData | undefined;
    if (!overData) return undefined;
    if (overData.type === 'embedded-browser-group') {
      return { groupId: overData.groupId, type: overData.type } as const;
    }

    const dragData = event.active.data.current as EmbeddedBrowserTabDndData | undefined;
    if (dragData?.type === 'embedded-browser-tab' && dragData.groupId === overData.groupId) {
      const sourceGroup = visibleGroups.find((group) => group.id === dragData.groupId);
      const sourceIndex = sourceGroup?.tabs.findIndex((tab) => tab.id === dragData.tabId) ?? -1;
      const targetIndex = sourceGroup?.tabs.findIndex((tab) => tab.id === overData.tabId) ?? -1;
      if (sourceIndex >= 0 && targetIndex >= 0 && sourceIndex !== targetIndex) {
        // horizontalListSortingStrategy moves the active item to the over item's
        // index. Use that exact index relationship when committing so the final
        // order cannot disagree with the animation shown while dragging.
        return {
          groupId: overData.groupId,
          position: sourceIndex < targetIndex ? 'after' : 'before',
          tabId: overData.tabId,
          type: overData.type,
        } as const;
      }
    }

    const activatorEvent = event.activatorEvent;
    const pointerX = activatorEvent instanceof MouseEvent ? activatorEvent.clientX + event.delta.x : undefined;
    const activeRect = event.active.rect.current.translated;
    const activeCenter = activeRect ? activeRect.left + activeRect.width / 2 : pointerX;
    const overThreshold = over.rect.left + over.rect.width / 2;
    const position = activeCenter === undefined
      ? (event.delta.x > 0 ? 'after' : 'before')
      : (activeCenter > overThreshold ? 'after' : 'before');
    return { groupId: overData.groupId, position, tabId: overData.tabId, type: overData.type } as const;
  }

  function previewEmbeddedBrowserTabMove(
    tabId: string,
    target: EmbeddedBrowserTabDropTarget | undefined,
  ) {
    if (!target || (target.type === 'embedded-browser-tab' && target.tabId === tabId)) return;
    setTabDragPreview((current) => {
      const next = Object.fromEntries(visibleGroups.map((group) => [
        group.id,
        [...(current?.[group.id] || group.tabs.map((tab) => tab.id))],
      ])) as EmbeddedBrowserTabDragPreview;
      for (const tabIds of Object.values(next)) {
        const sourceIndex = tabIds.indexOf(tabId);
        if (sourceIndex >= 0) tabIds.splice(sourceIndex, 1);
      }

      const destination = next[target.groupId];
      if (!destination) return current;
      if (target.type === 'embedded-browser-group') {
        destination.push(tabId);
      } else {
        const targetIndex = destination.indexOf(target.tabId);
        destination.splice(targetIndex < 0 ? destination.length : targetIndex + (target.position === 'after' ? 1 : 0), 0, tabId);
      }
      const tabsById = new Map(visibleGroups.flatMap((group) => group.tabs).map((tab) => [tab.id, tab]));
      next[target.groupId] = [
        ...destination.filter((id) => tabsById.get(id)?.pinned),
        ...destination.filter((id) => !tabsById.get(id)?.pinned),
      ];

      if (current && Object.keys(next).every((groupId) => (
        current[groupId]?.length === next[groupId].length
        && current[groupId].every((id, index) => id === next[groupId][index])
      ))) return current;
      return next;
    });
  }

  function handleEmbeddedTabDragStart(event: DragStartEvent) {
    const dragData = event.active.data.current as EmbeddedBrowserTabDndData | undefined;
    if (!dragData?.tabId) return;
    document.body.classList.add('is-dragging-embedded-tab');
    tabDragCommitTargetRef.current = null;
    tabDragCurrentGroupRef.current = dragData.groupId;
    tabDragSourceGroupRef.current = dragData.groupId;
    setDraggingTabId(dragData.tabId);
    setDragDropGroupId(dragData.groupId);
    setTabDragPreview(Object.fromEntries(visibleGroups.map((group) => [group.id, group.tabs.map((tab) => tab.id)])));
  }

  function handleEmbeddedTabDragOver(event: DragOverEvent) {
    const dragData = event.active.data.current as EmbeddedBrowserTabDndData | undefined;
    const target = embeddedBrowserDropTarget(event);
    if (!dragData?.tabId || !target) {
      return;
    }
    if (target.type === 'embedded-browser-tab' && target.tabId === dragData.tabId) {
      return;
    }
    tabDragCommitTargetRef.current = target;
    const sourceGroupId = tabDragSourceGroupRef.current || dragData.groupId;
    const previewCrossGroupMove = target.groupId !== sourceGroupId
      || tabDragCurrentGroupRef.current !== sourceGroupId;
    if (previewCrossGroupMove) previewEmbeddedBrowserTabMove(dragData.tabId, target);
    tabDragCurrentGroupRef.current = target.groupId;
    setDragDropGroupId(target.groupId);
  }

  function handleEmbeddedTabDragEnd(event: DragEndEvent) {
    const dragData = event.active.data.current as EmbeddedBrowserTabDndData | undefined;
    const detectedTarget = embeddedBrowserDropTarget(event);
    const activatorEvent = event.activatorEvent;
    const point = activatorEvent instanceof MouseEvent
      ? { x: activatorEvent.clientX + event.delta.x, y: activatorEvent.clientY + event.delta.y }
      : undefined;
    const droppedOnTabStrip = point
      ? document.elementsFromPoint(point.x, point.y).some((element) => element.closest('.browser-chat-embedded-tab-strip'))
      : false;
    const target = event.over == null
      ? droppedOnTabStrip ? tabDragCommitTargetRef.current || undefined : undefined
      : detectedTarget?.type === 'embedded-browser-tab' && detectedTarget.tabId === dragData?.tabId
        ? tabDragCommitTargetRef.current || undefined
        : detectedTarget;
    if (!dragData?.tabId) return;
    if (!target) {
      clearEmbeddedTabDrag();
      const droppedOnComposer = point
        ? document.elementsFromPoint(point.x, point.y).some((element) => element.closest('.browser-chat-compose--reference'))
        : false;
      const draggedTab = visibleGroups.flatMap((group) => group.tabs).find((tab) => tab.id === dragData.tabId);
      const reference = droppedOnComposer && draggedTab ? browserChatTabReferenceFromPayload({
        groupId: dragData.groupId,
        id: draggedTab.id,
        sessionId: draggedTab.sessionId,
        title: draggedTab.title,
        url: embeddedBrowserDisplayUrl(draggedTab) || draggedTab.url,
      }) : undefined;
      if (reference) onAddTabReference?.(reference);
      return;
    }

    if (target.type === 'embedded-browser-tab') {
      if (target.tabId === dragData.tabId) {
        clearEmbeddedTabDrag();
        return;
      }
      previewEmbeddedBrowserTabMove(dragData.tabId, target);
      clearEmbeddedTabDrag({ keepPreview: true });
      void moveEmbeddedBrowserTab(dragData.tabId, { position: target.position, targetId: target.tabId })
        .finally(() => setTabDragPreview(null));
      return;
    }

    previewEmbeddedBrowserTabMove(dragData.tabId, target);
    clearEmbeddedTabDrag({ keepPreview: true });
    const targetGroup = visibleGroups.find((group) => group.id === target.groupId);
    const targetSessionId = targetGroup?.sessionId
      || targetGroup?.tabs.find((tab) => tab.sessionId)?.sessionId
      || (target.groupId.startsWith('session:') ? embeddedSessionIdFromGroupId(target.groupId) : undefined);
    void moveEmbeddedBrowserTab(dragData.tabId, {
      position: 'end',
      targetGroupId: target.groupId,
      targetSessionId,
    }).finally(() => setTabDragPreview(null));
  }

  useEffect(() => {
    if (!addressFocusedRef.current) setAddressValue(embeddedBrowserDisplayUrl(activeEmbeddedTab));
  }, [activeEmbeddedTab]);

  useEffect(() => {
    setTabDragPortalTarget(document.body);
    return () => {
      document.body.classList.remove('is-dragging-embedded-tab');
    };
  }, []);

  useEffect(() => {
    if (!draggingTabId) return undefined;
    const cancelDrag = () => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'Escape',
        key: 'Escape',
      }));
    };
    const cancelWhenHidden = () => {
      if (document.visibilityState !== 'visible') cancelDrag();
    };
    window.addEventListener('blur', cancelDrag);
    document.addEventListener('lostpointercapture', cancelDrag, true);
    document.addEventListener('visibilitychange', cancelWhenHidden);
    document.documentElement.addEventListener('pointerleave', cancelDrag);
    return () => {
      window.removeEventListener('blur', cancelDrag);
      document.removeEventListener('lostpointercapture', cancelDrag, true);
      document.removeEventListener('visibilitychange', cancelWhenHidden);
      document.documentElement.removeEventListener('pointerleave', cancelDrag);
    };
  }, [draggingTabId]);

  return (
    <>
    <section
      className={[
        'browser-chat-embedded-browser',
        isEmbeddedBrowserLoading ? 'loading' : '',
      ].filter(Boolean).join(' ')}
      aria-label="嵌入浏览器"
    >
      <header className="browser-chat-embedded-chrome">
        <div className="browser-chat-embedded-tab-strip">
          <DndContext
            collisionDetection={embeddedBrowserTabCollisionDetection}
            modifiers={embeddedBrowserTabModifiers}
            onDragCancel={() => clearEmbeddedTabDrag()}
            onDragEnd={handleEmbeddedTabDragEnd}
            onDragOver={handleEmbeddedTabDragOver}
            onDragStart={handleEmbeddedTabDragStart}
            sensors={embeddedTabSensors}
          >
            <div
              className="browser-chat-embedded-tab-list"
              onWheel={handleEmbeddedTabListWheel}
              ref={tabListRef}
              role="tablist"
              aria-label="Embedded browser tabs"
              style={embeddedTabLayoutStyle}
            >
              {renderedVisibleGroups.map((group) => {
                const groupSessionId = group.sessionId
                  || group.tabs.find((tab) => tab.sessionId)?.sessionId
                  || (group.id.startsWith('session:') ? group.id.slice('session:'.length) : sessionId);
                const groupLabel = group.label || embeddedSessionGroupLabel(groupSessionId);
                const isActiveGroup = Boolean(group.active || group.id === selectedGroupId);
                const isCollapsedGroup = Boolean(group.collapsed);
                return (
                  <EmbeddedBrowserTabGroupDropZone
                    className={[
                      'browser-chat-embedded-tab-group-shell',
                      isActiveGroup ? 'active' : '',
                      isCollapsedGroup ? 'collapsed' : '',
                      group.tabs.length ? '' : 'empty',
                      dragDropGroupId === group.id ? 'drop-target' : '',
                    ].filter(Boolean).join(' ')}
                    endDropActive={Boolean(draggingTabId && dragDropGroupId === group.id)}
                    groupId={group.id}
                    key={group.id}
                    style={{ '--embedded-group-icon-color': visibleGroupIconColors.get(group.id) } as CSSProperties}
                  >
                    <div className="browser-chat-embedded-tab-group-tag">
                      <button
                        aria-expanded={!isCollapsedGroup}
                        className="browser-chat-embedded-tab-group-label"
                        onClick={() => void toggleEmbeddedBrowserGroupCollapsed(group)}
                        title={`${isCollapsedGroup ? '展开' : '收起'} ${groupLabel} 标签组`}
                        type="button"
                      >
                        {isCollapsedGroup ? <Folder size={16} /> : <FolderOpen size={16} />}
                      </button>
                      <button
                        aria-label={`关闭 ${groupLabel} 标签组`}
                        className="browser-chat-embedded-tab-group-action browser-chat-embedded-tab-group-close"
                        onClick={(event) => {
                          event.stopPropagation();
                          void closeEmbeddedBrowserGroup(group);
                        }}
                        title={`关闭 ${groupLabel} 标签组`}
                        type="button"
                      >
                        <X size={13} />
                      </button>
                      <button
                        aria-label={`在 ${groupLabel} 中新建标签页`}
                        className="browser-chat-embedded-tab-group-action browser-chat-embedded-tab-group-add"
                        onClick={(event) => {
                          event.stopPropagation();
                          void createEmbeddedBrowserTab(group);
                        }}
                        title={`在 ${groupLabel} 中新建标签页`}
                        type="button"
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                    <SortableContext
                      items={group.tabs.map((tab) => embeddedBrowserTabDndId(tab.id))}
                      strategy={horizontalListSortingStrategy}
                    >
                      <div className="browser-chat-embedded-tab-stack">
                        {group.tabs.map((tab) => {
                          const tabIndex = browserTabs.findIndex((item) => item.id === tab.id);
                          const isActiveTab = activeTabId ? tab.id === activeTabId : tabIndex === activeTabIndex;
                          return (
                            <EmbeddedBrowserSortableTab
                              active={isActiveTab}
                              dragging={draggingTabId === tab.id}
                              groupId={group.id}
                              key={tab.id || `${tab.url}-${tabIndex}`}
                              onActivate={() => void activateEmbeddedBrowserTab(tab)}
                              onClose={() => void closeEmbeddedBrowserTab(tab)}
                              onContextMenu={(event) => showEmbeddedBrowserTabContextMenu(event, tab)}
                              onToggleMute={() => void setEmbeddedBrowserTabMuted(tab)}
                              tab={tab}
                            />
                          );
                        })}
                      </div>
                    </SortableContext>
                  </EmbeddedBrowserTabGroupDropZone>
                );
              })}
            </div>
            {tabDragPortalTarget ? createPortal(
              <DragOverlay
                adjustScale={false}
                dropAnimation={null}
                modifiers={embeddedBrowserTabModifiers}
                zIndex={1200}
              >
                {draggedEmbeddedTab ? (
                  <div
                    aria-hidden="true"
                    className={[
                      'browser-chat-embedded-tab',
                      'browser-chat-embedded-tab-drag-overlay',
                      draggedEmbeddedTab.id === activeTabId ? 'active' : '',
                      draggedEmbeddedTab.pinned ? 'pinned' : '',
                      draggedEmbeddedTab.loading ? 'loading' : '',
                    ].filter(Boolean).join(' ')}
                  >
                    <EmbeddedBrowserTabContent tab={draggedEmbeddedTab} />
                  </div>
                ) : null}
              </DragOverlay>,
              tabDragPortalTarget,
            ) : null}
          </DndContext>
          <button
            aria-label="新建标签组"
            className="browser-chat-embedded-new-group"
            onClick={() => {
              setNewGroupDialogOpen(true);
              onDialogOpenChange?.(true);
            }}
            title="新建标签组"
            type="button"
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="browser-chat-embedded-toolbar">
          <div className="browser-chat-embedded-nav-controls">
            <button className="browser-chat-embedded-tool-button" disabled={!canGoBack} onClick={() => void goEmbeddedBrowserBack()} title="Back" type="button" aria-label="Back">
              <ArrowLeft size={16} />
            </button>
            <button className="browser-chat-embedded-tool-button" disabled={!canGoForward} onClick={() => void goEmbeddedBrowserForward()} title="Forward" type="button" aria-label="Forward">
              <ArrowRight size={16} />
            </button>
            <button
              aria-label={isEmbeddedBrowserLoading ? '停止加载' : '重新加载'}
              className={isEmbeddedBrowserLoading ? 'browser-chat-embedded-tool-button is-stop' : 'browser-chat-embedded-tool-button'}
              disabled={!activeEmbeddedTab}
              onClick={() => void (isEmbeddedBrowserLoading ? stopEmbeddedBrowserLoading() : reloadEmbeddedBrowser())}
              title={isEmbeddedBrowserLoading ? '停止加载' : '重新加载'}
              type="button"
            >
              {isEmbeddedBrowserLoading ? <X size={16} /> : <RefreshCw size={15} />}
            </button>
          </div>
          <form className="browser-chat-embedded-address-bar" onSubmit={navigateEmbeddedBrowserAddress}>
            <span className="browser-chat-embedded-address-icon" aria-hidden="true">
              {addressValue.startsWith('https://') ? <Lock size={14} /> : <Globe size={14} />}
            </span>
            <input
              ref={addressInputRef}
              aria-label="Address"
              disabled={!bridgeAvailable}
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
              aria-expanded={libraryPanel === 'library'}
              aria-label="收藏与历史记录"
              className={libraryPanel === 'library' ? 'browser-chat-embedded-tool-button active' : 'browser-chat-embedded-tool-button'}
              onClick={() => void toggleEmbeddedBrowserLibraryPanel()}
              title="收藏与历史记录"
              type="button"
            >
              <Library size={18} />
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
    {newGroupDialogOpen ? (
      <div className="ui-modal-overlay" onClick={() => {
        if (creatingNewGroup) return;
        setNewGroupDialogOpen(false);
        onDialogOpenChange?.(false);
      }} role="presentation">
        <form
          className="ui-modal ui-modal--compact"
          onClick={(event) => event.stopPropagation()}
          onSubmit={(event) => {
            event.preventDefault();
            void createEmbeddedBrowserGroup();
          }}
          role="dialog"
          aria-label="新建浏览器标签组"
        >
          <header className="ui-modal-header">
            <div className="ui-modal-heading">
              <h2 className="ui-modal-title">新建标签组</h2>
              <p className="ui-modal-subtitle">标签组可在对话工具栏中单独绑定。</p>
            </div>
            <button
              aria-label="关闭"
              className="ui-icon-button ui-modal-close"
              disabled={creatingNewGroup}
              onClick={() => {
                setNewGroupDialogOpen(false);
                onDialogOpenChange?.(false);
              }}
              type="button"
            >
              <X size={18} />
            </button>
          </header>
          <div className="ui-modal-body">
            <label className="modal-field">
              标签组名称
              <input
                autoFocus
                className="input"
                disabled={creatingNewGroup}
                onChange={(event) => setNewGroupName(event.target.value)}
                value={newGroupName}
              />
            </label>
          </div>
          <footer className="ui-modal-footer">
            <button className="ui-button ui-button--primary" disabled={creatingNewGroup} type="submit">
              {creatingNewGroup ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}
              {creatingNewGroup ? '创建中…' : '创建并绑定'}
            </button>
          </footer>
        </form>
      </div>
    ) : null}
    </>
  );
});

export function BrowserChatWorkspace({
  initialView = 'chat',
  initialSettings,
}: {
  initialView?: BrowserChatView;
  initialSettings?: EnvironmentSettingsInitialData;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requestUserId = searchParams.get('userId')?.trim() || searchParams.get('qzUserId')?.trim() || '0';
  const requestedSessionId = searchParams.get('sessionId')?.trim() || '';
  const visibleSettingsTabs = environmentSettingsTabsForUser(requestUserId);
  const browserChatApiUrl = useCallback((path: string) => (
    `${withWebPilotBasePath(path)}${path.includes('?') ? '&' : '?'}userId=${encodeURIComponent(requestUserId)}`
  ), [requestUserId]);
  const { t } = useI18n();
  const { mode: themeMode, toggleMode } = useTheme();
  const initialModelSelection = resolveRuntimeModelSelection(null);
  const sendingRef = useRef(false);
  const loadingSessionRef = useRef<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const embeddedWorkspaceRef = useRef<HTMLDivElement | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const mountedSessionActivationRef = useRef('');
  const sessionVersionsRef = useRef(new Map<string, number>());
  const sessionRefreshTimersRef = useRef(new Map<string, number>());
  const sessionListRefreshTimerRef = useRef<number | undefined>(undefined);
  const interruptRequestSequenceRef = useRef(0);
  const activeView = browserChatViewForPathname(pathname, initialView);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [session, setSession] = useState<BrowserChatSession | null>(null);
  const [sessions, setSessions] = useState<BrowserChatSession[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [mode, setMode] = useState<BrowserChatMode>('dom');
  const [safetyMode, setSafetyMode] = useState<BrowserChatSafetyMode>('strict');
  const [modelProvider, setModelProvider] = useState<ModelProvider>(() => initialModelSelection.provider);
  const [modelId, setModelId] = useState(() => initialModelSelection.model);
  const [modelConfig, setModelConfig] = useState<BrowserChatModelConfig | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const activeSettingsTab = visibleSettingsTabs.some((tab) => tab.id === settingsTab) ? settingsTab : 'general';
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
  const [deletingSessionIds, setDeletingSessionIds] = useState<Set<string>>(() => new Set());
  const deletingSessionIdsRef = useRef(new Set<string>());
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
  const [resumingHumanVerification, setResumingHumanVerification] = useState(false);
  const [imagePreview, setImagePreview] = useState<BrowserChatAttachment | null>(null);
  const [error, setError] = useState('');
  const [downloads, setDownloads] = useState<SystemDownloadItem[]>([]);
  const removedDownloadIdsRef = useRef(new Set<string>());
  const [downloadCenterOpen, setDownloadCenterOpen] = useState(false);
  const [browserGroupPickerOpen, setBrowserGroupPickerOpen] = useState(false);
  const [embeddedBrowserDialogOpen, setEmbeddedBrowserDialogOpen] = useState(false);
  const [webPreviewRuntime, setWebPreviewRuntime] = useState(false);
  const [webPreviewOpen, setWebPreviewOpen] = useState(false);
  const selectedSessionRunning = isBrowserChatSessionRunning(session);
  const selectedRunningSession = selectedSessionRunning ? session : undefined;
  const currentBusy = busy || selectedSessionRunning || interrupting;
  const interruptSessionId = selectedRunningSession?.id || (busy ? pendingMessageSessionId || session?.id : undefined);
  const canInterruptConversation = Boolean(interruptSessionId && (busy || selectedSessionRunning));
  const modeLocked = Boolean(session && session.status !== 'closed' && (session.messages.length || session.steps.length || selectedSessionRunning));
  const messages = useMemo(() => session?.messages || [], [session?.messages]);
  const steps = useMemo(() => session?.steps || [], [session?.steps]);
  const logs = useMemo(() => session?.logs || [], [session?.logs]);
  const liveToolDialog = useMemo(() => {
    if (!toolDialog) return null;
    const expectedSignature = toolInputSignature(toolDialog.tool.input);
    const indexedStep = steps.find((step) => step.index === toolDialog.stepIndex);
    const indexedTool = indexedStep?.tools?.[toolDialog.toolIndex];
    if (indexedStep && indexedTool?.name === toolDialog.tool.name
      && toolInputSignature(indexedTool.input) === expectedSignature) {
      return { ...toolDialog, step: indexedStep, tool: indexedTool };
    }
    for (const step of steps) {
      const toolIndex = (step.tools || []).findIndex((tool) => (
        tool.name === toolDialog.tool.name && toolInputSignature(tool.input) === expectedSignature
      ));
      if (toolIndex >= 0) {
        return { stepIndex: step.index, step, toolIndex, tool: step.tools![toolIndex]! };
      }
    }
    return toolDialog;
  }, [steps, toolDialog]);
  const visibleMessages = messages;
  const lastAssistantMessageId = useMemo(
    () => [...visibleMessages].reverse().find((item) => item.role === 'assistant')?.id,
    [visibleMessages],
  );
  const browserActivationRequestId = useMemo(() => {
    if (!selectedSessionRunning || !lastAssistantMessageId) return '';
    return [...logs].reverse().find((log) => (
      log.messageId === lastAssistantMessageId
      && (log.phase === 'browser:start' || log.phase === 'browser:reuse')
    ))?.id || '';
  }, [lastAssistantMessageId, logs, selectedSessionRunning]);
  const hasMessages = visibleMessages.length > 0;
  const hasChatContent = hasMessages;
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
    setWebPreviewRuntime(!window.webPilotEmbeddedBrowser);
  }, []);

  useEffect(() => {
    setWebPreviewOpen(false);
  }, [session?.id]);

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
      if (!download?.id || removedDownloadIdsRef.current.has(download.id)) return;
      setDownloads((current) => {
        const next = [download, ...current.filter((item) => item.id !== download.id)];
        return next.sort((left, right) => Number(right.startedAt || right.updatedAt || 0) - Number(left.startedAt || left.updatedAt || 0));
      });
    };
    bridge.getDownloads?.()
      .then((result) => {
        if (!mounted || !result?.ok || !Array.isArray(result.downloads)) return;
        setDownloads(result.downloads.filter((download) => !removedDownloadIdsRef.current.has(download.id)));
      })
      .catch(() => undefined);
    const unsubscribeProgress = bridge.onDownloadProgress?.(applyDownload);
    const unsubscribeRemoved = bridge.onDownloadRemoved?.(({ id }) => {
      if (!id) return;
      removedDownloadIdsRef.current.add(id);
      setDownloads((current) => current.filter((download) => download.id !== id));
    });
    return () => {
      mounted = false;
      unsubscribeProgress?.();
      unsubscribeRemoved?.();
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
  const addTabReference = useCallback((reference: BrowserChatAttachment) => {
    addReferenceAttachments([reference]);
  }, [addReferenceAttachments]);
  const showMessageLogs = useCallback((messageId: string) => {
    setLogDialogMessageId(messageId);
    const sessionId = activeSessionIdRef.current;
    if (!sessionId || fullLogSessionIdsRef.current.has(sessionId)) return;
    fullLogSessionIdsRef.current.add(sessionId);
    void fetch(browserChatApiUrl(`/api/browser-chat/${sessionId}/logs`), { cache: 'no-store' })
      .then((response) => readApiJson<{ logs?: BrowserChatLogRecord[] }>(response, '加载对话日志失败'))
      .then((data) => {
        if (!Array.isArray(data.logs)) return;
        setSession((current) => current?.id === sessionId ? { ...current, logs: data.logs || [] } : current);
      })
      .catch(() => {
        fullLogSessionIdsRef.current.delete(sessionId);
      });
  }, [browserChatApiUrl]);
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
  const embeddedBrowserCovered = Boolean(toolDialog || logDialogMessageId || imagePreview || embeddedBrowserDialogOpen);
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
  const toggleDownloadCenter = useCallback(() => {
    setBrowserGroupPickerOpen(false);
    setDownloadCenterOpen((current) => !current);
  }, []);

  const toggleBrowserGroupPicker = useCallback(() => {
    setDownloadCenterOpen(false);
    setBrowserGroupPickerOpen((current) => !current);
  }, []);

  const changeModelSelection = useCallback((selection: { provider: ModelProvider; model: string }) => {
    const next = resolveRuntimeModelSelection(modelConfig, selection);
    setModelProvider(next.provider);
    setModelId(next.model);

    const providerConfig = modelConfig?.providers[next.provider];
    if (!modelConfig || !providerConfig) return;
    const nextConfig: BrowserChatModelConfig = {
      ...modelConfig,
      provider: next.provider,
      providers: {
        ...modelConfig.providers,
        [next.provider]: {
          ...providerConfig,
          defaultModel: next.model,
          model: next.model,
          models: Array.from(new Set([...(providerConfig.models || []), next.model])),
        },
      },
    };
    setModelConfig(nextConfig);
    void fetch(withWebPilotBasePath('/api/settings/model'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: nextConfig.provider, providers: nextConfig.providers }),
    })
      .then(async (response) => {
        const data = await readApiJson<Record<string, unknown>>(response, '保存模型选择失败');
        const persisted = normalizeRuntimeModelConfig(data.config as Partial<BrowserChatModelConfig> | undefined);
        if (persisted) setModelConfig(persisted);
      })
      .catch(() => undefined);
  }, [modelConfig]);

  const loadBrowserRuntimeSettings = useCallback(async () => {
    const response = await fetch(withWebPilotBasePath('/api/settings/env'), { cache: 'no-store' });
    const data = await readApiJson<Record<string, unknown>>(response, '加载浏览器配置失败');
    const saved = Array.isArray(data.saved) ? data.saved as Array<{ key?: string; value?: string }> : [];
    const embeddedSetting = saved.find((item) => item.key === 'ELECTRON_EMBEDDED_BROWSER');
    const reasoningSetting = saved.find((item) => item.key === 'BROWSER_CHAT_SHOW_REASONING');
    setEmbeddedBrowserEnabled(embeddedSetting?.value === 'true');
    setShowReasoning(reasoningSetting?.value === 'true');
  }, []);

  const loadSkills = useCallback(async () => {
    const response = await fetch(browserChatApiUrl('/api/skills'), { cache: 'no-store' });
    const data = await readApiJson<Record<string, unknown>>(response, '加载 Skills 失败');
    setSkills(Array.isArray(data.skills) ? data.skills : []);
  }, [browserChatApiUrl]);

  const loadModelConfig = useCallback(async () => {
    const response = await fetch(withWebPilotBasePath('/api/settings/model'), { cache: 'no-store' });
    const data = await readApiJson<Record<string, unknown>>(response, '加载模型配置失败');
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

  const refreshSession = useCallback(async (sessionId: string, options: { activate?: boolean } = {}) => {
    const response = await fetch(browserChatApiUrl(`/api/browser-chat/${sessionId}`), { cache: 'no-store' });
    const data = await readApiJson<Record<string, unknown>>(response, '加载对话失败');
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
  }, [browserChatApiUrl, modelConfig, upsertSession]);

  const activateSession = useCallback(async (sessionId: string) => {
    if (loadingSessionRef.current === sessionId) return undefined;
    loadingSessionRef.current = sessionId;
    activeSessionIdRef.current = sessionId;
    setLoadingSessionId(sessionId);
    try {
      return await refreshSession(sessionId, { activate: true });
    } finally {
      if (loadingSessionRef.current === sessionId) {
        loadingSessionRef.current = null;
        setLoadingSessionId(null);
      }
    }
  }, [refreshSession]);

  const loadSessions = useCallback(async () => {
    const response = await fetch(browserChatApiUrl('/api/browser-chat'), { cache: 'no-store' });
    const data = await readApiJson<Record<string, unknown>>(response, '加载对话历史失败');
    const nextSessions = Array.isArray(data.sessions) ? data.sessions.map((item: BrowserChatSession) => normalizeSession(item)) : [];
    setSessions(nextSessions);
    await loadRequestedBrowserChatSessionDetail(nextSessions, requestedSessionId, async (requestedSession) => {
      if (mountedSessionActivationRef.current === requestedSession.id) return;
      mountedSessionActivationRef.current = requestedSession.id;
      try {
        await activateSession(requestedSession.id);
      } catch (loadError) {
        if (mountedSessionActivationRef.current === requestedSession.id) mountedSessionActivationRef.current = '';
        throw loadError;
      }
    });
  }, [activateSession, browserChatApiUrl, requestedSessionId]);

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

  async function createSession() {
    const response = await fetch(browserChatApiUrl('/api/browser-chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ safetyMode, modelProvider, model: modelId, userId: requestUserId }),
    });
    const data = await readApiJson<Record<string, unknown>>(response, '创建对话会话失败');
    return upsertSession(data.session as BrowserChatSession, { activate: true });
  }

  async function ensureSession() {
    if (session && session.status !== 'closed') return session;
    return createSession();
  }

  async function postMessageToSession(sessionId: string, content: string, clientMessageId: string, nextAttachments: BrowserChatAttachment[], skillIds: string[]) {
    const response = await fetch(browserChatApiUrl(`/api/browser-chat/${sessionId}/message`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachments: nextAttachments, clientMessageId, content, safetyMode, modelProvider, model: modelId, skillIds, userId: requestUserId }),
    });
    const data = await readApiJson<Record<string, unknown>>(response, '发送消息失败');
    return data.session as BrowserChatSession;
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
        const response = await fetch(withWebPilotBasePath('/api/uploads'), { method: 'POST', body: form });
        const data = await readApiJson<Record<string, unknown>>(response, '文件上传失败');
        const fileId = String(data.fileId || data.imageId || temporaryId(file.type.startsWith('image/') ? 'image' : 'file'));
        const kind: BrowserChatAttachmentKind = String(data.type || file.type || '').startsWith('image/') ? 'image' : 'file';
        uploaded.push({
          id: fileId,
          kind,
          name: String(data.name || file.name),
          type: String(data.type || file.type || 'application/octet-stream'),
          size: typeof data.size === 'number' ? data.size : file.size,
          path: String(data.path || `uploads/${fileId}`),
          url: withWebPilotBasePath(String(data.url || `/api/artifacts/uploads/${encodeURIComponent(fileId)}`)),
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
    try {
      let active = await ensureSession();
      setPendingMessageSessionId(active.id);
      let posted: BrowserChatSession;
      try {
        posted = await postMessageToSession(active.id, trimmedContent, clientMessageId, nextAttachments, skillIds);
      } catch (firstError) {
        const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
        if (!/Browser chat session not found/i.test(firstMessage)) throw firstError;
        active = await createSession();
        setPendingMessageSessionId(active.id);
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
    const timestamp = new Date().toISOString();
    setBusy(false);
    setPendingMessageSessionId((current) => current === targetId ? null : current);
    setSession((current) => current?.id === targetId
      ? interruptBrowserChatSessionOptimistically(current, timestamp)
      : current);
    setSessions((current) => current.map((item) => item.id === targetId
      ? interruptBrowserChatSessionOptimistically(item, timestamp)
      : item));
    const interruptRequestSequence = ++interruptRequestSequenceRef.current;
    const releaseInterrupting = () => {
      if (interruptRequestSequenceRef.current === interruptRequestSequence) setInterrupting(false);
    };
    const releaseLoadingTimer = window.setTimeout(releaseInterrupting, 400);
    const requestController = new AbortController();
    const requestTimeout = window.setTimeout(() => requestController.abort(), 5000);
    try {
      const response = await fetch(browserChatApiUrl(`/api/browser-chat/${targetId}/interrupt`), {
        method: 'POST',
        signal: requestController.signal,
      });
      const data = await readApiJson<Record<string, unknown>>(response, '中断对话失败');
      upsertSession(data.session as BrowserChatSession, { activate: activeSessionIdRef.current === targetId });
      setBusy(false);
      setPendingMessageSessionId((current) => current === targetId ? null : current);
    } catch (interruptError) {
      if (!requestController.signal.aborted) {
        setError(interruptError instanceof Error ? interruptError.message : '中断对话失败');
      }
      await refreshSession(targetId, { activate: activeSessionIdRef.current === targetId }).catch(() => undefined);
    } finally {
      window.clearTimeout(releaseLoadingTimer);
      window.clearTimeout(requestTimeout);
      releaseInterrupting();
    }
  }

  async function resolveToolConfirmation(confirmationId: string, action: BrowserChatToolConfirmationAction) {
    const sessionId = session?.id;
    if (!sessionId || resolvingConfirmationId) return;
    setResolvingConfirmationId(confirmationId);
    setResolvingConfirmationAction(action);
    setError('');
    try {
      const response = await fetch(browserChatApiUrl(`/api/browser-chat/${sessionId}/tool-confirmation`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, confirmationId, userId: requestUserId }),
      });
      const data = await readApiJson<Record<string, unknown>>(response, '工具确认失败');
      upsertSession(data.session as BrowserChatSession, { activate: activeSessionIdRef.current === sessionId });
      scheduleSessionRefresh(sessionId, 120);
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : '工具确认失败');
    } finally {
      setResolvingConfirmationId(null);
      setResolvingConfirmationAction(null);
    }
  }

  async function resumeHumanVerification() {
    const active = session;
    if (!active?.id || currentBusy || resumingHumanVerification) return;
    setResumingHumanVerification(true);
    setError('');
    try {
      const response = await fetch(browserChatApiUrl(`/api/browser-chat/${active.id}/resume-verification`), { method: 'POST' });
      const data = await readApiJson<{ session: BrowserChatSession }>(response, '继续人工校验回合失败');
      upsertSession(data.session, { activate: true });
      scheduleSessionRefresh(active.id, 120);
    } catch (resumeError) {
      setError(resumeError instanceof Error ? resumeError.message : '继续人工校验回合失败');
    } finally {
      setResumingHumanVerification(false);
    }
  }

  async function closeSession() {
    if (!session || busy) return;
    setBusy(true);
    startGlobalLoading('正在结束浏览器对话');
    try {
      const response = await fetch(browserChatApiUrl(`/api/browser-chat/${session.id}`), { method: 'DELETE' });
      if (response.ok) {
        const data = await readApiJson<{ session: BrowserChatSession }>(response, '结束浏览器对话失败');
        upsertSession(data.session, { activate: true });
        await discardEmbeddedBrowserDataForSessions([session], { includeSessionGroups: false });
        await loadSessions().catch(() => undefined);
      }
    } finally {
      setBusy(false);
      stopGlobalLoading();
    }
  }

  async function deleteSessionHistory(sessionId: string) {
    if (deletingSessionIdsRef.current.has(sessionId) || deletingSelectedSessions) return;
    deletingSessionIdsRef.current.add(sessionId);
    setDeletingSessionIds((current) => new Set(current).add(sessionId));
    setError('');
    const deletedSession = sessions.find((item) => item.id === sessionId)
      || (session?.id === sessionId ? session : undefined);
    try {
      const response = await fetch(browserChatApiUrl(`/api/browser-chat/${sessionId}/delete`), { method: 'POST' });
      await readApiJson<Record<string, unknown>>(response, '删除历史对话失败');
      setSessions((current) => current.filter((item) => item.id !== sessionId));
      setSelectedSessionIds((current) => current.filter((id) => id !== sessionId));
      if (session?.id === sessionId) setSession(null);
      if (deletedSession) await discardEmbeddedBrowserDataForSessions([deletedSession]);
      await loadSessions().catch(() => undefined);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除历史对话失败');
    } finally {
      deletingSessionIdsRef.current.delete(sessionId);
      setDeletingSessionIds((current) => {
        const next = new Set(current);
        next.delete(sessionId);
        return next;
      });
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
    const deletedSessions = sessions.filter((item) => deletingIdSet.has(item.id));
    setDeletingSelectedSessions(true);
    setError('');
    try {
      const response = await fetch(browserChatApiUrl('/api/browser-chat/delete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: deletingIds, userId: requestUserId }),
      });
      await readApiJson<Record<string, unknown>>(response, '批量删除历史对话失败');
      setSessions((current) => current.filter((item) => !deletingIdSet.has(item.id)));
      setSelectedSessionIds((current) => current.filter((id) => !deletingIdSet.has(id)));
      if (session?.id && deletingIdSet.has(session.id)) setSession(null);
      await discardEmbeddedBrowserDataForSessions(deletedSessions);
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
    router.push(`/dashboard?caseId=${encodeURIComponent(testCaseId)}`);
  }, [router]);

  const exportSelectedMessagesToTestCase = useCallback(async () => {
    const sessionId = session?.id;
    if (!sessionId || !selectedExportMessageIds.length || exportingMessageId || exportingSelectedMessages || generatingSkillMessageId || generatingSkillSelectedMessages) return;
    const messageIds = selectedExportMessageIds;
    setExportingSelectedMessages(true);
    setError('');
    startGlobalLoading('正在导出选中对话轮次');
    try {
      const response = await fetch(browserChatApiUrl(`/api/browser-chat/${sessionId}/export`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageIds }),
      });
      const data = await readApiJson<Record<string, unknown>>(response, '导出测试用例失败');
      setSelectedExportMessageIds([]);
      if (typeof data.testCaseId === 'string') openTargetCaseDetail(data.testCaseId);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : '导出测试用例失败');
    } finally {
      setExportingSelectedMessages(false);
      stopGlobalLoading();
    }
  }, [browserChatApiUrl, exportingMessageId, exportingSelectedMessages, generatingSkillMessageId, generatingSkillSelectedMessages, openTargetCaseDetail, selectedExportMessageIds, session?.id]);

  const exportMessageToTestCase = useCallback(async (messageId: string) => {
    const sessionId = session?.id;
    if (!sessionId || exportingMessageId || exportingSelectedMessages || generatingSkillMessageId || generatingSkillSelectedMessages) return;
    setExportingMessageId(messageId);
    setError('');
    try {
      const response = await fetch(browserChatApiUrl(`/api/browser-chat/${sessionId}/export`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId }),
      });
      const data = await readApiJson<Record<string, unknown>>(response, '导出测试用例失败');
      if (typeof data.testCaseId === 'string') openTargetCaseDetail(data.testCaseId);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : '导出测试用例失败');
    } finally {
      setExportingMessageId(null);
    }
  }, [browserChatApiUrl, exportingMessageId, exportingSelectedMessages, generatingSkillMessageId, generatingSkillSelectedMessages, openTargetCaseDetail, session?.id]);

  const generateSelectedMessagesSkill = useCallback(async () => {
    const sessionId = session?.id;
    if (!sessionId || !selectedExportMessageIds.length || exportingMessageId || exportingSelectedMessages || generatingSkillMessageId || generatingSkillSelectedMessages) return;
    const messageIds = selectedExportMessageIds;
    setGeneratingSkillSelectedMessages(true);
    setError('');
    startGlobalLoading('正在生成 Skill');
    try {
      const response = await fetch(browserChatApiUrl(`/api/browser-chat/${sessionId}/skills`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageIds }),
      });
      await readApiJson<Record<string, unknown>>(response, '生成 Skill 失败');
      setSelectedExportMessageIds([]);
      await loadSkills();
    } catch (skillError) {
      setError(skillError instanceof Error ? skillError.message : '生成 Skill 失败');
    } finally {
      setGeneratingSkillSelectedMessages(false);
      stopGlobalLoading();
    }
  }, [browserChatApiUrl, exportingMessageId, exportingSelectedMessages, generatingSkillMessageId, generatingSkillSelectedMessages, loadSkills, selectedExportMessageIds, session?.id]);

  const generateMessageSkill = useCallback(async (messageId: string) => {
    const sessionId = session?.id;
    if (!sessionId || exportingMessageId || exportingSelectedMessages || generatingSkillMessageId || generatingSkillSelectedMessages) return;
    setGeneratingSkillMessageId(messageId);
    setError('');
    startGlobalLoading('正在生成 Skill');
    try {
      const response = await fetch(browserChatApiUrl(`/api/browser-chat/${sessionId}/skills`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId }),
      });
      await readApiJson<Record<string, unknown>>(response, '生成 Skill 失败');
      await loadSkills();
    } catch (skillError) {
      setError(skillError instanceof Error ? skillError.message : '生成 Skill 失败');
    } finally {
      setGeneratingSkillMessageId(null);
      stopGlobalLoading();
    }
  }, [browserChatApiUrl, exportingMessageId, exportingSelectedMessages, generatingSkillMessageId, generatingSkillSelectedMessages, loadSkills, session?.id]);

  async function startNewConversation() {
    if (loadingSessionId) return;
    setError('');
    setComposerResetToken((current) => current + 1);
    attachmentsRef.current = [];
    setAttachments([]);
    setSession(null);
  }

  async function loadSession(sessionId: string) {
    if (loadingSessionRef.current === sessionId) return;
    setError('');
    setComposerResetToken((current) => current + 1);
    attachmentsRef.current = [];
    setAttachments([]);
    try {
      await activateSession(sessionId);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载对话失败');
      void loadSessions().catch(() => undefined);
    }
  }

  function renderSidebarDetail() {
    if (activeView === 'settings') {
      return (
        <section className="browser-chat-sidebar-section browser-chat-settings-section">
          <h2>设置</h2>
          <nav className="browser-chat-subnav" aria-label="环境配置分类">
            {visibleSettingsTabs.map((tab) => (
              <button aria-label={tab.label} className={activeSettingsTab === tab.id ? 'active' : undefined} key={tab.id} onClick={() => setSettingsTab(tab.id)} title={tab.label} type="button">
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
              disabled={Boolean(loadingSessionId)}
              onClick={() => void startNewConversation()}
              title={t('新建对话')}
              type="button"
            >
              <Plus size={16} />
            </button>
            {recentSelectionMode ? (
              <button
                aria-label={`删除已选对话（${selectedDeletableSessionIds.length}）`}
                className="ui-icon-button ui-icon-button--danger browser-chat-section-create"
                disabled={!selectedDeletableSessionIds.length || deletingSelectedSessions}
                onClick={() => void deleteSelectedSessionHistory()}
                title={selectedDeletableSessionIds.length ? `删除已选对话（${selectedDeletableSessionIds.length}）` : '请选择要删除的对话'}
                type="button"
              >
                {deletingSelectedSessions ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
              </button>
            ) : null}
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
              </div>
            </details>
          </div>
        </div>
        <button
          aria-label={t('新建对话')}
          className="ui-button ui-button--neutral browser-chat-new-chat-button"
          disabled={Boolean(loadingSessionId)}
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
                    aria-label={sessionDisplayTitle(item)}
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
                      {deletingSessionIds.has(item.id) ? <Loader2 className="spin" size={13} /> : <MoreHorizontal size={16} />}
                    </summary>
                    <div className="browser-chat-overflow-menu">
                      <button
                        className="danger"
                        disabled={item.busy || deletingSessionIds.has(item.id) || deletingSelectedSessions}
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

  async function assignBrowserGroup(browserGroupId: string) {
    if (!session?.id) return;
    if (session.browserGroupId === browserGroupId) {
      setBrowserGroupPickerOpen(false);
      return;
    }
    const previous = session;
    upsertSession({ ...session, browserGroupId }, { activate: true });
    try {
      const response = await fetch(browserChatApiUrl(`/api/browser-chat/${session.id}/group`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId: browserGroupId }),
      });
      const data = await readApiJson<Record<string, unknown>>(response, '设置对话标签组失败');
      upsertSession(data.session as BrowserChatSession, { activate: true });
      setBrowserGroupPickerOpen(false);
    } catch (assignError) {
      upsertSession(previous, { activate: true });
      throw assignError;
    }
  }

  const renderChatPaneActions = () => (
    <div className="browser-chat-pane-actions">
      {webPreviewRuntime && session ? (
        <button
          aria-label="打开实时界面"
          className="browser-chat-web-preview-button"
          disabled={session.status === 'closed'}
          onClick={() => setWebPreviewOpen(true)}
          title={session.status === 'closed' ? '当前对话已结束' : '打开实时界面'}
          type="button"
        >
          <AppWindow size={17} />
        </button>
      ) : null}
      {session ? (
        <button className="browser-chat-close" disabled={session.status === 'closed' || currentBusy} onClick={closeSession} title="结束会话" type="button">
          <Power size={17} />
        </button>
      ) : null}
      {!webPreviewRuntime ? (
        <>
          <BrowserChatGroupBindingCenter
            disabled={!session?.id}
            groupId={session?.browserGroupId}
            onClose={() => setBrowserGroupPickerOpen(false)}
            onSelect={assignBrowserGroup}
            onToggle={toggleBrowserGroupPicker}
            open={browserGroupPickerOpen}
          />
          <BrowserChatDownloadCenter
            downloads={downloads}
            open={downloadCenterOpen}
            onClose={() => setDownloadCenterOpen(false)}
            onRemove={(id) => {
              removedDownloadIdsRef.current.add(id);
              setDownloads((current) => current.filter((download) => download.id !== id));
            }}
            onToggle={toggleDownloadCenter}
          />
        </>
      ) : null}
    </div>
  );

  const renderChatPane = () => (
    <div className={`${hasChatContent ? 'browser-chat-chat-pane has-messages' : 'browser-chat-chat-pane'}${embeddedBrowserActive ? ' embedded-chat' : ''}`} style={chatPaneStyle}>
      {renderChatPaneActions()}

      {loadingSessionId ? <BrowserChatSessionLoading label={t('正在加载对话')} /> : hasMessages ? (
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
          onResumeHumanVerification={resumeHumanVerification}
          onSelectTool={setToolDialog}
          onShowLogs={showMessageLogs}
          onToggleExportSelection={toggleExportMessageSelection}
          pendingToolConfirmation={session?.pendingToolConfirmation}
          resolvingConfirmationAction={resolvingConfirmationAction}
          resolvingConfirmationId={resolvingConfirmationId}
          resumingHumanVerification={resumingHumanVerification}
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
          <strong>WebPilot</strong>
          <button
            className="ui-icon-button"
            onClick={toggleSidebarCollapsed}
            title={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
            type="button"
            aria-label={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
          >
            <PanelLeft size={17} />
          </button>
        </div>

        <nav className="browser-chat-nav" aria-label="工作模式">
          <button
            aria-current={activeView === 'chat' ? 'page' : undefined}
            aria-label={t('对话模式')}
            className={activeView === 'chat' ? 'browser-chat-nav-item active' : 'browser-chat-nav-item'}
            onClick={() => navigateBrowserChatView('/browser-chat')}
            title={t('对话模式')}
            type="button"
          >
            <MessageSquare size={17} />
            <span>{t('对话模式')}</span>
          </button>
          <button aria-current={activeView === 'settings' ? 'page' : undefined} aria-label="设置" className={activeView === 'settings' ? 'browser-chat-nav-item active' : 'browser-chat-nav-item'} onClick={() => navigateBrowserChatView('/settings')} title="设置" type="button">
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
        {activeView === 'settings' ? (
          <div className="browser-chat-settings-pane">
            <EnvironmentSettings
              activeTab={activeSettingsTab}
              embedded
              initialData={initialSettings}
              showTabs={false}
              onActiveTabChange={setSettingsTab}
              onModelSaved={() => void loadModelConfig()}
              onRuntimeEnvSaved={() => void loadBrowserRuntimeSettings()}
              onSkillsChanged={() => void loadSkills()}
              userId={requestUserId}
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
              activationRequestId={browserActivationRequestId}
              browserGroupId={session?.browserGroupId}
              enabled={embeddedBrowserEnabled}
              onAddTabReference={addTabReference}
              onDialogOpenChange={setEmbeddedBrowserDialogOpen}
              onSelectSession={(nextSessionId) => {
                const owner = sessions.find((item) => (
                  item.id === nextSessionId
                ));
                const ownerSessionId = owner?.id || nextSessionId;
                if (ownerSessionId && ownerSessionId !== activeSessionIdRef.current) void loadSession(ownerSessionId);
              }}
              sessionId={session?.id}
              userId={session?.userId || '0'}
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
          <div className={hasChatContent ? 'browser-chat-chat-pane has-messages' : 'browser-chat-chat-pane'} style={chatPaneStyle}>
            {renderChatPaneActions()}

            {loadingSessionId ? <BrowserChatSessionLoading label={t('正在加载对话')} /> : hasMessages ? (
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
                onResumeHumanVerification={resumeHumanVerification}
                onSelectTool={setToolDialog}
                onShowLogs={showMessageLogs}
                onToggleExportSelection={toggleExportMessageSelection}
                pendingToolConfirmation={session?.pendingToolConfirmation}
                resolvingConfirmationAction={resolvingConfirmationAction}
                resolvingConfirmationId={resolvingConfirmationId}
                resumingHumanVerification={resumingHumanVerification}
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

      {webPreviewRuntime && webPreviewOpen && session ? (
        <BrowserChatWebPreviewModal
          onClose={() => setWebPreviewOpen(false)}
          sessionId={session.id}
          userId={session.userId || requestUserId}
        />
      ) : null}

      {liveToolDialog ? (
        <BrowserChatToolDialog
          detail={liveToolDialog}
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

    </section>
    </BrowserChatReasoningVisibilityContext.Provider>
  );
}
