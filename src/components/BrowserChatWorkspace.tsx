'use client';

import { createContext, memo, type ClipboardEvent as ReactClipboardEvent, type CSSProperties, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, type WheelEvent as ReactWheelEvent, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
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
import { Button, Checkbox, Popover, TextArea } from '@heroui/react';
import dynamic from 'next/dynamic';
import {
  AppWindow,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Brain,
  Braces,
  Bug,
  Check,
  CircleAlert,
  Clock3,
  ChevronDown,
  ClipboardCheck,
  Compass,
  CornerDownLeft,
  CheckCircle2,
  Download,
  FileOutput,
  FilePlus2,
  FileSearch,
  FileText,
  Folder,
  FolderOpen,
  Gauge,
  Globe,
  ImageIcon,
  ImageUp,
  KeyRound,
  Library,
  Loader2,
  Lock,
  MessageSquare,
  MoreHorizontal,
  MousePointer2,
  Network,
  PanelLeftClose,
  PanelRight,
  Paperclip,
  PencilLine,
  Pin,
  Plus,
  Power,
  RefreshCw,
  Route,
  ScanSearch,
  ScrollText,
  SendHorizontal,
  Share2,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SquareArrowOutUpRight,
  Square,
  Star,
  Trash2,
  Volume2,
  VolumeX,
  Waypoints,
  Workflow,
  X,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { CustomSelect } from '@/components/CustomSelect';
import { ConfirmDeleteModal } from '@/components/ConfirmDeleteModal';
import { useEscapeDismiss } from '@/hooks/useEscapeDismiss';
import { AppModal } from '@/components/ui/app-modal';
import { AppInput } from '@/components/ui/app-input';
import { AnimatedShinyText } from '@/components/ui/animated-shiny-text';
import {
  browserChatDownloadPercent,
  browserChatDownloadStatusLabel,
  formatDownloadBytes,
  type SystemDownloadItem,
} from '@/components/browser-chat-download-model';
import {
  browserChatHasEarlierMessages,
  browserChatReachedHistoryTop,
  mergeBrowserChatHistoryChunkData,
  mergeBrowserChatSessionWindowData,
  normalizeBrowserChatHistory,
  type BrowserChatHistoryState,
} from '@/components/browser-chat-history-controller';
import { browserChatSubagentRecordsForToolCall } from '@/components/browser-chat-subagent-model';
import {
  normalizeBrowserChatMarkdown,
  remarkBrowserChatCjkStrong,
} from '@/components/browser-chat-markdown';
import { browserChatGenerationPreviewText } from '@/components/browser-chat-message-generation-preview';
import {
  mergeBrowserChatRealtimeCollections,
  mergeBrowserChatRealtimeRecords,
  parseBrowserChatRealtimePatch,
} from '@/components/browser-chat-realtime-model';
import { parseJsonObjectText, stripAnsiControlCodes } from '@/components/browser-chat-format';
import { browserChatToolValidationSummary } from '@/components/browser-chat-tool-error';
import {
  browserChatFileToolPresentation,
  type BrowserChatFileToolPresentationKey,
} from '@/components/browser-chat-file-tool-presentation';
import {
  resolveEmbeddedBrowserTabLayout,
  resolveEmbeddedBrowserWheelScrollLeft,
  type EmbeddedBrowserTabDensity,
} from '@/components/embedded-browser-tab-layout';
import { WorkspaceModeTabs, WorkspaceSidebar } from '@/components/WorkspaceSidebar';
import {
  WorkspaceSidebarArchiveFilter,
  WorkspaceSidebarArchiveHeader,
  WorkspaceHistoryList,
  WorkspaceSidebarArchiveRow,
} from '@/components/WorkspaceSidebarArchive';
import { WorkspaceOverflowMenu } from '@/components/WorkspaceOverflowMenu';
import { BrowserChatOnboarding } from '@/components/BrowserChatOnboarding';
import { BeautifulLoadingState } from '@/components/BeautifulLoadingState';
import { useFilePreview } from '@/components/FilePreviewProvider';
import {
  useBrowserChatSkillCatalog,
  type BrowserChatSkillListPage,
} from '@/components/useBrowserChatSkillCatalog';
import {
  useBrowserChatSessionPagination,
  type BrowserChatSessionListPage,
} from '@/components/useBrowserChatSessionPagination';
import { useBrowserChatRealtime } from '@/components/useBrowserChatRealtime';
import {
  readSidebarCollapsedPreference,
  writeSidebarCollapsedPreference,
} from '@/lib/sidebar-collapse';
import { sortBrowserChatAiOutputCycles } from '@/lib/browser-chat-output-cycles';
import {
  browserChatArtifactExtension,
  browserChatArtifactFileName,
  browserChatArtifactIsImage,
  browserChatScreenshotIsInternalDocumentPreview,
  type BrowserChatArtifactSummary,
} from '@/lib/browser-chat-artifacts';
import { LiquidGlassLoader } from '@/components/LiquidGlassLoader';
import { AnimatedCircularProgressBar } from '@/components/ui/animated-circular-progress-bar';
import { BlurFade } from '@/components/ui/blur-fade';
import { BorderBeam } from '@/components/ui/border-beam';
import { NumberTicker } from '@/components/ui/number-ticker';
import { ProgressiveBlur } from '@/components/ui/progressive-blur';
import { RainbowButton } from '@/components/ui/rainbow-button';
import {
  browserChatAiCycleAnchorsText,
  browserChatAssistantMessageHasExecutionMetadata,
  browserChatMessageElapsedMs,
  browserChatMessageIsTextStreaming,
  browserChatTerminalAnswerCycleIndex,
  buildBrowserChatAiCycleRenderEntries,
  buildBrowserChatLogIndex,
  buildBrowserChatMessageRenderEntries,
  browserChatAssistantMessageHasVisibleText as modelBrowserChatAssistantMessageHasVisibleText,
  browserChatLogsForMessage,
  formatBrowserChatElapsedTime,
  isBrowserChatManualVerificationStatusText,
  type BrowserChatLogIndex as BrowserChatLogIndexModel,
} from '@/components/browser-chat-message-model';
import {
  browserChatSessionNavigationHref,
  compactBrowserChatSessionForList,
  loadRequestedBrowserChatSessionDetail,
  shouldAcceptBrowserChatViewportPosition,
  shouldActivateRequestedBrowserChatSession,
  shouldFinishBrowserChatSessionLoading,
} from '@/components/browser-chat-session-selection';
import {
  visibleBrowserChatExecutionLogs,
} from '@/components/browser-chat-log-model';
import { useI18n } from '@/i18n/I18nProvider';
import { readApiJson } from '@/lib/api-client';
import { browserSessionGroupLabel } from '@/lib/browser-session-group';
import { fuzzyRetrievalScore } from '@/lib/fuzzy-retrieval';
import {
  browserChatSessionDisplayTitle,
  browserChatSessionTitleParts,
} from '@/lib/browser-chat-title';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';
import { waitForMinimumLoading } from '@/lib/minimum-loading';
import { WEBPILOT_ONBOARDING_RESTART_EVENT } from '@/lib/onboarding';
import { asRecord } from '@/lib/unknown-value';
import {
  modelSelectionDiagnosticLabel,
  modelSelectionOptionsForConfig,
  modelSelectionValueForConfig,
  normalizeRuntimeModelConfig,
  parseModelSelectionValue,
  resolveRuntimeModelSelection,
  type RuntimeModelConfig,
} from '@/lib/model-selection';
import { modelCapabilities } from '@/lib/model-capabilities';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';
import { artifactApiUrl } from '@/lib/artifacts';
import { useTheme } from '@/theme/ThemeProvider';
import type {
  BrowserChatAiOutputCycle,
  BrowserChatAiOutputPart,
  BrowserChatAiOutputTool,
  BrowserChatAiOutputView,
  BrowserChatSubagentRecord,
  ModelProvider,
  SkillRecord,
  StepExecutionResult,
} from '@/server/ai/schemas/runtime.schema';

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
  artifacts?: BrowserChatArtifactSummary[];
  activity?: {
    phase: string;
    label: string;
    updatedAt: string;
  };
  status?: 'queued' | 'running' | 'passed' | 'failed' | 'blocked' | 'interrupted';
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
type BrowserChatMessageGenerationKind = 'skill' | 'case';

type BrowserChatMessageGenerationDialog = {
  kind: BrowserChatMessageGenerationKind;
  selectedMessageIds: string[];
  summaryDirection: string;
};

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
  turnId?: string;
  attemptId?: string;
  toolCallId?: string;
};

type BrowserChatLogIndex = BrowserChatLogIndexModel<BrowserChatLogRecord>;

type BrowserChatToolConfirmation = {
  id: string;
  messageId: string;
  subagentId?: string;
  stepIndex?: number;
  toolName: string;
  inputSignature: string;
  reason?: string;
  prompt: string;
  screenshotUrl?: string;
  requestedAt: string;
};

type BrowserChatToolConfirmationAction = 'confirm' | 'cancel';

type BrowserChatSession = {
  id: string;
  userId?: string;
  title: string;
  titleFileName?: string;
  browserGroupId: string;
  targetUrl: string;
  safetyMode: BrowserChatSafetyMode;
  modelProvider: ModelProvider;
  model: string;
  status: 'idle' | 'running' | 'closed' | 'error';
  turnState?: 'idle' | 'running' | 'awaiting_confirmation' | 'awaiting_human' | 'stopping' | 'completed' | 'failed' | 'interrupted' | 'closed';
  busy: boolean;
  hasMessages?: boolean;
  contextUsage?: {
    currentTokens: number;
    imageTokens: number;
    maxTokens: number;
    textTokens: number;
    toolTokens: number;
  };
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  messages: BrowserChatMessage[];
  steps: StepExecutionResult[];
  outputCycles: BrowserChatAiOutputCycle[];
  subagents: BrowserChatSubagentRecord[];
  consoleErrors: string[];
  networkErrors: string[];
  logs: BrowserChatLogRecord[];
  queuedTurns?: Array<{
    id: string;
    userMessageId: string;
    queuedAt: string;
  }>;
  history?: BrowserChatHistoryState;
  pendingToolConfirmation?: BrowserChatToolConfirmation;
  error?: string;
};

type BrowserChatBootstrapData = {
  sessions?: BrowserChatSession[];
  sessionPage?: BrowserChatSessionListPage;
  skills?: SkillRecord[];
  skillPage?: BrowserChatSkillListPage;
  model?: { config?: Partial<BrowserChatModelConfig> };
  runtime?: Array<{ key?: string; value?: string }>;
};

const browserChatInitialRequests = new Map<string, Promise<Record<string, unknown>>>();

function readBrowserChatInitialRequest(url: string, errorMessage: string) {
  const existing = browserChatInitialRequests.get(url);
  if (existing) return existing;
  const request = fetch(url, { cache: 'no-store' })
    .then((response) => readApiJson<Record<string, unknown>>(response, errorMessage))
    .finally(() => browserChatInitialRequests.delete(url));
  browserChatInitialRequests.set(url, request);
  return request;
}

function waitForBrowserPaint() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

type BrowserChatSessionRealtimePatch = {
  session: Omit<BrowserChatSession, 'logs' | 'messages' | 'pendingToolConfirmation' | 'steps'> & {
    pendingToolConfirmation: BrowserChatToolConfirmation | null;
  };
  summary?: BrowserChatSession;
  logs?: BrowserChatLogRecord[];
  messages?: BrowserChatMessage[];
  steps?: StepExecutionResult[];
  removedLogIds?: string[];
  removedMessageIds?: string[];
  removedStepIndexes?: number[];
};

type BrowserChatSafetyMode = 'strict' | 'full';
type BrowserChatModelConfig = RuntimeModelConfig;
type BrowserChatToolCall = NonNullable<StepExecutionResult['tools']>[number];

type BrowserChatRenderableScreenshot = {
  kind?: NonNullable<BrowserChatToolCall['screenshots']>[number]['kind'];
  path: string;
  title: string;
  url: string;
};

type BrowserChatScreenshotPreview = {
  index: number;
  screenshots: BrowserChatRenderableScreenshot[];
};

const BrowserChatScreenshotPreviewContext = createContext<{
  open: (screenshots: BrowserChatRenderableScreenshot[], index?: number) => void;
} | null>(null);

function browserChatRenderableScreenshots(tool: BrowserChatToolCall) {
  const paths = new Set<string>();
  return (tool.screenshots || []).flatMap((screenshot): BrowserChatRenderableScreenshot[] => {
    if (browserChatScreenshotIsInternalDocumentPreview(tool.name, screenshot)) return [];
    const path = screenshot.path?.trim();
    const url = artifactApiUrl(path);
    if (!path || !url || paths.has(path)) return [];
    paths.add(path);
    return [{
      kind: screenshot.kind,
      path,
      title: screenshot.title?.trim() || '截图',
      url,
    }];
  });
}

const BrowserChatLogDialog = dynamic(
  () => import('@/components/BrowserChatLogDialog').then((module) => module.BrowserChatLogDialog),
  { ssr: false },
);
const BrowserChatToolDialog = dynamic(
  () => import('@/components/BrowserChatToolDialog').then((module) => module.BrowserChatToolDialog),
  { ssr: false },
);

const EMBEDDED_CHAT_COLLAPSED_STORAGE_KEY = 'webpilotqa.embeddedChatCollapsed';

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

const browserChatInterruptedReply = '本轮对话已由用户中止。已保留中止前已执行的工具和页面记录。';

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
        ? {
            ...message,
            activity: undefined,
            content: browserChatInterruptedReply,
            status: 'interrupted',
            updatedAt: timestamp,
          }
        : message
    )),
    steps: session.steps.map((step) => (
      step.status === 'queued' || step.status === 'running'
        ? { ...step, status: 'blocked' }
        : step
    )),
  };
}

type BrowserChatInterruptGuard = {
  assistantMessageIds: Set<string>;
  timestamp: string;
};

function applyBrowserChatInterruptGuard(
  session: BrowserChatSession,
  guard: BrowserChatInterruptGuard | undefined,
) {
  if (!guard) return { release: false, session };
  const runningAssistantIds = session.messages
    .filter((message) => message.role === 'assistant' && message.status === 'running')
    .map((message) => message.id);
  if (runningAssistantIds.some((messageId) => !guard.assistantMessageIds.has(messageId))) {
    return { release: true, session };
  }
  return {
    release: false,
    session: isBrowserChatSessionRunning(session)
      ? interruptBrowserChatSessionOptimistically(session, guard.timestamp)
      : session,
  };
}

type BrowserChatToolDetail = {
  confirmationScreenshotUrl?: string;
  stepIndex: number;
  step: StepExecutionResult;
  toolIndex: number;
  tool: BrowserChatToolCall;
};

type BrowserChatMessageRecordPage = {
  history: { cursor?: string; hasMore: boolean };
  logs: BrowserChatLogRecord[];
  outputCycles: BrowserChatAiOutputCycle[];
  steps: StepExecutionResult[];
  subagents: BrowserChatSubagentRecord[];
};

type BrowserChatMessageRecordLoader = (
  messageId: string,
  options?: { cursor?: string; signal?: AbortSignal; subagentsOnly?: boolean },
) => Promise<BrowserChatMessageRecordPage>;

