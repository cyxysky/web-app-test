import { NextRequest } from 'next/server';
import { listBrowserChatSessionSummaries } from '@/server/ai/agents/browser-chat-read.service';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { store } from '@/server/db/store';
import { apiJson } from '@/server/http/api-request';
import { readModelSettingsState, readRuntimeSettingsItems } from '@/server/settings/settings-snapshot';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const browserChatRuntimeKeys = new Set([
  'AI_BROWSER_MODE',
  'BROWSER_CHAT_SHOW_REASONING',
  'ELECTRON_EMBEDDED_BROWSER',
]);

export async function GET(request: NextRequest) {
  const userId = requestApplicationUserId(request);
  return apiJson(request, {
    sessions: listBrowserChatSessionSummaries(userId, { limit: 500 }),
    skills: store.listSkills(undefined, userId, 500),
    model: readModelSettingsState(),
    runtime: readRuntimeSettingsItems().filter((item) => browserChatRuntimeKeys.has(item.key)),
  });
}
