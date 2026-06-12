import { NextRequest, NextResponse } from 'next/server';
import {
  exportBrowserChatMessageToTestCase,
  exportBrowserChatSessionToTestSuite,
  exportBrowserChatSessionToTestCase,
} from '@/server/ai/agents/browser-chat.service';

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const { sessionId } = await context.params;
  try {
    const body = await request.json().catch(() => ({}));
    const messageId = typeof body.messageId === 'string' ? body.messageId : '';
    const scope = typeof body.scope === 'string' ? body.scope : '';
    if (scope === 'suite') {
      const exported = await exportBrowserChatSessionToTestSuite(sessionId);
      return NextResponse.json({
        groupId: exported.group?.id,
        group: exported.group,
        testCaseId: exported.testCases[0]?.id,
        testCaseIds: exported.testCases.map((item) => item.id),
        runIds: exported.runs.map((item) => item.id),
        testCases: exported.testCases,
        runs: exported.runs,
        fallback: exported.fallback,
      });
    }
    const exported = scope === 'session'
      ? await exportBrowserChatSessionToTestCase(sessionId)
      : await exportBrowserChatMessageToTestCase(sessionId, messageId);
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
