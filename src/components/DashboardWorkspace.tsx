'use client';

import Link from 'next/link';
import { useEffect, useState, useTransition } from 'react';
import { CalendarClock, Folder, FolderPlus, Loader2, MessageSquare, PlayCircle, Settings, Trash2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { CustomSelect } from '@/components/CustomSelect';
import { DeleteTestCaseButton } from '@/components/DeleteTestCaseButton';
import { NewTestCaseModal } from '@/components/NewTestCaseModal';
import { useI18n } from '@/i18n/I18nProvider';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';
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

function caseProgressLabel(status: string) {
  if (status === 'running') return '执行中';
  if (['passed', 'failed', 'blocked'].includes(status)) return '已完成';
  return '待执行';
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
      <button
        aria-label={group.name}
        className={selectedGroupId === group.id ? 'group-tree-button active' : 'group-tree-button'}
        onClick={() => onSelect(group.id)}
        title={group.name}
        type="button"
      >
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
  const { t } = useI18n();
  const rootGroups = groups.filter((group) => !group.parentId);

  return (
    <aside className={className}>
      <button
        className="icon-text-button group-create-button"
        onClick={onCreateGroup}
        title={selectedGroupId ? t('在当前组内创建子组') : t('创建组')}
        type="button"
      >
        <FolderPlus size={15} />
        <span>{selectedGroupId ? t('在当前组内创建子组') : t('创建组')}</span>
      </button>
      <button aria-label={t('Ungrouped')} className={!selectedGroupId ? 'group-tree-button active' : 'group-tree-button'} onClick={() => onSelect(undefined)} title={t('Ungrouped')} type="button">
        <Folder size={15} />
        <span>{t('Ungrouped')}</span>
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
  const { language, t } = useI18n();
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
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleName, setScheduleName] = useState(() => t('定时回归'));
  const [scheduleInterval, setScheduleInterval] = useState(60);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const selectedGroupId = controlledSelectedGroupId ?? internalSelectedGroupId;
  const selectGroup = onSelectedGroupIdChange ?? setInternalSelectedGroupId;
  const visibleCases = testCases.filter((item) => item.groupId === selectedGroupId);
  const completedCases = visibleCases.filter((item) => ['passed', 'failed', 'blocked'].includes(item.status));

  useEffect(() => {
    if (!testCases.some((item) => item.status === 'running')) return;
    const timer = window.setInterval(() => router.refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [router, testCases]);

  useEffect(() => {
    setScheduleName((current) => (
      current === '定时回归' || current === 'Scheduled regression' ? t('定时回归') : current
    ));
  }, [language, t]);

  async function createGroup(parentId?: string) {
    const name = groupName.trim();
    if (!name || creatingGroup) return;
    setCreatingGroup(true);
    startGlobalLoading(t('正在创建分组'));
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
    startGlobalLoading(t('正在移动测试用例'));
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
    startGlobalLoading(t('正在批量启动测试'));
    const openedTabs = selectedCaseIds.map(() => window.open('about:blank', '_blank'));
    try {
      const response = await fetch('/api/runs/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCaseIds: selectedCaseIds }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('批量运行启动失败'));
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
      window.alert(error instanceof Error ? error.message : t('批量运行启动失败'));
    } finally {
      setBatchRunning(false);
      stopGlobalLoading();
    }
  }

  async function deleteSelectedCases() {
    if (!selectedCaseIds.length || batchDeleting) return;
    if (!window.confirm(t('确定删除选中的 {count} 条用例吗？关联执行记录会一起移除。', { count: selectedCaseIds.length }))) return;
    setBatchDeleting(true);
    startGlobalLoading(t('正在批量删除测试用例'));
    try {
      const response = await fetch('/api/test-cases/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCaseIds: selectedCaseIds }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || t('批量删除失败'));
      setSelectedCaseIds([]);
      startTransition(() => router.refresh());
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t('批量删除失败'));
    } finally {
      setBatchDeleting(false);
      stopGlobalLoading();
    }
  }

  async function saveSchedule() {
    const ids = selectedCaseIds.length ? selectedCaseIds : visibleCases.map((item) => item.id);
    if (!ids.length || savingSchedule) return;
    setSavingSchedule(true);
    startGlobalLoading(t('正在保存定时任务'));
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
            <h2>{selectedGroupId ? groupPath(groups, selectedGroupId) : t('未分组')}</h2>
            <span>{t('{total} 条，已完成 {completed} 条', { total: visibleCases.length, completed: completedCases.length })}</span>
          </div>
          <div className="dashboard-actions">
            {showBrowserChatAction ? (
              <Link className="icon-text-button" href="/browser-chat">
                <MessageSquare size={15} />
                {t('对话操作')}
              </Link>
            ) : null}
            {showSettingsAction ? (
              <Link className="icon-text-button" href="/settings">
                <Settings size={15} />
                {t('环境配置')}
              </Link>
            ) : null}
            <button className="icon-text-button" disabled={!selectedCaseIds.length || batchRunning} onClick={startBatchRun} type="button">
              {batchRunning ? <Loader2 className="spin" size={15} /> : <PlayCircle size={15} />}
              {t('批量运行')}{selectedCaseIds.length ? ` ${selectedCaseIds.length}` : ''}
            </button>
            <button className="icon-text-button danger" disabled={!selectedCaseIds.length || batchDeleting} onClick={deleteSelectedCases} type="button">
              {batchDeleting ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
              {t('批量删除')}{selectedCaseIds.length ? ` ${selectedCaseIds.length}` : ''}
            </button>
            <button className="icon-text-button" disabled={!visibleCases.length} onClick={() => setScheduleOpen(true)} type="button">
              <CalendarClock size={15} />
              {t('定时任务')}
            </button>
            <NewTestCaseModal groupId={selectedGroupId} />
          </div>
        </div>
        {schedules.length ? (
          <div className="schedule-strip">
            {schedules.slice(0, 4).map((schedule) => (
              <span key={schedule.id}>
                {schedule.enabled ? t('启用') : t('停用')} · {schedule.name} · {t('下次')} {new Date(schedule.nextRunAt).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN')}
              </span>
            ))}
          </div>
        ) : null}
        <div className="case-table-list">
          {visibleCases.length ? (
            visibleCases.map((item) => (
              <div className="case-table-row case-table-row-managed" key={item.id}>
                <input
                  aria-label={t('选择 {name}', { name: item.title })}
                  checked={selectedCaseIds.includes(item.id)}
                  onChange={() => toggleCase(item.id)}
                  type="checkbox"
                />
                <Link href={`/test-cases/${item.id}`}>
                  <strong>{item.title}</strong>
                  <p>{richTextToPlainText(item.content.userRequirement || item.description) || item.description}</p>
                </Link>
                <span className={`badge status-${item.status}`}>{t(statusLabel(item.status))}</span>
                <span>{t(caseProgressLabel(item.status))}</span>
                <CustomSelect
                  className="compact-select"
                  disabled={movingCaseId === item.id}
                  value={item.groupId || ''}
                  onChange={(nextValue) => moveCase(item.id, nextValue || undefined)}
                  options={[
                    { label: t('未分组'), value: '' },
                    ...groups.map((group) => ({ label: groupPath(groups, group.id), value: group.id })),
                  ]}
                />
                <span className="case-row-actions">
                  {movingCaseId === item.id ? (
                    <Loader2 className="spin" size={16} />
                  ) : (
                    <Link className="case-row-icon-button" href={`/test-cases/${item.id}`} title={t('查看详情')}><PlayCircle size={18} /></Link>
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
            <div className="empty-state">{t('当前分组暂无测试用例。')}</div>
          )}
        </div>
      </div>
      {groupDialogOpen ? (
        <div className="modal-overlay" onClick={() => setGroupDialogOpen(false)} role="presentation">
          <section className="group-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label={t('创建分组')}>
            <header>
              <div>
                <h2>{selectedGroupId ? t('创建子组') : t('创建组')}</h2>
                <p>{selectedGroupId ? t('父级：{name}', { name: groupPath(groups, selectedGroupId) }) : t('创建根分组')}</p>
              </div>
              <button className="icon-button" onClick={() => setGroupDialogOpen(false)} type="button" aria-label={t('关闭')}>
                <X size={18} />
              </button>
            </header>
            <label className="modal-field">
              {t('分组名称')}
              <input autoFocus className="input" value={groupName} onChange={(event) => setGroupName(event.target.value)} />
            </label>
            <button className="button full-width" disabled={creatingGroup} onClick={() => createGroup(selectedGroupId)} type="button">
              {creatingGroup ? <Loader2 className="spin" size={16} /> : null}
              {creatingGroup ? t('创建中') : t('创建')}
            </button>
          </section>
        </div>
      ) : null}
      {scheduleOpen ? (
        <div className="modal-overlay" onClick={() => setScheduleOpen(false)} role="presentation">
          <section className="group-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label={t('创建定时任务')}>
            <header>
              <div>
                <h2>{t('创建定时任务')}</h2>
                <p>{selectedCaseIds.length ? t('已选择 {count} 条用例', { count: selectedCaseIds.length }) : t('将运行当前分组 {count} 条用例', { count: visibleCases.length })}</p>
              </div>
              <button className="icon-button" onClick={() => setScheduleOpen(false)} type="button" aria-label={t('关闭')}>
                <X size={18} />
              </button>
            </header>
            <label className="modal-field">
              {t('任务名称')}
              <input className="input" value={scheduleName} onChange={(event) => setScheduleName(event.target.value)} />
            </label>
            <label className="modal-field">
              {t('间隔分钟')}
              <input className="input" min={1} type="number" value={scheduleInterval} onChange={(event) => setScheduleInterval(Number(event.target.value))} />
            </label>
            <button className="button full-width" disabled={savingSchedule} onClick={saveSchedule} type="button">
              {savingSchedule ? <Loader2 className="spin" size={16} /> : null}
              {savingSchedule ? t('保存中') : t('保存并启用')}
            </button>
          </section>
        </div>
      ) : null}
    </section>
  );
}
