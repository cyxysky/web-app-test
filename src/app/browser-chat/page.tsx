import { BrowserChatWorkspace } from '@/components/BrowserChatWorkspace';
import { defaultApplicationUserId } from '@/server/auth/user-context';

export const dynamic = 'force-dynamic';

export default function BrowserChatPage() {
  return (
    <main className="browser-chat-shell">
      <BrowserChatWorkspace defaultUserId={defaultApplicationUserId()} />
    </main>
  );
}
