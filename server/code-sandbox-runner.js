/* eslint-disable no-console */
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { mkdtemp, mkdir, rm, writeFile, chmod } = require('node:fs/promises');

const HOST = process.env.CODE_SANDBOX_RUNNER_HOST || '127.0.0.1';
const PORT = Number(process.env.CODE_SANDBOX_RUNNER_PORT || 18100);
const TOKEN = String(process.env.CODE_SANDBOX_RUNNER_TOKEN || '').trim();
const WORKSPACE_ROOT = path.resolve(process.env.CODE_SANDBOX_RUNNER_WORKSPACE || path.join(os.tmpdir(), 'webpilot-code-sandbox'));
const MAX_BODY_BYTES = 1_000_000;
const MAX_CODE_CHARS = 100_000;
const MAX_OUTPUT_CHARS = 200_000;
const MAX_PACKAGES = 32;
const MAX_TIMEOUT_MS = 300_000;
const MAX_CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.CODE_SANDBOX_RUNNER_CONCURRENCY || 2)));
const PYTHON_EXECUTABLE = process.platform === 'win32' ? 'python' : 'python3';
const PYTHON_BIN_DIRECTORY = process.platform === 'win32' ? 'Scripts' : 'bin';
const PYTHON_BINARY = process.platform === 'win32' ? 'python.exe' : 'python';
const npmPackageSpec = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const pythonPackageSpec = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?==\d+(?:\.\d+)+(?:[A-Za-z0-9.+-]*)$/;

let active = 0;
const waiters = [];

function acquire(signal) {
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Operation aborted.'));
  if (active < MAX_CONCURRENCY) {
    active += 1;
    return Promise.resolve(() => release());
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal, onAbort: undefined };
    waiter.onAbort = () => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Operation aborted.'));
    };
    signal?.addEventListener('abort', waiter.onAbort, { once: true });
    waiters.push(waiter);
  });
}

function release() {
  active = Math.max(0, active - 1);
  const waiter = waiters.shift();
  if (!waiter) return;
  if (waiter.signal?.aborted) {
    waiter.reject(waiter.signal.reason instanceof Error ? waiter.signal.reason : new Error('Operation aborted.'));
    release();
    return;
  }
  if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
  active += 1;
  waiter.resolve(() => release());
}

function terminateProcessTree(child) {
  if (!child.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* process group may already be gone */ }
  try { child.kill('SIGKILL'); } catch { /* process may already be gone */ }
}

