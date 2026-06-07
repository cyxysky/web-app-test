'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
  Bot,
  Folder,
  Loader2,
  MessageSquare,
  PanelLeft,
  Power,
  ScrollText,
  Send,
  Settings,
  FilePlus2,
  Trash2,
  User,
  Wrench,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DashboardGroupSidebar, DashboardWorkspace, groupPath } from '@/components/DashboardWorkspace';
import { EnvironmentSettings, environmentSettingsTabs } from '@/components/EnvironmentSettings';
import type { SettingsTab } from '@/config/settings';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';
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
  stepIndexes?: number[];
  status?: 'running' | 'passed' | 'failed' | 'blocked';
};

type BrowserChatLogRecord = {
  id: string;
  time: string;
  phase: string;
  message: string;
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
  toolIndex: number;
  tool: BrowserChatToolCall;
};

function statusLabel(status: string) {
  return ({
    blocked: '阻塞',
    closed: '已结束',
    error: '异常',
    failed: '失败',
    idle: '空闲',
    passed: '完成',
    running: '执行中',
  } as Record<string, string>)[status] || status;
}

function compactText(value?: string, max = 160) {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
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
    messages: session.messages || [],
    mode: normalizeMode(session.mode),
    networkErrors: session.networkErrors || [],
    steps: session.steps || [],
  };
}

function sessionSortTime(session: BrowserChatSession) {
  return session.updatedAt || session.createdAt || '';
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

function normalizedAgentText(value?: string) {
  return (value || '').trim();
}

function stepNarrative(step: StepExecutionResult) {
  const text = normalizedAgentText(step.note) || normalizedAgentText(step.actual);
  if (!text) return '';
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

function BrowserChatMarkdown({ markdown }: { markdown: string }) {
  const normalizedMarkdown = normalizeChatMarkdown(markdown);
  return (
    <div className="browser-chat-agent-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {normalizedMarkdown}
      </ReactMarkdown>
    </div>
  );
}

function BrowserChatStepToolCards({
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
        <Wrench size={14} />
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
        <button
          className="browser-chat-tool-card"
          key={`${step.index}-${toolIndex}`}
          onClick={() => onSelectTool({ stepIndex: step.index, toolIndex, tool })}
          type="button"
        >
          <div>
            <strong>{compactText(tool.name, 72)}</strong>
            {tool.reason ? <p>{compactText(tool.reason, 140)}</p> : null}
          </div>
          <span className={tool.ok === false ? 'badge status-failed' : 'badge neutral'}>{toolStatusLabel(tool)}</span>
        </button>
      ))}
    </>
  );
}

