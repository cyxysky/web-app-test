import { spawn, type ChildProcess } from 'node:child_process';

export type BoundedProcessResult = {
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  outputLimitExceeded: boolean;
  error?: string;
};

function appendBounded(chunk: Buffer | string, remaining: number) {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  if (remaining <= 0) return { text: '', overflow: text.length > 0 };
  return text.length <= remaining
    ? { text, overflow: false }
    : { text: text.slice(0, remaining), overflow: true };
}

function terminateProcessTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const taskkill = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    taskkill.unref();
    return;
  }

  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the process may have already exited */ }
  try { child.kill('SIGKILL'); } catch { /* the process may have already exited */ }
}

export function runBoundedProcess(input: {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell?: boolean;
  timeoutMs: number;
  maxOutputChars: number;
  abortSignal?: AbortSignal;
  onStop?: () => void | Promise<void>;
}): Promise<BoundedProcessResult> {
  if (input.abortSignal?.aborted) {
    return Promise.reject(input.abortSignal.reason instanceof Error
      ? input.abortSignal.reason
      : new Error('Operation aborted.'));
  }

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(input.executable, [...input.args], {
        cwd: input.cwd,
        env: input.env,
        shell: input.shell ?? false,
        stdio: 'pipe',
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      resolve({
        exitCode: null,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false,
        aborted: false,
        outputLimitExceeded: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    child.stdin?.end();
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    let stdout = '';
    let stderr = '';
    let outputLength = 0;
    let stopReason: 'timeout' | 'abort' | 'output' | undefined;
    let spawnError: string | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const stop = (reason: 'timeout' | 'abort' | 'output') => {
      if (stopReason) return;
      stopReason = reason;
      void Promise.resolve(input.onStop?.()).catch(() => undefined);
      terminateProcessTree(child);
    };

    const onAbort = () => stop('abort');
    input.abortSignal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => stop('timeout'), input.timeoutMs);
    timer.unref?.();

    const append = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const bounded = appendBounded(chunk, input.maxOutputChars - outputLength);
      outputLength += bounded.text.length;
      if (target === 'stdout') stdout += bounded.text;
      else stderr += bounded.text;
      if (bounded.overflow) stop('output');
    };
    child.stdout?.on('data', (chunk: Buffer | string) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => append('stderr', chunk));
    child.once('error', (error) => {
      spawnError = error instanceof Error ? error.message : String(error);
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input.abortSignal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode,
        signal: signal || undefined,
        stdout,
        stderr,
        truncated: stopReason === 'output',
        timedOut: stopReason === 'timeout',
        aborted: stopReason === 'abort',
        outputLimitExceeded: stopReason === 'output',
        error: spawnError,
      });
    });
  });
}
