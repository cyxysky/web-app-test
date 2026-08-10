import { SettingsWorkspace } from '@/components/SettingsWorkspace';
import { adminSettingsPasswordEnabled } from '@/server/settings/admin-settings-access';
import { readEnvironmentSettingsSnapshot } from '@/server/settings/settings-snapshot';
import { readWorkspacePageContext } from '@/server/workspace/workspace-page-context';
import '../../styles/domains/settings-workspace.css';

export default async function SettingsPage() {
  const context = await readWorkspacePageContext();
  const adminPasswordRequired = adminSettingsPasswordEnabled();
  return (
    <main className="browser-chat-shell">
      <SettingsWorkspace
        adminSettingsPasswordRequired={adminPasswordRequired}
        defaultUserId={context.userId}
        initialData={adminPasswordRequired ? undefined : readEnvironmentSettingsSnapshot()}
        initialSidebarCollapsed={context.sidebarCollapsed}
      />
    </main>
  );
}