function BrowserChatTransientLogDialog({
  liveEntries,
  loadRecords,
  messageContent,
  messageId,
  onClose,
}: {
  liveEntries: BrowserChatLogRecord[];
  loadRecords: BrowserChatMessageRecordLoader;
  messageContent?: string;
  messageId: string;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<BrowserChatLogRecord[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestRef = useRef<AbortController | null>(null);

  const loadPage = useCallback(async (nextCursor?: string) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    if (nextCursor) setLoadingMore(true);
    else setLoading(true);
    try {
      const page = await loadRecords(messageId, { cursor: nextCursor, signal: controller.signal });
      if (controller.signal.aborted) return;
      setEntries((current) => {
        const records = new Map<string, BrowserChatLogRecord>();
        for (const record of [...page.logs, ...current]) records.set(record.id, record);
        return [...records.values()].sort((left, right) => left.time.localeCompare(right.time));
      });
      setCursor(page.history.cursor);
      setHasMore(page.history.hasMore);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setHasMore(false);
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (!controller.signal.aborted) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [loadRecords, messageId]);

  useEffect(() => {
    setEntries([]);
    setCursor(undefined);
    setHasMore(false);
    void loadPage();
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [loadPage]);

  useEffect(() => {
    if (!liveEntries.length) return;
    setEntries((current) => {
      const records = new Map<string, BrowserChatLogRecord>();
      for (const record of [...current, ...liveEntries]) records.set(record.id, record);
      return [...records.values()].sort((left, right) => left.time.localeCompare(right.time));
    });
  }, [liveEntries]);

  return (
    <BrowserChatLogDialog
      entries={visibleBrowserChatExecutionLogs(entries)}
      hasMore={hasMore}
      loading={loading}
      loadingMore={loadingMore}
      messageContent={messageContent}
      onClose={onClose}
      onLoadMore={cursor ? () => loadPage(cursor) : undefined}
      summaryEntries={entries}
    />
  );
}

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


function compactText(value?: unknown, max = 160) {
  const text = stringFromUnknown(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function embeddedSessionGroupLabel(sessionId?: string) {
  return browserSessionGroupLabel(sessionId);
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
  return normalized ? `session:${normalized}` : '';
}

function embeddedSessionIdFromGroupId(groupId?: string) {
  const normalized = (groupId || '').trim();
  return normalized.startsWith('session:') ? normalized.slice('session:'.length) : '';
}

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
    return stringFromUnknown(record.text ?? record.content ?? record.reasoning ?? record.value);
  }
  return '';
}

function arrayFromUnknown(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function textFromAiContentPart(part: Record<string, unknown>) {
  return stringFromUnknown(part.text)
    || stringFromUnknown(part.content)
    || stringFromUnknown(part.reasoning)
    || stringFromUnknown(part.value);
}

function toolReasonFromInput(input: unknown) {
  const record = asRecord(input);
  return stringFromUnknown(record?.reason)
    || stringFromUnknown(record?.targetVisual)
    || stringFromUnknown(record?.url)
    || stringFromUnknown(record?.text)
    || stringFromUnknown(record?.action);
}

function toolErrorFromUnknown(value: unknown) {
  const details: string[] = [];
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth = 0) => {
    if (depth > 6 || current === null || current === undefined) return;
    if (typeof current === 'string') {
      const text = stripAnsiControlCodes(current).trim();
      if (text && !details.includes(text)) details.push(text);
      return;
    }
    const record = asRecord(current);
    if (!record || seen.has(record)) return;
    seen.add(record);
    visit(record.message, depth + 1);
    if (Array.isArray(record.issues)) {
      for (const issue of record.issues) {
        const item = asRecord(issue);
        const path = Array.isArray(item?.path) ? item.path.map(String).join('.') : '';
        const message = stringFromUnknown(item?.message);
        if (message) details.push(`${path ? `参数 ${path}: ` : ''}${message}`);
      }
    }
    visit(record.cause, depth + 1);
    visit(record.error, depth + 1);
  };
  visit(value);
  return [...new Set(details)].join('；') || '工具参数解析失败：运行时未返回可识别的错误详情';
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
    const invalid = record.invalid === true;
    return {
      parts: [{ index: 0, kind: 'tool' }],
      reasoning: [],
      texts: [],
      tools: [{
        id: stringFromUnknown(record.toolCallId) || stringFromUnknown(record.id) || name,
        input,
        name,
        reason: toolReasonFromInput(input),
        invalid,
        error: invalid ? toolErrorFromUnknown(record.error) : undefined,
      }],
    };
  }
  return { parts: [], reasoning: [], texts: [], tools: [] };
}

function applyToolResultToAiOutput(output: BrowserChatAiOutputView, part: unknown) {
  const record = asRecord(part);
  if (!record) return false;
  const type = String(record.type || '').toLowerCase();
  if (type !== 'tool-result' && type !== 'tool_result' && type !== 'tool-error' && type !== 'tool_error') return false;
  const id = stringFromUnknown(record.toolCallId) || stringFromUnknown(record.id);
  if (!id) return true;
  const transportSucceeded = type === 'tool-result' || type === 'tool_result';
  const rawResult = transportSucceeded ? (record.output ?? record.result) : (record.error ?? record.output ?? record.result);
  const businessResult = asRecord(rawResult);
  const succeeded = transportSucceeded && (typeof businessResult?.ok !== 'boolean' || businessResult.ok);
  const result = stringFromUnknown(businessResult?.actual)
    || stringFromUnknown(businessResult?.error)
    || textFromAiContentPart(businessResult || { value: rawResult })
    || (succeeded ? 'Tool completed.' : toolErrorFromUnknown(rawResult));
  const tool = [...output.tools].reverse().find((item) => item.id === id);
  if (!tool) return true;
  tool.ok = succeeded;
  tool.result = result;
  tool.rawResult = rawResult;
  if (!succeeded) tool.error = result;
  return true;
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
    if (!applyToolResultToAiOutput(output, part)) mergeAiOutputView(output, normalizeAiContentPart(part));
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
  if (!output.tools.length) {
    for (const toolCall of arrayFromUnknown(record.toolCalls)) {
      mergeAiOutputView(output, normalizeAiContentPart({ ...asRecord(toolCall), type: 'tool-call' }));
    }
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

function hasAiOutputView(output: BrowserChatAiOutputView) {
  return Boolean(output.reasoning.length || output.texts.length || output.tools.length);
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

export function buildAiCycleToolDetailMap(cycles: BrowserChatAiOutputCycle[], steps: StepExecutionResult[], running = false) {
  const details = new Map<string, BrowserChatToolDetail>();
  const persistedToolsById = new Map<string, BrowserChatToolDetail[]>();
  const persistedTools: BrowserChatToolDetail[] = [];
  const consumedPersistedTools = new Set<BrowserChatToolDetail>();
  const consumedProviderResultIds = new Set<string>();

  steps.forEach((step) => {
    (step.tools || []).forEach((tool, toolIndex) => {
      const detail = {
        stepIndex: step.index,
        step,
        toolIndex,
        tool,
      };
      if (tool.id) {
        const matches = persistedToolsById.get(tool.id) || [];
        matches.push(detail);
        persistedToolsById.set(tool.id, matches);
      }
      persistedTools.push(detail);
    });
  });

  cycles.forEach((cycle) => {
    const unmatched: Array<{ aiTool: BrowserChatAiOutputTool; aiToolIndex: number }> = [];
    let matchedInCycle = false;
    cycle.output.tools.forEach((aiTool, aiToolIndex) => {
      const belongsToCycle = (candidate: BrowserChatToolDetail) => (
        candidate.tool.name === aiTool.name
        && (typeof cycle.stepIndex !== 'number' || candidate.stepIndex === cycle.stepIndex)
      );
      const idMatches = aiTool.id ? persistedToolsById.get(aiTool.id) : undefined;
      const detail = idMatches
        ? [...idMatches].sort((left, right) => {
          const score = (candidate: BrowserChatToolDetail) => (
            (candidate.tool.rawResult !== undefined ? 8 : 0)
            + (candidate.tool.result !== undefined ? 4 : 0)
            + (candidate.tool.ok !== undefined ? 2 : 0)
          );
          return score(right) - score(left);
        }).find((candidate) => (
          !consumedPersistedTools.has(candidate) && belongsToCycle(candidate)
        ))
        : undefined;
      if (detail) {
        details.set(aiCycleToolKey(cycle.id, aiToolIndex), detail);
        consumedPersistedTools.add(detail);
        matchedInCycle = true;
        return;
      }
      // The same provider call can be present in a duplicated response cycle.
      // Once its persisted trace was consumed, do not render a fictional second
      // running tool in a later duplicate cycle.
      if (idMatches?.length) return;
      // If persistence has not caught up yet, the provider result is still an
      // exact association. Synthesize a temporary card at the call's original
      // position, but do not pretend it is persisted tool #0. That false index
      // caused tools #1/#2 to be rendered again by the fallback timeline.
      if (aiTool.ok !== undefined) {
        const providerResultId = `${cycle.stepIndex ?? 'unknown'}:${aiTool.id || `${cycle.id}:${aiToolIndex}`}`;
        if (consumedProviderResultIds.has(providerResultId)) return;
        consumedProviderResultIds.add(providerResultId);
        const tool: BrowserChatToolCall = {
          id: aiTool.id || `${cycle.id}:${aiToolIndex}`,
          input: aiTool.input,
          name: aiTool.name,
          reason: aiTool.reason,
          ok: aiTool.ok,
          result: aiTool.result,
          rawResult: aiTool.rawResult,
          ...(aiTool.ok ? {} : { error: aiTool.error || aiTool.result }),
        };
        const stepIndex = typeof cycle.stepIndex === 'number' ? cycle.stepIndex : -1;
        const step: StepExecutionResult = {
          index: stepIndex,
          messageId: cycle.messageId,
          action: aiTool.name,
          expected: 'Tool execution result',
          actual: aiTool.result || (aiTool.ok ? 'Tool completed.' : 'Tool failed.'),
          status: aiTool.ok ? 'passed' : 'failed',
          tools: [tool],
        };
        details.set(aiCycleToolKey(cycle.id, aiToolIndex), { stepIndex, step, toolIndex: -1, tool });
        matchedInCycle = true;
        return;
      }
      // Never infer ownership from matching tool names and arguments. One model
      // cycle may propose several calls while the runtime executes only one,
      // then retry an identical call in a later cycle. Argument matching moves
      // that later execution card above the text that actually triggered it.
      // Persisted traces without an exact call ID are rendered by the fallback
      // step timeline instead of being attached to a guessed provider cycle.
      unmatched.push({ aiTool, aiToolIndex });
    });

    let optimisticToolShown = false;
    unmatched.forEach(({ aiTool, aiToolIndex }) => {
      // A provider may emit several calls in one response while the runtime is
      // intentionally limited to one executed tool per model step. Once one
      // call from the cycle has a real trace, the remaining valid calls are
      // proposals that were never executed, not additional running tools.
      if (!aiTool.invalid && (matchedInCycle || !running || optimisticToolShown)) return;
      if (!aiTool.invalid) optimisticToolShown = true;
      const stepIndex = typeof cycle.stepIndex === 'number' ? cycle.stepIndex : -1;
      const pendingExecution = running && !aiTool.invalid;
      const parseError = aiTool.invalid
        ? aiTool.error || '工具参数解析失败'
        : '工具没有返回执行记录';
      const invalidTool: BrowserChatToolCall = {
        id: aiTool.id || `${cycle.id}:${aiToolIndex}`,
        name: aiTool.name,
        input: aiTool.input,
        reason: aiTool.reason,
        invalid: aiTool.invalid,
        error: parseError,
        ok: pendingExecution ? undefined : false,
        result: parseError,
      };
      const invalidStep: StepExecutionResult = {
        index: stepIndex,
        messageId: cycle.messageId,
        action: aiTool.name,
        expected: aiTool.invalid ? '有效的工具参数' : '工具执行结果',
        actual: parseError,
        status: pendingExecution ? 'running' : 'failed',
        tools: [invalidTool],
      };
      details.set(aiCycleToolKey(cycle.id, aiToolIndex), {
        stepIndex,
        step: invalidStep,
        toolIndex: 0,
        tool: invalidTool,
      });
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

function summarizeToolFields(fields: unknown, t: (value: string, params?: Record<string, string | number>) => string) {
  if (!Array.isArray(fields) || !fields.length) return '';
  const textValues = fields
    .map((field) => toolInputValue(asRecord(field), ['text', 'value', 'content']))
    .filter(Boolean);
  if (fields.length === 1) return textValues[0] || t('{count} 项', { count: 1 });
  return textValues[0]
    ? t('{count} 项，{text}', { count: fields.length, text: textValues[0] })
    : t('{count} 项', { count: fields.length });
}

function browserChatToolLabel(name: string, input: unknown, t: (value: string) => string) {
  const filePresentation = browserChatFileToolPresentation(name, input);
  if (filePresentation) return t(filePresentation.label);
  const labels: Record<string, string> = {
    browserCode: '执行浏览器代码',
    file: '文件操作',
    fileVisual: '视觉检查',
    memory: '记忆管理',
    skill: '读取 Skill',
    subagent: '子 Agent',
    downloadFile: '下载文件',
    fillDocumentTemplate: '填充文档模板',
    generateFile: '生成文件',
    readFile: '读取文件',
    readSubagent: '读取子 Agent',
    spawnSubagents: '子 Agent',
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

function browserChatToolMeta(name: string, input: unknown, t: (value: string, params?: Record<string, string | number>) => string) {
  const record = asRecord(input);
  if (!record) return toolStringValue(input);

  const lower = name.toLowerCase();
  if (name === 'browserCode') return toolInputValue(record, ['reason']) || 'Playwright';
  if (name === 'file') {
    return toolInputValue(record, [
      'fileName',
      'documentId',
      'attachmentId',
      'artifactId',
      'url',
      'path',
      'documentType',
    ]);
  }
  if (name === 'fileVisual') {
    const action = toolInputValue(record, ['action']);
    const screenshotCount = Array.isArray(record.screenshotIds) ? record.screenshotIds.length : 0;
    if (action === 'index') return t('索引全部页面截图');
    if (action === 'read') return screenshotCount
      ? t('读取 {count} 张页面截图', { count: screenshotCount })
      : t('读取页面截图');
  }
  if (name === 'subagent') {
    return record.action === 'spawn' && Array.isArray(record.tasks)
      ? t('{count} 个任务', { count: record.tasks.length })
      : toolInputValue(record, ['uuid', 'action']);
  }
  if (name === 'skill') return toolInputValue(record, ['skillId', 'action']);
  if (name === 'memory') return toolInputValue(record, ['action', 'query', 'key', 'id']);
  if (name === 'readSubagent') return toolInputValue(record, ['uuid']);
  if (name === 'waitForHumanVerification') return toolInputValue(record, ['maxMs']);
  if (name === 'spawnSubagents') return Array.isArray(record.tasks) ? t('{count} 个任务', { count: record.tasks.length }) : '';
  if (lower.includes('fill')) return summarizeToolFields(record.fields, t) || toolInputValue(record, ['text', 'content', 'value']);
  if (lower.includes('click') || lower.includes('hover') || lower.includes('drag')) {
    return toolInputValue(record, ['text', 'targetVisual', 'targetText', 'id', 'fromId']);
  }
  if (lower.includes('find')) return toolInputValue(record, ['targetText', 'scopeId']);
  if (lower.includes('text')) return toolInputValue(record, ['text', 'targetText', 'id']);
  return toolInputValue(record, ['url', 'text', 'query', 'action', 'status']);
}

function isSubagentSpawnTool(name: string, input: unknown) {
  if (name === 'spawnSubagents') return true;
  return name === 'subagent' && asRecord(input)?.action === 'spawn';
}

function BrowserChatToolIcon({ input, name }: { input?: unknown; name: string }) {
  const lower = name.toLowerCase();
  if (name === 'browserCode') return <Braces size={13} />;
  const filePresentation = browserChatFileToolPresentation(name, input);
  if (filePresentation) {
    const icons: Record<BrowserChatFileToolPresentationKey, ReactNode> = {
      'create-draft': <FilePlus2 size={13} />,
      'download-file': <Download size={13} />,
      'edit-draft': <PencilLine size={13} />,
      'file-visual-index': <ScanSearch size={13} />,
      'file-visual-read': <ImageIcon size={13} />,
      'plan-document': <ClipboardCheck size={13} />,
      'read-attachment': <Paperclip size={13} />,
      'read-draft': <FileSearch size={13} />,
      'read-file': <FileText size={13} />,
      'read-file-visuals': <ImageIcon size={13} />,
      'render-file': <FileOutput size={13} />,
      'uno-api': <Library size={13} />,
    };
    return icons[filePresentation.key];
  }
  if (lower === 'file' || lower.includes('fileoperation')) {
    return <FileText size={13} />;
  }
  if (lower.includes('subagent')) return <Waypoints size={13} />;
  if (lower.includes('screenshot') || lower.includes('capture')) return <ImageIcon size={13} />;
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
    subagentId: typeof value.subagentId === 'string' && value.subagentId.trim()
      ? value.subagentId.trim()
      : undefined,
    stepIndex: typeof value.stepIndex === 'number' && Number.isFinite(value.stepIndex) ? Math.floor(value.stepIndex) : undefined,
    toolName,
    inputSignature,
    reason: typeof value.reason === 'string' && value.reason.trim() ? compactText(value.reason, 300) : undefined,
    prompt: compactText(prompt, 500),
    screenshotUrl: typeof value.screenshotUrl === 'string' && value.screenshotUrl.trim()
      ? value.screenshotUrl.trim()
      : undefined,
    requestedAt: typeof value.requestedAt === 'string' ? value.requestedAt : '',
  };
}

function normalizeSession(session: BrowserChatSession): BrowserChatSession {
  const modelSelection = resolveRuntimeModelSelection(null, { model: session.model, provider: session.modelProvider });
  return {
    ...session,
    consoleErrors: session.consoleErrors || [],
    history: normalizeBrowserChatHistory(session.history),
    logs: session.logs || [],
    messages: (session.messages || []).map((message) => ({
      ...message,
      attachments: message.attachments || [],
      content: message.role === 'assistant' && message.status === 'interrupted'
        ? browserChatInterruptedReply
        : stringFromUnknown(message.content),
      role: message.role === 'assistant' ? 'assistant' : 'user',
      stepIndexes: Array.isArray(message.stepIndexes) ? message.stepIndexes : [],
    })),
    safetyMode: normalizeSafetyMode(session.safetyMode),
    modelProvider: modelSelection.provider,
    model: modelSelection.model,
    turnState: session.turnState
      || (session.pendingToolConfirmation
        ? 'awaiting_confirmation'
        : session.busy || session.status === 'running'
          ? 'running'
          : session.status === 'closed'
            ? 'closed'
            : session.status === 'error'
              ? 'failed'
              : 'idle'),
    networkErrors: session.networkErrors || [],
    outputCycles: sortBrowserChatAiOutputCycles(session.outputCycles || []),
    pendingToolConfirmation: session.busy && session.status === 'running'
      ? normalizeToolConfirmation(session.pendingToolConfirmation)
      : undefined,
    queuedTurns: session.queuedTurns || [],
    steps: session.steps || [],
    subagents: session.subagents || [],
  };
}

function mergeBrowserChatSessionWindow(existing: BrowserChatSession | null | undefined, incoming: BrowserChatSession) {
  return normalizeSession(mergeBrowserChatSessionWindowData(existing, incoming));
}

function mergeBrowserChatHistoryChunk(
  current: BrowserChatSession,
  chunk: {
    history?: Partial<BrowserChatHistoryState>;
    logs?: BrowserChatLogRecord[];
    messages?: BrowserChatMessage[];
    steps?: StepExecutionResult[];
    outputCycles?: BrowserChatAiOutputCycle[];
    subagents?: BrowserChatSubagentRecord[];
  },
) {
  return normalizeSession(mergeBrowserChatHistoryChunkData(current, chunk));
}

function browserChatRealtimePatch(value: unknown): BrowserChatSessionRealtimePatch | undefined {
  return parseBrowserChatRealtimePatch<BrowserChatSessionRealtimePatch>(value);
}

function mergeBrowserChatSessionRealtimePatch(
  current: BrowserChatSession,
  patch: BrowserChatSessionRealtimePatch,
): BrowserChatSession {
  const collections = mergeBrowserChatRealtimeCollections(current, patch);
  const { pendingToolConfirmation, ...sessionPatch } = patch.session;
  const applySessionPatch = !sessionPatch.updatedAt
    || !current.updatedAt
    || sessionPatch.updatedAt >= current.updatedAt;
  const outputCycles = applySessionPatch
    ? mergeBrowserChatRealtimeRecords(current.outputCycles, sessionPatch.outputCycles)
    : current.outputCycles;
  const subagents = applySessionPatch
    ? mergeBrowserChatRealtimeRecords(current.subagents, sessionPatch.subagents)
    : current.subagents;
  return normalizeSession({
    ...current,
    ...(applySessionPatch ? sessionPatch : {}),
    outputCycles,
    pendingToolConfirmation: applySessionPatch
      ? normalizeToolConfirmation(pendingToolConfirmation ?? undefined)
      : current.pendingToolConfirmation,
    subagents,
    ...collections,
  });
}

function sessionSortTime(session: BrowserChatSession) {
  return session.updatedAt || session.createdAt || '';
}

function sessionSidebarTime(session: BrowserChatSession, language: 'zh' | 'en') {
  const timestamp = Date.parse(sessionSortTime(session));
  if (!Number.isFinite(timestamp)) return '';
  return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
  }).format(timestamp);
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
    || (incoming.logs?.length || 0) < (existing.logs?.length || 0)
    || (incoming.outputCycles?.length || 0) < (existing.outputCycles?.length || 0)
    || (incoming.subagents?.length || 0) < (existing.subagents?.length || 0);
}

function sessionDisplayTitle(session: BrowserChatSession) {
  return browserChatSessionDisplayTitle(session.title, 220, sessionTitleAttachments(session));
}

function sessionTitleAttachments(session: BrowserChatSession) {
  if (session.titleFileName) return [{ kind: 'file' as const, name: session.titleFileName }];
  return session.messages.find((message) => message.role === 'user')?.attachments || [];
}

function sessionTitleParts(session: BrowserChatSession) {
  return browserChatSessionTitleParts(session.title, sessionTitleAttachments(session));
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
  const normalizedMarkdown = useMemo(() => normalizeBrowserChatMarkdown(markdown), [markdown]);
  return (
    <div className="browser-chat-agent-markdown">
      <ReactMarkdown
        rehypePlugins={[rehypeKatex]}
        remarkPlugins={[remarkGfm, remarkMath, remarkBrowserChatCjkStrong]}
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
          table: ({ children }) => (
            <div className="browser-chat-markdown-table-scroll table-root table-root--primary">
              <div className="table__scroll-container">
                <table className="table__content">{children}</table>
              </div>
            </div>
          ),
          thead: ({ children }) => <thead className="table__header">{children}</thead>,
          tbody: ({ children }) => <tbody className="table__body">{children}</tbody>,
          tr: ({ children }) => <tr className="table__row">{children}</tr>,
          th: ({ children }) => <th className="table__column">{children}</th>,
          td: ({ children }) => <td className="table__cell">{children}</td>,
        }}
      >
        {normalizedMarkdown}
      </ReactMarkdown>
    </div>
  );
});

const BrowserChatDownloadCenter = memo(function BrowserChatDownloadCenter({
  anchorOnly = false,
  downloads,
  open,
  onClose,
  onPreview,
  onRemove,
  onToggle,
  panelWidth,
}: {
  anchorOnly?: boolean;
  downloads: SystemDownloadItem[];
  open: boolean;
  onClose: () => void;
  onPreview: (download: SystemDownloadItem) => void;
  onRemove: (id: string) => void;
  onToggle: () => void;
  panelWidth: number;
}) {
  const { t } = useI18n();
  const popoverId = useId();
  const activeCount = downloads.filter((download) => download.status === 'selecting' || download.status === 'pending' || download.status === 'downloading').length;
  const recentDownloads = downloads.slice(0, 12);
  const [downloadDirectory, setDownloadDirectory] = useState('');
  const [downloadDirectoryError, setDownloadDirectoryError] = useState('');
  const [downloadActionError, setDownloadActionError] = useState('');
  const [downloadPendingDelete, setDownloadPendingDelete] = useState<SystemDownloadItem | null>(null);
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
    setDownloadActionError('');
    setRemovingDownloadIds((current) => new Set(current).add(id));
    try {
      const result = await bridge.removeDownload({ id });
      if (!result.ok) {
        setDownloadActionError(result.error || '删除文件失败');
        return;
      }
      onRemove(id);
      setDownloadPendingDelete(null);
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
    <div className={`browser-chat-download-center${anchorOnly ? ' is-anchor-only' : ''}`}>
      <Popover
        isOpen={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen && !open) onToggle();
          else if (!nextOpen && open) onClose();
        }}
      >
        <Button
          aria-hidden={anchorOnly || undefined}
          aria-controls={popoverId}
          aria-expanded={open}
          aria-label={t('下载')}
          className={activeCount ? 'ui-icon-button browser-chat-download-button active' : 'ui-icon-button browser-chat-download-button'}
          excludeFromTabOrder={anchorOnly}
          variant="ghost"
        >
          <Download size={17} />
          {activeCount ? <span className="browser-chat-download-badge">{activeCount}</span> : null}
        </Button>
        <Popover.Content
          containerPadding={8}
          offset={6}
          placement="bottom end"
        >
          <Popover.Dialog aria-label={t('下载进度')} id={popoverId}>
          <div className="browser-chat-download-popover" style={{ maxHeight: 520, width: panelWidth }}>
          <header>
            <strong>{t('下载')}</strong>
            <div className="browser-chat-download-header-actions">
              <button
                aria-label={t('设置下载位置')}
                className="ui-icon-button"
                disabled={selectingDownloadDirectory}
                onClick={() => void chooseDownloadLocation()}
                title={downloadDirectory ? t('下载位置：{path}', { path: downloadDirectory }) : t('设置下载位置')}
                type="button"
              >
                {selectingDownloadDirectory ? <Loader2 className="spin" size={15} /> : <Settings size={15} />}
              </button>
              <button className="ui-icon-button" onClick={onClose} type="button" aria-label={t('关闭下载面板')} title={t('关闭')}>
                <X size={15} />
              </button>
            </div>
          </header>
          {downloadDirectoryError ? <div className="browser-chat-download-location-error">{t(downloadDirectoryError)}</div> : null}
          {downloadActionError ? <div className="browser-chat-download-location-error">{t(downloadActionError)}</div> : null}
          {recentDownloads.length ? (
            <ol className="browser-chat-download-list">
              {recentDownloads.map((download) => {
                const percent = browserChatDownloadPercent(download);
                const received = formatDownloadBytes(download.receivedBytes);
                const total = formatDownloadBytes(download.totalBytes);
                const progressWidth = percent === undefined ? (download.status === 'downloading' ? 18 : 0) : percent;
                const sizeLabel = total ? `${received || '0 B'} / ${total}` : received;
                const statusLine = [
                  t(browserChatDownloadStatusLabel(download.status)),
                  percent !== undefined ? `${percent}%` : '',
                  sizeLabel,
                ].filter(Boolean).join(' · ');
                const removable = !['selecting', 'pending', 'downloading', 'paused', 'interrupted'].includes(download.status || '');
                const revealable = download.status === 'completed' && Boolean(download.path);
                return (
                  <li className={`browser-chat-download-item ${download.status || 'pending'}`} key={download.id}>
                    <div className="browser-chat-download-item-head">
                      <div className="browser-chat-download-copy">
                        {download.status === 'completed' && (download.path || download.url) ? (
                          <button
                            aria-label={t('预览 {name}', { name: download.fileName || 'download' })}
                            className="browser-chat-download-file"
                            onClick={() => onPreview(download)}
                            title={t('点击预览文件')}
                            type="button"
                          >
                            {download.fileName || 'download'}
                          </button>
                        ) : <strong>{download.fileName || 'download'}</strong>}
                        <span>{statusLine}</span>
                      </div>
                      {revealable || removable ? (
                        <div className="browser-chat-download-actions">
                          {revealable ? (
                            <button
                              aria-label={t('在文件夹中显示')}
                              className="browser-chat-download-item-action browser-chat-download-reveal"
                              onClick={() => void showDownloadInFolder(download.id)}
                              title={t('在文件夹中显示')}
                              type="button"
                            >
                              <FolderOpen size={14} />
                            </button>
                          ) : null}
                          {removable ? (
                            <button
                              aria-label={t('删除下载文件')}
                              className="browser-chat-download-item-action browser-chat-download-remove"
                              disabled={removingDownloadIds.has(download.id)}
                              onClick={() => setDownloadPendingDelete(download)}
                              title={t('删除文件')}
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
                    {download.error ? <div className="browser-chat-download-error">{t(download.error)}</div> : null}
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="browser-chat-download-empty">{t('暂无下载')}</div>
          )}
          </div>
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
      {downloadPendingDelete ? (
        <ConfirmDeleteModal
          deleting={removingDownloadIds.has(downloadPendingDelete.id)}
          description={t('文件将移入回收站。')}
          error={downloadActionError}
          id="browser-chat-download-delete-title"
          itemTitle={downloadPendingDelete.fileName || t('该文件')}
          onClose={() => {
            if (!removingDownloadIds.has(downloadPendingDelete.id)) setDownloadPendingDelete(null);
          }}
          onConfirm={() => removeDownload(downloadPendingDelete.id)}
          title={t('删除下载文件')}
        />
      ) : null}
    </div>
  );
});

const BrowserChatGroupBindingCenter = memo(function BrowserChatGroupBindingCenter({
  anchorOnly = false,
  disabled,
  groupId,
  onClose,
  onSelect,
  onToggle,
  open,
  panelWidth,
}: {
  anchorOnly?: boolean;
  disabled?: boolean;
  groupId?: string;
  onClose: () => void;
  onSelect: (groupId: string) => void | Promise<void>;
  onToggle: () => void;
  open: boolean;
  panelWidth: number;
}) {
  const { t } = useI18n();
  const popoverId = useId();
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
    <div className={`browser-chat-group-binding-center${anchorOnly ? ' is-anchor-only' : ''}`}>
      <Popover
        isOpen={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen && !open && !disabled) onToggle();
          else if (!nextOpen && open) onClose();
        }}
      >
        <Button
          aria-hidden={anchorOnly || undefined}
          aria-controls={popoverId}
          aria-expanded={open}
          aria-label={t('绑定浏览器标签组')}
          className="ui-icon-button browser-chat-group-binding-button"
          excludeFromTabOrder={anchorOnly}
          isDisabled={disabled}
          style={{ '--browser-chat-bound-group-color': embeddedBrowserGroupIconColor(displayedGroupId) } as CSSProperties}
          variant="ghost"
        >
          {pendingGroupId ? <Loader2 className="spin" size={17} /> : <Folder size={17} />}
        </Button>
        <Popover.Content
          containerPadding={8}
          offset={6}
          placement="bottom end"
        >
          <Popover.Dialog aria-label={t('选择浏览器标签组')} id={popoverId}>
          <div className="browser-chat-group-binding-popover" style={{ maxHeight: 520, width: panelWidth }}>
          <header>
            <strong>{t('绑定标签组')}</strong>
            <button className="ui-icon-button" onClick={onClose} type="button" aria-label={t('关闭标签组面板')}>
              <X size={15} />
            </button>
          </header>
          {error ? <p className="browser-chat-group-binding-error">{t(error)}</p> : null}
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
            <div className="browser-chat-group-binding-empty">{t('暂无可绑定的标签组')}</div>
          )}
          </div>
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
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
  return <FileText size={14} />;
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
  return inlineTokenSvg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h6"/>');
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
  const { t } = useI18n();
  const kind = browserChatAttachmentKind(attachment);
  const label = t(browserChatReferenceLabel(kind));
  const children = (
    <>
      <span className={`browser-chat-reference-icon ${kind}`}>
        <BrowserChatReferenceIcon kind={kind} />
      </span>
      {attachment.name || label}
    </>
  );
  return (
    <span className={`browser-chat-inline-token browser-chat-reference-chip ${kind}${className ? ` ${className}` : ''}`} title={t(browserChatReferenceMeta(attachment, kind))}>
      {kind !== 'tab' ? (
        <button
          aria-label={t('预览 {name}', { name: attachment.name })}
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
    <span className="browser-chat-inline-token browser-chat-message-skill" title={skill.description}>
      <span className="browser-chat-message-skill-icon">
        <Braces size={14} />
      </span>
      {skill.title}
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

function confirmationScreenshotFromPendingLog(
  logs: BrowserChatLogRecord[],
  confirmationId: string,
  inputSignature: string,
) {
  for (const log of [...logs].reverse()) {
    if (log.phase !== 'tool:confirmation:pending') continue;
    const pending = asRecord(parseJsonObjectText(log.details)?.confirmation);
    if (!pending) continue;
    const pendingId = typeof pending.id === 'string' ? pending.id : '';
    const pendingSignature = typeof pending.inputSignature === 'string' ? pending.inputSignature : '';
    if (confirmationId ? pendingId !== confirmationId : pendingSignature !== inputSignature) continue;
    return typeof pending.screenshotUrl === 'string' && pending.screenshotUrl.trim()
      ? pending.screenshotUrl.trim()
      : undefined;
  }
  return undefined;
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
    const confirmationId = typeof details?.confirmationId === 'string' ? details.confirmationId : '';
    const screenshotUrl = typeof details?.screenshotUrl === 'string' && details.screenshotUrl.trim()
      ? details.screenshotUrl.trim()
      : confirmationScreenshotFromPendingLog(logs, confirmationId, inputSignature);
    return log.phase === 'tool:confirmation:confirmed'
      ? { className: 'is-confirmed', label: '用户已确认', screenshotUrl }
      : { className: 'is-cancelled', label: '用户已取消', screenshotUrl };
  }
  return undefined;
}

function BrowserChatToolUserActionTag({ action }: { action?: ReturnType<typeof toolUserActionForTool> }) {
  const { t } = useI18n();
  if (!action) return null;
  return <span className={`browser-chat-tool-user-action-tag ${action.className}`}>{t(action.label)}</span>;
}

function BrowserChatToolCardContent({
  active = false,
  input,
  label,
  meta,
  name,
  userAction,
}: {
  active?: boolean;
  input?: unknown;
  label: string;
  meta?: string;
  name: string;
  userAction?: ReturnType<typeof toolUserActionForTool>;
}) {
  const copy = (
    <>
      <span className="browser-chat-tool-label">
        <span className="browser-chat-tool-name">{label}</span>
        <BrowserChatToolUserActionTag action={userAction} />
      </span>
      {meta ? <span className="browser-chat-tool-meta">{meta}</span> : null}
    </>
  );
  return (
    <>
      <span className="browser-chat-tool-icon" aria-hidden="true">
        <BrowserChatToolIcon input={input} name={name} />
      </span>
      {active ? (
        <AnimatedShinyText className="browser-chat-tool-content browser-chat-tool-shiny-text">
          {copy}
        </AnimatedShinyText>
      ) : (
        <span className="browser-chat-tool-content">{copy}</span>
      )}
    </>
  );
}

function BrowserChatToolScreenshotButton({ tool }: { tool: BrowserChatToolCall }) {
  const { t } = useI18n();
  const preview = useContext(BrowserChatScreenshotPreviewContext);
  const screenshots = browserChatRenderableScreenshots(tool);
  if (!preview || !screenshots.length) return null;
  return (
    <button
      aria-label={t('查看工具截图，共 {count} 张', { count: screenshots.length })}
      className="browser-chat-tool-image-button"
      onClick={() => preview.open(screenshots)}
      title={t('查看工具截图')}
      type="button"
    >
      <ImageIcon size={14} />
      <span>{screenshots.length}</span>
    </button>
  );
}

function browserChatArtifactOpenUrl(artifact: BrowserChatArtifactSummary) {
  return artifact.url || artifactApiUrl(artifact.path) || artifact.downloadUrl;
}

function browserChatArtifactFileIcon(fileName: string, openUrl: string) {
  if (browserChatArtifactIsImage(fileName)) {
    return <img alt="" loading="lazy" src={openUrl} />;
  }
  const extension = browserChatArtifactExtension(fileName) || '';
  const icon = /^(?:PPT|PPTX|ODP)$/i.test(extension)
    ? { name: 'PowerPoint', src: '/file-icons/powerpoint.svg' }
    : /^(?:DOC|DOCX|ODT|RTF)$/i.test(extension)
      ? { name: 'Word', src: '/file-icons/word.svg' }
      : /^(?:XLS|XLSX|XLSM|XLSB|CSV|ODS)$/i.test(extension)
        ? { name: 'Excel', src: '/file-icons/excel.svg' }
        : undefined;
  if (!icon) return <FileText size={20} />;
  return (
    <img
      alt=""
      className="browser-chat-output-file-brand-icon"
      draggable={false}
      src={withWebPilotBasePath(icon.src)}
      title={icon.name}
    />
  );
}

function BrowserChatMessageArtifactCards({
  artifacts,
}: {
  artifacts?: BrowserChatArtifactSummary[];
}) {
  const { t } = useI18n();
  const preview = useContext(BrowserChatScreenshotPreviewContext);
  const messageArtifacts = useMemo(() => artifacts || [], [artifacts]);
  const screenshots = useMemo(() => messageArtifacts.flatMap((artifact): BrowserChatRenderableScreenshot[] => {
    if (artifact.kind !== 'screenshot' || !artifact.path) return [];
    const url = browserChatArtifactOpenUrl(artifact);
    if (!url) return [];
    return [{
      path: artifact.path,
      title: artifact.title || '截图',
      url,
    }];
  }), [messageArtifacts]);
  const files = useMemo(() => messageArtifacts.flatMap((artifact) => {
    if (artifact.kind === 'screenshot') return [];
    const openUrl = browserChatArtifactOpenUrl(artifact);
    return openUrl ? [{ ...artifact, openUrl }] : [];
  }), [messageArtifacts]);
  const [filesExpanded, setFilesExpanded] = useState(true);
  if (!files.length && !screenshots.length) return null;
  return (
    <section aria-label={t('输出文件')} className={`browser-chat-message-artifacts${filesExpanded ? ' is-expanded' : ''}`}>
          <button
            aria-expanded={filesExpanded}
            className="browser-chat-output-files-heading"
            onClick={() => setFilesExpanded((current) => !current)}
            type="button"
          >
            <ChevronDown aria-hidden="true" size={14} />
            <span>{t('输出文件')}</span>
          </button>
          <div className="browser-chat-output-files-shell" inert={!filesExpanded}>
            <div className="browser-chat-output-file-list">
              {files.map((file) => {
                const extension = browserChatArtifactExtension(file.fileName);
                const metadata = [
                  typeof file.bytes === 'number' ? formatDownloadBytes(file.bytes) : '',
                  extension,
                  file.pageCount ? t('{count} 页', { count: file.pageCount }) : '',
                ].filter(Boolean);
                return (
                  <article className="browser-chat-output-file-row" key={file.id}>
                    <a
                      aria-label={t('打开文件 {name}', { name: file.fileName })}
                      className="browser-chat-output-file-main"
                      href={file.openUrl}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      <span className={`browser-chat-output-file-icon${browserChatArtifactIsImage(file.fileName) ? ' is-image' : ''}`} aria-hidden="true">
                        {browserChatArtifactFileIcon(file.fileName, file.openUrl)}
                      </span>
                      <span className="browser-chat-output-file-copy">
                        <strong>{file.fileName}</strong>
                        <small>{metadata.join(' · ') || t('文件')}</small>
                      </span>
                    </a>
                    <span className="browser-chat-output-file-actions">
                      <a
                        aria-label={`${t('下载文件')}：${file.fileName}`}
                        download={file.fileName}
                        href={file.downloadUrl || file.openUrl}
                        rel="noopener noreferrer"
                        title={t('下载文件')}
                      >
                        <Download size={15} />
                      </a>
                      <a
                        aria-label={t('打开文件 {name}', { name: file.fileName })}
                        href={file.openUrl}
                        rel="noopener noreferrer"
                        target="_blank"
                        title={t('打开文件 {name}', { name: file.fileName })}
                      >
                        <SquareArrowOutUpRight size={15} />
                      </a>
                    </span>
                  </article>
                );
              })}
              {screenshots.map((screenshot, index) => {
                const rawTitle = screenshot.title.replace(/\s+explicit image\s+\d+$/i, '').trim();
                const title = rawTitle && rawTitle !== 'browserCode'
                  ? rawTitle
                  : t('操作截图 {index}', { index: index + 1 });
                const fileName = browserChatArtifactFileName(screenshot.path) || `screenshot-${index + 1}.png`;
                const extension = browserChatArtifactExtension(fileName) || t('图片');
                return (
                  <article className="browser-chat-output-file-row is-screenshot" key={`screenshot:${screenshot.path}`}>
                    {preview ? (
                      <button
                        aria-label={t('查看截图 {index}', { index: index + 1 })}
                        className="browser-chat-output-file-main"
                        onClick={() => preview.open(screenshots, index)}
                        type="button"
                      >
                        <span className="browser-chat-output-file-icon is-image" aria-hidden="true">
                          <img alt="" loading="lazy" src={screenshot.url} />
                        </span>
                        <span className="browser-chat-output-file-copy">
                          <strong>{title}</strong>
                          <small>{extension} · {t('截图')}</small>
                        </span>
                      </button>
                    ) : (
                      <a
                        aria-label={t('打开文件 {name}', { name: title })}
                        className="browser-chat-output-file-main"
                        href={screenshot.url}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        <span className="browser-chat-output-file-icon is-image" aria-hidden="true">
                          <img alt="" loading="lazy" src={screenshot.url} />
                        </span>
                        <span className="browser-chat-output-file-copy">
                          <strong>{title}</strong>
                          <small>{extension} · {t('截图')}</small>
                        </span>
                      </a>
                    )}
                    <span className="browser-chat-output-file-actions">
                      <a
                        aria-label={`${t('下载文件')}：${title}`}
                        download={fileName}
                        href={screenshot.url}
                        rel="noopener noreferrer"
                        title={t('下载文件')}
                      >
                        <Download size={15} />
                      </a>
                      <a
                        aria-label={t('打开文件 {name}', { name: title })}
                        href={screenshot.url}
                        rel="noopener noreferrer"
                        target="_blank"
                        title={t('打开文件 {name}', { name: title })}
                      >
                        <SquareArrowOutUpRight size={15} />
                      </a>
                    </span>
                  </article>
                );
              })}
            </div>
          </div>
    </section>
  );
}

function BrowserChatScreenshotPreviewDialog({
  onChange,
  onClose,
  preview,
}: {
  onChange: (index: number) => void;
  onClose: () => void;
  preview: BrowserChatScreenshotPreview | null;
}) {
  const { t } = useI18n();
  if (!preview) return null;
  const screenshot = preview.screenshots[preview.index];
  if (!screenshot) return null;
  const hasMultiple = preview.screenshots.length > 1;
  return (
    <AppModal
      ariaLabel={t('截图预览')}
      backdropClassName="browser-chat-tool-image-overlay"
      dialogClassName="browser-chat-tool-image-dialog"
      onClose={onClose}
      size="media"
    >
        <header className="browser-chat-tool-image-dialog-header">
          <div className="browser-chat-tool-image-dialog-title">
            <strong>{screenshot.title}</strong>
            <span>{t('{current} / {total}', { current: preview.index + 1, total: preview.screenshots.length })}</span>
          </div>
          <div className="browser-chat-tool-image-dialog-actions">
            <a data-file-preview="false" href={screenshot.url} rel="noopener noreferrer" target="_blank">
              <SquareArrowOutUpRight size={15} />
              {t('打开原图')}
            </a>
            <button aria-label={t('关闭')} className="browser-chat-tool-image-dialog-close" onClick={onClose} type="button"><X size={17} /></button>
          </div>
        </header>
        <div className="browser-chat-tool-image-stage">
          {hasMultiple ? (
            <button
              aria-label={t('上一张')}
              className="is-previous"
              onClick={() => onChange((preview.index - 1 + preview.screenshots.length) % preview.screenshots.length)}
              type="button"
            ><ArrowLeft size={19} /></button>
          ) : null}
          <img alt={screenshot.title} src={screenshot.url} />
          {hasMultiple ? (
            <button
              aria-label={t('下一张')}
              className="is-next"
              onClick={() => onChange((preview.index + 1) % preview.screenshots.length)}
              type="button"
            ><ArrowRight size={19} /></button>
          ) : null}
        </div>
    </AppModal>
  );
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
  const { t } = useI18n();
  const [screenshotOpen, setScreenshotOpen] = useState(false);
  const screenshotTitleId = useId();
  useEffect(() => setScreenshotOpen(false), [pending?.id]);
  if (!pending || !onResolveToolConfirmation) return null;
  const resolving = resolvingConfirmationId === pending.id;
  const resolvingConfirm = resolving && resolvingConfirmationAction === 'confirm';
  const resolvingCancel = resolving && resolvingConfirmationAction === 'cancel';
  return (
    <>
      <BlurFade className="browser-chat-tool-confirmation" duration={0.34} offset={8} role="group" aria-label={t('工具调用确认')}>
        <BorderBeam colorFrom="#d79a18" colorTo="#f5d584" duration={7.5} size={82} />
        <div className="browser-chat-tool-confirmation-copy">
          <span aria-hidden="true" className="browser-chat-tool-confirmation-icon">
            <svg viewBox="0 0 16 16">
              <circle cx="8" cy="8" r="7" />
              <path d="M8 4.25v4.5" />
              <circle className="browser-chat-tool-confirmation-icon-dot" cx="8" cy="11.35" r="0.8" />
            </svg>
          </span>
          <span className="browser-chat-tool-confirmation-message">
            <strong>{t('需要你的确认')}</strong>
            <span>{pending.reason || pending.prompt}</span>
          </span>
        </div>
        <div className="browser-chat-tool-confirmation-actions">
          {pending.screenshotUrl ? (
            <button
              className="browser-chat-tool-screenshot"
              disabled={resolving}
              onClick={() => setScreenshotOpen(true)}
              type="button"
            >
              <ScanSearch size={14} />
              {t('查看当前页面')}
            </button>
          ) : null}
          <button
            className="browser-chat-tool-cancel"
            disabled={resolving}
            onClick={() => void onResolveToolConfirmation(pending.id, 'cancel')}
            type="button"
          >
            {resolvingCancel ? <Loader2 className="spin" size={13} /> : <X size={13} />}
            {resolvingCancel ? t('取消中') : t('取消')}
          </button>
          <RainbowButton
            className="browser-chat-tool-confirm"
            disabled={resolving}
            onClick={() => void onResolveToolConfirmation(pending.id, 'confirm')}
            size="default"
          >
            {resolvingConfirm ? <Loader2 className="spin" size={13} /> : <BadgeCheck size={13} />}
            {resolvingConfirm ? t('确认中') : t('确认执行')}
          </RainbowButton>
        </div>
      </BlurFade>
      {screenshotOpen && pending.screenshotUrl ? (
        <AppModal
          ariaLabelledBy={screenshotTitleId}
          onClose={() => setScreenshotOpen(false)}
          size="media"
        >
            <header className="ui-modal-header">
              <div className="ui-modal-heading ui-modal-heading--with-icon">
                <span aria-hidden="true" className="ui-modal-heading-icon"><ScanSearch size={18} /></span>
                <div className="ui-modal-heading-copy">
                  <h2 className="ui-modal-title" id={screenshotTitleId}>{t('操作前的当前页面')}</h2>
                  <p className="ui-modal-subtitle">{t('确认前自动截取的浏览器可视区域')}</p>
                </div>
              </div>
              <button aria-label={t('关闭')} autoFocus className="ui-icon-button ui-modal-close" onClick={() => setScreenshotOpen(false)} type="button">
                <X size={16} />
              </button>
            </header>
            <div className="ui-modal-body browser-chat-confirmation-screenshot-body">
              <img alt={t('确认操作前的当前页面截图')} src={pending.screenshotUrl} />
            </div>
        </AppModal>
      ) : null}
    </>
  );
});

const BrowserChatPendingToolConfirmationCard = memo(function BrowserChatPendingToolConfirmationCard({
  pending,
  resolvingConfirmationAction,
  resolvingConfirmationId,
  onResolveToolConfirmation,
}: {
  pending: BrowserChatToolConfirmation;
  resolvingConfirmationAction?: BrowserChatToolConfirmationAction | null;
  resolvingConfirmationId?: string | null;
  onResolveToolConfirmation?: (confirmationId: string, action: BrowserChatToolConfirmationAction) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const label = browserChatToolLabel(pending.toolName, undefined, t);
  return (
    <section className="browser-chat-tool-call browser-chat-pending-tool-confirmation">
      {pending.reason ? <p className="browser-chat-tool-reason">{pending.reason}</p> : null}
      <div className="browser-chat-tool-card is-waiting">
        <BrowserChatToolCardContent label={label} meta={t('等待用户确认')} name={pending.toolName} />
      </div>
      <BrowserChatToolConfirmationActions
        pending={pending}
        resolvingConfirmationAction={resolvingConfirmationAction}
        resolvingConfirmationId={resolvingConfirmationId}
        onResolveToolConfirmation={onResolveToolConfirmation}
      />
    </section>
  );
});

const BrowserChatSubagentToolDisclosure = memo(function BrowserChatSubagentToolDisclosure({
  batchId,
  cardContent,
  className,
  isActive,
  onLoadSubagentRecords,
  onResolveToolConfirmation,
  onSelectTool,
  onResume,
  pendingToolConfirmation,
  resolvingConfirmationAction,
  resolvingConfirmationId,
  resuming,
  structuredSubagents,
  title,
  tool,
  toolResult,
}: {
  batchId?: string;
  cardContent: ReactNode;
  className: string;
  isActive: boolean;
  onLoadSubagentRecords?: () => void;
  onResolveToolConfirmation?: (confirmationId: string, action: BrowserChatToolConfirmationAction) => void | Promise<void>;
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  onResume?: () => void | Promise<void>;
  pendingToolConfirmation?: BrowserChatToolConfirmation;
  resolvingConfirmationAction?: BrowserChatToolConfirmationAction | null;
  resolvingConfirmationId?: string | null;
  resuming?: boolean;
  running: boolean;
  structuredSubagents?: BrowserChatSubagentRecord[];
  title: string;
  tool: BrowserChatToolCall;
  toolResult?: unknown;
}) {
  const [loadingRecords, setLoadingRecords] = useState(false);
  const requestedBatchRef = useRef<string | undefined>(undefined);
  const batchSubagents = useMemo(
    () => browserChatSubagentViewsFromRecords(structuredSubagents || [], toolResult, batchId),
    [batchId, structuredSubagents, toolResult],
  );
  const structuredSubagentsComplete = Boolean(
    batchSubagents.length
    && batchSubagents.every((subagent) => subagent.status !== 'running' && subagent.status !== 'queued'),
  );
  const loadSubagentRecords = useCallback(async () => {
    if (!onLoadSubagentRecords || loadingRecords || structuredSubagentsComplete) return;
    const showLoading = batchSubagents.length === 0;
    if (showLoading) setLoadingRecords(true);
    try {
      await onLoadSubagentRecords();
    } finally {
      if (showLoading) setLoadingRecords(false);
    }
  }, [batchSubagents.length, loadingRecords, onLoadSubagentRecords, structuredSubagentsComplete]);
  useEffect(() => {
    const requestKey = batchId || tool.id || title;
    if (!onLoadSubagentRecords || structuredSubagentsComplete || requestedBatchRef.current === requestKey) return;
    requestedBatchRef.current = requestKey;
    void loadSubagentRecords();
  }, [batchId, loadSubagentRecords, onLoadSubagentRecords, structuredSubagentsComplete, title, tool.id]);
  return (
    <section aria-label={title} className="browser-chat-ai-line-collapse browser-chat-subagent-tool browser-chat-tool-chips is-expanded">
      <div className="browser-chat-tool-card-row">
        <div
          className={`browser-chat-tool-card browser-chat-ai-tool-summary-card browser-chat-subagent-tool-chip is-static${className}`}
        >
          {cardContent}
          <span className="browser-chat-subagent-tool-actions" aria-hidden="true">
            {loadingRecords ? <Loader2 className="spin" size={13} /> : null}
            {isActive ? <BrowserChatToolTailParticles /> : null}
          </span>
        </div>
        <BrowserChatToolScreenshotButton tool={tool} />
      </div>
      <div className="browser-chat-subagent-body-shell">
        <div className="browser-chat-subagent-body">
          <BrowserChatSubagentList
            loadingRecords={loadingRecords}
            onResolveToolConfirmation={onResolveToolConfirmation}
            onSelectTool={onSelectTool}
            onResume={onResume}
            pendingToolConfirmation={pendingToolConfirmation}
            resolvingConfirmationAction={resolvingConfirmationAction}
            resolvingConfirmationId={resolvingConfirmationId}
            resuming={resuming}
            subagents={batchSubagents}
          />
        </div>
      </div>
    </section>
  );
});

const BrowserChatStepToolCards = memo(function BrowserChatStepToolCards({
  logs,
  onLoadSubagentRecords,
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
  structuredSubagents,
  visibleToolIndexes,
}: {
  logs: BrowserChatLogRecord[];
  onLoadSubagentRecords?: () => void;
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
  structuredSubagents?: BrowserChatSubagentRecord[];
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
            <span className="browser-chat-tool-name">{t('准备工具')}</span>
          </span>
          <small className="browser-chat-tool-meta">{t('正在选择下一步浏览器动作')}</small>
        </span>
      </div>
    );
  }

  return (
    <>
      {toolCalls.map(({ tool, toolIndex }) => {
        const label = browserChatToolLabel(tool.name, tool.input, t);
        const meta = tool.invalid
          ? browserChatToolValidationSummary(tool.error || tool.result)
          : compactText(tool.reason || browserChatToolMeta(tool.name, tool.input, t), 150);
        const displayText = `${label}${meta ? `: ${meta}` : ''}`;
        const presentation = browserChatToolPresentation(tool, step, running);
        const { isActive: isActiveTool, stateClass, status } = presentation;
        const translatedStatus = t(status);
        const pendingConfirmation = pendingConfirmationForTool({
          pending: pendingToolConfirmation,
          stepIndex: step.index,
          toolName: tool.name,
          toolInput: tool.input,
          toolOk: tool.ok,
        });
        if (onlyPendingConfirmation && !pendingConfirmation) return null;
        const progressMeta = isActiveTool && tool.progress?.message
          ? `${tool.progress.message}${tool.progress.current !== undefined && tool.progress.total ? ` ${tool.progress.current}/${tool.progress.total}` : ''}`
          : '';
        const visibleMeta = [meta, progressMeta, pendingConfirmation ? t('等待用户确认') : translatedStatus].filter(Boolean).join(' · ');
        const userAction = pendingConfirmation
          ? undefined
          : toolUserActionForTool(logs, step.index, tool.name, tool.input);
        return (
          <div
            className={`browser-chat-tool-call${isSubagentSpawnTool(tool.name, tool.input) ? ' has-subagents' : ''}`}
            key={`${step.index}-${toolIndex}-${tool.name}`}
          >
            {isSubagentSpawnTool(tool.name, tool.input) ? (
              <BrowserChatSubagentToolDisclosure
                batchId={tool.id}
                cardContent={(
                  <BrowserChatToolCardContent active={isActiveTool} input={tool.input} label={label} meta={visibleMeta} name={tool.name} userAction={userAction} />
                )}
                className={stateClass}
                isActive={isActiveTool}
                onLoadSubagentRecords={onLoadSubagentRecords}
                onResolveToolConfirmation={onResolveToolConfirmation}
                onSelectTool={onSelectTool}
                onResume={onResumeHumanVerification}
                pendingToolConfirmation={pendingToolConfirmation}
                resolvingConfirmationAction={resolvingConfirmationAction}
                resolvingConfirmationId={resolvingConfirmationId}
                resuming={resumingHumanVerification}
                running={running}
                structuredSubagents={structuredSubagents}
                title={`${displayText} · ${translatedStatus}`}
                tool={tool}
                toolResult={tool.rawResult ?? tool.result}
              />
            ) : (
              <div className="browser-chat-tool-card-row">
                <button
                  aria-label={`${displayText}，${translatedStatus}`}
                  className={`browser-chat-tool-card${stateClass}`}
                  onClick={() => onSelectTool({ stepIndex: step.index, step, toolIndex, tool })}
                  type="button"
                >
                  <BrowserChatToolCardContent active={isActiveTool} input={tool.input} label={label} meta={visibleMeta} name={tool.name} userAction={userAction} />
                  {isActiveTool ? <BrowserChatToolTailParticles /> : null}
                </button>
                <BrowserChatToolScreenshotButton tool={tool} />
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
    </>
  );
});

type BrowserChatAiCycleCommonProps = {
  logs: BrowserChatLogRecord[];
  onLoadSubagentRecords?: () => void;
  onResolveToolConfirmation?: (confirmationId: string, action: BrowserChatToolConfirmationAction) => void | Promise<void>;
  onResumeHumanVerification?: () => void | Promise<void>;
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  pendingToolConfirmation?: BrowserChatToolConfirmation;
  resolvingConfirmationAction?: BrowserChatToolConfirmationAction | null;
  resolvingConfirmationId?: string | null;
  resumingHumanVerification?: boolean;
  running: boolean;
  structuredSubagents?: BrowserChatSubagentRecord[];
  toolDetails: Map<string, BrowserChatToolDetail>;
};

const BrowserChatAiCycleLine = memo(function BrowserChatAiCycleLine({
  cycle,
  logs,
  onLoadSubagentRecords,
  onResolveToolConfirmation,
  onResumeHumanVerification,
  onSelectTool,
  pendingToolConfirmation,
  resolvingConfirmationAction,
  resolvingConfirmationId,
  resumingHumanVerification,
  running,
  structuredSubagents,
  toolDetails,
}: BrowserChatAiCycleCommonProps & {
  cycle: BrowserChatAiOutputCycle;
}) {
  const showReasoning = useContext(BrowserChatReasoningVisibilityContext);
  const { t } = useI18n();
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
  // `output.parts` is the persisted event order. Reordering tools after text
  // makes already-visible text jump when a running tool receives its result.
  if (!orderedParts.length) return null;
  const hasTimelineNarrative = orderedParts.some((entry) => entry.kind === 'text' || entry.kind === 'reasoning');
  return (
    <div className={`browser-chat-ai-cycle${hasTimelineNarrative ? ' has-timeline-narrative' : ''}`}>
      {orderedParts.map((entry, orderedIndex) => {
        if (entry.kind === 'reasoning') {
          return (
            <details className="browser-chat-ai-line-collapse" key={`reasoning-${entry.part.index}-${orderedIndex}`}>
              <summary className="browser-chat-ai-collapse-summary">
                <Sparkles size={14} />
                <span>{t('思维链')}</span>
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
        const executedTool = toolDetail.tool;
        const label = browserChatToolLabel(executedTool.name, executedTool.input, t);
        const meta = executedTool.invalid
          ? browserChatToolValidationSummary(executedTool.error || executedTool.result)
          : executedTool.reason || tool.reason || browserChatToolMeta(executedTool.name, executedTool.input, t);
        const presentation = browserChatToolPresentation(executedTool, toolDetail.step, running);
        const { isActive, stateClass, status } = presentation;
        const pendingConfirmation = pendingConfirmationForTool({
          pending: pendingToolConfirmation,
          stepIndex: toolDetail.stepIndex,
          toolName: executedTool.name,
          toolInput: executedTool.input,
          toolOk: executedTool.ok,
        });
        const userAction = pendingConfirmation
          ? undefined
          : toolUserActionForTool(logs, toolDetail.stepIndex, executedTool.name, executedTool.input);
        const compactMeta = executedTool.invalid ? meta : meta ? compactText(meta, 150) : undefined;
        const visibleMeta = [compactMeta, pendingConfirmation ? t('等待用户确认') : t(status)].filter(Boolean).join(' · ');
        const card = (
          <BrowserChatToolCardContent
            active={isActive}
            input={executedTool.input}
            label={label}
            meta={visibleMeta}
            name={executedTool.name}
            userAction={userAction}
          />
        );
        return (
          <div className="browser-chat-ai-cycle-tools" key={`tool-${tool.id}-${entry.part.index}-${orderedIndex}`}>
            <div className={`browser-chat-tool-call${isSubagentSpawnTool(executedTool.name, executedTool.input) ? ' has-subagents' : ''}`}>
              {isSubagentSpawnTool(executedTool.name, executedTool.input) ? (
                <BrowserChatSubagentToolDisclosure
                  batchId={executedTool.id || tool.id}
                  cardContent={card}
                  className={stateClass}
                  isActive={isActive}
                  onLoadSubagentRecords={onLoadSubagentRecords}
                  onResolveToolConfirmation={onResolveToolConfirmation}
                  onSelectTool={onSelectTool}
                  onResume={onResumeHumanVerification}
                  pendingToolConfirmation={pendingToolConfirmation}
                  resolvingConfirmationAction={resolvingConfirmationAction}
                  resolvingConfirmationId={resolvingConfirmationId}
                  resuming={resumingHumanVerification}
                  running={running}
                  structuredSubagents={structuredSubagents}
                  title={`${label}${meta ? ` - ${meta}` : ''}`}
                  tool={executedTool}
                  toolResult={executedTool.rawResult ?? executedTool.result}
                />
              ) : (
                <div className="browser-chat-tool-card-row">
                  <button
                    aria-label={`${label}${meta ? ` - ${meta}` : ''}`}
                    className={`browser-chat-tool-card browser-chat-ai-call-card${stateClass}`}
                    onClick={() => onSelectTool(toolDetail)}
                    type="button"
                  >
                    {card}
                  </button>
                  <BrowserChatToolScreenshotButton tool={executedTool} />
                </div>
              )}
              <BrowserChatToolConfirmationActions
                pending={pendingConfirmation}
                resolvingConfirmationAction={resolvingConfirmationAction}
                resolvingConfirmationId={resolvingConfirmationId}
                onResolveToolConfirmation={onResolveToolConfirmation}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
});

const BrowserChatExecutedCycleGroup = memo(function BrowserChatExecutedCycleGroup({
  cycles,
  logs,
  onLoadSubagentRecords,
  onResolveToolConfirmation,
  onResumeHumanVerification,
  onSelectTool,
  pendingToolConfirmation,
  resolvingConfirmationAction,
  resolvingConfirmationId,
  resumingHumanVerification,
  running,
  structuredSubagents,
  toolDetails,
}: BrowserChatAiCycleCommonProps & {
  cycles: BrowserChatAiOutputCycle[];
}) {
  const showReasoning = useContext(BrowserChatReasoningVisibilityContext);
  const toolCount = cycles.reduce((count, cycle) => (
    count + cycle.output.tools.filter((_tool, index) => toolDetails.has(aiCycleToolKey(cycle.id, index))).length
  ), 0);
  const reasoningCount = showReasoning ? cycles.reduce((count, cycle) => count + cycle.output.reasoning.length, 0) : 0;
  if (toolCount === 1 && reasoningCount === 0) {
    return (
      <div className="browser-chat-single-tool-group">
        {cycles.map((cycle) => (
          <BrowserChatAiCycleLine
            cycle={cycle}
            key={cycle.id}
            logs={logs}
            onLoadSubagentRecords={onLoadSubagentRecords}
            onResolveToolConfirmation={onResolveToolConfirmation}
            onResumeHumanVerification={onResumeHumanVerification}
            onSelectTool={onSelectTool}
            pendingToolConfirmation={pendingToolConfirmation}
            resolvingConfirmationAction={resolvingConfirmationAction}
            resolvingConfirmationId={resolvingConfirmationId}
            resumingHumanVerification={resumingHumanVerification}
            running={running}
            structuredSubagents={structuredSubagents}
            toolDetails={toolDetails}
          />
        ))}
      </div>
    );
  }

  return (
    <section className="browser-chat-ai-line-collapse browser-chat-executed-collapse browser-chat-tool-chips is-expanded">
      <div className="browser-chat-executed-body">
        {cycles.map((cycle) => (
          <div className="browser-chat-executed-entry" key={cycle.id}>
            <BrowserChatAiCycleLine
              cycle={cycle}
              logs={logs}
              onLoadSubagentRecords={onLoadSubagentRecords}
              onResolveToolConfirmation={onResolveToolConfirmation}
              onResumeHumanVerification={onResumeHumanVerification}
              onSelectTool={onSelectTool}
              pendingToolConfirmation={pendingToolConfirmation}
              resolvingConfirmationAction={resolvingConfirmationAction}
              resolvingConfirmationId={resolvingConfirmationId}
              resumingHumanVerification={resumingHumanVerification}
              running={running}
              structuredSubagents={structuredSubagents}
              toolDetails={toolDetails}
            />
          </div>
        ))}
      </div>
    </section>
  );
});

const BrowserChatManualVerificationCard = memo(function BrowserChatManualVerificationCard({
  onResume,
  resuming,
}: {
  onResume?: () => void | Promise<void>;
  resuming?: boolean;
}) {
  const { t } = useI18n();
  return (
    <section className="browser-chat-manual-verification" role="status">
      <span aria-hidden="true" className="browser-chat-manual-verification-icon"><Lock size={18} /></span>
      <div>
        <strong>{t('需要人工完成验证')}</strong>
        <p>{t('请在浏览器中完成验证码、登录/安全验证或其他需要本人确认的步骤。')}</p>
        <small>{t('完成后点击按钮，AI 会从当前浏览器和当前对话回合继续执行。')}</small>
        {onResume ? (
          <button className="ui-button ui-button--primary browser-chat-verification-resume" disabled={resuming} onClick={() => void onResume()} type="button">
            <span aria-hidden="true" className="browser-chat-verification-resume-icon">
              {resuming ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
            </span>
            {resuming ? t('正在继续') : t('校验完成，继续执行')}
          </button>
        ) : null}
      </div>
    </section>
  );
});

type BrowserChatSubagentView = {
  id: string;
  title: string;
  instruction: string;
  createdAt: string;
  updatedAt: string;
  status: 'queued' | 'running' | 'passed' | 'blocked' | 'failed';
  content: string;
  summary?: string;
  resumable: boolean;
  toolCount: number;
  currentAction?: string;
  steps: StepExecutionResult[];
  outputCycles: BrowserChatAiOutputCycle[];
};

type BrowserChatSubagentPanelContextValue = {
  selectedSubagentId: string | null;
  closeSubagent: () => void;
  openSubagent: (subagentId: string) => void;
};

const BrowserChatSubagentPanelContext = createContext<BrowserChatSubagentPanelContextValue | null>(null);

const BROWSER_CHAT_SUBAGENT_PANEL_DEFAULT_WIDTH = 680;
const BROWSER_CHAT_SUBAGENT_PANEL_MIN_WIDTH = 420;
const BROWSER_CHAT_SUBAGENT_PANEL_VIEWPORT_GUTTER = 48;

function browserChatClampSubagentPanelWidth(width: number) {
  if (typeof window === 'undefined') return Math.max(BROWSER_CHAT_SUBAGENT_PANEL_MIN_WIDTH, width);
  const maximumWidth = Math.max(
    BROWSER_CHAT_SUBAGENT_PANEL_MIN_WIDTH,
    window.innerWidth - BROWSER_CHAT_SUBAGENT_PANEL_VIEWPORT_GUTTER,
  );
  return Math.min(Math.max(BROWSER_CHAT_SUBAGENT_PANEL_MIN_WIDTH, width), maximumWidth);
}

function browserChatSubagentStatusPresentation(subagent: Pick<BrowserChatSubagentView, 'status' | 'summary'>) {
  if (subagent.status === 'passed') return { className: 'status-passed', label: '已完成' };
  if (subagent.status === 'failed' && subagent.summary?.trim()) return { className: 'status-partial', label: '已返回结果' };
  if (subagent.status === 'failed') return { className: 'status-failed', label: '执行失败' };
  if (subagent.status === 'blocked') return { className: 'status-blocked', label: '等待处理' };
  if (subagent.status === 'queued') return { className: 'status-running', label: '等待执行' };
  return { className: 'status-running', label: '正在执行' };
}

function browserChatSubagentViewsFromRecords(
  records: BrowserChatSubagentRecord[],
  toolResult?: unknown,
  toolCallId?: string,
): BrowserChatSubagentView[] {
  return browserChatSubagentRecordsForToolCall(records, toolResult, toolCallId)
    .map((record) => ({
      id: record.id,
      title: record.title,
      instruction: record.instruction,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      status: record.status,
      content: record.content,
      summary: record.summary,
      resumable: record.resumable,
      toolCount: record.toolCount,
      currentAction: record.currentAction,
      steps: record.steps,
      outputCycles: record.outputCycles,
    }));
}

const BrowserChatSubagentDetail = memo(function BrowserChatSubagentDetail({
  onSelectTool,
  onResume,
  resuming,
  subagent,
}: {
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  onResume?: () => void | Promise<void>;
  resuming?: boolean;
  subagent: BrowserChatSubagentView;
}) {
  const assistantMessageId = `${subagent.id}:assistant`;
  const operationRunning = subagent.status === 'running' || subagent.status === 'queued';
  const assistantMessage = useMemo<BrowserChatMessage>(() => ({
    id: assistantMessageId,
    role: 'assistant',
    content: operationRunning ? subagent.content : subagent.summary || subagent.content,
    createdAt: subagent.createdAt,
    updatedAt: subagent.updatedAt,
    status: subagent.status === 'queued' ? 'running' : subagent.status,
    stepIndexes: subagent.steps.map((step) => step.index),
    activity: operationRunning && subagent.currentAction
      ? {
          phase: 'subagent:running',
          label: subagent.currentAction,
          updatedAt: subagent.updatedAt,
        }
      : undefined,
  }), [assistantMessageId, operationRunning, subagent]);
  const steps = useMemo(() => subagent.steps.map((step) => ({
    ...step,
    messageId: assistantMessageId,
  })), [assistantMessageId, subagent.steps]);
  const outputCycles = useMemo(() => sortBrowserChatAiOutputCycles(subagent.outputCycles).map((cycle) => ({
    ...cycle,
    messageId: assistantMessageId,
    subagentId: undefined,
  })), [assistantMessageId, subagent.outputCycles]);

  return (
    <div className="browser-chat-subagent-detail">
      <article className="browser-chat-message user">
        <div>
          <BrowserChatInlineMessageContent
            content={subagent.instruction}
            onPreviewImage={() => undefined}
            skills={[]}
          />
        </div>
      </article>
      <article className={`browser-chat-message assistant${operationRunning ? ' is-running' : ''}`}>
        <div>
          <BrowserChatAssistantTimeline
            logs={[]}
            manualVerificationRequired={subagent.status === 'blocked' && subagent.resumable}
            message={assistantMessage}
            outputCycles={outputCycles}
            onResumeHumanVerification={onResume}
            onSelectTool={onSelectTool}
            resumingHumanVerification={resuming}
            running={operationRunning}
            steps={steps}
            subagents={[]}
          />
        </div>
      </article>
    </div>
  );
});

const BrowserChatSubagentPanel = memo(function BrowserChatSubagentPanel({
  loadingRecords,
  onClose,
  onSelectTool,
  onResume,
  resuming,
  subagent,
}: {
  loadingRecords?: boolean;
  onClose: () => void;
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  onResume?: () => void | Promise<void>;
  resuming?: boolean;
  subagent: BrowserChatSubagentView;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const status = browserChatSubagentStatusPresentation(subagent);
  const [closing, setClosing] = useState(false);
  const [panelWidth, setPanelWidth] = useState(BROWSER_CHAT_SUBAGENT_PANEL_DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);
  const closeTimerRef = useRef(0);
  const panelRef = useRef<HTMLElement | null>(null);
  const panelResizeRef = useRef<{ pointerId: number; startWidth: number; startX: number } | null>(null);
  const panelResizeBodyStyleRef = useRef<{ cursor: string; userSelect: string } | null>(null);
  const restorePanelResizeBodyStyles = useCallback(() => {
    const previous = panelResizeBodyStyleRef.current;
    if (!previous) return;
    document.body.style.cursor = previous.cursor;
    document.body.style.userSelect = previous.userSelect;
    panelResizeBodyStyleRef.current = null;
  }, []);
  const finishPanelResize = useCallback((handle?: HTMLDivElement, pointerId?: number) => {
    if (handle && pointerId !== undefined && handle.hasPointerCapture(pointerId)) {
      handle.releasePointerCapture(pointerId);
    }
    panelResizeRef.current = null;
    setResizing(false);
    restorePanelResizeBodyStyles();
  }, [restorePanelResizeBodyStyles]);
  const handlePanelResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || window.innerWidth <= 680) return;
    event.preventDefault();
    const startWidth = panelRef.current?.getBoundingClientRect().width || panelWidth;
    panelResizeRef.current = { pointerId: event.pointerId, startWidth, startX: event.clientX };
    panelResizeBodyStyleRef.current = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  }, [panelWidth]);
  const handlePanelResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = panelResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    setPanelWidth(browserChatClampSubagentPanelWidth(resize.startWidth + resize.startX - event.clientX));
  }, []);
  const handlePanelResizePointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (panelResizeRef.current?.pointerId !== event.pointerId) return;
    finishPanelResize(event.currentTarget, event.pointerId);
  }, [finishPanelResize]);
  const handlePanelResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === 'ArrowLeft' ? 24 : event.key === 'ArrowRight' ? -24 : 0;
    if (!delta) return;
    event.preventDefault();
    setPanelWidth((current) => browserChatClampSubagentPanelWidth(current + delta));
  }, []);
  const requestClose = useCallback(() => {
    if (closeTimerRef.current) return;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = 0;
      onClose();
    }, 180);
  }, [onClose]);

  useEscapeDismiss(true, requestClose);
  useEffect(() => {
    const handleResize = () => setPanelWidth((current) => browserChatClampSubagentPanelWidth(current));
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
      restorePanelResizeBodyStyles();
    };
  }, [restorePanelResizeBodyStyles]);

  return createPortal((
    <div className={`browser-chat-subagent-panel-layer${closing ? ' is-closing' : ''}`} onMouseDown={requestClose}>
      <aside
        aria-labelledby={titleId}
        aria-modal="true"
        className={`browser-chat-subagent-panel${resizing ? ' is-resizing' : ''}`}
        onMouseDown={(event) => event.stopPropagation()}
        ref={panelRef}
        role="dialog"
        style={{ '--browser-chat-subagent-panel-width': `${panelWidth}px` } as CSSProperties}
      >
        <div
          aria-label={t('调整子 Agent 侧边栏宽度')}
          aria-orientation="vertical"
          className="browser-chat-subagent-panel-resizer"
          onKeyDown={handlePanelResizeKeyDown}
          onLostPointerCapture={handlePanelResizePointerEnd}
          onPointerCancel={handlePanelResizePointerEnd}
          onPointerDown={handlePanelResizePointerDown}
          onPointerMove={handlePanelResizePointerMove}
          onPointerUp={handlePanelResizePointerEnd}
          role="separator"
          tabIndex={0}
        />
        <header className="browser-chat-subagent-panel-header">
          <div className="browser-chat-subagent-panel-heading">
            <span className={`browser-chat-subagent-status-icon ${status.className}`} aria-hidden="true">
              {loadingRecords || subagent.status === 'running'
                ? <Loader2 className="spin" size={14} />
                : subagent.status === 'queued'
                  ? <Clock3 size={14} />
                : subagent.status === 'passed' || status.className === 'status-partial'
                  ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}
            </span>
            <div>
              <h2 id={titleId}>{subagent.title}</h2>
              <p>
                {loadingRecords ? t('正在加载消息') : t(status.label)}
                {' · '}
                {t('{count} 个工具', { count: subagent.toolCount })}
              </p>
            </div>
          </div>
          <button aria-label={t('关闭子 Agent 详情')} className="ui-icon-button browser-chat-subagent-panel-close" onClick={requestClose} title={t('关闭')} type="button">
            <X size={18} />
          </button>
        </header>
        <div className="browser-chat-subagent-panel-body">
          <BrowserChatSubagentDetail
            onSelectTool={onSelectTool}
            onResume={onResume}
            resuming={resuming}
            subagent={subagent}
          />
        </div>
      </aside>
    </div>
  ), document.body);
});

const BrowserChatSubagentList = memo(function BrowserChatSubagentList({
  loadingRecords,
  onResolveToolConfirmation,
  onSelectTool,
  onResume,
  pendingToolConfirmation,
  resolvingConfirmationAction,
  resolvingConfirmationId,
  resuming,
  subagents = [],
}: {
  loadingRecords?: boolean;
  onResolveToolConfirmation?: (confirmationId: string, action: BrowserChatToolConfirmationAction) => void | Promise<void>;
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  onResume?: () => void | Promise<void>;
  pendingToolConfirmation?: BrowserChatToolConfirmation;
  resolvingConfirmationAction?: BrowserChatToolConfirmationAction | null;
  resolvingConfirmationId?: string | null;
  resuming?: boolean;
  subagents?: BrowserChatSubagentView[];
}) {
  const { t } = useI18n();
  const panel = useContext(BrowserChatSubagentPanelContext);
  const selectedSubagent = panel?.selectedSubagentId
    ? subagents.find((subagent) => subagent.id === panel.selectedSubagentId)
    : undefined;
  if (!subagents.length && !loadingRecords) return null;
  return (
    <div className="browser-chat-executed-body browser-chat-subagent-list">
      {loadingRecords && !subagents.length ? (
        <div className="browser-chat-agent-empty browser-chat-agent-thinking" role="status">
          <Loader2 className="spin" size={14} />
          <span>{t('正在加载子 Agent 消息')}</span>
        </div>
      ) : null}
      {subagents.map((subagent) => {
        const status = browserChatSubagentStatusPresentation(subagent);
        const pendingConfirmation = pendingToolConfirmation?.subagentId === subagent.id
          ? pendingToolConfirmation
          : undefined;
        return (
          <div className="browser-chat-subagent-item" key={subagent.id}>
            <button
              aria-haspopup="dialog"
              aria-pressed={panel?.selectedSubagentId === subagent.id}
              className="browser-chat-subagent-row"
              onClick={() => panel?.openSubagent(subagent.id)}
              title={t('查看子 Agent 详情')}
              type="button"
            >
              <span className={`browser-chat-subagent-status-icon ${status.className}`} aria-hidden="true">
                {loadingRecords || subagent.status === 'running'
                  ? <Loader2 className="spin" size={14} />
                  : subagent.status === 'queued'
                    ? <Clock3 size={14} />
                  : subagent.status === 'passed' || status.className === 'status-partial'
                    ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}
              </span>
              <span className="browser-chat-subagent-row-copy">
                <span className="browser-chat-subagent-row-title">{subagent.title}</span>
                <span className="browser-chat-subagent-row-meta">
                  {loadingRecords ? t('正在加载消息') : t(status.label)}
                  {' · '}
                  {t('{count} 个工具', { count: subagent.toolCount })}
                </span>
              </span>
              <PanelRight aria-hidden="true" className="browser-chat-subagent-row-open" size={15} />
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
      {selectedSubagent && panel ? (
        <BrowserChatSubagentPanel
          loadingRecords={loadingRecords}
          onClose={panel.closeSubagent}
          onSelectTool={onSelectTool}
          onResume={onResume}
          resuming={resuming}
          subagent={selectedSubagent}
        />
      ) : null}
    </div>
  );
});

const BrowserChatProcessDisclosure = memo(function BrowserChatProcessDisclosure({
  autoOpen,
  children,
  hasCachedRecords,
  label,
  message,
  onCollapse,
  onExpand,
  running,
}: {
  autoOpen: boolean;
  children: ReactNode;
  hasCachedRecords: boolean;
  label: string;
  message: BrowserChatMessage;
  onCollapse?: () => void;
  onExpand?: () => Promise<void> | void;
  running: boolean;
}) {
  const { t } = useI18n();
  const bodyId = useId();
  const [expanded, setExpanded] = useState(autoOpen);
  const [bodyMounted, setBodyMounted] = useState(autoOpen);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const loadingRecordsRef = useRef(false);
  const desiredExpandedRef = useRef(autoOpen);
  const openFrameRef = useRef(0);
  const previousAutoOpenRef = useRef(autoOpen);
  const autoOpenedAtRef = useRef(autoOpen ? Date.now() : 0);
  const autoCloseTimerRef = useRef(0);
  const [liveNowMs, setLiveNowMs] = useState(() => Date.now());
  const elapsed = formatBrowserChatElapsedTime(browserChatMessageElapsedMs(message, running ? liveNowMs : undefined));
  const setDisclosureExpanded = useCallback((nextExpanded: boolean) => {
    if (autoCloseTimerRef.current) window.clearTimeout(autoCloseTimerRef.current);
    autoCloseTimerRef.current = 0;
    desiredExpandedRef.current = nextExpanded;
    if (openFrameRef.current) cancelAnimationFrame(openFrameRef.current);
    openFrameRef.current = 0;
    if (!nextExpanded) {
      setExpanded(false);
      setBodyMounted(false);
      onCollapse?.();
      return;
    }
    setBodyMounted(true);
    openFrameRef.current = requestAnimationFrame(() => {
      openFrameRef.current = 0;
      if (desiredExpandedRef.current) setExpanded(true);
    });
  }, [onCollapse]);
  const loadProcessRecords = useCallback(() => {
    if (!onExpand || loadingRecordsRef.current) return;
    try {
      const pending = onExpand();
      if (!pending) return;
      loadingRecordsRef.current = true;
      if (!hasCachedRecords) setLoadingRecords(true);
      void Promise.resolve(pending).finally(() => {
        loadingRecordsRef.current = false;
        if (!hasCachedRecords) setLoadingRecords(false);
      });
    } catch {
      loadingRecordsRef.current = false;
      setLoadingRecords(false);
    }
  }, [hasCachedRecords, onExpand]);

  useEffect(() => {
    if (hasCachedRecords) setLoadingRecords(false);
  }, [hasCachedRecords]);
  const toggleDisclosure = useCallback(() => {
    const nextExpanded = !desiredExpandedRef.current;
    setDisclosureExpanded(nextExpanded);
    if (nextExpanded) loadProcessRecords();
  }, [loadProcessRecords, setDisclosureExpanded]);

  useEffect(() => {
    const wasAutoOpen = previousAutoOpenRef.current;
    if (autoOpen) {
      if (!wasAutoOpen) autoOpenedAtRef.current = Date.now();
      setDisclosureExpanded(true);
    } else if (wasAutoOpen) {
      // Re-read the persisted process once the run finishes. A tool-details
      // request made while the turn was still running may only contain an
      // intermediate subset of the final traces.
      loadProcessRecords();
      const minimumOpenMs = 1_200;
      const remainingOpenMs = Math.max(0, minimumOpenMs - (Date.now() - autoOpenedAtRef.current));
      if (remainingOpenMs > 0) {
        autoCloseTimerRef.current = window.setTimeout(() => {
          autoCloseTimerRef.current = 0;
          setDisclosureExpanded(false);
        }, remainingOpenMs);
      } else {
        setDisclosureExpanded(false);
      }
    }
    previousAutoOpenRef.current = autoOpen;
  }, [autoOpen, loadProcessRecords, setDisclosureExpanded]);

  useEffect(() => () => {
    if (openFrameRef.current) cancelAnimationFrame(openFrameRef.current);
    if (autoCloseTimerRef.current) window.clearTimeout(autoCloseTimerRef.current);
  }, []);

  useEffect(() => {
    if (!running) return undefined;
    setLiveNowMs(Date.now());
    const timer = window.setInterval(() => setLiveNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);

  return (
    <section className={`browser-chat-process-disclosure${expanded ? ' is-expanded' : ''}`}>
      <button
        aria-controls={bodyId}
        aria-expanded={expanded}
        className="browser-chat-process-summary"
        onClick={toggleDisclosure}
        type="button"
      >
        {running ? <Loader2 aria-hidden="true" className="spin" size={13} /> : null}
        <span>{label}</span>
        {elapsed ? <small>{elapsed}</small> : null}
        <ChevronDown aria-hidden="true" className="browser-chat-process-chevron" size={14} />
      </button>
      <div
        aria-hidden={!expanded}
        className="browser-chat-process-body-shell"
        id={bodyId}
        inert={!expanded}
      >
        {bodyMounted ? (
          <div className="browser-chat-process-body">
            <div className="browser-chat-process-body-content">
              {loadingRecords ? (
                <BeautifulLoadingState
                  className="browser-chat-agent-thinking browser-chat-tool-records-loading"
                  label={t('正在加载工具记录')}
                  showElapsed={false}
                  variant="orbit"
                />
              ) : null}
              {children}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
});

const BrowserChatStreamingAnswer = memo(function BrowserChatStreamingAnswer({
  hidden,
  running,
  text,
}: {
  hidden: boolean;
  running: boolean;
  text: string;
}) {
  if (hidden || !text.trim()) return null;
  return (
    <div className={`browser-chat-answer${running ? ' is-streaming' : ''}`}>
      <BrowserChatMarkdown markdown={text} />
    </div>
  );
});

const BrowserChatAssistantTimeline = memo(function BrowserChatAssistantTimeline({
  logs: liveLogs,
  manualVerificationRequired,
  message,
  onLoadProcessRecords,
  outputCycles: liveOutputCycles,
  onResolveToolConfirmation,
  onResumeHumanVerification,
  onSelectTool,
  pendingToolConfirmation,
  resolvingConfirmationAction,
  resolvingConfirmationId,
  resumingHumanVerification,
  running,
  steps: liveSteps,
  subagents: liveSubagents,
}: {
  logs: BrowserChatLogRecord[];
  manualVerificationRequired?: boolean;
  message: BrowserChatMessage;
  onLoadProcessRecords?: (signal?: AbortSignal) => Promise<BrowserChatMessageRecordPage>;
  outputCycles: BrowserChatAiOutputCycle[];
  onResolveToolConfirmation?: (confirmationId: string, action: BrowserChatToolConfirmationAction) => void | Promise<void>;
  onResumeHumanVerification?: () => void | Promise<void>;
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  pendingToolConfirmation?: BrowserChatToolConfirmation;
  resolvingConfirmationAction?: BrowserChatToolConfirmationAction | null;
  resolvingConfirmationId?: string | null;
  resumingHumanVerification?: boolean;
  running: boolean;
  steps: StepExecutionResult[];
  subagents: BrowserChatSubagentRecord[];
}) {
  const showReasoning = useContext(BrowserChatReasoningVisibilityContext);
  const { t } = useI18n();
  const [transientRecords, setTransientRecords] = useState<BrowserChatMessageRecordPage | null>(null);
  const recordsAbortRef = useRef<AbortController | null>(null);
  const loadHistoricalProcessRecords = useCallback(async () => {
    if (!onLoadProcessRecords || running) return;
    recordsAbortRef.current?.abort();
    const controller = new AbortController();
    recordsAbortRef.current = controller;
    try {
      const records = await onLoadProcessRecords(controller.signal);
      if (!controller.signal.aborted) setTransientRecords(records);
    } catch {
      // Historical process details are optional; collapsing or a transient read
      // failure must not affect the message itself.
    } finally {
      if (recordsAbortRef.current === controller) recordsAbortRef.current = null;
    }
  }, [onLoadProcessRecords, running]);
  const releaseHistoricalProcessRecords = useCallback(() => {
    recordsAbortRef.current?.abort();
    recordsAbortRef.current = null;
    setTransientRecords(null);
  }, []);
  useEffect(() => releaseHistoricalProcessRecords, [releaseHistoricalProcessRecords]);
  const logs = running ? liveLogs : transientRecords?.logs ?? liveLogs;
  const outputCycles = running ? liveOutputCycles : transientRecords?.outputCycles ?? liveOutputCycles;
  const steps = running ? liveSteps : transientRecords?.steps ?? liveSteps;
  const subagents = running ? liveSubagents : transientRecords?.subagents ?? liveSubagents;
  const selectTool = useCallback((detail: BrowserChatToolDetail) => {
    const confirmation = toolUserActionForTool(
      logs,
      detail.stepIndex,
      detail.tool.name,
      detail.tool.input,
    );
    onSelectTool({
      ...detail,
      confirmationScreenshotUrl: confirmation?.screenshotUrl,
    });
  }, [logs, onSelectTool]);
  const finalText = stringFromUnknown(message.content);
  const textStreaming = browserChatMessageIsTextStreaming(message);
  const normalizedFinalText = finalText.replace(/\s+/g, ' ').trim();
  const aiOutputCycles = useMemo(() => sortBrowserChatAiOutputCycles(outputCycles.filter((cycle) => !cycle.subagentId)
    .map((cycle) => (showReasoning ? cycle : {
      ...cycle,
      output: {
        ...cycle.output,
        parts: cycle.output.parts.filter((part) => part.kind !== 'reasoning'),
        reasoning: [],
      },
    }))
    .filter((cycle) => hasAiOutputView(cycle.output))), [outputCycles, showReasoning]);
  const terminalAnswerCycleIndex = message.status === 'passed'
    ? browserChatTerminalAnswerCycleIndex(aiOutputCycles)
    : -1;
  const processAiOutputCycles = useMemo(() => {
    if (!normalizedFinalText) return aiOutputCycles;
    return aiOutputCycles.map((cycle, cycleIndex) => {
      const texts = cycle.output.texts.map((text) => (
        cycleIndex === terminalAnswerCycleIndex
        || (!cycle.output.tools.length && text.replace(/\s+/g, ' ').trim() === normalizedFinalText)
          ? ''
          : text
      ));
      return {
        ...cycle,
        output: {
          ...cycle.output,
          parts: cycle.output.parts.filter((part) => (
            part.kind !== 'text' || Boolean(texts[part.index])
          )),
          texts,
        },
      };
    });
  }, [aiOutputCycles, normalizedFinalText, terminalAnswerCycleIndex]);
  const finalTextAnchoredToToolCycle = useMemo(() => (
    aiOutputCycles.some((cycle) => browserChatAiCycleAnchorsText(cycle, finalText))
  ), [aiOutputCycles, finalText]);
  const pairedAiOutputCycles = useMemo(() => processAiOutputCycles.flatMap((cycle) => {
    const hasVisibleNarrative = cycle.output.parts.some((part) => {
      if (part.kind === 'text') return Boolean(cycle.output.texts[part.index]?.trim());
      if (part.kind === 'reasoning') return Boolean(cycle.output.reasoning[part.index]?.trim());
      return false;
    });
    const toolParts = cycle.output.parts.filter((part) => part.kind === 'tool');
    if (hasVisibleNarrative || !toolParts.length) return [cycle];
    return toolParts.flatMap((part, partOrder) => {
      const tool = cycle.output.tools[part.index];
      if (!tool) return [];
      return [{
        ...cycle,
        id: `${cycle.id}:tool-${part.index}-${partOrder}`,
        sourceCycleId: cycle.sourceCycleId || cycle.id,
        output: {
          parts: [{ index: 0, kind: 'tool' as const }],
          reasoning: [],
          texts: [],
          tools: [tool],
        },
      }];
    });
  }), [processAiOutputCycles]);
  const matchedAiCycleToolDetails = useMemo(() => (
    buildAiCycleToolDetailMap(pairedAiOutputCycles, steps, running)
  ), [pairedAiOutputCycles, running, steps]);
  const aiCycleRepresentedToolKeys = new Set([...matchedAiCycleToolDetails.values()].map((detail) => (
    detail.toolIndex >= 0 ? `${detail.stepIndex}:${detail.toolIndex}` : ''
  )).filter(Boolean));
  const waitingForTool = running && steps.some((step) => step.status === 'running' && !(step.tools || []).length);
  const timelineSteps = steps.filter((step) => (step.tools || []).length || (running && step.status === 'running'));
  // Persisted step traces are the source of truth. Keep every trace that could not
  // be matched to an AI output cycle, including tools that have only just started,
  // so the card is rendered before execution finishes.
  const unrepresentedTimelineEntries = timelineSteps.flatMap((step): BrowserChatTimelineStepEntry[] => {
    const visibleToolIndexes = (step.tools || []).flatMap((_tool, toolIndex) => (
      !aiCycleRepresentedToolKeys.has(`${step.index}:${toolIndex}`) ? [toolIndex] : []
    ));
    if (visibleToolIndexes.length) return [{ step, visibleToolIndexes }];
    return [];
  });
  const hasPendingConfirmation = Boolean(pendingToolConfirmation);
  const hasSubagentPendingConfirmation = Boolean(
    pendingToolConfirmation?.subagentId
    && subagents.some((subagent) => subagent.id === pendingToolConfirmation.subagentId),
  );
  const aiCyclesContainPendingConfirmation = hasPendingConfirmation && pairedAiOutputCycles.some((cycle) => (
    cycle.output.tools.some((tool, index) => {
      const toolDetail = matchedAiCycleToolDetails.get(aiCycleToolKey(cycle.id, index));
      return Boolean(pendingConfirmationForTool({
        pending: pendingToolConfirmation,
        stepIndex: toolDetail?.stepIndex ?? cycle.stepIndex,
        toolName: tool.name,
        toolInput: toolDetail?.tool.input ?? tool.input,
        toolOk: toolDetail?.tool.ok,
      }));
    })
  ));
  const timelineContainsPendingConfirmation = hasPendingConfirmation && timelineSteps.some((step) => (
    (step.tools || []).some((tool) => Boolean(pendingConfirmationForTool({
      pending: pendingToolConfirmation,
      stepIndex: step.index,
      toolName: tool.name,
      toolInput: tool.input,
      toolOk: tool.ok,
    })))
  ));
  const showPendingTimelineFallback = hasPendingConfirmation
    && !hasSubagentPendingConfirmation
    && !aiCyclesContainPendingConfirmation;
  const showStandalonePendingConfirmation = hasPendingConfirmation
    && !hasSubagentPendingConfirmation
    && !aiCyclesContainPendingConfirmation
    && !timelineContainsPendingConfirmation;
  const splitTimelineEntries = unrepresentedTimelineEntries.map(({ step, visibleToolIndexes }) => {
    const currentToolIndexes: number[] = [];
    const historicalToolIndexes: number[] = [];
    for (const toolIndex of visibleToolIndexes || []) {
      const tool = step.tools?.[toolIndex];
      if (!tool) continue;
      const pendingConfirmation = showPendingTimelineFallback && pendingConfirmationForTool({
        pending: pendingToolConfirmation,
        stepIndex: step.index,
        toolName: tool.name,
        toolInput: tool.input,
        toolOk: tool.ok,
      });
      if ((running && step.status === 'running') || pendingConfirmation) currentToolIndexes.push(toolIndex);
      else historicalToolIndexes.push(toolIndex);
    }
    return { currentToolIndexes, historicalToolIndexes, step };
  });
  const currentTimelineEntries: BrowserChatTimelineStepEntry[] = splitTimelineEntries.flatMap((entry) => (
    entry.currentToolIndexes.length
      ? [{ step: entry.step, visibleToolIndexes: entry.currentToolIndexes }]
      : []
  ));
  const historicalTimelineEntries: BrowserChatTimelineStepEntry[] = splitTimelineEntries.flatMap((entry) => (
    entry.historicalToolIndexes.length
      ? [{ step: entry.step, visibleToolIndexes: entry.historicalToolIndexes }]
      : []
  ));
  const syntheticHistoricalOutput = useMemo(() => {
    const cycles: BrowserChatAiOutputCycle[] = [];
    const toolDetails: Array<[string, BrowserChatToolDetail]> = [];
    for (const { step, visibleToolIndexes } of historicalTimelineEntries) {
      for (const toolIndex of visibleToolIndexes || []) {
        const tool = step.tools?.[toolIndex];
        if (!tool) continue;
        const cycleId = `persisted-step-${message.id}-${step.index}-${toolIndex}`;
        const output: BrowserChatAiOutputView = {
          parts: [{ index: 0, kind: 'tool' }],
          reasoning: [],
          texts: [],
          tools: [{
            id: tool.id || cycleId,
            input: tool.input,
            name: tool.name,
          }],
        };
        cycles.push({ id: cycleId, output, stepIndex: step.index });
        toolDetails.push([
          aiCycleToolKey(cycleId, 0),
          { step, stepIndex: step.index, tool, toolIndex },
        ]);
      }
    }
    return { cycles, toolDetails };
  }, [historicalTimelineEntries, message.id]);
  const aiCycleToolDetails = useMemo(() => new Map<string, BrowserChatToolDetail>([
    ...matchedAiCycleToolDetails,
    ...syntheticHistoricalOutput.toolDetails,
  ]), [matchedAiCycleToolDetails, syntheticHistoricalOutput.toolDetails]);
  const renderedProviderCycles = useMemo(() => pairedAiOutputCycles.filter((cycle) => (
    !cycle.sourceCycleId
    || cycle.output.tools.some((_tool, index) => matchedAiCycleToolDetails.has(aiCycleToolKey(cycle.id, index)))
  )), [matchedAiCycleToolDetails, pairedAiOutputCycles]);
  const renderAiOutputCycles = useMemo(() => {
    return sortBrowserChatAiOutputCycles([
      ...renderedProviderCycles,
      ...syntheticHistoricalOutput.cycles,
    ]);
  }, [renderedProviderCycles, syntheticHistoricalOutput.cycles]);
  const aiOutputCycleEntries = useMemo(() => buildBrowserChatAiCycleRenderEntries(
    renderAiOutputCycles,
    (cycle) => cycle.output.tools.some((_tool, index) => aiCycleToolDetails.has(aiCycleToolKey(cycle.id, index))),
  ), [aiCycleToolDetails, renderAiOutputCycles]);
  const shouldShowStepTimeline = currentTimelineEntries.length > 0 || waitingForTool;
  const manualVerificationPaused = Boolean(manualVerificationRequired) || (message.status === 'blocked' && (
    steps.some((step) => (step.tools || []).some((tool) => tool.name === 'waitForHumanVerification'))
    || pairedAiOutputCycles.some((cycle) => cycle.output.tools.some((tool) => tool.name === 'waitForHumanVerification'))
  ));
  const hasFinalText = Boolean(finalText.trim());
  const hideManualVerificationStatusText = manualVerificationPaused && isBrowserChatManualVerificationStatusText(finalText);
  const hasHistoricalAiOutput = aiOutputCycleEntries.length > 0;
  const hasPersistedProcess = Boolean(message.stepIndexes?.length);
  const hasProcessContent = hasHistoricalAiOutput || hasPersistedProcess || shouldShowStepTimeline || running || hasPendingConfirmation;
  const runningActivityLabel = message.activity?.label?.trim()
    ? t(message.activity.label)
    : t('正在分析页面状态并准备下一步操作');
  const processAutoOpen = running || hasPendingConfirmation;
  const processLabel = running
    ? t('处理中')
    : message.status === 'blocked'
      ? t('等待处理')
      : message.status === 'failed'
        ? t('处理失败')
        : message.status === 'interrupted'
          ? t('已中止')
          : t('已处理');
  const aiCycleCommonProps: BrowserChatAiCycleCommonProps = {
    logs,
    onLoadSubagentRecords: () => { void loadHistoricalProcessRecords(); },
    onResolveToolConfirmation,
    onResumeHumanVerification,
    onSelectTool: selectTool,
    pendingToolConfirmation,
    resolvingConfirmationAction,
    resolvingConfirmationId,
    resumingHumanVerification,
    running,
    structuredSubagents: subagents,
    toolDetails: aiCycleToolDetails,
  };

  return (
    <div className="browser-chat-agent-timeline">
      {hasProcessContent ? (
        <BrowserChatProcessDisclosure
          autoOpen={processAutoOpen}
          hasCachedRecords={
            pairedAiOutputCycles.some((cycle) => cycle.output.tools.length > 0)
            || timelineSteps.some((step) => Boolean(step.tools?.length))
          }
          label={processLabel}
          message={message}
          onCollapse={!running ? releaseHistoricalProcessRecords : undefined}
          onExpand={!running ? loadHistoricalProcessRecords : undefined}
          running={running}
        >
          {aiOutputCycleEntries.map((entry) => (
            entry.kind === 'executed' ? (
              <BrowserChatExecutedCycleGroup
                {...aiCycleCommonProps}
                cycles={entry.cycles}
                key={entry.id}
              />
            ) : (
              <BrowserChatAiCycleLine
                {...aiCycleCommonProps}
                cycle={entry.cycle}
                key={entry.cycle.id}
              />
            )
          ))}
          {running && !finalTextAnchoredToToolCycle ? (
            <BrowserChatStreamingAnswer
              hidden={hideManualVerificationStatusText}
              running={textStreaming}
              text={finalText}
            />
          ) : null}
          {currentTimelineEntries.length ? (
            <div className="browser-chat-tool-stack browser-chat-current-tool-stack">
              {currentTimelineEntries.map(({ step, visibleToolIndexes }) => (
                <div className={`browser-chat-agent-step${running && step.status === 'running' ? ' is-running' : ''}`} key={step.index}>
                  <BrowserChatStepToolCards
                    logs={logs}
                    onLoadSubagentRecords={() => { void loadHistoricalProcessRecords(); }}
                    onResolveToolConfirmation={onResolveToolConfirmation}
                    onResumeHumanVerification={onResumeHumanVerification}
                    onSelectTool={selectTool}
                    onlyPendingConfirmation={showPendingTimelineFallback}
                    pendingToolConfirmation={pendingToolConfirmation}
                    resolvingConfirmationAction={resolvingConfirmationAction}
                    resolvingConfirmationId={resolvingConfirmationId}
                    resumingHumanVerification={resumingHumanVerification}
                    running={running && step.status === 'running'}
                    structuredSubagents={subagents}
                    step={step}
                    visibleToolIndexes={visibleToolIndexes}
                  />
                </div>
              ))}
            </div>
          ) : null}
          {showStandalonePendingConfirmation && pendingToolConfirmation ? (
            <BrowserChatPendingToolConfirmationCard
              pending={pendingToolConfirmation}
              resolvingConfirmationAction={resolvingConfirmationAction}
              resolvingConfirmationId={resolvingConfirmationId}
              onResolveToolConfirmation={onResolveToolConfirmation}
            />
          ) : null}
          {running && !hasPendingConfirmation ? (
            <BeautifulLoadingState
              className={`browser-chat-agent-thinking${hasHistoricalAiOutput || shouldShowStepTimeline ? ' is-continuation' : ''}`}
              detail={runningActivityLabel}
              label={t('AI 正在处理当前请求')}
              showElapsed
              startedAt={message.activity?.updatedAt}
            />
          ) : null}
        </BrowserChatProcessDisclosure>
      ) : null}
      {manualVerificationPaused ? (
        <BrowserChatManualVerificationCard
          onResume={!running ? onResumeHumanVerification : undefined}
          resuming={resumingHumanVerification}
        />
      ) : null}
      {!running && hasFinalText && (message.status === 'passed' || !finalTextAnchoredToToolCycle) ? (
        <BrowserChatStreamingAnswer
          hidden={hideManualVerificationStatusText}
          running={false}
          text={finalText}
        />
      ) : null}
      {!hasFinalText && !hasProcessContent && !manualVerificationPaused ? (
        <p className="browser-chat-agent-empty">{t('AI 已完成本轮操作，未返回额外文本。')}</p>
      ) : null}
      {!running ? <BrowserChatMessageArtifactCards artifacts={message.artifacts} /> : null}
    </div>
  );
});

const BrowserChatMessageItem = memo(function BrowserChatMessageItem({
  generatingAutomationMessageId,
  skillsById,
  generatingSkillMessageId,
  item,
  itemLogs,
  itemOutputCycles,
  itemSubagents,
  itemSteps,
  manualVerificationRequired,
  onGenerateAutomationCase,
  onGenerateSkill,
  onLoadMessageRecords,
  onPreviewImage,
  onResolveToolConfirmation,
  onResumeHumanVerification,
  onSelectTool,
  onShowLogs,
  pendingToolConfirmation,
  resolvingConfirmationAction,
  resolvingConfirmationId,
  resumingHumanVerification,
}: {
  generatingAutomationMessageId: string | null;
  generatingSkillMessageId: string | null;
  item: BrowserChatMessage;
  itemLogs: BrowserChatLogRecord[];
  itemOutputCycles: BrowserChatAiOutputCycle[];
  itemSubagents: BrowserChatSubagentRecord[];
  itemSteps: StepExecutionResult[];
  manualVerificationRequired?: boolean;
  onGenerateAutomationCase: (messageId: string) => void | Promise<void>;
  onGenerateSkill: (messageId: string) => void | Promise<void>;
  onLoadMessageRecords: BrowserChatMessageRecordLoader;
  onPreviewImage: (attachment: BrowserChatAttachment) => void;
  onResolveToolConfirmation?: (confirmationId: string, action: BrowserChatToolConfirmationAction) => void | Promise<void>;
  onResumeHumanVerification?: () => void | Promise<void>;
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  onShowLogs: (messageId: string) => void;
  pendingToolConfirmation?: BrowserChatToolConfirmation;
  resolvingConfirmationAction?: BrowserChatToolConfirmationAction | null;
  resolvingConfirmationId?: string | null;
  resumingHumanVerification?: boolean;
  skillsById: Map<string, SkillRecord>;
}) {
  const { t } = useI18n();
  const operationRunning = item.role === 'assistant' && item.status === 'running';
  const waitingInQueue = item.role === 'user' && item.status === 'queued';
  const hasExecutionRecords = browserChatAssistantMessageHasExecutionMetadata(item)
    || itemSteps.length > 0
    || itemLogs.length > 0;
  const canGenerateSkill = item.role === 'assistant' && item.status !== 'running' && hasExecutionRecords;
  const canGenerateAutomationCase = canGenerateSkill;
  const actionDisabled = Boolean(generatingSkillMessageId || generatingAutomationMessageId);
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
    <article className={`browser-chat-message ${item.role}${operationRunning ? ' is-running' : ''}${waitingInQueue ? ' is-queued' : ''}`}>
      <div>
        {item.role === 'assistant' ? (
          <BrowserChatAssistantTimeline
            logs={itemLogs}
            manualVerificationRequired={manualVerificationRequired}
            message={item}
            onLoadProcessRecords={!operationRunning ? (signal) => onLoadMessageRecords(item.id, { signal }) : undefined}
            outputCycles={itemOutputCycles}
            onResolveToolConfirmation={onResolveToolConfirmation}
            onResumeHumanVerification={onResumeHumanVerification}
            onSelectTool={onSelectTool}
            pendingToolConfirmation={pendingToolConfirmation?.messageId === item.id ? pendingToolConfirmation : undefined}
            resolvingConfirmationAction={resolvingConfirmationAction}
            resolvingConfirmationId={resolvingConfirmationId}
            resumingHumanVerification={resumingHumanVerification}
            running={operationRunning}
            steps={itemSteps}
            subagents={itemSubagents}
          />
        ) : (
          <>
            <BrowserChatInlineMessageContent
              attachments={item.attachments}
              content={item.content}
              onPreviewImage={onPreviewImage}
              skills={messageSkills}
            />
            {waitingInQueue ? <span className="browser-chat-message-queue-status">{t('排队中')}</span> : null}
            {/* <time className="browser-chat-message-time" dateTime={messageUpdateTime(item)}>
              最后更新 {formatLogTime(messageUpdateTime(item))}
            </time> */}
          </>
        )}
        {item.role === 'assistant' ? (
          <div className="browser-chat-message-actions">
            {hasExecutionRecords ? (
              <button className="browser-chat-log-button" onClick={() => onShowLogs(item.id)} type="button">
                <ScrollText size={14} />
                {t('查看日志')}
              </button>
            ) : null}
            {canGenerateSkill ? (
              <button
                className="browser-chat-log-button"
                disabled={actionDisabled}
                onClick={() => void onGenerateSkill(item.id)}
                type="button"
              >
                {generatingSkillMessageId === item.id ? <Loader2 className="spin" size={14} /> : <Sparkles size={14} />}
                {t('生成 Skill')}
              </button>
            ) : null}
            {canGenerateAutomationCase ? (
              <button
                className="browser-chat-log-button"
                disabled={actionDisabled}
                onClick={() => void onGenerateAutomationCase(item.id)}
                type="button"
              >
                {generatingAutomationMessageId === item.id ? <Loader2 className="spin" size={14} /> : <Workflow size={14} />}
                {t('生成用例')}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
});

function browserChatAssistantMessageHasVisibleText(message: BrowserChatMessage, outputCycles: BrowserChatAiOutputCycle[]) {
  return modelBrowserChatAssistantMessageHasVisibleText(
    message,
    [],
    () => outputCycles.flatMap((cycle) => cycle.output.texts),
  );
}

const BrowserChatExecutedGroup = memo(function BrowserChatExecutedGroup({
  items,
  lastAssistantMessageId,
  logIndex,
  sessionAwaitingHuman,
  onLoadMessageRecords,
  outputCycles,
  onResolveToolConfirmation,
  onResumeHumanVerification,
  onSelectTool,
  pendingToolConfirmation,
  resolvingConfirmationAction,
  resolvingConfirmationId,
  resumingHumanVerification,
  subagents,
  stepsByIndex,
}: {
  items: BrowserChatMessage[];
  lastAssistantMessageId?: string;
  logIndex: BrowserChatLogIndex;
  sessionAwaitingHuman?: boolean;
  onLoadMessageRecords: BrowserChatMessageRecordLoader;
  outputCycles: BrowserChatAiOutputCycle[];
  onResolveToolConfirmation?: (confirmationId: string, action: BrowserChatToolConfirmationAction) => void | Promise<void>;
  onResumeHumanVerification?: () => void | Promise<void>;
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  pendingToolConfirmation?: BrowserChatToolConfirmation;
  resolvingConfirmationAction?: BrowserChatToolConfirmationAction | null;
  resolvingConfirmationId?: string | null;
  resumingHumanVerification?: boolean;
  subagents: BrowserChatSubagentRecord[];
  stepsByIndex: Map<number, StepExecutionResult>;
}) {
  const itemViews = items.map((item) => {
    const steps = (item.stepIndexes || [])
      .map((stepIndex) => stepsByIndex.get(stepIndex))
      .filter((step): step is StepExecutionResult => step?.messageId === item.id);
    return {
      item,
      logs: browserChatLogsForMessage(item, logIndex),
      outputCycles: outputCycles.filter((cycle) => cycle.messageId === item.id),
      running: item.status === 'running',
      subagents: subagents.filter((subagent) => subagent.messageId === item.id),
      steps,
    };
  });
  return (
    <article className="browser-chat-message assistant browser-chat-executed-message">
      <div>
        <section className="browser-chat-ai-line-collapse browser-chat-executed-collapse browser-chat-tool-chips is-expanded">
          <div className="browser-chat-executed-body">
            {itemViews.map(({ item, logs, outputCycles: itemOutputCycles, running, steps, subagents: itemSubagents }) => (
              <div className="browser-chat-executed-entry" key={item.id}>
                <BrowserChatAssistantTimeline
                  logs={logs}
                  manualVerificationRequired={Boolean(sessionAwaitingHuman && item.id === lastAssistantMessageId)}
                  message={item}
                  onLoadProcessRecords={!running ? (signal) => onLoadMessageRecords(item.id, { signal }) : undefined}
                  outputCycles={itemOutputCycles}
                  onResolveToolConfirmation={onResolveToolConfirmation}
                  onResumeHumanVerification={onResumeHumanVerification}
                  onSelectTool={onSelectTool}
                  pendingToolConfirmation={pendingToolConfirmation?.messageId === item.id ? pendingToolConfirmation : undefined}
                  resolvingConfirmationAction={resolvingConfirmationAction}
                  resolvingConfirmationId={resolvingConfirmationId}
                  resumingHumanVerification={resumingHumanVerification}
                  running={running}
                  steps={steps}
                  subagents={itemSubagents}
                />
              </div>
            ))}
          </div>
        </section>
      </div>
    </article>
  );
});

const BrowserChatMessageList = memo(function BrowserChatMessageList({
  availableSkills,
  generatingAutomationMessageId,
  generatingSkillMessageId,
  historyHasMore,
  historyLoading,
  lastAssistantMessageId,
  logIndex,
  messages,
  outputCycles,
  onGenerateAutomationCase,
  onGenerateSkill,
  onLoadMessageRecords,
  onLoadEarlier,
  onInitialPositioned,
  onPreviewImage,
  onResolveToolConfirmation,
  onResumeHumanVerification,
  onSelectTool,
  onShowLogs,
  pendingToolConfirmation,
  resolvingConfirmationAction,
  resolvingConfirmationId,
  resumingHumanVerification,
  revealImmediately,
  sessionAwaitingHuman,
  sessionId,
  sessionBusy,
  subagents,
  stepsByIndex,
}: {
  availableSkills: SkillRecord[];
  generatingAutomationMessageId: string | null;
  generatingSkillMessageId: string | null;
  historyHasMore?: boolean;
  historyLoading?: boolean;
  lastAssistantMessageId?: string;
  logIndex: BrowserChatLogIndex;
  messages: BrowserChatMessage[];
  outputCycles: BrowserChatAiOutputCycle[];
  onGenerateAutomationCase: (messageId: string) => void | Promise<void>;
  onGenerateSkill: (messageId: string) => void | Promise<void>;
  onLoadMessageRecords: BrowserChatMessageRecordLoader;
  onLoadEarlier?: () => void | Promise<void>;
  onInitialPositioned?: (sessionId?: string) => void;
  onPreviewImage: (attachment: BrowserChatAttachment) => void;
  onResolveToolConfirmation?: (confirmationId: string, action: BrowserChatToolConfirmationAction) => void | Promise<void>;
  onResumeHumanVerification?: () => void | Promise<void>;
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  onShowLogs: (messageId: string) => void;
  pendingToolConfirmation?: BrowserChatToolConfirmation;
  resolvingConfirmationAction?: BrowserChatToolConfirmationAction | null;
  resolvingConfirmationId?: string | null;
  resumingHumanVerification?: boolean;
  revealImmediately?: boolean;
  sessionAwaitingHuman?: boolean;
  sessionId?: string;
  sessionBusy: boolean;
  subagents: BrowserChatSubagentRecord[];
  stepsByIndex: Map<number, StepExecutionResult>;
}) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(null);
  const [screenshotPreview, setScreenshotPreview] = useState<BrowserChatScreenshotPreview | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const followLatestRef = useRef(true);
  const scrollingToLatestRef = useRef(false);
  const scrollToLatestTimerRef = useRef(0);
  const earlierLoadInFlightRef = useRef(false);
  const earlierLoadArmedRef = useRef(true);
  const historyHeightFrameRef = useRef(0);
  const pendingHistoryHeightRef = useRef<{
    appliedAddedHeight: number;
    baselineScrollHeight: number;
    firstMessageId: string;
  } | null>(null);
  const previousRunStateRef = useRef({ sessionBusy, sessionId });
  const previousSessionIdRef = useRef(sessionId);
  const closeSubagent = useCallback(() => setSelectedSubagentId(null), []);
  const openSubagent = useCallback((subagentId: string) => setSelectedSubagentId(subagentId), []);
  const closeScreenshotPreview = useCallback(() => setScreenshotPreview(null), []);
  const openScreenshotPreview = useCallback((screenshots: BrowserChatRenderableScreenshot[], index = 0) => {
    if (!screenshots.length) return;
    setScreenshotPreview({
      index: Math.max(0, Math.min(index, screenshots.length - 1)),
      screenshots,
    });
  }, []);
  const changeScreenshotPreview = useCallback((index: number) => {
    setScreenshotPreview((current) => current ? { ...current, index } : current);
  }, []);
  const subagentPanelContext = useMemo<BrowserChatSubagentPanelContextValue>(() => ({
    selectedSubagentId,
    closeSubagent,
    openSubagent,
  }), [closeSubagent, openSubagent, selectedSubagentId]);
  const screenshotPreviewContext = useMemo(() => ({ open: openScreenshotPreview }), [openScreenshotPreview]);
  const getScrollContainer = useCallback(() => {
    return scrollRef.current;
  }, []);
  const lastMessage = messages[messages.length - 1];
  const skillsById = useMemo(() => new Map(availableSkills.map((skill) => [skill.id, skill])), [availableSkills]);
  const renderEntries = useMemo(
    () => buildBrowserChatMessageRenderEntries(
      messages,
      logIndex,
      (message) => (
        pendingToolConfirmation?.messageId === message.id
        || Boolean(sessionAwaitingHuman && message.id === lastAssistantMessageId)
        || browserChatAssistantMessageHasVisibleText(
          message,
          outputCycles.filter((cycle) => cycle.messageId === message.id && !cycle.subagentId),
        )
      ),
      browserChatAssistantMessageHasExecutionMetadata,
    ),
    [lastAssistantMessageId, logIndex, messages, outputCycles, pendingToolConfirmation?.messageId, sessionAwaitingHuman],
  );
  const scrollKey = [
    sessionId || '',
    messages.length,
    lastMessage?.id || '',
    lastMessage?.updatedAt || '',
    pendingToolConfirmation?.id || '',
    sessionBusy ? 'busy' : 'idle',
  ].join(':');

  const addLoadedHistoryHeight = useCallback(() => {
    const pending = pendingHistoryHeightRef.current;
    const container = getScrollContainer();
    if (!pending || !container) return;
    const addedHeight = Math.max(0, container.scrollHeight - pending.baselineScrollHeight);
    const unappliedHeight = addedHeight - pending.appliedAddedHeight;
    if (Math.abs(unappliedHeight) > 0.5) {
      const previousScrollBehavior = container.style.scrollBehavior;
      container.style.scrollBehavior = 'auto';
      container.scrollTop += unappliedHeight;
      container.style.scrollBehavior = previousScrollBehavior;
    }
    pending.appliedAddedHeight = addedHeight;
    followLatestRef.current = false;
  }, [getScrollContainer]);

  const settleHistoryHeight = useCallback(() => {
    if (!pendingHistoryHeightRef.current) return;
    if (historyHeightFrameRef.current) cancelAnimationFrame(historyHeightFrameRef.current);
    addLoadedHistoryHeight();
    let remainingFrames = 3;
    const settle = () => {
      addLoadedHistoryHeight();
      remainingFrames -= 1;
      if (remainingFrames > 0) {
        historyHeightFrameRef.current = requestAnimationFrame(settle);
        return;
      }
      historyHeightFrameRef.current = 0;
      pendingHistoryHeightRef.current = null;
      earlierLoadInFlightRef.current = false;
      earlierLoadArmedRef.current = true;
    };
    historyHeightFrameRef.current = requestAnimationFrame(settle);
  }, [addLoadedHistoryHeight]);

  useLayoutEffect(() => {
    const sessionChanged = previousSessionIdRef.current !== sessionId;
    previousSessionIdRef.current = sessionId;
    const messageList = scrollRef.current;
    const initialPositioning = messageList?.dataset.scrollReady !== 'true';
    if (sessionChanged) {
      if (historyHeightFrameRef.current) cancelAnimationFrame(historyHeightFrameRef.current);
      historyHeightFrameRef.current = 0;
      pendingHistoryHeightRef.current = null;
      earlierLoadInFlightRef.current = false;
      earlierLoadArmedRef.current = true;
      setShowScrollToBottom(false);
    }
    const pendingHistoryHeight = pendingHistoryHeightRef.current;
    if (
      !sessionChanged
      && pendingHistoryHeight
      && messages[0]?.id !== pendingHistoryHeight.firstMessageId
    ) {
      settleHistoryHeight();
      return undefined;
    }
    if (earlierLoadInFlightRef.current) return undefined;
    if (!initialPositioning && !sessionChanged && !followLatestRef.current) return undefined;
    let settleFrame = 0;
    let readyFrame = 0;
    let attempts = 0;
    let stableFrames = 0;
    let previousScrollHeight = -1;
    const scrollToBottom = () => {
      const container = getScrollContainer();
      if (!container) return;
      const previousScrollBehavior = container.style.scrollBehavior;
      container.style.scrollBehavior = 'auto';
      container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      container.style.scrollBehavior = previousScrollBehavior;
      followLatestRef.current = true;
      setShowScrollToBottom(false);
    };
    scrollToBottom();
    if (!initialPositioning && !sessionChanged) return undefined;
    messageList?.removeAttribute('data-scroll-ready');
    const settleInitialPosition = () => {
      const container = getScrollContainer();
      if (!container) return;
      scrollToBottom();
      attempts += 1;
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      const scrollHeightStable = Math.abs(container.scrollHeight - previousScrollHeight) < 1;
      stableFrames = distanceFromBottom <= 1 && scrollHeightStable ? stableFrames + 1 : 0;
      previousScrollHeight = container.scrollHeight;
      if (stableFrames < 2 && attempts < 12) {
        settleFrame = requestAnimationFrame(settleInitialPosition);
        return;
      }
      messageList?.setAttribute('data-scroll-ready', 'true');
      readyFrame = requestAnimationFrame(() => {
        scrollToBottom();
        onInitialPositioned?.(sessionId);
      });
    };
    settleFrame = requestAnimationFrame(settleInitialPosition);
    return () => {
      if (settleFrame) cancelAnimationFrame(settleFrame);
      if (readyFrame) cancelAnimationFrame(readyFrame);
    };
  }, [getScrollContainer, messages, onInitialPositioned, scrollKey, sessionId, settleHistoryHeight]);

  const trackScrollPosition = useCallback(() => {
    const container = getScrollContainer();
    if (!container) return;
    if (container.scrollTop > 0) earlierLoadArmedRef.current = true;
    if (earlierLoadInFlightRef.current) {
      followLatestRef.current = false;
      return;
    }
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (scrollingToLatestRef.current) {
      followLatestRef.current = true;
      setShowScrollToBottom(false);
      return;
    }
    followLatestRef.current = distanceFromBottom <= 16;
    setShowScrollToBottom(distanceFromBottom > 72);
  }, [getScrollContainer]);

  const scrollToLatest = useCallback(() => {
    const container = getScrollContainer();
    if (!container) return;
    if (scrollToLatestTimerRef.current) window.clearTimeout(scrollToLatestTimerRef.current);
    scrollingToLatestRef.current = true;
    followLatestRef.current = true;
    setShowScrollToBottom(false);
    container.scrollTo({
      behavior: 'smooth',
      top: Math.max(0, container.scrollHeight - container.clientHeight),
    });
    scrollToLatestTimerRef.current = window.setTimeout(() => {
      scrollToLatestTimerRef.current = 0;
      scrollingToLatestRef.current = false;
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      followLatestRef.current = distanceFromBottom <= 16;
      setShowScrollToBottom(distanceFromBottom > 72);
    }, 520);
  }, [getScrollContainer]);

  useLayoutEffect(() => {
    const previous = previousRunStateRef.current;
    previousRunStateRef.current = { sessionBusy, sessionId };
    const turnCompleted = previous.sessionId === sessionId && previous.sessionBusy && !sessionBusy;
    if (!turnCompleted || !followLatestRef.current || earlierLoadInFlightRef.current) return undefined;
    const container = getScrollContainer();
    if (!container) return undefined;

    let frame = 0;
    let cancelled = false;
    const startedAt = performance.now();
    const cancelPinning = () => { cancelled = true; };
    const pinToBottom = () => {
      if (cancelled) return;
      container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      followLatestRef.current = true;
      setShowScrollToBottom(false);
      if (performance.now() - startedAt < 420) frame = requestAnimationFrame(pinToBottom);
    };

    container.addEventListener('pointerdown', cancelPinning, { passive: true });
    container.addEventListener('touchstart', cancelPinning, { passive: true });
    container.addEventListener('wheel', cancelPinning, { passive: true });
    pinToBottom();
    return () => {
      cancelled = true;
      if (frame) cancelAnimationFrame(frame);
      container.removeEventListener('pointerdown', cancelPinning);
      container.removeEventListener('touchstart', cancelPinning);
      container.removeEventListener('wheel', cancelPinning);
    };
  }, [getScrollContainer, sessionBusy, sessionId]);

  useEffect(() => {
    const messageList = scrollRef.current;
    const scrollContainer = getScrollContainer();
    if (!messageList || !scrollContainer) return undefined;
    let frame = 0;
    const observedChildren = new Set<Element>();
    const scheduleScrollToBottom = () => {
      if (!followLatestRef.current || earlierLoadInFlightRef.current) return;
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!followLatestRef.current || earlierLoadInFlightRef.current) return;
        scrollContainer.scrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
      });
    };
    const resizeObserver = new ResizeObserver(scheduleScrollToBottom);
    const syncObservedChildren = () => {
      const currentChildren = new Set(Array.from(messageList.children));
      for (const child of observedChildren) {
        if (currentChildren.has(child)) continue;
        resizeObserver.unobserve(child);
        observedChildren.delete(child);
      }
      for (const child of currentChildren) {
        if (observedChildren.has(child)) continue;
        observedChildren.add(child);
        resizeObserver.observe(child);
      }
    };
    const mutationObserver = new MutationObserver(() => {
      syncObservedChildren();
      scheduleScrollToBottom();
    });
    scrollContainer.addEventListener('scroll', trackScrollPosition, { passive: true });
    syncObservedChildren();
    mutationObserver.observe(messageList, { childList: true, characterData: true, subtree: true });
    return () => {
      scrollContainer.removeEventListener('scroll', trackScrollPosition);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [getScrollContainer, trackScrollPosition]);

  const loadEarlier = useCallback(async () => {
    if (!onLoadEarlier || !historyHasMore || historyLoading || earlierLoadInFlightRef.current) return;
    const container = getScrollContainer();
    if (!container || container.scrollTop > 0) return;
    pendingHistoryHeightRef.current = {
      appliedAddedHeight: 0,
      baselineScrollHeight: container.scrollHeight,
      firstMessageId: messages[0]?.id || '',
    };
    earlierLoadInFlightRef.current = true;
    earlierLoadArmedRef.current = false;
    followLatestRef.current = false;
    try {
      await onLoadEarlier();
    } finally {
      requestAnimationFrame(() => {
        if (!pendingHistoryHeightRef.current) {
          earlierLoadInFlightRef.current = false;
          return;
        }
        const currentContainer = getScrollContainer();
        if (currentContainer && currentContainer.scrollHeight !== pendingHistoryHeightRef.current.baselineScrollHeight) {
          settleHistoryHeight();
          return;
        }
        pendingHistoryHeightRef.current = null;
        earlierLoadInFlightRef.current = false;
        earlierLoadArmedRef.current = true;
      });
    }
  }, [getScrollContainer, historyHasMore, historyLoading, messages, onLoadEarlier, settleHistoryHeight]);

  useEffect(() => {
    const scrollContainer = getScrollContainer();
    if (!scrollContainer || !historyHasMore || !onLoadEarlier) return undefined;
    let previousScrollTop = scrollContainer.scrollTop;
    const handleScroll = () => {
      const currentScrollTop = scrollContainer.scrollTop;
      if (currentScrollTop > 0) {
        earlierLoadArmedRef.current = true;
      }
      const reachedTop = browserChatReachedHistoryTop(previousScrollTop, currentScrollTop);
      previousScrollTop = currentScrollTop;
      if (!reachedTop || !earlierLoadArmedRef.current) return;
      earlierLoadArmedRef.current = false;
      void loadEarlier();
    };
    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      scrollContainer.removeEventListener('scroll', handleScroll);
    };
  }, [getScrollContainer, historyHasMore, loadEarlier, onLoadEarlier]);

  useEffect(() => () => {
    if (historyHeightFrameRef.current) cancelAnimationFrame(historyHeightFrameRef.current);
    if (scrollToLatestTimerRef.current) window.clearTimeout(scrollToLatestTimerRef.current);
  }, []);

  return (
    <BrowserChatSubagentPanelContext.Provider value={subagentPanelContext}>
      <BrowserChatScreenshotPreviewContext.Provider value={screenshotPreviewContext}>
        <div className="browser-chat-message-scroll-shell">
          <div
            className="browser-chat-message-list"
            data-scroll-ready={revealImmediately ? 'true' : undefined}
            ref={scrollRef}
          >
        {historyHasMore && historyLoading ? (
          <div aria-live="polite" className="browser-chat-history-loader" role="status">
            <Loader2 className="spin" size={15} />
            <span>正在加载更早记录…</span>
          </div>
        ) : null}
        <div className="browser-chat-message-list-content">
        {renderEntries.map((entry) => {
        if (entry.kind === 'executed-group') {
          return (
            <BrowserChatExecutedGroup
              items={entry.items}
              key={entry.id}
              lastAssistantMessageId={lastAssistantMessageId}
              logIndex={logIndex}
              onLoadMessageRecords={onLoadMessageRecords}
              onResolveToolConfirmation={onResolveToolConfirmation}
              outputCycles={outputCycles}
              onResumeHumanVerification={onResumeHumanVerification}
              onSelectTool={onSelectTool}
              pendingToolConfirmation={pendingToolConfirmation}
              resolvingConfirmationAction={resolvingConfirmationAction}
              resolvingConfirmationId={resolvingConfirmationId}
              resumingHumanVerification={resumingHumanVerification}
              sessionAwaitingHuman={sessionAwaitingHuman}
              subagents={subagents}
              stepsByIndex={stepsByIndex}
            />
          );
        }
        const item = entry.item;
        const declaredStepIndexes = item.stepIndexes || [];
        const itemSteps = declaredStepIndexes.length
          ? declaredStepIndexes
            .map((stepIndex) => stepsByIndex.get(stepIndex))
            .filter((step): step is StepExecutionResult => step?.messageId === item.id)
          : [...stepsByIndex.values()].filter((step) => step.messageId === item.id);
        const itemLogs = item.role === 'assistant' ? browserChatLogsForMessage(item, logIndex) : [];
        const itemOutputCycles = outputCycles.filter((cycle) => cycle.messageId === item.id);
        const itemSubagents = subagents.filter((subagent) => subagent.messageId === item.id);
        return (
          <BrowserChatMessageItem
            generatingAutomationMessageId={generatingAutomationMessageId}
            generatingSkillMessageId={generatingSkillMessageId}
            item={item}
            itemLogs={itemLogs}
            itemOutputCycles={itemOutputCycles}
            itemSubagents={itemSubagents}
            itemSteps={itemSteps}
            key={item.id}
            manualVerificationRequired={Boolean(sessionAwaitingHuman && item.id === lastAssistantMessageId)}
            onGenerateAutomationCase={onGenerateAutomationCase}
            onGenerateSkill={onGenerateSkill}
            onLoadMessageRecords={onLoadMessageRecords}
            onPreviewImage={onPreviewImage}
            onResolveToolConfirmation={onResolveToolConfirmation}
            onResumeHumanVerification={onResumeHumanVerification}
            onSelectTool={onSelectTool}
            onShowLogs={onShowLogs}
            pendingToolConfirmation={pendingToolConfirmation}
            resolvingConfirmationAction={resolvingConfirmationAction}
            resolvingConfirmationId={resolvingConfirmationId}
            resumingHumanVerification={resumingHumanVerification}
            skillsById={skillsById}
          />
        );
        })}
          <div aria-hidden="true" className="browser-chat-message-list-end" />
        </div>
          </div>
          <button
            aria-hidden={!showScrollToBottom}
            aria-label={t('滚动到底部')}
            className={`browser-chat-scroll-to-bottom${showScrollToBottom ? ' is-visible' : ' is-hidden'}`}
            onClick={scrollToLatest}
            tabIndex={showScrollToBottom ? 0 : -1}
            title={showScrollToBottom ? t('滚动到底部') : undefined}
            type="button"
          >
            <ArrowDown aria-hidden="true" size={20} />
          </button>
          <ProgressiveBlur className="browser-chat-message-progressive-blur" height="52px" position="both" />
        </div>
        <BrowserChatScreenshotPreviewDialog
          onChange={changeScreenshotPreview}
          onClose={closeScreenshotPreview}
          preview={screenshotPreview}
        />
      </BrowserChatScreenshotPreviewContext.Provider>
    </BrowserChatSubagentPanelContext.Provider>
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

function compactContextTokens(tokens: number) {
  if (tokens >= 1_000_000) return { decimalPlaces: tokens < 10_000_000 ? 1 : 0, suffix: 'm', value: tokens / 1_000_000 };
  if (tokens >= 1_000) return { decimalPlaces: tokens < 10_000 ? 1 : 0, suffix: 'k', value: tokens / 1_000 };
  return { decimalPlaces: 0, suffix: '', value: tokens };
}

function BrowserChatSafetySelector({
  contextUsage,
  disabled,
  onSafetyModeChange,
  safetyMode,
}: {
  contextUsage?: BrowserChatSession['contextUsage'];
  disabled: boolean;
  onSafetyModeChange: (mode: BrowserChatSafetyMode) => void;
  safetyMode: BrowserChatSafetyMode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const safetyLabel = safetyMode === 'full' ? t('完全模式') : t('严格模式');
  const currentTokens = Math.max(0, contextUsage?.currentTokens || 0);
  const maxTokens = Math.max(1, contextUsage?.maxTokens || 256_000);
  const contextPercent = Math.min(100, Math.round((currentTokens / maxTokens) * 100));
  const textTokens = Math.max(0, contextUsage?.textTokens || 0);
  const toolTokens = Math.max(0, contextUsage?.toolTokens || 0);
  const imageTokens = Math.max(0, contextUsage?.imageTokens || 0);
  const currentDisplay = compactContextTokens(currentTokens);
  const maxDisplay = compactContextTokens(maxTokens);
  const textDisplay = compactContextTokens(textTokens);
  const toolDisplay = compactContextTokens(toolTokens);
  const imageDisplay = compactContextTokens(imageTokens);

  useEffect(() => {
    if (!disabled) return;
    setOpen(false);
  }, [disabled]);

  return (
    <div className="browser-chat-mode-selector" data-i18n-skip>
      <Popover isOpen={open} onOpenChange={setOpen}>
        <Button
          aria-controls={menuId}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={t('执行权限：{mode}', { mode: safetyLabel })}
          className="browser-chat-mode-selector-trigger"
          isDisabled={disabled}
          variant="ghost"
        >
          <ShieldCheck aria-hidden="true" size={18} />
          <span>{safetyLabel}</span>
          <ChevronDown aria-hidden="true" className={open ? 'is-open' : undefined} size={14} />
        </Button>
        <Popover.Content
          containerPadding={8}
          offset={6}
          placement="top start"
        >
          <Popover.Dialog aria-label={t('执行权限')} className="browser-chat-mode-selector-dialog" id={menuId}>
            <section className="browser-chat-mode-selector-section">
              <header>
                <strong>{t('执行权限')}</strong>
              </header>
              <div aria-label={t('安全性')} className="browser-chat-mode-selector-options" role="radiogroup">
                <button
                  aria-checked={safetyMode === 'strict'}
                  className={safetyMode === 'strict' ? 'active' : undefined}
                  onClick={() => {
                    onSafetyModeChange('strict');
                    setOpen(false);
                  }}
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
                  onClick={() => {
                    onSafetyModeChange('full');
                    setOpen(false);
                  }}
                  role="radio"
                  title={t('完全模式下，模型不需要征求用户手动确认执行')}
                  type="button"
                >
                  <span>{t('完全')}</span>
                  {safetyMode === 'full' ? <Check aria-hidden="true" size={14} /> : null}
                </button>
              </div>
            </section>
          </Popover.Dialog>
        </Popover.Content>
      </Popover>

      <div
        aria-label={t('当前上下文 {current} / 最大上下文 {max}', {
          current: currentTokens.toLocaleString('zh-CN'),
          max: maxTokens.toLocaleString('zh-CN'),
        })}
        aria-valuemax={maxTokens}
        aria-valuemin={0}
        aria-valuenow={Math.min(currentTokens, maxTokens)}
        className="browser-chat-context-usage"
        role="meter"
        tabIndex={0}
      >
        <AnimatedCircularProgressBar
          className="browser-chat-context-ring"
          max={maxTokens}
          min={0}
          size={20}
          strokeWidth={2.25}
          value={currentTokens}
        />
        <div aria-hidden="true" className="browser-chat-context-card">
          <header className="browser-chat-context-card-header">
            <strong>{t('上下文')}</strong>
            <span>{contextPercent}%</span>
          </header>
          <div
            className="browser-chat-context-progress"
            style={{ '--browser-chat-context-progress': `${contextPercent}%` } as CSSProperties}
          >
            <span />
          </div>
          <div className="browser-chat-context-breakdown">
            <div className="is-text">
              <span>{t('消息与系统')}</span>
              <strong><NumberTicker {...textDisplay} value={textDisplay.value} /></strong>
            </div>
            <div className="is-tools">
              <span>{t('工具')}</span>
              <strong><NumberTicker {...toolDisplay} value={toolDisplay.value} /></strong>
            </div>
            <div className="is-images">
              <span>{t('图片')}</span>
              <strong><NumberTicker {...imageDisplay} value={imageDisplay.value} /></strong>
            </div>
          </div>
          <footer className="browser-chat-context-card-total">
            <span>{t('总计')}</span>
            <strong>
              <NumberTicker {...currentDisplay} value={currentDisplay.value} />
              <span aria-hidden="true"> / </span>
              <NumberTicker {...maxDisplay} value={maxDisplay.value} />
            </strong>
          </footer>
        </div>
      </div>

    </div>
  );
}

const BrowserChatComposer = memo(function BrowserChatComposer({
  attachments,
  availableSkills,
  busy,
  contextUsage,
  currentBusy,
  imageInputRef,
  interrupting,
  loading,
  loadingMoreSkills,
  managementActions,
  modelSelection,
  modelSelectionTitle,
  modelSelectionOptions,
  safetyMode,
  onInterrupt,
  onModelSelectionChange,
  onLoadMoreSkills,
  onPreviewAttachment,
  onRemoveAttachment,
  onSearchSkills,
  onSubmitMessage,
  onSafetyModeChange,
  onAddReferences,
  onUploadFiles,
  resetToken,
  showStop,
  skillsHasMore,
  uploadingImage,
}: {
  attachments: BrowserChatAttachment[];
  availableSkills: SkillRecord[];
  busy: boolean;
  contextUsage?: BrowserChatSession['contextUsage'];
  currentBusy: boolean;
  imageInputRef: RefObject<HTMLInputElement | null>;
  interrupting: boolean;
  loading: boolean;
  loadingMoreSkills: boolean;
  managementActions: ReactNode;
  modelSelection: string;
  modelSelectionTitle: string;
  modelSelectionOptions: Array<{ description?: string; group?: string; label: string; selectedLabel?: string; value: string }>;
  safetyMode: BrowserChatSafetyMode;
  onInterrupt: () => void | Promise<void>;
  onModelSelectionChange: (selection: { provider: ModelProvider; model: string }) => void;
  onLoadMoreSkills: () => void | Promise<void>;
  onPreviewAttachment: (attachment: BrowserChatAttachment) => void;
  onRemoveAttachment: (id: string) => void;
  onSearchSkills: (query: string) => void | Promise<void>;
  onSubmitMessage: (content: string, skillIds: string[], attachments: BrowserChatAttachment[]) => Promise<boolean>;
  onSafetyModeChange: (mode: BrowserChatSafetyMode) => void;
  onAddReferences: (attachments: BrowserChatAttachment[]) => BrowserChatAttachment[];
  onUploadFiles: (files: File[]) => Promise<BrowserChatAttachment[]>;
  resetToken: number;
  showStop: boolean;
  skillsHasMore: boolean;
  uploadingImage: boolean;
}) {
  const { t } = useI18n();
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState('');
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [dismissedSlashDraft, setDismissedSlashDraft] = useState('');
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const attachmentsById = useMemo(() => new Map(attachments.map((attachment) => [attachment.id, attachment])), [attachments]);
  const compactModelSelectionOptions = useMemo(() => modelSelectionOptions.map((option) => ({
    ...option,
    selectedLabel: option.label,
  })), [modelSelectionOptions]);

  useEffect(() => {
    setDraft('');
    setSelectedSkillIds([]);
    setDismissedSlashDraft('');
    setActiveSkillIndex(0);
    if (editorRef.current) {
      editorRef.current.innerHTML = '';
      delete editorRef.current.dataset.empty;
    }
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
    return Array.from(root.childNodes).map(walk).join('')
      .replace(/\u00A0/g, ' ')
      .replace(/\u200B/g, '');
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
    return Array.from(root.childNodes).map(walk).join('')
      .replace(/\u00A0/g, ' ')
      .replace(/\u200B/g, '');
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

  const ensureEmptyEditorCaret = useCallback((editor: HTMLElement | null) => {
    if (!editor) return false;
    const hasTokens = Boolean(editor.querySelector('[data-skill-id],[data-attachment-id]'));
    const hasText = (editor.textContent || '').replace(/[\u00A0\u200B]/g, '').trim().length > 0;
    if (hasTokens || hasText) {
      delete editor.dataset.empty;
      return false;
    }

    let textNode = editor.childNodes.length === 1 && editor.firstChild?.nodeType === Node.TEXT_NODE
      ? editor.firstChild as Text
      : null;
    if (!textNode) {
      editor.textContent = '';
      textNode = document.createTextNode('\u200B');
      editor.append(textNode);
    } else if (textNode.data !== '\u200B') {
      textNode.data = '\u200B';
    }
    editor.dataset.empty = 'true';

    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.setStart(textNode, textNode.data.length);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return true;
  }, []);

  const syncEditorState = useCallback((options: { scrollToBottom?: boolean } = {}) => {
    const editor = editorRef.current;
    if (editor === document.activeElement) ensureEmptyEditorCaret(editor);
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
  }, [editorPlainText, ensureEmptyEditorCaret]);

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
        return fuzzyRetrievalScore(skillQuery, [
          skill.title,
          skill.description,
          ...skill.triggerPhrases,
        ]) >= 0.38;
      })
      .slice(0, 8);
  }, [availableSkills, selectedSkillIds, skillMenuOpen, skillQuery]);

  useEffect(() => {
    if (!skillMenuOpen || !skillQuery) return undefined;
    const timer = window.setTimeout(() => void onSearchSkills(skillQuery), 180);
    return () => window.clearTimeout(timer);
  }, [onSearchSkills, skillMenuOpen, skillQuery]);

  useEffect(() => {
    setActiveSkillIndex(0);
  }, [skillMenuOpen, skillQuery, selectedSkillIds.length]);

  useEffect(() => {
    if (activeSkillIndex >= skillSuggestions.length) setActiveSkillIndex(Math.max(0, skillSuggestions.length - 1));
  }, [activeSkillIndex, skillSuggestions.length]);

  const submitDraft = useCallback(async () => {
    const content = editorContentForSubmit(editorRef.current).trim();
    const nextAttachments = editorAttachmentsForSubmit();
    if (
      (!content && !nextAttachments.length && !selectedSkillIds.length)
      || !modelSelectionOptions.length
      || busy
      || interrupting
      || loading
      || uploadingImage
    ) return;
    const sent = await onSubmitMessage(content, selectedSkillIds, nextAttachments);
    if (sent) {
      setDraft('');
      setSelectedSkillIds([]);
      if (editorRef.current) {
        editorRef.current.innerHTML = '';
        delete editorRef.current.dataset.empty;
      }
    }
  }, [busy, editorAttachmentsForSubmit, editorContentForSubmit, interrupting, loading, modelSelectionOptions.length, onSubmitMessage, selectedSkillIds, uploadingImage]);

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

  function isInlineToken(node: Node | null): node is HTMLElement {
    return node instanceof HTMLElement && Boolean(node.dataset.skillId || node.dataset.attachmentId);
  }

  function isBlankText(value: string) {
    return value.replace(/\u00A0/g, ' ').replace(/\u200B/g, '').trim() === '';
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
    ensureEmptyEditorCaret(editor);
    return true;
  }

  function isAtBlankBoundaryBeforeToken(editor: HTMLElement, container: Node, offset: number) {
    let next = container.nodeType === Node.TEXT_NODE
      ? (isBlankText((container as Text).data.slice(offset)) ? container.nextSibling : null)
      : container.childNodes[offset];
    while (next?.nodeType === Node.TEXT_NODE && isBlankText(next.textContent || '')) next = next.nextSibling;
    if (!isInlineToken(next)) return false;

    const beforeCaret = document.createRange();
    beforeCaret.selectNodeContents(editor);
    beforeCaret.setEnd(container, offset);
    return isBlankText(beforeCaret.cloneContents().textContent || '');
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
      if (isAtBlankBoundaryBeforeToken(editor, container, offset)) return true;
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
    const editor = editorRef.current;
    if (!editor || !range.collapsed) return range;

    const candidates: Array<{ node: Text; offset: number }> = [];
    const addCandidate = (node: Text, offset: number) => {
      if (node.parentElement?.closest('[data-skill-id],[data-attachment-id]')) return;
      if (candidates.some((candidate) => candidate.node === node && candidate.offset === offset)) return;
      candidates.push({ node, offset });
    };

    if (range.startContainer.nodeType === Node.TEXT_NODE) {
      addCandidate(range.startContainer as Text, range.startOffset);
    }

    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
      const textNode = current as Text;
      if (!textNode.parentElement?.closest('[data-skill-id],[data-attachment-id]')) textNodes.push(textNode);
      current = walker.nextNode();
    }
    textNodes.reverse().forEach((node) => addCandidate(node, node.data.length));

    for (const candidate of candidates) {
      const before = candidate.node.data.slice(0, candidate.offset);
      const match = before.match(/(^|[\s\u200B])\/[^\s/]*$/);
      if (!match) continue;
      const deleteFrom = before.length - match[0].length + match[1].length;
      candidate.node.data = `${candidate.node.data.slice(0, deleteFrom)}${candidate.node.data.slice(candidate.offset)}`;
      const nextRange = document.createRange();
      nextRange.setStart(candidate.node, deleteFrom);
      nextRange.collapse(true);
      return nextRange;
    }

    return range;
  }

  function finishInlineTokenInsertion(range: Range, token: HTMLElement, scrollToBottom = false) {
    range.insertNode(token);
    if (!token.previousSibling) {
      token.before(document.createTextNode('\u200B'));
    } else if (token.previousSibling.nodeType === Node.TEXT_NODE && isBlankText(token.previousSibling.textContent || '')) {
      (token.previousSibling as Text).data = '\u200B';
    }
    const trailingText = document.createTextNode('\u00A0');
    token.after(trailingText);
    setEditorSelection(trailingText, trailingText.data.length);
    syncEditorState(scrollToBottom ? { scrollToBottom: true } : undefined);
  }

  function insertSkillToken(skill: SkillRecord) {
    const editor = editorRef.current;
    if (!editor) return;
    const range = removeSlashTrigger(editorRange() || document.createRange());
    range.deleteContents();

    const token = document.createElement('span');
    token.className = 'browser-chat-inline-token browser-chat-inline-skill';
    token.contentEditable = 'false';
    token.dataset.skillId = skill.id;
    token.title = skill.description;
    token.innerHTML = `<span class="browser-chat-inline-skill-icon">${inlineSkillIconSvg()}</span>`;
    token.append(document.createTextNode(skill.title));

    finishInlineTokenInsertion(range, token);
  }

  function insertReferenceToken(attachment: BrowserChatAttachment) {
    const editor = editorRef.current;
    if (!editor) return;
    const kind = browserChatAttachmentKind(attachment);
    const range = editorRange() || document.createRange();
    range.deleteContents();

    const token = document.createElement('span');
    token.className = `browser-chat-inline-token browser-chat-inline-reference ${kind}`;
    token.contentEditable = 'false';
    token.dataset.attachmentId = attachment.id;
    token.dataset.attachmentJson = JSON.stringify(attachment);
    token.dataset.attachmentKind = kind;
    token.title = `${t(browserChatReferenceLabel(kind))}: ${attachment.name}`;
    token.innerHTML = `<span class="browser-chat-inline-reference-icon">${inlineReferenceIconSvg(kind)}</span>`;
    token.append(document.createTextNode(attachment.name || t(browserChatReferenceLabel(kind))));

    finishInlineTokenInsertion(range, token, true);
  }

  return (
    <>
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
        {skillMenuOpen ? (
          <div className="browser-chat-compose-context">
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
                    {availableSkills.some((skill) => skill.status === 'ready') ? t('没有匹配的 Skills') : t('暂无可用 Skills')}
                  </div>
                )}
                {!skillQuery && skillsHasMore ? (
                  <button
                    className="browser-chat-skill-load-more"
                    disabled={loadingMoreSkills}
                    onClick={() => void onLoadMoreSkills()}
                    onMouseDown={(event) => event.preventDefault()}
                    type="button"
                  >
                    {loadingMoreSkills ? <Loader2 className="spin" size={14} /> : null}
                    <span>{t(loadingMoreSkills ? '正在加载' : '加载更多')}</span>
                  </button>
                ) : null}
            </div>
          </div>
        ) : null}
        <div
          ref={editorRef}
          className="browser-chat-inline-editor"
          contentEditable={!busy && !loading}
          data-placeholder={t('问问题，尽管问…')}
          onClick={(event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            const token = target.closest<HTMLElement>('[data-attachment-id]');
            if (!token) return;
            const attachment = attachmentFromToken(token);
            if (!attachment || browserChatAttachmentKind(attachment) === 'tab') return;
            event.preventDefault();
            onPreviewAttachment(attachment);
          }}
          onFocus={() => syncEditorState()}
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
              aria-label={t('上传文件')}
              className="browser-chat-attach"
              disabled={currentBusy || uploadingImage || attachments.length >= BROWSER_CHAT_MAX_REFERENCES}
              onClick={() => imageInputRef.current?.click()}
              title={t('上传文件')}
              type="button"
            >
              {uploadingImage ? <Loader2 className="spin" size={17} /> : <Paperclip size={20} />}
            </button>
            <BrowserChatSafetySelector
              contextUsage={contextUsage}
              disabled={currentBusy || loading}
              onSafetyModeChange={onSafetyModeChange}
              safetyMode={safetyMode}
            />
          </div>
          {managementActions}
          <div className="browser-chat-compose-submit">
            <div className="browser-chat-model-control">
              <CustomSelect
                className="browser-chat-provider-select"
                disabled={currentBusy || loading || !modelSelectionOptions.length}
                onChange={(value) => onModelSelectionChange(parseModelSelectionValue(value))}
                options={compactModelSelectionOptions.length ? compactModelSelectionOptions : [{ label: t('未启用模型服务商'), value: modelSelection }]}
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
            ) : null}
            <RainbowButton
              className="browser-chat-send"
              disabled={(!composerText && !attachments.length && !selectedSkillIds.length) || !modelSelectionOptions.length || busy || interrupting || loading || uploadingImage}
              aria-label={t('发送')}
              size="icon"
              type="submit"
            >
              {busy ? <Loader2 className="spin" size={18} /> : <SendHorizontal size={20} strokeWidth={2.1} />}
            </RainbowButton>
          </div>
        </div>
      </form>
    </>
  );
});

type BrowserChatManagementTab = 'accounts' | 'memory' | 'skills';

function BrowserChatManagementSettingsLoading() {
  const { t } = useI18n();
  return (
    <div className="settings-loading-panel compact" role="status" aria-live="polite">
      <LiquidGlassLoader className="ui-liquid-glass-loader--compact" />
      <div><h2>{t('正在打开快捷管理')}</h2></div>
    </div>
  );
}

const BrowserChatManagementSettings = dynamic(
  () => import('@/components/EnvironmentSettings').then((module) => module.EnvironmentSettings),
  {
    ssr: false,
    loading: () => <BrowserChatManagementSettingsLoading />,
  },
);

function BrowserChatManagementDialog({
  defaultUserId,
  onClose,
  onSkillsChanged,
  personalMemoryRefreshToken,
  tab,
}: {
  defaultUserId: string;
  onClose: () => void;
  onSkillsChanged: () => void | Promise<void>;
  personalMemoryRefreshToken?: string;
  tab: BrowserChatManagementTab;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const Icon = tab === 'skills' ? Braces : tab === 'memory' ? Brain : KeyRound;
  const title = tab === 'skills' ? t('Skills 管理') : tab === 'memory' ? t('个性化记忆') : t('登录账号');

  return (
    <AppModal
      ariaLabelledBy={titleId}
      dialogClassName="browser-chat-management-dialog"
      onClose={onClose}
      size="management"
    >
        <header className="ui-modal-header">
          <div className="ui-modal-heading ui-modal-heading--with-icon ui-modal-heading--single-line browser-chat-management-heading">
            <span aria-hidden="true" className="ui-modal-heading-icon"><Icon size={18} /></span>
            <div className="ui-modal-heading-copy">
              <h2 className="ui-modal-title" id={titleId}>{title}</h2>
            </div>
          </div>
          <button aria-label={t('关闭')} autoFocus className="ui-icon-button ui-modal-close" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </header>
        <div className="ui-modal-body browser-chat-management-body">
          <div className="browser-chat-settings-pane">
            <BrowserChatManagementSettings
              activeTab={tab}
              defaultUserId={defaultUserId}
              embedded
              key={tab}
              onSkillsChanged={onSkillsChanged}
              personalMemoryRefreshToken={personalMemoryRefreshToken}
              showSectionTitles={false}
              showTabs={false}
              userId={defaultUserId}
            />
          </div>
        </div>
    </AppModal>
  );
}

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
  const { t } = useI18n();
  return (
    <>
      <span className="browser-chat-embedded-tab-icon">
        <EmbeddedBrowserTabFavicon faviconUrl={tab.faviconUrl} />
      </span>
      {tab.pinned ? <Pin aria-label={t('已固定')} className="browser-chat-embedded-tab-pin" size={11} /> : null}
      <span className="browser-chat-embedded-tab-text">
        <strong>{compactText(tab.title || tab.url || t('新建标签页'), 56)}</strong>
      </span>
      {tab.loading ? (
        <span className="browser-chat-embedded-tab-loading" aria-label={t('页面加载中')}>
          <Loader2 className="spin" size={12} />
        </span>
      ) : null}
    </>
  );
}

function EmbeddedBrowserTabActions({
  onClose,
  onToggleMute,
  tab,
}: {
  onClose?: () => void;
  onToggleMute?: () => void;
  tab: EmbeddedBrowserTab;
}) {
  const { t } = useI18n();
  const interactive = Boolean(onClose || onToggleMute);
  return (
    <>
      <button
        aria-label={tab.audioMuted ? t('取消静音标签页') : t('静音标签页')}
        className={tab.audioMuted ? 'browser-chat-embedded-tab-mute is-muted' : 'browser-chat-embedded-tab-mute'}
        onClick={(event) => {
          event.stopPropagation();
          onToggleMute?.();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        tabIndex={interactive ? undefined : -1}
        title={tab.audioMuted ? t('取消静音') : t('静音')}
        type="button"
      >
        {tab.audioMuted ? <VolumeX size={13} /> : <Volume2 size={13} />}
      </button>
      <button
        aria-label={t('关闭当前标签页')}
        className="browser-chat-embedded-tab-close"
        onClick={(event) => {
          event.stopPropagation();
          onClose?.();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        tabIndex={interactive ? undefined : -1}
        title={t('关闭当前标签页')}
        type="button"
      >
        <X size={13} />
      </button>
    </>
  );
}

function EmbeddedBrowserSortableTab({
  active,
  density,
  dragging,
  groupId,
  onActivate,
  onClose,
  onContextMenu,
  onToggleMute,
  tab,
}: {
  active: boolean;
  density: EmbeddedBrowserTabDensity;
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
        `browser-chat-embedded-tab--${density}`,
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
      tabIndex={active ? 0 : -1}
      title={tab.url || tab.title}
    >
      <EmbeddedBrowserTabContent tab={tab} />
      <EmbeddedBrowserTabActions onClose={onClose} onToggleMute={onToggleMute} tab={tab} />
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
  imageUrl: string;
  sequence?: number;
  tabs: BrowserChatPreviewTab[];
  url: string;
  viewport: { width: number; height: number };
};

type BrowserChatPreviewServerMetrics = {
  activeCaptures?: number;
  backpressureDrops?: number;
  bitrateKbps?: number;
  captureDurationMs?: number;
  captureDurationMsAverage?: number;
  captureFps?: number;
  height?: number;
  h264Level?: string;
  h264Profile?: string;
  imageFormat?: 'jpeg' | 'png';
  imageQuality?: number;
  maxConcurrentCaptures?: number;
  mimeType?: string;
  pendingClientFrames?: number;
  sendFps?: number;
  targetFps?: number;
  transport?: 'image' | 'video';
  width?: number;
};

type BrowserChatPreviewDisplayMetrics = BrowserChatPreviewServerMetrics & {
  displayedFps: number;
  receivedFps: number;
};

const BROWSER_CHAT_PREVIEW_VIDEO_MIME_TYPE = 'video/mp4; codecs="avc1.42C029"';

type BrowserChatPreviewInput =
  | { kind: 'tab'; tabId: string }
  | { kind: 'move'; xRatio: number; yRatio: number }
  | { kind: 'click'; xRatio: number; yRatio: number; button: 'left' | 'right' | 'middle'; clickCount: number }
  | { kind: 'drag'; xRatio: number; yRatio: number; toXRatio: number; toYRatio: number; button: 'left' | 'right' | 'middle' }
  | { kind: 'scroll'; xRatio: number; yRatio: number; deltaX: number; deltaY: number }
  | { kind: 'key'; key: string }
  | { kind: 'text'; text: string }
  | { kind: 'select'; xRatio: number; yRatio: number; value: string }
  | { controlKind: 'datalist' | 'picker'; kind: 'controlValue'; value: string; xRatio: number; yRatio: number }
  | { controlId: string; files: Array<{ mimeType: string; name: string; path: string }>; kind: 'files' }
  | { accept: boolean; dialogId: string; kind: 'dialog'; promptText?: string };

type BrowserChatPreviewNativeControlPosition = {
  label: string;
  openUpwards: boolean;
  targetXRatio: number;
  targetYRatio: number;
  topRatio: number;
  widthRatio: number;
  xRatio: number;
  yRatio: number;
};

type BrowserChatPreviewNativeControl = BrowserChatPreviewNativeControlPosition & ({
  kind: 'select';
  options: Array<{
    disabled: boolean;
    group?: string;
    label: string;
    selected: boolean;
    value: string;
  }>;
  selectedValue: string;
} | {
  kind: 'datalist';
  options: Array<{ label: string; value: string }>;
  value: string;
} | {
  inputType: 'color' | 'date' | 'datetime-local' | 'month' | 'time' | 'week';
  kind: 'picker';
  max?: string;
  min?: string;
  step?: string;
  value: string;
} | {
  accept: string;
  capture?: string;
  controlId: string;
  kind: 'file';
  multiple: boolean;
});

type BrowserChatPreviewDialog = {
  defaultValue: string;
  dialogType: 'alert' | 'beforeunload' | 'confirm' | 'prompt';
  id: string;
  message: string;
};

type BrowserChatPreviewDownload = {
  bytes?: number;
  delivery?: 'pending' | 'started';
  error?: string;
  fileName: string;
  id: string;
  status: 'preparing' | 'ready';
  url?: string;
};

function BrowserChatWebPreviewModal({
  onClose,
  sessionId,
  userId,
}: {
  onClose: () => void;
  sessionId: string;
  userId: string;
}) {
  const { t } = useI18n();
  const streamRef = useRef<WebSocket | null>(null);
  const reconnectEnabledRef = useRef(true);
  const previewImageRef = useRef<HTMLImageElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewStageRef = useRef<HTMLDivElement | null>(null);
  const previewFileInputRef = useRef<HTMLInputElement | null>(null);
  const handledPreviewDownloadIdsRef = useRef(new Set<string>());
  const mediaSourceRef = useRef<MediaSource | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const videoChunkQueueRef = useRef<Uint8Array[]>([]);
  const videoObjectUrlRef = useRef('');
  const forceImageTransportRef = useRef(false);
  const pumpVideoChunksRef = useRef<() => void>(() => undefined);
  const pendingFrameRef = useRef<BrowserChatPreviewFrame | null>(null);
  const frameObjectUrlRef = useRef('');
  const staleFrameObjectUrlRef = useRef('');
  const decodingFrameObjectUrlRef = useRef('');
  const frameDecodeActiveRef = useRef(false);
  const framePipelineDisposedRef = useRef(false);
  const frameCountersRef = useRef({
    displayed: 0,
    received: 0,
    sampledAt: Date.now(),
    sampledDisplayed: 0,
    sampledReceived: 0,
  });
  const frameStateRef = useRef<Pick<BrowserChatPreviewFrame, 'tabs' | 'url' | 'viewport'>>({
    tabs: [],
    url: '',
    viewport: { height: 720, width: 1280 },
  });
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
  const [previewTransport, setPreviewTransport] = useState<'image' | 'video'>('video');
  const [videoObjectUrl, setVideoObjectUrl] = useState('');
  const [videoDisplayReady, setVideoDisplayReady] = useState(false);
  const [status, setStatus] = useState<'connecting' | 'live' | 'reconnecting' | 'unavailable'>('connecting');
  const [streamError, setStreamError] = useState('');
  const [inputError, setInputError] = useState('');
  const [previewMetrics, setPreviewMetrics] = useState<BrowserChatPreviewDisplayMetrics | null>(null);
  const [nativeControl, setNativeControl] = useState<BrowserChatPreviewNativeControl | null>(null);
  const [nativeControlPosition, setNativeControlPosition] = useState<CSSProperties | null>(null);
  const [nativeControlBusy, setNativeControlBusy] = useState(false);
  const [nativePickerValue, setNativePickerValue] = useState('');
  const [nativeDialog, setNativeDialog] = useState<BrowserChatPreviewDialog | null>(null);
  const [nativeDialogPrompt, setNativeDialogPrompt] = useState('');
  const [previewDownload, setPreviewDownload] = useState<BrowserChatPreviewDownload | null>(null);
  const videoPipelineErrorRef = useRef<(message: string) => void>(() => undefined);
  const previewViewportWidth = frame?.viewport.width;
  const previewViewportHeight = frame?.viewport.height;

  useLayoutEffect(() => {
    const stage = previewStageRef.current;
    if (!nativeControl || !previewViewportWidth || !previewViewportHeight || !stage) {
      setNativeControlPosition(null);
      return undefined;
    }
    const updatePosition = () => {
      const stageRect = stage.getBoundingClientRect();
      if (!stageRect.width || !stageRect.height) return;
      const sourceRatio = Math.max(1, previewViewportWidth) / Math.max(1, previewViewportHeight);
      const stageRatio = stageRect.width / stageRect.height;
      const contentWidth = stageRatio > sourceRatio ? stageRect.height * sourceRatio : stageRect.width;
      const contentHeight = stageRatio > sourceRatio ? stageRect.height : stageRect.width / sourceRatio;
      const contentLeft = (stageRect.width - contentWidth) / 2;
      const contentTop = (stageRect.height - contentHeight) / 2;
      const menuWidth = Math.min(
        Math.max(nativeControl.widthRatio * contentWidth, Math.min(220, contentWidth - 16)),
        Math.max(0, contentWidth - 16),
      );
      const desiredLeft = contentLeft + nativeControl.xRatio * contentWidth;
      const left = Math.min(
        Math.max(contentLeft + 8, desiredLeft),
        Math.max(contentLeft + 8, contentLeft + contentWidth - menuWidth - 8),
      );
      setNativeControlPosition({
        left,
        width: menuWidth,
        ...(nativeControl.openUpwards
          ? { bottom: stageRect.height - (contentTop + nativeControl.topRatio * contentHeight) }
          : { top: contentTop + nativeControl.yRatio * contentHeight }),
      });
    };
    updatePosition();
    const resizeObserver = new ResizeObserver(updatePosition);
    resizeObserver.observe(stage);
    return () => resizeObserver.disconnect();
  }, [nativeControl, previewViewportHeight, previewViewportWidth]);

  useEffect(() => {
    setNativePickerValue(nativeControl?.kind === 'picker' ? nativeControl.value : '');
    setNativeControlBusy(false);
  }, [nativeControl]);

  useEffect(() => {
    if (nativeControl?.kind !== 'file') return undefined;
    const animationFrame = window.requestAnimationFrame(() => {
      try {
        previewFileInputRef.current?.click();
      } catch (error) {
        setNativeControl(null);
        setInputError(error instanceof Error ? error.message : '无法打开系统文件选择器');
      }
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [nativeControl]);

  const disposeVideoPipeline = useCallback((updateState = true) => {
    const sourceBuffer = sourceBufferRef.current;
    sourceBufferRef.current = null;
    videoChunkQueueRef.current = [];
    if (sourceBuffer?.updating) {
      try { sourceBuffer.abort(); } catch { /* MediaSource may already be closed. */ }
    }
    const mediaSource = mediaSourceRef.current;
    mediaSourceRef.current = null;
    if (mediaSource?.readyState === 'open') {
      try { mediaSource.endOfStream(); } catch { /* Decoder teardown is best-effort. */ }
    }
    if (videoObjectUrlRef.current) URL.revokeObjectURL(videoObjectUrlRef.current);
    videoObjectUrlRef.current = '';
    if (updateState) {
      setVideoObjectUrl('');
      setVideoDisplayReady(false);
    }
  }, []);

  const pumpVideoChunks = useCallback(() => {
    const sourceBuffer = sourceBufferRef.current;
    if (!sourceBuffer || sourceBuffer.updating) return;
    const next = videoChunkQueueRef.current.shift();
    if (next) {
      try {
        const copy = new Uint8Array(next.byteLength);
        copy.set(next);
        sourceBuffer.appendBuffer(copy.buffer);
      } catch (error) {
        videoPipelineErrorRef.current(error instanceof Error ? error.message : '视频缓冲区写入失败');
      }
      return;
    }
    const video = previewVideoRef.current;
    if (!video || !sourceBuffer.buffered.length) return;
    const lastRange = sourceBuffer.buffered.length - 1;
    const start = sourceBuffer.buffered.start(0);
    const end = sourceBuffer.buffered.end(lastRange);
    if (end - video.currentTime > 0.6) video.currentTime = Math.max(start, end - 0.12);
    if (end - start > 8) {
      try { sourceBuffer.remove(0, Math.max(0, end - 3)); } catch { /* A later update trims again. */ }
    }
    void video.play().catch(() => undefined);
  }, []);
  pumpVideoChunksRef.current = pumpVideoChunks;

  const beginVideoPipeline = useCallback((contentType: string, initialization: Uint8Array) => {
    disposeVideoPipeline();
    if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(contentType)) return false;
    setVideoDisplayReady(false);
    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);
    mediaSourceRef.current = mediaSource;
    videoObjectUrlRef.current = objectUrl;
    videoChunkQueueRef.current = [initialization];
    mediaSource.addEventListener('sourceopen', () => {
      if (mediaSourceRef.current !== mediaSource) return;
      try {
        const sourceBuffer = mediaSource.addSourceBuffer(contentType);
        sourceBuffer.mode = 'segments';
        sourceBufferRef.current = sourceBuffer;
        sourceBuffer.addEventListener('updateend', () => {
          if (sourceBufferRef.current === sourceBuffer) pumpVideoChunksRef.current();
        });
        sourceBuffer.addEventListener('error', () => {
          if (sourceBufferRef.current === sourceBuffer) videoPipelineErrorRef.current('H.264 视频解码失败');
        });
        pumpVideoChunksRef.current();
      } catch (error) {
        videoPipelineErrorRef.current(error instanceof Error ? error.message : '无法创建 H.264 视频缓冲区');
      }
    }, { once: true });
    setVideoObjectUrl(objectUrl);
    setPreviewTransport('video');
    return true;
  }, [disposeVideoPipeline]);

  const enqueueVideoChunk = useCallback((chunk: Uint8Array) => {
    if (!mediaSourceRef.current) return;
    if (videoChunkQueueRef.current.length >= 240) {
      videoPipelineErrorRef.current('视频缓冲积压过多，正在回退到图片预览');
      return;
    }
    videoChunkQueueRef.current.push(chunk);
    pumpVideoChunksRef.current();
  }, []);

  const fallbackToImagePreview = useCallback((message: string) => {
    forceImageTransportRef.current = true;
    setPreviewTransport('image');
    disposeVideoPipeline();
    setStreamError(message);
    const stream = streamRef.current;
    if (stream?.readyState === WebSocket.OPEN || stream?.readyState === WebSocket.CONNECTING) stream.close();
  }, [disposeVideoPipeline]);
  videoPipelineErrorRef.current = fallbackToImagePreview;

  const deliverPreviewDownload = useCallback(async (
    download: BrowserChatPreviewDownload,
    options: { repeat?: boolean; userInitiated?: boolean } = {},
  ) => {
    if (!download.url) return;
    const bridge = typeof window === 'undefined' ? undefined : window.webPilotSystem;
    // Chromium blocks repeated downloads started from asynchronous WebSocket
    // callbacks. On the web, wait for the user to click the notice button so
    // anchor.click() runs inside a real user-activation handler.
    if (!bridge?.downloadUrl && !options.userInitiated) return;
    if (!options.repeat && handledPreviewDownloadIdsRef.current.has(download.id)) return;
    handledPreviewDownloadIdsRef.current.add(download.id);
    try {
      const url = withWebPilotBasePath(download.url);
      if (bridge?.downloadUrl) {
        const result = await bridge.downloadUrl({ fileName: download.fileName, url });
        if (!result.ok) throw new Error(result.error || '下载文件失败');
      } else {
        const anchor = document.createElement('a');
        anchor.download = download.fileName;
        anchor.href = url;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }
      setPreviewDownload((current) => current?.id === download.id
        ? { ...current, delivery: 'started' }
        : current);
    } catch (error) {
      handledPreviewDownloadIdsRef.current.delete(download.id);
      setInputError(error instanceof Error ? error.message : '下载文件失败');
    }
  }, []);

  useEffect(() => {
    if (!previewDownload) return undefined;
    const timeoutMs = previewDownload.delivery === 'started'
      ? 4_000
      : previewDownload.status === 'ready' ? 15_000 : 20_000;
    const timer = window.setTimeout(() => {
      setPreviewDownload((current) => current?.id === previewDownload.id ? null : current);
    }, timeoutMs);
    return () => window.clearTimeout(timer);
  }, [previewDownload]);

  const commitPendingPreviewFrame = useCallback(async function commitPendingPreviewFrame() {
    if (framePipelineDisposedRef.current || frameDecodeActiveRef.current) return;
    const nextFrame = pendingFrameRef.current;
    if (!nextFrame) return;
    pendingFrameRef.current = null;
    frameDecodeActiveRef.current = true;
    decodingFrameObjectUrlRef.current = nextFrame.imageUrl;
    let committed = false;
    try {
      const decodedImage = new Image();
      decodedImage.decoding = 'async';
      decodedImage.src = nextFrame.imageUrl;
      await decodedImage.decode();
      if (framePipelineDisposedRef.current) return;

      if (staleFrameObjectUrlRef.current.startsWith('blob:')) {
        URL.revokeObjectURL(staleFrameObjectUrlRef.current);
      }
      staleFrameObjectUrlRef.current = frameObjectUrlRef.current;
      frameObjectUrlRef.current = nextFrame.imageUrl;
      decodingFrameObjectUrlRef.current = '';
      committed = true;
      frameCountersRef.current.displayed += 1;
      setFrame(nextFrame);
      setStatus('live');
      setStreamError('');
    } catch {
      // A newer frame remains queued and will be decoded below.
    } finally {
      if (!committed && nextFrame.imageUrl.startsWith('blob:')) {
        URL.revokeObjectURL(nextFrame.imageUrl);
      }
      if (decodingFrameObjectUrlRef.current === nextFrame.imageUrl) {
        decodingFrameObjectUrlRef.current = '';
      }
      frameDecodeActiveRef.current = false;
      if (!framePipelineDisposedRef.current && pendingFrameRef.current) {
        void commitPendingPreviewFrame();
      }
    }
  }, []);

  const queuePreviewFrame = useCallback((nextFrame: BrowserChatPreviewFrame) => {
    if (framePipelineDisposedRef.current) {
      if (nextFrame.imageUrl.startsWith('blob:')) URL.revokeObjectURL(nextFrame.imageUrl);
      return;
    }
    const previousPending = pendingFrameRef.current?.imageUrl;
    if (previousPending?.startsWith('blob:')) URL.revokeObjectURL(previousPending);
    pendingFrameRef.current = nextFrame;
    void commitPendingPreviewFrame();
  }, [commitPendingPreviewFrame]);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | undefined;
    reconnectEnabledRef.current = true;
    const connect = async () => {
      try {
        const response = await fetch(
          `${withWebPilotBasePath('/api/browser-chat/preview-stream')}?sessionId=${encodeURIComponent(sessionId)}`,
          { cache: 'no-store', method: 'POST' },
        );
        const data = await response.json() as { error?: string; transport?: 'image' | 'video'; url?: string };
        if (!response.ok || !data.url) throw new Error(data.error || '实时界面连接失败');
        if (disposed) return;
        const videoSupported = typeof MediaSource !== 'undefined'
          && MediaSource.isTypeSupported(BROWSER_CHAT_PREVIEW_VIDEO_MIME_TYPE);
        const requestedTransport = data.transport === 'image' || forceImageTransportRef.current || !videoSupported
          ? 'image'
          : 'video';
        setPreviewTransport(requestedTransport);
        disposeVideoPipeline();
        const url = new URL(data.url);
        url.searchParams.set('sessionId', sessionId);
        url.searchParams.set('transport', requestedTransport);
        const stream = new WebSocket(url);
        stream.binaryType = 'arraybuffer';
        streamRef.current = stream;
        stream.onopen = () => {
          const counters = frameCountersRef.current;
          counters.sampledAt = Date.now();
          counters.sampledDisplayed = counters.displayed;
          counters.sampledReceived = counters.received;
          frameStateRef.current = { tabs: [], url: '', viewport: { height: 720, width: 1280 } };
          setPreviewMetrics(null);
          setStatus('connecting');
          setStreamError('');
        };
        stream.onmessage = (event) => {
          try {
            if (event.data instanceof ArrayBuffer) {
              const bytes = new Uint8Array(event.data);
              if (bytes.byteLength < 4) throw new Error('Invalid binary frame');
              const metadataLength = new DataView(event.data).getUint32(0, false);
              if (metadataLength <= 0 || metadataLength + 4 > bytes.byteLength) throw new Error('Invalid binary metadata');
              const metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + metadataLength))) as {
                capturedAt?: string;
                contentType?: string;
                sequence?: number;
                type?: 'frame' | 'videoChunk' | 'videoInit';
              };
              const payload = bytes.slice(4 + metadataLength);
              if (metadata.type === 'videoInit') {
                if (!metadata.contentType || !beginVideoPipeline(metadata.contentType, payload)) {
                  fallbackToImagePreview('当前客户端不支持该 H.264 视频流，正在回退到图片预览');
                }
                return;
              }
              if (metadata.type === 'videoChunk') {
                frameCountersRef.current.received += 1;
                enqueueVideoChunk(payload);
                return;
              }
              if (metadata.type !== 'frame' || (metadata.contentType !== 'image/jpeg' && metadata.contentType !== 'image/png')) {
                throw new Error('Unknown binary preview payload');
              }
              frameCountersRef.current.received += 1;
              const imageUrl = URL.createObjectURL(new Blob(
                [payload],
                { type: metadata.contentType },
              ));
              queuePreviewFrame({
                ...frameStateRef.current,
                capturedAt: metadata.capturedAt || new Date().toISOString(),
                contentType: metadata.contentType,
                imageUrl,
                sequence: metadata.sequence,
              });
              return;
            }
            const message = JSON.parse(String(event.data)) as BrowserChatPreviewFrame & {
              error?: string;
              height?: number;
              metrics?: BrowserChatPreviewServerMetrics;
              control?: BrowserChatPreviewNativeControl;
              dialog?: BrowserChatPreviewDialog;
              dialogId?: string;
              download?: Omit<BrowserChatPreviewDownload, 'status'>;
              transport?: 'image' | 'video';
              type?: string;
              width?: number;
            };
            if (message.type === 'frame') {
              const legacyMessage = message as BrowserChatPreviewFrame & { data?: string };
              frameCountersRef.current.received += 1;
              queuePreviewFrame({
                ...message,
                imageUrl: legacyMessage.imageUrl || `data:${message.contentType};base64,${legacyMessage.data || ''}`,
              });
              frameStateRef.current = { tabs: message.tabs, url: message.url, viewport: message.viewport };
            } else if (message.type === 'tabsChanged' && Array.isArray(message.tabs)) {
              setNativeControl(null);
              frameStateRef.current = { ...frameStateRef.current, tabs: message.tabs };
              setFrame((current) => current ? { ...current, tabs: message.tabs } : current);
            } else if (message.type === 'navigationChanged' && typeof message.url === 'string') {
              setNativeControl(null);
              frameStateRef.current = { ...frameStateRef.current, url: message.url };
              setFrame((current) => current ? { ...current, url: message.url } : current);
            } else if (message.type === 'viewportChanged' && message.viewport) {
              frameStateRef.current = { ...frameStateRef.current, viewport: message.viewport };
              setFrame((current) => current ? { ...current, viewport: message.viewport } : current);
            } else if (
              message.type === 'videoReady'
              && typeof message.width === 'number'
              && typeof message.height === 'number'
            ) {
              frameStateRef.current = {
                ...frameStateRef.current,
                viewport: { width: message.width, height: message.height },
              };
            } else if (message.type === 'frameHeartbeat' && message.metrics) {
              const counters = frameCountersRef.current;
              const sampledAt = Date.now();
              const sampleSeconds = Math.max(0.001, (sampledAt - counters.sampledAt) / 1_000);
              setPreviewMetrics({
                ...message.metrics,
                displayedFps: (counters.displayed - counters.sampledDisplayed) / sampleSeconds,
                receivedFps: (counters.received - counters.sampledReceived) / sampleSeconds,
              });
              counters.sampledAt = sampledAt;
              counters.sampledDisplayed = counters.displayed;
              counters.sampledReceived = counters.received;
            } else if (message.type === 'transportChanged' && message.transport) {
              setPreviewTransport(message.transport);
              if (message.transport === 'image') {
                forceImageTransportRef.current = true;
                disposeVideoPipeline();
                if (message.error) setStreamError(message.error);
              }
            } else if (message.type === 'activeTabChanged') {
              setNativeControl(null);
              setStatus('reconnecting');
            } else if (message.type === 'nativeControlOpened' && message.control) {
              setNativeControl(message.control);
            } else if (message.type === 'nativeControlClosed') {
              setNativeControl(null);
              setNativeControlBusy(false);
            } else if (message.type === 'nativeDialogOpened' && message.dialog) {
              setNativeDialog(message.dialog);
              setNativeDialogPrompt(message.dialog.defaultValue || '');
            } else if (message.type === 'nativeDialogClosed') {
              setNativeDialog((current) => current?.id === message.dialogId ? null : current);
            } else if (message.type === 'browserDownloadStarted' && message.download) {
              setPreviewDownload({ ...message.download, status: 'preparing' });
            } else if (message.type === 'browserDownloadReady' && message.download?.url) {
              const readyDownload: BrowserChatPreviewDownload = { ...message.download, delivery: 'pending', status: 'ready' };
              setPreviewDownload(readyDownload);
              void deliverPreviewDownload(readyDownload);
            } else if (message.type === 'browserDownloadFailed' && message.download) {
              setPreviewDownload(null);
              setInputError(message.download.error || '测试浏览器文件下载失败');
            } else if (message.type === 'ready') {
              setStatus('live');
              setStreamError('');
            } else if (message.type === 'inputError') {
              setNativeControlBusy(false);
              setInputError(message.error || '实时界面操作失败');
            } else if (message.type === 'unavailable') {
              reconnectEnabledRef.current = false;
              setStatus('unavailable');
              setStreamError(message.error || '当前会话没有运行中的测试浏览器');
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
          if (disposed || !reconnectEnabledRef.current) return;
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
  }, [beginVideoPipeline, deliverPreviewDownload, disposeVideoPipeline, enqueueVideoChunk, fallbackToImagePreview, queuePreviewFrame, sessionId, userId]);

  useEffect(() => {
    // React Strict Mode mounts effects again after a simulated cleanup. Reset
    // this flag on every setup so the remounted preview continues accepting frames.
    framePipelineDisposedRef.current = false;
    return () => {
      framePipelineDisposedRef.current = true;
      if (frameObjectUrlRef.current.startsWith('blob:')) URL.revokeObjectURL(frameObjectUrlRef.current);
      if (staleFrameObjectUrlRef.current.startsWith('blob:')) URL.revokeObjectURL(staleFrameObjectUrlRef.current);
      if (decodingFrameObjectUrlRef.current.startsWith('blob:')) URL.revokeObjectURL(decodingFrameObjectUrlRef.current);
      const pendingUrl = pendingFrameRef.current?.imageUrl;
      if (pendingUrl?.startsWith('blob:')) URL.revokeObjectURL(pendingUrl);
      frameObjectUrlRef.current = '';
      staleFrameObjectUrlRef.current = '';
      decodingFrameObjectUrlRef.current = '';
      pendingFrameRef.current = null;
      pendingMoveRef.current = null;
      pointerGestureRef.current = null;
      if (moveFlushTimerRef.current !== undefined) window.clearTimeout(moveFlushTimerRef.current);
      if (scrollFlushTimerRef.current !== undefined) window.clearTimeout(scrollFlushTimerRef.current);
      disposeVideoPipeline(false);
    };
  }, [disposeVideoPipeline]);

  useEffect(() => {
    const video = previewVideoRef.current;
    if (!videoObjectUrl || !video) return undefined;
    let stopped = false;
    let callbackId = 0;
    const markLive = () => {
      if (stopped) return;
      setStatus('live');
      setStreamError('');
    };
    const frameCallback = () => {
      if (stopped) return;
      frameCountersRef.current.displayed += 1;
      markLive();
      callbackId = video.requestVideoFrameCallback(frameCallback);
    };
    video.addEventListener('playing', markLive);
    callbackId = video.requestVideoFrameCallback(frameCallback);
    void video.play().catch(() => undefined);
    return () => {
      stopped = true;
      video.removeEventListener('playing', markLive);
      if (callbackId) video.cancelVideoFrameCallback(callbackId);
    };
  }, [videoObjectUrl]);

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

  const relativePoint = useCallback((clientX: number, clientY: number, element: HTMLElement, clamp = false) => {
    if (!frame) return undefined;
    const mediaRect = previewVideoRef.current?.getBoundingClientRect()
      || previewImageRef.current?.getBoundingClientRect()
      || element.getBoundingClientRect();
    if (!mediaRect.width || !mediaRect.height) return undefined;
    const sourceWidth = Math.max(1, frame.viewport.width);
    const sourceHeight = Math.max(1, frame.viewport.height);
    const sourceRatio = sourceWidth / sourceHeight;
    const mediaRatio = mediaRect.width / mediaRect.height;
    const contentWidth = mediaRatio > sourceRatio ? mediaRect.height * sourceRatio : mediaRect.width;
    const contentHeight = mediaRatio > sourceRatio ? mediaRect.height : mediaRect.width / sourceRatio;
    const rect = {
      bottom: mediaRect.top + (mediaRect.height + contentHeight) / 2,
      height: contentHeight,
      left: mediaRect.left + (mediaRect.width - contentWidth) / 2,
      right: mediaRect.left + (mediaRect.width + contentWidth) / 2,
      top: mediaRect.top + (mediaRect.height - contentHeight) / 2,
      width: contentWidth,
    };
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
    setNativeControl(null);
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
    if (nativeControl && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setNativeControl(null);
      return;
    }
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
  }, [nativeControl, sendInput]);

  const pastePreviewText = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
    const text = event.clipboardData.getData('text');
    if (!text) return;
    event.preventDefault();
    sendInput({ kind: 'text', text });
  }, [sendInput]);

  const switchPreviewTab = useCallback((tabId: string) => {
    setNativeControl(null);
    setFrame((current) => current ? {
      ...current,
      tabs: current.tabs.map((tab) => ({ ...tab, active: tab.id === tabId })),
    } : current);
    setStatus('reconnecting');
    sendInput({ kind: 'tab', tabId });
  }, [sendInput]);

  const selectPreviewNativeOption = useCallback((value: string) => {
    if (!nativeControl || (nativeControl.kind !== 'select' && nativeControl.kind !== 'datalist')) return;
    setNativeControl(null);
    if (nativeControl.kind === 'select') {
      sendInput({
        kind: 'select',
        value,
        xRatio: nativeControl.targetXRatio,
        yRatio: nativeControl.targetYRatio,
      });
      return;
    }
    sendInput({
      controlKind: 'datalist',
      kind: 'controlValue',
      value,
      xRatio: nativeControl.targetXRatio,
      yRatio: nativeControl.targetYRatio,
    });
  }, [nativeControl, sendInput]);

  const applyPreviewNativePicker = useCallback(() => {
    if (nativeControl?.kind !== 'picker') return;
    setNativeControl(null);
    sendInput({
      controlKind: 'picker',
      kind: 'controlValue',
      value: nativePickerValue,
      xRatio: nativeControl.targetXRatio,
      yRatio: nativeControl.targetYRatio,
    });
  }, [nativeControl, nativePickerValue, sendInput]);

  const uploadPreviewNativeFiles = useCallback(async (files: FileList | null) => {
    if (nativeControl?.kind !== 'file' || !files?.length || nativeControlBusy) return;
    const selected = Array.from(files).slice(0, nativeControl.multiple ? 8 : 1);
    setNativeControlBusy(true);
    setInputError('');
    try {
      const uploaded: Array<{ mimeType: string; name: string; path: string }> = [];
      for (const file of selected) {
        const response = await fetch(withWebPilotBasePath('/api/uploads'), {
          body: file,
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'x-webpilot-file-name': encodeURIComponent(file.name),
            'x-webpilot-upload': 'raw',
          },
          method: 'POST',
        });
        const data = await readApiJson<Record<string, unknown>>(response, '文件上传失败');
        uploaded.push({
          mimeType: String(data.type || file.type || 'application/octet-stream'),
          name: String(data.name || file.name),
          path: String(data.path || ''),
        });
      }
      if (!uploaded.every((file) => file.path)) throw new Error('文件上传结果无效');
      if (!sendInput({ controlId: nativeControl.controlId, files: uploaded, kind: 'files' })) {
        setNativeControlBusy(false);
      }
    } catch (error) {
      setNativeControlBusy(false);
      setInputError(error instanceof Error ? error.message : '文件上传失败');
    } finally {
      if (previewFileInputRef.current) previewFileInputRef.current.value = '';
    }
  }, [nativeControl, nativeControlBusy, sendInput]);

  const respondPreviewNativeDialog = useCallback((accept: boolean) => {
    if (!nativeDialog) return;
    sendInput({
      accept,
      dialogId: nativeDialog.id,
      kind: 'dialog',
      ...(nativeDialog.dialogType === 'prompt' ? { promptText: nativeDialogPrompt } : {}),
    });
  }, [nativeDialog, nativeDialogPrompt, sendInput]);

  const statusLabelSource = status === 'live'
    ? '实时'
    : status === 'reconnecting'
      ? '正在重连'
      : status === 'unavailable'
        ? '浏览器未运行'
        : '正在连接';
  const statusLabel = t(statusLabelSource);
  const previewMetricsLabel = previewMetrics
    ? t('{transport} · 目标 {target} · 截图 {capture} · 发送 {send} · 接收 {received} · 显示 {displayed} FPS', {
        transport: previewTransport === 'video' ? 'H.264' : t('图片'),
        target: Math.round(previewMetrics.targetFps || 0),
        capture: (previewMetrics.captureFps || 0).toFixed(1),
        send: (previewMetrics.sendFps || 0).toFixed(1),
        received: previewMetrics.receivedFps.toFixed(1),
        displayed: previewMetrics.displayedFps.toFixed(1),
      })
    : '';
  const previewMetricsTitle = previewMetrics
    ? [
        previewTransport === 'video'
          ? t('传输：H.264 fragmented MP4')
          : previewMetrics.imageFormat === 'jpeg' ? t('JPEG 质量：{quality}', { quality: previewMetrics.imageQuality ?? '-' }) : 'PNG',
        ...(previewTransport === 'video' ? [
          t('编码：{profile} / Level {level} / {mime}', { profile: previewMetrics.h264Profile || '-', level: previewMetrics.h264Level || '-', mime: previewMetrics.mimeType || '-' }),
          t('视频：{width}×{height} / {bitrate} Kbps', { width: previewMetrics.width || '-', height: previewMetrics.height || '-', bitrate: previewMetrics.bitrateKbps || '-' }),
        ] : []),
        t('最近一次截图耗时：{time} ms', { time: (previewMetrics.captureDurationMs || 0).toFixed(1) }),
        t('平均截图耗时：{time} ms', { time: (previewMetrics.captureDurationMsAverage || 0).toFixed(1) }),
        t('在途截图：{active}/{maximum}', { active: previewMetrics.activeCaptures || 0, maximum: previewMetrics.maxConcurrentCaptures || 1 }),
        t('网络背压丢帧：{count}', { count: previewMetrics.backpressureDrops || 0 }),
        t('待发送客户端帧：{count}', { count: previewMetrics.pendingClientFrames || 0 }),
      ].join('\n')
    : '';
  const hasPreviewVisual = videoDisplayReady || Boolean(frame?.imageUrl);

  return (
    <AppModal
      ariaLabel={t('实时界面')}
      backdropClassName="browser-chat-web-preview-overlay"
      dialogClassName="browser-chat-web-preview-modal"
      onClose={onClose}
      size="full"
    >
        <header className="ui-modal-header browser-chat-web-preview-header">
          <div className="ui-modal-heading">
            <div className="browser-chat-web-preview-title-row">
              <h2 className="ui-modal-title">{t('实时界面')}</h2>
              <span className={`browser-chat-web-preview-status is-${status}`}>
                <span />
                {statusLabel}
              </span>
              {previewMetricsLabel ? (
                <span className="browser-chat-web-preview-metrics" title={previewMetricsTitle}>
                  {previewMetricsLabel}
                </span>
              ) : null}
              <span className="browser-chat-web-preview-url" title={frame?.url || ''}>
                {frame?.url || t('等待会话浏览器启动')}
              </span>
            </div>
          </div>
          <button aria-label={t('关闭实时界面')} className="browser-chat-web-preview-close" onClick={onClose} title={t('关闭')} type="button">
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
                <span>{tab.url || t('标签页 {index}', { index: tab.index + 1 })}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="browser-chat-web-preview-body">
          <div
            aria-label={t('可操作的浏览器实时画面')}
            className={hasPreviewVisual ? 'browser-chat-web-preview-stage has-frame' : 'browser-chat-web-preview-stage'}
            onContextMenu={openPreviewContextMenu}
            onKeyDown={pressPreviewKey}
            onPaste={pastePreviewText}
            onPointerCancel={cancelPreviewPointer}
            onPointerDown={beginPreviewPointer}
            onPointerMove={movePreviewPointer}
            onPointerUp={endPreviewPointer}
            onWheel={scrollPreview}
            ref={previewStageRef}
            role="application"
            tabIndex={0}
          >
            {frame?.imageUrl && !videoDisplayReady ? (
              <img
                alt={t('浏览器实时画面')}
                draggable={false}
                height={frame.viewport.height}
                ref={previewImageRef}
                src={frame.imageUrl}
                width={frame.viewport.width}
              />
            ) : null}
            {videoObjectUrl ? (
              <video
                autoPlay
                className={videoDisplayReady ? 'is-ready' : 'is-loading'}
                disablePictureInPicture
                height={frame?.viewport.height || 720}
                muted
                onLoadedData={() => {
                  setVideoDisplayReady(true);
                  setStatus('live');
                  setStreamError('');
                }}
                playsInline
                ref={previewVideoRef}
                src={videoObjectUrl}
                width={frame?.viewport.width || 1280}
              />
            ) : null}
            {nativeControl?.kind === 'file' ? (
              <input
                accept={nativeControl.accept || undefined}
                capture={nativeControl.capture === 'environment' || nativeControl.capture === 'user'
                  ? nativeControl.capture
                  : nativeControl.capture ? true : undefined}
                className="browser-chat-web-preview-native-file-input"
                multiple={nativeControl.multiple}
                onChange={(event) => void uploadPreviewNativeFiles(event.target.files)}
                ref={previewFileInputRef}
                type="file"
              />
            ) : null}
            {nativeControl && nativeControl.kind !== 'file' && nativeControlPosition ? (
              <div
                aria-label={nativeControl.label}
                className={`browser-chat-web-preview-native-select is-${nativeControl.kind}`}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                role={nativeControl.kind === 'select' || nativeControl.kind === 'datalist' ? 'listbox' : 'dialog'}
                style={nativeControlPosition}
              >
                {nativeControl.kind === 'select' || nativeControl.kind === 'datalist' ? (
                  nativeControl.options.map((option, index) => {
                    const selected = nativeControl.kind === 'select'
                      ? option.value === nativeControl.selectedValue
                      : option.value === nativeControl.value;
                    const disabled = 'disabled' in option ? option.disabled : false;
                    const group = 'group' in option ? option.group : undefined;
                    return (
                      <button
                        aria-selected={selected}
                        className={selected ? 'is-selected' : undefined}
                        disabled={disabled}
                        key={`${option.value}:${index}`}
                        onClick={() => selectPreviewNativeOption(option.value)}
                        role="option"
                        type="button"
                      >
                        <span>{option.label}</span>
                        {group ? <small>{group}</small> : null}
                        {selected ? <Check size={15} /> : null}
                      </button>
                    );
                  })
                ) : null}
                {nativeControl.kind === 'picker' ? (
                  <div className="browser-chat-web-preview-native-control-form">
                    <strong>{nativeControl.label}</strong>
                    <input
                      autoFocus
                      max={nativeControl.max}
                      min={nativeControl.min}
                      onChange={(event) => setNativePickerValue(event.target.value)}
                      step={nativeControl.step}
                      type={nativeControl.inputType}
                      value={nativePickerValue}
                    />
                    <div className="browser-chat-web-preview-native-control-actions">
                      <button onClick={() => setNativeControl(null)} type="button">{t('取消')}</button>
                      <button className="is-primary" onClick={applyPreviewNativePicker} type="button">{t('应用')}</button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
            {nativeDialog ? (
              <div
                className="browser-chat-web-preview-native-dialog-backdrop"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    respondPreviewNativeDialog(false);
                  }
                }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <section aria-labelledby="browser-chat-native-dialog-title" aria-modal="true" role="dialog">
                  <strong id="browser-chat-native-dialog-title">
                    {nativeDialog.dialogType === 'prompt' ? t('请输入内容') : t('浏览器提示')}
                  </strong>
                  <p>{nativeDialog.message}</p>
                  {nativeDialog.dialogType === 'prompt' ? (
                    <AppInput
                      autoFocus
                      onChange={(event) => setNativeDialogPrompt(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') respondPreviewNativeDialog(true);
                      }}
                      value={nativeDialogPrompt}
                    />
                  ) : null}
                  <div className="browser-chat-web-preview-native-dialog-actions">
                    {nativeDialog.dialogType !== 'alert' ? (
                      <button onClick={() => respondPreviewNativeDialog(false)} type="button">
                        {nativeDialog.dialogType === 'beforeunload' ? t('留在此页') : t('取消')}
                      </button>
                    ) : null}
                    <button className="is-primary" onClick={() => respondPreviewNativeDialog(true)} type="button">
                      {nativeDialog.dialogType === 'beforeunload' ? t('离开页面') : t('确定')}
                    </button>
                  </div>
                </section>
              </div>
            ) : null}
            {!hasPreviewVisual ? (
              <div className="browser-chat-web-preview-empty">
                <Loader2 className="spin" size={22} />
                <strong>{streamError ? t(streamError) : t('正在等待浏览器画面')}</strong>
                <span>{t('发送一条需要访问网页的消息后，画面会自动出现。')}</span>
              </div>
            ) : null}
          </div>
          {streamError && hasPreviewVisual ? <div className="browser-chat-web-preview-alert">{t(streamError)}</div> : null}
          {inputError ? <div className="browser-chat-web-preview-alert">{t(inputError)}</div> : null}
          {previewDownload ? (
            <div className="browser-chat-web-preview-download-notice" role="status">
              {previewDownload.status === 'preparing' ? <Loader2 className="spin" size={14} /> : <Download size={14} />}
              <span>{previewDownload.status === 'preparing'
                ? '正在识别下载文件'
                : previewDownload.delivery === 'started' ? '已开始下载' : '检测到下载文件'}：{previewDownload.fileName}</span>
              {previewDownload.status === 'ready' ? (
                <button
                  onClick={() => void deliverPreviewDownload(previewDownload, { repeat: true, userInitiated: true })}
                  type="button"
                >{previewDownload.delivery === 'started' ? '重新下载' : '下载到本机'}</button>
              ) : null}
              <button
                aria-label="关闭下载提示"
                className="browser-chat-web-preview-download-dismiss"
                onClick={() => setPreviewDownload(null)}
                type="button"
              ><X size={13} /></button>
            </div>
          ) : null}
        </div>

    </AppModal>
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
  const { t } = useI18n();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const embeddedBrowserSyncRef = useRef({ boundsKey: '', groupId: '', hiddenConfirmed: false, sessionId: '', visible: false });
  const addressFocusedRef = useRef(false);
  const tabDragCommitTargetRef = useRef<EmbeddedBrowserTabDropTarget | null>(null);
  const tabDragCurrentGroupRef = useRef('');
  const tabDragSourceGroupRef = useRef('');
  const [bridgeAvailable, setBridgeAvailable] = useState(false);
  const [bridgeError, setBridgeError] = useState('');
  const [browserGroups, setBrowserGroups] = useState<EmbeddedBrowserGroup[]>([]);
  const [browserTabs, setBrowserTabs] = useState<EmbeddedBrowserTab[]>([]);
  const [activeTabId, setActiveTabId] = useState('');
  const [addressValue, setAddressValue] = useState('');
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [closedGroupIds, setClosedGroupIds] = useState<string[]>([]);
  const [draggingTabId, setDraggingTabId] = useState('');
  const [draggingTabSize, setDraggingTabSize] = useState<{ height: number; width: number } | null>(null);
  const [dragDropGroupId, setDragDropGroupId] = useState('');
  const [tabDragPreview, setTabDragPreview] = useState<EmbeddedBrowserTabDragPreview | null>(null);
  const [tabDragPortalTarget, setTabDragPortalTarget] = useState<HTMLElement | null>(null);
  const [tabListWidth, setTabListWidth] = useState(0);
  const [libraryPanel, setLibraryPanel] = useState<'library' | null>(null);
  const [newGroupDialogOpen, setNewGroupDialogOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [creatingNewGroup, setCreatingNewGroup] = useState(false);
  const [runtimeActivatedSessionId, setRuntimeActivatedSessionId] = useState('');
  const requestedGroupId = browserGroupId || embeddedGroupIdForSession(sessionId);
  const requestedGroupAvailable = useMemo(() => (
    Boolean(requestedGroupId) && (
      browserGroups.some((group) => (
        group.id === requestedGroupId
        && group.tabs.some((tab) => tab.groupId === requestedGroupId)
      ))
      || browserTabs.some((tab) => (
        Boolean(tab.groupId) && tab.groupId === requestedGroupId
      ))
    )
  ), [browserGroups, browserTabs, requestedGroupId]);
  // Historical conversations do not have a fresh browser:start/browser:reuse
  // log entry, but their persisted tab group is still safe to reattach. Keep
  // the runtime gate only for creating a missing group; otherwise selecting a
  // historical conversation detaches the native WebContentsView and leaves the
  // React-rendered tab strip above an empty browser surface.
  const runtimeAuthorized = Boolean(sessionId) && (
    requestedGroupAvailable
    || runtimeActivatedSessionId === sessionId
  );

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
    useSensor(MouseSensor, {
      activationConstraint: { distance: 3 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 180, tolerance: 8 },
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
    const scopedGroups = requestedGroupId ? (Array.isArray(result.groups) ? result.groups : [])
      .filter((group) => Boolean(group.id) && group.id === requestedGroupId) : [];
    const scopedTabs = requestedGroupId ? (Array.isArray(result.tabs) ? result.tabs : [])
      .filter((tab) => Boolean(tab.groupId) && tab.groupId === requestedGroupId) : [];
    const scopedTabIds = new Set([
      ...scopedTabs.map((tab) => tab.id),
      ...scopedGroups.flatMap((group) => group.tabs.map((tab) => tab.id)),
    ]);
    setBrowserGroups(scopedGroups);
    setBrowserTabs(scopedTabs);
    setLibraryPanel(result.libraryPanel === 'library' ? result.libraryPanel : null);
    setActiveTabId(scopedTabIds.has(result.activeTabId || '') ? result.activeTabId || '' : '');
    setCanGoBack(Boolean(result.canGoBack));
    setCanGoForward(Boolean(result.canGoForward));
  }, [requestedGroupId]);

  const loadEmbeddedBrowserState = useCallback(async () => {
    const bridge = window.webPilotEmbeddedBrowser;
    setBridgeAvailable(Boolean(bridge));
    if (!bridge) {
      setBrowserGroups([]);
      setBrowserTabs([]);
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
    const visible = enabled && active && Boolean(viewport) && Boolean(requestedGroupId) && runtimeAuthorized
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
        if (!previous.visible && previous.hiddenConfirmed) return;
        embeddedBrowserSyncRef.current = {
          boundsKey: '',
          groupId: '',
          hiddenConfirmed: true,
          sessionId: '',
          visible: false,
        };
        const result = await bridge.setVisible({ visible: false });
        setBridgeError(result.ok ? '' : result.error || '嵌入浏览器不可用');
        if (result.ok) applyEmbeddedBrowserState(result);
        return;
      }

      if (options.forceAttach || !previous.visible || previous.groupId !== groupId || previous.sessionId !== (sessionId || '')) {
        embeddedBrowserSyncRef.current = {
          boundsKey,
          groupId,
          hiddenConfirmed: false,
          sessionId: sessionId || '',
          visible: true,
        };
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
        embeddedBrowserSyncRef.current = {
          boundsKey,
          groupId,
          hiddenConfirmed: false,
          sessionId: sessionId || '',
          visible: true,
        };
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
    embeddedBrowserSyncRef.current = {
      boundsKey: '',
      groupId: '',
      hiddenConfirmed: true,
      sessionId: '',
      visible: false,
    };
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
    const label = newGroupName.trim() || t('新建标签组');
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
      setNewGroupName('');
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
    const groupId = activeEmbeddedTab?.groupId || requestedGroupId || undefined;
    if (!groupId) {
      setBridgeError('当前对话的浏览器标签组尚未创建');
      return;
    }
    const targetSessionId = activeEmbeddedTab?.sessionId
      || (groupId?.startsWith('session:') ? embeddedSessionIdFromGroupId(groupId) : undefined)
      || sessionId;
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
    setDraggingTabSize(null);
    setDragDropGroupId('');
    if (!keepPreview) setTabDragPreview(null);
  }

  const selectedGroupId = browserGroupId || embeddedGroupIdForSession(sessionId);
  const visibleGroups = useMemo<EmbeddedBrowserGroup[]>(() => {
    if (!selectedGroupId) return [];
    const selectedGroup = browserGroups.find((group) => group.id === selectedGroupId);
    if (!requestedGroupAvailable) {
      if (!sessionId || closedGroupIds.includes(selectedGroupId)) return [];
      return [{
        ...selectedGroup,
        active: true,
        id: selectedGroupId,
        sessionId: selectedGroup?.sessionId || sessionId,
        tabs: [],
      }];
    }
    const tabsById = new Map<string, EmbeddedBrowserTab>();
    for (const tab of selectedGroup?.tabs || []) {
      if (tab.groupId === selectedGroupId) tabsById.set(tab.id, tab);
    }
    for (const tab of browserTabs) {
      if (!tab.groupId || tab.groupId !== selectedGroupId) continue;
      tabsById.set(tab.id, tab);
    }
    return [{
      active: true,
      activeTabId: selectedGroup?.activeTabId,
      collapsed: Boolean(selectedGroup?.collapsed),
      id: selectedGroupId,
      label: selectedGroup?.label,
      sessionId: selectedGroup?.sessionId || sessionId,
      tabs: [...tabsById.values()],
    }];
  }, [browserGroups, browserTabs, closedGroupIds, requestedGroupAvailable, selectedGroupId, sessionId]);

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
  const embeddedTabLayout = useMemo(() => {
    const expandedGroups = renderedVisibleGroups.filter((group) => !group.collapsed);
    const tabCount = expandedGroups.reduce((total, group) => total + group.tabs.length, 0);
    const groupCount = renderedVisibleGroups.length;
    const groupGapWidth = Math.max(0, groupCount - 1) * 5;
    const tagToTabGapWidth = expandedGroups.filter((group) => group.tabs.length > 0).length * 4;
    const stackPaddingWidth = expandedGroups.length * 20;
    const fixedWidth = groupCount * 28
      + groupGapWidth
      + tagToTabGapWidth
      + stackPaddingWidth;
    const requestedWidth = tabListWidth > 0 && tabCount > 0
      ? Math.floor((tabListWidth - fixedWidth) / tabCount)
      : 210;
    const { density, width: tabWidth } = resolveEmbeddedBrowserTabLayout(requestedWidth);
    return {
      density,
      style: { '--embedded-tab-width': `${tabWidth}px` } as CSSProperties,
    };
  }, [renderedVisibleGroups, tabListWidth]);

  const activeEmbeddedTab = useMemo(() => {
    const activeGroup = visibleGroups[0];
    const activeGroupTabs = activeGroup?.tabs || [];
    const scopedActiveTabId = activeGroup?.activeTabId
      || (activeGroupTabs.some((tab) => tab.id === activeTabId) ? activeTabId : '');
    return activeGroupTabs.find((tab) => tab.id === scopedActiveTabId) || activeGroupTabs[0];
  }, [activeTabId, visibleGroups]);

  useEffect(() => {
    const tabList = tabListRef.current;
    if (!tabList || !activeEmbeddedTab?.id) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const activeTab = tabList.querySelector<HTMLElement>('.browser-chat-embedded-tab[aria-selected="true"]');
      if (!activeTab) return;
      const scrollViewport = activeTab.closest<HTMLElement>('.browser-chat-embedded-tab-stack') || tabList;
      const listRect = scrollViewport.getBoundingClientRect();
      const tabRect = activeTab.getBoundingClientRect();
      const leftDelta = tabRect.left - listRect.left;
      const rightDelta = tabRect.right - listRect.right;
      if (leftDelta < 0) scrollViewport.scrollBy({ left: leftDelta - 8, behavior: 'auto' });
      else if (rightDelta > 0) scrollViewport.scrollBy({ left: rightDelta + 8, behavior: 'auto' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeEmbeddedTab?.id, renderedVisibleGroups]);

  function handleEmbeddedTabListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const currentTab = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>('.browser-chat-embedded-tab')
      : null;
    if (!currentTab || event.target !== currentTab) return;
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('.browser-chat-embedded-tab:not(.dragging)'));
    const currentIndex = tabs.indexOf(currentTab);
    if (currentIndex < 0 || !tabs.length) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : event.key === 'ArrowLeft'
          ? (currentIndex - 1 + tabs.length) % tabs.length
          : (currentIndex + 1) % tabs.length;
    tabs[nextIndex]?.focus({ preventScroll: true });
    tabs[nextIndex]?.click();
  }

  function handleEmbeddedTabStackWheel(event: ReactWheelEvent<HTMLDivElement>) {
    const stack = event.currentTarget;
    const previousScrollLeft = stack.scrollLeft;
    const nextScrollLeft = resolveEmbeddedBrowserWheelScrollLeft({
      clientWidth: stack.clientWidth,
      deltaMode: event.deltaMode,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      scrollLeft: previousScrollLeft,
      scrollWidth: stack.scrollWidth,
    });
    if (nextScrollLeft === previousScrollLeft) return;
    event.preventDefault();
    stack.scrollLeft = nextScrollLeft;
  }

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
    const sourceElement = event.activatorEvent.target instanceof Element
      ? event.activatorEvent.target.closest<HTMLElement>('.browser-chat-embedded-tab')
      : null;
    const sourceRect = sourceElement?.getBoundingClientRect() || event.active.rect.current.initial;
    setDraggingTabSize(sourceRect ? { height: sourceRect.height, width: sourceRect.width } : null);
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
      aria-label={t('嵌入浏览器')}
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
              onKeyDown={handleEmbeddedTabListKeyDown}
              ref={tabListRef}
              role="tablist"
              aria-label={t('嵌入浏览器标签页')}
              style={embeddedTabLayout.style}
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
                        title={isCollapsedGroup
                          ? t('展开 {name} 标签组', { name: groupLabel })
                          : t('收起 {name} 标签组', { name: groupLabel })}
                        type="button"
                      >
                        {isCollapsedGroup ? <Folder size={16} /> : <FolderOpen size={16} />}
                        <span>{groupLabel}</span>
                      </button>
                      <button
                        aria-label={t('关闭 {name} 标签组', { name: groupLabel })}
                        className="browser-chat-embedded-tab-group-action browser-chat-embedded-tab-group-close"
                        onClick={(event) => {
                          event.stopPropagation();
                          void closeEmbeddedBrowserGroup(group);
                        }}
                        title={t('关闭 {name} 标签组', { name: groupLabel })}
                        type="button"
                      >
                        <X size={13} />
                      </button>
                      <button
                        aria-label={t('在 {name} 中新建标签页', { name: groupLabel })}
                        className="browser-chat-embedded-tab-group-action browser-chat-embedded-tab-group-add"
                        onClick={(event) => {
                          event.stopPropagation();
                          void createEmbeddedBrowserTab(group);
                        }}
                        title={t('在 {name} 中新建标签页', { name: groupLabel })}
                        type="button"
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                    <SortableContext
                      items={group.tabs.map((tab) => embeddedBrowserTabDndId(tab.id))}
                      strategy={horizontalListSortingStrategy}
                    >
                      <div
                        className="browser-chat-embedded-tab-stack"
                        onWheel={handleEmbeddedTabStackWheel}
                      >
                        {group.tabs.map((tab) => {
                          const tabIndex = browserTabs.findIndex((item) => item.id === tab.id);
                          const isActiveTab = tab.id === activeEmbeddedTab?.id;
                          return (
                            <EmbeddedBrowserSortableTab
                              active={isActiveTab}
                              density={embeddedTabLayout.density}
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
                style={draggingTabSize ? {
                  height: `${draggingTabSize.height}px`,
                  width: `${draggingTabSize.width}px`,
                } : undefined}
                zIndex={1200}
              >
                {draggedEmbeddedTab ? (
                  <div
                    aria-hidden="true"
                    className={[
                      'browser-chat-embedded-tab',
                      'browser-chat-embedded-tab-drag-overlay',
                      `browser-chat-embedded-tab--${embeddedTabLayout.density}`,
                      draggedEmbeddedTab.id === activeEmbeddedTab?.id ? 'active' : 'source-hovered',
                      draggedEmbeddedTab.pinned ? 'pinned' : '',
                      draggedEmbeddedTab.loading ? 'loading' : '',
                    ].filter(Boolean).join(' ')}
                    style={draggingTabSize ? {
                      flex: `0 0 ${draggingTabSize.width}px`,
                      height: `${draggingTabSize.height}px`,
                      maxWidth: `${draggingTabSize.width}px`,
                      minWidth: `${draggingTabSize.width}px`,
                      width: `${draggingTabSize.width}px`,
                    } : undefined}
                  >
                    <EmbeddedBrowserTabContent tab={draggedEmbeddedTab} />
                    <EmbeddedBrowserTabActions tab={draggedEmbeddedTab} />
                  </div>
                ) : null}
              </DragOverlay>,
              tabDragPortalTarget,
            ) : null}
          </DndContext>
          <button
            aria-label={t('新建标签组')}
            className="browser-chat-embedded-new-group"
            onClick={() => {
              setNewGroupDialogOpen(true);
              onDialogOpenChange?.(true);
            }}
            title={t('新建标签组')}
            type="button"
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="browser-chat-embedded-toolbar">
          <div className="browser-chat-embedded-nav-controls">
            <button className="browser-chat-embedded-tool-button" disabled={!canGoBack} onClick={() => void goEmbeddedBrowserBack()} title={t('后退')} type="button" aria-label={t('后退')}>
              <ArrowLeft size={16} />
            </button>
            <button className="browser-chat-embedded-tool-button" disabled={!canGoForward} onClick={() => void goEmbeddedBrowserForward()} title={t('前进')} type="button" aria-label={t('前进')}>
              <ArrowRight size={16} />
            </button>
            <button
              aria-label={isEmbeddedBrowserLoading ? t('停止加载') : t('重新加载')}
              className={isEmbeddedBrowserLoading ? 'browser-chat-embedded-tool-button is-stop' : 'browser-chat-embedded-tool-button'}
              disabled={!activeEmbeddedTab}
              onClick={() => void (isEmbeddedBrowserLoading ? stopEmbeddedBrowserLoading() : reloadEmbeddedBrowser())}
              title={isEmbeddedBrowserLoading ? t('停止加载') : t('重新加载')}
              type="button"
            >
              {isEmbeddedBrowserLoading ? <X size={16} /> : <RefreshCw size={15} />}
            </button>
          </div>
          <form className="browser-chat-embedded-address-bar" onSubmit={navigateEmbeddedBrowserAddress}>
            <AppInput
              ref={addressInputRef}
              aria-label={t('地址')}
              disabled={!bridgeAvailable}
              onBlur={() => {
                addressFocusedRef.current = false;
                setAddressValue(embeddedBrowserDisplayUrl(activeEmbeddedTab));
              }}
              onChange={(event) => setAddressValue(event.currentTarget.value)}
              onFocus={() => {
                addressFocusedRef.current = true;
              }}
              prefix={<span className="browser-chat-embedded-address-icon" aria-hidden="true">
                {addressValue.startsWith('https://') ? <Lock size={14} /> : <Globe size={14} />}
              </span>}
              spellCheck={false}
              value={addressValue}
            />
            <button
              aria-label={activeEmbeddedTab?.bookmarked ? t('取消收藏当前页面') : t('收藏当前页面')}
              className={activeEmbeddedTab?.bookmarked ? 'browser-chat-embedded-address-action active' : 'browser-chat-embedded-address-action'}
              disabled={!activeEmbeddedTab}
              onClick={() => void toggleEmbeddedBrowserBookmark()}
              title={activeEmbeddedTab?.bookmarked ? t('取消收藏') : t('收藏此页面')}
              type="button"
            >
              <Star fill={activeEmbeddedTab?.bookmarked ? 'currentColor' : 'none'} size={18} />
            </button>
          </form>
          <div className="browser-chat-embedded-library-actions">
            <button
              aria-expanded={libraryPanel === 'library'}
              aria-label={t('收藏与历史记录')}
              className={libraryPanel === 'library' ? 'browser-chat-embedded-tool-button active' : 'browser-chat-embedded-tool-button'}
              onClick={() => void toggleEmbeddedBrowserLibraryPanel()}
              title={t('收藏与历史记录')}
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
            <strong>{t('仅桌面端可用')}</strong>
            <span>{t('请使用 Electron 开发壳或桌面版打开。')}</span>
          </div>
        ) : bridgeError ? (
          <div className="browser-chat-embedded-state">
            <Bug size={24} />
            <strong>{t('嵌入浏览器未就绪')}</strong>
            <span>{t(bridgeError)}</span>
          </div>
        ) : null}
      </div>
    </section>
    {newGroupDialogOpen ? (
      <AppModal
        ariaLabel={t('新建浏览器标签组')}
        dismissable={!creatingNewGroup}
        keyboardDismissable={!creatingNewGroup}
        onClose={() => {
          if (creatingNewGroup) return;
          setNewGroupDialogOpen(false);
          onDialogOpenChange?.(false);
        }}
        size="sm"
      >
        <form
          className="webpilot-modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            void createEmbeddedBrowserGroup();
          }}
        >
          <header className="ui-modal-header">
            <div className="ui-modal-heading">
              <h2 className="ui-modal-title">{t('新建标签组')}</h2>
              <p className="ui-modal-subtitle">{t('标签组可在对话工具栏中单独绑定。')}</p>
            </div>
            <button
              aria-label={t('关闭')}
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
              {t('标签组名称')}
              <AppInput
                autoFocus
                disabled={creatingNewGroup}
                onChange={(event) => setNewGroupName(event.target.value)}
                placeholder={t('新建标签组')}
                value={newGroupName}
              />
            </label>
          </div>
          <footer className="ui-modal-footer">
            <button className="ui-button ui-button--primary" disabled={creatingNewGroup} type="submit">
              {creatingNewGroup ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}
              {creatingNewGroup ? t('创建中…') : t('创建并绑定')}
            </button>
          </footer>
        </form>
      </AppModal>
    ) : null}
    </>
  );
});

export function BrowserChatWorkspace({
  defaultUserId,
  initialSidebarCollapsed = false,
}: {
  defaultUserId: string;
  initialSidebarCollapsed?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryUserId = defaultUserId.trim() || '1';
  const querySessionId = searchParams.get('sessionId')?.trim() || '';
  const queryTargetUrl = searchParams.get('targetUrl')?.trim() || '';
  const mountedIdentityRef = useRef<{ sessionId: string; targetUrl: string; userId: string } | null>(null);
  const initialDataLoadStartedRef = useRef(false);
  const sessionHistoryLoadSequenceRef = useRef(0);
  if (!mountedIdentityRef.current && searchParams.get('webpilotEmbed') === '1') {
    mountedIdentityRef.current = { sessionId: querySessionId, targetUrl: queryTargetUrl, userId: queryUserId };
  }
  const requestUserId = mountedIdentityRef.current?.userId || queryUserId;
  const requestedSessionId = mountedIdentityRef.current?.sessionId || querySessionId;
  const requestedTargetUrl = mountedIdentityRef.current?.targetUrl || queryTargetUrl;
  const browserChatApiUrl = useCallback((path: string) => withWebPilotBasePath(path), []);
  const { language, t } = useI18n();
  const {
    initialize: initializeSkills,
    loadMore: loadMoreSkills,
    loadingMore: loadingMoreSkills,
    page: skillListPage,
    reload: loadSkills,
    search: searchSkills,
    skills,
  } = useBrowserChatSkillCatalog(browserChatApiUrl, t);
  const { mode: themeMode, setMode } = useTheme();
  const {
    closeFilePreview,
    filePreviewOpen,
    openFilePreview,
  } = useFilePreview();
  const initialModelSelection = resolveRuntimeModelSelection(null);
  const sendingRef = useRef(false);
  const loadingSessionRef = useRef<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const embeddedWorkspaceRef = useRef<HTMLDivElement | null>(null);
  const recentSessionListRef = useRef<HTMLOListElement | null>(null);
  const recentSessionListEndRef = useRef<HTMLLIElement | null>(null);
  const recentSessionListFailedCursorRef = useRef('');
  const activeSessionIdRef = useRef<string | null>(null);
  const releaseSessionRuntime = useCallback((sessionId: string | null | undefined) => {
    const normalized = sessionId?.trim() || '';
    if (!normalized) return;
    void fetch(browserChatApiUrl(`/api/browser-chat/${normalized}/release`), {
      keepalive: true,
      method: 'POST',
    }).catch(() => undefined);
  }, [browserChatApiUrl]);
  const sessionActivationSequenceRef = useRef(0);
  const sessionSelectionIntentRef = useRef(0);
  const mountedSessionActivationRef = useRef('');
  const interruptRequestSequenceRef = useRef(0);
  const interruptingRef = useRef(false);
  const interruptGuardsRef = useRef(new Map<string, BrowserChatInterruptGuard>());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed);
  const [session, setSession] = useState<BrowserChatSession | null>(null);
  const [sessions, setSessions] = useState<BrowserChatSession[]>([]);
  const applySessionListPage = useCallback((incoming: BrowserChatSession[]) => {
    const normalized = incoming.map((item) => compactBrowserChatSessionForList(normalizeSession(item)));
    setSessions((current) => {
      const byId = new Map(current.map((item) => [item.id, item]));
      for (const item of normalized) byId.set(item.id, item);
      return [...byId.values()].sort((a, b) => sessionSortTime(b).localeCompare(sessionSortTime(a)));
    });
  }, []);
  const {
    initialize: initializeSessionListPage,
    loadMore: loadMoreSessions,
    loadingMore: loadingMoreSessions,
    page: sessionListPage,
  } = useBrowserChatSessionPagination(browserChatApiUrl, applySessionListPage, t);
  const [safetyMode, setSafetyMode] = useState<BrowserChatSafetyMode>('strict');
  const [modelProvider, setModelProvider] = useState<ModelProvider>(() => initialModelSelection.provider);
  const [modelId, setModelId] = useState(() => initialModelSelection.model);
  const [modelConfig, setModelConfig] = useState<BrowserChatModelConfig | null>(null);
  const [attachments, setAttachments] = useState<BrowserChatAttachment[]>([]);
  const attachmentsRef = useRef<BrowserChatAttachment[]>([]);
  const [composerResetToken, setComposerResetToken] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pendingMessageSessionId, setPendingMessageSessionId] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [embeddedBrowserEnabled, setEmbeddedBrowserEnabled] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);
  const [embeddedChatWidth, setEmbeddedChatWidth] = useState(420);
  const [embeddedChatCollapsed, setEmbeddedChatCollapsed] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [deletingSessionIds, setDeletingSessionIds] = useState<Set<string>>(() => new Set());
  const deletingSessionIdsRef = useRef(new Set<string>());
  const [deletingSelectedSessions, setDeletingSelectedSessions] = useState(false);
  const [recentSelectionMode, setRecentSelectionMode] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [historyFilter, setHistoryFilter] = useState('');
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const [generatingAutomationMessageId, setGeneratingAutomationMessageId] = useState<string | null>(null);
  const [generatingSkillMessageId, setGeneratingSkillMessageId] = useState<string | null>(null);
  const [messageGenerationDialog, setMessageGenerationDialog] = useState<BrowserChatMessageGenerationDialog | null>(null);
  const [messageGenerationError, setMessageGenerationError] = useState('');
  const [managementTab, setManagementTab] = useState<BrowserChatManagementTab | null>(null);
  const personalMemoryRefreshToken = session?.logs.reduce(
    (token, log) => log.phase === 'memory:extract:done' ? log.id : token,
    '',
  ) || '';
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [sessionMinimumLoadingElapsed, setSessionMinimumLoadingElapsed] = useState(false);
  const [loadingSessionHistory, setLoadingSessionHistory] = useState(true);
  const [messageViewportReady, setMessageViewportReady] = useState(false);
  const [messageViewportGeneration, setMessageViewportGeneration] = useState(0);
  const [loadingEarlierHistory, setLoadingEarlierHistory] = useState(false);
  const [logDialogMessageId, setLogDialogMessageId] = useState<string | null>(null);
  const [toolDialog, setToolDialog] = useState<BrowserChatToolDetail | null>(null);
  const toolDialogAbortRef = useRef<AbortController | null>(null);
  const [resolvingConfirmationId, setResolvingConfirmationId] = useState<string | null>(null);
  const [resolvingConfirmationAction, setResolvingConfirmationAction] = useState<BrowserChatToolConfirmationAction | null>(null);
  const [resumingHumanVerification, setResumingHumanVerification] = useState(false);
  const [error, setError] = useState('');
  const [downloads, setDownloads] = useState<SystemDownloadItem[]>([]);
  const removedDownloadIdsRef = useRef(new Set<string>());
  const [downloadCenterOpen, setDownloadCenterOpen] = useState(false);
  const [browserGroupPickerOpen, setBrowserGroupPickerOpen] = useState(false);
  const [embeddedBrowserDialogOpen, setEmbeddedBrowserDialogOpen] = useState(false);
  const [webPreviewRuntime, setWebPreviewRuntime] = useState(false);
  const [webPreviewOpen, setWebPreviewOpen] = useState(false);
  const [editingConversationTitle, setEditingConversationTitle] = useState(false);
  const [conversationTitleDraft, setConversationTitleDraft] = useState('');
  const [savingConversationTitle, setSavingConversationTitle] = useState(false);
  const [shareLinkCopied, setShareLinkCopied] = useState(false);
  const shareLinkFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionUiKey = `${session?.userId || requestUserId}:${session?.id || 'new'}`;
  const selectedSessionRunning = isBrowserChatSessionRunning(session);
  const selectedRunningSession = selectedSessionRunning ? session : undefined;
  const currentBusy = busy || selectedSessionRunning || interrupting;
  const interruptSessionId = selectedRunningSession?.id || (busy ? pendingMessageSessionId || session?.id : undefined);
  const canInterruptConversation = Boolean(interruptSessionId && (busy || selectedSessionRunning));
  const messages = useMemo(() => session?.messages || [], [session?.messages]);
  const steps = useMemo(() => session?.steps || [], [session?.steps]);
  const logs = useMemo(() => session?.logs || [], [session?.logs]);
  const generationSkillsById = useMemo(() => new Map(skills.map((skill) => [skill.id, skill])), [skills]);
  const liveToolDialog = useMemo(() => {
    if (!toolDialog) return null;
    let resolvedDetail = toolDialog;
    if (toolDialog.tool.id && (toolDialog.step.status === 'running' || toolDialog.tool.ok === undefined)) {
      for (const step of steps) {
        const toolIndex = (step.tools || []).findIndex((tool) => tool.id === toolDialog.tool.id);
        if (toolIndex < 0) continue;
        const tool = step.tools?.[toolIndex];
        if (tool) resolvedDetail = { stepIndex: step.index, step, toolIndex, tool };
        break;
      }
    }
    const confirmation = toolUserActionForTool(
      logs,
      resolvedDetail.stepIndex,
      resolvedDetail.tool.name,
      resolvedDetail.tool.input,
    );
    return {
      ...resolvedDetail,
      confirmationScreenshotUrl: confirmation?.screenshotUrl || toolDialog.confirmationScreenshotUrl,
    };
  }, [logs, steps, toolDialog]);
  const visibleMessages = messages;
  const generatableMessageOptions = useMemo(() => visibleMessages.flatMap((message, messageIndex) => {
    if (message.role !== 'assistant' || message.status === 'running') return [];
    const declaredStepIndexes = new Set(message.stepIndexes || []);
    const ownedSteps = steps.filter((step) => (
      step.messageId === message.id || declaredStepIndexes.has(step.index)
    ));
    const knownStepIndexes = new Set([
      ...declaredStepIndexes,
      ...ownedSteps.map((step) => step.index),
    ]);
    if (!knownStepIndexes.size) return [];
    const previousUser = [...visibleMessages.slice(0, messageIndex)].reverse().find((item) => item.role === 'user');
    const titleMessage = previousUser || message;
    return [{
      id: message.id,
      title: browserChatGenerationPreviewText(titleMessage, generationSkillsById, {
        fallbackFileLabel: t('文件'),
        fallbackSkillLabel: 'Skill',
        max: 120,
      }) || t('AI 消息 {index}', { index: messageIndex + 1 }),
      summary: browserChatGenerationPreviewText(message, generationSkillsById, {
        fallbackFileLabel: t('文件'),
        fallbackSkillLabel: 'Skill',
        max: 160,
      }),
      stepCount: knownStepIndexes.size,
    }];
  }), [generationSkillsById, steps, t, visibleMessages]);
  const selectedGenerationMessageIdSet = useMemo(
    () => new Set(messageGenerationDialog?.selectedMessageIds || []),
    [messageGenerationDialog?.selectedMessageIds],
  );
  const allGeneratableMessagesSelected = generatableMessageOptions.length > 0
    && generatableMessageOptions.every((item) => selectedGenerationMessageIdSet.has(item.id));
  const messageGenerationSubmitting = Boolean(generatingSkillMessageId || generatingAutomationMessageId);
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
  const messageViewportPositioning = Boolean(loadingSessionHistory || loadingSessionId || (hasMessages && !messageViewportReady));
  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((current) => {
      const next = !current;
      writeSidebarCollapsedPreference(next);
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

  useLayoutEffect(() => {
    const storedSidebarCollapsed = readSidebarCollapsedPreference(initialSidebarCollapsed);
    setSidebarCollapsed(storedSidebarCollapsed);
    writeSidebarCollapsedPreference(storedSidebarCollapsed);
    setEmbeddedChatCollapsed(readStoredEmbeddedChatCollapsed());
    setWebPreviewRuntime(!window.webPilotEmbeddedBrowser);
  }, [initialSidebarCollapsed]);

  useEffect(() => {
    setWebPreviewOpen(false);
    toolDialogAbortRef.current?.abort();
    toolDialogAbortRef.current = null;
    setToolDialog(null);
    setLogDialogMessageId(null);
    closeFilePreview();
    setMessageGenerationDialog(null);
    setMessageGenerationError('');
    setBrowserGroupPickerOpen(false);
  }, [closeFilePreview, session?.id]);

  useEffect(() => () => {
    toolDialogAbortRef.current?.abort();
    toolDialogAbortRef.current = null;
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

  useEffect(() => {
    if (!session || selectedSessionRunning || session.pendingToolConfirmation) return undefined;
    const sessionId = session.id;
    const timer = window.setTimeout(() => {
      setSession((current) => {
        if (!current || current.id !== sessionId || isBrowserChatSessionRunning(current) || current.pendingToolConfirmation) {
          return current;
        }
        if (!current.logs.length && !current.steps.length && !current.outputCycles.length && !current.subagents.length) {
          return current;
        }
        return {
          ...current,
          logs: [],
          outputCycles: [],
          steps: [],
          subagents: [],
        };
      });
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, [selectedSessionRunning, session]);

  const stepsByIndex = useMemo(() => new Map(steps.map((step) => [step.index, step])), [steps]);
  const logIndex = useMemo(() => buildBrowserChatLogIndex(logs), [logs]);
  const logDialogMessage = useMemo(
    () => messages.find((item) => item.id === logDialogMessageId),
    [logDialogMessageId, messages],
  );
  const logDialogLiveEntries = useMemo(
    () => logDialogMessage ? browserChatLogsForMessage(logDialogMessage, logIndex) : [],
    [logDialogMessage, logIndex],
  );
  const previewAttachment = useCallback((attachment: BrowserChatAttachment) => {
    const source = attachment.url || (attachment.path
      ? withWebPilotBasePath(`/api/artifacts/${attachment.path.split('/').map(encodeURIComponent).join('/')}`)
      : '');
    openFilePreview({
      fileName: attachment.name || t('文件'),
      mimeType: attachment.type || undefined,
      source: source || (async () => { throw new Error(t('文件地址不可用')); }),
    });
  }, [openFilePreview, t]);

  const previewDownload = useCallback((download: SystemDownloadItem) => {
    openFilePreview({
      fileName: download.fileName || 'download',
      source: async () => {
        const bridge = typeof window === 'undefined' ? undefined : window.webPilotSystem;
        if (download.path && bridge?.readDownload) {
          const result = await bridge.readDownload({ id: download.id });
          if (result.ok && result.data) return result.data;
          if (!download.url) throw new Error(result.error || t('文件预览加载失败'));
        }
        if (download.url) return download.url;
        throw new Error(t('文件地址不可用'));
      },
    });
  }, [openFilePreview, t]);
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
  const loadMessageRecords = useCallback<BrowserChatMessageRecordLoader>(async (messageId, options = {}) => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) throw new Error('No active browser chat session');
    const params = new URLSearchParams({ limit: '200', messageId });
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.subagentsOnly) params.set('subagentsOnly', 'true');
    const response = await fetch(browserChatApiUrl(`/api/browser-chat/${sessionId}/logs?${params}`), {
      cache: 'no-store',
      signal: options.signal,
    });
    const data = await readApiJson<{
      history?: { cursor?: string; hasMore?: boolean };
      logs?: BrowserChatLogRecord[];
      outputCycles?: BrowserChatAiOutputCycle[];
      subagents?: BrowserChatSubagentRecord[];
      steps?: StepExecutionResult[];
    }>(response, '加载对话记录失败');
    return {
      history: {
        cursor: data.history?.cursor,
        hasMore: Boolean(data.history?.hasMore),
      },
      logs: Array.isArray(data.logs) ? data.logs : [],
      outputCycles: Array.isArray(data.outputCycles) ? data.outputCycles : [],
      steps: Array.isArray(data.steps) ? data.steps : [],
      subagents: Array.isArray(data.subagents) ? data.subagents : [],
    };
  }, [browserChatApiUrl]);
  const showMessageLogs = useCallback((messageId: string) => {
    setLogDialogMessageId(messageId);
  }, []);
  const showToolDetails = useCallback((detail: BrowserChatToolDetail) => {
    toolDialogAbortRef.current?.abort();
    const controller = new AbortController();
    toolDialogAbortRef.current = controller;
    setToolDialog(detail);
    const messageId = detail.step.messageId;
    if (!messageId) return;
    void loadMessageRecords(messageId, { signal: controller.signal })
      .then((records) => {
        if (controller.signal.aborted) return;
        const step = records.steps.find((item) => item.index === detail.stepIndex);
        if (!step) return;
        const toolIndex = detail.tool.id
          ? (step.tools || []).findIndex((tool) => tool.id === detail.tool.id)
          : detail.toolIndex;
        const tool = step.tools?.[toolIndex];
        if (!tool) return;
        const confirmation = toolUserActionForTool(records.logs, step.index, tool.name, tool.input);
        setToolDialog((current) => {
          if (!current || current.stepIndex !== detail.stepIndex || current.tool.id !== detail.tool.id) return current;
          return {
            confirmationScreenshotUrl: confirmation?.screenshotUrl || detail.confirmationScreenshotUrl,
            step,
            stepIndex: step.index,
            tool,
            toolIndex,
          };
        });
      })
      .catch(() => undefined)
      .finally(() => {
        if (toolDialogAbortRef.current === controller) toolDialogAbortRef.current = null;
      });
  }, [loadMessageRecords]);
  const closeToolDetails = useCallback(() => {
    toolDialogAbortRef.current?.abort();
    toolDialogAbortRef.current = null;
    setToolDialog(null);
  }, []);
  const loadEarlierHistory = useCallback(async () => {
    const current = session;
    const history = current?.history;
    if (!current || !history || !browserChatHasEarlierMessages(history) || loadingEarlierHistory) return;
    const params = new URLSearchParams();
    if (history.messages.hasMore && history.messages.cursor) params.set('messageCursor', history.messages.cursor);
    if (!params.size) return;
    const loadingStartedAt = Date.now();
    setLoadingEarlierHistory(true);
    setError('');
    try {
      const response = await fetch(browserChatApiUrl(`/api/browser-chat/${current.id}/history?${params.toString()}`), { cache: 'no-store' });
      const chunk = await readApiJson<{
        history?: Partial<BrowserChatHistoryState>;
        messages?: BrowserChatMessage[];
      }>(response, '加载更早对话记录失败');
      setSession((active) => active?.id === current.id ? mergeBrowserChatHistoryChunk(active, chunk) : active);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载更早对话记录失败');
    } finally {
      await waitForMinimumLoading(loadingStartedAt);
      setLoadingEarlierHistory(false);
    }
  }, [browserChatApiUrl, loadingEarlierHistory, session]);
  const sidebarSessions = useMemo(() => {
    const merged = new Map<string, BrowserChatSession>();
    for (const item of sessions) merged.set(item.id, item);
    if (session) merged.set(session.id, session);
    return [...merged.values()]
      .filter((item) => item.hasMessages || item.messages.length)
      .sort((a, b) => sessionSortTime(b).localeCompare(sessionSortTime(a)));
  }, [session, sessions]);
  const recentSessions = useMemo(() => sidebarSessions, [sidebarSessions]);
  const filteredRecentSessions = useMemo(() => {
    const query = historyFilter.trim().toLocaleLowerCase();
    if (!query) return recentSessions;
    return sidebarSessions.filter((item) => sessionDisplayTitle(item).toLocaleLowerCase().includes(query));
  }, [historyFilter, recentSessions, sidebarSessions]);
  useEffect(() => {
    if (loadingSessionHistory || loadingMoreSessions || !sessionListPage.hasMore || !sessionListPage.next) return undefined;
    const list = recentSessionListRef.current;
    const listEnd = recentSessionListEndRef.current;
    if (!list || !listEnd) return undefined;
    const cursorKey = `${sessionListPage.next.beforeUpdatedAt || ''}\u0000${sessionListPage.next.beforeId || ''}`;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting) || recentSessionListFailedCursorRef.current === cursorKey) return;
      void loadMoreSessions().catch((loadError) => {
        recentSessionListFailedCursorRef.current = cursorKey;
        setError(loadError instanceof Error ? loadError.message : '加载更多对话失败');
      });
    }, { root: list, rootMargin: '80px' });
    observer.observe(listEnd);
    return () => observer.disconnect();
  }, [historyFilter, loadingMoreSessions, loadingSessionHistory, loadMoreSessions, mobileHistoryOpen, sessionListPage.hasMore, sessionListPage.next]);
  const selectedSessionIdSet = useMemo(() => new Set(selectedSessionIds), [selectedSessionIds]);
  const selectableRecentSessionIds = useMemo(
    () => filteredRecentSessions.filter((item) => !item.busy).map((item) => item.id),
    [filteredRecentSessions],
  );
  const selectableRecentSessionIdSet = useMemo(() => new Set(selectableRecentSessionIds), [selectableRecentSessionIds]);
  const selectedDeletableSessionIds = useMemo(
    () => selectedSessionIds.filter((id) => selectableRecentSessionIdSet.has(id)),
    [selectableRecentSessionIdSet, selectedSessionIds],
  );
  const allSelectableRecentSessionsSelected = selectableRecentSessionIds.length > 0
    && selectableRecentSessionIds.every((id) => selectedSessionIdSet.has(id));
  const embeddedBrowserActive = embeddedBrowserEnabled;
  const embeddedBrowserCovered = Boolean(toolDialog || logDialogMessageId || filePreviewOpen || embeddedBrowserDialogOpen || managementTab || messageGenerationDialog);
  const embeddedBrowserViewActive = embeddedBrowserActive && !embeddedBrowserCovered;
  const modelSelection = modelSelectionValueForConfig(modelConfig, { model: modelId, provider: modelProvider });
  const modelSelectionDiagnostic = modelSelectionDiagnosticLabel(modelConfig, { model: modelId, provider: modelProvider });
  const modelSelectionOptions = useMemo(() => modelSelectionOptionsForConfig(modelConfig), [modelConfig]);
  const selectedModelSupportsImageInput = modelCapabilities(
    modelConfig?.providers?.[modelProvider],
    modelProvider,
    modelId,
  ).imageInput;
  const selectedModelLabel = modelSelectionOptions.find((option) => option.value === modelSelection)?.selectedLabel
    || modelSelectionOptions.find((option) => option.value === modelSelection)?.label
    || modelSelectionDiagnostic;
  const downloadPanelWidth = embeddedBrowserActive
    ? Math.max(260, Math.min(360, embeddedChatWidth - 36))
    : 380;
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
    void fetch(withWebPilotBasePath('/api/settings/model-selection'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: next.provider, model: next.model }),
    })
      .then(async (response) => {
        const data = await readApiJson<Record<string, unknown>>(response, '保存模型选择失败');
        const persisted = normalizeRuntimeModelConfig(data.config as Partial<BrowserChatModelConfig> | undefined);
        if (persisted) setModelConfig(persisted);
      })
      .catch(() => undefined);
  }, [modelConfig]);

  const applyBrowserRuntimeSettings = useCallback((saved: Array<{ key?: string; value?: string }>) => {
    const embeddedSetting = saved.find((item) => item.key === 'ELECTRON_EMBEDDED_BROWSER');
    const reasoningSetting = saved.find((item) => item.key === 'BROWSER_CHAT_SHOW_REASONING');
    setEmbeddedBrowserEnabled(embeddedSetting?.value === 'true');
    setShowReasoning(reasoningSetting?.value === 'true');
  }, []);

  const applyModelConfig = useCallback((value: Partial<BrowserChatModelConfig> | undefined) => {
    const config = normalizeRuntimeModelConfig(value);
    if (config) setModelConfig(config);
  }, []);

  const beginEmbeddedChatResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const workspace = embeddedWorkspaceRef.current;
    if (!workspace) return;
    const resizeWorkspace: HTMLDivElement = workspace;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const rect = resizeWorkspace.getBoundingClientRect();
    const minChatWidth = 320;
    const minBrowserWidth = 380;
    const maxChatWidth = Math.max(minChatWidth, Math.min(760, rect.width - minBrowserWidth - 8));
    let pendingWidth = embeddedChatWidth;
    let resizeFrame = 0;

    function nextWidth(clientX: number) {
      return Math.round(Math.max(minChatWidth, Math.min(maxChatWidth, rect.right - clientX)));
    }

    function applyPendingWidth() {
      resizeFrame = 0;
      resizeWorkspace.style.setProperty('--embedded-chat-width', `${pendingWidth}px`);
    }

    function queueWidth(clientX: number) {
      pendingWidth = nextWidth(clientX);
      if (!resizeFrame) resizeFrame = window.requestAnimationFrame(applyPendingWidth);
    }

    queueWidth(event.clientX);
    const onPointerMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      queueWidth(moveEvent.clientX);
    };
    const onPointerUp = (upEvent: PointerEvent) => {
      if (upEvent.type === 'pointerup') pendingWidth = nextWidth(upEvent.clientX);
      if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
      applyPendingWidth();
      setEmbeddedChatWidth(pendingWidth);
      document.body.classList.remove('browser-chat-resizing');
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('pointercancel', onPointerUp, true);
    };
    document.body.classList.add('browser-chat-resizing');
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onPointerUp, true);
  }, [embeddedChatWidth]);

  const resizeEmbeddedChatWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const workspace = embeddedWorkspaceRef.current;
    if (!workspace) return;
    event.preventDefault();
    const minChatWidth = 320;
    const maxChatWidth = Math.max(minChatWidth, Math.min(760, workspace.getBoundingClientRect().width - 388));
    const nextWidth = event.key === 'Home'
      ? minChatWidth
      : event.key === 'End'
        ? maxChatWidth
        : Math.max(minChatWidth, Math.min(maxChatWidth, embeddedChatWidth + (event.key === 'ArrowRight' ? 24 : -24)));
    workspace.style.setProperty('--embedded-chat-width', `${nextWidth}px`);
    setEmbeddedChatWidth(nextWidth);
  }, [embeddedChatWidth]);

  useEffect(() => {
    if (session?.id) activeSessionIdRef.current = session.id;
  }, [session?.id]);

  useEffect(() => {
    setEditingConversationTitle(false);
    setConversationTitleDraft('');
    setShareLinkCopied(false);
  }, [session?.id]);

  useEffect(() => () => {
    if (shareLinkFeedbackTimerRef.current) clearTimeout(shareLinkFeedbackTimerRef.current);
  }, []);

  useEffect(() => () => {
    releaseSessionRuntime(activeSessionIdRef.current);
  }, [releaseSessionRuntime]);

  const upsertSession = useCallback((nextSession: BrowserChatSession, options: { activate?: boolean } = {}) => {
    let normalized = normalizeSession(nextSession);
    const guarded = applyBrowserChatInterruptGuard(normalized, interruptGuardsRef.current.get(normalized.id));
    if (guarded.release) interruptGuardsRef.current.delete(normalized.id);
    normalized = guarded.session;
    const shouldActivate = options.activate ?? activeSessionIdRef.current === normalized.id;
    if (shouldActivate) {
      setSession((current) => {
        const merged = mergeBrowserChatSessionWindow(current, normalized);
        return isOlderSessionSnapshot(merged, current) ? current : merged;
      });
    }
    setSessions((current) => {
      const existing = current.find((item) => item.id === normalized.id);
      const merged = mergeBrowserChatSessionWindow(existing, normalized);
      const accepted = isOlderSessionSnapshot(merged, existing) ? existing || merged : merged;
      const next = [compactBrowserChatSessionForList(accepted), ...current.filter((item) => item.id !== normalized.id)];
      return next.sort((a, b) => sessionSortTime(b).localeCompare(sessionSortTime(a)));
    });
    return normalized;
  }, []);

  const refreshSession = useCallback(async (sessionId: string, options: { activate?: boolean; activateIf?: () => boolean } = {}) => {
    const data = await readBrowserChatInitialRequest(
      browserChatApiUrl(`/api/browser-chat/${sessionId}`),
      '加载对话失败',
    );
    const shouldActivate = options.activateIf?.() ?? options.activate ?? activeSessionIdRef.current === sessionId;
    const loadedSession = upsertSession(data.session as BrowserChatSession, { activate: shouldActivate });
    if (shouldActivate) {
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
    const previousSessionId = activeSessionIdRef.current;
    const activationSequence = ++sessionActivationSequenceRef.current;
    loadingSessionRef.current = sessionId;
    activeSessionIdRef.current = sessionId;
    setSession((current) => current?.id === sessionId ? current : null);
    if (previousSessionId && previousSessionId !== sessionId) releaseSessionRuntime(previousSessionId);
    const loadingStartedAt = Date.now();
    setLoadingSessionId(sessionId);
    setSessionMinimumLoadingElapsed(false);
    setMessageViewportReady(false);
    setMessageViewportGeneration((current) => current + 1);
    await waitForBrowserPaint();
    try {
      const loadedSession = await refreshSession(sessionId, {
        activateIf: () => (
          sessionActivationSequenceRef.current === activationSequence
          && activeSessionIdRef.current === sessionId
        ),
      });
      if (sessionActivationSequenceRef.current === activationSequence && !loadedSession.messages.length) {
        setMessageViewportReady(true);
      }
      return loadedSession;
    } catch (loadError) {
      if (sessionActivationSequenceRef.current === activationSequence) setMessageViewportReady(true);
      throw loadError;
    } finally {
      await waitForMinimumLoading(loadingStartedAt);
      if (sessionActivationSequenceRef.current === activationSequence) {
        setSessionMinimumLoadingElapsed(true);
      }
    }
  }, [refreshSession, releaseSessionRuntime]);

  const applyLoadedSessions = useCallback(async (items: BrowserChatSession[]) => {
    const selectionIntent = sessionSelectionIntentRef.current;
    const nextSessions = items.map((item) => {
      const normalized = normalizeSession(item);
      const guarded = applyBrowserChatInterruptGuard(normalized, interruptGuardsRef.current.get(normalized.id));
      if (guarded.release) interruptGuardsRef.current.delete(normalized.id);
      return compactBrowserChatSessionForList(guarded.session);
    });
    setSessions(nextSessions);
    if (sessionSelectionIntentRef.current !== selectionIntent) return;
    await loadRequestedBrowserChatSessionDetail(requestedSessionId, async (requestedSessionId) => {
      if (!shouldActivateRequestedBrowserChatSession({
        activeSessionId: activeSessionIdRef.current,
        currentSelectionIntent: sessionSelectionIntentRef.current,
        requestedSessionId,
        selectionIntent,
      })) return undefined;
      if (mountedSessionActivationRef.current === requestedSessionId) return;
      mountedSessionActivationRef.current = requestedSessionId;
      if (!mountedIdentityRef.current) {
        window.history.replaceState(null, '', browserChatSessionNavigationHref(window.location.href, requestedSessionId));
      }
      try {
        await activateSession(requestedSessionId);
      } catch (loadError) {
        if (mountedSessionActivationRef.current === requestedSessionId) mountedSessionActivationRef.current = '';
        throw loadError;
      }
    });
  }, [activateSession, requestedSessionId]);

  const loadSessions = useCallback(async () => {
    const loadingSequence = ++sessionHistoryLoadSequenceRef.current;
    const loadingStartedAt = Date.now();
    setLoadingSessionHistory(true);
    try {
      const response = await fetch(browserChatApiUrl('/api/browser-chat?limit=10'), { cache: 'no-store' });
      const data = await readApiJson<{ page?: BrowserChatSessionListPage; sessions?: BrowserChatSession[] }>(response, '加载对话历史失败');
      initializeSessionListPage(data.page || {});
      await applyLoadedSessions(Array.isArray(data.sessions) ? data.sessions as BrowserChatSession[] : []);
      await waitForBrowserPaint();
    } finally {
      await waitForMinimumLoading(loadingStartedAt);
      if (sessionHistoryLoadSequenceRef.current === loadingSequence) setLoadingSessionHistory(false);
    }
  }, [applyLoadedSessions, browserChatApiUrl, initializeSessionListPage]);

  const loadInitialBrowserChatData = useCallback(async () => {
    const data = await readBrowserChatInitialRequest(
      browserChatApiUrl('/api/browser-chat/bootstrap?sessionLimit=10'),
      '加载对话初始化数据失败',
    ) as BrowserChatBootstrapData;
    initializeSkills(Array.isArray(data.skills) ? data.skills : [], data.skillPage || {});
    initializeSessionListPage(data.sessionPage || {});
    applyModelConfig(data.model?.config);
    applyBrowserRuntimeSettings(Array.isArray(data.runtime) ? data.runtime : []);
    await applyLoadedSessions(Array.isArray(data.sessions) ? data.sessions : []);
  }, [applyBrowserRuntimeSettings, applyLoadedSessions, applyModelConfig, browserChatApiUrl, initializeSessionListPage, initializeSkills]);

  useEffect(() => {
    if (initialDataLoadStartedRef.current) return;
    initialDataLoadStartedRef.current = true;
    const loadingSequence = ++sessionHistoryLoadSequenceRef.current;
    const loadingStartedAt = Date.now();
    setLoadingSessionHistory(true);
    void (async () => {
      try {
        await loadInitialBrowserChatData();
        await waitForBrowserPaint();
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : '加载对话历史失败');
      } finally {
        await waitForMinimumLoading(loadingStartedAt);
        if (sessionHistoryLoadSequenceRef.current === loadingSequence) setLoadingSessionHistory(false);
      }
    })();
  }, [loadInitialBrowserChatData]);

  useEffect(() => {
    if (session?.id || !modelConfig?.provider) return;
    const nextModel = resolveRuntimeModelSelection(modelConfig);
    setModelProvider(nextModel.provider);
    setModelId(nextModel.model);
  }, [modelConfig, session?.id]);

  useEffect(() => {
    setModelId((current) => resolveRuntimeModelSelection(modelConfig, { model: current, provider: modelProvider }).model);
  }, [modelConfig, modelProvider]);

  const handleRealtimeRefresh = useCallback((event: import('@/lib/realtime-refresh').RealtimeRefreshEvent) => {
    if (event.deleted) {
      interruptGuardsRef.current.delete(event.id);
      setSessions((current) => current.filter((item) => item.id !== event.id));
      if (activeSessionIdRef.current === event.id) {
        activeSessionIdRef.current = null;
      }
      setSession((current) => (current?.id === event.id ? null : current));
      setSelectedSessionIds((current) => current.filter((id) => id !== event.id));
      return;
    }
    const patch = browserChatRealtimePatch(event.patch);
    if (!patch) return;
    if (activeSessionIdRef.current === event.id) {
      setSession((current) => {
        if (current?.id !== event.id) return current;
        const merged = mergeBrowserChatSessionRealtimePatch(current, patch);
        const guarded = applyBrowserChatInterruptGuard(merged, interruptGuardsRef.current.get(event.id));
        if (guarded.release) interruptGuardsRef.current.delete(event.id);
        return guarded.session;
      });
    }
    setSessions((current) => {
      const existing = current.find((item) => item.id === event.id);
      const summaryIsCurrent = patch.summary && (!existing
        || !existing.updatedAt
        || !patch.summary.updatedAt
        || patch.summary.updatedAt >= existing.updatedAt);
      const nextSummary = summaryIsCurrent && patch.summary
        ? normalizeSession(patch.summary)
        : existing
          ? mergeBrowserChatSessionRealtimePatch(existing, patch)
          : undefined;
      if (!nextSummary) return current;
      const guarded = applyBrowserChatInterruptGuard(nextSummary, interruptGuardsRef.current.get(event.id));
      if (guarded.release) interruptGuardsRef.current.delete(event.id);
      return [compactBrowserChatSessionForList(guarded.session), ...current.filter((item) => item.id !== event.id)]
        .sort((a, b) => sessionSortTime(b).localeCompare(sessionSortTime(a)));
    });
  }, []);

  const resyncRealtimeSessions = useCallback(async () => {
    const activeSessionId = activeSessionIdRef.current;
    await loadSessions();
    if (activeSessionId) await refreshSession(activeSessionId, { activate: true });
  }, [loadSessions, refreshSession]);

  useBrowserChatRealtime({
    onRefresh: handleRealtimeRefresh,
    onResync: resyncRealtimeSessions,
  });

  async function createSession() {
    sessionSelectionIntentRef.current += 1;
    const previousSessionId = activeSessionIdRef.current;
    if (previousSessionId) releaseSessionRuntime(previousSessionId);
    const response = await fetch(browserChatApiUrl('/api/browser-chat/create'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ safetyMode, modelProvider, model: modelId, targetUrl: requestedTargetUrl }),
    });
    const data = await readApiJson<Record<string, unknown>>(response, '创建对话会话失败');
    const created = upsertSession(data.session as BrowserChatSession, { activate: true });
    activeSessionIdRef.current = created.id;
    mountedSessionActivationRef.current = created.id;
    if (!mountedIdentityRef.current) {
      window.history.replaceState(null, '', browserChatSessionNavigationHref(window.location.href, created.id));
    }
    return created;
  }

  async function ensureSession() {
    if (session && session.status !== 'closed') return session;
    return createSession();
  }

  async function postMessageToSession(sessionId: string, content: string, clientMessageId: string, nextAttachments: BrowserChatAttachment[], skillIds: string[]) {
    const response = await fetch(browserChatApiUrl(`/api/browser-chat/${sessionId}/message`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachments: nextAttachments, clientMessageId, content, safetyMode, modelProvider, model: modelId, skillIds }),
    });
    const data = await readApiJson<Record<string, unknown>>(response, '发送消息失败');
    return data.session as BrowserChatSession;
  }

  async function uploadChatFiles(files: FileList | File[]) {
    const selectedFiles = Array.from(files);
    const rejectedImages = selectedFiles.filter((file) => file.type.startsWith('image/'));
    const uploadableFiles = selectedModelSupportsImageInput
      ? selectedFiles
      : selectedFiles.filter((file) => !file.type.startsWith('image/'));
    if (rejectedImages.length && !selectedModelSupportsImageInput) {
      setError(t('当前模型不支持图片输入，请在模型配置中为该模型启用图片输入后再上传图片。'));
    }
    const remainingSlots = Math.max(0, BROWSER_CHAT_MAX_REFERENCES - attachmentsRef.current.length);
    if (!uploadableFiles.length || !remainingSlots || uploadingImage || currentBusy) return [];
    setUploadingImage(true);
    if (!rejectedImages.length) setError('');
    try {
      const uploaded: BrowserChatAttachment[] = [];
      for (const file of uploadableFiles.slice(0, remainingSlots)) {
        const response = await fetch(withWebPilotBasePath('/api/uploads'), {
          method: 'POST',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'x-webpilot-file-name': encodeURIComponent(file.name),
            'x-webpilot-upload': 'raw',
          },
          body: file,
        });
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
    if (
      !selectedModelSupportsImageInput
      && nextAttachments.some((attachment) => browserChatAttachmentKind(attachment) === 'image')
    ) {
      setError(t('当前模型不支持图片输入，请在模型配置中为该模型启用图片输入后再上传图片。'));
      return false;
    }
    if (
      (!trimmedContent && !nextAttachments.length && !skillIds.length)
      || loadingSessionId
      || sendingRef.current
      || interruptingRef.current
      || uploadingImage
    ) return false;
    sendingRef.current = true;
    const clientMessageId = temporaryId('client_msg');
    setError('');
    setBusy(true);
    try {
      let active = await ensureSession();
      setPendingMessageSessionId(active.id);
      const optimisticTimestamp = new Date().toISOString();
      const willQueue = isBrowserChatSessionRunning(active)
        || active.turnState === 'awaiting_human'
        || active.messages.some((message) => message.status === 'queued');
      const optimisticUserMessage: BrowserChatMessage = {
        id: `${clientMessageId}:user`,
        role: 'user',
        content: trimmedContent,
        createdAt: optimisticTimestamp,
        updatedAt: optimisticTimestamp,
        clientMessageId,
        attachments: nextAttachments,
        skillIds,
        status: willQueue ? 'queued' : undefined,
      };
      const optimisticAssistantMessage: BrowserChatMessage | undefined = willQueue ? undefined : {
        id: `${clientMessageId}:assistant`,
        role: 'assistant',
        content: '',
        createdAt: optimisticTimestamp,
        updatedAt: optimisticTimestamp,
        clientMessageId,
        status: 'running',
        stepIndexes: [],
      };
      active = upsertSession({
        ...active,
        busy: willQueue ? active.busy : true,
        status: willQueue ? active.status : 'running',
        turnState: willQueue ? active.turnState : 'running',
        updatedAt: optimisticTimestamp,
        messages: [
          ...active.messages,
          optimisticUserMessage,
          ...(optimisticAssistantMessage ? [optimisticAssistantMessage] : []),
        ],
      }, { activate: true });
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
    if (!targetId || interruptingRef.current) return;
    const targetSession = session?.id === targetId ? session : sessions.find((item) => item.id === targetId);
    const targetAssistantMessage = [...(targetSession?.messages || [])].reverse().find((message) => (
      message.role === 'assistant'
      && message.status === 'running'
      && Boolean(message.clientMessageId)
    ));
    const targetClientMessageId = targetAssistantMessage?.clientMessageId;
    if (!targetClientMessageId) {
      setError('无法确定要中止的对话回合，请刷新后重试');
      return;
    }
    interruptingRef.current = true;
    setInterrupting(true);
    setError('');
    const timestamp = new Date().toISOString();
    interruptGuardsRef.current.set(targetId, {
      assistantMessageIds: new Set((targetSession?.messages || [])
        .filter((message) => message.role === 'assistant' && message.status === 'running')
        .map((message) => message.id)),
      timestamp,
    });
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
      if (interruptRequestSequenceRef.current !== interruptRequestSequence) return;
      interruptingRef.current = false;
      setInterrupting(false);
    };
    const requestController = new AbortController();
    const requestTimeout = window.setTimeout(() => requestController.abort(), 30000);
    try {
      const response = await fetch(browserChatApiUrl(`/api/browser-chat/${targetId}/interrupt`), {
        keepalive: true,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientMessageId: targetClientMessageId }),
        signal: requestController.signal,
      });
      const data = await readApiJson<Record<string, unknown>>(response, '中断对话失败');
      upsertSession(data.session as BrowserChatSession, { activate: activeSessionIdRef.current === targetId });
      setBusy(false);
      setPendingMessageSessionId((current) => current === targetId ? null : current);
    } catch (interruptError) {
      interruptGuardsRef.current.delete(targetId);
      if (!requestController.signal.aborted) {
        setError(interruptError instanceof Error ? interruptError.message : '中断对话失败');
      }
      await refreshSession(targetId, { activate: activeSessionIdRef.current === targetId }).catch(() => undefined);
    } finally {
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
        body: JSON.stringify({ action, confirmationId }),
      });
      const data = await readApiJson<{ session: BrowserChatSession }>(response, '工具确认失败');
      if (data.session) upsertSession(data.session, { activate: activeSessionIdRef.current === sessionId });
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
      if (data.session) upsertSession(data.session, { activate: activeSessionIdRef.current === active.id });
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
      const response = await fetch(browserChatApiUrl(`/api/browser-chat/${session.id}/close`), { method: 'POST' });
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

  function clearDeletedActiveSession() {
    sessionSelectionIntentRef.current += 1;
    sessionActivationSequenceRef.current += 1;
    loadingSessionRef.current = null;
    mountedSessionActivationRef.current = '';
    activeSessionIdRef.current = null;
    setLoadingSessionId(null);
    setSessionMinimumLoadingElapsed(true);
    setMessageViewportReady(true);
    setSession(null);
    if (!mountedIdentityRef.current) {
      window.history.replaceState(null, '', browserChatSessionNavigationHref(window.location.href));
    }
  }

  async function deleteSessionHistory(sessionId: string) {
    if (deletingSessionIdsRef.current.has(sessionId) || deletingSelectedSessions) return;
    const deletingActiveSession = activeSessionIdRef.current === sessionId || session?.id === sessionId;
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
      if (deletingActiveSession) clearDeletedActiveSession();
      if (deletedSession) await discardEmbeddedBrowserDataForSessions([deletedSession]);
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
    const activeSessionId = activeSessionIdRef.current;
    const deletingActiveSession = Boolean(
      (activeSessionId && deletingIdSet.has(activeSessionId))
      || (session?.id && deletingIdSet.has(session.id)),
    );
    const deletedSessions = sessions.filter((item) => deletingIdSet.has(item.id));
    setDeletingSelectedSessions(true);
    setError('');
    try {
      const response = await fetch(browserChatApiUrl('/api/browser-chat/delete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: deletingIds }),
      });
      await readApiJson<Record<string, unknown>>(response, '批量删除历史对话失败');
      setSessions((current) => current.filter((item) => !deletingIdSet.has(item.id)));
      setSelectedSessionIds((current) => current.filter((id) => !deletingIdSet.has(id)));
      if (deletingActiveSession) clearDeletedActiveSession();
      await discardEmbeddedBrowserDataForSessions(deletedSessions);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '批量删除历史对话失败');
    } finally {
      setDeletingSelectedSessions(false);
      setRecentSelectionMode(false);
    }
  }

  const openMessageGenerationDialog = useCallback((kind: BrowserChatMessageGenerationKind, messageId: string) => {
    setMessageGenerationError('');
    setMessageGenerationDialog({ kind, selectedMessageIds: [messageId], summaryDirection: '' });
  }, []);

  const generateMessageSkill = useCallback((messageId: string) => {
    openMessageGenerationDialog('skill', messageId);
  }, [openMessageGenerationDialog]);

  const generateMessageAutomationCase = useCallback((messageId: string) => {
    openMessageGenerationDialog('case', messageId);
  }, [openMessageGenerationDialog]);

  function closeMessageGenerationDialog() {
    if (generatingSkillMessageId || generatingAutomationMessageId) return;
    setMessageGenerationDialog(null);
    setMessageGenerationError('');
  }

  function toggleGeneratedMessageSelection(messageId: string, selected: boolean) {
    setMessageGenerationDialog((current) => {
      if (!current) return current;
      const nextIds = new Set(current.selectedMessageIds);
      if (selected) nextIds.add(messageId);
      else nextIds.delete(messageId);
      return { ...current, selectedMessageIds: [...nextIds] };
    });
  }

  async function submitSelectedMessageGeneration() {
    const sessionId = session?.id;
    const dialog = messageGenerationDialog;
    if (!sessionId || !dialog || generatingSkillMessageId || generatingAutomationMessageId) return;
    const availableIds = new Set(generatableMessageOptions.map((item) => item.id));
    const messageIds = dialog.selectedMessageIds.filter((id) => availableIds.has(id));
    const isSkill = dialog.kind === 'skill';
    const summaryDirection = dialog.summaryDirection.trim();
    if (!messageIds.length) {
      setMessageGenerationError(t('请至少选择一条包含执行步骤的 AI 消息'));
      return;
    }
    if (isSkill && !summaryDirection) {
      setMessageGenerationError(t('请填写 Skill 总结方向'));
      return;
    }

    const firstMessageId = messageIds[0];
    if (isSkill) setGeneratingSkillMessageId(firstMessageId);
    else setGeneratingAutomationMessageId(firstMessageId);
    setMessageGenerationError('');
    setError('');
    startGlobalLoading(t(isSkill ? '正在生成 Skill' : '正在生成测试用例'));
    try {
      const endpoint = isSkill ? 'skills' : 'automation-cases';
      const response = await fetch(browserChatApiUrl(`/api/browser-chat/${sessionId}/${endpoint}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageIds, ...(isSkill ? { summaryDirection } : {}) }),
      });
      if (isSkill) {
        await readApiJson<Record<string, unknown>>(response, t('生成 Skill 失败'));
        await loadSkills();
        setMessageGenerationDialog(null);
      } else {
        const data = await readApiJson<{ automationCase?: { id?: string }; case?: { id?: string } }>(response, t('生成测试用例失败'));
        const caseId = data.automationCase?.id || data.case?.id || '';
        const search = new URLSearchParams();
        if (caseId) search.set('caseId', caseId);
        const query = search.toString();
        router.push(`/automation${query ? `?${query}` : ''}`);
      }
    } catch (generationError) {
      setMessageGenerationError(generationError instanceof Error
        ? generationError.message
        : t(isSkill ? '生成 Skill 失败' : '生成测试用例失败'));
    } finally {
      setGeneratingSkillMessageId(null);
      setGeneratingAutomationMessageId(null);
      stopGlobalLoading();
    }
  }

  const startNewConversation = useCallback(async (force = false) => {
    if (loadingSessionId && !force) return;
    sessionSelectionIntentRef.current += 1;
    sessionActivationSequenceRef.current += 1;
    if (force) {
      loadingSessionRef.current = null;
      mountedSessionActivationRef.current = '';
      setLoadingSessionId(null);
      setSessionMinimumLoadingElapsed(true);
    }
    mountedSessionActivationRef.current = '';
    setError('');
    setComposerResetToken((current) => current + 1);
    attachmentsRef.current = [];
    setAttachments([]);
    releaseSessionRuntime(activeSessionIdRef.current);
    activeSessionIdRef.current = null;
    setSession(null);
    setMessageViewportReady(true);
    if (!mountedIdentityRef.current) {
      window.history.replaceState(null, '', browserChatSessionNavigationHref(window.location.href));
    }
  }, [loadingSessionId, releaseSessionRuntime]);

  useEffect(() => {
    const handleTutorialRestart = () => {
      void startNewConversation(true);
    };
    window.addEventListener(WEBPILOT_ONBOARDING_RESTART_EVENT, handleTutorialRestart);
    return () => window.removeEventListener(WEBPILOT_ONBOARDING_RESTART_EVENT, handleTutorialRestart);
  }, [startNewConversation]);

  async function loadSession(sessionId: string) {
    if (loadingSessionRef.current === sessionId) return;
    sessionSelectionIntentRef.current += 1;
    mountedSessionActivationRef.current = sessionId;
    if (!mountedIdentityRef.current) {
      window.history.replaceState(null, '', browserChatSessionNavigationHref(window.location.href, sessionId));
    }
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

  const markMessageViewportReady = useCallback((positionedSessionId?: string) => {
    if (!shouldAcceptBrowserChatViewportPosition({
      activeSessionId: activeSessionIdRef.current,
      positionedSessionId,
    })) return;
    setMessageViewportReady(true);
  }, []);

  useEffect(() => {
    if (!shouldFinishBrowserChatSessionLoading({
      loadingSessionId,
      minimumLoadingElapsed: sessionMinimumLoadingElapsed,
      viewportReady: messageViewportReady,
    })) return;
    if (loadingSessionRef.current === loadingSessionId) loadingSessionRef.current = null;
    setLoadingSessionId((current) => current === loadingSessionId ? null : current);
  }, [loadingSessionId, messageViewportReady, sessionMinimumLoadingElapsed]);

  useEscapeDismiss(mobileHistoryOpen, () => setMobileHistoryOpen(false));

  useEffect(() => {
    const phoneLayout = window.matchMedia('(max-width: 680px)');
    const closeOutsidePhoneLayout = () => {
      if (!phoneLayout.matches) setMobileHistoryOpen(false);
    };
    phoneLayout.addEventListener('change', closeOutsidePhoneLayout);
    return () => phoneLayout.removeEventListener('change', closeOutsidePhoneLayout);
  }, []);

  function renderSidebarDetail() {
    return (
      <section className="browser-chat-sidebar-section browser-chat-recent-section workspace-sidebar-archive browser-chat-conversation-history">
        <div className="browser-chat-mobile-history-bar">
          <button
            aria-controls="browser-chat-mobile-history-panel"
            aria-expanded={mobileHistoryOpen}
            className="browser-chat-mobile-history-trigger"
            onClick={() => setMobileHistoryOpen((current) => !current)}
            title={session ? sessionDisplayTitle(session) : t('对话')}
            type="button"
          >
            <MessageSquare aria-hidden="true" size={16} />
            <span>{session ? sessionDisplayTitle(session) : t('对话')}</span>
            <ChevronDown aria-hidden="true" className={mobileHistoryOpen ? 'is-open' : undefined} size={15} />
          </button>
          <button
            aria-label={t('新建对话')}
            className="ui-icon-button browser-chat-mobile-new-chat"
            disabled={Boolean(loadingSessionHistory || loadingSessionId)}
            onClick={() => {
              setMobileHistoryOpen(false);
              void startNewConversation();
            }}
            title={t('新建对话')}
            type="button"
          >
            <Plus size={17} />
          </button>
        </div>
        {mobileHistoryOpen ? (
          <button
            aria-label={t('关闭对话历史')}
            className="browser-chat-mobile-history-backdrop"
            onClick={() => setMobileHistoryOpen(false)}
            type="button"
          />
        ) : null}
        <div
          aria-label={mobileHistoryOpen ? t('对话历史') : undefined}
          aria-modal={mobileHistoryOpen ? 'true' : undefined}
          className={`browser-chat-recent-panel${mobileHistoryOpen ? ' is-mobile-open' : ''}`}
          id="browser-chat-mobile-history-panel"
          role={mobileHistoryOpen ? 'dialog' : undefined}
        >
          <WorkspaceSidebarArchiveHeader
            actions={(
              <>
                <button
                  aria-label={t('关闭对话历史')}
                  className="ui-icon-button browser-chat-mobile-history-close"
                  onClick={() => setMobileHistoryOpen(false)}
                  title={t('关闭')}
                  type="button"
                >
                  <X size={17} />
                </button>
                <button
                  aria-label={t('新建对话')}
                  className="ui-icon-button browser-chat-section-create"
                  disabled={Boolean(loadingSessionHistory || loadingSessionId)}
                  onClick={() => void startNewConversation()}
                  title={t('新建对话')}
                  type="button"
                >
                  <Plus size={18} />
                </button>
                {recentSelectionMode ? (
                  <button
                    aria-label={t('删除已选对话（{count}）', { count: selectedDeletableSessionIds.length })}
                    className="ui-icon-button ui-icon-button--danger browser-chat-section-create"
                    disabled={!selectedDeletableSessionIds.length || deletingSelectedSessions}
                    onClick={() => void deleteSelectedSessionHistory()}
                    title={selectedDeletableSessionIds.length
                      ? t('删除已选对话（{count}）', { count: selectedDeletableSessionIds.length })
                      : t('请选择要删除的对话')}
                    type="button"
                  >
                    {deletingSelectedSessions ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
                  </button>
                ) : null}
                <WorkspaceOverflowMenu
                  className="browser-chat-recent-actions"
                  icon={<SlidersHorizontal size={16} />}
                  label={t('对话操作')}
                  title={t('对话操作')}
                >
                  <button onClick={toggleSidebarCollapsed} type="button">
                    <PanelLeftClose size={15} />
                    <span>{t('折叠侧边栏')}</span>
                  </button>
                  {recentSessions.length ? (
                    <button
                      onClick={() => {
                        setRecentSelectionMode((current) => !current);
                        if (recentSelectionMode) setSelectedSessionIds([]);
                      }}
                      type="button"
                    >
                      <Square size={14} />
                      <span>{recentSelectionMode ? t('退出选择') : t('选择对话')}</span>
                    </button>
                  ) : null}
                  {recentSelectionMode ? (
                    <button
                      onClick={() => {
                        toggleAllRecentSelections();
                      }}
                      type="button"
                    >
                      <CheckCircle2 size={15} />
                      <span>{allSelectableRecentSessionsSelected ? t('取消全选') : t('全选')}</span>
                    </button>
                  ) : null}
                </WorkspaceOverflowMenu>
              </>
            )}
          >
            <WorkspaceSidebarArchiveFilter
              ariaLabel={t('筛选对话历史')}
              clearLabel={t('清空对话筛选')}
              clearTitle={t('清空筛选')}
              disabled={loadingSessionHistory}
              onChange={setHistoryFilter}
              placeholder={t('搜索对话')}
              value={historyFilter}
            />
          </WorkspaceSidebarArchiveHeader>
          <div className={loadingSessionHistory ? 'browser-chat-history-stage is-loading' : 'browser-chat-history-stage'} aria-busy={loadingSessionHistory}>
            {loadingSessionHistory ? (
            <div className="browser-chat-history-loading" role="status" aria-live="polite" aria-label={t('正在加载对话')}>
              <Loader2 className="spin" size={16} />
              <span>{t('正在加载对话')}</span>
            </div>
          ) : filteredRecentSessions.length || (!historyFilter.trim() && sessionListPage.hasMore) ? (
            <WorkspaceHistoryList
              aria-busy={loadingMoreSessions}
              className="browser-chat-recent-list workspace-sidebar-archive-list"
              compactGroupHeaders
              footer={sessionListPage.hasMore && sessionListPage.next ? (
                <li
                  className={`browser-chat-history-scroll-sentinel${loadingMoreSessions ? ' is-loading' : ''}`}
                  ref={recentSessionListEndRef}
                >
                  {loadingMoreSessions ? (
                    <span aria-live="polite" role="status">
                      <Loader2 className="spin" size={13} />
                      {t('正在加载更多对话')}
                    </span>
                  ) : null}
                </li>
              ) : null}
              getKey={(item) => item.id}
              items={filteredRecentSessions}
              language={language}
              onScroll={(event) => {
                const list = event.currentTarget;
                const verticalRemaining = list.scrollHeight - list.scrollTop - list.clientHeight;
                const horizontalRemaining = list.scrollWidth - list.scrollLeft - list.clientWidth;
                if (verticalRemaining > 160 || horizontalRemaining > 160) {
                  recentSessionListFailedCursorRef.current = '';
                }
              }}
              listRef={recentSessionListRef}
              renderItem={(item) => {
                const displayTitle = sessionDisplayTitle(item);
                const titleParts = sessionTitleParts(item);
                const active = (loadingSessionId || session?.id || requestedSessionId) === item.id;
                  return (
                    <WorkspaceSidebarArchiveRow
                      active={active}
                      ariaLabel={displayTitle}
                      collapsed={sidebarCollapsed}
                      collapsedAction={(
                        <button
                          aria-label={t('删除对话“{name}”', { name: displayTitle })}
                          className="workspace-sidebar-archive-row-delete browser-chat-collapsed-delete"
                          disabled={item.busy || deletingSessionIds.has(item.id) || deletingSelectedSessions}
                          onClick={() => void deleteSessionHistory(item.id)}
                          title={item.busy ? t('执行中，无法删除') : t('删除对话')}
                          type="button"
                        >
                          {deletingSessionIds.has(item.id) ? <Loader2 className="spin" size={10} /> : <X size={11} />}
                        </button>
                      )}
                      collapsedIcon={<MessageSquare size={17} />}
                      disabled={Boolean(loadingSessionId && loadingSessionId !== item.id)}
                      expandedAction={(
                        <WorkspaceOverflowMenu
                          className="workspace-sidebar-archive-row-menu"
                          icon={deletingSessionIds.has(item.id) ? <Loader2 className="spin" size={13} /> : <MoreHorizontal size={16} />}
                          label={t('{name} 操作', { name: displayTitle })}
                          title={t('更多操作')}
                        >
                          <button
                            className="danger"
                            disabled={item.busy || deletingSessionIds.has(item.id) || deletingSelectedSessions}
                            onClick={() => {
                              void deleteSessionHistory(item.id);
                            }}
                            type="button"
                          >
                            <Trash2 size={15} />
                            <span>{item.busy ? t('执行中，无法删除') : t('删除对话')}</span>
                          </button>
                        </WorkspaceOverflowMenu>
                      )}
                      expandedIcon={titleParts.fileName
                        ? <FileText aria-hidden="true" size={16} />
                        : undefined}
                      iconTone={active ? 'accent' : 'muted'}
                      meta={sessionSidebarTime(item, language)}
                      onOpen={() => {
                        setMobileHistoryOpen(false);
                        void loadSession(item.id);
                      }}
                      selecting={recentSelectionMode}
                      selectionControl={recentSelectionMode ? (
                        <span className="browser-chat-recent-check">
                          <Checkbox
                            isDisabled={item.busy || deletingSelectedSessions}
                            isSelected={selectedSessionIdSet.has(item.id)}
                            onChange={(selected) => toggleSessionSelection(item.id, selected)}
                          >
                            <Checkbox.Content aria-label={t('选择 {name}', { name: displayTitle })}>
                              <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
                            </Checkbox.Content>
                          </Checkbox>
                        </span>
                      ) : undefined}
                      title={displayTitle}
                    />
                );
              }}
            />
          ) : recentSessions.length ? (
            <p className="browser-chat-history-filter-empty">{t('没有匹配的对话')}</p>
          ) : null}
        </div>
        </div>
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

  function startConversationTitleEdit() {
    if (!session) return;
    setConversationTitleDraft(sessionDisplayTitle(session));
    setEditingConversationTitle(true);
  }

  async function saveConversationTitle(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!session || savingConversationTitle) return;
    const title = conversationTitleDraft.trim();
    if (!title) return;
    if (title === sessionDisplayTitle(session)) {
      setEditingConversationTitle(false);
      return;
    }
    const previous = session;
    const sessionId = session.id;
    setSavingConversationTitle(true);
    setError('');
    upsertSession({
      ...session,
      title,
      titleFileName: undefined,
      updatedAt: new Date().toISOString(),
    }, { activate: true });
    try {
      const response = await fetch(browserChatApiUrl(`/api/browser-chat/${sessionId}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      const data = await readApiJson<Record<string, unknown>>(response, '修改对话标题失败');
      upsertSession(data.session as BrowserChatSession, { activate: activeSessionIdRef.current === sessionId });
      setConversationTitleDraft(title);
      setEditingConversationTitle(false);
    } catch (renameError) {
      upsertSession(previous, { activate: activeSessionIdRef.current === sessionId });
      setError(renameError instanceof Error ? renameError.message : '修改对话标题失败');
    } finally {
      setSavingConversationTitle(false);
    }
  }

  async function shareConversationLink() {
    if (!session) return;
    const href = new URL(
      browserChatSessionNavigationHref(window.location.href, session.id),
      window.location.origin,
    ).toString();
    try {
      try {
        await navigator.clipboard.writeText(href);
      } catch {
        const textarea = document.createElement('textarea');
        textarea.value = href;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        if (!copied) throw new Error('复制对话链接失败');
      }
    } catch (shareError) {
      setError(shareError instanceof Error ? shareError.message : '复制对话链接失败');
      return;
    }
    setShareLinkCopied(true);
    if (shareLinkFeedbackTimerRef.current) clearTimeout(shareLinkFeedbackTimerRef.current);
    shareLinkFeedbackTimerRef.current = setTimeout(() => setShareLinkCopied(false), 1800);
  }

  const renderChatPaneHeader = () => session && hasMessages ? (
    <header className="browser-chat-conversation-header">
      <div className="browser-chat-conversation-title-area">
        {editingConversationTitle ? (
          <form className="browser-chat-conversation-title-form" onSubmit={(event) => void saveConversationTitle(event)}>
            <AppInput
              aria-label={t('对话标题')}
              autoFocus
              disabled={savingConversationTitle}
              maxLength={240}
              onChange={(event) => setConversationTitleDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                setEditingConversationTitle(false);
              }}
              value={conversationTitleDraft}
            />
            <button aria-label={t('保存标题')} disabled={!conversationTitleDraft.trim() || savingConversationTitle} title={t('保存标题')} type="submit">
              {savingConversationTitle ? <Loader2 className="spin" size={15} /> : <Check size={15} />}
            </button>
            <button aria-label={t('取消修改')} disabled={savingConversationTitle} onClick={() => setEditingConversationTitle(false)} title={t('取消')} type="button">
              <X size={15} />
            </button>
          </form>
        ) : (
          <>
            <h1 title={sessionDisplayTitle(session)}>{sessionDisplayTitle(session)}</h1>
            <button
              aria-label={t('修改对话标题')}
              className="browser-chat-conversation-title-edit"
              onClick={startConversationTitleEdit}
              title={t('修改对话标题')}
              type="button"
            >
              <PencilLine aria-hidden="true" size={15} />
            </button>
          </>
        )}
      </div>
      <div className="browser-chat-conversation-header-actions">
        <button
          aria-label={shareLinkCopied ? t('对话链接已复制') : t('分享对话')}
          className={`browser-chat-conversation-share${shareLinkCopied ? ' is-copied' : ''}`}
          onClick={() => void shareConversationLink()}
          title={t('复制对话链接')}
          type="button"
        >
          {shareLinkCopied ? <Check aria-hidden="true" size={15} /> : <Share2 aria-hidden="true" size={15} />}
          <span>{shareLinkCopied ? t('已复制链接') : t('分享')}</span>
        </button>
        {webPreviewRuntime ? (
          <button
            aria-label={t('打开实时界面')}
            className="browser-chat-conversation-direct-action"
            disabled={session.status === 'closed'}
            onClick={() => setWebPreviewOpen(true)}
            title={session.status === 'closed' ? t('当前对话已结束') : t('打开实时界面')}
            type="button"
          >
            <AppWindow aria-hidden="true" size={17} />
            <span>{t('实时界面')}</span>
          </button>
        ) : null}
        <button
          aria-label={t('结束会话并关闭浏览器')}
          className="browser-chat-conversation-direct-action is-danger"
          disabled={session.status === 'closed' || currentBusy}
          onClick={closeSession}
          title={t('结束会话并关闭浏览器')}
          type="button"
        >
          <Power aria-hidden="true" size={17} />
          <span>{t('关闭浏览器')}</span>
        </button>
        {!webPreviewRuntime ? (
          <WorkspaceOverflowMenu
            className="browser-chat-conversation-more"
            icon={<MoreHorizontal size={17} />}
            label={t('更多对话操作')}
            title={t('更多对话操作')}
          >
              <button onClick={toggleBrowserGroupPicker} type="button">
                <Folder size={16} />
                <span>{t('浏览器标签组')}</span>
              </button>
              <button onClick={toggleDownloadCenter} type="button">
                <Download size={16} />
                <span>{t('下载管理')}</span>
              </button>
          </WorkspaceOverflowMenu>
        ) : null}
        {!webPreviewRuntime ? (
          <div aria-hidden="true" className="browser-chat-conversation-popover-anchors">
            <BrowserChatGroupBindingCenter
              anchorOnly
              disabled={!session.id}
              groupId={session.browserGroupId}
              onClose={() => setBrowserGroupPickerOpen(false)}
              onSelect={assignBrowserGroup}
              onToggle={toggleBrowserGroupPicker}
              open={browserGroupPickerOpen}
              panelWidth={downloadPanelWidth}
            />
            <BrowserChatDownloadCenter
              anchorOnly
              downloads={downloads}
              open={downloadCenterOpen}
              onClose={() => setDownloadCenterOpen(false)}
              onPreview={previewDownload}
              onRemove={(id) => {
                removedDownloadIdsRef.current.add(id);
                setDownloads((current) => current.filter((download) => download.id !== id));
              }}
              onToggle={toggleDownloadCenter}
              panelWidth={downloadPanelWidth}
            />
          </div>
        ) : null}
      </div>
    </header>
  ) : null;

  const renderChatPane = () => (
    <div className={`${hasChatContent ? 'browser-chat-chat-pane has-messages' : 'browser-chat-chat-pane'}${embeddedBrowserActive ? ' embedded-chat' : ''}`}>
      {renderChatPaneHeader()}

      {hasMessages ? (
        <BrowserChatMessageList
          key={`messages:${sessionUiKey}:${messageViewportGeneration}`}
          availableSkills={skills}
          generatingAutomationMessageId={generatingAutomationMessageId}
          generatingSkillMessageId={generatingSkillMessageId}
          historyHasMore={browserChatHasEarlierMessages(session?.history)}
          historyLoading={loadingEarlierHistory}
          lastAssistantMessageId={lastAssistantMessageId}
          logIndex={logIndex}
          messages={visibleMessages}
          outputCycles={session?.outputCycles || []}
          onGenerateAutomationCase={generateMessageAutomationCase}
          onGenerateSkill={generateMessageSkill}
          onLoadMessageRecords={loadMessageRecords}
          onLoadEarlier={loadEarlierHistory}
          onInitialPositioned={markMessageViewportReady}
          onPreviewImage={previewAttachment}
          onResolveToolConfirmation={resolveToolConfirmation}
          onResumeHumanVerification={resumeHumanVerification}
          onSelectTool={showToolDetails}
          onShowLogs={showMessageLogs}
          pendingToolConfirmation={session?.pendingToolConfirmation}
          resolvingConfirmationAction={resolvingConfirmationAction}
          resolvingConfirmationId={resolvingConfirmationId}
          resumingHumanVerification={resumingHumanVerification}
          revealImmediately={!loadingSessionHistory && !loadingSessionId && messageViewportReady}
          sessionAwaitingHuman={session?.turnState === 'awaiting_human'}
          sessionId={session?.id}
          sessionBusy={selectedSessionRunning}
          subagents={session?.subagents || []}
          stepsByIndex={stepsByIndex}
        />
      ) : (
        <BrowserChatOnboarding
          busy={currentBusy || Boolean(loadingSessionId)}
          modelLabel={selectedModelLabel}
          onOpenManagement={(tab) => setManagementTab(tab)}
          onOpenModelSelector={() => {
            const trigger = document.querySelector<HTMLButtonElement>('.browser-chat-provider-select .custom-select-button');
            trigger?.focus();
            trigger?.click();
          }}
          onSafetyModeChange={setSafetyMode}
          onSubmit={(content) => sendMessage(content)}
          safetyMode={safetyMode}
        />
      )}
      {messageViewportPositioning ? (
        <div className="browser-chat-session-loading-overlay">
          <BrowserChatSessionLoading label={t(loadingSessionHistory || loadingSessionId ? '正在加载对话' : '正在定位对话')} />
        </div>
      ) : null}

      <div className="browser-chat-composer-shell">
        {error || session?.error ? <div className="error">{t(stripAnsiControlCodes(error || session?.error || ''))}</div> : null}
        <BrowserChatComposer
          key={`composer:${sessionUiKey}`}
          attachments={attachments}
          availableSkills={skills}
          busy={busy}
          contextUsage={session?.contextUsage}
          currentBusy={currentBusy}
          imageInputRef={imageInputRef}
          interrupting={interrupting}
          loading={Boolean(loadingSessionId)}
          loadingMoreSkills={loadingMoreSkills}
          managementActions={(
            <div aria-label={t('快捷管理')} className="browser-chat-management-shortcuts" role="group">
              <button aria-label={t('Skills 管理')} onClick={() => setManagementTab('skills')} title={t('Skills 管理')} type="button">
                <Braces aria-hidden="true" size={14} />
                <span>{t('技能')}</span>
              </button>
              <button aria-label={t('个性化记忆')} onClick={() => setManagementTab('memory')} title={t('个性化记忆')} type="button">
                <Brain aria-hidden="true" size={14} />
                <span>{t('记忆')}</span>
              </button>
              <button aria-label={t('登录账号')} onClick={() => setManagementTab('accounts')} title={t('登录账号')} type="button">
                <KeyRound aria-hidden="true" size={14} />
                <span>{t('账号')}</span>
              </button>
            </div>
          )}
          modelSelection={modelSelection}
          modelSelectionTitle={modelSelectionDiagnostic}
          modelSelectionOptions={modelSelectionOptions}
          safetyMode={safetyMode}
          onInterrupt={interruptConversation}
          onModelSelectionChange={changeModelSelection}
          onLoadMoreSkills={loadMoreSkills}
          onPreviewAttachment={previewAttachment}
          onRemoveAttachment={removeAttachment}
          onSearchSkills={searchSkills}
          onSubmitMessage={sendMessage}
          onSafetyModeChange={setSafetyMode}
          onAddReferences={addReferenceAttachments}
          onUploadFiles={uploadChatFiles}
          resetToken={composerResetToken}
          showStop={canInterruptConversation}
          skillsHasMore={Boolean(skillListPage.hasMore)}
          uploadingImage={uploadingImage}
        />
      </div>
    </div>
  );

  return (
    <BrowserChatReasoningVisibilityContext.Provider value={showReasoning}>
    <section className={sidebarCollapsed ? 'browser-chat-layout sidebar-collapsed' : 'browser-chat-layout'}>
      <WorkspaceSidebar
        collapsed={sidebarCollapsed}
        collapseLabel={sidebarCollapsed ? t('展开侧边栏') : t('折叠侧边栏')}
        onToggleCollapse={toggleSidebarCollapsed}
        onThemeChange={setMode}
        themeMode={themeMode}
        themeToggleLabel={themeMode === 'dark' ? t('切换到浅色模式') : t('切换到深色模式')}
        themeToggleTitle={themeMode === 'dark' ? t('浅色模式') : t('深色模式')}
      >

        <WorkspaceModeTabs
          activeKey="/browser-chat"
          aiOperationsLabel={t('AI 运营')}
          ariaLabel={t('工作模式')}
          automationLabel={t('自动化')}
          collapsed={sidebarCollapsed}
          conversationLabel={t('对话模式')}
          settingsLabel={t('设置')}
          showAiOperations={requestUserId === '1'}
        />

        {renderSidebarDetail()}

      </WorkspaceSidebar>

      <main
        aria-busy={messageViewportPositioning}
        className={[
          'browser-chat-main',
          messageViewportPositioning ? 'is-positioning-chat' : '',
          embeddedBrowserActive && embeddedChatCollapsed ? 'embedded-chat-collapsed' : '',
        ].filter(Boolean).join(' ')}
      >
        {embeddedBrowserActive ? (
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
              key={`${session?.userId || requestUserId}:${session?.id || 'new'}`}
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
              userId={session?.userId || requestUserId}
            />
            {embeddedChatCollapsed ? null : (
              <div
                aria-label={t('调整对话栏宽度')}
                aria-orientation="vertical"
                aria-valuemax={760}
                aria-valuemin={320}
                aria-valuenow={embeddedChatWidth}
                className="browser-chat-embedded-resizer"
                onKeyDown={resizeEmbeddedChatWithKeyboard}
                onPointerDown={beginEmbeddedChatResize}
                role="separator"
                tabIndex={0}
                title={t('拖拽调整对话栏宽度')}
              >
                <span />
              </div>
            )}
            <aside aria-label={t('对话')} className="browser-chat-embedded-chat-column">
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
        ) : renderChatPane()}
      </main>

      {webPreviewRuntime && webPreviewOpen && session ? (
        <BrowserChatWebPreviewModal
          key={`${session.userId || requestUserId}:${session.id}`}
          onClose={() => setWebPreviewOpen(false)}
          sessionId={session.id}
          userId={session.userId || requestUserId}
        />
      ) : null}

      {liveToolDialog ? (
        <BrowserChatToolDialog
          detail={liveToolDialog}
          onClose={closeToolDetails}
          toolLabel={(name, input) => browserChatToolLabel(name, input, t)}
        />
      ) : null}

      {logDialogMessageId ? (
        <BrowserChatTransientLogDialog
          key={`${session?.id || 'session'}:${logDialogMessageId}`}
          liveEntries={logDialogLiveEntries}
          loadRecords={loadMessageRecords}
          messageContent={logDialogMessage ? compactText(logDialogMessage.content, 80) : undefined}
          messageId={logDialogMessageId}
          onClose={() => setLogDialogMessageId(null)}
        />
      ) : null}

      {managementTab ? (
        <BrowserChatManagementDialog
          defaultUserId={requestUserId}
          key={managementTab}
          onClose={() => setManagementTab(null)}
          onSkillsChanged={loadSkills}
          personalMemoryRefreshToken={personalMemoryRefreshToken}
          tab={managementTab}
        />
      ) : null}

      {messageGenerationDialog ? (
        <AppModal
          ariaLabelledBy="browser-chat-message-generation-title"
          dismissable={!messageGenerationSubmitting}
          keyboardDismissable={!messageGenerationSubmitting}
          onClose={closeMessageGenerationDialog}
          size="lg"
        >
            <header className="ui-modal-header browser-chat-message-generation-header">
              <div className="ui-modal-heading ui-modal-heading--with-icon browser-chat-message-generation-heading">
                <span className="ui-modal-heading-icon browser-chat-message-generation-icon" aria-hidden="true">
                  {messageGenerationDialog.kind === 'skill' ? <Sparkles size={18} /> : <Workflow size={18} />}
                </span>
                <div className="ui-modal-heading-copy">
                  <h2 className="ui-modal-title" id="browser-chat-message-generation-title">
                    {messageGenerationDialog.kind === 'skill' ? t('生成 Skill') : t('生成用例')}
                  </h2>
                  <p className="ui-modal-subtitle">{t('从当前对话中选择要提炼的消息')}</p>
                </div>
              </div>
              <button
                aria-label={t('关闭')}
                className="ui-icon-button ui-modal-close"
                disabled={messageGenerationSubmitting}
                onClick={closeMessageGenerationDialog}
                type="button"
              >
                <X size={16} />
              </button>
            </header>
            <div className="ui-modal-body browser-chat-message-generation-body">
              {messageGenerationDialog.kind === 'skill' ? (
                <label className="modal-field browser-chat-message-generation-direction">
                  <span className="browser-chat-message-generation-field-label">
                    <strong>{t('总结方向')}</strong>
                    <small>{messageGenerationDialog.summaryDirection.length}/2000</small>
                  </span>
                  <TextArea
                    autoFocus
                    disabled={messageGenerationSubmitting}
                    fullWidth
                    maxLength={2_000}
                    onChange={(event) => {
                      const summaryDirection = event.currentTarget.value;
                      setMessageGenerationDialog((current) => current
                        ? { ...current, summaryDirection }
                        : current);
                    }}
                    placeholder={t('例如：总结为需求提交流程，重点保留版本选择、必填字段和异常处理。')}
                    rows={3}
                    value={messageGenerationDialog.summaryDirection}
                  />
                  <small className="browser-chat-message-generation-hint">{t('说明希望 Skill 聚焦的任务、关键步骤或判断逻辑')}</small>
                </label>
              ) : null}
              <div className="browser-chat-message-generation-toolbar">
                <div>
                  <strong>{t('对话消息')}</strong>
                  <span>{t('已选 {selected}/{total}', {
                    selected: selectedGenerationMessageIdSet.size,
                    total: generatableMessageOptions.length,
                  })}</span>
                </div>
                <button
                  className="link-button"
                  disabled={messageGenerationSubmitting || !generatableMessageOptions.length}
                  onClick={() => setMessageGenerationDialog((current) => current ? {
                    ...current,
                    selectedMessageIds: allGeneratableMessagesSelected
                      ? []
                      : generatableMessageOptions.map((item) => item.id),
                  } : current)}
                  type="button"
                >
                  {allGeneratableMessagesSelected ? t('取消全选') : t('全选')}
                </button>
              </div>
              <div className="browser-chat-message-generation-list">
                {generatableMessageOptions.map((item) => (
                  <div className="browser-chat-message-generation-item" key={item.id}>
                    <Checkbox
                      isDisabled={messageGenerationSubmitting}
                      isSelected={selectedGenerationMessageIdSet.has(item.id)}
                      onChange={(selected) => toggleGeneratedMessageSelection(item.id, selected)}
                    >
                      <Checkbox.Content>
                        <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
                        <div className="browser-chat-message-generation-content">
                          <div className="browser-chat-message-generation-title" title={item.title}>{item.title}</div>
                          {item.summary && item.summary !== item.title ? (
                            <div className="browser-chat-message-generation-summary" title={item.summary}>{item.summary}</div>
                          ) : null}
                        </div>
                        <em>{t('{count} 个步骤', { count: item.stepCount })}</em>
                      </Checkbox.Content>
                    </Checkbox>
                  </div>
                ))}
              </div>
              {messageGenerationError ? <div className="error" role="alert">{messageGenerationError}</div> : null}
            </div>
            <footer className="ui-modal-footer browser-chat-message-generation-footer">
              <span>{t('将按消息顺序合并 {count} 条记录', { count: selectedGenerationMessageIdSet.size })}</span>
              <div>
                <button className="ui-button ui-button--neutral" disabled={messageGenerationSubmitting} onClick={closeMessageGenerationDialog} type="button">
                  {t('取消')}
                </button>
                <button
                  className="ui-button ui-button--primary"
                  disabled={messageGenerationSubmitting
                    || !selectedGenerationMessageIdSet.size
                    || (messageGenerationDialog.kind === 'skill' && !messageGenerationDialog.summaryDirection.trim())}
                  onClick={() => void submitSelectedMessageGeneration()}
                  type="button"
                >
                  {messageGenerationSubmitting
                    ? <Loader2 className="spin" size={15} />
                    : messageGenerationDialog.kind === 'skill' ? <Sparkles size={15} /> : <Workflow size={15} />}
                  {messageGenerationSubmitting
                    ? t('正在生成')
                    : messageGenerationDialog.kind === 'skill' ? t('生成 Skill') : t('生成用例')}
                </button>
              </div>
            </footer>
        </AppModal>
      ) : null}

    </section>
    </BrowserChatReasoningVisibilityContext.Provider>
  );
}
