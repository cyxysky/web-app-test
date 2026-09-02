import { queryDatabase, queryDatabaseOne } from '@/server/db/database';
import { runtimeMetricsSnapshot } from '@/server/observability/runtime-observability';
import { databaseWriteQueueSnapshot } from '@/server/storage/database-write-queue';
import { fileTextExtractionPoolSnapshot } from '@/server/capabilities/webpilot-file-observability';
import { readArchivedAiOperationsChatSessions } from '@/server/observability/ai-operations-chat-archive';

export type AiOperationsStatus = 'passed' | 'failed' | 'blocked' | 'running' | 'interrupted' | 'unknown';

export type AiOperationsTrendPoint = {
  activeUsers: number;
  automationRuns: number;
  blocked: number;
  chatTasks: number;
  date: string;
  failed: number;
  interrupted: number;
  passed: number;
  running: number;
};

export type AiOperationsIncident = {
  href?: string;
  id: string;
  reason: string;
  source: 'automation' | 'chat';
  status: Exclude<AiOperationsStatus, 'passed' | 'running' | 'unknown'>;
  target: string;
  time: string;
  title: string;
  userId: string;
};

export type AiOperationsUserMetric = {
  automationRuns: number;
  blocked: number;
  chatTasks: number;
  failed: number;
  inputTokens: number;
  lastActiveAt: string;
  outputTokens: number;
  passed: number;
  successRate: number;
  totalTokens: number;
  totalTasks: number;
  userId: string;
};

export type AiOperationsModelMetric = {
  averageResponseMs: number;
  blocked: number;
  calls: number;
  failed: number;
  inputTokens: number;
  model: string;
  outputTokens: number;
  outputTokensPerSecond: number;
  passed: number;
  provider: string;
  sessionCount: number;
  taskCount: number;
};

export type AiOperationsSystemMetric = {
  blocked: number;
  failed: number;
  passed: number;
  successRate: number;
  target: string;
  totalTasks: number;
};

export type AiOperationsDashboardData = {
  generatedAt: string;
  incidents: AiOperationsIncident[];
  models: AiOperationsModelMetric[];
  overview: {
    activeUsers: number;
    automationRuns: number;
    averageDurationMs: number;
    blocked: number;
    chatTasks: number;
    enabledSchedules: number;
    failed: number;
    inputTokens: number;
    interrupted: number;
    modelCalls: number;
    outputTokens: number;
    p95DurationMs: number;
    passed: number;
    repairs: number;
    runningNow: number;
    successRate: number;
    totalTasks: number;
  };
  rangeDays: number;
  runtime: {
    cpuWorkers: ReturnType<typeof fileTextExtractionPoolSnapshot>;
    databaseWrites: ReturnType<typeof databaseWriteQueueSnapshot>;
  };
  systems: AiOperationsSystemMetric[];
  timezone: string;
  trend: AiOperationsTrendPoint[];
  trendUserId?: string;
  trendUsers: Array<Pick<AiOperationsUserMetric, 'totalTasks' | 'totalTokens' | 'userId'>>;
  users: AiOperationsUserMetric[];
};

type JsonRecord = Record<string, unknown>;

type SessionRow = {
  created_at: string;
  id: string;
  status: string;
  summary_json: string;
  title: string;
  updated_at: string;
  user_id?: string | null;
};

type MessageRow = {
  record_json: string;
  session_id: string;
  time: string;
  user_id?: string | null;
};

type StepRow = {
  record_json: string;
  session_id: string;
  user_id?: string | null;
};

type LogRow = {
  record_json: string;
  session_id: string;
  time: string;
  user_id?: string | null;
};

type AutomationRunRow = {
  case_id: string;
  created_at: string;
  id: string;
  record_json: string;
  status: string;
  updated_at: string;
  user_id: string;
};

type AutomationCaseRow = {
  id: string;
  record_json: string;
  title: string;
};

type MutableUserMetric = Omit<AiOperationsUserMetric, 'successRate' | 'totalTasks'>;
type MutableModelMetric = Omit<AiOperationsModelMetric, 'sessionCount'> & { sessions: Set<string> };
type MutableSystemMetric = Omit<AiOperationsSystemMetric, 'successRate'>;

const dashboardTimezone = 'Asia/Hong_Kong';

function parseRecord(value: unknown): JsonRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonRecord;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : {};
  } catch {
    return {};
  }
}

