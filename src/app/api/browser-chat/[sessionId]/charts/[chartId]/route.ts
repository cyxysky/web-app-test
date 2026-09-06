import { readBrowserChatChart, updateBrowserChatChart } from '@/server/capabilities/browser-chat-chart';
import { ChartRevisionConflict, maxChartBytes, type ChartUpdateInput } from '@webpilot/capability-chart';
import { z } from 'zod';
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

const updateInput = z.object({
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  option: z.record(z.string(), z.unknown()),
  title: z.string().max(200).optional(), description: z.string().max(1000).optional(),
  height: z.number().int().min(240).max(720).optional(),
  engine: z.enum(['echarts', 'three']).optional(), renderer: z.enum(['canvas', 'svg']).optional(),
  maps: z.array(z.object({ name: z.string().min(1).max(160), geoJson: z.union([z.record(z.string(), z.unknown()), z.string().min(1)]), specialAreas: z.record(z.string(), z.unknown()).optional() }).strict()).max(12).optional(),
}).strict();

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { chartId, sessionId } = await context.params;
    const session = await readBrowserChatRuntimeState(sessionId, requestApplicationUserId(request));
    if (!session) throw new ApiRequestError('Browser chat session not found', { code: 'not_found', status: 404 });
    // Bound the streamed body before parsing, including chunked requests.
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > maxChartBytes + 16_384) { await reader.cancel(); throw new ApiRequestError('图表配置不能超过 4 MB。', { code: 'payload_too_large', status: 413 }); }
        chunks.push(result.value);
      }
    } finally { reader.releaseLock(); }
    let input: z.infer<typeof updateInput>;
    try { input = updateInput.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch { throw new ApiRequestError('图表更新参数无效。', { code: 'invalid_request', status: 400 }); }
    const { expectedRevision, ...update } = input;
    let chart;
    try { chart = await updateBrowserChatChart(sessionId, chartId, update as ChartUpdateInput, expectedRevision); }
    catch (error) {
      if (error instanceof ChartRevisionConflict) throw new ApiRequestError(error.message, { code: 'chart_revision_conflict', status: 409 });
      // Invalid chart data is actionable in the editor; storage failures remain server errors.
      if (error instanceof Error && !('code' in error) && !error.message.startsWith('Unable to read chart')) throw new ApiRequestError(error.message, { code: 'invalid_chart', status: 400 });
      throw error;
    }
    if (!chart) throw new ApiRequestError('Chart not found', { code: 'not_found', status: 404 });
    return apiJson(request, { chart });
  } catch (error) { return apiError(request, error, { fallback: 'Failed to update browser chat chart', status: 500 }); }
}
