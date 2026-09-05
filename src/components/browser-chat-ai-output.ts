import type {
  BrowserChatAiOutputCycle,
  BrowserChatAiOutputTool,
  StepExecutionResult,
} from '@/server/ai/schemas/runtime.schema';

export {
  browserChatAiOutputViewFromResponse as aiOutputViewFromResponse,
  hasAiOutputView,
  stringFromUnknown,
} from '@/lib/browser-chat-output-cycles';

type BrowserChatToolCall = NonNullable<StepExecutionResult['tools']>[number];

export type BrowserChatToolDetail = {
  confirmationScreenshotUrl?: string;
  stepIndex: number;
  step: StepExecutionResult;
  toolIndex: number;
  tool: BrowserChatToolCall;
};

/** Realtime traces omit raw payloads; never let them erase fetched evidence. */
export function mergeBrowserChatToolDetail(detail: BrowserChatToolDetail, live: BrowserChatToolDetail): BrowserChatToolDetail {
  return {
    ...detail,
    ...live,
    confirmationScreenshotUrl: live.confirmationScreenshotUrl ?? detail.confirmationScreenshotUrl,
    tool: {
      ...detail.tool,
      ...live.tool,
      ok: live.tool.ok ?? detail.tool.ok,
      rawResult: detail.tool.rawResult ?? live.tool.rawResult,
      result: detail.tool.result ?? live.tool.result,
      error: detail.tool.error ?? live.tool.error,
    },
  };
}

export function aiCycleToolKey(cycleId: string, toolIndex: number) {
  return `${cycleId}:${toolIndex}`;
}

export function toolInputSignature(value: unknown) {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (!input || typeof input !== 'object') return input;
    const record = input as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record)
      .filter((key) => key !== 'reason' && key !== 'requiresConfirmation' && key !== 'confirmationMessage')
      .sort()
      .map((key) => [key, canonicalize(record[key])]));
  };
  try {
    return JSON.stringify(canonicalize(value)) || '';
  } catch {
    return '';
  }
}

export function buildAiCycleToolDetailMap(cycles: BrowserChatAiOutputCycle[], steps: StepExecutionResult[], running = false) {
  const details = new Map<string, BrowserChatToolDetail>();
  const persistedToolsById = new Map<string, BrowserChatToolDetail[]>();
  const persistedTools: BrowserChatToolDetail[] = [];
  const consumedPersistedTools = new Set<BrowserChatToolDetail>();
  const consumedProviderResultIds = new Set<string>();

  steps.forEach((step) => {
    (step.tools || []).forEach((tool, toolIndex) => {
      const detail = {
        stepIndex: step.index,
        step,
        toolIndex,
        tool,
      };
      if (tool.id) {
        const matches = persistedToolsById.get(tool.id) || [];
        matches.push(detail);
        persistedToolsById.set(tool.id, matches);
      }
      persistedTools.push(detail);
    });
  });

  cycles.forEach((cycle) => {
    const unmatched: Array<{ aiTool: BrowserChatAiOutputTool; aiToolIndex: number }> = [];
    let matchedInCycle = false;
    cycle.output.tools.forEach((aiTool, aiToolIndex) => {
      const belongsToCycle = (candidate: BrowserChatToolDetail) => (
        candidate.tool.name === aiTool.name
        && (typeof cycle.stepIndex !== 'number' || candidate.stepIndex === cycle.stepIndex)
      );
      const idMatches = aiTool.id ? persistedToolsById.get(aiTool.id) : undefined;
      const detail = idMatches
        ? [...idMatches].sort((left, right) => {
          const score = (candidate: BrowserChatToolDetail) => (
            (candidate.tool.rawResult !== undefined ? 8 : 0)
            + (candidate.tool.result !== undefined ? 4 : 0)
            + (candidate.tool.ok !== undefined ? 2 : 0)
          );
          return score(right) - score(left);
        }).find((candidate) => (
          !consumedPersistedTools.has(candidate) && belongsToCycle(candidate)
        ))
        : undefined;
      if (detail) {
        details.set(aiCycleToolKey(cycle.id, aiToolIndex), detail);
        consumedPersistedTools.add(detail);
        matchedInCycle = true;
        return;
      }
      if (idMatches?.length) return;
      if (aiTool.ok !== undefined) {
        const providerResultId = `${cycle.stepIndex ?? 'unknown'}:${aiTool.id || `${cycle.id}:${aiToolIndex}`}`;
        if (consumedProviderResultIds.has(providerResultId)) return;
        consumedProviderResultIds.add(providerResultId);
        const tool: BrowserChatToolCall = {
          id: aiTool.id || `${cycle.id}:${aiToolIndex}`,
          input: aiTool.input,
          name: aiTool.name,
          reason: aiTool.reason,
          ok: aiTool.ok,
          result: aiTool.result,
          rawResult: aiTool.rawResult,
          ...(aiTool.ok ? {} : { error: aiTool.error || aiTool.result }),
        };
        const stepIndex = typeof cycle.stepIndex === 'number' ? cycle.stepIndex : -1;
        const step: StepExecutionResult = {
          index: stepIndex,
          messageId: cycle.messageId,
          action: aiTool.name,
          expected: 'Tool execution result',
          actual: aiTool.result || (aiTool.ok ? 'Tool completed.' : 'Tool failed.'),
          status: aiTool.ok ? 'passed' : 'failed',
          tools: [tool],
        };
        details.set(aiCycleToolKey(cycle.id, aiToolIndex), { stepIndex, step, toolIndex: -1, tool });
        matchedInCycle = true;
        return;
      }
      unmatched.push({ aiTool, aiToolIndex });
    });

    let optimisticToolShown = false;
    unmatched.forEach(({ aiTool, aiToolIndex }) => {
      if (!aiTool.invalid && (matchedInCycle || !running || optimisticToolShown)) return;
      if (!aiTool.invalid) optimisticToolShown = true;
      const stepIndex = typeof cycle.stepIndex === 'number' ? cycle.stepIndex : -1;
      const pendingExecution = running && !aiTool.invalid;
      const parseError = aiTool.invalid
        ? aiTool.error || '工具参数解析失败'
        : '工具没有返回执行记录';
      const invalidTool: BrowserChatToolCall = {
        id: aiTool.id || `${cycle.id}:${aiToolIndex}`,
        name: aiTool.name,
        input: aiTool.input,
        reason: aiTool.reason,
        invalid: aiTool.invalid,
        error: parseError,
        ok: pendingExecution ? undefined : false,
        result: parseError,
      };
      const invalidStep: StepExecutionResult = {
        index: stepIndex,
        messageId: cycle.messageId,
        action: aiTool.name,
        expected: aiTool.invalid ? '有效的工具参数' : '工具执行结果',
        actual: parseError,
        status: pendingExecution ? 'running' : 'failed',
        tools: [invalidTool],
      };
      details.set(aiCycleToolKey(cycle.id, aiToolIndex), {
        stepIndex,
        step: invalidStep,
        toolIndex: 0,
        tool: invalidTool,
      });
    });
  });

  return details;
}
