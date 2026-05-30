import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, Play } from 'lucide-react';
import { TestCaseEditor } from '@/components/TestCaseEditor';
import { startTestCaseRun } from '@/server/ai/agents/test-runner.service';
import { store } from '@/server/db/mock-store';

export const dynamic = 'force-dynamic';

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function TestCaseDetailPage({ params }: PageProps) {
  const { id } = await params;
  const testCase = store.getTestCase(id);
  if (!testCase) notFound();

  async function runAction() {
    'use server';
    const run = startTestCaseRun(id);
    redirect(`/runs/${run.id}`);
  }

  return (
    <main className="case-workspace">
      <header className="case-inline-header">
        <Link className="ghost-link" href="/dashboard">
          <ArrowLeft size={15} />
          工作台
        </Link>
        <form action={runAction}>
          <button className="icon-text-button" type="submit">
            <Play size={16} />
            启动 AI 浏览器测试
          </button>
        </form>
      </header>

      <TestCaseEditor testCase={testCase} />
    </main>
  );
}
