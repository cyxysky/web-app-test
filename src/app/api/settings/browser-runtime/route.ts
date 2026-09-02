import { NextRequest } from 'next/server';
import { apiJson } from '@/server/http/api-request';
import { readRuntimeSettingsItems } from '@/server/settings/settings-snapshot';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const browserChatRuntimeKeys = new Set(['BROWSER_CHAT_SHOW_REASONING', 'ELECTRON_EMBEDDED_BROWSER']);

export async function GET(request: NextRequest) {
  return apiJson(request, {
    saved: (await readRuntimeSettingsItems()).filter((item) => browserChatRuntimeKeys.has(item.key)),
  });
}
