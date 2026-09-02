import { readBrowserChatChart } from '@/server/ai/agents/chart-artifact-tools';
import { readBrowserChatRuntimeState } from '@/server/ai/agents/browser-chat-read.service';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { ApiRequestError, apiError, apiJson } from '@/server/http/api-request';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ chartId: string; sessionId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const { chartId, sessionId } = await context.params;
    const session = await readBrowserChatRuntimeState(sessionId, requestApplicationUserId(request));
    if (!session) throw new ApiRequestError('Browser chat session not found', { code: 'not_found', status: 404 });
    const chart = await readBrowserChatChart(sessionId, chartId);
    if (!chart) throw new ApiRequestError('Chart not found', { code: 'not_found', status: 404 });
    return apiJson(request, { chart });
  } catch (error) {
    return apiError(request, error, { fallback: 'Failed to read browser chat chart' });
  }
}
