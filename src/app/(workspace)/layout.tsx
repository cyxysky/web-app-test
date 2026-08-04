import type { ReactNode } from 'react';
import { cookies, headers } from 'next/headers';
import { BrowserChatWorkspace } from '@/components/BrowserChatWorkspace';
import { requestApplicationPrincipal } from '@/server/auth/user-context';
import { store } from '@/server/db/store';
import { adminSettingsPasswordEnabled } from '@/server/settings/admin-settings-access';
import { readEnvironmentSettingsSnapshot } from '@/server/settings/settings-snapshot';
import {
  SIDEBAR_COLLAPSED_COOKIE_NAME,
  sidebarCollapsedFromCookie,
} from '@/lib/sidebar-collapse';
import '../styles/modern-system.css';
import '../styles/browser-chat-debug.css';

export const dynamic = 'force-dynamic';

export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  store.applyRuntimeEnv();
  const requestHeaders = await headers();
  const requestCookies = await cookies();
  const authenticatedUserId = requestApplicationPrincipal({ headers: requestHeaders }).userId;
  const adminPasswordRequired = adminSettingsPasswordEnabled();
  const initialSettings = adminPasswordRequired ? undefined : readEnvironmentSettingsSnapshot();

  return (
    <>
      <main className="browser-chat-shell">
        <BrowserChatWorkspace
          adminSettingsPasswordRequired={adminPasswordRequired}
          defaultUserId={authenticatedUserId}
          initialSidebarCollapsed={sidebarCollapsedFromCookie(requestCookies.get(SIDEBAR_COLLAPSED_COOKIE_NAME)?.value)}
          initialSettings={initialSettings}
        />
      </main>
      {children}
    </>
  );
}
