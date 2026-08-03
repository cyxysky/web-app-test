import { BrowserChatWorkspace } from '@/components/BrowserChatWorkspace';
import { defaultApplicationUserId } from '@/server/auth/user-context';
import { adminSettingsPasswordEnabled } from '@/server/settings/admin-settings-access';

export const dynamic = 'force-dynamic';

export default function BrowserChatPage() {
  return (
    <main className="browser-chat-shell">
      <BrowserChatWorkspace
        adminSettingsPasswordRequired={adminSettingsPasswordEnabled()}
        defaultUserId={defaultApplicationUserId()}
      />
    </main>
  );
}
