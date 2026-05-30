import { executeTestCase } from '@/server/ai/agents/test-executor.agent';
import { store } from '@/server/db/mock-store';
import { writeReport } from '@/server/reports/report-writer.agent';

async function executeRun(testCaseId: string, runId: string) {
  const testCase = store.getTestCase(testCaseId);
  if (!testCase) throw new Error('Test case not found');

  store.updateTestCaseStatus(testCaseId, 'running');
  store.updateRun(runId, {
    status: 'running',
    startedAt: new Date().toISOString(),
    result: { steps: [], consoleErrors: [], networkErrors: [] },
    debug: {
      enabled: process.env.AI_TEST_DEBUG === 'true',
      phase: 'starting',
      events: [],
    },
  });

  const execution = await executeTestCase(testCase, runId, {
    onProgress: (step) => {
      store.updateRunStep(runId, step);
    },
    onDebug: (event) => {
      if (process.env.AI_TEST_DEBUG === 'true') store.appendRunDebug(runId, event);
    },
    shouldSkipStep: (stepIndex) => store.consumeRunSkip(runId, stepIndex),
    shouldResumeStep: (stepIndex) => store.consumeRunResume(runId, stepIndex),
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
    const failed = store.updateRun(run.id, {
      status: 'blocked',
      endedAt: new Date().toISOString(),
      result: {
        steps: [
          {
            index: 1,
            action: 'Start AI browser run',
            expected: 'The AI agent can start and operate the browser.',
            actual: error instanceof Error ? error.message : 'Unknown execution error',
            status: 'blocked',
          },
        ],
        consoleErrors: [],
        networkErrors: [],
      },
    });
    if (failed) {
      const report = writeReport(testCase, failed);
      store.updateRun(run.id, { report });
    }
    store.updateTestCaseStatus(testCaseId, 'blocked');
  });

  return store.getRun(run.id) || run;
}
