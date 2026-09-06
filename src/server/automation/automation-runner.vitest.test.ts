import { beforeEach, expect, test, vi } from 'vitest';
import type { AutomationCaseRecord, AutomationRunRecord, UpdateAutomationRunInput } from './automation.schema';

const fixture = vi.hoisted(() => ({
  task: {} as AutomationCaseRecord,
  run: {} as AutomationRunRecord,
  execute: vi.fn(), replay: vi.fn(), close: vi.fn(), start: vi.fn(), release: vi.fn(),
}));

vi.mock('@/server/ai/agents/browser-chat-executor.agent', () => ({
  executeInteractiveBrowserTurn: fixture.execute, executeRecordedBrowserOperation: fixture.replay,
}));
vi.mock('@/server/capabilities/webpilot-browser', () => ({
  createWebPilotBrowserSession: () => ({ start: fixture.start, close: fixture.close }),
}));
vi.mock('@/server/credentials/login-account-vault', () => ({
  listLoginAccounts: async () => [], resolveLoginAccountCredentialById: vi.fn(),
}));
vi.mock('@/server/db/store', () => ({ store: { getSkill: vi.fn() } }));
vi.mock('@/server/storage/runtime-knowledge-store', () => ({
  readRuntimeKnowledgeRevisions: vi.fn(), readRuntimeSkillCatalog: vi.fn(),
}));
vi.mock('@/server/ai/agents/runtime-knowledge-context', () => ({
  createRuntimeKnowledgeResolver: () => ({ readSkill: vi.fn(), refresh: async () => [], markSelected: async () => undefined }),
}));
vi.mock('@/server/storage/automation-store', () => ({
  getAutomationCase: async () => fixture.task,
  getAutomationRun: async () => fixture.run,
  createAutomationRun: vi.fn(),
  claimAutomationRunLease: async (_id: string, owner: string) => {
    fixture.run = { ...fixture.run, lease: { owner, acquiredAt: 'now', heartbeatAt: 'now', expiresAt: 'later' } };
    return fixture.run;
  },
  releaseAutomationRunLease: fixture.release,
  updateAutomationRunIfStatus: async (_id: string, statuses: string[], patch: UpdateAutomationRunInput, _userId: string, owner?: string) => {
    if (!statuses.includes(fixture.run.status) || (owner && owner !== fixture.run.lease?.owner)) return { updated: false, run: fixture.run };
    const { appendLog, ...values } = patch;
    fixture.run = { ...fixture.run, ...values, steps: [...(patch.steps || fixture.run.steps)], log: [...fixture.run.log, ...(appendLog || [])] } as AutomationRunRecord;
    if (patch.error === null) delete fixture.run.error;
    if (patch.finishedAt === null) delete fixture.run.finishedAt;
    return { updated: true, run: fixture.run };
  },
}));

import { cancelAutomationRun, executeAutomationRun } from './automation-runner';
import { automationRunRecordSchema } from './automation.schema';

beforeEach(() => {
  vi.clearAllMocks();
  fixture.close.mockResolvedValue(undefined);
  fixture.start.mockResolvedValue(undefined);
  fixture.task = {
    id: 'task-1', userId: 'user-1', title: '订单巡检', sourceSessionId: 'manual', sourceMessageIds: [],
    targetUrl: 'https://example.com', instruction: '检查新增订单', completionCriteria: '每条异常都有订单号',
    outputRequirements: '输出异常表格和文件链接', createdAt: 'now', updatedAt: 'now',
    operations: [{ index: 1, name: 'browser', input: { code: 'old_submit_order()' }, sourceStepAction: '检查订单状态' }],
  };
  fixture.run = { id: 'run-1', userId: 'user-1', caseId: 'task-1', trigger: 'schedule', status: 'queued', steps: [], log: [], createdAt: 'now', updatedAt: 'now' };
});

test('a scheduled legacy task runs one continuous agent and retains its full output and live steps', async () => {
  const output = '## 巡检结果\n\n| 订单 | 异常 |\n| --- | --- |\n| 123 | 未付款 |\n\n[下载文件](/api/artifacts/report.xlsx)';
  fixture.execute.mockImplementation(async (input) => {
    expect(input.userId).toBe('user-1');
    expect(input.allowedToolTypes).toBeUndefined();
    expect(input.instruction).toContain('检查订单状态');
    expect(input.instruction).toContain('每条异常都有订单号');
    expect(input.instruction).not.toContain('old_submit_order()');
    await input.onProgress({ index: 1, action: '读取订单', expected: '获得订单', actual: '读取中', status: 'running' });
    expect(fixture.run.steps[0].status).toBe('running');
    await input.onProgress({ index: 1, action: '读取订单', expected: '获得订单', actual: '发现 1 条异常', status: 'passed' });
    return { status: 'passed', reply: output, blocks: [{ type: 'markdown', text: output }] };
  });
  const run = await executeAutomationRun('run-1');
  expect(fixture.execute).toHaveBeenCalledTimes(1);
  expect(fixture.replay).not.toHaveBeenCalled();
  expect(run.steps).toHaveLength(1);
  expect(run.steps[0].status).toBe('passed');
  expect(run.output).toBe(output);
  expect(run.outputBlocks).toEqual([{ type: 'markdown', text: output }]);
  expect(automationRunRecordSchema.safeParse(run).success).toBe(true);
  expect(fixture.release).toHaveBeenCalled();
});

test('an unmet condition remains blocked without a second verification or repair agent', async () => {
  fixture.execute.mockResolvedValue({ status: 'blocked', reply: '需要登录验证码', blocks: [{ type: 'markdown', text: '需要登录验证码' }] });
  const run = await executeAutomationRun('run-1');
  expect(run.status).toBe('blocked');
  expect(run.output).toBe('需要登录验证码');
  expect(fixture.execute).toHaveBeenCalledTimes(1);
});

test('cancelling a running task interrupts the agent and cannot be overwritten by completion', async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  fixture.execute.mockImplementation((input) => new Promise((_resolve, reject) => {
    input.abortSignal.addEventListener('abort', () => reject(input.abortSignal.reason), { once: true });
    started();
  }));
  const execution = executeAutomationRun('run-1');
  await ready;
  await cancelAutomationRun('run-1', 'user-1');
  const run = await execution;
  expect(run.status).toBe('cancelled');
  expect(fixture.close).toHaveBeenCalled();
  expect(fixture.release).toHaveBeenCalled();
});
