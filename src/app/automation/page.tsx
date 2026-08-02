import { AutomationWorkspace } from '@/components/AutomationWorkspace';
import { defaultApplicationUserId } from '@/server/auth/user-context';

export const dynamic = 'force-dynamic';

type AutomationPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AutomationPage({ searchParams }: AutomationPageProps) {
  const query = await searchParams;
  const userId = firstQueryValue(query.userId)?.trim() || defaultApplicationUserId();
  const initialCaseId = firstQueryValue(query.caseId)?.trim() || '';
  return (
    <div className="browser-chat-shell automation-page-shell">
      <AutomationWorkspace defaultUserId={userId} initialCaseId={initialCaseId} />
    </div>
  );
}
