import { AutomationWorkspace } from '@/components/AutomationWorkspace';
import { requestApplicationPrincipal } from '@/server/auth/user-context';
import { cookies, headers } from 'next/headers';
import {
  SIDEBAR_COLLAPSED_COOKIE_NAME,
  sidebarCollapsedFromCookie,
} from '@/lib/sidebar-collapse';

export const dynamic = 'force-dynamic';

type AutomationPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AutomationPage({ searchParams }: AutomationPageProps) {
  const query = await searchParams;
  const requestHeaders = await headers();
  const requestCookies = await cookies();
  const userId = requestApplicationPrincipal({ headers: requestHeaders }).userId;
  const initialCaseId = firstQueryValue(query.caseId)?.trim() || '';
  return (
    <div className="browser-chat-shell automation-page-shell">
      <AutomationWorkspace
        defaultUserId={userId}
        initialCaseId={initialCaseId}
        initialSidebarCollapsed={sidebarCollapsedFromCookie(requestCookies.get(SIDEBAR_COLLAPSED_COOKIE_NAME)?.value)}
      />
    </div>
  );
}
