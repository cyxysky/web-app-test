import { BrowserChatWorkspace } from '@/components/BrowserChatWorkspace';
import { startScheduler } from '@/server/ai/agents/test-runner.service';
import { store } from '@/server/db/mock-store';

export const dynamic = 'force-dynamic';

export default function DashboardPage() {
  store.applyRuntimeEnv();
  startScheduler();
  const testCases = store.listTestCases();
  const groups = store.listGroups();
  const schedules = store.listSchedules();

  return (
    <main className="browser-chat-shell">
      <BrowserChatWorkspace groups={groups} schedules={schedules} testCases={testCases} />
    </main>
  );
}
