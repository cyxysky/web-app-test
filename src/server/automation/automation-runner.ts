import { randomUUID } from 'node:crypto';
import {
  executeInteractiveBrowserTurn,
  executeRecordedBrowserOperation,
} from '@/server/ai/agents/browser-chat-executor.agent';
import type { InteractiveBrowserTurnResult } from '@/server/ai/agents/browser-chat-executor.agent';
import { BrowserSession, type BrowserActionResult } from '@/server/browser/browser-session';
import type { BrowserCodeCredentialBinding } from '@/server/browser/browser-code-runner';
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
  AutomationOperationRecord,
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

function recordedCredentialRefs(automationCase: AutomationCaseRecord) {
  const refs = new Set<string>();
  for (const operation of automationCase.operations) {
    let serialized = '';
    try {
      serialized = typeof operation.input === 'string'
        ? operation.input
        : JSON.stringify(operation.input ?? {});
    } catch {
      serialized = '';
    }
    for (const match of serialized.matchAll(/credential_[A-Za-z0-9_-]+_(?:username|password)/g)) {
      refs.add(match[0]);
    }
  }
  return Array.from(refs);
}

function credentialContextForCase(automationCase: AutomationCaseRecord): AutomationCredentialContext {
  const target = httpUrl(automationCase.targetUrl);
  const activeAccounts = listLoginAccounts({ userId: automationCase.userId })
    .filter((account) => account.status === 'active' && account.hasPassword);
  const domainAccounts = target
    ? activeAccounts.filter((account) => account.domain === target.hostname.toLowerCase())
    : [];
  const mentionedAccounts = activeAccounts.filter((account) => instructionMentionsAccount(automationCase.instruction, account));
  const mentionedDomainAccounts = domainAccounts.filter((account) => instructionMentionsAccount(automationCase.instruction, account));
  const account = mentionedDomainAccounts.length === 1
    ? mentionedDomainAccounts[0]
    : domainAccounts.length === 1
      ? domainAccounts[0]
      : mentionedAccounts.length === 1
        ? mentionedAccounts[0]
        : undefined;
  if (!account) return { bindings: [], operationalContext: '' };

  const resolved = resolveLoginAccountCredentialById(account.id, automationCase.userId);
  if (!resolved) return { bindings: [], operationalContext: '' };
  const allowedOrigins = Array.from(new Set([
    target?.origin,
    httpUrl(account.loginUrl)?.origin,
  ].filter((origin): origin is string => Boolean(origin))));
  if (!allowedOrigins.length) return { bindings: [], operationalContext: '' };

  const token = randomUUID();
  const usernameRef = `credential_${token}_username`;
  const passwordRef = `credential_${token}_password`;
  const bindings: BrowserCodeCredentialBinding[] = [
    { ref: usernameRef, value: account.username, allowedOrigins },
    { ref: passwordRef, value: resolved.password, allowedOrigins },
  ];
  for (const ref of recordedCredentialRefs(automationCase)) {
    if (bindings.some((binding) => binding.ref === ref)) continue;
    if (/_username$/i.test(ref)) bindings.push({ ref, value: account.username, allowedOrigins });
    else if (/_password$/i.test(ref)) bindings.push({ ref, value: resolved.password, allowedOrigins });
  }
  return {
    bindings,
    operationalContext: [
      '[后台已匹配的安全账号引用]',
      `- ${allowedOrigins.join('、')} / ${account.username}`,
      `  用户名：await credentialVault.fill(page.getByLabel('用户名'), "${usernameRef}")`,
      `  密码：await credentialVault.fill(page.getByLabel('密码'), "${passwordRef}")`,
      'credentialVault.fill 只会将凭据写入上述 origin 的真实 Playwright Locator。不得读取、输出或记录凭据明文；验证码、OTP、扫码或二次认证必须报告 blocked。',
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

function throwIfRunCannotContinue(
  runId: string,
  runUserId: string,
  leaseOwner: string,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  const persistedRun = getAutomationRun(runId, runUserId);
  if (persistedRun?.status === 'cancelled') {
    throw new AutomationRunCancelledError();
  }
  if (persistedRun?.status !== 'running' || persistedRun.lease?.owner !== leaseOwner) {
    throw new AutomationRunLeaseLostError();
  }
}

async function captureAutomationStepEvidence(input: {
  browser: BrowserSession;
  runId: string;
  stepNumber: number;
  abortSignal?: AbortSignal;
}): Promise<Pick<AutomationRunStepRecord, 'screenshotPath' | 'screenshotCapturedAt' | 'screenshotError'>> {
  let screenshotError = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    throwIfAborted(input.abortSignal);
    try {
      const screenshotPath = await input.browser.takeCurrentScreenshotOnly(
        input.runId,
        input.stepNumber,
        `visual-${input.stepNumber}`,
        { capture: 'viewport' },
      );
      return { screenshotPath, screenshotCapturedAt: now() };
    } catch (error) {
      screenshotError = errorMessage(error);
      if (attempt === 0) await waitBeforeOperation(160, input.abortSignal);
    }
  }
  return {
    screenshotCapturedAt: now(),
    screenshotError: screenshotError || 'Unable to capture the completed step.',
  };
}

async function waitBeforeOperation(delayMs: unknown, signal?: AbortSignal) {
  const milliseconds = typeof delayMs === 'number' && Number.isFinite(delayMs)
    ? Math.max(0, Math.floor(delayMs))
    : 0;
  if (!milliseconds) return;
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Automation run was cancelled.'));
    };
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Automation run was cancelled.'));
    }
  });
}

