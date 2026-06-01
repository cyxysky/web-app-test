import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RunDebugEvent, StepExecutionResult, TestCaseContent, TestCaseRecord, TestGroupRecord, TestRunRecord } from '@/server/ai/schemas/test-case.schema';

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
const storePath = path.join(process.cwd(), '.data', 'store.json');

const seedContent: TestCaseContent = {
  title: 'Login smoke test',
  description: 'Verify the login page loads, rejects an invalid password, and supports a successful test login.',
  targetUrl: 'https://example.com',
  priority: 'high',
  preconditions: ['The test environment is reachable', 'A test account is available', 'The target domain is allowlisted'],
  testData: {
    username: 'demo@example.com',
    password: '******',
  },
  steps: [
    {
      index: 1,
      operation: 'wait',
      action: 'Open the login page and verify it finishes loading',
      expected: 'The page shows login-related content',
      riskLevel: 'safe',
    },
    {
      index: 2,
      operation: 'fill',
      action: 'Submit an invalid password',
      input: 'wrong-password',
      expected: 'The page shows an error and does not enter the app',
      riskLevel: 'safe',
    },
    {
      index: 3,
      operation: 'fill',
      action: 'Submit the configured test account',
      input: 'configured test credential',
      expected: 'Login succeeds and navigates to the dashboard or home page',
      riskLevel: 'warning',
    },
  ],
  expectedResults: ['The login page is reachable', 'Invalid credentials show a clear error', 'Valid test credentials enter the app'],
  risks: ['Use an isolated test account only. Do not connect production accounts.'],
};

type StoreData = {
  testCases: TestCaseRecord[];
  runs: TestRunRecord[];
  groups?: TestGroupRecord[];
};

const seedRecord: TestCaseRecord = {
  id: 'tc_demo_login',
  title: seedContent.title,
  description: seedContent.description,
  targetUrl: seedContent.targetUrl,
  status: 'ready',
  priority: seedContent.priority,
  content: seedContent,
  imageNames: [],
  createdAt: now(),
  updatedAt: now(),
};

