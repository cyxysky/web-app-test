'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { CalendarClock, Folder, FolderPlus, Loader2, PlayCircle, Settings, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { NewTestCaseModal } from '@/components/NewTestCaseModal';
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

function groupPath(groups: TestGroupRecord[], groupId?: string): string {
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
      <button className={selectedGroupId === group.id ? 'group-tree-button active' : 'group-tree-button'} onClick={() => onSelect(group.id)} type="button">
        <Folder size={15} />
        {group.name}
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

export function DashboardWorkspace({
  testCases,
  groups,
  schedules,
}: {
  testCases: TestCaseRecord[];
  groups: TestGroupRecord[];
  schedules: RunScheduleRecord[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [selectedGroupId, setSelectedGroupId] = useState<string | undefined>();
  const [groupName, setGroupName] = useState('');
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [movingCaseId, setMovingCaseId] = useState<string | null>(null);
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleName, setScheduleName] = useState('定时回归');
  const [scheduleInterval, setScheduleInterval] = useState(60);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const rootGroups = useMemo(() => groups.filter((group) => !group.parentId), [groups]);
  const visibleCases = testCases.filter((item) => item.groupId === selectedGroupId);
  const completedCases = visibleCases.filter((item) => ['passed', 'failed', 'blocked'].includes(item.status));

  useEffect(() => {
    if (!testCases.some((item) => item.status === 'running')) return;
    const timer = window.setInterval(() => router.refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [router, testCases]);

  async function createGroup(parentId?: string) {
    const name = groupName.trim();
    if (!name || creatingGroup) return;
    setCreatingGroup(true);
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
    }
  }

  async function moveCase(testCaseId: string, groupId?: string) {
    setMovingCaseId(testCaseId);
    try {
      await fetch(`/api/test-cases/${testCaseId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId }),
      });
      startTransition(() => router.refresh());
    } finally {
      setMovingCaseId(null);
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
    }
  }

  async function saveSchedule() {
    const ids = selectedCaseIds.length ? selectedCaseIds : visibleCases.map((item) => item.id);
    if (!ids.length || savingSchedule) return;
    setSavingSchedule(true);
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
    }
  }

  return (
    <section className="dashboard-folder-layout">
      <aside className="group-sidebar">
        <button className="icon-text-button group-create-button" onClick={() => setGroupDialogOpen(true)} type="button">
          <FolderPlus size={15} />
          {selectedGroupId ? '在当前组内创建子组' : '创建组'}
        </button>
        <button className={!selectedGroupId ? 'group-tree-button active' : 'group-tree-button'} onClick={() => setSelectedGroupId(undefined)} type="button">
          <Folder size={15} />
          未分组
        </button>
        <ol className="group-tree">
          {rootGroups.map((group) => (
            <GroupNode group={group} groups={groups} key={group.id} selectedGroupId={selectedGroupId} onSelect={setSelectedGroupId} />
          ))}
        </ol>
      </aside>

      <div className="dashboard-v2-list">
        <div className="plain-section-head">
          <div>
            <h2>{selectedGroupId ? groupPath(groups, selectedGroupId) : '未分组'}</h2>
            <span>{visibleCases.length} 条，已完成 {completedCases.length} 条</span>
          </div>
          <div className="dashboard-actions">
            <Link className="icon-text-button" href="/settings">
              <Settings size={15} />
              环境配置
            </Link>
            <button className="icon-text-button" disabled={!selectedCaseIds.length || batchRunning} onClick={startBatchRun} type="button">
              {batchRunning ? <Loader2 className="spin" size={15} /> : <PlayCircle size={15} />}
              批量运行{selectedCaseIds.length ? ` ${selectedCaseIds.length}` : ''}
            </button>
            <button className="icon-text-button" disabled={!visibleCases.length} onClick={() => setScheduleOpen(true)} type="button">
              <CalendarClock size={15} />
              定时任务
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
                {movingCaseId === item.id ? <Loader2 className="spin" size={16} /> : <Link href={`/test-cases/${item.id}`}><PlayCircle size={18} /></Link>}
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
