import type {
  CoverageMatrixItem,
  EvidenceArtifact,
  EvidenceGraphRecord,
  EvidenceIndexItem,
  RunDebugEvent,
  RunDiagnosticSummary,
  RunTraceEvent,
  StepDiagnosticSummary,
  StepExecutionResult,
  TaskFrame,
  TaskLedgerItem,
  TestRunRecord,
} from '@/server/ai/schemas/test-case.schema';
import { buildProgressDigest } from '@/server/ai/run-progress-digest';

type RunResult = NonNullable<TestRunRecord['result']>;

function now() {
  return new Date().toISOString();
}

function compact(value?: string, max = 220) {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function toolStatus(ok?: boolean): 'running' | 'passed' | 'failed' {
  if (ok === false) return 'failed';
  if (ok === true) return 'passed';
  return 'running';
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function contextBudgetFromStep(step: StepExecutionResult) {
  const budget = recordValue(step.aiRequest?.options?.contextBudget);
  if (!budget) return undefined;
  return {
    estimatedTokens: numberValue(budget.estimatedTokens),
    windowTokens: numberValue(budget.windowTokens),
    thresholdTokens: numberValue(budget.thresholdTokens),
    usageRatio: numberValue(budget.usageRatio),
    imageCount: numberValue(budget.imageCount),
    compressed: budget.compressed === true,
  };
}

function artifactFromPath(title: string, path?: string, kind: EvidenceArtifact['kind'] = 'screenshot'): EvidenceArtifact | undefined {
  if (!path) return undefined;
  return { title, path, kind };
}

function screenshotArtifacts(step: StepExecutionResult): EvidenceArtifact[] {
  return [
    artifactFromPath(`Step ${step.index} before`, step.beforeScreenshotPath),
    artifactFromPath(`Step ${step.index} after`, step.afterScreenshotPath || step.screenshotPath),
    ...(step.tools || []).flatMap((tool) => (tool.screenshots || []).map((shot) => ({
      title: `Step ${step.index} ${tool.name}: ${shot.title}`,
      path: shot.path,
      kind: 'screenshot' as const,
      summary: shot.kind,
    }))),
  ].filter((item): item is EvidenceArtifact => Boolean(item?.path));
}

export function buildStepDiagnostics(step: StepExecutionResult): StepDiagnosticSummary {
  const tools = step.tools || [];
  const visualFrames = [
    step.visualContext?.current,
    ...(step.visualContext?.history || []),
  ].filter(Boolean);
  const screenshots = screenshotArtifacts(step);
  const contextCompressionCount = (step.traceEvents || []).filter((event) => event.phase === 'ai:context-compressed').length;
  const lastTool = tools.at(-1);
  const contextBudget = contextBudgetFromStep(step);

  return {
    browserMode: typeof step.aiRequest?.options?.browserMode === 'string' ? step.aiRequest.options.browserMode : undefined,
    toolCallCount: tools.length,
    failedToolCallCount: tools.filter((tool) => tool.ok === false).length,
    screenshotCount: screenshots.length,
    visualFrameCount: visualFrames.length,
    ledgerItemCount: (step.ledgerItems || step.workingMemory?.ledgerItems || []).length,
    contextCompressionCount,
    estimatedContextTokens: contextBudget?.estimatedTokens,
    contextWindowTokens: contextBudget?.windowTokens,
    contextThresholdTokens: contextBudget?.thresholdTokens,
    contextBudgetRatio: contextBudget?.usageRatio,
    contextImageCount: contextBudget?.imageCount,
    contextCompressed: contextBudget?.compressed,
    lastToolName: lastTool?.name,
    lastToolStatus: lastTool ? toolStatus(lastTool.ok) : undefined,
    updatedAt: now(),
  };
}

export function buildStepTraceEvents(step: StepExecutionResult): RunTraceEvent[] {
  const time = step.aiRequest?.createdAt || now();
  const events: RunTraceEvent[] = [{
    id: `step:${step.index}:status:${step.status}`,
    time,
    type: 'step',
    phase: 'step:status',
    stepIndex: step.index,
    status: step.status,
    message: compact(step.observation || step.note || step.actual || step.action, 300),
    evidence: screenshotArtifacts(step).slice(0, 4),
  }];

  for (const [index, tool] of (step.tools || []).entries()) {
    const status = toolStatus(tool.ok);
    events.push({
      id: `step:${step.index}:tool:${index + 1}:${tool.name}:${status}`,
      time,
      type: 'tool',
      phase: `tool:${status}`,
      stepIndex: step.index,
      toolName: tool.name,
      status,
      message: compact(tool.reason || tool.result || `${tool.name} ${status}`, 300),
      evidence: (tool.screenshots || []).map((shot) => ({
        title: shot.title,
        path: shot.path,
        kind: 'screenshot' as const,
        summary: shot.kind,
      })),
      details: {
        input: tool.input,
        result: tool.result,
        visualAfter: tool.visualAfter,
      },
    });
  }

  const ledgerItems = [
    ...(step.ledgerItems || []),
    ...(step.workingMemory?.ledgerItems || []).filter((item) => item.sourceStep === step.index),
  ];
  for (const [index, item] of ledgerItems.entries()) {
    events.push({
      id: `step:${step.index}:ledger:${item.id || index + 1}`,
      time,
      type: 'ledger',
      phase: 'ledger:item',
      stepIndex: step.index,
      status: step.status,
      message: compact([item.status || 'finding', item.title, item.summary || item.actual].filter(Boolean).join(': '), 300),
      evidence: item.evidence?.map((summary) => ({ title: item.title, kind: 'ledger' as const, summary: compact(summary, 260) })),
      details: item,
    });
  }

  if (step.workingMemory) {
    events.push({
      id: `step:${step.index}:memory`,
      time,
      type: 'memory',
      phase: 'memory:updated',
      stepIndex: step.index,
      status: step.status,
      message: compact(step.workingMemory.currentState || step.workingMemory.lastResult || step.workingMemory.nextStep, 300),
      details: {
        nextStep: step.workingMemory.nextStep,
        blockerCount: step.workingMemory.blockers.length,
        findingCount: step.workingMemory.findings.length,
        ledgerItemCount: step.workingMemory.ledgerItems?.length || 0,
      },
    });
  }

  const contextBudget = contextBudgetFromStep(step);
  if (contextBudget?.estimatedTokens) {
    events.push({
      id: `step:${step.index}:diagnostic:context-budget`,
      time,
      type: 'diagnostic',
      phase: 'context:budget',
      stepIndex: step.index,
      status: step.status,
      message: `Estimated context ${contextBudget.estimatedTokens}/${contextBudget.windowTokens || '?'} tokens with ${contextBudget.imageCount || 0} image(s).`,
      details: contextBudget,
    });
  }

  const contextSummary = step.contextSummary || step.workingMemory?.contextSummary;
  if (contextSummary) {
    events.push({
      id: `step:${step.index}:context-summary:v${contextSummary.version}`,
      time: contextSummary.createdAt || time,
      type: 'diagnostic',
      phase: 'context:summary',
      stepIndex: step.index,
      status: step.status,
      message: compact([
        `Structured summary v${contextSummary.version}`,
        contextSummary.source,
        contextSummary.nextExecutionPlan?.[0],
      ].filter(Boolean).join(' / '), 300),
      details: contextSummary,
    });
  }

  return events;
}

export function enrichStepWithTrace(step: StepExecutionResult): StepExecutionResult {
  const baseStep = { ...step };
  const traceEvents = buildStepTraceEvents(baseStep);
  return {
    ...baseStep,
    traceEvents,
    diagnostics: buildStepDiagnostics({ ...baseStep, traceEvents }),
  };
}

export function buildRunTraceEvents(steps: StepExecutionResult[], debugEvents: RunDebugEvent[] = []) {
  const stepEvents = steps.flatMap((step) => step.traceEvents || buildStepTraceEvents(step));
  const debugTraceEvents: RunTraceEvent[] = debugEvents.slice(-200).map((event, index) => ({
    id: `debug:${index}:${event.phase}:${event.stepIndex || 0}`,
    time: event.time,
    type: event.phase.includes('visual') ? 'visual' : 'diagnostic',
    phase: event.phase,
    stepIndex: event.stepIndex,
    message: compact(event.message, 300),
    details: event.details,
  }));
  const map = new Map<string, RunTraceEvent>();
  for (const event of [...stepEvents, ...debugTraceEvents]) map.set(event.id, event);
  return [...map.values()].slice(-500);
}

export function buildEvidenceIndex(steps: StepExecutionResult[], ledgerItems: TaskLedgerItem[] = [], traceEvents: RunTraceEvent[] = []): EvidenceIndexItem[] {
  const items: EvidenceIndexItem[] = [];
  for (const step of steps) {
    if (step.beforeScreenshotPath) {
      items.push({
        id: `step:${step.index}:before`,
        title: `Step ${step.index} before screenshot`,
        source: 'step',
        stepIndex: step.index,
        kind: 'screenshot',
        path: step.beforeScreenshotPath,
        status: step.status,
        summary: compact(step.action, 160),
      });
    }
    if (step.afterScreenshotPath || step.screenshotPath) {
      items.push({
        id: `step:${step.index}:after`,
        title: `Step ${step.index} after screenshot`,
        source: 'step',
        stepIndex: step.index,
        kind: 'screenshot',
        path: step.afterScreenshotPath || step.screenshotPath,
        status: step.status,
        summary: compact(step.actual, 180),
      });
    }
    for (const [toolIndex, tool] of (step.tools || []).entries()) {
      for (const [shotIndex, shot] of (tool.screenshots || []).entries()) {
        items.push({
          id: `step:${step.index}:tool:${toolIndex + 1}:shot:${shotIndex + 1}`,
          title: shot.title || `${tool.name} screenshot`,
          source: 'tool',
          stepIndex: step.index,
          toolName: tool.name,
          kind: 'screenshot',
          path: shot.path,
          status: tool.ok === false ? 'failed' : tool.ok === true ? 'passed' : 'running',
          summary: compact(tool.reason || tool.result || shot.kind, 180),
        });
      }
    }
  }

  for (const [index, item] of ledgerItems.entries()) {
    items.push({
      id: `ledger:${item.id || index + 1}`,
      title: item.title,
      source: 'ledger',
      stepIndex: item.sourceStep,
      kind: 'ledger',
      ledgerItemId: item.id,
      status: item.status,
      severity: item.severity,
      summary: compact([item.summary, item.actual, item.expected, ...(item.evidence || [])].filter(Boolean).join(' | '), 260),
    });
  }

  for (const event of traceEvents) {
    for (const [index, evidence] of (event.evidence || []).entries()) {
      items.push({
        id: `trace:${event.id}:evidence:${index + 1}`,
        title: evidence.title,
        source: event.type === 'ledger' ? 'ledger' : event.type === 'tool' ? 'tool' : 'debug',
        stepIndex: event.stepIndex,
        toolName: event.toolName,
        kind: evidence.kind,
        path: evidence.path,
        status: event.status,
        summary: compact(evidence.summary || event.message, 260),
      });
    }
  }

  const map = new Map<string, EvidenceIndexItem>();
  for (const item of items) map.set(item.id, item);
  return [...map.values()].slice(-500);
}

export function buildCoverageMatrix(input: {
  steps: StepExecutionResult[];
  taskFrame?: TaskFrame;
  ledgerItems: TaskLedgerItem[];
  evidenceIndex: EvidenceIndexItem[];
}): CoverageMatrixItem[] {
  const digest = buildProgressDigest({ steps: input.steps, taskFrame: input.taskFrame, ledgerItems: input.ledgerItems });
  return digest.dimensions.map((dimension) => {
    const dimensionLedger = input.ledgerItems.filter((item) => (item.dimensionId || 'general') === dimension.id);
    const evidenceItemIds = input.evidenceIndex
      .filter((item) => (
        (item.source === 'ledger' && dimensionLedger.some((ledger) => ledger.id && ledger.id === item.ledgerItemId))
        || (item.stepIndex && dimensionLedger.some((ledger) => ledger.sourceStep === item.stepIndex))
      ))
      .map((item) => item.id)
      .slice(-20);
    return {
      dimensionId: dimension.id,
      dimensionName: dimension.name,
      status: dimension.status,
      itemCount: dimension.itemCount,
      latestStep: dimension.latestStep,
      latestSummary: dimension.latestSummary,
      evidenceItemIds,
      nextAction: dimension.status === 'missing'
        ? 'Collect first evidence for this requirement dimension.'
        : dimension.status === 'in_progress' || dimension.status === 'question'
          ? 'Resolve remaining uncertainty with fresh page evidence.'
          : undefined,
    };
  });
}

export function buildEvidenceGraph(steps: StepExecutionResult[], ledgerItems: TaskLedgerItem[], evidenceIndex: EvidenceIndexItem[]): EvidenceGraphRecord {
  const nodes = new Map<string, EvidenceGraphRecord['nodes'][number]>();
  const edges: EvidenceGraphRecord['edges'] = [];
  const addNode = (node: EvidenceGraphRecord['nodes'][number]) => nodes.set(node.id, node);
  const addEdge = (from: string, to: string, type: EvidenceGraphRecord['edges'][number]['type']) => {
    if (from && to) edges.push({ from, to, type });
  };

  for (const step of steps) {
    const stepId = `step:${step.index}`;
    addNode({ id: stepId, type: 'step', label: `Step ${step.index}`, stepIndex: step.index, status: step.status, summary: compact(step.action, 160) });
    for (const [toolIndex, tool] of (step.tools || []).entries()) {
      const toolId = `step:${step.index}:tool:${toolIndex + 1}`;
      addNode({ id: toolId, type: 'tool', label: tool.name, stepIndex: step.index, status: tool.ok === false ? 'failed' : tool.ok === true ? 'passed' : 'running', summary: compact(tool.reason || tool.result, 160) });
      addEdge(stepId, toolId, 'executes');
    }
  }

  for (const [index, ledger] of ledgerItems.entries()) {
    const ledgerId = `ledger:${ledger.id || index + 1}`;
    addNode({ id: ledgerId, type: 'ledger', label: ledger.title, stepIndex: ledger.sourceStep, status: ledger.status, summary: compact(ledger.summary || ledger.actual || ledger.expected, 180) });
    if (ledger.sourceStep) addEdge(`step:${ledger.sourceStep}`, ledgerId, 'produces');
  }

  for (const item of evidenceIndex) {
    const evidenceId = `evidence:${item.id}`;
    addNode({ id: evidenceId, type: 'evidence', label: item.title, stepIndex: item.stepIndex, status: item.status, summary: compact(item.summary, 180) });
    if (item.source === 'tool' && item.stepIndex) {
      const step = steps.find((candidate) => candidate.index === item.stepIndex);
      const toolIndex = step?.tools?.findIndex((tool) => tool.name === item.toolName);
      if (toolIndex !== undefined && toolIndex >= 0) addEdge(`step:${item.stepIndex}:tool:${toolIndex + 1}`, evidenceId, 'produces');
      else addEdge(`step:${item.stepIndex}`, evidenceId, 'produces');
    } else if (item.source === 'ledger') {
      addEdge(item.ledgerItemId ? `ledger:${item.ledgerItemId}` : item.id, evidenceId, 'supports');
    } else if (item.stepIndex) {
      addEdge(`step:${item.stepIndex}`, evidenceId, 'produces');
    }
  }

  const uniqueEdges = Array.from(new Map(edges.map((edge) => [`${edge.from}:${edge.type}:${edge.to}`, edge])).values());
  return {
    nodes: [...nodes.values()].slice(-500),
    edges: uniqueEdges.slice(-800),
  };
}

export function buildRunDiagnostics(steps: StepExecutionResult[], traceEvents: RunTraceEvent[], debugEvents: RunDebugEvent[] = []): RunDiagnosticSummary {
  const tools = steps.flatMap((step) => step.tools || []);
  const screenshots = buildEvidenceIndex(steps).filter((item) => item.kind === 'screenshot' && item.path);
  const runningStep = steps.find((step) => step.status === 'running');
  const visualFrameCount = steps.reduce((count, step) => count + (step.visualContext?.current ? 1 : 0) + (step.visualContext?.history?.length || 0), 0);
  const ledgerItemCount = steps.reduce((count, step) => count + (step.ledgerItems?.length || step.workingMemory?.ledgerItems?.length || 0), 0);
  const contextCompressionCount = debugEvents.filter((event) => event.phase === 'ai:context-compressed').length
    + steps.reduce((count, step) => count + (step.diagnostics?.contextCompressionCount || 0), 0);
  const contextBudgets = steps
    .map((step) => step.diagnostics)
    .filter((item): item is StepDiagnosticSummary => Boolean(item));
  const estimatedContexts = contextBudgets.map((item) => item.estimatedContextTokens).filter((item): item is number => typeof item === 'number');
  const budgetRatios = contextBudgets.map((item) => item.contextBudgetRatio).filter((item): item is number => typeof item === 'number');

  return {
    stepCount: steps.length,
    runningStepIndex: runningStep?.index,
    lastStepIndex: steps.at(-1)?.index,
    toolCallCount: tools.length,
    failedToolCallCount: tools.filter((tool) => tool.ok === false).length,
    screenshotCount: screenshots.length,
    visualFrameCount,
    ledgerItemCount,
    traceEventCount: traceEvents.length,
    contextCompressionCount,
    maxEstimatedContextTokens: estimatedContexts.length ? Math.max(...estimatedContexts) : undefined,
    maxContextBudgetRatio: budgetRatios.length ? Math.max(...budgetRatios) : undefined,
    latestContextBudgetRatio: contextBudgets.at(-1)?.contextBudgetRatio,
    latestContextImageCount: contextBudgets.at(-1)?.contextImageCount,
    lastPhase: debugEvents.at(-1)?.phase,
    updatedAt: now(),
  };
}

export function enrichRunResult(result: RunResult, debugEvents: RunDebugEvent[] = []): RunResult {
  const steps = (result.steps || []).map(enrichStepWithTrace);
  const ledgerItems = result.ledgerItems || [];
  const contextSummaryMap = new Map<string, NonNullable<StepExecutionResult['contextSummary']>>();
  for (const summary of [
    ...(result.contextSummaries || []),
    ...steps.flatMap((step) => [step.contextSummary, step.workingMemory?.contextSummary]),
  ].filter((summary): summary is NonNullable<StepExecutionResult['contextSummary']> => Boolean(summary))) {
    contextSummaryMap.set(`${summary.version}:${summary.createdAt}:${summary.sourceStepRange.join('-')}`, summary);
  }
  const contextSummaries = [...contextSummaryMap.values()].slice(-12);
  const traceEvents = buildRunTraceEvents(steps, debugEvents);
  const evidenceIndex = buildEvidenceIndex(steps, ledgerItems, traceEvents);
  const coverageMatrix = buildCoverageMatrix({ steps, taskFrame: result.taskFrame, ledgerItems, evidenceIndex });
  const evidenceGraph = buildEvidenceGraph(steps, ledgerItems, evidenceIndex);
  return {
    ...result,
    steps,
    contextSummaries,
    contextSummary: contextSummaries.at(-1) || result.contextSummary,
    traceEvents,
    evidenceIndex,
    coverageMatrix,
    evidenceGraph,
    diagnostics: buildRunDiagnostics(steps, traceEvents, debugEvents),
  };
}
