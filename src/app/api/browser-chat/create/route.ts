import { NextRequest } from 'next/server';
import { createBrowserChatSession } from '@/server/ai/agents/browser-chat.service';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { createBrowserChatSessionRequestSchema } from '@/server/http/browser-chat-request.schema';
import { apiError, apiJson, parseJsonRequest } from '@/server/http/api-request';
import { idempotencyFingerprint, runIdempotentJson } from '@/server/http/idempotency';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(request: NextRequest) {
  try {
    const body = await parseJsonRequest(request, createBrowserChatSessionRequestSchema, { maxBytes: 64 * 1024 });
    const userId = requestApplicationUserId(request);
    return runIdempotentJson(request, {
      fingerprint: idempotencyFingerprint(body),
      scope: 'browser-chat.create',
      userId,
    }, async () => {
      const session = await createBrowserChatSession({
        targetUrl: body.targetUrl,
        safetyMode: body.safetyMode,
        modelProvider: body.modelProvider,
        model: body.model,
        title: body.title,
        userId,
      });
      return apiJson(request, { session });
    });
  } catch (error) {
    return apiError(request, error, { fallback: 'Failed to create browser chat session' });
  }
}
