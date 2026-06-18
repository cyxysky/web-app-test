import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { RunProgress } from '@/components/RunProgress';
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
    <main className="run-workspace">
      <header className="run-inline-header">
        <Link className="ghost-link" href={testCase ? `/test-cases/${testCase.id}` : '/dashboard'}>
          <ArrowLeft size={15} />
          返回用例
        </Link>
        <div className="run-inline-actions" />
      </header>

      <RunProgress browserMode={testCase?.content.browserMode} initialRun={run} testCaseTitle={testCase?.title || '未知用例'} />
    </main>
  );
}
