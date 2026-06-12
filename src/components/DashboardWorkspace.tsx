'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, useTransition } from 'react';
import { CalendarClock, FlaskConical, Folder, FolderPlus, Loader2, MessageSquare, PlayCircle, Settings, Trash2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { DeleteTestCaseButton } from '@/components/DeleteTestCaseButton';
import { NewTestCaseModal } from '@/components/NewTestCaseModal';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';
import { subscribeRealtime } from '@/lib/realtime-client';
import { richTextToPlainText } from '@/lib/rich-text';
import type { RunScheduleRecord, TestCaseRecord, TestGroupRecord } from '@/server/ai/schemas/test-case.schema';

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    draft: '草稿',
    generated: '已生成',
    ready: '待执行',
    running: '运行中',
    passed: '通过',
    failed: '失败',
    blocked: '阻塞',
  };
  return labels[status] || status;
}

type EvaluationSuiteStatus = {
  totalTemplates: number;
  seededCases: number;
  missingCases: number;
  totalRuns: number;
  completedRunCount: number;
  passedRunCount: number;
  failedRunCount: number;
  blockedRunCount: number;
  passRate: number;
  averageDurationMs?: number;
  trend: {
    recentRuns: number;
    previousRuns: number;
    recentPassRate: number;
    previousPassRate?: number;
    delta?: number;
    status: 'no-data' | 'baseline' | 'regressed' | 'improved' | 'stable';
  };
  alerts: Array<{
    level: 'info' | 'warning' | 'danger';
    title: string;
    detail: string;
  }>;
  areas: Array<{
    area: string;
    totalCases: number;
    seededCases: number;
    completedRunCount: number;
    passedRunCount: number;
    failedRunCount: number;
    blockedRunCount: number;
    passRate: number;
  }>;
  cases: Array<{
    key: string;
    area: string;
    title: string;
    testCaseId?: string;
    status: string;
    runCount: number;
    completedRunCount: number;
    passRate: number;
    trend: EvaluationSuiteStatus['trend'];
    latestRun?: {
      id: string;
      status: string;
      startedAt?: string;
      endedAt?: string;
      qualityScore?: number;
      contextSummaryScore?: number;
    };
  }>;
};

function areaLabel(area: string) {
  return ({
    'browser-chat': 'browser-chat',
    'context-summary': '长上下文',
    'dom-mode': 'DOM',
    'visual-markers': '视觉标记',
  } as Record<string, string>)[area] || area;
}

function formatDuration(ms?: number) {
  if (!ms) return '暂无';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  return `${Math.round(ms / 60_000)} 分钟`;
}

function trendLabel(trend: EvaluationSuiteStatus['trend']) {
  if (trend.status === 'no-data') return '暂无趋势';
  if (trend.status === 'baseline') return `基线 ${trend.recentPassRate}%`;
  const delta = trend.delta || 0;
  const sign = delta > 0 ? '+' : '';
  return `${trend.recentPassRate}% (${sign}${delta})`;
}

