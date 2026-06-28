import { BrowserChatWorkspace } from '@/components/BrowserChatWorkspace';
import { store } from '@/server/db/mock-store';

export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  store.applyRuntimeEnv();
  const testCases = store.listTestCases();
  const groups = store.listGroups();
  const schedules = store.listSchedules();

  return (
    <main className="browser-chat-shell">
      <BrowserChatWorkspace groups={groups} initialView="settings" schedules={schedules} testCases={testCases} />
    </main>
  );
}
