import {
  createChartCapability,
  createChartTool,
  readChart,
  updateChart,
  type ChartUpdateInput,
  type ChartToolInput,
  type ChartRecord,
} from '@webpilot/capability-chart';
import { createFileSystemChartStore, validateEChartsOption } from '@webpilot/capability-chart/node';
import { artifactPath } from '@/server/storage/paths';
import { capabilityResultToBrowserActionResult } from './browser-chat-result';

const browserChatSessionIdPattern = /^(chat_[a-f0-9]{12})(?:_|$)/i;
const automationRunIdPattern = /^automation_run_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const webPilotEChartsVersion = '6.1.0';

function browserChatSessionId(runId: string) {
  const normalized = String(runId || '').trim();
  if (automationRunIdPattern.test(normalized)) return normalized;
  const sessionId = normalized.match(browserChatSessionIdPattern)?.[1];
  if (!sessionId) throw new Error('Chart creation requires a valid browser-chat session run id.');
  return sessionId;
}

function chartStore(runId: string) {
  return createFileSystemChartStore({
    directory: artifactPath(browserChatSessionId(runId), 'charts'),
  });
}

export const browserChatChartCapability = createChartCapability({
  echartsVersion: webPilotEChartsVersion,
  validateOption: validateEChartsOption,
  createStore(context) {
    return chartStore(context.runId);
  },
});

export async function readBrowserChatChart(
  sessionId: string,
  chartId: string,
): Promise<ChartRecord | undefined> {
  return readChart(chartStore(sessionId), chartId);
}

export async function updateBrowserChatChart(sessionId: string, chartId: string, input: ChartUpdateInput, expectedRevision: number) {
  return updateChart(chartStore(sessionId), chartId, input, expectedRevision, { validateOption: validateEChartsOption });
}

export async function executeBrowserChatChart(
  runId: string,
  input: unknown,
  options: { abortSignal?: AbortSignal; invocationId?: string } = {},
) {
  const tool = createChartTool(chartStore(runId), {
    echartsVersion: webPilotEChartsVersion,
    validateOption: validateEChartsOption,
  });
  const parsed = tool.input.parse(input) as ChartToolInput;
  return capabilityResultToBrowserActionResult(await tool.execute(parsed, {
    invocationId: options.invocationId || `chart:${runId}`,
    abortSignal: options.abortSignal,
  }));
}
