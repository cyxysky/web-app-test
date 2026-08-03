import { resumeBrowserChatHumanVerification } from '@/server/ai/agents/browser-chat.service';
import { noStoreJson } from '@/server/http/no-store-response';
import { requestApplicationUserId } from '@/server/auth/user-context';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

function requestUserId(request: Request) {
  return requestApplicationUserId(request);
}

export async function POST(request: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  try {
    return noStoreJson({ session: resumeBrowserChatHumanVerification(sessionId, requestUserId(request)) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to resume browser chat verification';
    return noStoreJson({ error: message }, { status: /not found/i.test(message) ? 404 : 400 });
  }
}
