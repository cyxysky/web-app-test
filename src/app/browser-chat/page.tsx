import { BrowserChatWorkspace } from '@/components/BrowserChatWorkspace';

export const dynamic = 'force-dynamic';

export default function BrowserChatPage() {
  return (
    <main className="browser-chat-shell">
      <BrowserChatWorkspace />
    </main>
  );
}
