import { BrowserChatWorkspace } from '@/components/BrowserChatWorkspace';
import { defaultApplicationUserId } from '@/server/auth/user-context';
import { store } from '@/server/db/store';
import { readEnvironmentSettingsSnapshot } from '@/server/settings/settings-snapshot';
import { adminSettingsPasswordEnabled } from '@/server/settings/admin-settings-access';

export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  store.applyRuntimeEnv();
  const adminPasswordRequired = adminSettingsPasswordEnabled();
  const initialSettings = adminPasswordRequired ? undefined : readEnvironmentSettingsSnapshot();

  return (
    <main className="browser-chat-shell">
      <BrowserChatWorkspace
        adminSettingsPasswordRequired={adminPasswordRequired}
        defaultUserId={defaultApplicationUserId()}
        initialSettings={initialSettings}
        initialView="settings"
      />
    </main>
  );
}
