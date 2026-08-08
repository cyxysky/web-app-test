import { NextRequest } from 'next/server';
import { z } from 'zod';
import { generateBrowserChatMessagesSkill } from '@/server/ai/agents/browser-chat.service';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { ApiRequestError, apiError, apiJson, parseJsonRequest } from '@/server/http/api-request';
import { idempotencyFingerprint, runIdempotentJson } from '@/server/http/idempotency';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = { params: Promise<{ sessionId: string }> };

const requestSchema = z.object({
  messageIds: z.array(z.string().trim().min(1).max(200)).max(500),
  summaryDirection: z.string().trim().min(1).max(2_000),
}).strict();

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { sessionId } = await context.params;
    const body = await parseJsonRequest(request, requestSchema, { maxBytes: 128 * 1024 });
    const userId = requestApplicationUserId(request);
    return runIdempotentJson(request, {
      fingerprint: idempotencyFingerprint({ sessionId, ...body }),
      scope: 'browser_chat.generate_skill',
      userId,
    }, async () => {
      const generated = await generateBrowserChatMessagesSkill(sessionId, body.messageIds, userId, body.summaryDirection);
      return apiJson(request, { ok: true, skill: generated.skill, sourceMessageIds: generated.sourceMessageIds });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return apiError(request, error instanceof ApiRequestError ? error : new ApiRequestError(message || '生成 Skill 失败'), {
      fallback: 'Failed to generate skill from browser chat',
    });
  }
}
