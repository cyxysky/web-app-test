import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { DeleteTestCaseButton } from '@/components/DeleteTestCaseButton';
import { RunHistoryList } from '@/components/RunHistoryList';
import { RunTestButton } from '@/components/RunTestButton';
import { SiteKnowledgePanel } from '@/components/SiteKnowledgePanel';
import { TestCaseEditor } from '@/components/TestCaseEditor';
import { store } from '@/server/db/sqlite-store';

export const dynamic = 'force-dynamic';

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function TestCaseDetailPage({ params }: PageProps) {
  const { id } = await params;
  const testCase = await store.getTestCase(id);
  if (!testCase) notFound();
  const [runs, siteKnowledge] = await Promise.all([
    store.listRunsForTestCase(id),
    store.getSiteKnowledgeForUrl(testCase.targetUrl),
  ]);

  return (
    <main className="case-workspace">
      <header className="case-inline-header">
        <Link className="ghost-link" href="/dashboard">
          <ArrowLeft size={15} />
          工作台
        </Link>
        <div className="case-inline-actions">
          <RunTestButton testCaseId={id} />
          <DeleteTestCaseButton redirectTo="/dashboard" testCaseId={id} testCaseTitle={testCase.title} />
        </div>
      </header>

      <TestCaseEditor testCase={testCase} />
      <SiteKnowledgePanel initialKnowledge={siteKnowledge} targetUrl={testCase.targetUrl} />

      <section className="content-band run-history-panel">
        <RunHistoryList runs={runs} />
      </section>
    </main>
  );
}
