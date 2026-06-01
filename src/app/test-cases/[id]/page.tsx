import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Clock3, ExternalLink, FileText } from 'lucide-react';
import { TestCaseEditor } from '@/components/TestCaseEditor';
import { RunTestButton } from '@/components/RunTestButton';
import { store } from '@/server/db/mock-store';
import type { TestRunRecord } from '@/server/ai/schemas/test-case.schema';

export const dynamic = 'force-dynamic';

type PageProps = {
  params: Promise<{ id: string }>;
};

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

export default async function TestCaseDetailPage({ params }: PageProps) {
  const { id } = await params;
  const testCase = store.getTestCase(id);
  if (!testCase) notFound();
  const runs = store.listRunsForTestCase(id);
  const finishedRuns = runs.filter((run) => ['passed', 'failed', 'blocked'].includes(run.status)).length;
  const latestRun = runs[0];

  return (
    <main className="case-workspace">
      <header className="case-inline-header">
        <Link className="ghost-link" href="/dashboard">
          <ArrowLeft size={15} />
          工作台
        </Link>
        <RunTestButton testCaseId={id} />
      </header>

      <TestCaseEditor testCase={testCase} />

      <section className="content-band run-history-panel">
        <div className="section-head compact">
          <div>
            <h2>执行记录</h2>
            <p>
              {latestRun
                ? `最近一次：${formatRunTime(latestRun.startedAt || latestRun.createdAt)}`
                : '运行后会在这里保留详情入口。'}
            </p>
          </div>
          <div className="run-history-summary">
            <span>{runs.length} 次运行</span>
            <span>{finishedRuns} 次完成</span>
          </div>
        </div>

        {runs.length ? (
          <div className="run-history-list">
            {runs.map((run) => {
              const completedStepCount = run.result?.steps.filter((step) => step.status !== 'queued').length || 0;
              const totalStepCount = run.result?.steps.length || 0;
              const startedAt = formatRunTime(run.startedAt || run.createdAt);
              const endedAt = run.endedAt ? formatRunTime(run.endedAt) : undefined;
              return (
                <Link className="run-history-row" href={`/runs/${run.id}`} key={run.id}>
                  <span className={`run-history-status status-${run.status}`}>{runStatusLabel(run.status)}</span>
                  <span className="run-history-main">
                    <strong>{run.report?.title || `运行 ${run.id}`}</strong>
                    <small className="run-history-id">{run.id}</small>
                  </span>
                  <span className="run-history-time">
                    <Clock3 size={14} />
                    {startedAt}
                    {endedAt ? <span>至 {endedAt}</span> : <span>未结束</span>}
                  </span>
                  <span className="run-history-meta">
                    <b>{totalStepCount ? `${completedStepCount}/${totalStepCount}` : '-'}</b>
                    步骤
                  </span>
                  <span className={run.report ? 'run-history-report ready' : 'run-history-report'}>
                    <FileText size={14} />
                    {run.report ? '报告已生成' : '报告生成中'}
                  </span>
                  <ExternalLink className="run-history-open" size={16} />
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="empty-state">这个用例还没有执行记录。</div>
        )}
      </section>
    </main>
  );
}
