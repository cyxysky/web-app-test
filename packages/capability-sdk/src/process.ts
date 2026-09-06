import { spawn, type ChildProcess } from 'node:child_process';

export type CapabilityProcessOptions = {
  executable: string; args: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv;
  timeoutMs: number; maxOutputChars?: number; signal?: AbortSignal; stdin?: string;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
};

function terminate(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => { child.kill(); });
    killer.unref();
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

/** Owns the process tree and settles after termination; cancellation never returns a successful partial result. */
export function runCapabilityProcess(input: CapabilityProcessOptions): Promise<{ stdout: string; stderr: string }> {
  input.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, [...input.args], {
      cwd: input.cwd, env: input.env, windowsHide: true, shell: false,
      detached: process.platform !== 'win32', stdio: 'pipe',
    });
    let stdout = '', stderr = '', stopped: Error | undefined;
    const maximum = input.maxOutputChars || 100_000;
    const stop = (error: Error) => { if (!stopped) { stopped = error; terminate(child); } };
    const abort = () => stop(input.signal?.reason instanceof Error ? input.signal.reason : new Error('Operation cancelled.'));
    const timer = setTimeout(() => stop(new Error(`Process timed out after ${input.timeoutMs}ms.`)), input.timeoutMs);
    const cleanup = () => { clearTimeout(timer); input.signal?.removeEventListener('abort', abort); };
    input.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const append = (text: string, target: 'stdout' | 'stderr') => {
      const remaining = Math.max(0, maximum - stdout.length - stderr.length);
      if (target === 'stdout') stdout += text.slice(0, remaining); else stderr += text.slice(0, remaining);
      if (text.length > remaining) stop(new Error(`Process output exceeded ${maximum} characters.`));
      try { (target === 'stdout' ? input.onStdout : input.onStderr)?.(text.slice(0, remaining)); }
      catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
    };
    child.stdout.on('data', (chunk: string) => append(chunk, 'stdout'));
    child.stderr.on('data', (chunk: string) => append(chunk, 'stderr'));
    child.once('error', (error) => { cleanup(); reject(error); });
    child.stdin.on('error', (error) => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') stop(error); });
    child.once('close', (code) => {
      cleanup();
      if (stopped) reject(stopped);
      else if (code !== 0) reject(new Error(stderr || `Process exited with code ${code}.`));
      else resolve({ stdout, stderr });
    });
    child.stdin.end(input.stdin);
    if (input.signal?.aborted) abort();
  });
}
