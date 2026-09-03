import { spawn } from 'node:child_process';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCodeSandboxCapability, type CodeSandboxExecutor, type CodeSandboxExecutionResult } from './index.js';
import type { CapabilityRunContext } from '@webpilot/capability-sdk';

function boundedAppend(current: string, chunk: Buffer | string, maximum: number) {
  const next = current + String(chunk);
  return next.length <= maximum ? { text: next, truncated: false } : { text: next.slice(0, maximum), truncated: true };
}

export function createNodeProcessCodeSandbox(input: {
  workspaceDirectory: string;
  nodeExecutable?: string;
  pythonExecutable?: string;
}): CodeSandboxExecutor {
  const workspace = path.resolve(input.workspaceDirectory);
  return {
    async run(execution, context): Promise<CodeSandboxExecutionResult> {
      await mkdir(workspace, { recursive: true });
      const extension = execution.language === 'python' ? 'py' : 'mjs';
      const file = path.join(workspace, `run-${randomUUID()}.${extension}`);
      await writeFile(file, execution.code, { encoding: 'utf8', flag: 'wx' });
      const executable = execution.language === 'python' ? (input.pythonExecutable || 'python') : (input.nodeExecutable || process.execPath);
      const startedAt = Date.now();
      return new Promise((resolve, reject) => {
        const child = spawn(executable, [file, ...execution.args], {
          cwd: workspace,
          env: { NODE_ENV: process.env.NODE_ENV || 'production', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
          shell: false,
          stdio: 'pipe',
          windowsHide: true,
        });
        child.stdin.end();
        let stdout = '';
        let stderr = '';
        let truncated = false;
        const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
          const current = target === 'stdout' ? stdout : stderr;
          const bounded = boundedAppend(current, chunk, execution.maxOutputChars);
          if (target === 'stdout') stdout = bounded.text;
          else stderr = bounded.text;
          truncated ||= bounded.truncated;
        };
        child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
        child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
        const stop = () => child.kill('SIGKILL');
        const timer = setTimeout(stop, execution.timeoutMs);
        timer.unref?.();
        const onAbort = () => stop();
        context.abortSignal?.addEventListener('abort', onAbort, { once: true });
        child.once('error', (error) => { clearTimeout(timer); context.abortSignal?.removeEventListener('abort', onAbort); void unlink(file).catch(() => undefined); reject(error); });
        child.once('close', (exitCode, signal) => {
          clearTimeout(timer);
          context.abortSignal?.removeEventListener('abort', onAbort);
          void unlink(file).catch(() => undefined);
          resolve({ exitCode, signal: signal || undefined, stdout, stderr, truncated, elapsedMs: Date.now() - startedAt });
        });
      });
    },
    async health() {
      try { await mkdir(workspace, { recursive: true }); return { status: 'healthy' }; }
      catch (error) { return { status: 'unhealthy', message: error instanceof Error ? error.message : String(error) }; }
    },
  };
}

export function createNodeCodeSandboxCapability(input: {
  workspaceDirectory: string | ((context: CapabilityRunContext) => string);
  nodeExecutable?: string;
  pythonExecutable?: string;
}) {
  return createCodeSandboxCapability({
    createExecutor(context) {
      return createNodeProcessCodeSandbox({
        workspaceDirectory: typeof input.workspaceDirectory === 'function' ? input.workspaceDirectory(context) : input.workspaceDirectory,
        nodeExecutable: input.nodeExecutable,
        pythonExecutable: input.pythonExecutable,
      });
    },
  });
}
