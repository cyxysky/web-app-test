import { cookies, headers } from 'next/headers';
import { requestWorkspaceApplicationPrincipal } from '@/server/auth/user-context';
import { store } from '@/server/db/store';
import {
  SIDEBAR_COLLAPSED_COOKIE_NAME,
  sidebarCollapsedFromCookie,
} from '@/lib/sidebar-collapse';

export async function readWorkspacePageContext() {
  await store.applyRuntimeEnv();
  const requestHeaders = await headers();
  const requestCookies = await cookies();
  return {
    userId: requestWorkspaceApplicationPrincipal({ headers: requestHeaders }).userId,
    sidebarCollapsed: sidebarCollapsedFromCookie(
      requestCookies.get(SIDEBAR_COLLAPSED_COOKIE_NAME)?.value,
    ),
  };
}
