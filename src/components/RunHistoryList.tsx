'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Clock3, ExternalLink, FileText, Loader2, Trash2 } from 'lucide-react';
import { DeleteRunButton } from '@/components/DeleteRunButton';
import { ReplayRunButton } from '@/components/ReplayRunButton';
import { RecordedFlowToCaseButton } from '@/components/RecordedFlowToCaseButton';
import { RunScreenshotChainButton } from '@/components/RunScreenshotChain';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';
import type { TestRunRecord } from '@/server/ai/schemas/test-case.schema';

const activeRunStatuses: TestRunRecord['status'][] = ['running', 'queued', 'paused'];
const finishedRunStatuses: TestRunRecord['status'][] = ['passed', 'failed', 'blocked'];

function isActiveRun(run: TestRunRecord) {
  return activeRunStatuses.includes(run.status);
}

function runStatusLabel(status: TestRunRecord['status']) {
  const labels: Record<TestRunRecord['status'], string> = {
    queued: '排队中',
    running: '执行中',
    paused: '已暂停',
    passed: '已通过',
    failed: '未通过',
    blocked: '已阻塞',
  };
  return labels[status];
}

function formatRunTime(value?: string) {
  if (!value) return '未开始';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function RunHistoryList({ runs }: { runs: TestRunRecord[] }) {
  const router = useRouter();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const latestRun = runs[0];
  const finishedRuns = runs.filter((run) => finishedRunStatuses.includes(run.status)).length;
  const deletableIds = useMemo(() => runs.filter((run) => !isActiveRun(run)).map((run) => run.id), [runs]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allSelected = deletableIds.length > 0 && deletableIds.every((runId) => selectedSet.has(runId));

  function toggleRun(runId: string) {
    setSelectedIds((current) => (current.includes(runId) ? current.filter((id) => id !== runId) : [...current, runId]));
  }

  function toggleAll() {
    setSelectedIds(allSelected ? [] : deletableIds);
  }

  async function deleteSelected() {
    const runIds = selectedIds.filter((runId) => deletableIds.includes(runId));
    if (!runIds.length || deleting) return;
    if (!window.confirm(`确定删除选中的 ${runIds.length} 条执行记录吗？`)) return;
    setDeleting(true);
    startGlobalLoading('正在删除执行记录');
    try {
      const response = await fetch('/api/runs/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runIds }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || '批量删除失败');
      setSelectedIds([]);
      router.refresh();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '批量删除失败');
    } finally {
      setDeleting(false);
      stopGlobalLoading();
    }
  }

  return (
    <>
      <div className="section-head compact run-history-head">
        <div className="run-history-title-copy">
          <h2>执行记录</h2>
          <p title={latestRun ? `最近一次：${formatRunTime(latestRun.startedAt || latestRun.createdAt)}` : '运行后会在这里保留详情入口。'}>
            {latestRun ? `最近一次：${formatRunTime(latestRun.startedAt || latestRun.createdAt)}` : '运行后会在这里保留详情入口。'}
          </p>
        </div>
        <div className="run-history-toolbar">
          <div className="run-history-summary">
            <span title={`${runs.length} 次运行`}>{runs.length} 次运行</span>
            <span title={`${finishedRuns} 次完成`}>{finishedRuns} 次完成</span>
          </div>
          <button className="run-history-bulk-delete" disabled={!selectedIds.length || deleting} onClick={deleteSelected} type="button">
            {deleting ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
            {selectedIds.length ? `删除选中 ${selectedIds.length}` : '删除选中'}
          </button>
        </div>
      </div>

      {runs.length ? (
        <div className="run-history-list">
          <label className="run-history-select-all">
            <input checked={allSelected} disabled={!deletableIds.length || deleting} onChange={toggleAll} type="checkbox" />
            <span title={deletableIds.length ? '全选可删除记录' : '暂无可删除记录'}>{deletableIds.length ? '全选可删除记录' : '暂无可删除记录'}</span>
          </label>
          {runs.map((run) => {
            const completedStepCount = run.result?.steps.filter((step) => step.status !== 'queued').length || 0;
            const totalStepCount = run.result?.steps.length || 0;
            const replayable = Boolean(run.result?.steps.some((step) => step.tools?.some((tool) => tool.name && tool.ok !== false)));
            const startedAt = formatRunTime(run.startedAt || run.createdAt);
            const endedAt = run.endedAt ? formatRunTime(run.endedAt) : undefined;
            const active = isActiveRun(run);
            const selected = selectedSet.has(run.id);
            const reportText = run.report ? '报告已生成' : '报告生成中';
            return (
              <div className={selected ? 'run-history-row selected' : 'run-history-row'} key={run.id}>
                <label className="run-history-select" title={active ? '运行中的记录不能删除' : '选择这条执行记录'}>
                  <input checked={selected} disabled={active || deleting} onChange={() => toggleRun(run.id)} type="checkbox" />
                </label>
                <span className={`run-history-status status-${run.status}`} title={runStatusLabel(run.status)}>
                  {runStatusLabel(run.status)}
                </span>
                <span className="run-history-main">
                  <strong title={run.report?.title || `运行 ${run.id}`}>{run.report?.title || `运行 ${run.id}`}</strong>
                  <small className="run-history-id" title={run.id}>{run.id}</small>
                </span>
                <span className="run-history-time" title={endedAt ? `${startedAt} 至 ${endedAt}` : `${startedAt}，未结束`}>
                  <Clock3 size={14} />
                  {startedAt}
                  {endedAt ? <span>至 {endedAt}</span> : <span>未结束</span>}
                </span>
                <span className="run-history-meta" title={`${totalStepCount ? `${completedStepCount}/${totalStepCount}` : '-'} 步骤`}>
                  <b>{totalStepCount ? `${completedStepCount}/${totalStepCount}` : '-'}</b>
                  步骤
                </span>
                <span className={run.report ? 'run-history-report ready' : 'run-history-report'} title={reportText}>
                  <FileText size={14} />
                  {reportText}
                </span>
                <span className="run-history-actions">
                  <RunScreenshotChainButton className="run-history-replay" run={run} />
                  <ReplayRunButton disabled={!replayable || active} runId={run.id} />
                  <RecordedFlowToCaseButton disabled={!replayable || active} runId={run.id} />
                  <DeleteRunButton disabled={active || deleting} runId={run.id} />
                  <Link className="run-history-open" href={`/runs/${run.id}`} title="查看详情">
                    <ExternalLink size={16} />
                  </Link>
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty-state">这个用例还没有执行记录。</div>
      )}
    </>
  );
}
