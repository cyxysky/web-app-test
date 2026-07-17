import { notFound } from 'next/navigation';
import { BrowserChatWorkspace } from '@/components/BrowserChatWorkspace';
import { store } from '@/server/db/store';

export const dynamic = 'force-dynamic';

type PageProps = {
  params: Promise<{ runId: string }>;
};

export default async function RunReportPage({ params }: PageProps) {
  const { runId } = await params;
  const run = store.getRun(runId);
  if (!run) notFound();

  const testCase = store.getTestCase(run.testCaseId);
  const testCases = store.listTestCases();
  const groups = store.listGroups();
  const schedules = store.listSchedules();

  return (
    <main className="browser-chat-shell">
      <BrowserChatWorkspace
        groups={groups}
        initialTargetDetailCaseId={testCase?.id || run.testCaseId}
        initialTargetRunId={run.id}
        initialView="target"
        schedules={schedules}
        testCases={testCases}
      />
    </main>
  );
}
