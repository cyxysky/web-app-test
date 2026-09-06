import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getBrowserChatSession } from '@/server/ai/agents/browser-chat.service';
import { compileConversationMessagesCase } from '@/server/automation/conversation-case-compiler';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { ApiRequestError, apiError, apiJson, parseJsonRequest } from '@/server/http/api-request';
import { idempotencyFingerprint, runIdempotentJson } from '@/server/http/idempotency';
import { createAutomationCase, listAutomationCases } from '@/server/storage/automation-store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = { params: Promise<{ sessionId: string }> };

const requestSchema = z.object({
  messageIds: z.array(z.string().trim().min(1).max(200)).min(1).max(500),
  title: z.union([z.string(), z.number()]).optional(),
  name: z.union([z.string(), z.number()]).optional(),
  description: z.union([z.string(), z.number()]).optional(),
}).strict();

function text(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { sessionId } = await context.params;
    const userId = requestApplicationUserId(request);
    if (!await getBrowserChatSession(sessionId, userId)) {
      throw new ApiRequestError('Browser chat session not found', { code: 'not_found', status: 404 });
    }
    return apiJson(request, { cases: await listAutomationCases({ userId, sourceSessionId: sessionId }) });
  } catch (error) {
    return apiError(request, error, { fallback: 'Failed to read automation cases' });
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { sessionId } = await context.params;
    const body = await parseJsonRequest(request, requestSchema, { maxBytes: 128 * 1024 });
    const userId = requestApplicationUserId(request);
    return runIdempotentJson(request, {
      fingerprint: idempotencyFingerprint({ sessionId, ...body }),
      scope: 'browser_chat.compile_automation_case',
      userId,
    }, async () => {
      const session = await getBrowserChatSession(sessionId, userId);
      if (!session) throw new ApiRequestError('Browser chat session not found', { code: 'not_found', status: 404 });
      const compiled = compileConversationMessagesCase({
        session,
        assistantMessageIds: body.messageIds,
        userId,
        title: text(body.title ?? body.name) || undefined,
        description: text(body.description) || undefined,
      });
      const automationCase = await createAutomationCase(compiled);
      return apiJson(request, {
        ok: true,
        case: automationCase,
        automationCase,
        sourceMessageIds: body.messageIds,
        cases: await listAutomationCases({ userId, sourceSessionId: sessionId }),
      }, { status: 201 });
    });
  } catch (error) {
    return apiError(request, error, { fallback: 'Failed to compile automation case' });
  }
}
