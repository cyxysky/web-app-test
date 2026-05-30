import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { TestCaseEditor } from '@/components/TestCaseEditor';
import { RunTestButton } from '@/components/RunTestButton';
import { store } from '@/server/db/mock-store';

export const dynamic = 'force-dynamic';

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function TestCaseDetailPage({ params }: PageProps) {
  const { id } = await params;
  const testCase = store.getTestCase(id);
  if (!testCase) notFound();

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
    </main>
  );
}
