import { BrowserChatWorkspace } from '@/components/BrowserChatWorkspace';
import { startScheduler } from '@/server/ai/agents/test-runner.service';
import { store } from '@/server/db/store';

export const dynamic = 'force-dynamic';

type PageProps = {
  searchParams: Promise<{ caseId?: string | string[] }>;
};

export default async function DashboardPage({ searchParams }: PageProps) {
  const { caseId } = await searchParams;
  store.applyRuntimeEnv();
  startScheduler();
  const testCases = store.listTestCases();
  const groups = store.listGroups();
  const schedules = store.listSchedules();

  return (
    <main className="browser-chat-shell">
      <BrowserChatWorkspace
        groups={groups}
        initialTargetDetailCaseId={typeof caseId === 'string' ? caseId : undefined}
        initialView="target"
        schedules={schedules}
        testCases={testCases}
      />
    </main>
  );
}
