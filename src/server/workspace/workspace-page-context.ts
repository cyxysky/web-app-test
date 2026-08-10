import { cookies, headers } from 'next/headers';
import { requestApplicationPrincipal } from '@/server/auth/user-context';
import { store } from '@/server/db/store';
import {
  SIDEBAR_COLLAPSED_COOKIE_NAME,
  sidebarCollapsedFromCookie,
} from '@/lib/sidebar-collapse';

export async function readWorkspacePageContext() {
  store.applyRuntimeEnv();
  const requestHeaders = await headers();
  const requestCookies = await cookies();
  return {
    userId: requestApplicationPrincipal({ headers: requestHeaders }).userId,
    sidebarCollapsed: sidebarCollapsedFromCookie(
      requestCookies.get(SIDEBAR_COLLAPSED_COOKIE_NAME)?.value,
    ),
  };
}