function EvaluationSuiteSummary({
  loading,
  status,
}: {
  loading: boolean;
  status: EvaluationSuiteStatus;
}) {
  return (
    <section className="evaluation-suite-summary">
      <header>
        <div>
          <strong>最小评测集</strong>
          <span>{status.seededCases}/{status.totalTemplates} 用例，{status.completedRunCount} 次完成运行</span>
        </div>
        <span>{loading ? '刷新中' : status.totalRuns ? `最近通过率 ${status.passRate}%` : '暂无运行'}</span>
      </header>
      <div className="evaluation-suite-metrics">
        <div>
          <strong>{status.passRate}%</strong>
          <span>通过率</span>
        </div>
        <div>
          <strong>{status.passedRunCount}</strong>
          <span>通过</span>
        </div>
        <div>
          <strong>{status.failedRunCount + status.blockedRunCount}</strong>
          <span>失败/阻塞</span>
        </div>
        <div>
          <strong>{formatDuration(status.averageDurationMs)}</strong>
          <span>平均耗时</span>
        </div>
        <div>
          <strong>{trendLabel(status.trend)}</strong>
          <span>趋势窗口</span>
        </div>
      </div>
      {status.alerts.length ? (
        <div className="evaluation-suite-alerts">
          {status.alerts.slice(0, 4).map((item, index) => (
            <span className={item.level} key={`${item.title}-${index}`}>
              <strong>{item.title}</strong>
              {item.detail}
            </span>
          ))}
        </div>
      ) : null}
      {status.areas.length ? (
        <div className="evaluation-suite-areas">
          {status.areas.map((area) => (
            <span key={area.area}>
              {areaLabel(area.area)} · {area.seededCases}/{area.totalCases} · {area.completedRunCount ? `${area.passRate}%` : '未运行'}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function groupPath(groups: TestGroupRecord[], groupId?: string): string {
  if (!groupId) return '未分组';
  const group = groups.find((item) => item.id === groupId);
  if (!group) return '未知分组';
  return `${groupPath(groups, group.parentId)} / ${group.name}`.replace(/^未分组 \/ /, '');
}

function GroupNode({
  group,
  groups,
  selectedGroupId,
  onSelect,
}: {
  group: TestGroupRecord;
  groups: TestGroupRecord[];
  selectedGroupId?: string;
  onSelect: (groupId?: string) => void;
}) {
  const children = groups.filter((item) => item.parentId === group.id);

  return (
    <li>
      <button className={selectedGroupId === group.id ? 'group-tree-button active' : 'group-tree-button'} onClick={() => onSelect(group.id)} title={group.name} type="button">
        <Folder size={15} />
        <span>{group.name}</span>
      </button>
      {children.length ? (
        <ol>
          {children.map((child) => (
            <GroupNode group={child} groups={groups} key={child.id} selectedGroupId={selectedGroupId} onSelect={onSelect} />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

export function DashboardGroupSidebar({
  className = 'group-sidebar',
  groups,
  selectedGroupId,
  onCreateGroup,
  onSelect,
}: {
  className?: string;
  groups: TestGroupRecord[];
  selectedGroupId?: string;
  onCreateGroup: () => void;
  onSelect: (groupId?: string) => void;
}) {
  const rootGroups = groups.filter((group) => !group.parentId);

  return (
    <aside className={className}>
      <button className="icon-text-button group-create-button" onClick={onCreateGroup} type="button">
        <FolderPlus size={15} />
        {selectedGroupId ? '在当前组内创建子组' : '创建组'}
      </button>
      <button className={!selectedGroupId ? 'group-tree-button active' : 'group-tree-button'} onClick={() => onSelect(undefined)} type="button">
        <Folder size={15} />
        <span>未分组</span>
      </button>
      <ol className="group-tree">
        {rootGroups.map((group) => (
          <GroupNode group={group} groups={groups} key={group.id} selectedGroupId={selectedGroupId} onSelect={onSelect} />
        ))}
      </ol>
    </aside>
  );
}

export function DashboardWorkspace({
  testCases,
  groups,
  schedules,
  selectedGroupId: controlledSelectedGroupId,
  onSelectedGroupIdChange,
  showGroupSidebar = true,
  showBrowserChatAction = true,
  showSettingsAction = true,
}: {
  testCases: TestCaseRecord[];
  groups: TestGroupRecord[];
  schedules: RunScheduleRecord[];
  selectedGroupId?: string;
  onSelectedGroupIdChange?: (groupId?: string) => void;
  showGroupSidebar?: boolean;
  showBrowserChatAction?: boolean;
  showSettingsAction?: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [internalSelectedGroupId, setInternalSelectedGroupId] = useState<string | undefined>();
  const [groupName, setGroupName] = useState('');
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [movingCaseId, setMovingCaseId] = useState<string | null>(null);
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [seedingEvaluation, setSeedingEvaluation] = useState(false);
  const [loadingEvaluationStatus, setLoadingEvaluationStatus] = useState(false);
  const [evaluationStatus, setEvaluationStatus] = useState<EvaluationSuiteStatus>();
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleName, setScheduleName] = useState('定时回归');
  const [scheduleInterval, setScheduleInterval] = useState(60);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const selectedGroupId = controlledSelectedGroupId ?? internalSelectedGroupId;
  const selectGroup = onSelectedGroupIdChange ?? setInternalSelectedGroupId;
  const visibleCases = testCases.filter((item) => item.groupId === selectedGroupId);
  const completedCases = visibleCases.filter((item) => ['passed', 'failed', 'blocked'].includes(item.status));

  const loadEvaluationStatus = useCallback(async () => {
    setLoadingEvaluationStatus(true);
    try {
      const response = await fetch('/api/evaluation-suite/status', { cache: 'no-store' });
      const data = await response.json();
      if (response.ok) setEvaluationStatus(data.status as EvaluationSuiteStatus);
    } finally {
      setLoadingEvaluationStatus(false);
    }
  }, []);

  useEffect(() => {
    return subscribeRealtime(['dashboard'], (event) => {
      if (event.entityType === 'run' || event.entityType === 'testCase' || event.entityType === 'group' || event.entityType === 'schedule') {
        router.refresh();
      }
    });
  }, [router]);

  useEffect(() => {
    void loadEvaluationStatus();
  }, [loadEvaluationStatus, testCases.length]);

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

  async function moveCase(testCaseId: string, groupId?: string) {
    setMovingCaseId(testCaseId);
    startGlobalLoading('正在移动测试用例');
    try {
      await fetch(`/api/test-cases/${testCaseId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId }),
      });
      startTransition(() => router.refresh());
    } finally {
      setMovingCaseId(null);
      stopGlobalLoading();
    }
  }

  function toggleCase(testCaseId: string) {
    setSelectedCaseIds((current) =>
      current.includes(testCaseId) ? current.filter((id) => id !== testCaseId) : [...current, testCaseId],
    );
  }

  async function startBatchRun() {
    if (!selectedCaseIds.length || batchRunning) return;
    setBatchRunning(true);
    startGlobalLoading('正在批量启动测试');
    const openedTabs = selectedCaseIds.map(() => window.open('about:blank', '_blank'));
    try {
      const response = await fetch('/api/runs/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCaseIds: selectedCaseIds }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '批量运行启动失败');
      const runs: Array<{ id?: string }> = Array.isArray(data.runs) ? data.runs : [];
      runs.forEach((run, index) => {
        if (!run?.id) return;
        const url = `/runs/${run.id}`;
        const tab = openedTabs[index];
        if (tab) tab.location.href = url;
        else window.open(url, '_blank', 'noopener,noreferrer');
      });
      for (let index = runs.length; index < openedTabs.length; index += 1) {
        openedTabs[index]?.close();
      }
      setSelectedCaseIds([]);
      startTransition(() => router.refresh());
    } catch (error) {
      openedTabs.forEach((tab) => tab?.close());
      window.alert(error instanceof Error ? error.message : '批量运行启动失败');
    } finally {
      setBatchRunning(false);
      stopGlobalLoading();
    }
  }

  async function deleteSelectedCases() {
    if (!selectedCaseIds.length || batchDeleting) return;
    if (!window.confirm(`确定删除选中的 ${selectedCaseIds.length} 条用例吗？关联执行记录会一起移除。`)) return;
    setBatchDeleting(true);
    startGlobalLoading('正在批量删除测试用例');
    try {
      const response = await fetch('/api/test-cases/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCaseIds: selectedCaseIds }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || '批量删除失败');
      setSelectedCaseIds([]);
      startTransition(() => router.refresh());
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '批量删除失败');
    } finally {
      setBatchDeleting(false);
      stopGlobalLoading();
    }
  }

  async function saveSchedule() {
    const ids = selectedCaseIds.length ? selectedCaseIds : visibleCases.map((item) => item.id);
    if (!ids.length || savingSchedule) return;
    setSavingSchedule(true);
    startGlobalLoading('正在保存定时任务');
    try {
      await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: scheduleName,
          enabled: true,
          testCaseIds: ids,
          intervalMinutes: scheduleInterval,
        }),
      });
      setScheduleOpen(false);
      startTransition(() => router.refresh());
    } finally {
      setSavingSchedule(false);
      stopGlobalLoading();
    }
  }

  async function seedEvaluationSuite() {
    if (seedingEvaluation) return;
    setSeedingEvaluation(true);
    startGlobalLoading('正在创建最小评测集');
    try {
      const response = await fetch('/api/evaluation-suite/seed', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '创建评测集失败');
      const created = data.result?.created?.length || 0;
      const skipped = data.result?.skipped?.length || 0;
      window.alert(`最小评测集已准备好：新建 ${created} 条，已存在 ${skipped} 条。`);
      void loadEvaluationStatus();
      startTransition(() => router.refresh());
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '创建评测集失败');
    } finally {
      setSeedingEvaluation(false);
      stopGlobalLoading();
    }
  }

  return (
    <section className={showGroupSidebar ? 'dashboard-folder-layout' : 'dashboard-folder-layout no-sidebar'}>
      {showGroupSidebar ? (
        <DashboardGroupSidebar
          groups={groups}
          selectedGroupId={selectedGroupId}
          onCreateGroup={() => setGroupDialogOpen(true)}
          onSelect={selectGroup}
        />
      ) : null}

      <div className="dashboard-v2-list">
        <div className="plain-section-head">
          <div>
            <h2>{selectedGroupId ? groupPath(groups, selectedGroupId) : '未分组'}</h2>
            <span>{visibleCases.length} 条，已完成 {completedCases.length} 条</span>
          </div>
          <div className="dashboard-actions">
            {showBrowserChatAction ? (
              <Link className="icon-text-button" href="/browser-chat">
                <MessageSquare size={15} />
                对话操作
              </Link>
            ) : null}
            {showSettingsAction ? (
              <Link className="icon-text-button" href="/settings">
                <Settings size={15} />
                环境配置
              </Link>
            ) : null}
            <button className="icon-text-button" disabled={!selectedCaseIds.length || batchRunning} onClick={startBatchRun} type="button">
              {batchRunning ? <Loader2 className="spin" size={15} /> : <PlayCircle size={15} />}
              批量运行{selectedCaseIds.length ? ` ${selectedCaseIds.length}` : ''}
            </button>
            <button className="icon-text-button danger" disabled={!selectedCaseIds.length || batchDeleting} onClick={deleteSelectedCases} type="button">
              {batchDeleting ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
              批量删除{selectedCaseIds.length ? ` ${selectedCaseIds.length}` : ''}
            </button>
            <button className="icon-text-button" disabled={!visibleCases.length} onClick={() => setScheduleOpen(true)} type="button">
              <CalendarClock size={15} />
              定时任务
            </button>
            <button className="icon-text-button" disabled={seedingEvaluation} onClick={seedEvaluationSuite} type="button">
              {seedingEvaluation ? <Loader2 className="spin" size={15} /> : <FlaskConical size={15} />}
              最小评测集
            </button>
            <NewTestCaseModal groupId={selectedGroupId} />
          </div>
        </div>
        {schedules.length ? (
          <div className="schedule-strip">
            {schedules.slice(0, 4).map((schedule) => (
              <span key={schedule.id}>
                {schedule.enabled ? '启用' : '停用'} · {schedule.name} · 下次 {new Date(schedule.nextRunAt).toLocaleString()}
              </span>
            ))}
          </div>
        ) : null}
        {evaluationStatus && (evaluationStatus.seededCases > 0 || evaluationStatus.totalRuns > 0) ? (
          <EvaluationSuiteSummary loading={loadingEvaluationStatus} status={evaluationStatus} />
        ) : null}
        <div className="case-table-list">
          {visibleCases.length ? (
            visibleCases.map((item) => (
              <div className="case-table-row case-table-row-managed" key={item.id}>
                <input
                  aria-label={`选择 ${item.title}`}
                  checked={selectedCaseIds.includes(item.id)}
                  onChange={() => toggleCase(item.id)}
                  type="checkbox"
                />
                <Link href={`/test-cases/${item.id}`}>
                  <strong>{item.title}</strong>
                  <p>{richTextToPlainText(item.content.userRequirement || item.description) || item.description}</p>
                </Link>
                <span className={`badge status-${item.status}`}>{statusLabel(item.status)}</span>
                <span>{item.status === 'running' ? '执行中' : ['passed', 'failed', 'blocked'].includes(item.status) ? '已完成' : '待执行'}</span>
                <select className="input compact-select" disabled={movingCaseId === item.id} value={item.groupId || ''} onChange={(event) => moveCase(item.id, event.target.value || undefined)}>
                  <option value="">未分组</option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>{groupPath(groups, group.id)}</option>
                  ))}
                </select>
                <span className="case-row-actions">
                  {movingCaseId === item.id ? (
                    <Loader2 className="spin" size={16} />
                  ) : (
                    <Link className="case-row-icon-button" href={`/test-cases/${item.id}`} title="查看详情"><PlayCircle size={18} /></Link>
                  )}
                  <DeleteTestCaseButton
                    className="case-row-icon-button danger"
                    label=""
                    testCaseId={item.id}
                    testCaseTitle={item.title}
                  />
                </span>
              </div>
            ))
          ) : (
            <div className="empty-state">当前分组暂无测试用例。</div>
          )}
        </div>
      </div>
      {groupDialogOpen ? (
        <div className="modal-overlay" onClick={() => setGroupDialogOpen(false)} role="presentation">
          <section className="group-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="创建分组">
            <header>
              <div>
                <h2>{selectedGroupId ? '创建子组' : '创建组'}</h2>
                <p>{selectedGroupId ? `父级：${groupPath(groups, selectedGroupId)}` : '创建根分组'}</p>
              </div>
              <button className="icon-button" onClick={() => setGroupDialogOpen(false)} type="button" aria-label="关闭">
                <X size={18} />
              </button>
            </header>
            <label className="modal-field">
              分组名称
              <input autoFocus className="input" value={groupName} onChange={(event) => setGroupName(event.target.value)} />
            </label>
            <button className="button full-width" disabled={creatingGroup} onClick={() => createGroup(selectedGroupId)} type="button">
              {creatingGroup ? <Loader2 className="spin" size={16} /> : null}
              {creatingGroup ? '创建中' : '创建'}
            </button>
          </section>
        </div>
      ) : null}
      {scheduleOpen ? (
        <div className="modal-overlay" onClick={() => setScheduleOpen(false)} role="presentation">
          <section className="group-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="创建定时任务">
            <header>
              <div>
                <h2>创建定时任务</h2>
                <p>{selectedCaseIds.length ? `已选择 ${selectedCaseIds.length} 条用例` : `将运行当前分组 ${visibleCases.length} 条用例`}</p>
              </div>
              <button className="icon-button" onClick={() => setScheduleOpen(false)} type="button" aria-label="关闭">
                <X size={18} />
              </button>
            </header>
            <label className="modal-field">
              任务名称
              <input className="input" value={scheduleName} onChange={(event) => setScheduleName(event.target.value)} />
            </label>
            <label className="modal-field">
              间隔分钟
              <input className="input" min={1} type="number" value={scheduleInterval} onChange={(event) => setScheduleInterval(Number(event.target.value))} />
            </label>
            <button className="button full-width" disabled={savingSchedule} onClick={saveSchedule} type="button">
              {savingSchedule ? <Loader2 className="spin" size={16} /> : null}
              {savingSchedule ? '保存中' : '保存并启用'}
            </button>
          </section>
        </div>
      ) : null}
    </section>
  );
}