function operationDiagnostic(operation: AutomationOperationRecord) {
  const result = typeof operation.recordedResult === 'string' ? operation.recordedResult.trim() : '';
  return result || `The recorded ${operation.name} tool was not a successful fixed action.`;
}

function operationRepairInstruction(
  automationCase: AutomationCaseRecord,
  operation: AutomationOperationRecord,
  fixedFailure: string,
) {
  const input = (() => {
    try {
      return JSON.stringify(operation.input ?? {}).slice(0, 6_000);
    } catch {
      return '[unserializable recorded input]';
    }
  })();
  return [
    '你正在修复一次无头自动化回放中的单个失败步骤。',
    `完整用例目标：${automationCase.instruction}`,
    `当前步骤：${operation.sourceStepAction || operation.reason || operation.name}`,
    `步骤预期：${operation.sourceStepExpected || '达到该录制工具原本要实现的页面状态'}`,
    `录制工具：${operation.name}`,
    `录制输入：${input}`,
    `固定回放失败证据：${fixedFailure}`,
    '请先读取当前页面事实，使用任意必要浏览器工具修复并达到本步骤预期。不要重启浏览器；完成、失败或阻塞后明确报告状态。',
  ].join('\n');
}

function finalVerificationInstruction(automationCase: AutomationCaseRecord, stepRecords: AutomationRunStepRecord[]) {
  const failedSteps = stepRecords
    .filter((step) => step.status === 'failed')
    .map((step) => `- ${step.name}: ${step.actual}`)
    .join('\n');
  return [
    '所有固定自动化步骤及其逐步修复均已执行完毕。现在必须进行最终验收，不可直接沿用历史结论。',
    `完整用例目标：${automationCase.instruction}`,
    `初始目标地址：${automationCase.targetUrl}`,
    failedSteps ? `此前仍有失败记录：\n${failedSteps}` : '此前没有未修复的固定步骤失败记录。',
    '请读取当前页面的最新事实，验证完整目标是否已经满足；如仍有缺口，立即使用浏览器工具补完。最后明确报告 passed、failed 或 blocked，并给出可追溯证据。',
  ].join('\n\n');
}

