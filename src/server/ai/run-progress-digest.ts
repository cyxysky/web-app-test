import type { StepExecutionResult, TaskFrame, TaskLedgerItem } from '@/server/ai/schemas/test-case.schema';

export type RequirementProgressDigest = {
  stepCount: number;
  highestStepIndex?: number;
  coverageRatio?: number;
  dimensions: Array<{
    id: string;
    name: string;
    status: 'missing' | 'in_progress' | 'covered' | 'issue' | 'risk' | 'question';
    itemCount: number;
    latestStep?: number;
    latestSummary?: string;
  }>;
  unresolvedDimensionIds: string[];
  resolvedDimensionIds: string[];
  issueDimensionIds: string[];
  riskDimensionIds: string[];
  nextUnresolvedDimension?: {
    id: string;
    name: string;
  };
  nextObjectiveHint: string;
  statusCounts: Record<'missing' | 'in_progress' | 'covered' | 'issue' | 'risk' | 'question', number>;
  rule: string;
};

function compact(value?: string, max = 180) {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function uniqueLedgerItems(items: TaskLedgerItem[]) {
  const map = new Map<string, TaskLedgerItem>();
  for (const item of items) {
    const key = item.id || `${item.dimensionId}:${item.status || ''}:${item.title}`.toLowerCase();
    map.set(key, item);
  }
  return [...map.values()];
}

function statusForItems(items: TaskLedgerItem[]): RequirementProgressDigest['dimensions'][number]['status'] {
  if (items.some((item) => item.status === 'issue' || item.severity === 'critical')) return 'issue';
  if (items.some((item) => item.status === 'risk')) return 'risk';
  if (items.some((item) => item.status === 'question')) return 'question';
  if (items.some((item) => item.status === 'covered' || item.status === 'decision' || item.status === 'evidence')) return 'covered';
  if (items.length) return 'in_progress';
  return 'missing';
}

export function buildProgressDigest(input: {
  steps: StepExecutionResult[];
  taskFrame?: TaskFrame;
  ledgerItems?: TaskLedgerItem[];
}): RequirementProgressDigest {
  const steps = input.steps || [];
  const ledgerItems = uniqueLedgerItems(input.ledgerItems || []);
  const dimensions = input.taskFrame?.dimensions?.length
    ? input.taskFrame.dimensions.map((dimension) => ({ id: dimension.id, name: dimension.name }))
    : Array.from(new Set(ledgerItems.map((item) => item.dimensionId || 'general'))).map((id) => ({ id, name: id }));

  const dimensionProgress = dimensions.map((dimension) => {
    const items = ledgerItems.filter((item) => (item.dimensionId || 'general') === dimension.id);
    const latest = items
      .filter((item) => typeof item.sourceStep === 'number')
      .sort((a, b) => (a.sourceStep || 0) - (b.sourceStep || 0))
      .at(-1);
    const latestItem = latest || items.at(-1);
    return {
      ...dimension,
      status: statusForItems(items),
      itemCount: items.length,
      latestStep: latest?.sourceStep,
      latestSummary: compact(latestItem ? [latestItem.title, latestItem.summary || latestItem.actual || latestItem.expected].filter(Boolean).join(': ') : ''),
    };
  });

  const unresolved = dimensionProgress.filter((dimension) => (
    dimension.status === 'missing'
    || dimension.status === 'in_progress'
    || dimension.status === 'question'
  ));
  const coveredCount = dimensionProgress.filter((dimension) => dimension.status === 'covered').length;
  const nextUnresolved = unresolved[0];
  const statusCounts = dimensionProgress.reduce((counts, dimension) => {
    counts[dimension.status] += 1;
    return counts;
  }, {
    missing: 0,
    in_progress: 0,
    covered: 0,
    issue: 0,
    risk: 0,
    question: 0,
  } satisfies RequirementProgressDigest['statusCounts']);

  return {
    stepCount: steps.length,
    highestStepIndex: steps.map((step) => step.index).sort((a, b) => a - b).at(-1),
    coverageRatio: dimensionProgress.length ? Number((coveredCount / dimensionProgress.length).toFixed(2)) : undefined,
    dimensions: dimensionProgress,
    unresolvedDimensionIds: unresolved.map((dimension) => dimension.id),
    resolvedDimensionIds: dimensionProgress.filter((dimension) => (
      dimension.status === 'covered'
      || dimension.status === 'issue'
      || dimension.status === 'risk'
    )).map((dimension) => dimension.id),
    issueDimensionIds: dimensionProgress.filter((dimension) => dimension.status === 'issue').map((dimension) => dimension.id),
    riskDimensionIds: dimensionProgress.filter((dimension) => dimension.status === 'risk').map((dimension) => dimension.id),
    nextUnresolvedDimension: nextUnresolved ? { id: nextUnresolved.id, name: nextUnresolved.name } : undefined,
    nextObjectiveHint: nextUnresolved
      ? `Continue with ${nextUnresolved.name} (${nextUnresolved.id}); do not restart resolved dimensions unless new evidence contradicts them.`
      : 'All known dimensions have ledger evidence; summarize from TaskFrame plus ledger instead of restarting earlier screenshots.',
    statusCounts,
    rule: 'Treat covered/issue/risk dimensions as resolved coverage unless current evidence contradicts them; continue with missing, in-progress, or questioned dimensions first.',
  };
}
