import type { ReactNode } from 'react';
import { BrowserChatWorkspace } from '@/components/BrowserChatWorkspace';
import { defaultApplicationUserId } from '@/server/auth/user-context';
import { store } from '@/server/db/store';
import { adminSettingsPasswordEnabled } from '@/server/settings/admin-settings-access';
import { readEnvironmentSettingsSnapshot } from '@/server/settings/settings-snapshot';
import '../styles/modern-system.css';
import '../styles/browser-chat-debug.css';

export const dynamic = 'force-dynamic';

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  store.applyRuntimeEnv();
  const adminPasswordRequired = adminSettingsPasswordEnabled();
  const initialSettings = adminPasswordRequired ? undefined : readEnvironmentSettingsSnapshot();

  return (
    <>
      <main className="browser-chat-shell">
        <BrowserChatWorkspace
          adminSettingsPasswordRequired={adminPasswordRequired}
          defaultUserId={defaultApplicationUserId()}
          initialSettings={initialSettings}
        />
      </main>
      {children}
    </>
  );
}
