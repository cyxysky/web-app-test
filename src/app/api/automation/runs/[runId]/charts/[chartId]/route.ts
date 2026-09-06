import { readBrowserChatChart } from '@/server/capabilities/browser-chat-chart';
import { getAutomationRun } from '@/server/storage/automation-store';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { ApiRequestError, apiError, apiJson } from '@/server/http/api-request';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request, context: { params: Promise<{ runId: string; chartId: string }> }) {
  try {
    const { runId, chartId } = await context.params;
    const run = await getAutomationRun(runId, requestApplicationUserId(request));
    if (!run) throw new ApiRequestError('Automation run not found', { code: 'not_found', status: 404 });
    const chart = await readBrowserChatChart(run.id, chartId);
    if (!chart) throw new ApiRequestError('Chart not found', { code: 'not_found', status: 404 });
    return apiJson(request, { chart });
  } catch (error) {
    return apiError(request, error, { fallback: 'Failed to read automation chart' });
  }
}
