import { executeTestCase } from '@/server/ai/agents/test-executor.agent';
import type { RecordedFlowStep, StepExecutionResult, TestRunRecord } from '@/server/ai/schemas/test-case.schema';
import { store } from '@/server/db/mock-store';
import { writeReport } from '@/server/reports/report-writer.agent';

type ExecuteRunOptions = {
  continueExisting?: boolean;
  recordedFlow?: RecordedFlowStep[];
};

// 执行一次测试运行，并把步骤进度、调试事件、人工介入状态同步写入存储。
function jsonClone(value: unknown) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function isCertificateBypassTool(step: StepExecutionResult, tool: NonNullable<StepExecutionResult['tools']>[number]) {
  const text = [
    step.action,
    step.actual,
    tool.reason,
    tool.result,
    JSON.stringify(tool.input || {}),
  ].filter(Boolean).join('\n');
  return /chrome-error:\/\/chromewebdata|ERR_CERT|certificate warning|certificate error|security warning|continue toward the login page|继续前往|证书错误|证书安全|证书安全警告|不安全站点|unsafe/i.test(text);
}

function recordedFlowFromSteps(steps: StepExecutionResult[]): RecordedFlowStep[] {
  return steps
    .flatMap((step) => (step.tools || []).map((tool) => ({ step, tool })))
    .filter(({ step, tool }) => tool.name && tool.ok !== false && !isCertificateBypassTool(step, tool))
    .map(({ tool }, index) => ({
      index: index + 1,
      name: tool.name,
      input: jsonClone(tool.input),
      reason: tool.reason,
    }));
}

function ensureReplayStartsFromTarget(recordedFlow: RecordedFlowStep[], targetUrl: string): RecordedFlowStep[] {
  const replayFlow = recordedFlow.filter((step, index) => {
    if (index !== 0) return true;
    return step.name !== 'openPage' && step.name !== 'openUrl';
  });
  return [
    {
      index: 1,
      name: 'openPage',
      input: { url: targetUrl },
      reason: 'Replay starts from the test case target URL so recorded candidate actions run on the expected page.',
    },
    ...replayFlow.map((step, index) => ({ ...step, index: index + 2 })),
  ];
}

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
    recordedFlow: options.recordedFlow,
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

// 创建处于 running 状态的运行记录，作为同步或后台执行的初始数据。
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

// 同步执行测试用例，调用方会等待整次运行结束。
export async function runTestCase(testCaseId: string) {
  const { run } = createRunningRun(testCaseId);
  return executeRun(testCaseId, run.id);
}

// 后台启动测试用例执行，立即返回运行记录供前端轮询。
export function startTestCaseRun(testCaseId: string) {
  const { run, testCase } = createRunningRun(testCaseId);

  void executeRun(testCaseId, run.id).catch((error) => {
    persistBackgroundRunFailure(run, testCase, error);
  });

  return store.getRun(run.id) || run;
}

// 从已结束或阻塞的运行记录继续执行，保留已有步骤作为上下文。
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

// 后台执行发生异常时，把失败步骤和报告落库，避免前端看到悬空的 running 状态。
export function replayRun(runId: string) {
  const sourceRun = store.getRun(runId);
  if (!sourceRun) throw new Error('Run not found');
  if (sourceRun.status === 'running' || sourceRun.status === 'queued' || sourceRun.status === 'paused') {
    throw new Error('Cannot replay a run that is still active');
  }
  const testCase = store.getTestCase(sourceRun.testCaseId);
  if (!testCase) throw new Error('Test case not found');
  const recordedFlow = ensureReplayStartsFromTarget(
    recordedFlowFromSteps(sourceRun.result?.steps || []),
    testCase.targetUrl,
  );
  if (!recordedFlow.length) throw new Error('No successful tool calls found in this run');

  const { run } = createRunningRun(sourceRun.testCaseId);
  store.appendRunDebug(run.id, {
    phase: 'recorded:source',
    message: `Replaying ${recordedFlow.length} successful tool calls from ${sourceRun.id}.`,
    details: { sourceRunId: sourceRun.id, recordedFlow },
  });

  void executeRun(sourceRun.testCaseId, run.id, { recordedFlow }).catch((error) => {
    persistBackgroundRunFailure(run, testCase, error);
  });

  return store.getRun(run.id) || run;
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
