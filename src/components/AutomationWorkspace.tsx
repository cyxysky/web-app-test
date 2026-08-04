'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Download,
  ExternalLink,
  Globe2,
  History,
  ListChecks,
  Loader2,
  MessageSquare,
  Moon,
  PanelLeft,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  StopCircle,
  Sun,
  Trash2,
  Workflow,
  X,
  XCircle,
} from 'lucide-react';
import { CustomSelect } from '@/components/CustomSelect';
import { LiquidGlassLoader } from '@/components/LiquidGlassLoader';
import { useI18n } from '@/i18n/I18nProvider';
import type { Language } from '@/i18n/translations';
import { readApiJson } from '@/lib/api-client';
import { artifactApiUrl } from '@/lib/artifacts';
import {
  readSidebarCollapsedPreference,
  writeSidebarCollapsedPreference,
} from '@/lib/sidebar-collapse';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';
import { useTheme } from '@/theme/ThemeProvider';

type AutomationFrequency = 'daily' | 'weekly';
type AutomationRunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'blocked' | 'interrupted';
type AutomationRunStepStatus = 'fixed' | 'repaired' | 'failed';
type AutomationDialog = 'case' | 'schedule' | 'deleteCase' | 'deleteSchedule' | null;
type Translate = (value: string, params?: Record<string, string | number>) => string;

type AutomationCase = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  targetUrl?: string;
  enabled: boolean;
  updatedAt?: string;
};

type AutomationSchedule = {
  id: string;
  name: string;
  caseId: string;
  caseName?: string;
  frequency: AutomationFrequency;
  time: string;
  weekday?: number;
  timezone: string;
  enabled: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
};

type AutomationRunStep = {
  index: number;
  name: string;
  status: AutomationRunStepStatus;
  actual: string;
  error?: string;
  fixedResult?: string;
  screenshotUrl?: string;
  screenshotCapturedAt?: string;
  screenshotError?: string;
  startedAt?: string;
  finishedAt?: string;
};

type AutomationRun = {
  id: string;
  caseId: string;
  caseName: string;
  scheduleId?: string;
  sessionId?: string;
  status: AutomationRunStatus;
  trigger: 'api' | 'manual' | 'retry' | 'schedule';
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  steps: AutomationRunStep[];
};

type CaseDraft = {
  name: string;
  description: string;
  prompt: string;
  targetUrl: string;
};

type ScheduleDraft = {
  name: string;
  caseId: string;
  frequency: AutomationFrequency;
  time: string;
  weekday: string;
  timezone: string;
};

const emptyCaseDraft: CaseDraft = {
  name: '',
  description: '',
  prompt: '',
  targetUrl: '',
};

const weekdayOptions = [
  { label: '周一', value: '1' },
  { label: '周二', value: '2' },
  { label: '周三', value: '3' },
  { label: '周四', value: '4' },
  { label: '周五', value: '5' },
  { label: '周六', value: '6' },
  { label: '周日', value: '0' },
];

const activeRunStatuses = new Set<AutomationRunStatus>(['queued', 'running']);

function asRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function textValue(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function recordText(record: Record<string, unknown> | undefined, keys: string[]) {
  if (!record) return '';
  for (const key of keys) {
    const value = textValue(record[key]);
    if (value) return value;
  }
  return '';
}

function collectionItems(payload: unknown, keys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  if (!record) return [];
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key];
  }
  if (Array.isArray(record.items)) return record.items;
  if (Array.isArray(record.data)) return record.data;
  const nestedData = asRecord(record.data);
  return nestedData ? collectionItems(nestedData, keys) : [];
}

function normalizeCase(value: unknown, t: Translate): AutomationCase | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const id = recordText(record, ['id', 'caseId']);
  if (!id) return undefined;
  const name = recordText(record, ['name', 'title']) || t('自动化用例 {id}', { id });
  const description = recordText(record, ['description', 'summary']);
  const prompt = recordText(record, ['prompt', 'instruction', 'task', 'content']) || description;
  return {
    id,
    name,
    description,
    prompt,
    targetUrl: recordText(record, ['targetUrl', 'url']) || undefined,
    enabled: record.enabled !== false && recordText(record, ['status']) !== 'disabled',
    updatedAt: recordText(record, ['updatedAt', 'createdAt']) || undefined,
  };
}

function normalizedFrequency(value: unknown): AutomationFrequency {
  const frequency = textValue(value).toLowerCase();
  return frequency.includes('week') || frequency.includes('周') ? 'weekly' : 'daily';
}

function normalizeSchedule(value: unknown, t: Translate): AutomationSchedule | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const recurrence = asRecord(record.recurrence);
  const id = recordText(record, ['id', 'scheduleId']);
  if (!id) return undefined;
  const rawWeekday = record.weekday ?? recurrence?.weekday ?? record.weekdays ?? recurrence?.weekdays;
  const firstWeekday = Array.isArray(rawWeekday) ? rawWeekday[0] : rawWeekday;
  const weekday = Number(firstWeekday);
  return {
    id,
    name: recordText(record, ['name', 'title']) || t('计划 {id}', { id }),
    caseId: recordText(record, ['caseId', 'automationCaseId']),
    caseName: recordText(record, ['caseName', 'automationCaseName']) || undefined,
    frequency: normalizedFrequency(record.frequency ?? record.cadence ?? record.recurrence ?? recurrence?.frequency),
    time: recordText(record, ['time', 'localTime', 'timeOfDay']) || recordText(recurrence, ['time', 'localTime']) || '09:00',
    weekday: Number.isInteger(weekday) && weekday >= 0 && weekday <= 6 ? weekday : undefined,
    timezone: recordText(record, ['timezone', 'timeZone']) || recordText(recurrence, ['timezone', 'timeZone']) || 'UTC',
    enabled: record.enabled !== false && recordText(record, ['status']) !== 'disabled',
    nextRunAt: recordText(record, ['nextRunAt', 'nextOccurrenceAt']) || undefined,
    lastRunAt: recordText(record, ['lastRunAt', 'lastOccurrenceAt']) || undefined,
  };
}

function normalizeRunStatus(value: unknown): AutomationRunStatus {
  const status = textValue(value).toLowerCase();
  if (status.includes('pass') || status.includes('success') || status.includes('complete')) return 'passed';
  if (status.includes('fail') || status.includes('error')) return 'failed';
  if (status.includes('block') || status.includes('attention') || status.includes('pause')) return 'blocked';
  if (status.includes('interrupt') || status.includes('cancel') || status.includes('skip')) return 'interrupted';
  if (status.includes('run') || status.includes('process') || status.includes('execut')) return 'running';
  return 'queued';
}

