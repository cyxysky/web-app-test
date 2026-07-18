import { BrowserChatWorkspace } from '@/components/BrowserChatWorkspace';
import { store } from '@/server/db/store';
import { readEnvironmentSettingsSnapshot } from '@/server/settings/settings-snapshot';

export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  store.applyRuntimeEnv();
  const initialSettings = readEnvironmentSettingsSnapshot();

  return (
    <main className="browser-chat-shell">
      <BrowserChatWorkspace
        initialSettings={initialSettings}
        initialView="settings"
      />
    </main>
  );
}