function runBoundedProcess(input) {
  if (input.signal?.aborted) return Promise.reject(input.signal.reason instanceof Error ? input.signal.reason : new Error('Operation aborted.'));
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(input.executable, input.args, {
        cwd: input.cwd,
        env: input.env,
        shell: input.shell || false,
        stdio: 'pipe',
        detached: true,
        ...(process.platform === 'linux' ? { uid: 10001, gid: 10001 } : {}),
      });
    } catch (error) {
      resolve({ exitCode: null, stdout: '', stderr: '', truncated: false, timedOut: false, aborted: false, outputLimitExceeded: false, error: error.message || String(error) });
      return;
    }
    child.stdin.end();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let outputLength = 0;
    let stopReason;
    let spawnError;
    let timer;
    const stop = (reason) => {
      if (stopReason) return;
      stopReason = reason;
      terminateProcessTree(child);
    };
    const onAbort = () => stop('abort');
    input.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => stop('timeout'), input.timeoutMs);
    const append = (target, chunk) => {
      const text = String(chunk);
      const remaining = Math.max(0, input.maxOutputChars - outputLength);
      const bounded = text.slice(0, remaining);
      outputLength += bounded.length;
      if (target === 'stdout') stdout += bounded;
      else stderr += bounded;
      if (bounded.length < text.length) stop('output');
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.once('error', (error) => { spawnError = error.message || String(error); });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
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

function environment(jobDirectory, pythonPackages) {
  return {
    NODE_ENV: 'production',
    PATH: process.env.PATH,
    HOME: path.join(jobDirectory, 'home'),
    TMPDIR: '/tmp',
    TEMP: '/tmp',
    TMP: '/tmp',
    PYTHONNOUSERSITE: '1',
    PYTHONPATH: pythonPackages,
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
  };
}

function failureText(result) {
  return [result.error, result.stderr && result.stderr.trim(), result.stdout && result.stdout.trim()].filter(Boolean).join('\n').slice(0, 8_000) || 'Process failed.';
}

async function installPackages(input) {
  if (!input.packages.length) return { elapsedMs: 0 };
  const target = input.language === 'javascript' ? input.jobDirectory : path.join(input.jobDirectory, 'python-packages');
  await mkdir(target, { recursive: true });
  const startedAt = Date.now();
  if (input.language === 'javascript') {
    const result = await runBoundedProcess({
      executable: process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args: ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--no-save', '--prefix', input.jobDirectory, ...input.packages],
      cwd: input.jobDirectory,
      env: input.env,
      timeoutMs: input.timeoutMs,
      maxOutputChars: 8_000,
      signal: input.signal,
      shell: process.platform === 'win32',
    });
    if (result.error || result.exitCode !== 0) throw new Error(`Package installation failed.\n${failureText(result)}`);
  } else {
    const venv = path.join(input.jobDirectory, '.venv');
    const venvResult = await runBoundedProcess({
      executable: PYTHON_EXECUTABLE,
      args: ['-m', 'venv', venv],
      cwd: input.jobDirectory,
      env: input.env,
      timeoutMs: input.timeoutMs,
      maxOutputChars: 8_000,
      signal: input.signal,
    });
    if (venvResult.error || venvResult.exitCode !== 0) throw new Error(`Python environment creation failed.\n${failureText(venvResult)}`);
    const pip = path.join(venv, PYTHON_BIN_DIRECTORY, process.platform === 'win32' ? 'pip.exe' : 'pip');
    const result = await runBoundedProcess({
      executable: pip,
      args: ['install', '--disable-pip-version-check', '--no-input', '--no-cache-dir', '--target', target, ...input.packages],
      cwd: input.jobDirectory,
      env: input.env,
      timeoutMs: input.timeoutMs,
      maxOutputChars: 8_000,
      signal: input.signal,
    });
    if (result.error || result.exitCode !== 0) throw new Error(`Package installation failed.\n${failureText(result)}`);
    input.executable = path.join(venv, PYTHON_BIN_DIRECTORY, PYTHON_BINARY);
  }
  return { elapsedMs: Date.now() - startedAt };
}

async function execute(payload, signal) {
  const language = payload.language;
  if (language !== 'javascript' && language !== 'python') throw new Error('Unsupported language.');
  if (typeof payload.code !== 'string' || payload.code.length < 1 || payload.code.length > MAX_CODE_CHARS) throw new Error('Code length is outside the allowed range.');
  const args = Array.isArray(payload.args) ? payload.args : [];
  const packages = Array.isArray(payload.packages) ? payload.packages.map((item) => String(item).trim()) : [];
  if (args.length > 32 || args.some((item) => typeof item !== 'string' || item.length > 2_000)) throw new Error('Invalid execution arguments.');
  if (packages.length > MAX_PACKAGES) throw new Error(`At most ${MAX_PACKAGES} packages may be installed per execution.`);
  const packagePattern = language === 'javascript' ? npmPackageSpec : pythonPackageSpec;
  const invalidPackages = packages.filter((item) => !packagePattern.test(item));
  if (invalidPackages.length) throw new Error(`Only exact package versions are allowed: ${invalidPackages.join(', ')}`);
  if (payload.networkMode !== 'full') throw new Error('This runner is network-enabled. Use a separately deployed no-network runner for networkMode=none.');

  const timeoutMs = Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Number(payload.timeoutMs) || 30_000));
  const installTimeoutMs = Math.max(5_000, Math.min(timeoutMs, Number(payload.installTimeoutMs) || 120_000));
  const maxOutputChars = Math.max(1_000, Math.min(MAX_OUTPUT_CHARS, Number(payload.maxOutputChars) || 30_000));
  const startedAt = Date.now();
  let jobDirectory;
  try {
    await mkdir(WORKSPACE_ROOT, { recursive: true });
    jobDirectory = await mkdtemp(path.join(WORKSPACE_ROOT, 'job-'));
    await chmod(jobDirectory, 0o777).catch(() => undefined);
    await mkdir(path.join(jobDirectory, 'home'), { recursive: true });
    const file = path.join(jobDirectory, `run-${Date.now()}.${language === 'python' ? 'py' : 'mjs'}`);
    await writeFile(file, payload.code, 'utf8');
    const pythonPackages = path.join(jobDirectory, 'python-packages');
    const env = environment(jobDirectory, pythonPackages);
    const execution = {
      language,
      packages,
      jobDirectory,
      executable: language === 'python' ? PYTHON_EXECUTABLE : 'node',
      env,
      signal,
    };
    const install = await installPackages({
      ...execution,
      timeoutMs: Math.min(installTimeoutMs, Math.max(1, timeoutMs - (Date.now() - startedAt))),
    });
    const result = await runBoundedProcess({
      executable: execution.executable,
      args: [file, ...args],
      cwd: jobDirectory,
      env,
      timeoutMs: Math.max(1, timeoutMs - (Date.now() - startedAt)),
      maxOutputChars,
      signal,
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
      packagesInstalled: packages.length ? packages : undefined,
      installElapsedMs: install.elapsedMs || undefined,
    };
  } finally {
    if (jobDirectory) await rm(jobDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
  }
}

function authorized(request) {
  if (!TOKEN) return false;
  return request.headers.authorization === `Bearer ${TOKEN}`;
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.once('error', reject);
  });
}

const server = http.createServer(async (request, response) => {
  if (!authorized(request)) {
    sendJson(response, 401, { error: 'Unauthorized.' });
    return;
  }
  if (request.method === 'GET' && (request.url === '/health' || request.url === '/healthz')) {
    sendJson(response, 200, { status: 'healthy', network: 'full', concurrency: MAX_CONCURRENCY });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/execute') {
    sendJson(response, 404, { error: 'Not found.' });
    return;
  }
  const abortController = new AbortController();
  request.once('aborted', () => abortController.abort(new Error('Client disconnected.')));
  let release;
  try {
    const raw = await readBody(request);
    const payload = JSON.parse(raw);
    release = await acquire(abortController.signal);
    const result = await execute(payload, abortController.signal);
    sendJson(response, 200, result);
  } catch (error) {
    if (!response.destroyed) sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  } finally {
    release?.();
  }
});

if (!TOKEN) {
  console.error('CODE_SANDBOX_RUNNER_TOKEN must be set.');
  process.exit(1);
}

server.requestTimeout = 0;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.listen(PORT, HOST, () => console.log(`Code Sandbox runner listening on ${HOST}:${PORT} (network=full, concurrency=${MAX_CONCURRENCY})`));
