import { NextRequest } from 'next/server';
import { exportBrowserChatMessagesToTestCase, exportBrowserChatMessageToTestCase } from '@/server/ai/agents/browser-chat.service';
import { noStoreJson } from '@/server/http/no-store-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const { sessionId } = await context.params;
  try {
    const body = await request.json().catch(() => ({}));
    const messageIds = Array.isArray(body.messageIds)
      ? body.messageIds.filter((item: unknown): item is string => typeof item === 'string')
      : [];
    const messageId = typeof body.messageId === 'string' ? body.messageId : '';
    const exported = messageIds.length
      ? exportBrowserChatMessagesToTestCase(sessionId, messageIds)
      : exportBrowserChatMessageToTestCase(sessionId, messageId);
    return noStoreJson({
      testCaseId: exported.testCase.id,
      runId: exported.run.id,
      testCase: exported.testCase,
      run: exported.run,
    });
  } catch (error) {
    return noStoreJson(
      { error: error instanceof Error ? error.message : 'Failed to export browser chat message' },
      { status: 400 },
    );
  }
}
