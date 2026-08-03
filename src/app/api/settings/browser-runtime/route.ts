import { noStoreJson } from '@/server/http/no-store-response';
import { readRuntimeSettingsItems } from '@/server/settings/settings-snapshot';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const browserChatRuntimeKeys = new Set([
  'AI_BROWSER_MODE',
  'BROWSER_CHAT_SHOW_REASONING',
  'ELECTRON_EMBEDDED_BROWSER',
]);

export async function GET() {
  return noStoreJson({
    saved: readRuntimeSettingsItems().filter((item) => browserChatRuntimeKeys.has(item.key)),
  });
}
