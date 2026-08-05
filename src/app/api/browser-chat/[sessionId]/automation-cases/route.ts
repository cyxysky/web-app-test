import { NextRequest } from 'next/server';
import { getBrowserChatSession } from '@/server/ai/agents/browser-chat.service';
import { compileConversationMessagesCase } from '@/server/automation/conversation-case-compiler';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { noStoreJson } from '@/server/http/no-store-response';
import { createAutomationCase, listAutomationCases } from '@/server/storage/automation-store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

type RequestBody = Record<string, unknown>;

function bodyRecord(value: unknown): RequestBody {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RequestBody : {};
}

function text(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function requestUserId(request: NextRequest) {
  return requestApplicationUserId(request);
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { sessionId } = await context.params;
  const userId = requestUserId(request);
  const session = getBrowserChatSession(sessionId, userId);
  if (!session) return noStoreJson({ error: 'Browser chat session not found.' }, { status: 404 });
  return noStoreJson({ cases: listAutomationCases({ userId, sourceSessionId: sessionId }) });
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { sessionId } = await context.params;
  try {
    const body = bodyRecord(await request.json().catch(() => ({})));
    const userId = requestUserId(request);
    const session = getBrowserChatSession(sessionId, userId);
    if (!session) return noStoreJson({ error: 'Browser chat session not found.' }, { status: 404 });
    const messageIds = Array.isArray(body.messageIds)
      ? body.messageIds.filter((item): item is string => typeof item === 'string')
      : [];
    const assistantMessageIds = messageIds;
    if (!assistantMessageIds.length) throw new Error('At least one assistant message id is required.');
    const compiled = compileConversationMessagesCase({
      session,
      assistantMessageIds,
      userId,
      title: text(body.title ?? body.name) || undefined,
      description: text(body.description) || undefined,
    });
    const automationCase = createAutomationCase(compiled);
    return noStoreJson({
      ok: true,
      case: automationCase,
      automationCase,
      sourceMessageIds: assistantMessageIds,
      cases: listAutomationCases({ userId, sourceSessionId: sessionId }),
    }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to compile automation case.';
    return noStoreJson(
      { error: message },
      { status: /not found/i.test(message) ? 404 : 400 },
    );
  }
}