function text(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function numberValue(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function tokenValue(value: unknown) {
  const record = parseRecord(value);
  return Math.max(0, numberValue(record.total || record.totalTokens || value));
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function compact(value: unknown, max = 150) {
  const normalized = text(value).replace(/\s+/g, ' ');
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function timestampMs(value: unknown) {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function durationMs(start: unknown, finish: unknown) {
  const startedAt = timestampMs(start);
  const finishedAt = timestampMs(finish);
  return startedAt && finishedAt && finishedAt >= startedAt ? finishedAt - startedAt : 0;
}

function dateKey(value: unknown) {
  const timestamp = timestampMs(value);
  if (!timestamp) return '';
  return new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: dashboardTimezone,
    year: 'numeric',
  }).format(new Date(timestamp));
}

function normalizedStatus(value: unknown): AiOperationsStatus {
  const status = text(value).toLowerCase();
  if (['passed', 'complete', 'completed', 'success', 'succeeded'].includes(status)) return 'passed';
  if (['failed', 'error'].includes(status)) return 'failed';
  if (['blocked', 'skipped'].includes(status)) return 'blocked';
  if (['running', 'queued', 'pending'].includes(status)) return 'running';
  if (['interrupted', 'cancelled', 'canceled'].includes(status)) return 'interrupted';
  return 'unknown';
}

function targetFromUrl(value: unknown) {
  const raw = text(value);
  if (!raw) return '未指定页面';
  try {
    return new URL(raw).hostname || raw;
  } catch {
    return raw.replace(/^https?:\/\//i, '').split('/')[0] || '未指定页面';
  }
}

function successRate(passed: number, failed: number, blocked: number, interrupted = 0) {
  const terminal = passed + failed + blocked + interrupted;
  return terminal ? Math.round((passed / terminal) * 1000) / 10 : 0;
}

function percentile(values: number[], ratio: number) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * ratio) - 1)] || 0;
}

function metricDescriptor(value: string) {
  const match = /^([^{}]+)(?:\{(.+)\})?$/.exec(value);
  const labels: Record<string, string> = {};
  for (const item of match?.[2]?.split(',') || []) {
    const separator = item.indexOf('=');
    if (separator > 0) labels[item.slice(0, separator)] = item.slice(separator + 1);
  }
  return { labels, name: match?.[1] || value };
}

function modelKey(provider: string, model: string) {
  return `${provider}\u0000${model}`;
}

function modelIdentity(summary: JsonRecord) {
  return {
    model: text(summary.model) || 'unknown-model',
    provider: text(summary.modelProvider) || 'unknown-provider',
  };
}

function usageFromLog(value: unknown) {
  const log = parseRecord(value);
  if (!['ai:runtime:object', 'ai:runtime:response'].includes(text(log.phase))) return undefined;
  const details = parseRecord(log.details);
  const payload = parseRecord(details.value);
  const aiOutput = parseRecord(payload.aiOutput || details.aiOutput);
  const response = parseRecord(aiOutput.response);
  const usage = parseRecord(aiOutput.usage || response.usage);
  const inputTokens = tokenValue(usage.inputTokens || usage.promptTokens || usage.input_tokens || usage.prompt_tokens);
  const outputTokens = tokenValue(usage.outputTokens || usage.completionTokens || usage.output_tokens || usage.completion_tokens);
  const totalTokens = Math.max(
    inputTokens + outputTokens,
    tokenValue(usage.totalTokens || usage.total_tokens),
  );
  return totalTokens ? { inputTokens, outputTokens, totalTokens } : undefined;
}

function mutableUser(users: Map<string, MutableUserMetric>, userIdValue: unknown) {
  const userId = text(userIdValue) || 'unknown';
  let metric = users.get(userId);
  if (!metric) {
    metric = {
      automationRuns: 0,
      blocked: 0,
      chatTasks: 0,
      failed: 0,
      inputTokens: 0,
      lastActiveAt: '',
      outputTokens: 0,
      passed: 0,
      totalTokens: 0,
      userId,
    };
    users.set(userId, metric);
  }
  return metric;
}

function mutableSystem(systems: Map<string, MutableSystemMetric>, target: string) {
  let metric = systems.get(target);
  if (!metric) {
    metric = { blocked: 0, failed: 0, passed: 0, target, totalTasks: 0 };
    systems.set(target, metric);
  }
  return metric;
}