function BrowserChatAssistantTimeline({
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
      {steps.map((step) => (
        <div className="browser-chat-agent-step" key={step.index}>
          <BrowserChatStepToolCards onSelectTool={onSelectTool} running={running && step.status === 'running'} step={step} />
          {renderText(stepNarrative(step), `step-${step.index}-text`)}
        </div>
      ))}
      {!running || !steps.length ? renderText(finalText, 'final-text') : null}
    </div>
  );
}

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
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [exportingMessageId, setExportingMessageId] = useState<string | null>(null);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [logDialogMessageId, setLogDialogMessageId] = useState<string | null>(null);
  const [toolDialog, setToolDialog] = useState<BrowserChatToolDetail | null>(null);
  const [error, setError] = useState('');
  const runningSession = useMemo(() => (session?.busy ? session : sessions.find((item) => item.busy)), [session, sessions]);
  const currentBusy = busy || Boolean(runningSession);
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
  const logDialogMessage = useMemo(
    () => messages.find((item) => item.id === logDialogMessageId),
    [logDialogMessageId, messages],
  );
  const logDialogEntries = useMemo(() => {
    if (!logDialogMessage) return [];
    const byMessageId = logs.filter((log) => log.messageId === logDialogMessage.id);
    if (byMessageId.length) return byMessageId;
    const stepIndexes = new Set(logDialogMessage.stepIndexes || []);
    return logs.filter((log) => log.stepIndex && stepIndexes.has(log.stepIndex));
  }, [logDialogMessage, logs]);
  const recentSessions = useMemo(() => {
    const merged = new Map<string, BrowserChatSession>();
    for (const item of sessions) merged.set(item.id, item);
    if (session) merged.set(session.id, session);
    return [...merged.values()]
      .filter((item) => item.messages.length || item.id === session?.id)
      .sort((a, b) => sessionSortTime(b).localeCompare(sessionSortTime(a)))
      .slice(0, 14);
  }, [session, sessions]);

  const upsertSession = useCallback((nextSession: BrowserChatSession) => {
    const normalized = normalizeSession(nextSession);
    setSession(normalized);
    setSessions((current) => {
      const next = [normalized, ...current.filter((item) => item.id !== normalized.id)];
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

  const refreshSession = useCallback(async (sessionId: string) => {
    const response = await fetch(`/api/browser-chat/${sessionId}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '加载对话失败');
    const loadedSession = upsertSession(data.session as BrowserChatSession);
    setMode(normalizeMode(loadedSession.mode));
    return loadedSession;
  }, [upsertSession]);

  useEffect(() => {
    void loadSessions().catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : '加载对话历史失败');
    });
  }, [loadSessions]);

  useEffect(() => {
    if (!session?.id) return undefined;
    const sessionId = session.id;
    const events = new EventSource(`/api/browser-chat/${sessionId}/events`);
    let refreshTimer: number | undefined;
    const scheduleRefresh = (delay = 20) => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        void refreshSession(sessionId).catch((refreshError) => {
          setError(refreshError instanceof Error ? refreshError.message : '加载对话失败');
        });
      }, delay);
    };
    const handleRefresh = () => scheduleRefresh();
    events.addEventListener('refresh', handleRefresh);
    events.onopen = () => scheduleRefresh(0);
    events.onerror = () => undefined;
    return () => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      events.removeEventListener('refresh', handleRefresh);
      events.close();
    };
  }, [refreshSession, session?.id]);

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
    return upsertSession(data.session as BrowserChatSession);
  }

  async function ensureSession() {
    if (session && session.status !== 'closed') return session;
    return createSession();
  }

  async function postMessageToSession(sessionId: string, content: string, clientMessageId: string) {
    const response = await fetch(`/api/browser-chat/${sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientMessageId, content, mode }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '发送消息失败');
    return data.session as BrowserChatSession;
  }

  async function sendMessage() {
    const content = message.trim();
    if (!content || currentBusy || loadingSessionId || sendingRef.current) return;
    sendingRef.current = true;
    const clientMessageId = temporaryId('client_msg');
    setError('');
    setBusy(true);
    setActiveView('chat');
    try {
      let active = await ensureSession();
      let posted: BrowserChatSession;
      try {
        posted = await postMessageToSession(active.id, content, clientMessageId);
      } catch (firstError) {
        const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
        if (!/Browser chat session not found/i.test(firstMessage)) throw firstError;
        active = await createSession();
        posted = await postMessageToSession(active.id, content, clientMessageId);
      }
      upsertSession(posted);
      window.setTimeout(() => {
        void refreshSession(posted.id).catch(() => undefined);
      }, 600);
      setMessage('');
      await loadSessions().catch(() => undefined);
    } catch (sendError) {
      const sendMessageText = sendError instanceof Error ? sendError.message : '发送消息失败';
      setError(sendMessageText);
      setMessage(content);
    } finally {
      sendingRef.current = false;
      setBusy(false);
    }
  }

  async function closeSession() {
    if (!session || currentBusy) return;
    setBusy(true);
    startGlobalLoading('正在结束浏览器对话');
    try {
      const response = await fetch(`/api/browser-chat/${session.id}`, { method: 'DELETE' });
      const data = await response.json();
      if (response.ok) {
        upsertSession(data.session);
        await loadSessions().catch(() => undefined);
      }
    } finally {
      setBusy(false);
      stopGlobalLoading();
    }
  }

  async function deleteSessionHistory(sessionId: string) {
    if (deletingSessionId) return;
    setDeletingSessionId(sessionId);
    setError('');
    try {
      const response = await fetch(`/api/browser-chat/${sessionId}/delete`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '删除历史对话失败');
      setSessions((current) => current.filter((item) => item.id !== sessionId));
      if (session?.id === sessionId) setSession(null);
      await loadSessions().catch(() => undefined);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除历史对话失败');
    } finally {
      setDeletingSessionId(null);
    }
  }

  async function exportMessageToTestCase(messageId: string) {
    if (!session || exportingMessageId) return;
    setExportingMessageId(messageId);
    setError('');
    try {
      const response = await fetch(`/api/browser-chat/${session.id}/export`, {
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
  }

  async function startNewConversation() {
    setActiveView('chat');
    if (currentBusy) return;
    setError('');
    setMessage('');
    setSession(null);
  }

  async function loadSession(sessionId: string, options: { allowBusy?: boolean } = {}) {
    if (currentBusy && session?.id !== sessionId && !options.allowBusy) return;
    if (loadingSessionRef.current === sessionId) return;
    loadingSessionRef.current = sessionId;
    setLoadingSessionId(sessionId);
    setActiveView('chat');
    setError('');
    setMessage('');
    try {
      const loadedSession = await refreshSession(sessionId);
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
    setActiveView('chat');
    if (runningSession) {
      await loadSession(runningSession.id, { allowBusy: true });
      return;
    }
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
        <h2>最近</h2>
        {recentSessions.length ? (
          <ol className="browser-chat-recent-list">
            {recentSessions.map((item) => (
              <li key={item.id}>
                <div className={session?.id === item.id ? 'browser-chat-recent-item active' : 'browser-chat-recent-item'}>
                  <button
                    className="browser-chat-recent-open"
                    disabled={(currentBusy && session?.id !== item.id && !item.busy) || Boolean(loadingSessionId && loadingSessionId !== item.id)}
                    onClick={() => void loadSession(item.id, { allowBusy: item.busy })}
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
                    disabled={item.busy || deletingSessionId === item.id}
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
            aria-label={runningSession ? '返回正在执行的对话' : '新对话'}
            className={activeView === 'chat' ? 'browser-chat-nav-item active' : 'browser-chat-nav-item'}
            onClick={() => void openChatEntry()}
            title={runningSession ? '返回正在执行的对话' : '新对话'}
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
              <button className="browser-chat-close" disabled={session.status === 'closed' || currentBusy} onClick={closeSession} title="结束会话" type="button">
                <Power size={17} />
              </button>
            ) : null}

            {hasMessages ? (
              <div className="browser-chat-message-list">
                {visibleMessages.map((item) => {
                  const itemSteps = (item.stepIndexes || []).map((stepIndex) => stepsByIndex.get(stepIndex)).filter((step): step is StepExecutionResult => Boolean(step));
                  const operationRunning = item.role === 'assistant' && (item.status === 'running' || Boolean(session?.busy && item.id === lastAssistantMessageId));
                  const itemLogs = item.role === 'assistant'
                    ? logs.filter((log) => log.messageId === item.id || (!log.messageId && log.stepIndex && (item.stepIndexes || []).includes(log.stepIndex)))
                    : [];
                  const canExportMessage = item.role === 'assistant' && item.status !== 'running' && (itemSteps.length > 0 || steps.length > 0);
                  return (
                    <article className={`browser-chat-message ${item.role}`} key={item.id}>
                      <div className="browser-chat-avatar">
                        {item.role === 'user' ? <User size={15} /> : <Bot size={15} />}
                      </div>
                      <div>
                        {item.role === 'assistant' ? (
                          <>
                            <div className="browser-chat-agent-meta">
                              <span>{operationRunning ? '处理中' : '已处理'}</span>
                              <time dateTime={messageUpdateTime(item)}>最后更新 {formatLogTime(messageUpdateTime(item))}</time>
                            </div>
                            <BrowserChatAssistantTimeline message={item} onSelectTool={setToolDialog} running={operationRunning} steps={itemSteps} />
                          </>
                        ) : (
                          <>
                            <p>{item.content}</p>
                            <time className="browser-chat-message-time" dateTime={messageUpdateTime(item)}>
                              最后更新 {formatLogTime(messageUpdateTime(item))}
                            </time>
                          </>
                        )}
                        {item.role === 'assistant' ? (
                          <div className="browser-chat-message-actions">
                            {itemLogs.length ? (
                              <button className="browser-chat-log-button" onClick={() => setLogDialogMessageId(item.id)} type="button">
                                <ScrollText size={14} />
                                查看日志
                              </button>
                            ) : null}
                            {canExportMessage ? (
                              <button
                                className="browser-chat-log-button"
                                disabled={Boolean(exportingMessageId)}
                                onClick={() => void exportMessageToTestCase(item.id)}
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
                })}
              </div>
            ) : (
              <div className="browser-chat-hero">
                <h1>今天要测试什么？</h1>
              </div>
            )}

            <div className="browser-chat-composer-shell">
              {error || session?.error ? <div className="error">{error || session?.error}</div> : null}
              <form
                className="browser-chat-compose"
                onSubmit={(event) => {
                  event.preventDefault();
                  void sendMessage();
                }}
              >
                <textarea
                  disabled={currentBusy || Boolean(loadingSessionId)}
                  placeholder="有问题，尽管问"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void sendMessage();
                    }
                  }}
                />
                <div className="browser-chat-mode-toggle" role="radiogroup" aria-label="操作模式">
                  <button
                    aria-pressed={mode === 'visual-markers'}
                    className={mode === 'visual-markers' ? 'active' : undefined}
                    disabled={currentBusy || Boolean(loadingSessionId) || modeLocked}
                    onClick={() => setMode('visual-markers')}
                    type="button"
                  >
                    视觉
                  </button>
                  <button
                    aria-pressed={mode === 'dom'}
                    className={mode === 'dom' ? 'active' : undefined}
                    disabled={currentBusy || Boolean(loadingSessionId) || modeLocked}
                    onClick={() => setMode('dom')}
                    type="button"
                  >
                    DOM
                  </button>
                </div>
                <button className="browser-chat-send" disabled={!message.trim() || currentBusy || Boolean(loadingSessionId)} type="submit" aria-label="发送">
                  {currentBusy ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
                </button>
              </form>
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
            {toolDialog.tool.visualAfter ? (
              <section className="browser-chat-tool-detail-section">
                <h3>视觉截图参数</h3>
                <pre>{formatToolPayload(toolDialog.tool.visualAfter)}</pre>
              </section>
            ) : null}
            {toolDialog.tool.screenshots?.length ? (
              <section className="browser-chat-tool-detail-section">
                <h3>截图记录</h3>
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
