import { BrowserChatWorkspace } from '@/components/BrowserChatWorkspace';
import { store } from '@/server/db/store';
import { readEnvironmentSettingsSnapshot } from '@/server/settings/settings-snapshot';

export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  store.applyRuntimeEnv();
  const testCases = store.listTestCases();
  const groups = store.listGroups();
  const schedules = store.listSchedules();
  const initialSettings = readEnvironmentSettingsSnapshot();

  return (
    <main className="browser-chat-shell">
      <BrowserChatWorkspace
        groups={groups}
        initialSettings={initialSettings}
        initialView="settings"
        schedules={schedules}
        testCases={testCases}
      />
    </main>
  );
}
