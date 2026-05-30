import { executeTestCase } from '@/server/ai/agents/test-executor.agent';
import type { StepExecutionResult, TestRunRecord } from '@/server/ai/schemas/test-case.schema';
import { store } from '@/server/db/mock-store';
import { writeReport } from '@/server/reports/report-writer.agent';

type ExecuteRunOptions = {
  continueExisting?: boolean;
};

async function executeRun(testCaseId: string, runId: string, options: ExecuteRunOptions = {}) {
  const testCase = store.getTestCase(testCaseId);
  if (!testCase) throw new Error('Test case not found');
  const existingRun = store.getRun(runId);
  const initialSteps = options.continueExisting ? existingRun?.result?.steps || [] : [];

  store.updateTestCaseStatus(testCaseId, 'running');
  store.updateRun(runId, {
    status: 'running',
    startedAt: existingRun?.startedAt || new Date().toISOString(),
    endedAt: undefined,
    report: undefined,
    control: undefined,
    result: options.continueExisting
      ? existingRun?.result || { steps: [], consoleErrors: [], networkErrors: [] }
      : { steps: [], consoleErrors: [], networkErrors: [] },
    debug: {
      enabled: process.env.AI_TEST_DEBUG === 'true',
      phase: options.continueExisting ? 'continuing' : 'starting',
      events: options.continueExisting ? existingRun?.debug?.events || [] : [],
    },
  });

  const execution = await executeTestCase(testCase, runId, {
    initialSteps,
    onProgress: (step) => {
      store.updateRunStep(runId, step);
    },
    onDebug: (event) => {
      if (process.env.AI_TEST_DEBUG === 'true') store.appendRunDebug(runId, event);
    },
    shouldSkipStep: (stepIndex) => store.consumeRunSkip(runId, stepIndex),
    shouldPauseRun: () => store.isRunPaused(runId),
    shouldResumeStep: (stepIndex) => store.consumeRunResume(runId, stepIndex),
    onPaused: () => {
      store.updateRun(runId, { status: 'paused' });
    },
    onResumed: () => {
      store.updateRun(runId, { status: 'running' });
    },
    onManualIntervention: (manualIntervention) => {
      store.setRunManualIntervention(runId, {
        ...manualIntervention,
        requestedAt: new Date().toISOString(),
      });
    },
    onManualInterventionCleared: () => {
      store.setRunManualIntervention(runId);
    },
  });

  const current = store.getRun(runId);
  const finished = store.updateRun(runId, {
    status: execution.status,
    endedAt: new Date().toISOString(),
    control: undefined,
    result: {
      steps: current?.result?.steps?.length ? current.result.steps : execution.result.steps,
      consoleErrors: execution.result.consoleErrors,
      networkErrors: execution.result.networkErrors,
    },
  });

  if (!finished) throw new Error('Run not found after execution');
  const report = writeReport(testCase, finished);
  const withReport = store.updateRun(runId, { report });
  store.updateTestCaseStatus(testCaseId, execution.status);

  return withReport;
}

function createRunningRun(testCaseId: string) {
  const testCase = store.getTestCase(testCaseId);
  if (!testCase) throw new Error('Test case not found');

  const run = store.createRun(testCaseId);
  store.updateTestCaseStatus(testCaseId, 'running');
  store.updateRun(run.id, {
    status: 'running',
    startedAt: new Date().toISOString(),
    result: { steps: [], consoleErrors: [], networkErrors: [] },
    debug: {
      enabled: process.env.AI_TEST_DEBUG === 'true',
      phase: 'queued',
      events: [],
    },
  });

  return { run, testCase };
}

export async function runTestCase(testCaseId: string) {
  const { run } = createRunningRun(testCaseId);
  return executeRun(testCaseId, run.id);
}

export function startTestCaseRun(testCaseId: string) {
  const { run, testCase } = createRunningRun(testCaseId);

  void executeRun(testCaseId, run.id).catch((error) => {
    persistBackgroundRunFailure(run, testCase, error);
  });

  return store.getRun(run.id) || run;
}

export function continueTestCaseRun(runId: string) {
  const run = store.getRun(runId);
  if (!run) throw new Error('Run not found');
  if (run.status === 'running' || run.status === 'queued' || run.status === 'paused') return run;
  const testCase = store.getTestCase(run.testCaseId);
  if (!testCase) throw new Error('Test case not found');

  store.updateRun(runId, {
    status: 'running',
    endedAt: undefined,
    report: undefined,
    control: undefined,
  });
  store.updateTestCaseStatus(run.testCaseId, 'running');

  void executeRun(run.testCaseId, runId, { continueExisting: true }).catch((error) => {
    persistBackgroundRunFailure(run, testCase, error);
  });

  return store.getRun(runId) || run;
}

function persistBackgroundRunFailure(run: TestRunRecord, testCase: ReturnType<typeof store.getTestCase>, error: unknown) {
  if (!testCase) return;
  try {
    const current = store.getRun(run.id) || run;
    const previousSteps = current.result?.steps || [];
    const errorStep: StepExecutionResult = {
      index: Math.max(0, ...previousSteps.map((step) => step.index)) + 1,
      action: 'Start or continue AI browser run',
      expected: 'The AI agent can start and operate the browser.',
      actual: error instanceof Error ? error.message : 'Unknown execution error',
      status: 'blocked',
    };
    const failed = store.updateRun(run.id, {
      status: 'blocked',
      endedAt: new Date().toISOString(),
      result: {
        steps: [...previousSteps, errorStep],
        consoleErrors: current.result?.consoleErrors || [],
        networkErrors: current.result?.networkErrors || [],
      },
    });
    if (failed) {
      const report = writeReport(testCase, failed);
      store.updateRun(run.id, { report });
    }
    store.updateTestCaseStatus(run.testCaseId, 'blocked');
  } catch (persistError) {
    console.error('Failed to persist background run failure', persistError);
  }
}
