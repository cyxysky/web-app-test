import { existsSync } from 'node:fs';
import sharp from 'sharp';
import { executeTestCase } from '@/server/ai/agents/target-executor.agent';
import type { RecordedFlowStep, StepExecutionResult, TaskLedgerItem, TestRunRecord } from '@/server/ai/schemas/test-case.schema';
import { store } from '@/server/db/mock-store';
import { writeAiReport } from '@/server/reports/report-writer.agent';
import { artifactPath } from '@/server/storage/paths';

type ExecuteRunOptions = {
  continueExisting?: boolean;
  recordedFlow?: RecordedFlowStep[];
  source?: NonNullable<TestRunRecord['queue']>['source'];
};

type QueueJob = {
  runId: string;
  testCaseId: string;
  options?: ExecuteRunOptions;
};

const workerId = `worker_${Math.random().toString(36).slice(2, 8)}`;
const runQueue: QueueJob[] = [];
let activeWorkers = 0;
let schedulerStarted = false;

function queueConcurrency() {
  const raw = Number(process.env.RUN_WORKER_CONCURRENCY || process.env.AI_RUN_WORKER_CONCURRENCY || 1);
  return Math.max(1, Math.floor(Number.isFinite(raw) ? raw : 1));
}

function syncQueuePositions() {
  runQueue.forEach((job, index) => {
    const run = store.getRun(job.runId);
    if (!run?.queue) return;
    store.updateRunQueue(job.runId, {
      ...run.queue,
      position: index + 1,
    });
  });
}

function enqueueRun(job: QueueJob) {
  store.applyRuntimeEnv();
  if (!runQueue.some((item) => item.runId === job.runId)) runQueue.push(job);
  syncQueuePositions();
  void drainQueue();
}

async function drainQueue() {
  store.applyRuntimeEnv();
  while (activeWorkers < queueConcurrency() && runQueue.length) {
    const job = runQueue.shift()!;
    syncQueuePositions();
    activeWorkers += 1;
    void executeQueuedJob(job).finally(() => {
      activeWorkers -= 1;
      void drainQueue();
    });
  }
}

async function executeQueuedJob(job: QueueJob) {
  const run = store.getRun(job.runId);
  const testCase = store.getTestCase(job.testCaseId);
  if (!run || !testCase) return;
  const attempts = (run.queue?.attempts || 0) + 1;
  store.updateRunQueue(job.runId, {
    ...run.queue,
    attempts,
    position: undefined,
    startedAt: new Date().toISOString(),
    workerId,
    enqueuedAt: run.queue?.enqueuedAt || run.createdAt,
  });
  try {
    await executeRun(job.testCaseId, job.runId, job.options);
  } catch (error) {
    persistBackgroundRunFailure(run, testCase, error);
  }
}

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

function replayStepDelayMs() {
  const raw = Number(process.env.REPLAY_STEP_DELAY_MS || 1500);
  return Math.max(0, Math.floor(Number.isFinite(raw) ? raw : 1500));
}

function isManualVerificationReplayPoint(step: StepExecutionResult, tool: NonNullable<StepExecutionResult['tools']>[number]) {
  if (tool.name === 'waitForHumanVerification') return true;
  const text = [
    step.action,
    step.expected,
    step.actual,
    step.observation,
    ...(step.findings || []),
    tool.reason,
    tool.result,
  ].filter(Boolean).join('\n');
  return /验证码|安全校验|安全验证|人机验证|人工|用户介入|captcha|verification\s*code|security\s*check|human\s*verification|two[-\s]?factor|\b2fa\b|\botp\b/i.test(text);
}

function recordedFlowFromSteps(steps: StepExecutionResult[]): RecordedFlowStep[] {
  const defaultDelayMs = replayStepDelayMs();
  return steps
    .flatMap((step) => (step.tools || []).map((tool, toolIndex) => ({ step, tool, toolIndex })))
    .filter(({ step, tool }) => tool.name && tool.ok !== false && !isCertificateBypassTool(step, tool))
    .map(({ step, tool, toolIndex }, index) => ({
      index: index + 1,
      name: tool.name,
      input: jsonClone(tool.input),
      reason: tool.reason,
      delayBeforeMs: index === 0 ? 0 : defaultDelayMs,
      waitForManual: isManualVerificationReplayPoint(step, tool),
      sourceStepIndex: step.index,
      sourceStepAction: step.action,
      sourceStepExpected: step.expected,
      sourceToolIndex: toolIndex + 1,
    }));
}