function mutableModel(
  models: Map<string, MutableModelMetric>,
  provider: string,
  model: string,
) {
  const key = modelKey(provider, model);
  let metric = models.get(key);
  if (!metric) {
    metric = {
      averageResponseMs: 0,
      blocked: 0,
      calls: 0,
      failed: 0,
      inputTokens: 0,
      model,
      outputTokens: 0,
      outputTokensPerSecond: 0,
      passed: 0,
      provider,
      sessions: new Set(),
      taskCount: 0,
    };
    models.set(key, metric);
  }
  return metric;
}

function markStatus(target: { blocked: number; failed: number; passed: number }, status: AiOperationsStatus) {
  if (status === 'passed') target.passed += 1;
  else if (status === 'failed' || status === 'interrupted') target.failed += 1;
  else if (status === 'blocked') target.blocked += 1;
}

function trendPoint(date: string): AiOperationsTrendPoint {
  return {
    activeUsers: 0,
    automationRuns: 0,
    blocked: 0,
    chatTasks: 0,
    date,
    failed: 0,
    interrupted: 0,
    passed: 0,
    running: 0,
  };
}

function addTrendStatus(point: AiOperationsTrendPoint | undefined, status: AiOperationsStatus) {
  if (!point || status === 'unknown') return;
  point[status] += 1;
}

function boundedRangeDays(value: number) {
  if (value <= 7) return 7;
  if (value <= 30) return 30;
  return 90;
}