function normalizeRunSteps(value: unknown, t: Translate): AutomationRunStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const record = asRecord(item);
    if (!record) return [];
    const rawStatus = recordText(record, ['status']).toLowerCase();
    const status: AutomationRunStepStatus = rawStatus === 'repaired'
      ? 'repaired'
      : rawStatus === 'failed'
        ? 'failed'
        : 'fixed';
    const screenshotPath = recordText(record, ['screenshotPath', 'evidencePath']);
    return [{
      index: Number.isFinite(Number(record.operationIndex)) ? Number(record.operationIndex) : index,
      name: recordText(record, ['name']) || t('步骤 {index}', { index: index + 1 }),
      status,
      actual: recordText(record, ['actual']),
      error: recordText(record, ['error']) || undefined,
      fixedResult: recordText(record, ['fixedResult']) || undefined,
      screenshotUrl: recordText(record, ['screenshotUrl']) || artifactApiUrl(screenshotPath),
      screenshotCapturedAt: recordText(record, ['screenshotCapturedAt']) || undefined,
      screenshotError: recordText(record, ['screenshotError']) || undefined,
      startedAt: recordText(record, ['startedAt']) || undefined,
      finishedAt: recordText(record, ['finishedAt']) || undefined,
    }];
  });
}

function normalizeRun(value: unknown, t: Translate): AutomationRun | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const id = recordText(record, ['id', 'runId']);
  if (!id) return undefined;
  const caseRecord = asRecord(record.case);
  const triggerText = recordText(record, ['trigger', 'source']).toLowerCase();
  const trigger: AutomationRun['trigger'] = triggerText.includes('sched') || triggerText.includes('plan')
    ? 'schedule'
    : triggerText.includes('retry')
      ? 'retry'
      : triggerText.includes('api')
        ? 'api'
        : 'manual';
  return {
    id,
    caseId: recordText(record, ['caseId', 'automationCaseId']) || recordText(caseRecord, ['id']),
    caseName: recordText(record, ['caseName', 'automationCaseName', 'name', 'title'])
      || recordText(caseRecord, ['name', 'title'])
      || t('自动运行 {id}', { id }),
    scheduleId: recordText(record, ['scheduleId']) || undefined,
    sessionId: recordText(record, ['sessionId', 'browserChatSessionId']) || undefined,
    status: normalizeRunStatus(record.status),
    trigger,
    startedAt: recordText(record, ['startedAt', 'createdAt', 'claimedAt']) || undefined,
    finishedAt: recordText(record, ['finishedAt', 'endedAt', 'completedAt']) || undefined,
    error: recordText(record, ['error', 'message']) || undefined,
    steps: normalizeRunSteps(record.steps, t),
  };
}

function apiUrl(path: string, _userId: string, params: Record<string, string> = {}) {
  const search = new URLSearchParams(params);
  const query = search.toString();
  return `${withWebPilotBasePath(path)}${query ? `?${query}` : ''}`;
}

async function fetchCollection<T>(
  path: string,
  userId: string,
  keys: string[],
  normalize: (value: unknown) => T | undefined,
  fallback: string,
) {
  const response = await fetch(apiUrl(path, userId), { cache: 'no-store' });
  const payload = await readApiJson<unknown>(response, fallback);
  return collectionItems(payload, keys).map(normalize).filter((item): item is T => Boolean(item));
}

function formatDateTime(value: string | undefined, language: Language) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language === 'en' ? 'en-GB' : 'zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatTime(value: string | undefined, language: Language) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(language === 'en' ? 'en-GB' : 'zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function formatDuration(t: Translate, startedAt?: string, finishedAt?: string, fallbackMs?: number) {
  const started = startedAt ? new Date(startedAt).getTime() : Number.NaN;
  const finished = finishedAt ? new Date(finishedAt).getTime() : Number.NaN;
  const milliseconds = Number.isFinite(started) && Number.isFinite(finished)
    ? Math.max(0, finished - started)
    : fallbackMs;
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return '';
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) {
    return t('{seconds} 秒', { seconds: (milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0) });
  }
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1_000);
  return t('{minutes} 分 {seconds} 秒', { minutes, seconds });
}

function statusLabel(status: AutomationRunStatus, t: Translate) {
  const labels: Record<AutomationRunStatus, string> = {
    queued: '排队中',
    running: '执行中',
    passed: '已完成',
    failed: '失败',
    blocked: '需处理',
    interrupted: '已中止',
  };
  return t(labels[status]);
}

function triggerLabel(trigger: AutomationRun['trigger'], t: Translate) {
  const labels: Record<AutomationRun['trigger'], string> = {
    api: 'API',
    manual: '手动',
    retry: '重试',
    schedule: '计划',
  };
  return t(labels[trigger]);
}

function scheduleDescription(schedule: AutomationSchedule, t: Translate) {
  const weekday = schedule.weekday !== undefined
    ? t(weekdayOptions.find((item) => Number(item.value) === schedule.weekday)?.label || '周一')
    : t('周一');
  return schedule.frequency === 'weekly'
    ? t('每周 {weekday} {time}', { weekday, time: schedule.time })
    : t('每日 {time}', { time: schedule.time });
}

function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Hong_Kong';
  } catch {
    return 'Asia/Hong_Kong';
  }
}

function compactText(value: string, maxLength = 180) {
  const normalized = value
    .replace(/\\[nrt]/g, ' ')
    .replace(/<[^>]{0,200}>/g, ' ')
    .replace(/(^|\s)#{1,6}\s+/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function parseNestedJson(value: unknown, depth = 0): unknown {
  if (depth > 3 || typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || !['{', '[', '"'].includes(trimmed[0])) return value;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === 'string' ? parseNestedJson(parsed, depth + 1) : parsed;
  } catch {
    return value;
  }
}