function compactMemoryText(value?: string, max = 220) {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function buildFinalRunMemory(
  steps: StepExecutionResult[],
  previous?: NonNullable<NonNullable<TestRunRecord['result']>['memory']>,
): NonNullable<NonNullable<TestRunRecord['result']>['memory']> {
  const timeline = steps.map((step) => {
    const reasons = (step.tools || []).map((toolCall) => toolCall.reason).filter(Boolean).join('；');
    return `Step ${step.index} [${step.status}]: ${[
      step.observation ? `观察：${compactMemoryText(step.observation, 100)}` : '',
      step.note ? `进展：${compactMemoryText(step.note, 100)}` : '',
      reasons ? `原因：${compactMemoryText(reasons, 140)}` : '',
      step.findings?.length ? `发现：${compactMemoryText(step.findings.join('；'), 140)}` : '',
    ].filter(Boolean).join(' | ') || compactMemoryText(step.action || step.actual)}`;
  }).slice(-40);
  const ledgerSummaries = collectTaskLedgerItems(steps)
    .map((item) => compactMemoryText(`${item.status || 'finding'}:${item.title}${item.summary ? ` - ${item.summary}` : ''}`, 260))
    .filter(Boolean);
  const findings = Array.from(new Set([
    ...(previous?.findings || []),
    ...steps.flatMap((step) => step.findings || []),
    ...ledgerSummaries,
  ].map((item) => compactMemoryText(item, 260)).filter(Boolean))).slice(-40);
  const failedAttempts = Array.from(new Set([
    ...(previous?.failedAttempts || []),
    ...steps
      .filter((step) => step.status === 'failed' || step.status === 'blocked')
      .map((step) => `Step ${step.index}: ${compactMemoryText(step.action, 100)} -> ${compactMemoryText(step.actual, 220)}`),
  ])).slice(-20);
  const memoryItems = Array.from(new Set(steps.flatMap((step) => step.memoryItems || []).map((item) => compactMemoryText(item, 260)).filter(Boolean))).slice(-24);
  const summary = [
    `已执行 ${steps.length} 步。`,
    steps.length ? `最近进展：${steps.slice(-6).map((step) => `S${step.index}:${compactMemoryText(step.observation || step.note || step.action, 80)}`).join('；')}` : '',
    findings.length ? `重要发现：${findings.slice(-8).join('；')}` : '',
    memoryItems.length ? `后续记忆：${memoryItems.slice(-8).join('；')}` : '',
  ].filter(Boolean).join('\n').slice(0, 1800);
  return {
    summary,
    timeline,
    findings,
    failedAttempts,
    updatedAt: new Date().toISOString(),
  };
}

function taskLedgerKey(item: TaskLedgerItem) {
  return item.id || `${item.dimensionId}:${item.status || ''}:${item.title}`.toLowerCase();
}

function collectTaskFrame(steps: StepExecutionResult[]) {
  return steps.map((step) => step.taskFrame || step.workingMemory?.taskFrame).filter(Boolean).at(-1);
}

function collectTaskLedgerItems(steps: StepExecutionResult[]) {
  const map = new Map<string, TaskLedgerItem>();
  for (const item of [
    ...steps.flatMap((step) => step.ledgerItems || []),
    ...steps.flatMap((step) => step.workingMemory?.ledgerItems || []),
  ]) {
    map.set(taskLedgerKey(item), item);
  }
  return [...map.values()];
}

function isInitialReplayNavigation(step?: RecordedFlowStep) {
  return step?.name === 'openPage' || step?.name === 'openUrl';
}

function ensureReplayStartsFromTarget(recordedFlow: RecordedFlowStep[], targetUrl: string): RecordedFlowStep[] {
  const replayFlow = recordedFlow.filter((step, index) => {
    if (index !== 0) return true;
    return !isInitialReplayNavigation(step);
  });
  const initialNavigation = isInitialReplayNavigation(recordedFlow[0]) ? recordedFlow[0] : undefined;
  const defaultDelayMs = replayStepDelayMs();
  return [
    {
      index: 1,
      name: 'openPage',
      input: { url: targetUrl },
      delayBeforeMs: 0,
      reason: 'Replay starts from the test case target URL so recorded candidate actions run on the expected page.',
      sourceStepIndex: initialNavigation?.sourceStepIndex,
      sourceStepAction: initialNavigation?.sourceStepAction,
      sourceStepExpected: initialNavigation?.sourceStepExpected,
      sourceToolIndex: initialNavigation?.sourceToolIndex,
    },
    ...replayFlow.map((step, index) => ({
      ...step,
      index: index + 2,
      delayBeforeMs: index === 0 && !step.delayBeforeMs ? defaultDelayMs : step.delayBeforeMs,
    })),
  ];
}

async function screenshotChangeScore(beforePath?: string, afterPath?: string) {
  if (!beforePath || !afterPath || !existsSync(beforePath) || !existsSync(afterPath)) return 0;
  const [before, after] = await Promise.all([
    sharp(beforePath, { failOn: 'none' }).resize(48, 36, { fit: 'fill' }).greyscale().raw().toBuffer(),
    sharp(afterPath, { failOn: 'none' }).resize(48, 36, { fit: 'fill' }).greyscale().raw().toBuffer(),
  ]);
  const length = Math.min(before.length, after.length);
  if (!length) return 0;
  let diff = 0;
  for (let index = 0; index < length; index += 1) diff += Math.abs(before[index] - after[index]);
  return Number((diff / (length * 255)).toFixed(4));
}

async function analyzeRunOutcome(run: TestRunRecord) {
  const steps = run.result?.steps || [];
  const pageChanges = await Promise.all(steps.map(async (step) => {
    const changeScore = await screenshotChangeScore(step.beforeScreenshotPath, step.afterScreenshotPath || step.screenshotPath).catch(() => 0);
    const changed = changeScore >= 0.018;
    return {
      stepIndex: step.index,
      changed,
      changeScore,
      summary: changed
        ? `步骤 ${step.index} 执行前后页面有可见变化，变化分数 ${changeScore}。`
        : `步骤 ${step.index} 执行前后页面变化很小，变化分数 ${changeScore}，可能点击未命中、等待不足或页面被遮罩拦截。`,
    };
  }));

  const failedSteps = steps.filter((step) => step.status === 'failed' || step.status === 'blocked');
  const noChangeFailed = failedSteps.filter((step) => !pageChanges.find((change) => change.stepIndex === step.index)?.changed);
  const toolFailures = steps.flatMap((step) => (step.tools || []).filter((tool) => tool.ok === false).map((tool) => ({ step, tool })));
  const repeatedTools = new Map<string, number>();
  for (const step of steps) {
    for (const toolCall of step.tools || []) {
      const key = `${toolCall.name}:${JSON.stringify(toolCall.input || {})}`;
      repeatedTools.set(key, (repeatedTools.get(key) || 0) + 1);
    }
  }

  const repairSuggestions = [
    noChangeFailed.length ? '失败步骤前后截图变化很小：下次优先选择更小、更贴近文字/图标的候选元素，或先关闭遮罩、滚动到目标区域后再操作。' : '',
    toolFailures.length ? '存在工具调用失败：下次应先重新读取候选元素/DOM，再执行替代路径，避免复用旧 candidate id。' : '',
    [...repeatedTools.values()].some((count) => count >= 3) ? '检测到重复工具调用：下次同一可见目标最多尝试两次，第三次必须换目标、换操作或换导航路径。' : '',
    failedSteps.some((step) => /captcha|验证码|otp|security|安全|人工/i.test(step.actual)) ? '失败可能来自人工验证：下次遇到验证码/OTP/安全校验时进入人工介入，不要继续自动绕过。' : '',
  ].filter(Boolean);

  const promptHints = [
    noChangeFailed.length ? '如果上一次相同目标点击后页面没有可见变化，不要第三次点击同一目标；改用更具体的子元素、键盘操作、滚动或重新打开入口。' : '',
    toolFailures.length ? '工具失败后先刷新当前候选元素和页面状态，再选择替代操作。' : '',
    failedSteps.length ? `历史失败摘要：${failedSteps.slice(-3).map((step) => `步骤${step.index} ${step.action} -> ${step.actual}`).join('；')}` : '',
  ].filter(Boolean);

  return {
    pageChanges,
    repairSuggestions: repairSuggestions.length ? repairSuggestions : ['本次未发现明显失败模式；若后续失败，请优先检查目标环境、账号状态和断言条件。'],
    promptHints,
    selfHealing: {
      applied: [
        '执行器已限制同一可见目标重复尝试次数。',
        '完成校验失败后会把剩余工作写回下一轮 prompt。',
        '历史失败策略会自动注入后续运行 prompt。',
      ],
      nextRunStrategy: promptHints,
    },
  };
}

async function executeRun(testCaseId: string, runId: string, options: ExecuteRunOptions = {}) {
  store.applyRuntimeEnv();
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
    recordedFlow: options.recordedFlow || (options.continueExisting ? undefined : testCase.content.recordedFlow),
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
  const tracePath = artifactPath(runId, 'trace.zip');
  const executionTracePath = (execution.result as { tracePath?: string }).tracePath;
  const finalSteps = current?.result?.steps?.length ? current.result.steps : execution.result.steps;
  const finished = store.updateRun(runId, {
    status: execution.status,
    endedAt: new Date().toISOString(),
    control: undefined,
    result: {
      steps: finalSteps,
      consoleErrors: execution.result.consoleErrors,
      networkErrors: execution.result.networkErrors,
      tracePath: existsSync(tracePath) ? tracePath : executionTracePath,
      taskFrame: collectTaskFrame(finalSteps) || testCase.content.taskFrame,
      ledgerItems: collectTaskLedgerItems(finalSteps),
      memory: buildFinalRunMemory(finalSteps, current?.result?.memory),
    },
  });

  if (!finished) throw new Error('Run not found after execution');
  const report = await writeAiReport(testCase, finished);
  const analysis = await analyzeRunOutcome({ ...finished, report });
  const withReport = store.updateRun(runId, { report, analysis });
  if (execution.status === 'failed' || execution.status === 'blocked') {
    store.appendTestCaseStrategyMemory(testCaseId, analysis.promptHints);
  }
  store.updateTestCaseStatus(testCaseId, execution.status);

  return withReport;
}

// 创建处于 running 状态的运行记录，作为同步或后台执行的初始数据。
function createQueuedRun(testCaseId: string, source: NonNullable<TestRunRecord['queue']>['source'] = 'single') {
  const testCase = store.getTestCase(testCaseId);
  if (!testCase) throw new Error('Test case not found');

  const run = store.createRun(testCaseId);
  store.updateTestCaseStatus(testCaseId, 'running');
  store.updateRun(run.id, {
    status: 'queued',
    result: { steps: [], consoleErrors: [], networkErrors: [] },
    queue: {
      attempts: 0,
      enqueuedAt: new Date().toISOString(),
      source,
    },
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
  const { run } = createQueuedRun(testCaseId);
  return executeRun(testCaseId, run.id);
}

// 后台启动测试用例执行，立即返回运行记录供前端轮询。
export function startTestCaseRun(testCaseId: string, source: NonNullable<TestRunRecord['queue']>['source'] = 'single') {
  const { run } = createQueuedRun(testCaseId, source);
  enqueueRun({ runId: run.id, testCaseId, options: { source } });

  return store.getRun(run.id) || run;
}

export function startBatchRun(testCaseIds: string[], source: NonNullable<TestRunRecord['queue']>['source'] = 'batch') {
  return Array.from(new Set(testCaseIds))
    .map((testCaseId) => startTestCaseRun(testCaseId, source))
    .filter(Boolean);
}

// 从已结束或阻塞的运行记录继续执行，保留已有步骤作为上下文。
export function continueTestCaseRun(runId: string) {
  const run = store.getRun(runId);
  if (!run) throw new Error('Run not found');
  if (run.status === 'running' || run.status === 'queued' || run.status === 'paused') return run;
  const testCase = store.getTestCase(run.testCaseId);
  if (!testCase) throw new Error('Test case not found');

  store.updateRun(runId, {
    status: 'queued',
    endedAt: undefined,
    report: undefined,
    control: undefined,
    queue: {
      attempts: run.queue?.attempts || 0,
      enqueuedAt: new Date().toISOString(),
      source: 'continue',
    },
  });
  store.updateTestCaseStatus(run.testCaseId, 'running');

  enqueueRun({ runId, testCaseId: run.testCaseId, options: { continueExisting: true, source: 'continue' } });

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

  const { run } = createQueuedRun(sourceRun.testCaseId, 'replay');
  store.appendRunDebug(run.id, {
    phase: 'recorded:source',
    message: `Replaying ${recordedFlow.length} successful tool calls from ${sourceRun.id}.`,
    details: { sourceRunId: sourceRun.id, recordedFlow },
  });

  enqueueRun({ runId: run.id, testCaseId: sourceRun.testCaseId, options: { recordedFlow, source: 'replay' } });

  return store.getRun(run.id) || run;
}

export function getRecordedFlowForRun(runId: string) {
  const run = store.getRun(runId);
  if (!run) throw new Error('Run not found');
  const testCase = store.getTestCase(run.testCaseId);
  if (!testCase) throw new Error('Test case not found');
  return ensureReplayStartsFromTarget(recordedFlowFromSteps(run.result?.steps || []), testCase.targetUrl);
}

export function createTestCaseFromRecordedRun(runId: string) {
  const run = store.getRun(runId);
  if (!run) throw new Error('Run not found');
  const source = store.getTestCase(run.testCaseId);
  if (!source) throw new Error('Source test case not found');
  const recordedFlow = getRecordedFlowForRun(runId);
  if (!recordedFlow.length) throw new Error('No successful tool calls found in this run');
  const content = {
    ...source.content,
    title: `${source.title} - 固定流程`,
    description: `由运行 ${runId} 的成功操作录制生成。`,
    userRequirement: `按运行 ${runId} 录制下来的固定浏览器流程执行，并验证最终结果。`,
    steps: recordedFlow.map((flow, index) => ({
      index: index + 1,
      operation: flow.name.includes('click') ? 'click' as const : flow.name.includes('type') ? 'fill' as const : 'wait' as const,
      action: `执行录制工具 ${flow.name}`,
      input: flow.input ? JSON.stringify(flow.input) : undefined,
      expected: flow.reason || '录制工具应成功执行。',
      riskLevel: 'safe' as const,
    })),
    expectedResults: ['录制的固定流程可以稳定回放。', ...(source.content.expectedResults || [])],
    risks: ['如果页面结构变化，固定候选编号可能失效，可改用重放失败后的 AI 修复建议更新流程。', ...(source.content.risks || [])],
    recordedFlow,
  };
  return store.createTestCase(content, source.imageNames || [], source.groupId);
}

export function startScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const tick = () => {
    try {
      store.applyRuntimeEnv();
      const due = store.listSchedules().filter((schedule) =>
        schedule.enabled &&
        schedule.testCaseIds.length &&
        new Date(schedule.nextRunAt).getTime() <= Date.now()
      );
      for (const schedule of due) {
        startBatchRun(schedule.testCaseIds, 'schedule');
        store.markScheduleTriggered(schedule.id);
      }
    } finally {
      setTimeout(tick, 30_000).unref?.();
    }
  };
  setTimeout(tick, 2_000).unref?.();
}

function persistBackgroundRunFailure(run: TestRunRecord, testCase: ReturnType<typeof store.getTestCase>, error: unknown) {
  if (!testCase) return;
  try {
    const current = store.getRun(run.id);
    if (!current) return;
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
    if (failed && testCase) {
      void writeAiReport(testCase, failed).then(async (report) => {
        const analysis = await analyzeRunOutcome({ ...failed, report });
        store.updateRun(run.id, { report, analysis });
        store.appendTestCaseStrategyMemory(run.testCaseId, analysis.promptHints);
      });
    }
    store.updateTestCaseStatus(run.testCaseId, 'blocked');
  } catch (persistError) {
    console.error('Failed to persist background run failure', persistError);
  }
}
