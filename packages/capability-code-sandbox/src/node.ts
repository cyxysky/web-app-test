import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCodeSandboxCapability, type CodeSandboxExecutor, type CodeSandboxExecutionResult } from './index.js';
import { runBoundedProcess } from './process-runner.js';
import type { CapabilityRunContext } from '@webpilot/capability-sdk';

type LocalProcessOptions = {
  workspaceDirectory: string;
  nodeExecutable?: string;
  pythonExecutable?: string;
  npmExecutable?: string;
};

class AsyncSemaphore {
  readonly #limit: number;
  #active = 0;
  readonly #waiters: Array<{ resolve: (release: () => void) => void; reject: (error: Error) => void; signal?: AbortSignal; onAbort?: () => void }> = [];

  constructor(limit: number) {
    this.#limit = Math.max(1, Math.floor(limit));
  }

  acquire(signal?: AbortSignal) {
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Operation aborted.'));
    if (this.#active < this.#limit) {
      this.#active += 1;
      return Promise.resolve(() => this.release());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter = { resolve, reject, signal } as { resolve: (release: () => void) => void; reject: (error: Error) => void; signal?: AbortSignal; onAbort?: () => void };
      waiter.onAbort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(signal?.reason instanceof Error ? signal.reason : new Error('Operation aborted.'));
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  private release() {
    this.#active = Math.max(0, this.#active - 1);
    const waiter = this.#waiters.shift();
    if (!waiter) return;
    if (waiter.signal?.aborted) {
      waiter.reject(waiter.signal.reason instanceof Error ? waiter.signal.reason : new Error('Operation aborted.'));
      this.release();
      return;
    }
    if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
    this.#active += 1;
    waiter.resolve(() => this.release());
  }
}

function executableName(value: string | undefined, fallback: string) {
  return String(value || '').trim() || fallback;
}

function cleanError(result: { error?: string; stderr: string; stdout: string }) {
  return [result.error, result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n').slice(0, 8_000) || 'Process failed.';
}

function localEnvironment(jobDirectory: string, pythonPackages: string) {
  return {
    NODE_ENV: process.env.NODE_ENV || 'production',
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    HOME: path.join(jobDirectory, 'home'),
    PYTHONNOUSERSITE: '1',
    PYTHONPATH: pythonPackages,
  } satisfies NodeJS.ProcessEnv;
}

async function installPackages(input: {
  language: 'javascript' | 'python';
  packages: readonly string[];
  jobDirectory: string;
  executable: string;
  npmExecutable?: string;
  timeoutMs: number;
  maxOutputChars: number;
  abortSignal?: AbortSignal;
  environment: NodeJS.ProcessEnv;
}) {
  if (!input.packages.length) return { elapsedMs: 0 };
  const startedAt = Date.now();
  const target = input.language === 'javascript'
    ? input.jobDirectory
    : path.join(input.jobDirectory, 'python-packages');
  await mkdir(target, { recursive: true });
  const result = await runBoundedProcess({
    executable: input.language === 'javascript'
      ? executableName(input.npmExecutable, process.platform === 'win32' ? 'npm.cmd' : 'npm')
      : input.executable,
    args: input.language === 'javascript'
      ? ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--no-save', '--prefix', input.jobDirectory, ...input.packages]
      : ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--no-cache-dir', '--target', target, ...input.packages],
    cwd: input.jobDirectory,
    env: input.environment,
    timeoutMs: input.timeoutMs,
    maxOutputChars: Math.min(input.maxOutputChars, 8_000),
    abortSignal: input.abortSignal,
    shell: input.language === 'javascript' && process.platform === 'win32',
  });
  if (result.error || result.exitCode !== 0) throw new Error(`Package installation failed.\n${cleanError(result)}`);
  return { elapsedMs: Date.now() - startedAt };
}

async function checkExecutable(executable: string) {
  const result = await runBoundedProcess({
    executable,
    args: ['--version'],
    cwd: process.cwd(),
    env: { NODE_ENV: process.env.NODE_ENV || 'production', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
    timeoutMs: 5_000,
    maxOutputChars: 1_000,
  });
  return result.error ? result.error : result.exitCode === 0 ? undefined : cleanError(result);
}

export function createNodeProcessCodeSandbox(input: LocalProcessOptions & { maxConcurrent?: number }): CodeSandboxExecutor {
  const workspace = path.resolve(input.workspaceDirectory);
  const semaphore = new AsyncSemaphore(input.maxConcurrent || 2);
  return {
    async run(execution, context): Promise<CodeSandboxExecutionResult> {
      if (execution.networkMode === 'none') {
        throw new Error('The local code backend cannot enforce network isolation. Use the remote runner for network=none.');
      }
      const release = await semaphore.acquire(context.abortSignal);
      let jobDirectory: string | undefined;
      const startedAt = Date.now();
      try {
        await mkdir(workspace, { recursive: true });
        jobDirectory = await mkdtemp(path.join(workspace, 'job-'));
        await chmod(jobDirectory, 0o700).catch(() => undefined);
        const extension = execution.language === 'python' ? 'py' : 'mjs';
        const file = path.join(jobDirectory, `run-${randomUUID()}.${extension}`);
        await writeFile(file, execution.code, { encoding: 'utf8', flag: 'wx' });
        const pythonPackages = path.join(jobDirectory, 'python-packages');
        await mkdir(path.join(jobDirectory, 'home'), { recursive: true });
        const environment = localEnvironment(jobDirectory, pythonPackages);
        const executable = execution.language === 'python'
          ? executableName(input.pythonExecutable, 'python')
          : executableName(input.nodeExecutable, process.execPath);
        const install = await installPackages({
          language: execution.language,
          packages: execution.packages,
          jobDirectory,
          executable,
          npmExecutable: input.npmExecutable,
          timeoutMs: Math.min(execution.installTimeoutMs, Math.max(1, execution.timeoutMs - (Date.now() - startedAt))),
          maxOutputChars: execution.maxOutputChars,
          abortSignal: context.abortSignal,
          environment,
        });
        const remainingMs = Math.max(1, execution.timeoutMs - (Date.now() - startedAt));
        const result = await runBoundedProcess({
          executable,
          args: [file, ...execution.args],
          cwd: jobDirectory,
          env: environment,
          timeoutMs: remainingMs,
          maxOutputChars: execution.maxOutputChars,
          abortSignal: context.abortSignal,
        });
        if (result.error) throw new Error(result.error);
        return {
          exitCode: result.exitCode,
          signal: result.signal,
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.truncated,
          elapsedMs: Date.now() - startedAt,
          timedOut: result.timedOut,
          aborted: result.aborted,
          outputLimitExceeded: result.outputLimitExceeded,
          packagesInstalled: execution.packages.length ? [...execution.packages] : undefined,
          installElapsedMs: install.elapsedMs || undefined,
        };
      } finally {
        if (jobDirectory) await rm(jobDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
        release();
      }
    },
    async health() {
      try {
        await mkdir(workspace, { recursive: true });
        const nodeError = await checkExecutable(executableName(input.nodeExecutable, process.execPath));
        const pythonError = await checkExecutable(executableName(input.pythonExecutable, 'python'));
        if (nodeError || pythonError) return { status: 'needs-runtime', message: [nodeError && `Node: ${nodeError}`, pythonError && `Python: ${pythonError}`].filter(Boolean).join(' ') };
        return { status: 'healthy' };
      } catch (error) {
        return { status: 'unhealthy', message: error instanceof Error ? error.message : String(error) };
      }
    },
    async dispose() {
      await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
    },
  };
}

export function createNodeCodeSandboxCapability(input: {
  workspaceDirectory: string | ((context: CapabilityRunContext) => string);
  nodeExecutable?: string;
  pythonExecutable?: string;
  npmExecutable?: string;
  maxConcurrent?: number;
}) {
  return createCodeSandboxCapability({
    createExecutor(context) {
      return createNodeProcessCodeSandbox({
        workspaceDirectory: typeof input.workspaceDirectory === 'function' ? input.workspaceDirectory(context) : input.workspaceDirectory,
        nodeExecutable: input.nodeExecutable,
        pythonExecutable: input.pythonExecutable,
        npmExecutable: input.npmExecutable,
        maxConcurrent: input.maxConcurrent,
      });
    },
  });
}
