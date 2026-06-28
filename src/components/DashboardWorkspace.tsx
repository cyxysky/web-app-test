'use client';

import Link from 'next/link';
import { useCallback, useEffect, useReducer, useRef, useState, useTransition, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, CalendarClock, Folder, FolderPlus, Loader2, MessageSquare, Play, RotateCcw, Settings, Trash2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { CustomSelect } from '@/components/CustomSelect';
import { DeleteTestCaseButton } from '@/components/DeleteTestCaseButton';
import { NewTestCaseModal } from '@/components/NewTestCaseModal';
import { RunProgress } from '@/components/RunProgress';
import { TestCaseDetailWorkspace } from '@/components/TestCaseDetailWorkspace';
import { useI18n } from '@/i18n/I18nProvider';
import { readApiJson } from '@/lib/api-client';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';
import { richTextToPlainText } from '@/lib/rich-text';
import type { ModelProvider, RunScheduleRecord, SkillRecord, TestCaseRecord, TestGroupRecord, TestRunRecord } from '@/server/ai/schemas/test-case.schema';

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

type CaseDetailPayload = {
  runs: TestRunRecord[];
  skills: SkillRecord[];
  testCase: TestCaseRecord;
};

export function groupPath(groups: TestGroupRecord[], groupId?: string): string {
  if (!groupId) return '未分组';
  const group = groups.find((item) => item.id === groupId);
  if (!group) return '未知分组';
  return `${groupPath(groups, group.parentId)} / ${group.name}`.replace(/^未分组 \/ /, '');
}

function GroupNode({
  deletingGroupId,
  group,
  groups,
  onDelete,
  selectedGroupId,
  onSelect,
}: {
  deletingGroupId?: string | null;
  group: TestGroupRecord;
  groups: TestGroupRecord[];
  onDelete?: (group: TestGroupRecord) => void;
  selectedGroupId?: string;
  onSelect: (groupId?: string) => void;
}) {
  const { t } = useI18n();
  const children = groups.filter((item) => item.parentId === group.id);

  return (
    <li>
      <div className="group-tree-row">
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
        {onDelete ? (
          <button aria-label={t('删除 {name}', { name: group.name })} className="group-tree-delete" disabled={deletingGroupId === group.id} onClick={() => onDelete(group)} title={t('删除 {name}', { name: group.name })} type="button">
            {deletingGroupId === group.id ? <Loader2 className="spin" size={13} /> : <Trash2 size={13} />}
          </button>
        ) : null}
      </div>
      {children.length ? (
        <ol>
          {children.map((child) => (
            <GroupNode deletingGroupId={deletingGroupId} group={child} groups={groups} key={child.id} selectedGroupId={selectedGroupId} onDelete={onDelete} onSelect={onSelect} />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

export function DashboardGroupSidebar({
  className = 'group-sidebar',
  deletingGroupId,
  groups,
  onDeleteGroup,
  selectedGroupId,
  onCreateGroup,
  onSelect,
}: {
  className?: string;
  deletingGroupId?: string | null;
  groups: TestGroupRecord[];
  onDeleteGroup?: (group: TestGroupRecord) => void;
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
      <button aria-label={t('未分组')} className={!selectedGroupId ? 'group-tree-button active' : 'group-tree-button'} onClick={() => onSelect(undefined)} title={t('未分组')} type="button">
        <Folder size={15} />
        <span>{t('未分组')}</span>
      </button>
      <ol className="group-tree">
        {rootGroups.map((group) => (
          <GroupNode deletingGroupId={deletingGroupId} group={group} groups={groups} key={group.id} selectedGroupId={selectedGroupId} onDelete={onDeleteGroup} onSelect={onSelect} />
        ))}
      </ol>
    </aside>
  );
}

type CaseDetailPanelState = {
  activeDetailCaseId: string | null;
  activeRunId: string | null;
};

type CaseDetailPanelAction =
  | { caseId: string; type: 'open-case' }
  | { type: 'close' }
  | { caseId?: string; runId: string; type: 'open-run' }
  | { runId: string | null; type: 'set-run' }
  | { type: 'back-to-case' };

function caseDetailPanelReducer(state: CaseDetailPanelState, action: CaseDetailPanelAction): CaseDetailPanelState {
  if (action.type === 'open-case') {
    return { activeDetailCaseId: action.caseId, activeRunId: null };
  }
  if (action.type === 'close') {
    return { activeDetailCaseId: null, activeRunId: null };
  }
  if (action.type === 'open-run') {
    return {
      activeDetailCaseId: action.caseId ?? state.activeDetailCaseId,
      activeRunId: action.runId,
    };
  }
  if (action.type === 'set-run') {
    return { ...state, activeRunId: action.runId };
  }
  return { ...state, activeRunId: null };
}

function useCaseDetailPanelState({
  controlledActiveDetailCaseId,
  initialActiveRunId,
  onActiveDetailCaseIdChange,
}: {
  controlledActiveDetailCaseId?: string | null;
  initialActiveRunId?: string | null;
  onActiveDetailCaseIdChange?: (caseId: string | null) => void;
}) {
  const [state, dispatch] = useReducer(caseDetailPanelReducer, {
    activeDetailCaseId: null,
    activeRunId: initialActiveRunId || null,
  });
  const activeDetailCaseId = controlledActiveDetailCaseId !== undefined ? controlledActiveDetailCaseId : state.activeDetailCaseId;
  const syncActiveDetailCaseId = useCallback((caseId: string | null) => {
    onActiveDetailCaseIdChange?.(caseId);
  }, [onActiveDetailCaseIdChange]);
  useEffect(() => {
    if (activeDetailCaseId || !state.activeRunId) return;
    dispatch({ type: 'set-run', runId: null });
  }, [activeDetailCaseId, state.activeRunId]);
  const openCaseDetail = useCallback((caseId: string) => {
    syncActiveDetailCaseId(caseId);
    dispatch({ type: 'open-case', caseId });
  }, [syncActiveDetailCaseId]);
  const closeCaseDetail = useCallback(() => {
    syncActiveDetailCaseId(null);
    dispatch({ type: 'close' });
  }, [syncActiveDetailCaseId]);
  const openRunDetail = useCallback((runId: string, caseId?: string) => {
    if (caseId && caseId !== activeDetailCaseId) syncActiveDetailCaseId(caseId);
    dispatch({ type: 'open-run', runId, caseId });
  }, [activeDetailCaseId, syncActiveDetailCaseId]);
  const backToCaseDetail = useCallback(() => {
    dispatch({ type: 'back-to-case' });
  }, []);
  const setActiveRunId = useCallback((runId: string | null) => {
    dispatch({ type: 'set-run', runId });
  }, []);

  return {
    activeDetailCaseId,
    activeRunId: state.activeRunId,
    backToCaseDetail,
    closeCaseDetail,
    openCaseDetail,
    openRunDetail,
    setActiveRunId,
  };
}

export function DashboardWorkspace({
  activeDetailCaseId: controlledActiveDetailCaseId,
  initialActiveRunId,
  testCases,
  groups,
  schedules,
  selectedGroupId: controlledSelectedGroupId,
  model,
  modelProvider,
  actionsPortalId,
  hideListHeader = false,
  onActiveDetailCaseIdChange,
  onSelectedGroupIdChange,
  showGroupSidebar = true,
  showBrowserChatAction = true,
  showSettingsAction = true,
}: {
  activeDetailCaseId?: string | null;
  initialActiveRunId?: string | null;
  testCases: TestCaseRecord[];
  groups: TestGroupRecord[];
  schedules: RunScheduleRecord[];
  selectedGroupId?: string;
  model?: string;
  modelProvider?: ModelProvider;
  actionsPortalId?: string;
  hideListHeader?: boolean;
  onActiveDetailCaseIdChange?: (caseId: string | null) => void;
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
  const [deletingGroupId, setDeletingGroupId] = useState<string | null>(null);
  const [movingCaseId, setMovingCaseId] = useState<string | null>(null);
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchDefaultRunning, setBatchDefaultRunning] = useState(false);
  const [startingCaseId, setStartingCaseId] = useState<string | null>(null);
  const [startingDefaultCaseId, setStartingDefaultCaseId] = useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleName, setScheduleName] = useState(() => t('定时回归'));
  const [scheduleInterval, setScheduleInterval] = useState(60);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [detailData, setDetailData] = useState<CaseDetailPayload | null>(null);
  const [detailError, setDetailError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [runData, setRunData] = useState<TestRunRecord | null>(null);
  const [runError, setRunError] = useState('');
  const [runLoading, setRunLoading] = useState(false);
  const [detailPanelWidth, setDetailPanelWidth] = useState(820);
  const [actionsPortalElement, setActionsPortalElement] = useState<HTMLElement | null>(null);
  const detailRequestIdRef = useRef(0);
  const runRequestIdRef = useRef(0);
  const selectedGroupId = controlledSelectedGroupId ?? internalSelectedGroupId;
  const selectGroup = onSelectedGroupIdChange ?? setInternalSelectedGroupId;
  const {
    activeDetailCaseId,
    activeRunId,
    backToCaseDetail: setPanelBackToCaseDetail,
    closeCaseDetail: setPanelClosed,
    openCaseDetail: setPanelCaseDetail,
    openRunDetail: setPanelRunDetail,
    setActiveRunId,
  } = useCaseDetailPanelState({
    controlledActiveDetailCaseId,
    initialActiveRunId,
    onActiveDetailCaseIdChange,
  });
  const visibleCases = testCases.filter((item) => item.groupId === selectedGroupId);
  const completedCases = visibleCases.filter((item) => ['passed', 'failed', 'blocked'].includes(item.status));
  const selectedCases = selectedCaseIds
    .map((id) => testCases.find((item) => item.id === id))
    .filter((item): item is TestCaseRecord => Boolean(item));
  const selectedCasesCanRunDefault = selectedCases.length > 0 && selectedCases.every((item) => item.content.defaultRecordedRunId);
  const modelPayload = modelProvider && model ? { modelProvider, model } : {};

  const clampDetailPanelWidth = useCallback((width: number) => {
    if (typeof window === 'undefined') return width;
    const min = window.innerWidth * 0.5;
    const max = Math.max(min, window.innerWidth - 48);
    return Math.min(max, Math.max(min, width));
  }, []);

  const openCaseDetail = useCallback((caseId: string) => {
    setRunData(null);
    setRunError('');
    setPanelCaseDetail(caseId);
  }, [setPanelCaseDetail]);

  const closeCaseDetail = useCallback(() => {
    setPanelClosed();
    setDetailData(null);
    setDetailError('');
    setRunData(null);
    setRunError('');
  }, [setPanelClosed]);

  const openRunDetail = useCallback((runId: string, caseId?: string) => {
    setPanelRunDetail(runId, caseId);
  }, [setPanelRunDetail]);

  const backToCaseDetail = useCallback(() => {
    setPanelBackToCaseDetail();
    setRunData(null);
    setRunError('');
  }, [setPanelBackToCaseDetail]);

  const beginDetailPanelResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // The capture can fail if the pointer is already gone; document-level listeners still cover the drag.
    }
    const startX = event.clientX;
    const startWidth = detailPanelWidth;
    const move = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      setDetailPanelWidth(clampDetailPanelWidth(startWidth + startX - moveEvent.clientX));
    };
    const stop = (stopEvent?: PointerEvent) => {
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', stop, true);
      document.removeEventListener('pointercancel', stop, true);
      document.body.classList.remove('is-resizing-case-panel');
      try {
        handle.releasePointerCapture(stopEvent?.pointerId ?? event.pointerId);
      } catch {
        // Ignore release errors for interrupted drags.
      }
    };
    document.body.classList.add('is-resizing-case-panel');
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', stop, true);
    document.addEventListener('pointercancel', stop, true);
  }, [clampDetailPanelWidth, detailPanelWidth]);

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

  useEffect(() => () => {
    document.body.classList.remove('is-resizing-case-panel');
  }, []);

  useEffect(() => {
    if (!actionsPortalId) {
      setActionsPortalElement(null);
      return;
    }
    setActionsPortalElement(document.getElementById(actionsPortalId));
  }, [actionsPortalId]);

  useEffect(() => {
    if (!activeDetailCaseId) {
      setDetailData(null);
      setDetailError('');
      setDetailLoading(false);
      setActiveRunId(null);
      return;
    }

    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;
    setDetailLoading(true);
    setDetailError('');
    fetch(`/api/test-cases/${activeDetailCaseId}/detail`, { cache: 'no-store' })
      .then(async (response) => {
        const data = await readApiJson<any>(response, t('加载测试用例失败'));
        return data as CaseDetailPayload;
      })
      .then((data) => {
        if (detailRequestIdRef.current !== requestId) return;
        setDetailData(data);
      })
      .catch((error) => {
        if (detailRequestIdRef.current !== requestId) return;
        setDetailData(null);
        setDetailError(error instanceof Error ? error.message : t('加载测试用例失败'));
      })
      .finally(() => {
        if (detailRequestIdRef.current === requestId) setDetailLoading(false);
      });
  }, [activeDetailCaseId, t]);

  useEffect(() => {
    if (!activeRunId) {
      setRunData(null);
      setRunError('');
      setRunLoading(false);
      return;
    }

    const requestId = runRequestIdRef.current + 1;
    runRequestIdRef.current = requestId;
    setRunLoading(true);
    setRunError('');
    fetch(`/api/runs/${activeRunId}`, { cache: 'no-store' })
      .then(async (response) => {
        const data = await readApiJson<any>(response, t('加载执行记录失败'));
        return data as TestRunRecord;
      })
      .then((data) => {
        if (runRequestIdRef.current !== requestId) return;
        setRunData(data);
      })
      .catch((error) => {
        if (runRequestIdRef.current !== requestId) return;
        setRunData(null);
        setRunError(error instanceof Error ? error.message : t('加载执行记录失败'));
      })
      .finally(() => {
        if (runRequestIdRef.current === requestId) setRunLoading(false);
      });
  }, [activeRunId, t]);

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

  async function deleteGroup(group: TestGroupRecord) {
    if (deletingGroupId) return;
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
      ? t('确定删除分组{name}及其 {count} 个子分组吗？这些分组下的测试用例会移回未分组。', { name: `“${group.name}”`, count: childCount })
      : t('确定删除分组{name}吗？这个分组下的测试用例会移回未分组。', { name: `“${group.name}”` });
    if (!window.confirm(message)) return;
    setDeletingGroupId(group.id);
    startGlobalLoading(t('正在删除分组'));
    try {
      const response = await fetch(`/api/groups/${group.id}`, { method: 'DELETE' });
      const data = await readApiJson<any>(response, t('删除分组失败'));
      if (selectedGroupId && descendantIds.has(selectedGroupId)) selectGroup(undefined);
      startTransition(() => router.refresh());
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t('删除分组失败'));
    } finally {
      setDeletingGroupId(null);
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

  async function startCaseRun(testCaseId: string) {
    if (startingCaseId || startingDefaultCaseId) return;
    setStartingCaseId(testCaseId);
    startGlobalLoading(t('正在启动测试'));
    try {
      const response = await fetch(`/api/test-cases/${testCaseId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(modelPayload),
      });
      const data = await readApiJson<any>(response, t('启动失败'));
      if (!data.runId) throw new Error(t('启动失败'));
      setStartingCaseId(null);
      stopGlobalLoading();
      openRunDetail(data.runId, testCaseId);
      startTransition(() => router.refresh());
    } catch (error) {
      setStartingCaseId(null);
      stopGlobalLoading();
      window.alert(error instanceof Error ? error.message : t('启动失败'));
    }
  }

  async function startDefaultRecordedCaseRun(testCase: TestCaseRecord) {
    if (startingCaseId || startingDefaultCaseId) return;
    if (!testCase.content.defaultRecordedRunId) {
      window.alert(t('请先在执行记录中设置默认记录'));
      return;
    }
    setStartingDefaultCaseId(testCase.id);
    startGlobalLoading(t('正在按默认记录执行'));
    try {
      const response = await fetch(`/api/test-cases/${testCase.id}/run-default-recorded`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(modelPayload),
      });
      const data = await readApiJson<any>(response, t('默认记录执行失败'));
      if (!data.runId) throw new Error(t('默认记录执行失败'));
      setStartingDefaultCaseId(null);
      stopGlobalLoading();
      openRunDetail(data.runId, testCase.id);
      startTransition(() => router.refresh());
    } catch (error) {
      setStartingDefaultCaseId(null);
      stopGlobalLoading();
      window.alert(error instanceof Error ? error.message : t('默认记录执行失败'));
    }
  }

  async function startBatchRun() {
    if (!selectedCaseIds.length || batchRunning || batchDefaultRunning) return;
    setBatchRunning(true);
    startGlobalLoading(t('正在批量启动测试'));
    const openedTabs = selectedCaseIds.map(() => window.open('about:blank', '_blank'));
    try {
      const response = await fetch('/api/runs/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCaseIds: selectedCaseIds, ...modelPayload }),
      });
      const data = await readApiJson<any>(response, t('批量运行启动失败'));
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

  async function startBatchDefaultRecordedRun() {
    if (!selectedCaseIds.length || batchDefaultRunning || batchRunning) return;
    const missingDefaultRuns = selectedCases.filter((item) => !item.content.defaultRecordedRunId);
    if (missingDefaultRuns.length) {
      window.alert(t('选中的用例中有 {count} 条没有默认记录，请先在执行记录中设置默认记录。', { count: missingDefaultRuns.length }));
      return;
    }

    setBatchDefaultRunning(true);
    startGlobalLoading(t('正在按默认记录批量执行'));
    const openedTabs = selectedCaseIds.map(() => window.open('about:blank', '_blank'));
    const navigatedTabs = new Set<number>();
    try {
      for (const [index, testCaseId] of selectedCaseIds.entries()) {
        const response = await fetch(`/api/test-cases/${testCaseId}/run-default-recorded`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(modelPayload),
        });
        const data = await readApiJson<any>(response, t('默认记录执行失败'));
      if (!data.runId) throw new Error(t('默认记录执行失败'));
        const url = `/runs/${data.runId}`;
        const tab = openedTabs[index];
        if (tab) {
          tab.location.href = url;
          navigatedTabs.add(index);
        } else {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
      }
      setSelectedCaseIds([]);
      startTransition(() => router.refresh());
    } catch (error) {
      openedTabs.forEach((tab, index) => {
        if (!navigatedTabs.has(index)) tab?.close();
      });
      window.alert(error instanceof Error ? error.message : t('默认记录执行失败'));
    } finally {
      setBatchDefaultRunning(false);
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
      const data = await readApiJson<any>(response, t('批量删除失败'));
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

  const dashboardActions = (
    <div className="dashboard-actions">
      {showBrowserChatAction ? (
        <Link aria-label={t('对话操作')} className="icon-button dashboard-action-icon" href="/browser-chat" title={t('对话操作')}>
          <MessageSquare size={15} />
        </Link>
      ) : null}
      {showSettingsAction ? (
        <Link aria-label={t('环境配置')} className="icon-button dashboard-action-icon" href="/settings" title={t('环境配置')}>
          <Settings size={15} />
        </Link>
      ) : null}
      <button
        aria-label={selectedCaseIds.length ? t('AI运行 {count} 条', { count: selectedCaseIds.length }) : t('AI运行')}
        className="icon-button dashboard-action-icon"
        disabled={!selectedCaseIds.length || batchRunning || batchDefaultRunning}
        onClick={startBatchRun}
        title={selectedCaseIds.length ? t('AI运行 {count} 条', { count: selectedCaseIds.length }) : t('AI运行')}
        type="button"
      >
        {batchRunning ? <Loader2 className="spin" size={15} /> : <Play size={15} />}
      </button>
      <button
        aria-label={selectedCaseIds.length ? t('默认用例执行 {count} 条', { count: selectedCaseIds.length }) : t('默认用例执行')}
        className="icon-button dashboard-action-icon"
        disabled={!selectedCasesCanRunDefault || batchDefaultRunning || batchRunning}
        onClick={startBatchDefaultRecordedRun}
        title={selectedCasesCanRunDefault ? (selectedCaseIds.length ? t('默认用例执行 {count} 条', { count: selectedCaseIds.length }) : t('按当前默认记录执行')) : t('请先在执行记录中设置默认记录')}
        type="button"
      >
        {batchDefaultRunning ? <Loader2 className="spin" size={15} /> : <RotateCcw size={15} />}
      </button>
      <button
        aria-label={selectedCaseIds.length ? t('批量删除 {count} 条', { count: selectedCaseIds.length }) : t('批量删除')}
        className="icon-button dashboard-action-icon danger"
        disabled={!selectedCaseIds.length || batchDeleting}
        onClick={deleteSelectedCases}
        title={selectedCaseIds.length ? t('批量删除 {count} 条', { count: selectedCaseIds.length }) : t('批量删除')}
        type="button"
      >
        {batchDeleting ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
      </button>
      <button aria-label={t('定时任务')} className="icon-button dashboard-action-icon" disabled={!visibleCases.length} onClick={() => setScheduleOpen(true)} title={t('定时任务')} type="button">
        <CalendarClock size={15} />
      </button>
      <NewTestCaseModal
        groupId={selectedGroupId}
        iconOnly
        onCreated={(testCaseId) => {
          openCaseDetail(testCaseId);
          startTransition(() => router.refresh());
        }}
      />
    </div>
  );

  return (
    <section className={showGroupSidebar ? 'dashboard-folder-layout' : 'dashboard-folder-layout no-sidebar'}>
      {actionsPortalElement ? createPortal(dashboardActions, actionsPortalElement) : null}
      {showGroupSidebar ? (
        <DashboardGroupSidebar
          deletingGroupId={deletingGroupId}
          groups={groups}
          selectedGroupId={selectedGroupId}
          onDeleteGroup={deleteGroup}
          onCreateGroup={() => setGroupDialogOpen(true)}
          onSelect={selectGroup}
        />
      ) : null}

      <div className="dashboard-v2-list">
        {hideListHeader ? null : (
          <div className="plain-section-head">
            <div>
              <h2>{selectedGroupId ? groupPath(groups, selectedGroupId) : t('未分组')}</h2>
              <span>{t('{total} 条，已完成 {completed} 条', { total: visibleCases.length, completed: completedCases.length })}</span>
            </div>
            {actionsPortalId ? null : dashboardActions}
          </div>
        )}
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
              <div
                className="case-table-row case-table-row-managed"
                key={item.id}
                onClick={(event) => {
                  const target = event.target;
                  if (target instanceof HTMLElement && target.closest('button, input, a, [role="listbox"]')) return;
                  openCaseDetail(item.id);
                }}
              >
                <input
                  aria-label={t('选择 {name}', { name: item.title })}
                  checked={selectedCaseIds.includes(item.id)}
                  onChange={() => toggleCase(item.id)}
                  type="checkbox"
                />
                <button className="case-table-row-open" onClick={() => openCaseDetail(item.id)} type="button">
                  <strong>{item.title}</strong>
                  <p>{richTextToPlainText(item.content.userRequirement || item.description) || item.description}</p>
                </button>
                <span className={`badge status-${item.status}`}>{t(statusLabel(item.status))}</span>
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
                  {movingCaseId === item.id ? <Loader2 className="spin" size={16} /> : null}
                  <button
                    aria-label={t('AI运行')}
                    className="case-row-icon-button"
                    disabled={Boolean(startingCaseId || startingDefaultCaseId)}
                    onClick={() => void startCaseRun(item.id)}
                    title={t('AI运行')}
                    type="button"
                  >
                    {startingCaseId === item.id ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
                  </button>
                  <button
                    aria-label={t('默认用例执行')}
                    className="case-row-icon-button"
                    disabled={Boolean(startingCaseId || startingDefaultCaseId || !item.content.defaultRecordedRunId)}
                    onClick={() => void startDefaultRecordedCaseRun(item)}
                    title={item.content.defaultRecordedRunId ? t('按当前默认记录执行') : t('请先在执行记录中设置默认记录')}
                    type="button"
                  >
                    {startingDefaultCaseId === item.id ? <Loader2 className="spin" size={14} /> : <RotateCcw size={14} />}
                  </button>
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
      {activeDetailCaseId ? (
        <>
        <div className="dashboard-detail-backdrop" onClick={closeCaseDetail} role="presentation" />
        <aside
          aria-label={t('测试用例详情')}
          className="dashboard-detail-shell"
          style={{ '--case-detail-panel-width': `${detailPanelWidth}px` } as CSSProperties}
        >
          <div
            aria-label={t('调整详情侧栏宽度')}
            aria-orientation="vertical"
            className="dashboard-detail-resizer"
            onPointerDown={beginDetailPanelResize}
            role="separator"
          />
          {activeRunId ? (
            runLoading ? (
              <div className="dashboard-detail-state">
                <Loader2 className="spin" size={18} />
                <span>{t('正在加载执行记录')}</span>
              </div>
            ) : runError ? (
              <div className="dashboard-detail-state">
                <strong>{runError}</strong>
                <button className="icon-text-button" onClick={backToCaseDetail} type="button">
                  <ArrowLeft size={15} />
                  {t('返回测试用例')}
                </button>
              </div>
            ) : runData ? (
              <section className="run-panel-workspace">
                <header className="run-panel-header">
                  <button className="ghost-link" onClick={backToCaseDetail} type="button">
                    <ArrowLeft size={15} />
                    {t('返回测试用例')}
                  </button>
                  <button aria-label={t('关闭')} className="icon-button case-detail-close-button" onClick={closeCaseDetail} title={t('关闭')} type="button">
                    <X size={17} />
                  </button>
                </header>
                <RunProgress
                  browserMode={(detailData?.testCase || testCases.find((item) => item.id === runData.testCaseId))?.content.browserMode}
                  initialRun={runData}
                  testCaseTitle={(detailData?.testCase || testCases.find((item) => item.id === runData.testCaseId))?.title || '未知用例'}
                />
              </section>
            ) : null
          ) : detailLoading ? (
            <div className="dashboard-detail-state">
              <Loader2 className="spin" size={18} />
              <span>{t('正在加载测试用例')}</span>
            </div>
          ) : detailError ? (
            <div className="dashboard-detail-state">
              <strong>{detailError}</strong>
              <button className="icon-text-button" onClick={closeCaseDetail} type="button">
                <X size={15} />
                {t('关闭')}
              </button>
            </div>
          ) : detailData ? (
            <TestCaseDetailWorkspace
              initialModel={model}
              initialModelProvider={modelProvider}
              onClose={closeCaseDetail}
              onDeleted={() => {
                closeCaseDetail();
                startTransition(() => router.refresh());
              }}
              onOpenRun={openRunDetail}
              onSaved={(updated) => {
                setDetailData((current) => current ? { ...current, testCase: updated } : current);
              }}
              runs={detailData.runs}
              skills={detailData.skills}
              testCase={detailData.testCase}
              variant="panel"
            />
          ) : null}
        </aside>
        </>
      ) : null}
    </section>
  );
}
