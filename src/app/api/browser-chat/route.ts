import { NextRequest } from 'next/server';
import { listBrowserChatSessionSummaries } from '@/server/ai/agents/browser-chat-read.service';
import { noStoreJson } from '@/server/http/no-store-response';
import { requestApplicationUserId } from '@/server/auth/user-context';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function requestUserId(request: NextRequest) {
  return requestApplicationUserId(request);
}

export async function GET(request: NextRequest) {
  return noStoreJson({ sessions: listBrowserChatSessionSummaries(requestUserId(request)) });
}
