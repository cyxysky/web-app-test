'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { BadgeCheck, Clock3, ExternalLink, FileText, Loader2, Sparkles, Star, Trash2 } from 'lucide-react';
import { DeleteRunButton } from '@/components/DeleteRunButton';
import { RecordedFlowToCaseButton } from '@/components/RecordedFlowToCaseButton';
import { RunScreenshotChainButton } from '@/components/RunScreenshotChain';
import { useI18n } from '@/i18n/I18nProvider';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';
import type { TestRunRecord } from '@/server/ai/schemas/test-case.schema';
import { readApiJson } from '@/lib/api-client';

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

function formatRunTime(value?: string, language: 'zh' | 'en' = 'zh') {
  if (!value) return language === 'en' ? 'Not started' : '未开始';
  return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function RunHistoryList({
  defaultRecordedRunId,
  onOpenRun,
  runs,
  testCaseId,
}: {
  defaultRecordedRunId?: string;
  onOpenRun?: (runId: string) => void;
  runs: TestRunRecord[];
  testCaseId: string;
}) {
  const { language, t } = useI18n();
  const router = useRouter();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [settingDefaultRunId, setSettingDefaultRunId] = useState<string | null>(null);
  const [generatingSkillRunId, setGeneratingSkillRunId] = useState<string | null>(null);
  const latestRun = runs[0];
  const finishedRuns = runs.filter((run) => finishedRunStatuses.includes(run.status)).length;
  const deletableIds = useMemo(() => runs.map((run) => run.id), [runs]);
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
    if (!window.confirm(t('确定删除选中的 {count} 条执行记录吗？', { count: runIds.length }))) return;
    setDeleting(true);
    startGlobalLoading(t('正在删除执行记录'));
    try {
      const response = await fetch('/api/runs/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runIds }),
      });
      const data = await readApiJson<any>(response, t('批量删除失败'));
      setSelectedIds([]);
      router.refresh();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t('批量删除失败'));
    } finally {
      setDeleting(false);
      stopGlobalLoading();
    }
  }

  async function setDefaultRecordedRun(runId: string) {
    if (settingDefaultRunId) return;
    setSettingDefaultRunId(runId);
    startGlobalLoading(t('正在设置默认记录'));
    try {
      const response = await fetch(`/api/test-cases/${testCaseId}/default-recorded-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId }),
      });
      const data = await readApiJson<any>(response, t('设置默认记录失败'));
      router.refresh();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t('设置默认记录失败'));
    } finally {
      setSettingDefaultRunId(null);
      stopGlobalLoading();
    }
  }

  async function generateSkill(runId: string) {
    if (generatingSkillRunId) return;
    setGeneratingSkillRunId(runId);
    startGlobalLoading(t('正在生成 Skill'));
    try {
      const response = await fetch(`/api/runs/${runId}/skills`, { method: 'POST' });
      const data = await readApiJson<any>(response, t('生成 Skill 失败'));
      router.refresh();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t('生成 Skill 失败'));
    } finally {
      setGeneratingSkillRunId(null);
      stopGlobalLoading();
    }
  }

  return (
    <>
      <div className="section-head compact run-history-head">
        <div className="run-history-title-copy">
          <h2>执行记录</h2>
          <p title={latestRun ? t('最近一次：{time}', { time: formatRunTime(latestRun.startedAt || latestRun.createdAt, language) }) : t('运行后会在这里保留详情入口。')}>
            {latestRun ? t('最近一次：{time}', { time: formatRunTime(latestRun.startedAt || latestRun.createdAt, language) }) : t('运行后会在这里保留详情入口。')}
          </p>
        </div>
        <div className="run-history-toolbar">
          <div className="run-history-summary">
            <span title={t('{count} 次运行', { count: runs.length })}>{t('{count} 次运行', { count: runs.length })}</span>
            <span title={t('{count} 次完成', { count: finishedRuns })}>{t('{count} 次完成', { count: finishedRuns })}</span>
          </div>
          <button className="run-history-bulk-delete" disabled={!selectedIds.length || deleting} onClick={deleteSelected} type="button">
            {deleting ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
            {selectedIds.length ? `${t('删除选中')} ${selectedIds.length}` : t('删除选中')}
          </button>
        </div>
      </div>

      {runs.length ? (
        <div className="run-history-list">
          <label className="run-history-select-all">
            <input checked={allSelected} disabled={!deletableIds.length || deleting} onChange={toggleAll} type="checkbox" />
            <span title={deletableIds.length ? t('全选执行记录') : t('暂无执行记录')}>{deletableIds.length ? t('全选执行记录') : t('暂无执行记录')}</span>
          </label>
          {runs.map((run) => {
            const completedStepCount = run.result?.steps.filter((step) => step.status !== 'queued').length || 0;
            const totalStepCount = run.result?.steps.length || 0;
            const replayable = Boolean(run.result?.steps.some((step) => step.tools?.some((tool) => tool.name && tool.ok !== false)));
            const startedAt = formatRunTime(run.startedAt || run.createdAt, language);
            const endedAt = run.endedAt ? formatRunTime(run.endedAt, language) : undefined;
            const active = isActiveRun(run);
            const selected = selectedSet.has(run.id);
            const isDefaultRecordedRun = run.id === defaultRecordedRunId;
            const skillable = !active && Boolean(run.result?.steps?.length);
            const reportText = run.report ? t('报告已生成') : t('报告生成中');
            return (
              <div className={selected ? 'run-history-row selected' : 'run-history-row'} key={run.id}>
                <label className="run-history-select" title={t('选择这条执行记录')}>
                  <input checked={selected} disabled={deleting} onChange={() => toggleRun(run.id)} type="checkbox" />
                </label>
                <span className={`run-history-status status-${run.status}`} title={t(runStatusLabel(run.status))}>
                  {t(runStatusLabel(run.status))}
                </span>
                <span className="run-history-main">
                  <strong title={run.report?.title || t('运行 {id}', { id: run.id })}>{run.report?.title || t('运行 {id}', { id: run.id })}</strong>
                  <small className="run-history-id" title={run.id}>{run.id}</small>
                </span>
                <span className="run-history-time" title={endedAt ? `${startedAt} ${t('至')} ${endedAt}` : `${startedAt}${language === 'en' ? ', ' : '，'}${t('未结束')}`}>
                  <Clock3 size={14} />
                  {startedAt}
                  {endedAt ? <span>{t('至')} {endedAt}</span> : <span>{t('未结束')}</span>}
                </span>
                <span className="run-history-actions">
                  <button
                    aria-label={isDefaultRecordedRun ? t('当前默认记录') : t('设为默认记录')}
                    className={isDefaultRecordedRun ? 'run-history-replay default-record selected' : 'run-history-replay default-record'}
                    disabled={!replayable || active || isDefaultRecordedRun || Boolean(settingDefaultRunId)}
                    onClick={() => setDefaultRecordedRun(run.id)}
                    title={isDefaultRecordedRun ? t('当前默认记录') : t('设为默认记录')}
                    type="button"
                  >
                    {settingDefaultRunId === run.id ? <Loader2 className="spin" size={14} /> : isDefaultRecordedRun ? <BadgeCheck size={14} /> : <Star size={14} />}
                  </button>
                  <RunScreenshotChainButton className="run-history-replay" run={run} />
                  <RecordedFlowToCaseButton disabled={!replayable || active} runId={run.id} />
                  <button
                    aria-label={t('从这条执行记录生成 Skill')}
                    className="run-history-replay"
                    disabled={!skillable || Boolean(generatingSkillRunId)}
                    onClick={() => void generateSkill(run.id)}
                    title={t('从这条执行记录生成 Skill')}
                    type="button"
                  >
                    {generatingSkillRunId === run.id ? <Loader2 className="spin" size={14} /> : <Sparkles size={14} />}
                  </button>
                  <DeleteRunButton disabled={deleting} runId={run.id} />
                  <button aria-label={t('查看详情')} className="run-history-open" onClick={() => (onOpenRun ? onOpenRun(run.id) : router.push(`/runs/${run.id}`))} title={t('查看详情')} type="button">
                    <ExternalLink size={16} />
                  </button>
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
