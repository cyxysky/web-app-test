import { randomUUID } from 'node:crypto';
import { executeInteractiveBrowserTurn } from '@/server/ai/agents/browser-chat-executor.agent';
import type { StepExecutionResult } from '@/server/ai/schemas/runtime.schema';
import { store } from '@/server/db/store';
import { createRuntimeKnowledgeResolver } from '@/server/ai/agents/runtime-knowledge-context';
import { readRuntimeKnowledgeRevisions, readRuntimeSkillCatalog } from '@/server/storage/runtime-knowledge-store';
import { automationTaskInstruction } from './automation-task';
import type { BrowserSession } from '@webpilot/capability-browser/node';
import type { BrowserCodeCredentialBinding } from '@webpilot/capability-browser/node';
import { createWebPilotBrowserSession } from '@/server/capabilities/webpilot-browser';
import {
  listLoginAccounts,
  resolveLoginAccountCredentialById,
  type LoginAccountMetadata,
} from '@/server/credentials/login-account-vault';
import {
  claimAutomationRunLease,
  createAutomationRun,
  getAutomationCase,
  getAutomationRun,
  releaseAutomationRunLease,
  updateAutomationRunIfStatus,
} from '@/server/storage/automation-store';
import type {
  AutomationCaseRecord,
  AutomationRunLogEntry,
  AutomationRunRecord,
  AutomationRunStepRecord,
  AutomationRunTrigger,
  UpdateAutomationRunInput,
} from './automation.schema';

export type EnqueueAutomationCaseRunInput = {
  caseId: string;
  userId: string | number;
  scheduleId?: string;
  occurrenceKey?: string;
  trigger?: AutomationRunTrigger;
};

export type ExecuteAutomationRunOptions = {
  userId?: string | number;
  leaseOwner?: string;
  leaseTtlMs?: number;
  abortSignal?: AbortSignal;
};

type ActiveRunExecution = {
  controller: AbortController;
  promise: Promise<AutomationRunRecord>;
  detachAbortSignals: Set<() => void>;
};

const activeRunExecutions = new Map<string, ActiveRunExecution>();

class AutomationRunCancelledError extends Error {
  constructor(message = 'Automation run was cancelled.') {
    super(message);
    this.name = 'AutomationRunCancelledError';
  }
}

class AutomationRunLeaseLostError extends Error {
  constructor(message = 'Automation run lease was lost to another worker.') {
    super(message);
    this.name = 'AutomationRunLeaseLostError';
  }
}

type AutomationCredentialContext = {
  bindings: BrowserCodeCredentialBinding[];
  operationalContext: string;
};

function now() {
  return new Date().toISOString();
}

