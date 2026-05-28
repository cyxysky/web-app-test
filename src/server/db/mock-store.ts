import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TestCaseContent, TestCaseRecord, TestRunRecord } from '@/server/ai/schemas/test-case.schema';

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
      selectorHint: 'email/password/login button',
      input: 'wrong-password',
      expected: 'The page shows an error and does not enter the app',
      riskLevel: 'safe',
    },
    {
      index: 3,
      operation: 'fill',
      action: 'Submit the configured test account',
      selectorHint: 'email/password/login button',
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
  writeFileSync(storePath, JSON.stringify(data, null, 2), 'utf8');
}

function readData(): StoreData {
  if (!existsSync(storePath)) {
    const seed: StoreData = { testCases: [seedRecord], runs: [] };
    writeData(seed);
    return seed;
  }

  return JSON.parse(readFileSync(storePath, 'utf8')) as StoreData;
}

export const store = {
  listTestCases() {
    return readData().testCases.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
  getTestCase(testCaseId: string) {
    return readData().testCases.find((item) => item.id === testCaseId);
  },
  createTestCase(content: TestCaseContent, imageNames: string[]) {
    const data = readData();
    const record: TestCaseRecord = {
      id: id('tc'),
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
  getRun(runId: string) {
    return readData().runs.find((item) => item.id === runId);
  },
};