function numericValue(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function summarizePayload(value: unknown, t: Translate, depth = 0): { elapsedMs?: number; text: string } {
  if (depth > 4) return { text: t('工具结果已记录') };
  const parsed = parseNestedJson(value);
  if (typeof parsed === 'string') {
    const compact = compactText(parsed);
    const looksLikeRawPage = /(?:\[page-state\]|domChanges|<html|uid=|"(?:epoch|added|removed|tabs|images)"\s*:)/i.test(parsed);
    return { text: looksLikeRawPage ? t('页面状态已更新，详细结果已收起') : compact };
  }
  if (Array.isArray(parsed)) return { text: t('返回 {count} 项结果', { count: parsed.length }) };
  const record = asRecord(parsed);
  if (!record) return { text: t('步骤已完成') };

  const elapsedMs = numericValue(record.elapsedMs);
  const error = recordText(record, ['error']);
  if (error && error !== 'null') return { elapsedMs, text: t('错误：{error}', { error: compactText(error) }) };

  const parts: string[] = [];
  const finalPage = asRecord(record.finalPage);
  if (finalPage) {
    const title = recordText(finalPage, ['title']);
    const url = recordText(finalPage, ['url']);
    if (title) parts.push(t('到达“{title}”', { title: compactText(title, 72) }));
    if (url) parts.push(compactText(url, 110));
  }

  const directSummary = recordText(record, ['summary', 'message', 'description']);
  if (directSummary) parts.push(compactText(directSummary, 140));

  if (finalPage && parts.length) {
    return { elapsedMs, text: compactText([...new Set(parts)].join(' · ')) };
  }

  if (record.result !== undefined) {
    const nested = summarizePayload(record.result, t, depth + 1);
    if (nested.text && ![t('步骤已完成'), t('工具结果已记录')].includes(nested.text)) parts.push(nested.text);
    return {
      elapsedMs: elapsedMs ?? nested.elapsedMs,
      text: compactText([...new Set(parts)].join(' · ')) || (record.ok === true ? t('工具执行成功') : nested.text),
    };
  }

  const url = recordText(record, ['url']);
  const title = recordText(record, ['title']);
  if (!finalPage && title) parts.push(compactText(title, 72));
  if (!finalPage && url) parts.push(compactText(url, 110));
  if (!parts.length && record.ok === true) parts.push(t('工具执行成功'));
  return { elapsedMs, text: compactText([...new Set(parts)].join(' · ')) || t('步骤已完成') };
}

function summarizeStep(step: AutomationRunStep, t: Translate) {
  if (step.actual) return summarizePayload(step.actual, t);
  if (step.fixedResult) return summarizePayload(step.fixedResult, t);
  if (step.error) return { text: t('错误：{error}', { error: compactText(step.error) }) };
  return { text: t('步骤已完成') };
}

function RunTimeline({ language, steps, t }: { language: Language; steps: AutomationRunStep[]; t: Translate }) {
  if (!steps.length) {
    return <div className="automation-trace-empty">{t('执行轨迹将在任务开始后实时出现。')}</div>;
  }
  return (
    <ol className="automation-timeline">
      {steps.map((step, position) => {
        const summary = summarizeStep(step, t);
        const duration = formatDuration(t, step.startedAt, step.finishedAt, summary.elapsedMs);
        const finalVerification = step.name === 'finalVerification';
        const title = finalVerification ? t('AI 最终验收') : step.name;
        const phaseLabel = finalVerification
          ? (step.status === 'failed' ? t('验收失败') : t('AI 验收'))
          : step.status === 'repaired'
            ? t('AI 已修复')
            : step.status === 'failed'
              ? t('执行失败')
              : t('固定回放');
        return (
          <li className={`automation-timeline-item is-${step.status}`} key={`${step.index}:${step.name}:${position}`}>
            <span className="automation-timeline-marker" aria-hidden="true">
              {step.status === 'repaired'
                ? <Sparkles size={14} />
                : step.status === 'failed'
                  ? <XCircle size={14} />
                  : <CheckCircle2 size={14} />}
            </span>
            <details className="automation-timeline-content">
              <summary className="automation-timeline-summary">
                <span className="automation-timeline-heading">
                  <strong>{title}</strong>
                  <span>{phaseLabel}</span>
                </span>
                {(step.startedAt || duration) ? (
                  <span className="automation-timeline-meta">
                    {step.startedAt ? <span>{formatTime(step.startedAt, language)}</span> : null}
                    {duration ? <span>{t('耗时 {duration}', { duration })}</span> : null}
                  </span>
                ) : null}
                <ChevronRight className="automation-timeline-toggle" size={15} aria-hidden="true" />
              </summary>
              <div className="automation-timeline-details">
                <p>{summary.text}</p>
                {step.screenshotUrl ? (
                  <figure className="automation-step-evidence">
                    <a href={step.screenshotUrl} rel="noreferrer" target="_blank" title={t('查看 {title} 完成截图', { title })}>
                      <img alt={t('{title} 完成后的页面截图', { title })} loading="lazy" src={step.screenshotUrl} />
                    </a>
                    <figcaption>
                      <span>{t('步骤完成截图')}</span>
                      {step.screenshotCapturedAt ? <time>{formatTime(step.screenshotCapturedAt, language)}</time> : null}
                    </figcaption>
                  </figure>
                ) : step.screenshotError ? (
                  <p className="automation-step-evidence-error">{t('截图失败：{error}', { error: compactText(step.screenshotError, 120) })}</p>
                ) : null}
              </div>
            </details>
          </li>
        );
      })}
    </ol>
  );
}

export function AutomationWorkspace({
  defaultUserId = '1',
  initialCaseId = '',
  initialSidebarCollapsed = false,
}: {
  defaultUserId?: string;
  initialCaseId?: string;
  initialSidebarCollapsed?: boolean;
}) {
  const userId = defaultUserId.trim() || '1';
  const { mode: themeMode, toggleMode } = useTheme();
  const { language, t } = useI18n();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed);
  const [cases, setCases] = useState<AutomationCase[]>([]);
  const [schedules, setSchedules] = useState<AutomationSchedule[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [caseDraft, setCaseDraft] = useState<CaseDraft>(emptyCaseDraft);
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>(() => ({
    name: '',
    caseId: initialCaseId,
    frequency: 'daily',
    time: '09:00',
    weekday: '1',
    timezone: browserTimezone(),
  }));
  const [selectedCaseId, setSelectedCaseId] = useState(initialCaseId);
  const [caseFilter, setCaseFilter] = useState('');
  const [openRunIds, setOpenRunIds] = useState<string[]>([]);
  const [dialog, setDialog] = useState<AutomationDialog>(null);
  const [loading, setLoading] = useState(true);
  const [savingCase, setSavingCase] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [runningCaseId, setRunningCaseId] = useState<string | null>(null);
  const [abortingRunId, setAbortingRunId] = useState<string | null>(null);
  const [deletingCaseId, setDeletingCaseId] = useState<string | null>(null);
  const [deletingScheduleId, setDeletingScheduleId] = useState<string | null>(null);
  const [casePendingDelete, setCasePendingDelete] = useState<AutomationCase | null>(null);
  const [schedulePendingDelete, setSchedulePendingDelete] = useState<AutomationSchedule | null>(null);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');

  const loadAll = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [nextCases, nextSchedules, nextRuns] = await Promise.all([
        fetchCollection('/api/automation/cases', userId, ['cases'], (value) => normalizeCase(value, t), t('加载自动化用例失败')),
        fetchCollection('/api/automation/schedules', userId, ['schedules'], (value) => normalizeSchedule(value, t), t('加载执行计划失败')),
        fetchCollection('/api/automation/runs', userId, ['runs'], (value) => normalizeRun(value, t), t('加载运行历史失败')),
      ]);
      setCases(nextCases);
      setSchedules(nextSchedules);
      setRuns(nextRuns);
      setError('');
    } catch (loadError) {
      if (!silent) setError(loadError instanceof Error ? t(loadError.message) : t('加载自动化数据失败'));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [t, userId]);

  useLayoutEffect(() => {
    const storedSidebarCollapsed = readSidebarCollapsedPreference(initialSidebarCollapsed);
    setSidebarCollapsed(storedSidebarCollapsed);
    writeSidebarCollapsedPreference(storedSidebarCollapsed);
  }, [initialSidebarCollapsed]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    const timer = window.setInterval(() => void loadAll(true), 12_000);
    return () => window.clearInterval(timer);
  }, [loadAll]);

  useEffect(() => {
    if (!cases.length) return;
    setScheduleDraft((current) => (
      cases.some((item) => item.id === current.caseId)
        ? current
        : { ...current, caseId: cases[0].id }
    ));
    setSelectedCaseId((current) => (
      cases.some((item) => item.id === current) ? current : cases[0].id
    ));
  }, [cases]);

  useEffect(() => {
    if (!dialog) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || savingCase || savingSchedule || deletingCaseId || deletingScheduleId) return;
      setDialog(null);
      setCasePendingDelete(null);
      setSchedulePendingDelete(null);
      setFormError('');
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [deletingCaseId, deletingScheduleId, dialog, savingCase, savingSchedule]);

  useEffect(() => {
    if (dialog !== 'schedule') return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById('automation-schedule-case')?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [dialog]);

  useEffect(() => {
    if (!initialCaseId || loading) return;
    window.requestAnimationFrame(() => {
      document.getElementById(`automation-case-${initialCaseId}`)?.scrollIntoView({ block: 'start' });
    });
  }, [initialCaseId, loading]);

  const caseNameById = useMemo(() => new Map(cases.map((item) => [item.id, item.name])), [cases]);
  const schedulesByCase = useMemo(() => {
    const grouped = new Map<string, AutomationSchedule[]>();
    for (const schedule of schedules) grouped.set(schedule.caseId, [...(grouped.get(schedule.caseId) || []), schedule]);
    return grouped;
  }, [schedules]);
  const runsByCase = useMemo(() => {
    const grouped = new Map<string, AutomationRun[]>();
    const sorted = [...runs].sort((left, right) => {
      const leftTime = new Date(left.startedAt || left.finishedAt || 0).getTime();
      const rightTime = new Date(right.startedAt || right.finishedAt || 0).getTime();
      return rightTime - leftTime;
    });
    for (const run of sorted) grouped.set(run.caseId, [...(grouped.get(run.caseId) || []), run]);
    return grouped;
  }, [runs]);

  function beginMutation() {
    setError('');
    setNotice('');
  }

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      writeSidebarCollapsedPreference(next);
      return next;
    });
  }

  function openCaseDialog() {
    setFormError('');
    setDialog('case');
  }

  function openScheduleDialog(caseId?: string) {
    setFormError('');
    if (caseId) setScheduleDraft((current) => ({ ...current, caseId }));
    setDialog('schedule');
  }

  function closeDialog() {
    if (savingCase || savingSchedule || deletingCaseId || deletingScheduleId) return;
    setDialog(null);
    setCasePendingDelete(null);
    setSchedulePendingDelete(null);
    setFormError('');
  }

  function openDeleteCaseDialog(automationCase: AutomationCase) {
    setCasePendingDelete(automationCase);
    setDialog('deleteCase');
  }

  function openDeleteScheduleDialog(schedule: AutomationSchedule) {
    setSchedulePendingDelete(schedule);
    setDialog('deleteSchedule');
  }

  async function createCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = caseDraft.name.trim();
    const prompt = caseDraft.prompt.trim();
    const targetUrl = caseDraft.targetUrl.trim();
    if (!name || !prompt) {
      setFormError(t('请填写用例名称和执行指令。'));
      return;
    }
    if (targetUrl) {
      try {
        const parsed = new URL(targetUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
      } catch {
        setFormError(t('目标网址需要是完整的 http:// 或 https:// 地址。'));
        return;
      }
    }
    beginMutation();
    setFormError('');
    setSavingCase(true);
    try {
      const response = await fetch(apiUrl('/api/automation/cases', userId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: name,
          description: caseDraft.description.trim(),
          targetUrl,
          instruction: prompt,
        }),
      });
      const payload = await readApiJson<unknown>(response, t('创建自动化用例失败'));
      const payloadRecord = asRecord(payload);
      const created = normalizeCase(payloadRecord?.automationCase ?? payloadRecord?.case ?? payload, t);
      setCaseDraft(emptyCaseDraft);
      setDialog(null);
      setNotice(t('已创建用例“{name}”。', { name }));
      if (created) setSelectedCaseId(created.id);
      await loadAll(true);
    } catch (mutationError) {
      setFormError(mutationError instanceof Error ? t(mutationError.message) : t('创建自动化用例失败'));
    } finally {
      setSavingCase(false);
    }
  }

  async function runCase(item: AutomationCase) {
    beginMutation();
    setRunningCaseId(item.id);
    try {
      const response = await fetch(apiUrl(`/api/automation/cases/${encodeURIComponent(item.id)}/runs`, userId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const payload = await readApiJson<unknown>(response, t('启动自动化用例失败'));
      const payloadRecord = asRecord(payload);
      const createdRun = normalizeRun(payloadRecord?.run ?? payload, t);
      setNotice(t('“{name}”已进入执行队列。', { name: item.name }));
      setSelectedCaseId(item.id);
      if (createdRun) setOpenRunIds((current) => current.includes(createdRun.id) ? current : [...current, createdRun.id]);
      await loadAll(true);
    } catch (mutationError) {
      setError(mutationError instanceof Error ? t(mutationError.message) : t('启动自动化用例失败'));
    } finally {
      setRunningCaseId(null);
    }
  }

  async function abortRun(run: AutomationRun) {
    beginMutation();
    setAbortingRunId(run.id);
    try {
      const response = await fetch(apiUrl(`/api/automation/runs/${encodeURIComponent(run.id)}`, userId), {
        method: 'DELETE',
      });
      await readApiJson<unknown>(response, t('中止自动化运行失败'));
      setNotice(t('已发送中止指令。'));
      await loadAll(true);
    } catch (mutationError) {
      setError(mutationError instanceof Error ? t(mutationError.message) : t('中止自动化运行失败'));
    } finally {
      setAbortingRunId(null);
    }
  }

  async function createSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!scheduleDraft.caseId) {
      setFormError(t('请先选择一个自动化用例。'));
      return;
    }
    try {
      new Intl.DateTimeFormat(language === 'en' ? 'en-GB' : 'zh-CN', { timeZone: scheduleDraft.timezone.trim() }).format(new Date());
    } catch {
      setFormError(t('请输入有效的 IANA 时区，例如 Asia/Hong_Kong。'));
      return;
    }
    const selectedCaseName = caseNameById.get(scheduleDraft.caseId) || t('自动化用例');
    const name = scheduleDraft.name.trim() || t('{caseName} · {frequency}', {
      caseName: selectedCaseName,
      frequency: t(scheduleDraft.frequency === 'daily' ? '每日' : '每周'),
    });
    beginMutation();
    setFormError('');
    setSavingSchedule(true);
    try {
      const response = await fetch(apiUrl('/api/automation/schedules', userId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: name,
          caseId: scheduleDraft.caseId,
          recurrence: scheduleDraft.frequency,
          time: scheduleDraft.time,
          weekdays: scheduleDraft.frequency === 'weekly' ? [Number(scheduleDraft.weekday)] : [],
          timezone: scheduleDraft.timezone.trim(),
          enabled: true,
          overlap: 'skip',
          misfire: 'run-once',
        }),
      });
      await readApiJson<unknown>(response, t('创建执行计划失败'));
      setScheduleDraft((current) => ({ ...current, name: '' }));
      setDialog(null);
      setNotice(t('已创建计划“{name}”。', { name }));
      setSelectedCaseId(scheduleDraft.caseId);
      await loadAll(true);
    } catch (mutationError) {
      setFormError(mutationError instanceof Error ? t(mutationError.message) : t('创建执行计划失败'));
    } finally {
      setSavingSchedule(false);
    }
  }

  async function deleteSchedule() {
    const schedule = schedulePendingDelete;
    if (!schedule) return;
    beginMutation();
    setDeletingScheduleId(schedule.id);
    try {
      const response = await fetch(apiUrl('/api/automation/schedules', userId, { id: schedule.id }), {
        method: 'DELETE',
      });
      await readApiJson<unknown>(response, t('删除执行计划失败'));
      setNotice(t('已删除计划“{name}”。', { name: schedule.name }));
      setDialog(null);
      setSchedulePendingDelete(null);
      await loadAll(true);
    } catch (mutationError) {
      setError(mutationError instanceof Error ? t(mutationError.message) : t('删除执行计划失败'));
    } finally {
      setDeletingScheduleId(null);
    }
  }

  async function deleteCase() {
    const automationCase = casePendingDelete;
    if (!automationCase) return;
    const deletedIndex = cases.findIndex((item) => item.id === automationCase.id);
    const replacementCase = cases[deletedIndex + 1] || cases[deletedIndex - 1];
    const nextSelectedCaseId = selectedCaseId === automationCase.id
      ? replacementCase?.id || ''
      : selectedCaseId;

    beginMutation();
    setDeletingCaseId(automationCase.id);
    try {
      const response = await fetch(apiUrl(`/api/automation/cases/${encodeURIComponent(automationCase.id)}`, userId), {
        method: 'DELETE',
      });
      await readApiJson<unknown>(response, t('删除自动化用例失败'));
      setSelectedCaseId(nextSelectedCaseId);
      setScheduleDraft((current) => current.caseId === automationCase.id
        ? { ...current, caseId: replacementCase?.id || '' }
        : current);
      setOpenRunIds((current) => current.filter((runId) => (
        !(runsByCase.get(automationCase.id) || []).some((run) => run.id === runId)
      )));
      setDialog(null);
      setCasePendingDelete(null);
      setNotice(t('已删除用例“{name}”。', { name: automationCase.name }));
      await loadAll(true);
    } catch (mutationError) {
      setError(mutationError instanceof Error ? t(mutationError.message) : t('删除自动化用例失败'));
    } finally {
      setDeletingCaseId(null);
    }
  }

  const selectedCase = cases.find((item) => item.id === selectedCaseId) || cases[0];
  const filteredCases = useMemo(() => {
    const query = caseFilter.trim().toLocaleLowerCase();
    if (!query) return cases;
    return cases.filter((item) => (
      [item.name, item.description, item.prompt, item.targetUrl]
        .filter(Boolean)
        .some((value) => value?.toLocaleLowerCase().includes(query))
    ));
  }, [caseFilter, cases]);
  const selectedCaseSchedules = selectedCase ? schedulesByCase.get(selectedCase.id) || [] : [];
  const selectedCaseRuns = selectedCase ? runsByCase.get(selectedCase.id) || [] : [];
  const selectedCaseActiveRuns = selectedCaseRuns.filter((run) => activeRunStatuses.has(run.status));

  return (
    <section className={sidebarCollapsed ? 'browser-chat-layout sidebar-collapsed automation-layout' : 'browser-chat-layout automation-layout'}>
      <aside className="browser-chat-sidebar automation-sidebar">
        <div className="browser-chat-brand">
          <strong>WebPilot</strong>
          <button
            aria-label={t(sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏')}
            className="ui-icon-button"
            onClick={toggleSidebar}
            title={t(sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏')}
            type="button"
          >
            <PanelLeft size={17} />
          </button>
        </div>

        <nav className="browser-chat-nav" aria-label={t('工作模式')}>
          <Link
            aria-label={t('对话模式')}
            className="browser-chat-nav-item"
            href="/browser-chat"
            title={t('对话模式')}
          >
            <MessageSquare size={17} />
            <span>{t('对话模式')}</span>
          </Link>
          <Link
            aria-current="page"
            aria-label={t('自动化')}
            className="browser-chat-nav-item active"
            href="/automation"
            title={t('自动化')}
          >
            <Workflow size={17} />
            <span>{t('自动化')}</span>
          </Link>
          <Link
            aria-label={t('设置')}
            className="browser-chat-nav-item"
            href="/settings"
            title={t('设置')}
          >
            <Settings size={17} />
            <span>{t('设置')}</span>
          </Link>
        </nav>

        <section className="browser-chat-sidebar-section browser-chat-recent-section automation-case-history">
          <div className="browser-chat-recent-header automation-case-history-header">
            <h2>{t('用例')}</h2>
            <span aria-label={t('共 {count} 个用例', { count: cases.length })} className="automation-case-history-total">
              {cases.length}
            </span>
          </div>
          <label className="domain-list-search browser-chat-history-filter">
            <Search aria-hidden="true" size={16} />
            <input
              aria-label={t('筛选用例历史')}
              className="domain-list-search-input"
              onChange={(event) => setCaseFilter(event.currentTarget.value)}
              placeholder={t('筛选用例')}
              type="search"
              value={caseFilter}
            />
            {caseFilter ? (
              <button
                aria-label={t('清空用例筛选')}
                onClick={() => setCaseFilter('')}
                title={t('清空筛选')}
                type="button"
              >
                <X size={14} />
              </button>
            ) : null}
          </label>
          {filteredCases.length ? (
            <ol className="automation-case-history-list">
              {filteredCases.map((item) => {
                const itemRuns = runsByCase.get(item.id) || [];
                const itemLatestRun = itemRuns[0];
                const itemActiveRuns = itemRuns.filter((run) => activeRunStatuses.has(run.status));
                const active = item.id === selectedCase?.id;
                return (
                  <li key={item.id}>
                    <div
                      className={active ? 'automation-case-history-item active' : 'automation-case-history-item'}
                      id={`automation-case-${item.id}`}
                    >
                      <button
                        aria-current={active ? 'true' : undefined}
                        aria-label={item.name}
                        className="automation-case-history-open"
                        onClick={() => setSelectedCaseId(item.id)}
                        title={item.name}
                        type="button"
                      >
                        {sidebarCollapsed ? (
                          <ListChecks
                            aria-hidden="true"
                            className={itemActiveRuns.length
                              ? 'automation-case-history-icon is-running'
                              : item.enabled
                                ? 'automation-case-history-icon is-enabled'
                                : 'automation-case-history-icon'}
                            size={17}
                          />
                        ) : (
                          <span
                            aria-hidden="true"
                            className={itemActiveRuns.length ? 'automation-state-dot is-running' : item.enabled ? 'automation-state-dot is-enabled' : 'automation-state-dot'}
                          />
                        )}
                        <span className="automation-case-history-copy">
                          <strong>{item.name}</strong>
                          <small>
                            {itemActiveRuns.length
                              ? t('{count} 个任务执行中', { count: itemActiveRuns.length })
                              : itemLatestRun
                                ? t('{status} · {time}', {
                                  status: statusLabel(itemLatestRun.status, t),
                                  time: formatDateTime(itemLatestRun.startedAt, language),
                                })
                                : t('尚未运行')}
                          </small>
                        </span>
                      </button>
                      <span aria-label={t('{count} 次运行', { count: itemRuns.length })} className="automation-case-history-count">{itemRuns.length}</span>
                      <button
                        aria-label={t('删除用例“{name}”', { name: item.name })}
                        className="ui-icon-button ui-icon-button--danger automation-case-history-delete browser-chat-collapsed-delete"
                        disabled={Boolean(deletingCaseId)}
                        onClick={() => openDeleteCaseDialog(item)}
                        title={t('删除用例')}
                        type="button"
                      >
                        {sidebarCollapsed ? <X size={12} /> : <Trash2 size={14} />}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : cases.length ? (
            <p className="browser-chat-history-filter-empty">{t('没有匹配的用例')}</p>
          ) : (
            <p className="browser-chat-history-filter-empty">{t('暂无用例')}</p>
          )}
        </section>

        <div className="browser-chat-sidebar-footer">
          <button
            aria-label={t(themeMode === 'dark' ? '切换到浅色模式' : '切换到深色模式')}
            className="browser-chat-theme-toggle"
            onClick={toggleMode}
            title={t(themeMode === 'dark' ? '浅色模式' : '深色模式')}
            type="button"
          >
            {themeMode === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            <span>{t(themeMode === 'dark' ? '浅色模式' : '深色模式')}</span>
          </button>
        </div>
      </aside>

      <main className="browser-chat-main automation-main">
        <div className="automation-content" aria-busy={loading}>
          <header className="automation-page-header">
            <div>
              <h1>{t('自动化')}</h1>
              <p>{t('让对话中的工具操作按计划运行，失败时由 AI 自动修复并完成验收。')}</p>
            </div>
            <div className="automation-header-actions">
              <button className="automation-icon-action" onClick={openCaseDialog} type="button">
                <Plus size={16} />
                {t('新建用例')}
              </button>
              <button className="automation-icon-action" disabled={loading} onClick={() => void loadAll()} type="button">
                <RefreshCw className={loading ? 'spin' : undefined} size={16} />
                {t('刷新')}
              </button>
            </div>
          </header>

          <div className="automation-feedback" aria-live="polite">
            {error ? <p className="error">{error}</p> : null}
            {notice ? <p className="automation-notice">{notice}</p> : null}
          </div>

          {loading && !cases.length ? (
            <section className="automation-loading-state">
              <LiquidGlassLoader />
              <div>
                <h2>{t('正在加载自动化任务')}</h2>
                <p>{t('同步用例、执行计划与运行状态。')}</p>
              </div>
            </section>
          ) : cases.length ? (
            <section className="automation-case-section" aria-label={t('自动化用例')}>
              <div className="automation-case-workbench">
                {selectedCase ? (
                  <article className="automation-case-detail">
                    <header className="automation-case-detail-header">
                      <div className="automation-case-detail-heading">
                        <div className="automation-case-status-row">
                          <span className={selectedCase.enabled ? 'automation-case-status is-enabled' : 'automation-case-status'}>
                            <span aria-hidden="true" />
                            {t(selectedCase.enabled ? '已启用' : '已停用')}
                          </span>
                          {selectedCaseActiveRuns.length ? (
                            <span className="automation-case-status is-running">
                              <Loader2 className="spin" size={12} />
                              {t('{count} 个执行中', { count: selectedCaseActiveRuns.length })}
                            </span>
                          ) : null}
                        </div>
                        <h2>{selectedCase.name}</h2>
                        <p>{selectedCase.description || selectedCase.prompt || t('暂无用例说明')}</p>
                      </div>
                      <div className="automation-case-actions">
                        <Link
                          className="automation-icon-action"
                          download
                          href={apiUrl(`/api/automation/cases/${encodeURIComponent(selectedCase.id)}`, userId, { download: '1' })}
                          title={t('导出用例')}
                        >
                          <Download size={16} />
                          <span>{t('导出')}</span>
                        </Link>
                        <button
                          className="automation-icon-action automation-run-action"
                          disabled={runningCaseId === selectedCase.id}
                          onClick={() => void runCase(selectedCase)}
                          type="button"
                        >
                          {runningCaseId === selectedCase.id ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
                          <span>{t('立即运行')}</span>
                        </button>
                      </div>
                    </header>

                    <div className="automation-case-context">
                      {selectedCase.targetUrl ? (
                        <a href={selectedCase.targetUrl} rel="noreferrer" target="_blank" title={selectedCase.targetUrl}>
                          <Globe2 size={14} />
                          <span>{selectedCase.targetUrl}</span>
                        </a>
                      ) : <span>{t('未设置目标页面')}</span>}
                      <span><Clock3 size={13} /> {t('更新于 {time}', { time: formatDateTime(selectedCase.updatedAt, language) })}</span>
                    </div>

                    {selectedCase.prompt
                      && selectedCase.prompt !== selectedCase.description
                      && selectedCase.prompt !== selectedCase.name ? (
                        <div className="automation-case-instruction">
                          <span>{t('执行目标')}</span>
                          <p>{selectedCase.prompt}</p>
                        </div>
                      ) : null}

                    <div className="automation-case-detail-sections">
                      <section className="automation-case-subsection">
                        <div className="automation-subsection-heading">
                          <div>
                            <CalendarDays size={15} />
                            <h3>{t('执行计划')}</h3>
                          </div>
                          <button
                            aria-label={t('为 {name} 新建计划', { name: selectedCase.name })}
                            className="automation-icon-action"
                            onClick={() => openScheduleDialog(selectedCase.id)}
                            type="button"
                          >
                            <Plus size={15} />
                            {t('新建计划')}
                          </button>
                        </div>
                        {selectedCaseSchedules.length ? (
                          <div className="automation-schedule-list">
                            {selectedCaseSchedules.map((schedule) => (
                              <div className="automation-schedule-row" key={schedule.id}>
                                <span className={schedule.enabled ? 'automation-state-dot is-enabled' : 'automation-state-dot'} aria-hidden="true" />
                                <div>
                                  <strong>{schedule.name}</strong>
                                  <p>{scheduleDescription(schedule, t)} · {schedule.timezone}</p>
                                </div>
                                <span className="automation-next-run">
                                  <Clock3 size={13} />
                                  {t('下次 {time}', { time: formatDateTime(schedule.nextRunAt, language) })}
                                </span>
                                <button
                                  aria-label={t('删除计划 {name}', { name: schedule.name })}
                                  className="automation-icon-action is-danger"
                                  disabled={Boolean(deletingScheduleId)}
                                  onClick={() => openDeleteScheduleDialog(schedule)}
                                  title={t('删除计划')}
                                  type="button"
                                >
                                  {deletingScheduleId === schedule.id ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="automation-inline-empty">{t('尚未设置自动执行计划。')}</div>
                        )}
                      </section>

                      <section className="automation-case-subsection automation-run-history">
                        <div className="automation-subsection-heading">
                          <div>
                            <History size={15} />
                            <h3>{t('运行历史')}</h3>
                          </div>
                          <span>{t('{count} 次', { count: selectedCaseRuns.length })}</span>
                        </div>
                        {selectedCaseRuns.length ? (
                          <div className="automation-run-list">
                            {selectedCaseRuns.map((run) => {
                              const runExpanded = openRunIds.includes(run.id);
                              const active = activeRunStatuses.has(run.status);
                              const repairedSteps = run.steps.filter((step) => step.status === 'repaired' && step.name !== 'finalVerification').length;
                              const duration = formatDuration(t, run.startedAt, run.finishedAt);
                              return (
                                <article className={`automation-run-item automation-run-state-${run.status}`} key={run.id}>
                                  <div className="automation-run-summary">
                                    <button
                                      aria-expanded={runExpanded}
                                      className="automation-run-expand"
                                      onClick={() => setOpenRunIds((current) => current.includes(run.id) ? [] : [run.id])}
                                      type="button"
                                    >
                                      {runExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                      <span className="automation-run-status-dot" aria-hidden="true" />
                                      <span className="automation-run-copy">
                                        <strong>{statusLabel(run.status, t)}</strong>
                                        <small>
                                          {run.error
                                            ? compactText(t(run.error), 72)
                                            : t(repairedSteps ? '{steps} 步 · AI 修复 {repairs} 次' : '{steps} 步', {
                                              steps: run.steps.length,
                                              repairs: repairedSteps,
                                            })}
                                        </small>
                                      </span>
                                    </button>
                                    <div className="automation-run-meta">
                                      {duration ? <span>{duration}</span> : null}
                                      <span>{triggerLabel(run.trigger, t)}</span>
                                      <span><Clock3 size={13} /> {formatDateTime(run.startedAt, language)}</span>
                                    </div>
                                    <div className="automation-run-item-actions">
                                      {active ? (
                                        <button
                                          className="automation-icon-action is-danger"
                                          disabled={abortingRunId === run.id}
                                          onClick={() => void abortRun(run)}
                                          type="button"
                                        >
                                          {abortingRunId === run.id ? <Loader2 className="spin" size={15} /> : <StopCircle size={15} />}
                                          {t('中止')}
                                        </button>
                                      ) : null}
                                      {run.sessionId ? (
                                        <Link
                                          aria-label={t('打开关联对话')}
                                          className="automation-icon-action"
                                          href={`/browser-chat?sessionId=${encodeURIComponent(run.sessionId)}`}
                                          title={t('打开关联对话')}
                                        >
                                          <ExternalLink size={15} />
                                        </Link>
                                      ) : null}
                                    </div>
                                  </div>
                                  {runExpanded ? (
                                    <div className="automation-run-trace">
                                      <div className="automation-trace-heading">
                                        <h4>{t('执行轨迹')}</h4>
                                        <span>{run.finishedAt
                                          ? t('完成于 {time}', { time: formatDateTime(run.finishedAt, language) })
                                          : t('实时更新中')}</span>
                                      </div>
                                      <RunTimeline language={language} steps={run.steps} t={t} />
                                    </div>
                                  ) : null}
                                </article>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="automation-inline-empty">{t('还没有运行记录，点击“立即运行”开始第一次执行。')}</div>
                        )}
                      </section>
                    </div>
                  </article>
                ) : null}
              </div>
            </section>
          ) : (
            <section className="automation-empty-state">
              <Workflow size={24} />
              <h2>{t('还没有自动化用例')}</h2>
              <p>{t('从对话中的工具执行生成用例，或在这里新建一条执行指令。')}</p>
              <button className="automation-icon-action" onClick={openCaseDialog} type="button">
                <Plus size={16} />
                {t('新建用例')}
              </button>
            </section>
          )}
        </div>
      </main>

      {dialog === 'case' ? (
        <div className="ui-modal-overlay" onMouseDown={(event) => event.currentTarget === event.target && closeDialog()} role="presentation">
          <form
            aria-labelledby="automation-case-dialog-title"
            aria-modal="true"
            className="ui-modal automation-dialog"
            onSubmit={createCase}
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header className="ui-modal-header">
              <div>
                <h2 id="automation-case-dialog-title">{t('新建自动化用例')}</h2>
                <p>{t('描述浏览器需要完成的任务和验收目标。')}</p>
              </div>
              <button aria-label={t('关闭')} className="ui-icon-button" disabled={savingCase} onClick={closeDialog} type="button">
                <X size={17} />
              </button>
            </header>
            <div className="ui-modal-body automation-dialog-fields">
              {formError ? <p className="error">{formError}</p> : null}
              <div className="field modal-field">
                <label htmlFor="automation-case-name">{t('用例名称')}</label>
                <input
                  autoFocus
                  className="input"
                  id="automation-case-name"
                  maxLength={160}
                  onChange={(event) => setCaseDraft((current) => ({ ...current, name: event.target.value }))}
                  placeholder={t('例如：打开直播间并检查主播状态')}
                  value={caseDraft.name}
                />
              </div>
              <div className="field modal-field">
                <label htmlFor="automation-case-description">{t('用例说明（可选）')}</label>
                <input
                  className="input"
                  id="automation-case-description"
                  maxLength={500}
                  onChange={(event) => setCaseDraft((current) => ({ ...current, description: event.target.value }))}
                  placeholder={t('简要说明这条自动化解决什么问题')}
                  value={caseDraft.description}
                />
              </div>
              <div className="field modal-field">
                <label htmlFor="automation-case-url">{t('目标网址（可选）')}</label>
                <input
                  className="input"
                  id="automation-case-url"
                  maxLength={4_000}
                  onChange={(event) => setCaseDraft((current) => ({ ...current, targetUrl: event.target.value }))}
                  placeholder="https://example.com"
                  type="url"
                  value={caseDraft.targetUrl}
                />
              </div>
              <div className="field modal-field">
                <label htmlFor="automation-case-prompt">{t('执行指令')}</label>
                <textarea
                  className="textarea"
                  id="automation-case-prompt"
                  maxLength={100_000}
                  onChange={(event) => setCaseDraft((current) => ({ ...current, prompt: event.target.value }))}
                  placeholder={t('说明要完成的操作，以及如何判断执行成功。')}
                  rows={6}
                  value={caseDraft.prompt}
                />
              </div>
            </div>
            <footer className="ui-modal-footer">
              <button className="ui-button ui-button--neutral" disabled={savingCase} onClick={closeDialog} type="button">{t('取消')}</button>
              <button className="ui-button ui-button--primary" disabled={savingCase} type="submit">
                {t(savingCase ? '创建中…' : '创建用例')}
              </button>
            </footer>
          </form>
        </div>
      ) : null}

      {dialog === 'schedule' ? (
        <div className="ui-modal-overlay" onMouseDown={(event) => event.currentTarget === event.target && closeDialog()} role="presentation">
          <form
            aria-labelledby="automation-schedule-dialog-title"
            aria-modal="true"
            className="ui-modal ui-modal--compact automation-dialog"
            onSubmit={createSchedule}
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header className="ui-modal-header">
              <div>
                <h2 id="automation-schedule-dialog-title">{t('新建执行计划')}</h2>
                <p>{t('按本地时区每日或每周自动执行用例。')}</p>
              </div>
              <button aria-label={t('关闭')} className="ui-icon-button" disabled={savingSchedule} onClick={closeDialog} type="button">
                <X size={17} />
              </button>
            </header>
            <div className="ui-modal-body automation-dialog-fields">
              {formError ? <p className="error">{formError}</p> : null}
              <div className="field modal-field">
                <label htmlFor="automation-schedule-case">{t('自动化用例')}</label>
                <CustomSelect
                  id="automation-schedule-case"
                  onChange={(value) => setScheduleDraft((current) => ({ ...current, caseId: value }))}
                  options={[
                    { label: t('请选择用例'), value: '' },
                    ...cases.map((item) => ({ label: item.name, value: item.id })),
                  ]}
                  title={t('自动化用例')}
                  value={scheduleDraft.caseId}
                />
              </div>
              <div className="field modal-field">
                <label htmlFor="automation-schedule-name">{t('计划名称（可选）')}</label>
                <input
                  className="input"
                  id="automation-schedule-name"
                  maxLength={160}
                  onChange={(event) => setScheduleDraft((current) => ({ ...current, name: event.target.value }))}
                  placeholder={t('未填写时自动生成')}
                  value={scheduleDraft.name}
                />
              </div>
              <div className="automation-schedule-fields-row">
                <div className="field modal-field">
                  <label htmlFor="automation-schedule-frequency">{t('重复频率')}</label>
                  <CustomSelect
                    id="automation-schedule-frequency"
                    onChange={(value) => setScheduleDraft((current) => ({ ...current, frequency: value as AutomationFrequency }))}
                    options={[
                      { label: t('每日'), value: 'daily' },
                      { label: t('每周'), value: 'weekly' },
                    ]}
                    title={t('重复频率')}
                    value={scheduleDraft.frequency}
                  />
                </div>
                {scheduleDraft.frequency === 'weekly' ? (
                  <div className="field modal-field">
                    <label htmlFor="automation-schedule-weekday">{t('星期')}</label>
                    <CustomSelect
                      id="automation-schedule-weekday"
                      onChange={(value) => setScheduleDraft((current) => ({ ...current, weekday: value }))}
                      options={weekdayOptions.map((item) => ({ ...item, label: t(item.label) }))}
                      title={t('星期')}
                      value={scheduleDraft.weekday}
                    />
                  </div>
                ) : null}
                <div className="field modal-field">
                  <label htmlFor="automation-schedule-time">{t('运行时间')}</label>
                  <input
                    className="input"
                    id="automation-schedule-time"
                    onChange={(event) => setScheduleDraft((current) => ({ ...current, time: event.target.value }))}
                    required
                    type="time"
                    value={scheduleDraft.time}
                  />
                </div>
              </div>
              <div className="field modal-field">
                <label htmlFor="automation-schedule-timezone">{t('时区')}</label>
                <input
                  className="input"
                  id="automation-schedule-timezone"
                  maxLength={120}
                  onChange={(event) => setScheduleDraft((current) => ({ ...current, timezone: event.target.value }))}
                  placeholder="Asia/Hong_Kong"
                  value={scheduleDraft.timezone}
                />
              </div>
            </div>
            <footer className="ui-modal-footer">
              <button className="ui-button ui-button--neutral" disabled={savingSchedule} onClick={closeDialog} type="button">{t('取消')}</button>
              <button className="ui-button ui-button--primary" disabled={!cases.length || savingSchedule} type="submit">
                {t(savingSchedule ? '创建中…' : '创建计划')}
              </button>
            </footer>
          </form>
        </div>
      ) : null}

      {dialog === 'deleteCase' && casePendingDelete ? (
        <div className="ui-modal-overlay" onMouseDown={(event) => event.currentTarget === event.target && closeDialog()} role="presentation">
          <div
            aria-labelledby="automation-delete-case-dialog-title"
            aria-modal="true"
            className="ui-modal ui-modal--compact automation-dialog automation-confirm-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header className="ui-modal-header">
              <div>
                <h2 id="automation-delete-case-dialog-title">{t('删除自动化用例')}</h2>
                <p>{t('此操作无法撤销。')}</p>
              </div>
              <button aria-label={t('关闭')} className="ui-icon-button" disabled={Boolean(deletingCaseId)} onClick={closeDialog} type="button">
                <X size={17} />
              </button>
            </header>
            <div className="ui-modal-body automation-confirm-copy">
              {t('确认删除“{name}”？关联的 {schedules} 个执行计划和 {runs} 次运行历史也会一并删除。', {
                name: casePendingDelete.name,
                schedules: (schedulesByCase.get(casePendingDelete.id) || []).length,
                runs: (runsByCase.get(casePendingDelete.id) || []).length,
              })}
            </div>
            <footer className="ui-modal-footer">
              <button className="ui-button ui-button--neutral" disabled={Boolean(deletingCaseId)} onClick={closeDialog} type="button">{t('取消')}</button>
              <button className="ui-button ui-button--danger" disabled={Boolean(deletingCaseId)} onClick={() => void deleteCase()} type="button">
                {t(deletingCaseId ? '删除中…' : '删除用例')}
              </button>
            </footer>
          </div>
        </div>
      ) : null}

      {dialog === 'deleteSchedule' && schedulePendingDelete ? (
        <div className="ui-modal-overlay" onMouseDown={(event) => event.currentTarget === event.target && closeDialog()} role="presentation">
          <div
            aria-labelledby="automation-delete-schedule-dialog-title"
            aria-modal="true"
            className="ui-modal ui-modal--compact automation-dialog automation-confirm-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header className="ui-modal-header">
              <div>
                <h2 id="automation-delete-schedule-dialog-title">{t('删除执行计划')}</h2>
                <p>{t('删除后，该计划将不再自动运行。')}</p>
              </div>
              <button aria-label={t('关闭')} className="ui-icon-button" disabled={Boolean(deletingScheduleId)} onClick={closeDialog} type="button">
                <X size={17} />
              </button>
            </header>
            <div className="ui-modal-body automation-confirm-copy">
              {t('确认删除“{name}”？已产生的运行历史不会受到影响。', { name: schedulePendingDelete.name })}
            </div>
            <footer className="ui-modal-footer">
              <button className="ui-button ui-button--neutral" disabled={Boolean(deletingScheduleId)} onClick={closeDialog} type="button">{t('取消')}</button>
              <button className="ui-button ui-button--danger" disabled={Boolean(deletingScheduleId)} onClick={() => void deleteSchedule()} type="button">
                {t(deletingScheduleId ? '删除中…' : '删除计划')}
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </section>
  );
}
