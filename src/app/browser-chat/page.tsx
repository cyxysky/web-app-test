import { BrowserChatWorkspace } from '@/components/BrowserChatWorkspace';
import { startScheduler } from '@/server/ai/agents/test-runner.service';
import { store } from '@/server/db/sqlite-store';

export const dynamic = 'force-dynamic';

export default async function BrowserChatPage() {
  await store.applyRuntimeEnv();
  startScheduler();
  const [testCases, groups, schedules] = await Promise.all([
    store.listTestCases(),
    store.listGroups(),
    store.listSchedules(),
  ]);

  return (
    <main className="browser-chat-shell">
      <BrowserChatWorkspace groups={groups} schedules={schedules} testCases={testCases} />
    </main>
  );
}
