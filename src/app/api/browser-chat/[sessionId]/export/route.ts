import { NextRequest, NextResponse } from 'next/server';
import { exportBrowserChatMessageToTestCase } from '@/server/ai/agents/browser-chat.service';

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const { sessionId } = await context.params;
  try {
    const body = await request.json().catch(() => ({}));
    const messageId = typeof body.messageId === 'string' ? body.messageId : '';
    const exported = exportBrowserChatMessageToTestCase(sessionId, messageId);
    return NextResponse.json({
      testCaseId: exported.testCase.id,
      runId: exported.run.id,
      testCase: exported.testCase,
      run: exported.run,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to export browser chat message' },
      { status: 400 },
    );
  }
}
