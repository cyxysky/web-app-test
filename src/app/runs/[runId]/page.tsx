import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { MarkdownReport } from '@/components/MarkdownReport';
import { store } from '@/server/db/mock-store';

export const dynamic = 'force-dynamic';

type PageProps = {
  params: Promise<{ runId: string }>;
};

export default async function RunReportPage({ params }: PageProps) {
  const { runId } = await params;
  const run = store.getRun(runId);
  if (!run) notFound();

  const testCase = store.getTestCase(run.testCaseId);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Run Report</p>
          <h1 className="page-title">{run.report?.title || '测试运行报告'}</h1>
          <p className="page-subtitle">运行 ID：{run.id}</p>
        </div>
        <Link className="button secondary" href={testCase ? `/test-cases/${testCase.id}` : '/dashboard'}>
          <ArrowLeft size={16} />
          返回用例
        </Link>
      </header>

      <section className="report-layout">
        <aside className="panel">
          <div className="panel-heading">
            <h2>运行状态</h2>
            <span className={`badge status-${run.status}`}>{run.status}</span>
          </div>
          <dl className="info-list">
            <div>
              <dt>开始时间</dt>
              <dd>{run.startedAt || '-'}</dd>
            </div>
            <div>
              <dt>结束时间</dt>
              <dd>{run.endedAt || '-'}</dd>
            </div>
            <div>
              <dt>步骤数</dt>
              <dd>{run.result?.steps.length || 0}</dd>
            </div>
          </dl>
        </aside>
        <article className="panel report">
          {run.report?.markdown ? <MarkdownReport markdown={run.report.markdown} /> : '报告生成中。'}
        </article>
      </section>
    </main>
  );
}
