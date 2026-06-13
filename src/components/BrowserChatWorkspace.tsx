'use client';

import { memo, type RefObject, useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
  Bot,
  Folder,
  ImageUp,
  Loader2,
  Maximize2,
  MessageSquare,
  PanelLeft,
  Power,
  ScrollText,
  Send,
  Settings,
  FilePlus2,
  Square,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DashboardGroupSidebar, DashboardWorkspace, groupPath } from '@/components/DashboardWorkspace';
import { EnvironmentSettings, environmentSettingsTabs } from '@/components/EnvironmentSettings';
import type { SettingsTab } from '@/config/settings';
import { domTreeFromToolCall } from '@/lib/ai-request-inspection';
import { artifactApiUrl as artifactUrl } from '@/lib/artifacts';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';
import { subscribeRealtimeRefresh } from '@/lib/realtime-refresh';
import type {
  RunScheduleRecord,
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

type BrowserChatSession = {
  id: string;
  title: string;
  targetUrl: string;
  mode: BrowserChatMode;
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
  error?: string;
};

type BrowserChatView = 'chat' | 'target' | 'settings';
type BrowserChatMode = 'dom' | 'visual-markers';
type BrowserChatToolCall = NonNullable<StepExecutionResult['tools']>[number];
type BrowserChatToolDetail = {
  stepIndex: number;
  step: StepExecutionResult;
  toolIndex: number;
  tool: BrowserChatToolCall;
};

type BrowserChatLogIndex = {
  byMessageId: Map<string, BrowserChatLogRecord[]>;
  byStepIndex: Map<number, BrowserChatLogRecord[]>;
};

function statusLabel(status: string) {
  return ({
    blocked: '阻塞',
    closed: '已结束',
    error: '异常',
    failed: '失败',
    idle: '空闲',
    interrupted: '已中断',
    passed: '完成',
    running: '执行中',
  } as Record<string, string>)[status] || status;
}

function compactText(value?: string, max = 160) {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
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

function readableAgentText(value?: string) {
  const text = (value || '').trim();
  const parsed = parseJsonObjectText(text);
  if (!parsed) return text;
  for (const key of ['actual', 'reason', 'observation', 'currentState', 'nextGoal', 'action']) {
    const item = typeof parsed[key] === 'string' ? (parsed[key] as string).trim() : '';
    if (item && !parseJsonObjectText(item)) return item;
  }
  return '';
}

function formatToolPayload(value: unknown) {
  if (value === undefined || value === null || value === '') return '无';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toolStatusLabel(tool: BrowserChatToolCall) {
  if (tool.ok === false) return '失败';
  if (tool.ok === true) return '完成';
  return '运行中';
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

function normalizeSession(session: BrowserChatSession): BrowserChatSession {
  return {
    ...session,
    consoleErrors: session.consoleErrors || [],
    logs: session.logs || [],
    messages: (session.messages || []).map((message) => ({ ...message, attachments: message.attachments || [] })),
    mode: normalizeMode(session.mode),
    networkErrors: session.networkErrors || [],
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

function normalizedAgentText(value?: string) {
  const text = readableAgentText(value);
  if (isRawInfrastructureErrorText(text)) {
    return 'AI 模型请求失败：当前模型网关不兼容本轮工具调用格式，完整错误已记录在日志中。';
  }
  return isRawDomSnapshotText(text) ? '' : text;
}

function isRawDomSnapshotText(value?: string) {
  const text = (value || '').trim();
  if (!text || !/\bnode_id=\d+\b/.test(text)) return false;
  return /<\s*(?:a|button|input|select|textarea|option|summary|details|label|form|iframe)\b/i.test(text);
}

function isRawInfrastructureErrorText(value?: string) {
  return /litellm\.BadRequestError|AnthropicException|Failed to deserialize the JSON body|unknown variant `?custom`?|invalid_request_error|Recorded as recoverable/i.test(value || '');
}

function toolTimelineSummary(tool?: BrowserChatToolCall) {
  if (!tool || tool.ok === false) return '';
  if (tool.name === 'getDomTree') return '已读取当前可见 DOM 快照。';
  if (tool.name === 'getInteractiveCandidates') return '已读取当前可见可交互元素。';
  if (tool.name === 'getDomNodeText') return '已读取目标 DOM 节点文本。';
  if (tool.name === 'findByText') return '已查询页面文本匹配结果。';
  if (tool.name === 'getHttpRequests') return '已读取当前标签页的网络请求记录。';
  if (tool.name === 'listTabs') return '已读取浏览器标签页列表。';
  return '';
}

function stepNarrative(step: StepExecutionResult) {
  const text = normalizedAgentText(step.note)
    || toolTimelineSummary(step.tools?.at(-1))
    || normalizedAgentText(step.actual);
  if (!text) return '';
  if (isRawDomSnapshotText(text)) return toolTimelineSummary(step.tools?.at(-1));
  if (/^AI (is choosing|called a browser tool)/i.test(text)) return '';
  return text.replace(/^Reported state without browser action:\s*/i, '').trim();
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

const BrowserChatStepToolCards = memo(function BrowserChatStepToolCards({
  onSelectTool,
  running,
  step,
}: {
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  running: boolean;
  step: StepExecutionResult;
}) {
  const toolCalls = step.tools || [];
  if (!running && !toolCalls.length) return null;
  if (running && !toolCalls.length) {
    return (
      <div className="browser-chat-tool-card is-waiting">
        <div>
          <strong>等待工具调用</strong>
          <p>AI 正在基于当前页面选择下一步操作。</p>
        </div>
        <span className="badge neutral">运行中</span>
      </div>
    );
  }

  return (
    <>
      {toolCalls.map((tool, toolIndex) => (
        <div className="browser-chat-tool-call" key={`${step.index}-${toolIndex}-${tool.name}`}>
          {tool.reason ? (
            <div className="browser-chat-tool-reason">
              {compactText(tool.reason, 140)}
            </div>
          ) : null}
          <button
            className="browser-chat-tool-card"
            onClick={() => onSelectTool({ stepIndex: step.index, step, toolIndex, tool })}
            type="button"
          >
            <div>
              <strong>{compactText(tool.name, 72)}</strong>
            </div>
            <span className={tool.ok === false ? 'badge status-failed' : 'badge neutral'}>{toolStatusLabel(tool)}</span>
          </button>
        </div>
      ))}
    </>
  );
});

const BrowserChatAssistantTimeline = memo(function BrowserChatAssistantTimeline({
  message,
  onSelectTool,
  running,
  steps,
}: {
  message: BrowserChatMessage;
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  running: boolean;
  steps: StepExecutionResult[];
}) {
  const finalText = normalizedAgentText(message.content);
  const seenTexts = new Set<string>();
  const shouldShowStepTimeline = running || steps.some((step) => (step.tools || []).length);
  const renderText = (text: string, key: string) => {
    const normalized = normalizedAgentText(text);
    if (!normalized || seenTexts.has(normalized)) return null;
    seenTexts.add(normalized);
    return (
      <BrowserChatMarkdown key={key} markdown={normalized} />
    );
  };

  return (
    <div className="browser-chat-agent-timeline">
      {running ? renderText(finalText || '正在处理...', 'running-text') : null}
      {shouldShowStepTimeline ? steps.map((step) => (
        <div className="browser-chat-agent-step" key={step.index}>
          <BrowserChatStepToolCards onSelectTool={onSelectTool} running={running && step.status === 'running'} step={step} />
          {running ? renderText(stepNarrative(step), `step-${step.index}-text`) : null}
        </div>
      )) : null}
      {!running || !steps.length ? renderText(finalText, 'final-text') : null}
    </div>
  );
});

const BrowserChatMessageItem = memo(function BrowserChatMessageItem({
  exportingMessageId,
  item,
  itemLogs,
  itemSteps,
  lastAssistantMessageId,
  onExportMessage,
  onPreviewImage,
  onSelectTool,
  onShowLogs,
  sessionBusy,
  totalStepCount,
}: {
  exportingMessageId: string | null;
  item: BrowserChatMessage;
  itemLogs: BrowserChatLogRecord[];
  itemSteps: StepExecutionResult[];
  lastAssistantMessageId?: string;
  onExportMessage: (messageId: string) => void | Promise<void>;
  onPreviewImage: (attachment: BrowserChatAttachment) => void;
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  onShowLogs: (messageId: string) => void;
  sessionBusy: boolean;
  totalStepCount: number;
}) {
  const operationRunning = item.role === 'assistant' && (item.status === 'running' || Boolean(sessionBusy && item.id === lastAssistantMessageId));
  const operationLabel = operationRunning ? (item.activity?.label || '处理中') : statusLabel(item.status || 'passed');
  const canExportMessage = item.role === 'assistant' && item.status !== 'running' && (itemSteps.length > 0 || totalStepCount > 0);

  return (
    <article className={`browser-chat-message ${item.role}`}>
      <div className="browser-chat-avatar">
        {item.role === 'user' ? <User size={15} /> : <Bot size={15} />}
      </div>
      <div>
        {item.role === 'assistant' ? (
          <>
            <div className="browser-chat-agent-meta">
              <span>{operationLabel}</span>
              <time dateTime={messageUpdateTime(item)}>最后更新 {formatLogTime(messageUpdateTime(item))}</time>
            </div>
            <BrowserChatAssistantTimeline message={item} onSelectTool={onSelectTool} running={operationRunning} steps={itemSteps} />
          </>
        ) : (
          <>
            {item.content ? <p>{item.content}</p> : null}
            <BrowserChatImageGrid attachments={item.attachments} onPreview={onPreviewImage} />
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
                disabled={Boolean(exportingMessageId)}
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
  exportingMessageId,
  lastAssistantMessageId,
  logIndex,
  messages,
  onExportMessage,
  onPreviewImage,
  onSelectTool,
  onShowLogs,
  sessionBusy,
  stepsByIndex,
  totalStepCount,
}: {
  exportingMessageId: string | null;
  lastAssistantMessageId?: string;
  logIndex: BrowserChatLogIndex;
  messages: BrowserChatMessage[];
  onExportMessage: (messageId: string) => void | Promise<void>;
  onPreviewImage: (attachment: BrowserChatAttachment) => void;
  onSelectTool: (detail: BrowserChatToolDetail) => void;
  onShowLogs: (messageId: string) => void;
  sessionBusy: boolean;
  stepsByIndex: Map<number, StepExecutionResult>;
  totalStepCount: number;
}) {
  return (
    <div className="browser-chat-message-list">
      {messages.map((item) => {
        const itemSteps = (item.stepIndexes || [])
          .map((stepIndex) => stepsByIndex.get(stepIndex))
          .filter((step): step is StepExecutionResult => Boolean(step));
        const itemLogs = item.role === 'assistant' ? browserChatLogsForMessage(item, logIndex) : [];
        return (
          <BrowserChatMessageItem
            exportingMessageId={exportingMessageId}
            item={item}
            itemLogs={itemLogs}
            itemSteps={itemSteps}
            key={item.id}
            lastAssistantMessageId={lastAssistantMessageId}
            onExportMessage={onExportMessage}
            onPreviewImage={onPreviewImage}
            onSelectTool={onSelectTool}
            onShowLogs={onShowLogs}
            sessionBusy={sessionBusy}
            totalStepCount={totalStepCount}
          />
        );
      })}
    </div>
  );
});

const BrowserChatComposer = memo(function BrowserChatComposer({
  attachments,
  busy,
  currentBusy,
  imageInputRef,
  interrupting,
  loading,
  mode,
  modeLocked,
  onInterrupt,
  onModeChange,
  onPreviewAttachment,
  onRemoveAttachment,
  onSubmitMessage,
  onUploadImages,
  resetToken,
  showStop,
  uploadingImage,
}: {
  attachments: BrowserChatAttachment[];
  busy: boolean;
  currentBusy: boolean;
  imageInputRef: RefObject<HTMLInputElement | null>;
  interrupting: boolean;
  loading: boolean;
  mode: BrowserChatMode;
  modeLocked: boolean;
  onInterrupt: () => void | Promise<void>;
  onModeChange: (mode: BrowserChatMode) => void;
  onPreviewAttachment: (attachment: BrowserChatAttachment) => void;
  onRemoveAttachment: (id: string) => void;
  onSubmitMessage: (content: string) => Promise<boolean>;
  onUploadImages: (files: File[]) => void | Promise<void>;
  resetToken: number;
  showStop: boolean;
  uploadingImage: boolean;
}) {
  const [draft, setDraft] = useState('');

  useEffect(() => {
    setDraft('');
  }, [resetToken]);

  const submitDraft = useCallback(async () => {
    const content = draft.trim();
    if ((!content && !attachments.length) || currentBusy || loading || uploadingImage) return;
    const sent = await onSubmitMessage(content);
    if (sent) setDraft('');
  }, [attachments.length, currentBusy, draft, loading, onSubmitMessage, uploadingImage]);

  return (
    <>
      <BrowserChatImageGrid
        attachments={attachments}
        editable
        onPreview={onPreviewAttachment}
        onRemove={onRemoveAttachment}
      />
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
        <textarea
          disabled={currentBusy || loading}
          placeholder="有问题，尽管问"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submitDraft();
            }
          }}
        />
        <button
          aria-label="上传图片"
          className="browser-chat-attach"
          disabled={currentBusy || uploadingImage || attachments.length >= 8}
          onClick={() => imageInputRef.current?.click()}
          title="上传图片"
          type="button"
        >
          {uploadingImage ? <Loader2 className="spin" size={17} /> : <ImageUp size={17} />}
        </button>
        <div className="browser-chat-mode-toggle" role="radiogroup" aria-label="操作模式">
          <button
            aria-pressed={mode === 'visual-markers'}
            className={mode === 'visual-markers' ? 'active' : undefined}
            disabled={currentBusy || loading || modeLocked}
            onClick={() => onModeChange('visual-markers')}
            type="button"
          >
            视觉
          </button>
          <button
            aria-pressed={mode === 'dom'}
            className={mode === 'dom' ? 'active' : undefined}
            disabled={currentBusy || loading || modeLocked}
            onClick={() => onModeChange('dom')}
            type="button"
          >
            DOM
          </button>
        </div>
        {showStop ? (
          <button
            className="browser-chat-stop"
            disabled={interrupting}
            onClick={() => void onInterrupt()}
            type="button"
            aria-label="中断本轮对话"
            title="中断本轮对话"
          >
            {interrupting ? <Loader2 className="spin" size={18} /> : <Square size={16} />}
          </button>
        ) : (
          <button
            className="browser-chat-send"
            disabled={(!draft.trim() && !attachments.length) || currentBusy || loading || uploadingImage}
            type="submit"
            aria-label="发送"
          >
            {busy ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
          </button>
        )}
      </form>
    </>
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
  const [, startTransition] = useTransition();
  const sendingRef = useRef(false);
  const loadingSessionRef = useRef<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const sessionVersionsRef = useRef(new Map<string, number>());
  const sessionRefreshTimersRef = useRef(new Map<string, number>());
  const sessionListRefreshTimerRef = useRef<number | undefined>(undefined);
  const [activeView, setActiveView] = useState<BrowserChatView>(initialView);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [session, setSession] = useState<BrowserChatSession | null>(null);
  const [sessions, setSessions] = useState<BrowserChatSession[]>([]);
  const [mode, setMode] = useState<BrowserChatMode>('visual-markers');
  const [targetGroupId, setTargetGroupId] = useState<string | undefined>();
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('model');
  const [groupName, setGroupName] = useState('');
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [attachments, setAttachments] = useState<BrowserChatAttachment[]>([]);
  const [composerResetToken, setComposerResetToken] = useState(0);
  const [busy, setBusy] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [deletingSelectedSessions, setDeletingSelectedSessions] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [exportingMessageId, setExportingMessageId] = useState<string | null>(null);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [logDialogMessageId, setLogDialogMessageId] = useState<string | null>(null);
  const [toolDialog, setToolDialog] = useState<BrowserChatToolDetail | null>(null);
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
  const logIndex = useMemo(() => buildBrowserChatLogIndex(logs), [logs]);
  const logDialogMessage = useMemo(
    () => messages.find((item) => item.id === logDialogMessageId),
    [logDialogMessageId, messages],
  );
  const logDialogEntries = useMemo(() => {
    if (!logDialogMessage) return [];
    return browserChatLogsForMessage(logDialogMessage, logIndex);
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

  useEffect(() => {
    activeSessionIdRef.current = session?.id || null;
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
    if (shouldActivate) setMode(normalizeMode(loadedSession.mode));
    return loadedSession;
  }, [upsertSession]);

  const scheduleLoadSessions = useCallback((delay = 80) => {
    if (sessionListRefreshTimerRef.current) window.clearTimeout(sessionListRefreshTimerRef.current);
    sessionListRefreshTimerRef.current = window.setTimeout(() => {
      sessionListRefreshTimerRef.current = undefined;
      void loadSessions().catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : '鍔犺浇瀵硅瘽鍘嗗彶澶辫触');
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
          setError(refreshError instanceof Error ? refreshError.message : '鍔犺浇瀵硅瘽澶辫触');
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
      body: JSON.stringify({ mode }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '创建对话会话失败');
    return upsertSession(data.session as BrowserChatSession, { activate: true });
  }

  async function ensureSession() {
    if (session && session.status !== 'closed') return session;
    return createSession();
  }

  async function postMessageToSession(sessionId: string, content: string, clientMessageId: string, nextAttachments: BrowserChatAttachment[]) {
    const response = await fetch(`/api/browser-chat/${sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachments: nextAttachments, clientMessageId, content, mode }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '发送消息失败');
    return data.session as BrowserChatSession;
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

  async function sendMessage(content: string) {
    const trimmedContent = content.trim();
    const nextAttachments = attachments;
    if ((!trimmedContent && !nextAttachments.length) || currentBusy || loadingSessionId || sendingRef.current || uploadingImage) return false;
    sendingRef.current = true;
    const clientMessageId = temporaryId('client_msg');
    setError('');
    setBusy(true);
    setActiveView('chat');
    try {
      let active = await ensureSession();
      let posted: BrowserChatSession;
      try {
        posted = await postMessageToSession(active.id, trimmedContent, clientMessageId, nextAttachments);
      } catch (firstError) {
        const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
        if (!/Browser chat session not found/i.test(firstMessage)) throw firstError;
        active = await createSession();
        posted = await postMessageToSession(active.id, trimmedContent, clientMessageId, nextAttachments);
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

  const exportMessageToTestCase = useCallback(async (messageId: string) => {
    const sessionId = session?.id;
    if (!sessionId || exportingMessageId) return;
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
  }, [exportingMessageId, router, session?.id, startTransition]);

  async function startNewConversation() {
    setActiveView('chat');
    if (busy) return;
    setError('');
    setComposerResetToken((current) => current + 1);
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
    setAttachments([]);
    try {
      const loadedSession = await refreshSession(sessionId, { activate: true });
      setMode(normalizeMode(loadedSession.mode));
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
        <section className="browser-chat-sidebar-section">
          <h2>设置</h2>
          <nav className="browser-chat-subnav" aria-label="环境配置分类">
            {environmentSettingsTabs.map((tab) => (
              <button className={settingsTab === tab.id ? 'active' : undefined} key={tab.id} onClick={() => setSettingsTab(tab.id)} type="button">
                {tab.label}
              </button>
            ))}
          </nav>
        </section>
      );
    }

    return (
      <section className="browser-chat-sidebar-section">
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
                <div className={session?.id === item.id ? 'browser-chat-recent-item active' : 'browser-chat-recent-item'}>
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
                    disabled={Boolean(loadingSessionId && loadingSessionId !== item.id)}
                    onClick={() => void loadSession(item.id)}
                    type="button"
                  >
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

  return (
    <section className={sidebarCollapsed ? 'browser-chat-layout sidebar-collapsed' : 'browser-chat-layout'}>
      <aside className="browser-chat-sidebar">
        <div className="browser-chat-brand">
          <strong>AI Web Test</strong>
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
            <EnvironmentSettings activeTab={settingsTab} embedded showTabs={false} onActiveTabChange={setSettingsTab} />
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
                exportingMessageId={exportingMessageId}
                lastAssistantMessageId={lastAssistantMessageId}
                logIndex={logIndex}
                messages={visibleMessages}
                onExportMessage={exportMessageToTestCase}
                onPreviewImage={previewAttachment}
                onSelectTool={setToolDialog}
                onShowLogs={showMessageLogs}
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
              {error || session?.error ? <div className="error">{error || session?.error}</div> : null}
              <BrowserChatComposer
                attachments={attachments}
                busy={busy}
                currentBusy={currentBusy}
                imageInputRef={imageInputRef}
                interrupting={interrupting}
                loading={Boolean(loadingSessionId)}
                mode={mode}
                modeLocked={modeLocked}
                onInterrupt={interruptConversation}
                onModeChange={setMode}
                onPreviewAttachment={previewAttachment}
                onRemoveAttachment={removeAttachment}
                onSubmitMessage={sendMessage}
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
                <h2>{toolDialog.tool.name}</h2>
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
                <strong>{toolDialog.tool.name}</strong>
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
            {toolDialogDomTree ? (
              <section className="browser-chat-tool-detail-section">
                <h3>模型看到的 DOM 树</h3>
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
              <ol className="browser-chat-log-modal-list">
                {logDialogEntries.map((log) => (
                  <li key={log.id}>
                    <span>{phaseLabel(log.phase)}</span>
                    <div>
                      <strong>{log.message}</strong>
                      <small>
                        {formatLogTime(log.time)}
                        {log.stepIndex ? ` · 步骤 ${log.stepIndex}` : ''}
                        {typeof log.elapsedMs === 'number' ? ` · ${log.elapsedMs}ms` : ''}
                      </small>
                      {log.details ? <pre>{log.details}</pre> : null}
                    </div>
                  </li>
                ))}
              </ol>
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