function writeData(data: StoreData) {
  mkdirSync(path.dirname(storePath), { recursive: true });
  const tempPath = `${storePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');

  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      renameSync(tempPath, storePath);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(code || '')) {
        rmSync(tempPath, { force: true });
        throw error;
      }
      sleepSync(25 * (attempt + 1));
    }
  }

  try {
    copyFileSync(tempPath, storePath);
  } finally {
    rmSync(tempPath, { force: true });
  }
  if (!existsSync(storePath) && lastError) throw lastError;
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readData(): StoreData {
  if (!existsSync(storePath)) {
    const seed: StoreData = { testCases: [seedRecord], runs: [], groups: [] };
    writeData(seed);
    return seed;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const data = JSON.parse(readFileSync(storePath, 'utf8')) as StoreData;
      return { ...data, groups: data.groups || [] };
    } catch (error) {
      lastError = error;
      sleepSync(25);
    }
  }
  throw lastError;
}

export const store = {
  listTestCases() {
    return readData().testCases.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
  listGroups() {
    return readData().groups || [];
  },
  createGroup(name: string, parentId?: string) {
    const data = readData();
    const group: TestGroupRecord = {
      id: id('grp'),
      parentId,
      name,
      createdAt: now(),
      updatedAt: now(),
    };
    data.groups = [...(data.groups || []), group];
    writeData(data);
    return group;
  },
  updateGroup(groupId: string, patch: Partial<Pick<TestGroupRecord, 'name' | 'parentId'>>) {
    const data = readData();
    let updated: TestGroupRecord | undefined;
    data.groups = (data.groups || []).map((group) => {
      if (group.id !== groupId) return group;
      updated = { ...group, ...patch, updatedAt: now() };
      return updated;
    });
    writeData(data);
    return updated;
  },
  getTestCase(testCaseId: string) {
    return readData().testCases.find((item) => item.id === testCaseId);
  },
  listRunsForTestCase(testCaseId: string) {
    return readData().runs
      .filter((item) => item.testCaseId === testCaseId)
      .sort((a, b) => (b.startedAt || b.createdAt).localeCompare(a.startedAt || a.createdAt));
  },
  createTestCase(content: TestCaseContent, imageNames: string[], groupId?: string) {
    const data = readData();
    const record: TestCaseRecord = {
      id: id('tc'),
      groupId,
      title: content.title,
      description: content.description,
      targetUrl: content.targetUrl,
      status: 'ready',
      priority: content.priority,
      content,
      imageNames,
      createdAt: now(),
      updatedAt: now(),
    };
    data.testCases.push(record);
    writeData(data);
    return record;
  },
  updateTestCaseStatus(testCaseId: string, status: TestCaseRecord['status']) {
    const data = readData();
    data.testCases = data.testCases.map((record) =>
      record.id === testCaseId ? { ...record, status, updatedAt: now() } : record,
    );
    writeData(data);
  },
  moveTestCase(testCaseId: string, groupId?: string) {
    const data = readData();
    let updated: TestCaseRecord | undefined;
    data.testCases = data.testCases.map((record) => {
      if (record.id !== testCaseId) return record;
      updated = { ...record, groupId, updatedAt: now() };
      return updated;
    });
    writeData(data);
    return updated;
  },
  updateTestCase(testCaseId: string, content: TestCaseContent, imageNames?: string[]) {
    const data = readData();
    let updated: TestCaseRecord | undefined;
    data.testCases = data.testCases.map((record) => {
      if (record.id !== testCaseId) return record;
      updated = {
        ...record,
        title: content.title,
        description: content.description,
        targetUrl: content.targetUrl,
        priority: content.priority,
        content,
        imageNames: imageNames ?? record.imageNames,
        updatedAt: now(),
      };
      return updated;
    });
    writeData(data);
    return updated;
  },
  createRun(testCaseId: string) {
    const data = readData();
    const run: TestRunRecord = {
      id: id('run'),
      testCaseId,
      status: 'queued',
      createdAt: now(),
    };
    data.runs.push(run);
    writeData(data);
    return run;
  },
  updateRun(runId: string, patch: Partial<TestRunRecord>) {
    const data = readData();
    const run = data.runs.find((item) => item.id === runId);
    if (!run) return undefined;
    const updated = { ...run, ...patch };
    data.runs = data.runs.map((item) => (item.id === runId ? updated : item));
    writeData(data);
    return updated;
  },
  updateRunStep(runId: string, step: StepExecutionResult) {
    const data = readData();
    const run = data.runs.find((item) => item.id === runId);
    if (!run) return undefined;

    const result = run.result || { steps: [], consoleErrors: [], networkErrors: [] };
    const exists = result.steps.some((item) => item.index === step.index);
    const steps = exists
      ? result.steps.map((item) => (item.index === step.index ? { ...item, ...step } : item))
      : [...result.steps, step].sort((a, b) => a.index - b.index);

    const updated = { ...run, result: { ...result, steps } };
    data.runs = data.runs.map((item) => (item.id === runId ? updated : item));
    writeData(data);
    return updated;
  },
  appendRunDebug(runId: string, event: Omit<RunDebugEvent, 'time'>) {
    const data = readData();
    const run = data.runs.find((item) => item.id === runId);
    if (!run) return undefined;
    const debug = run.debug || { enabled: false, phase: '', events: [] };
    const updatedDebug = {
      ...debug,
      phase: event.phase,
      stepIndex: event.stepIndex,
      events: [...debug.events, { ...event, time: now() }].slice(-200),
    };
    const updated = { ...run, debug: updatedDebug };
    data.runs = data.runs.map((item) => (item.id === runId ? updated : item));
    writeData(data);
    return updated;
  },
  requestRunSkip(runId: string, stepIndex?: number) {
    const data = readData();
    const run = data.runs.find((item) => item.id === runId);
    if (!run) return undefined;
    const updated = {
      ...run,
      control: {
        ...run.control,
        skipRequestedAt: now(),
        skipStepIndex: stepIndex,
      },
    };
    data.runs = data.runs.map((item) => (item.id === runId ? updated : item));
    writeData(data);
    return updated;
  },
  requestRunPause(runId: string, stepIndex?: number) {
    const data = readData();
    const run = data.runs.find((item) => item.id === runId);
    if (!run) return undefined;
    const pausedAt = now();
    const updated = {
      ...run,
      status: 'paused' as const,
      control: {
        ...run.control,
        pauseRequestedAt: pausedAt,
        pauseStepIndex: stepIndex,
        pausedAt,
      },
    };
    data.runs = data.runs.map((item) => (item.id === runId ? updated : item));
    writeData(data);
    return updated;
  },
  requestRunResume(runId: string, stepIndex?: number) {
    const data = readData();
    const run = data.runs.find((item) => item.id === runId);
    if (!run) return undefined;
    const updated = {
      ...run,
      status: run.status === 'paused' ? ('running' as const) : run.status,
      control: {
        ...run.control,
        pauseRequestedAt: undefined,
        pauseStepIndex: undefined,
        pausedAt: undefined,
        resumeRequestedAt: now(),
        resumeStepIndex: stepIndex,
        manualIntervention: undefined,
      },
    };
    data.runs = data.runs.map((item) => (item.id === runId ? updated : item));
    writeData(data);
    return updated;
  },
  isRunPaused(runId: string) {
    const run = readData().runs.find((item) => item.id === runId);
    return Boolean(run?.control?.pausedAt);
  },
  setRunManualIntervention(runId: string, manualIntervention?: NonNullable<TestRunRecord['control']>['manualIntervention']) {
    const data = readData();
    const run = data.runs.find((item) => item.id === runId);
    if (!run) return undefined;
    const updated = {
      ...run,
      control: {
        ...run.control,
        manualIntervention,
      },
    };
    data.runs = data.runs.map((item) => (item.id === runId ? updated : item));
    writeData(data);
    return updated;
  },
  consumeRunSkip(runId: string, stepIndex: number) {
    const data = readData();
    const run = data.runs.find((item) => item.id === runId);
    const requested = run?.control?.skipRequestedAt && (!run.control.skipStepIndex || run.control.skipStepIndex === stepIndex);
    if (!run || !requested) return false;
    const updated = { ...run, control: { ...run.control, skipRequestedAt: undefined, skipStepIndex: undefined } };
    data.runs = data.runs.map((item) => (item.id === runId ? updated : item));
    writeData(data);
    return true;
  },
  consumeRunResume(runId: string, stepIndex: number) {
    const data = readData();
    const run = data.runs.find((item) => item.id === runId);
    const requested = run?.control?.resumeRequestedAt && (!run.control.resumeStepIndex || run.control.resumeStepIndex === stepIndex);
    if (!run || !requested) return false;
    const updated = {
      ...run,
      control: {
        ...run.control,
        resumeRequestedAt: undefined,
        resumeStepIndex: undefined,
        manualIntervention: undefined,
      },
    };
    data.runs = data.runs.map((item) => (item.id === runId ? updated : item));
    writeData(data);
    return true;
  },
  getRun(runId: string) {
    return readData().runs.find((item) => item.id === runId);
  },
};