export async function readAiOperationsDashboard(
  rangeDaysValue = 30,
  trendUserIdValue?: unknown,
): Promise<AiOperationsDashboardData> {
  const rangeDays = boundedRangeDays(rangeDaysValue);
  const trendUserId = text(trendUserIdValue) || undefined;
  const now = new Date();
  const since = new Date(now.getTime() - (rangeDays - 1) * 24 * 60 * 60 * 1000);
  since.setUTCHours(0, 0, 0, 0);
  const sinceIso = since.toISOString();
  const [sessions, allLiveSessions, archivedChatSessions, messages, steps, logs,
    automationRuns, automationCases, scheduleCount] = await Promise.all([
    queryDatabase<SessionRow>(`
    SELECT id, user_id, title, status, summary_json, created_at, updated_at
    FROM browser_chat_session
    WHERE updated_at >= ?
  `, [sinceIso]),
    queryDatabase<{ id: string }>(`
    SELECT id FROM browser_chat_session
  `),
    readArchivedAiOperationsChatSessions(),
    queryDatabase<MessageRow>(`
    SELECT message.session_id, message.time, message.record_json, session.user_id
    FROM browser_chat_message AS message
    JOIN browser_chat_session AS session ON session.id = message.session_id
    WHERE message.time >= ?
    ORDER BY message.time ASC
  `, [sinceIso]),
    queryDatabase<StepRow>(`
    SELECT step.session_id, step.record_json, session.user_id
    FROM browser_chat_step AS step
    JOIN browser_chat_session AS session ON session.id = step.session_id
    WHERE session.updated_at >= ?
  `, [sinceIso]),
    queryDatabase<LogRow>(`
    SELECT log.session_id, log.time, log.record_json, session.user_id
    FROM browser_chat_log AS log
    JOIN browser_chat_session AS session ON session.id = log.session_id
    WHERE log.time >= ?
    ORDER BY log.time ASC
  `, [sinceIso]),
    queryDatabase<AutomationRunRow>(`
    SELECT id, user_id, case_id, status, record_json, created_at, updated_at
    FROM automation_run
    WHERE updated_at >= ?
    ORDER BY updated_at DESC
  `, [sinceIso]),
    queryDatabase<AutomationCaseRow>(`
    SELECT id, title, record_json FROM automation_case
  `),
    queryDatabaseOne<{ count?: number }>(`
      SELECT COUNT(*) AS count FROM automation_schedule WHERE enabled = ?
    `, [true]),
  ]);
  const liveSessionIds = new Set(allLiveSessions.map((row) => row.id));
  const enabledSchedules = numberValue(scheduleCount?.count);

  const sessionById = new Map(sessions.map((row) => [row.id, {
    ...row,
    summary: parseRecord(row.summary_json),
  }]));
  const caseById = new Map(automationCases.map((row) => [row.id, {
    ...row,
    record: parseRecord(row.record_json),
  }]));
  const trend = new Map<string, AiOperationsTrendPoint>();
  const trendUsers = new Map<string, Set<string>>();
  for (let offset = rangeDays - 1; offset >= 0; offset -= 1) {
    const key = dateKey(new Date(now.getTime() - offset * 24 * 60 * 60 * 1000).toISOString());
    trend.set(key, trendPoint(key));
    trendUsers.set(key, new Set());
  }

  const users = new Map<string, MutableUserMetric>();
  const models = new Map<string, MutableModelMetric>();
  const systems = new Map<string, MutableSystemMetric>();
  const incidents: AiOperationsIncident[] = [];
  const durations: number[] = [];
  let chatTasks = 0;
  let chatPassed = 0;
  let chatFailed = 0;
  let chatBlocked = 0;
  let chatInterrupted = 0;
  let chatRunning = 0;

  for (const row of messages) {
    const message = parseRecord(row.record_json);
    const role = text(message.role);
    const session = sessionById.get(row.session_id);
    const userId = text(row.user_id) || text(session?.summary.userId) || 'unknown';
    const eventTime = text(message.updatedAt) || text(message.createdAt) || row.time;
    const point = trend.get(dateKey(eventTime));
    const user = mutableUser(users, userId);
    const identity = modelIdentity(session?.summary || {});
    const model = mutableModel(models, identity.provider, identity.model);
    const target = targetFromUrl(session?.summary.targetUrl);
    const system = mutableSystem(systems, target);
    const includeInTrend = !trendUserId || trendUserId === userId;
    if (role === 'user') {
      chatTasks += 1;
      if (point && includeInTrend) point.chatTasks += 1;
      if (includeInTrend) trendUsers.get(dateKey(eventTime))?.add(userId);
      user.chatTasks += 1;
      user.lastActiveAt = user.lastActiveAt > eventTime ? user.lastActiveAt : eventTime;
      model.taskCount += 1;
      model.sessions.add(row.session_id);
      system.totalTasks += 1;
      continue;
    }
    if (role !== 'assistant') continue;
    let status = normalizedStatus(message.status);
    if (status === 'unknown' && text(message.content)) status = 'passed';
    if (includeInTrend) addTrendStatus(point, status);
    const elapsed = durationMs(message.createdAt, message.updatedAt || row.time);
    if (elapsed) durations.push(elapsed);
    if (status === 'passed') chatPassed += 1;
    else if (status === 'failed') chatFailed += 1;
    else if (status === 'blocked') chatBlocked += 1;
    else if (status === 'interrupted') chatInterrupted += 1;
    else if (status === 'running') chatRunning += 1;
    markStatus(user, status);
    markStatus(model, status);
    markStatus(system, status);
    if (['failed', 'blocked', 'interrupted'].includes(status)) {
      incidents.push({
        href: userId === '1' ? `/browser-chat?sessionId=${encodeURIComponent(row.session_id)}` : undefined,
        id: `chat:${row.session_id}:${text(message.id) || row.time}`,
        reason: compact(message.content) || compact(session?.summary.error) || '任务未能正常完成',
        source: 'chat',
        status: status as AiOperationsIncident['status'],
        target,
        time: eventTime,
        title: text(session?.title) || text(session?.summary.title) || '浏览器对话任务',
        userId,
      });
    }
  }

  for (const row of logs) {
    const usage = usageFromLog(row.record_json);
    if (!usage) continue;
    const session = sessionById.get(row.session_id);
    const userId = text(row.user_id) || text(session?.summary.userId) || 'unknown';
    const user = mutableUser(users, userId);
    user.inputTokens += usage.inputTokens;
    user.outputTokens += usage.outputTokens;
    user.totalTokens += usage.totalTokens;
    user.lastActiveAt = user.lastActiveAt > row.time ? user.lastActiveAt : row.time;
  }

  let repairs = 0;
  for (const row of steps) {
    const step = parseRecord(row.record_json);
    for (const tool of arrayValue(step.tools)) {
      const record = parseRecord(tool);
      if (record.recovered === true) repairs += 1;
    }
  }

  const sinceTimestamp = timestampMs(sinceIso);
  for (const archive of archivedChatSessions) {
    if (liveSessionIds.has(archive.sessionId)) continue;
    const identity = {
      model: text(archive.model) || 'unknown-model',
      provider: text(archive.provider) || 'unknown-provider',
    };
    const target = targetFromUrl(archive.targetUrl);
    const userId = text(archive.userId) || 'unknown';
    const includeInTrend = !trendUserId || trendUserId === userId;
    for (const message of archive.messages) {
      const eventTime = text(message.time);
      if (!eventTime || timestampMs(eventTime) < sinceTimestamp) continue;
      const point = trend.get(dateKey(eventTime));
      const user = mutableUser(users, userId);
      const model = mutableModel(models, identity.provider, identity.model);
      const system = mutableSystem(systems, target);
      if (message.role === 'user') {
        chatTasks += 1;
        if (point && includeInTrend) point.chatTasks += 1;
        if (includeInTrend) trendUsers.get(dateKey(eventTime))?.add(userId);
        user.chatTasks += 1;
        user.lastActiveAt = user.lastActiveAt > eventTime ? user.lastActiveAt : eventTime;
        model.taskCount += 1;
        model.sessions.add(archive.sessionId);
        system.totalTasks += 1;
        continue;
      }
      let status = normalizedStatus(message.status);
      if (status === 'running') status = 'interrupted';
      if (includeInTrend) addTrendStatus(point, status);
      if (message.durationMs > 0) durations.push(message.durationMs);
      if (status === 'passed') chatPassed += 1;
      else if (status === 'failed') chatFailed += 1;
      else if (status === 'blocked') chatBlocked += 1;
      else if (status === 'interrupted') chatInterrupted += 1;
      markStatus(user, status);
      markStatus(model, status);
      markStatus(system, status);
      if (['failed', 'blocked', 'interrupted'].includes(status)) {
        incidents.push({
          id: `archived-chat:${archive.sessionId}:${message.id}`,
          reason: '对话内容已删除，仅保留匿名化运营结果',
          source: 'chat',
          status: status as AiOperationsIncident['status'],
          target,
          time: eventTime,
          title: '已删除的对话任务',
          userId,
        });
      }
    }
    for (const usage of archive.usages) {
      const eventTime = text(usage.time);
      if (!eventTime || timestampMs(eventTime) < sinceTimestamp) continue;
      const user = mutableUser(users, userId);
      user.inputTokens += numberValue(usage.inputTokens);
      user.outputTokens += numberValue(usage.outputTokens);
      user.totalTokens += numberValue(usage.totalTokens);
      user.lastActiveAt = user.lastActiveAt > eventTime ? user.lastActiveAt : eventTime;
    }
    if (timestampMs(archive.updatedAt) >= sinceTimestamp) repairs += numberValue(archive.repairs);
  }

  let automationPassed = 0;
  let automationFailed = 0;
  let automationBlocked = 0;
  let automationInterrupted = 0;
  let automationRunning = 0;
  for (const row of automationRuns) {
    const run = parseRecord(row.record_json);
    const automationCase = caseById.get(row.case_id);
    const eventTime = text(run.finishedAt) || text(run.startedAt) || row.updated_at || row.created_at;
    const point = trend.get(dateKey(eventTime));
    const status = normalizedStatus(run.status || row.status);
    const userId = text(row.user_id) || text(run.userId) || 'unknown';
    const user = mutableUser(users, userId);
    const target = targetFromUrl(automationCase?.record.targetUrl);
    const system = mutableSystem(systems, target);
    const includeInTrend = !trendUserId || trendUserId === userId;
    if (point && includeInTrend) {
      point.automationRuns += 1;
      addTrendStatus(point, status);
    }
    if (includeInTrend) trendUsers.get(dateKey(eventTime))?.add(userId);
    user.automationRuns += 1;
    user.lastActiveAt = user.lastActiveAt > eventTime ? user.lastActiveAt : eventTime;
    system.totalTasks += 1;
    markStatus(user, status);
    markStatus(system, status);
    const elapsed = durationMs(run.startedAt || row.created_at, run.finishedAt || row.updated_at);
    if (elapsed) durations.push(elapsed);
    const runSteps = arrayValue(run.steps).map(parseRecord);
    repairs += runSteps.filter((step) => text(step.status) === 'repaired').length;
    if (status === 'passed') automationPassed += 1;
    else if (status === 'failed') automationFailed += 1;
    else if (status === 'blocked') automationBlocked += 1;
    else if (status === 'interrupted') automationInterrupted += 1;
    else if (status === 'running') automationRunning += 1;
    if (['failed', 'blocked', 'interrupted'].includes(status)) {
      const failureStep = [...runSteps].reverse().find((step) => text(step.error) || text(step.actual));
      incidents.push({
        href: `/automation?caseId=${encodeURIComponent(row.case_id)}`,
        id: `automation:${row.id}`,
        reason: compact(run.error) || compact(failureStep?.error) || compact(failureStep?.actual) || '自动化运行未能正常完成',
        source: 'automation',
        status: status as AiOperationsIncident['status'],
        target,
        time: eventTime,
        title: text(automationCase?.title) || text(automationCase?.record.title) || '自动化任务',
        userId,
      });
    }
  }

  for (const [key, point] of trend) point.activeUsers = trendUsers.get(key)?.size || 0;

  const runtimeMetrics = runtimeMetricsSnapshot();
  for (const [key, value] of Object.entries(runtimeMetrics.counters)) {
    const descriptor = metricDescriptor(key);
    if (!['ai_sdk_model_calls_total', 'ai_sdk_input_tokens_total', 'ai_sdk_output_tokens_total'].includes(descriptor.name)) continue;
    const provider = descriptor.labels.provider || 'unknown-provider';
    const model = descriptor.labels.model || 'unknown-model';
    const metric = mutableModel(models, provider, model);
    if (descriptor.name === 'ai_sdk_model_calls_total') metric.calls += numberValue(value);
    else if (descriptor.name === 'ai_sdk_input_tokens_total') metric.inputTokens += numberValue(value);
    else metric.outputTokens += numberValue(value);
  }
  for (const [key, value] of Object.entries(runtimeMetrics.gauges)) {
    const descriptor = metricDescriptor(key);
    if (descriptor.name !== 'ai_sdk_output_tokens_per_second') continue;
    mutableModel(
      models,
      descriptor.labels.provider || 'unknown-provider',
      descriptor.labels.model || 'unknown-model',
    ).outputTokensPerSecond = numberValue(value);
  }
  for (const [key, value] of Object.entries(runtimeMetrics.timings)) {
    const descriptor = metricDescriptor(key);
    if (descriptor.name !== 'ai_sdk_model_response_ms') continue;
    mutableModel(
      models,
      descriptor.labels.provider || 'unknown-provider',
      descriptor.labels.model || 'unknown-model',
    ).averageResponseMs = numberValue(parseRecord(value).averageMs);
  }

  const passed = chatPassed + automationPassed;
  const failed = chatFailed + automationFailed;
  const blocked = chatBlocked + automationBlocked;
  const interrupted = chatInterrupted + automationInterrupted;
  const modelRows = [...models.values()].map<AiOperationsModelMetric>(({ sessions: sessionIds, ...metric }) => ({
    ...metric,
    sessionCount: sessionIds.size,
  })).sort((left, right) => right.taskCount - left.taskCount || right.calls - left.calls);
  const totalTasks = chatTasks + automationRuns.length;
  const runningSessions = sessions.filter((row) => normalizedStatus(row.status) === 'running').length;
  const inputTokens = modelRows.reduce((sum, item) => sum + item.inputTokens, 0);
  const outputTokens = modelRows.reduce((sum, item) => sum + item.outputTokens, 0);
  const userRows = [...users.values()]
    .map((item) => ({
      ...item,
      successRate: successRate(item.passed, item.failed, item.blocked),
      totalTasks: item.chatTasks + item.automationRuns,
    }))
    .sort((left, right) => right.totalTasks - left.totalTasks);

  return {
    generatedAt: now.toISOString(),
    incidents: incidents
      .sort((left, right) => right.time.localeCompare(left.time))
      .slice(0, 40),
    models: modelRows.slice(0, 30),
    overview: {
      activeUsers: users.size,
      automationRuns: automationRuns.length,
      averageDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
      blocked,
      chatTasks,
      enabledSchedules,
      failed,
      inputTokens,
      interrupted,
      modelCalls: modelRows.reduce((sum, item) => sum + item.calls, 0),
      outputTokens,
      p95DurationMs: percentile(durations, 0.95),
      passed,
      repairs,
      runningNow: Math.max(runningSessions, chatRunning) + automationRunning,
      successRate: successRate(passed, failed, blocked, interrupted),
      totalTasks,
    },
    rangeDays,
    runtime: {
      cpuWorkers: fileTextExtractionPoolSnapshot(),
      databaseWrites: databaseWriteQueueSnapshot(),
    },
    systems: [...systems.values()]
      .map((item) => ({ ...item, successRate: successRate(item.passed, item.failed, item.blocked) }))
      .sort((left, right) => right.totalTasks - left.totalTasks)
      .slice(0, 20),
    timezone: dashboardTimezone,
    trend: [...trend.values()],
    trendUserId,
    trendUsers: userRows.map(({ totalTasks: tasks, totalTokens: tokens, userId }) => ({
      totalTasks: tasks,
      totalTokens: tokens,
      userId,
    })),
    users: userRows.slice(0, 50),
  };
}
