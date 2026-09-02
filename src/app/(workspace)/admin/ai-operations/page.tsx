import { redirect } from 'next/navigation';
import { AiOperationsWorkspace } from '@/components/AiOperationsWorkspace';
import { isAiOperationsAdmin } from '@/server/auth/ai-operations-admin';
import { readAiOperationsDashboard } from '@/server/observability/ai-operations-dashboard';
import { readWorkspacePageContext } from '@/server/workspace/workspace-page-context';
import '../../../styles/domains/ai-operations-workspace.css';

export const dynamic = 'force-dynamic';

export default async function AiOperationsPage() {
  const context = await readWorkspacePageContext();
  if (!isAiOperationsAdmin(context.userId)) redirect('/browser-chat');
  return (
    <main className="browser-chat-shell ai-operations-page-shell">
      <AiOperationsWorkspace
        initialData={await readAiOperationsDashboard(30)}
        initialSidebarCollapsed={context.sidebarCollapsed}
      />
    </main>
  );
}
