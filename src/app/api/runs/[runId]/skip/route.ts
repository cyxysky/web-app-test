import { NextResponse } from 'next/server';
import { abortRunStep } from '@/server/ai/run-control.registry';
import type { StepExecutionResult, TestRunRecord } from '@/server/ai/schemas/test-case.schema';
import { store } from '@/server/db/mock-store';

type RouteContext = {
  params: Promise<{ runId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { runId } = await context.params;
  const body = await request.json().catch(() => ({}));
  const stepIndex = typeof body.stepIndex === 'number' ? body.stepIndex : undefined;
  const aborted = abortRunStep(runId, stepIndex);
  const run = store.requestRunSkip(runId, stepIndex);

  if (!run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  const skippedRun = writeImmediateSkippedStep(run, stepIndex) || run;
  return NextResponse.json({ ok: true, aborted, run: skippedRun });
}

function writeImmediateSkippedStep(run: TestRunRecord, requestedStepIndex?: number) {
  const steps = run.result?.steps || [];
  const currentStep = typeof requestedStepIndex === 'number'
    ? steps.find((step) => step.index === requestedStepIndex)
    : steps.find((step) => step.status === 'running') || steps.at(-1);
  const stepIndex = requestedStepIndex ?? currentStep?.index;
  if (typeof stepIndex !== 'number') return undefined;

  const skippedStep: StepExecutionResult = {
    index: stepIndex,
    action: currentStep?.action || 'User skipped current AI step',
    expected: currentStep?.expected || 'After this skipped step, continue to the next AI decision.',
    actual: 'User skipped this step manually.',
    status: 'blocked',
    beforeScreenshotPath: currentStep?.beforeScreenshotPath,
    afterScreenshotPath: currentStep?.afterScreenshotPath,
    screenshotPath: currentStep?.screenshotPath || currentStep?.afterScreenshotPath || currentStep?.beforeScreenshotPath,
    tools: currentStep?.tools,
    aiRequest: currentStep?.aiRequest,
    observation: currentStep?.observation,
    findings: currentStep?.findings,
    memoryItems: currentStep?.memoryItems,
    taskFrame: currentStep?.taskFrame,
    ledgerItems: currentStep?.ledgerItems,
    visualContext: currentStep?.visualContext,
    workingMemory: currentStep?.workingMemory,
  };

  return store.updateRunStep(run.id, skippedStep);
}
