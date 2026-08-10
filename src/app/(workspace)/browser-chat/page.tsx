import { BrowserChatWorkspaceLoader } from '@/components/BrowserChatWorkspaceLoader';
import { readWorkspacePageContext } from '@/server/workspace/workspace-page-context';
import '../../styles/domains/browser-chat.css';

export default async function BrowserChatPage() {
  const context = await readWorkspacePageContext();
  return (
    <main className="browser-chat-shell">
      <BrowserChatWorkspaceLoader
        defaultUserId={context.userId}
        initialSidebarCollapsed={context.sidebarCollapsed}
      />
    </main>
  );
}
