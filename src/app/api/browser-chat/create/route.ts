import { NextRequest } from 'next/server';
import { createBrowserChatSession } from '@/server/ai/agents/browser-chat.service';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { createBrowserChatSessionRequestSchema } from '@/server/http/browser-chat-request.schema';
import { noStoreJson } from '@/server/http/no-store-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(request: NextRequest) {
  try {
    const body = createBrowserChatSessionRequestSchema.parse(await request.json().catch(() => ({})));
    const session = createBrowserChatSession({
      targetUrl: body.targetUrl,
      safetyMode: body.safetyMode,
      modelProvider: body.modelProvider,
      model: body.model,
      title: body.title,
      userId: requestApplicationUserId(request),
    });
    return noStoreJson({ session });
  } catch (error) {
    return noStoreJson(
      { error: error instanceof Error ? error.message : 'Failed to create browser chat session' },
      { status: 400 },
    );
  }
}