function userId(value: string | number | undefined) {
  return String(value ?? '').trim() || '1';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function abortActiveRun(runId: string, reason = new AutomationRunCancelledError()) {
  const active = activeRunExecutions.get(runId);
  if (!active || active.controller.signal.aborted) return;
  active.controller.abort(reason);
}

function forwardAbortSignal(signal: AbortSignal | undefined, controller: AbortController) {
  if (!signal) return () => undefined;
  const onAbort = () => {
    const reason = signal.reason instanceof Error
      ? signal.reason
      : new AutomationRunCancelledError();
    if (!controller.signal.aborted) controller.abort(reason);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

function httpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function instructionMentionsAccount(instruction: string, account: LoginAccountMetadata) {
  const normalized = instruction.toLowerCase();
  return normalized.includes(account.username.toLowerCase())
    || normalized.includes(account.domain.toLowerCase())
    || Boolean(account.loginUrl && normalized.includes(account.loginUrl.toLowerCase()));
}

async function credentialContextForCase(automationCase: AutomationCaseRecord): Promise<AutomationCredentialContext> {
  const target = httpUrl(automationCase.targetUrl);
  const activeAccounts = (await listLoginAccounts({ userId: automationCase.userId }))
    .filter((account) => account.status === 'active' && account.hasPassword);
  const domainAccounts = target
    ? activeAccounts.filter((account) => account.domain === target.hostname.toLowerCase())
    : [];
  const mentionedAccounts = activeAccounts.filter((account) => instructionMentionsAccount(automationCase.instruction, account));
  const account = mentionedAccounts.length === 1
    ? mentionedAccounts[0]
    : domainAccounts.length === 1
      ? domainAccounts[0]
      : activeAccounts.length === 1
        ? activeAccounts[0]
        : undefined;
  if (!account) return { bindings: [], operationalContext: '' };

  const resolved = await resolveLoginAccountCredentialById(account.id, automationCase.userId);
  if (!resolved) return { bindings: [], operationalContext: '' };
  const allowedOrigins: string[] = [];

  const token = randomUUID();
  const usernameRef = `credential_${token}_username`;
  const passwordRef = `credential_${token}_password`;
  const bindings: BrowserCodeCredentialBinding[] = [
    { ref: usernameRef, value: account.username, allowedOrigins },
    { ref: passwordRef, value: resolved.password, allowedOrigins },
  ];
  return {
    bindings,
    operationalContext: [
      '[后台已匹配的安全账号引用]',
      `- 默认站点 ${account.domain} / ${account.username} / 任意 HTTP(S) 页面可用`,
      `  用户名：await credentialVault.fill(page.getByLabel('用户名'), "${usernameRef}")`,
      `  密码：await credentialVault.fill(page.getByLabel('密码'), "${passwordRef}")`,
      'credentialVault.fill 只会将凭据写入当前浏览器会话中的真实 Playwright Locator；默认站点不限制使用域名。不得读取、输出或记录凭据明文；验证码、OTP、扫码或二次认证必须报告 blocked。',
    ].join('\n'),
  };
}

function logEntry(level: 'debug' | 'info' | 'warn' | 'error', message: string, details?: unknown): AutomationRunLogEntry {
  return { time: now(), level, message, ...(details === undefined ? {} : { details }) };
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Automation run was cancelled.');
}

async function throwIfRunCannotContinue(
  runId: string,
  runUserId: string,
  leaseOwner: string,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  const persistedRun = await getAutomationRun(runId, runUserId);
  if (persistedRun?.status === 'cancelled') {
    throw new AutomationRunCancelledError();
  }
  if (persistedRun?.status !== 'running' || persistedRun.lease?.owner !== leaseOwner) {
    throw new AutomationRunLeaseLostError();
  }
}

async function persistRunProgress(
  run: AutomationRunRecord,
  steps: AutomationRunStepRecord[],
  leaseOwner: string,
  entry?: AutomationRunLogEntry,
) {
  const transition = await updateAutomationRunIfStatus(run.id, ['running'], {
    steps,
    ...(entry ? { appendLog: [entry] } : {}),
  }, run.userId, leaseOwner);
  if (!transition) throw new Error('Automation run disappeared while persisting progress.');
  if (!transition.updated) {
    if (transition.run.status === 'cancelled') {
      throw new AutomationRunCancelledError();
    }
    throw new AutomationRunLeaseLostError(
      `Automation run lease was lost before progress could be saved (${transition.run.status}).`,
    );
  }
  return transition.run;
}

function agentStepRecord(step: StepExecutionResult, previous?: AutomationRunStepRecord): AutomationRunStepRecord {
  const running = step.status === 'running' || step.status === 'queued';
  return {
    operationIndex: step.index,
    name: step.action || 'AI 执行',
    status: step.status === 'queued' ? 'running' : step.status,
    actual: step.actual,
    tools: step.tools,
    screenshotPath: step.afterScreenshotPath || step.screenshotPath || step.visualContext?.current?.path,
    startedAt: previous?.startedAt || now(),
    finishedAt: running ? undefined : now(),
    ...(step.status === 'failed' || step.status === 'blocked' ? { error: step.actual } : {}),
  };
}

async function executeAutomationRunNow(runId: string, options: ExecuteAutomationRunOptions): Promise<AutomationRunRecord> {
  const requestedUserId = options.userId === undefined ? undefined : userId(options.userId);
  const initialRun = await getAutomationRun(runId, requestedUserId);
  if (!initialRun) throw new Error('Automation run not found.');
  const automationCase = await getAutomationCase(initialRun.caseId, initialRun.userId);
  if (!automationCase) throw new Error('Automation case not found.');

  const owner = options.leaseOwner?.trim() || `automation-runner:${process.pid}:${randomUUID()}`;
  const leaseTtlMs = Math.max(60_000, Math.floor(options.leaseTtlMs || 60 * 60_000));
  const claimedRun = await claimAutomationRunLease(initialRun.id, owner, leaseTtlMs, initialRun.userId);
  if (!claimedRun) throw new Error('Automation run is already claimed by another runner.');

  const stepRecords: AutomationRunStepRecord[] = [];
  let browser: BrowserSession | undefined;
  let run = claimedRun;
  const heartbeatIntervalMs = Math.max(5_000, Math.min(30_000, Math.floor(leaseTtlMs / 3)));
  const leaseHeartbeat = setInterval(async () => {
    try {
      const renewedRun = await claimAutomationRunLease(run.id, owner, leaseTtlMs, run.userId);
      if (!renewedRun || renewedRun.lease?.owner !== owner) {
        const persistedRun = await getAutomationRun(run.id, run.userId);
        abortActiveRun(
          run.id,
          persistedRun?.status === 'cancelled'
            ? new AutomationRunCancelledError()
            : new AutomationRunLeaseLostError('Automation run lease renewal was rejected.'),
        );
      }
    } catch (error) {
      abortActiveRun(
        run.id,
        new AutomationRunLeaseLostError(`Automation run lease renewal failed: ${errorMessage(error)}`),
      );
    }
  }, heartbeatIntervalMs);
  leaseHeartbeat.unref?.();

  const durableStatePoll = setInterval(async () => {
    try {
      const persistedRun = await getAutomationRun(run.id, run.userId);
      if (persistedRun?.status === 'cancelled') {
        abortActiveRun(run.id);
      } else if (
        !persistedRun
        || !['queued', 'running'].includes(persistedRun.status)
        || persistedRun.lease?.owner !== owner
      ) {
        abortActiveRun(run.id, new AutomationRunLeaseLostError());
      }
    } catch (error) {
      abortActiveRun(
        run.id,
        new AutomationRunLeaseLostError(`Automation run state polling failed: ${errorMessage(error)}`),
      );
    }
  }, 1_000);
  durableStatePoll.unref?.();

  try {
    const runningPatch: UpdateAutomationRunInput = {
      status: 'running',
      steps: [],
      error: null,
      output: '',
      outputBlocks: [],
      startedAt: now(),
      finishedAt: null,
      appendLog: [logEntry('info', 'AI automation task started.')],
    };
    const runningTransition = await updateAutomationRunIfStatus(
      claimedRun.id,
      ['queued', 'running'],
      runningPatch,
      claimedRun.userId,
      owner,
    );
    if (!runningTransition) throw new Error('Automation run disappeared before execution started.');
    run = runningTransition.run;
    if (!runningTransition.updated) {
      if (run.status === 'cancelled') throw new AutomationRunCancelledError();
      return run;
    }
    const credentialContext = await credentialContextForCase(automationCase);
    await throwIfRunCannotContinue(run.id, run.userId, owner, options.abortSignal);
    const browserProfileKey = `user_${automationCase.userId}`;
    browser = createWebPilotBrowserSession({
      browserSurface: 'external',
      headless: true,
      browserProfileKey,
      sharedBrowserRuntimeKey: browserProfileKey,
      isMarked: true,
      preferExistingPage: false,
      runId: run.id,
    });
    const taskInstruction = automationTaskInstruction(automationCase);
    const knowledge = createRuntimeKnowledgeResolver({
      scopeId: run.id,
      query: taskInstruction,
      selectedSkillIds: [],
      getState: () => undefined,
      saveState: () => undefined,
      revisions: (domain) => readRuntimeKnowledgeRevisions(run.userId, domain),
      listSkills: () => readRuntimeSkillCatalog(run.userId),
      getSkill: (id) => store.getSkill(id, run.userId),
      searchMemory: async () => [],
      formatMemory: () => '',
    });
    const activeBrowser = browser;
    let browserStart: Promise<unknown> | undefined;
    let progressQueue = Promise.resolve();
    const result = await executeInteractiveBrowserTurn({
      session: activeBrowser,
      runId: run.id,
      userId: run.userId,
      targetUrl: automationCase.targetUrl,
      instruction: taskInstruction,
      safetyMode: 'full',
      abortSignal: options.abortSignal,
      shouldContinue: () => !options.abortSignal?.aborted,
      credentialBindings: credentialContext.bindings,
      ensureBrowserStarted: async () => { await (browserStart ??= activeBrowser.start()); },
      readSkill: knowledge.readSkill,
      getRuntimeOperationalContext: async () => ({
        operationalContext: credentialContext.operationalContext,
        credentialBindings: credentialContext.bindings,
        knowledge: await knowledge.refresh(httpUrl(automationCase.targetUrl)?.hostname || ''),
        onKnowledgeSelected: knowledge.markSelected,
      }),
      onProgress: (step) => {
        progressQueue = progressQueue.then(async () => {
          await throwIfRunCannotContinue(run.id, run.userId, owner, options.abortSignal);
          const index = stepRecords.findIndex((record) => record.operationIndex === step.index);
          const record = agentStepRecord(step, index < 0 ? undefined : stepRecords[index]);
          if (index < 0) stepRecords.push(record);
          else stepRecords[index] = record;
          run = await persistRunProgress(run, stepRecords, owner);
        });
        return progressQueue;
      },
    });
    await progressQueue;
    await throwIfRunCannotContinue(run.id, run.userId, owner, options.abortSignal);
    const completedPatch: UpdateAutomationRunInput = {
      status: result.status,
      steps: stepRecords,
      output: result.reply,
      outputBlocks: result.blocks,
      error: result.status === 'passed' ? null : result.reply || 'AI task did not complete.',
      finishedAt: now(),
      appendLog: [logEntry(result.status === 'passed' ? 'info' : 'warn', `AI task finished with ${result.status}.`)],
    };
    const completion = await updateAutomationRunIfStatus(
      run.id,
      ['running'],
      completedPatch,
      run.userId,
      owner,
    );
    if (!completion) throw new Error('Automation run disappeared while saving the task result.');
    run = completion.run;
    if (!completion.updated && run.status === 'cancelled') {
      throw new AutomationRunCancelledError();
    }
    return run;
  } catch (error) {
    const persistedRun = await getAutomationRun(run.id, run.userId);
    const leaseLost = Boolean(
      error instanceof AutomationRunLeaseLostError
      || options.abortSignal?.reason instanceof AutomationRunLeaseLostError,
    );
    if (leaseLost) {
      if (persistedRun) run = persistedRun;
      return run;
    }
    const cancelled = Boolean(
      options.abortSignal?.aborted
      || error instanceof AutomationRunCancelledError
      || persistedRun?.status === 'cancelled',
    );
    if (persistedRun?.status === 'cancelled') {
      run = persistedRun;
      return run;
    }
    const failureTransition = await updateAutomationRunIfStatus(run.id, ['queued', 'running'], {
      status: cancelled ? 'cancelled' : 'failed',
      steps: stepRecords,
      error: errorMessage(error),
      finishedAt: now(),
      appendLog: [logEntry(cancelled ? 'warn' : 'error', cancelled ? 'Automation run was cancelled.' : 'Automation run failed.', errorMessage(error))],
    }, run.userId, owner);
    if (failureTransition) run = failureTransition.run;
    return run;
  } finally {
    clearInterval(leaseHeartbeat);
    clearInterval(durableStatePoll);
    await browser?.close().catch(() => undefined);
    await releaseAutomationRunLease(run.id, owner, run.userId);
  }
}

/** Create a durable queued run and start its in-process worker immediately. */
export async function enqueueAutomationCaseRun(input: EnqueueAutomationCaseRunInput): Promise<AutomationRunRecord> {
  const normalizedUserId = userId(input.userId);
  const automationCase = await getAutomationCase(input.caseId, normalizedUserId);
  if (!automationCase) throw new Error('Automation case not found.');
  const run = await createAutomationRun({
    userId: automationCase.userId,
    caseId: automationCase.id,
    scheduleId: input.scheduleId,
    occurrenceKey: input.occurrenceKey,
    trigger: input.trigger || (input.scheduleId ? 'schedule' : 'manual'),
    status: 'queued',
    steps: [],
    log: [logEntry('info', 'Automation run queued.')],
  });
  void executeAutomationRun(run.id, { userId: run.userId }).catch(() => undefined);
  return run;
}

export type CancelAutomationRunResult = {
  run: AutomationRunRecord;
  accepted: boolean;
  changed: boolean;
};

/** Persist cancellation first, then interrupt an in-process worker if this process owns it. */
export async function cancelAutomationRun(
  runId: string,
  requestedUserId: string | number,
): Promise<CancelAutomationRunResult | undefined> {
  const normalizedUserId = userId(requestedUserId);
  const transition = await updateAutomationRunIfStatus(runId, ['queued', 'running'], {
    status: 'cancelled',
    error: 'Cancelled by the user.',
    finishedAt: now(),
    appendLog: [logEntry(
      'warn',
      'Cancellation requested. Any active browser execution is stopping.',
    )],
  }, normalizedUserId);
  if (!transition) return undefined;
  const accepted = transition.updated || transition.run.status === 'cancelled';
  if (accepted) {
    abortActiveRun(runId);
  }
  return {
    run: transition.run,
    accepted,
    changed: transition.updated,
  };
}

/** Execute one queued run at most once per process and under a durable lease. */
export function executeAutomationRun(runId: string, options: ExecuteAutomationRunOptions = {}) {
  const existing = activeRunExecutions.get(runId);
  if (existing) {
    existing.detachAbortSignals.add(forwardAbortSignal(options.abortSignal, existing.controller));
    return existing.promise;
  }

  const controller = new AbortController();
  const detachAbortSignals = new Set<() => void>();
  detachAbortSignals.add(forwardAbortSignal(options.abortSignal, controller));
  const execution = executeAutomationRunNow(runId, {
    ...options,
    abortSignal: controller.signal,
  }).finally(() => {
    const active = activeRunExecutions.get(runId);
    if (active?.promise !== execution) return;
    for (const detach of active.detachAbortSignals) detach();
    activeRunExecutions.delete(runId);
  });
  activeRunExecutions.set(runId, { controller, promise: execution, detachAbortSignals });
  return execution;
}