async function persistRunProgress(
  run: AutomationRunRecord,
  steps: AutomationRunStepRecord[],
  leaseOwner: string,
  entry?: AutomationRunLogEntry,
) {
  const transition = updateAutomationRunIfStatus(run.id, ['running'], {
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

async function runRepairAgent(input: {
  automationCase: AutomationCaseRecord;
  browser: BrowserSession;
  runId: string;
  instruction: string;
  initialStepIndex: number;
  credentialContext: AutomationCredentialContext;
  abortSignal?: AbortSignal;
}): Promise<InteractiveBrowserTurnResult> {
  throwIfAborted(input.abortSignal);
  return executeInteractiveBrowserTurn({
    session: input.browser,
    runId: input.runId,
    initialStepIndex: input.initialStepIndex,
    targetUrl: input.automationCase.targetUrl,
    instruction: input.instruction,
    operationalContext: input.credentialContext.operationalContext || undefined,
    mode: input.automationCase.mode,
    safetyMode: 'full',
    abortSignal: input.abortSignal,
    shouldContinue: () => !input.abortSignal?.aborted,
    credentialBindings: input.credentialContext.bindings,
    ensureBrowserStarted: async () => undefined,
  });
}

async function repairFailedOperation(input: {
  automationCase: AutomationCaseRecord;
  browser: BrowserSession;
  runId: string;
  operation: AutomationOperationRecord;
  fixedFailure: string;
  initialStepIndex: number;
  credentialContext: AutomationCredentialContext;
  abortSignal?: AbortSignal;
}) {
  try {
    const result = await runRepairAgent({
      automationCase: input.automationCase,
      browser: input.browser,
      runId: input.runId,
      instruction: operationRepairInstruction(input.automationCase, input.operation, input.fixedFailure),
      initialStepIndex: input.initialStepIndex,
      credentialContext: input.credentialContext,
      abortSignal: input.abortSignal,
    });
    return { result };
  } catch (error) {
    if (input.abortSignal?.aborted) throw error;
    return { error: errorMessage(error) };
  }
}

async function executeAutomationRunNow(runId: string, options: ExecuteAutomationRunOptions): Promise<AutomationRunRecord> {
  const requestedUserId = options.userId === undefined ? undefined : userId(options.userId);
  const initialRun = getAutomationRun(runId, requestedUserId);
  if (!initialRun) throw new Error('Automation run not found.');
  const automationCase = getAutomationCase(initialRun.caseId, initialRun.userId);
  if (!automationCase) throw new Error('Automation case not found.');

  const owner = options.leaseOwner?.trim() || `automation-runner:${process.pid}:${randomUUID()}`;
  const leaseTtlMs = Math.max(60_000, Math.floor(options.leaseTtlMs || 60 * 60_000));
  const claimedRun = claimAutomationRunLease(initialRun.id, owner, leaseTtlMs, initialRun.userId);
  if (!claimedRun) throw new Error('Automation run is already claimed by another runner.');

  const stepRecords: AutomationRunStepRecord[] = [];
  let browser: BrowserSession | undefined;
  let aiStepIndex = 0;
  let run = claimedRun;
  const heartbeatIntervalMs = Math.max(5_000, Math.min(30_000, Math.floor(leaseTtlMs / 3)));
  const leaseHeartbeat = setInterval(() => {
    try {
      const renewedRun = claimAutomationRunLease(run.id, owner, leaseTtlMs, run.userId);
      if (!renewedRun || renewedRun.lease?.owner !== owner) {
        const persistedRun = getAutomationRun(run.id, run.userId);
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

  const durableStatePoll = setInterval(() => {
    try {
      const persistedRun = getAutomationRun(run.id, run.userId);
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
      startedAt: now(),
      finishedAt: null,
      appendLog: [logEntry('info', 'Automation run started in a headless browser with the user browser profile.')],
    };
    const runningTransition = updateAutomationRunIfStatus(
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
    const credentialContext = credentialContextForCase(automationCase);
    throwIfRunCannotContinue(run.id, run.userId, owner, options.abortSignal);
    const browserProfileKey = `user_${automationCase.userId}`;
    browser = new BrowserSession(automationCase.mode, {
      browserSurface: 'external',
      headless: true,
      browserProfileKey,
      sharedBrowserRuntimeKey: browserProfileKey,
      isMarked: true,
      preferExistingPage: false,
      runId: run.id,
    });
    await browser.start();
    throwIfRunCannotContinue(run.id, run.userId, owner, options.abortSignal);
    if (automationCase.targetUrl && automationCase.targetUrl !== 'about:blank') {
      let initialOpen: BrowserActionResult;
      try {
        initialOpen = await browser.open(automationCase.targetUrl);
      } catch (error) {
        if (options.abortSignal?.aborted) throw error;
        initialOpen = { ok: false, actual: errorMessage(error) };
      }
      if (!initialOpen.ok) {
        run = await persistRunProgress(
          run,
          stepRecords,
          owner,
          logEntry('warn', 'Initial target navigation did not pass; fixed operations and final Agent verification will continue.', initialOpen.actual),
        );
      }
    }

    const operations = [...automationCase.operations].sort((left, right) => left.index - right.index);
    for (const operation of operations) {
      throwIfRunCannotContinue(run.id, run.userId, owner, options.abortSignal);
      await waitBeforeOperation(operation.delayBeforeMs, options.abortSignal);
      const startedAt = now();
      let fixedResult: BrowserActionResult;
      if (
        operation.replayable === false
        || operation.waitForManual === true
        || operation.name === 'waitForHumanVerification'
        || operation.recordedStatus === 'failed'
        || operation.recordedStatus === 'cancelled'
      ) {
        fixedResult = { ok: false, actual: operationDiagnostic(operation) };
      } else {
        try {
          fixedResult = await executeRecordedBrowserOperation(browser, operation, {
            runId: run.id,
            targetUrl: automationCase.targetUrl,
            abortSignal: options.abortSignal,
            credentialBindings: credentialContext.bindings,
          });
        } catch (error) {
          if (options.abortSignal?.aborted) throw error;
          fixedResult = { ok: false, actual: errorMessage(error) };
        }
      }

      throwIfRunCannotContinue(run.id, run.userId, owner, options.abortSignal);
      if (fixedResult.ok) {
        const evidence = await captureAutomationStepEvidence({
          browser,
          runId: run.id,
          stepNumber: stepRecords.length + 1,
          abortSignal: options.abortSignal,
        });
        stepRecords.push({
          operationIndex: operation.index,
          name: operation.name,
          status: 'fixed',
          actual: fixedResult.actual,
          fixedResult: fixedResult.actual,
          ...evidence,
          startedAt,
          finishedAt: now(),
        });
        run = await persistRunProgress(
          run,
          stepRecords,
          owner,
          logEntry(
            evidence.screenshotPath ? 'info' : 'warn',
            `Fixed operation ${operation.index} (${operation.name}) passed${evidence.screenshotPath ? ' with screenshot evidence' : ', but screenshot evidence failed'}.`,
            evidence.screenshotPath || evidence.screenshotError,
          ),
        );
        continue;
      }

      const repair = await repairFailedOperation({
        automationCase,
        browser,
        runId: run.id,
        operation,
        fixedFailure: fixedResult.actual,
        initialStepIndex: aiStepIndex,
        credentialContext,
        abortSignal: options.abortSignal,
      });
      throwIfRunCannotContinue(run.id, run.userId, owner, options.abortSignal);
      const evidence = await captureAutomationStepEvidence({
        browser,
        runId: run.id,
        stepNumber: stepRecords.length + 1,
        abortSignal: options.abortSignal,
      });
      if (repair.result) {
        const repairStepIndexes = repair.result.steps.map((step) => step.index);
        if (repairStepIndexes.length) aiStepIndex = Math.max(aiStepIndex, ...repairStepIndexes);
        const repaired = repair.result.status === 'passed';
        stepRecords.push({
          operationIndex: operation.index,
          name: operation.name,
          status: repaired ? 'repaired' : 'failed',
          actual: repair.result.reply || fixedResult.actual,
          fixedResult: fixedResult.actual,
          repairSteps: repair.result.newSteps,
          ...evidence,
          ...(repaired ? {} : { error: `Repair Agent ended with ${repair.result.status}.` }),
          startedAt,
          finishedAt: now(),
        });
      } else {
        stepRecords.push({
          operationIndex: operation.index,
          name: operation.name,
          status: 'failed',
          actual: repair.error || fixedResult.actual,
          fixedResult: fixedResult.actual,
          ...evidence,
          error: repair.error || 'Repair Agent failed.',
          startedAt,
          finishedAt: now(),
        });
      }
      run = await persistRunProgress(
        run,
        stepRecords,
        owner,
        logEntry(
          stepRecords.at(-1)?.status === 'repaired' ? 'info' : 'warn',
          `Fixed operation ${operation.index} (${operation.name}) failed and the mandatory repair Agent completed${evidence.screenshotPath ? ' with screenshot evidence' : ', but screenshot evidence failed'}.`,
          {
            actual: stepRecords.at(-1)?.actual,
            screenshot: evidence.screenshotPath || evidence.screenshotError,
          },
        ),
      );
    }

    throwIfRunCannotContinue(run.id, run.userId, owner, options.abortSignal);
    let verification: InteractiveBrowserTurnResult | undefined;
    let verificationError = '';
    const verificationStartedAt = now();
    try {
      verification = await runRepairAgent({
        automationCase,
        browser,
        runId: run.id,
        instruction: finalVerificationInstruction(automationCase, stepRecords),
        initialStepIndex: aiStepIndex,
        credentialContext,
        abortSignal: options.abortSignal,
      });
    } catch (error) {
      if (options.abortSignal?.aborted) throw error;
      verificationError = errorMessage(error);
    }

    throwIfRunCannotContinue(run.id, run.userId, owner, options.abortSignal);
    const verificationEvidence = await captureAutomationStepEvidence({
      browser,
      runId: run.id,
      stepNumber: stepRecords.length + 1,
      abortSignal: options.abortSignal,
    });

    const finalStatus = verification?.status === 'passed'
      ? 'passed'
      : verification?.status === 'blocked'
        ? 'blocked'
        : 'failed';
    stepRecords.push({
      operationIndex: operations.length + 1,
      name: 'finalVerification',
      status: finalStatus === 'passed' ? 'repaired' : 'failed',
      actual: verification?.reply || verificationError || 'Final verification failed without a result.',
      repairSteps: verification?.newSteps,
      ...verificationEvidence,
      ...(finalStatus === 'passed' ? {} : { error: verificationError || `Final Agent ended with ${verification?.status || 'failed'}.` }),
      startedAt: verificationStartedAt,
      finishedAt: now(),
    });
    const completedPatch: UpdateAutomationRunInput = {
      status: finalStatus,
      steps: stepRecords,
      error: finalStatus === 'passed' ? null : stepRecords.at(-1)?.error || stepRecords.at(-1)?.actual,
      finishedAt: now(),
      appendLog: [logEntry(
        finalStatus === 'passed' ? 'info' : 'error',
        `Mandatory final Agent verification ended with ${finalStatus}${verificationEvidence.screenshotPath ? ' with screenshot evidence' : ', but screenshot evidence failed'}.`,
        {
          actual: stepRecords.at(-1)?.actual,
          screenshot: verificationEvidence.screenshotPath || verificationEvidence.screenshotError,
        },
      )],
    };
    const completion = updateAutomationRunIfStatus(
      run.id,
      ['running'],
      completedPatch,
      run.userId,
      owner,
    );
    if (!completion) throw new Error('Automation run disappeared while saving the final verification.');
    run = completion.run;
    if (!completion.updated && run.status === 'cancelled') {
      throw new AutomationRunCancelledError();
    }
    return run;
  } catch (error) {
    const persistedRun = getAutomationRun(run.id, run.userId);
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
    const failureTransition = updateAutomationRunIfStatus(run.id, ['queued', 'running'], {
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
    releaseAutomationRunLease(run.id, owner, run.userId);
  }
}

/** Create a durable queued run and start its in-process worker immediately. */
export function enqueueAutomationCaseRun(input: EnqueueAutomationCaseRunInput): AutomationRunRecord {
  const normalizedUserId = userId(input.userId);
  const automationCase = getAutomationCase(input.caseId, normalizedUserId);
  if (!automationCase) throw new Error('Automation case not found.');
  const run = createAutomationRun({
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
export function cancelAutomationRun(
  runId: string,
  requestedUserId: string | number,
): CancelAutomationRunResult | undefined {
  const normalizedUserId = userId(requestedUserId);
  const transition = updateAutomationRunIfStatus(runId, ['queued', 'running'], {
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
