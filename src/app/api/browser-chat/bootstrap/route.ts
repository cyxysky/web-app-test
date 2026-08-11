import { NextRequest } from 'next/server';
import { listBrowserChatSessionSummaries } from '@/server/ai/agents/browser-chat-read.service';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { store } from '@/server/db/store';
import { apiJson, boundedQueryInteger } from '@/server/http/api-request';
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
  const sessionLimit = boundedQueryInteger(request.nextUrl.searchParams.get('sessionLimit'), { fallback: 10, max: 100 });
  const skillLimit = boundedQueryInteger(request.nextUrl.searchParams.get('skillLimit'), { fallback: 50, max: 100 });
  const sessionPage = listBrowserChatSessionSummaries(userId, { limit: sessionLimit + 1 });
  const sessions = sessionPage.slice(0, sessionLimit);
  const lastSession = sessions.at(-1);
  const skillPage = store.listSkills(undefined, userId, skillLimit + 1);
  const skills = skillPage.slice(0, skillLimit);
  const lastSkill = skills.at(-1);
  return apiJson(request, {
    sessions,
    sessionPage: {
      hasMore: sessionPage.length > sessionLimit,
      next: sessionPage.length > sessionLimit && lastSession
        ? { beforeId: lastSession.id, beforeUpdatedAt: lastSession.updatedAt }
        : undefined,
    },
    skills,
    skillPage: {
      hasMore: skillPage.length > skillLimit,
      next: skillPage.length > skillLimit && lastSkill
        ? { beforeId: lastSkill.id, beforeUpdatedAt: lastSkill.updatedAt }
        : undefined,
    },
    model: readModelSettingsState(),
    runtime: readRuntimeSettingsItems().filter((item) => browserChatRuntimeKeys.has(item.key)),
  });
}
