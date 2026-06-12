import { z } from 'zod';
import type { ContextSummaryRecord, EvidenceIndexItem, RuntimeWorkingMemory, StepExecutionResult, TaskFrame, TaskLedgerItem } from '@/server/ai/schemas/test-case.schema';
import type { RequirementProgressDigest } from '@/server/ai/run-progress-digest';

export const contextSummarySchema = z.object({
  implementationGoal: z.array(z.string()).default([]),
  currentImplementationStatus: z.array(z.string()).default([]),
  nextExecutionPlan: z.array(z.string()).default([]),
  previousSummary: z.array(z.string()).default([]),
  ledgerDigest: z.array(z.string()).default([]),
  evidenceDigest: z.array(z.string()).default([]),
  antiRegressionRules: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  currentPageState: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).optional(),
});

export type ContextSummaryObject = z.infer<typeof contextSummarySchema>;

function compact(value?: string, max = 220) {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function uniqueStrings(values: Array<string | undefined> | undefined, limit = 12, max = 220) {
  return Array.from(new Set((values || []).map((item) => compact(item, max)).filter((item): item is string => Boolean(item)))).slice(0, limit);
}

function stepRange(steps: StepExecutionResult[]): [number, number] {
  const indexes = steps.map((step) => step.index).filter((index) => Number.isFinite(index)).sort((a, b) => a - b);
  return [indexes[0] || 0, indexes.at(-1) || 0];
}

function ledgerLine(item: TaskLedgerItem) {
  return compact([
    item.sourceStep ? `S${item.sourceStep}` : 'S?',
    item.dimensionId || 'general',
    item.status || 'finding',
    item.severity || 'info',
    item.title,
    item.summary || item.actual || item.expected || item.evidence?.[0],
  ].filter(Boolean).join(' / '), 260);
}

function evidenceLine(item: EvidenceIndexItem) {
  return compact([
    item.stepIndex ? `S${item.stepIndex}` : item.source,
    item.toolName,
    item.kind,
    item.title,
    item.summary,
  ].filter(Boolean).join(' / '), 260);
}

export function buildContextSummaryPrompt(input: {
  goal: string;
  taskFrame?: TaskFrame;
  progressDigest?: RequirementProgressDigest;
  workingMemory: RuntimeWorkingMemory;
  steps: StepExecutionResult[];
  ledgerItems: TaskLedgerItem[];
  evidenceIndex: EvidenceIndexItem[];
}) {
  const recentSteps = input.steps.slice(-12).map((step) => ({
    index: step.index,
    status: step.status,
    action: compact(step.action, 180),
    actual: compact(step.actual, 260),
    observation: compact(step.observation || step.note, 220),
    tools: (step.tools || []).slice(-4).map((tool) => ({
      name: tool.name,
      ok: tool.ok,
      reason: compact(tool.reason, 140),
      result: compact(tool.result, 180),
    })),
  }));

  return [
    'You are compressing a long AI browser-agent run into a durable structured context summary.',
    'Return JSON only. Use Chinese strings. Preserve verified progress; do not invent page facts.',
    '',
    'The output must be concise but explicit in these sections:',
    '- implementationGoal: 具体实现目标',
    '- currentImplementationStatus: 当前实现状态',
    '- nextExecutionPlan: 后续执行方案',
    '- previousSummary: 对此前的总结',
    '- ledgerDigest: 结构化台账摘要',
    '- evidenceDigest: 证据摘要',
    '- antiRegressionRules: 防回退规则',
    '- blockers/openQuestions/currentPageState: any extra important state',
    '',
    'Hard rules:',
    '- Historical candidate ids, marker ids, coordinates, DOM node ids, and screenshot-local labels are invalid after compression.',
    '- If progressDigest marks dimensions covered/issue/risk, treat them as already covered unless current evidence contradicts them.',
    '- The nextExecutionPlan must prioritize missing, in-progress, or questioned dimensions.',
    '',
    `User/task goal:\n${input.goal}`,
    '',
    `TaskFrame JSON:\n${JSON.stringify(input.taskFrame || null, null, 2)}`,
    '',
    `ProgressDigest JSON:\n${JSON.stringify(input.progressDigest || null, null, 2)}`,
    '',
    `WorkingMemory JSON:\n${JSON.stringify(input.workingMemory, null, 2)}`,
    '',
    `Recent steps JSON:\n${JSON.stringify(recentSteps, null, 2)}`,
    '',
    `Ledger digest:\n${input.ledgerItems.slice(-80).map(ledgerLine).join('\n') || '[none]'}`,
    '',
    `Evidence digest:\n${input.evidenceIndex.slice(-80).map(evidenceLine).join('\n') || '[none]'}`,
  ].join('\n');
}

export function normalizeContextSummary(input: {
  object: Partial<ContextSummaryObject>;
  goal: string;
  steps: StepExecutionResult[];
  workingMemory: RuntimeWorkingMemory;
  ledgerItems: TaskLedgerItem[];
  evidenceIndex: EvidenceIndexItem[];
  source: ContextSummaryRecord['source'];
  version?: number;
}): ContextSummaryRecord {
  const object = input.object || {};
  return {
    version: input.version || 1,
    createdAt: new Date().toISOString(),
    sourceStepRange: stepRange(input.steps),
    source: input.source,
    implementationGoal: uniqueStrings(object.implementationGoal?.length ? object.implementationGoal : [input.goal], 10, 260),
    currentImplementationStatus: uniqueStrings(object.currentImplementationStatus, 12, 260),
    nextExecutionPlan: uniqueStrings(object.nextExecutionPlan, 12, 260),
    previousSummary: uniqueStrings(object.previousSummary, 14, 260),
    ledgerDigest: uniqueStrings(object.ledgerDigest?.length ? object.ledgerDigest : input.ledgerItems.slice(-20).map(ledgerLine), 24, 280),
    evidenceDigest: uniqueStrings(object.evidenceDigest?.length ? object.evidenceDigest : input.evidenceIndex.slice(-20).map(evidenceLine), 24, 280),
    antiRegressionRules: uniqueStrings(object.antiRegressionRules?.length ? object.antiRegressionRules : [
      '不要回到已完成维度，除非当前证据推翻旧结论。',
      '不要复用历史 candidate id、marker id、DOM node id、坐标或截图局部编号。',
      '当前截图/当前 DOM 才是可操作上下文，历史截图仅作参考。',
      '压缩后继续执行 nextExecutionPlan，不要从第一张图或第一步重新开始。',
    ], 12, 260),
    blockers: uniqueStrings(object.blockers?.length ? object.blockers : input.workingMemory.blockers, 10, 260),
    openQuestions: uniqueStrings(object.openQuestions, 10, 260),
    currentPageState: uniqueStrings(object.currentPageState?.length ? object.currentPageState : [
      input.workingMemory.currentState,
      input.workingMemory.pageUnderstanding,
      input.workingMemory.scrollSummary,
    ], 10, 260),
    confidence: typeof object.confidence === 'number' ? object.confidence : undefined,
  };
}

export function fallbackContextSummary(input: {
  goal: string;
  steps: StepExecutionResult[];
  workingMemory: RuntimeWorkingMemory;
  ledgerItems: TaskLedgerItem[];
  evidenceIndex: EvidenceIndexItem[];
  progressDigest?: RequirementProgressDigest;
  version?: number;
}) {
  const recent = input.steps.slice(-8);
  return normalizeContextSummary({
    object: {
      implementationGoal: [
        input.goal,
        input.progressDigest?.nextObjectiveHint,
      ].filter(Boolean) as string[],
      currentImplementationStatus: [
        input.workingMemory.currentState,
        input.workingMemory.pageUnderstanding,
        input.progressDigest ? `覆盖率 ${Math.round((input.progressDigest.coverageRatio || 0) * 100)}%，未完成维度：${input.progressDigest.unresolvedDimensionIds.join(', ') || '无'}` : '',
      ].filter((item): item is string => Boolean(item)),
      nextExecutionPlan: [
        input.workingMemory.nextStep,
        input.progressDigest?.nextObjectiveHint,
      ].filter(Boolean) as string[],
      previousSummary: recent.map((step) => `S${step.index} [${step.status}] ${compact(step.observation || step.note || step.action, 220)}`),
      ledgerDigest: input.ledgerItems.slice(-24).map(ledgerLine),
      evidenceDigest: input.evidenceIndex.slice(-24).map(evidenceLine),
      antiRegressionRules: [],
      blockers: input.workingMemory.blockers,
      currentPageState: [
        input.workingMemory.currentState,
        input.workingMemory.scrollSummary,
      ].filter(Boolean) as string[],
    },
    goal: input.goal,
    steps: input.steps,
    workingMemory: input.workingMemory,
    ledgerItems: input.ledgerItems,
    evidenceIndex: input.evidenceIndex,
    source: 'fallback',
    version: input.version,
  });
}

export function formatContextSummaryForPrompt(summary?: ContextSummaryRecord) {
  if (!summary) return '';
  const section = (title: string, items?: string[]) => [
    `## ${title}`,
    items?.length ? items.map((item) => `- ${item}`).join('\n') : '- 无',
  ].join('\n');
  return [
    'Structured Context Summary:',
    section('具体实现目标', summary.implementationGoal),
    section('当前实现状态', summary.currentImplementationStatus),
    section('后续执行方案', summary.nextExecutionPlan),
    section('对此前的总结', summary.previousSummary),
    section('结构化台账摘要', summary.ledgerDigest),
    section('证据摘要', summary.evidenceDigest),
    section('防回退规则', summary.antiRegressionRules),
    section('阻塞点', summary.blockers),
    section('疑问点', summary.openQuestions),
    section('当前页面状态', summary.currentPageState),
  ].join('\n\n');
}
