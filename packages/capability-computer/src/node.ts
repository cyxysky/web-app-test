import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createComputerCapability, type ComputerDriver } from './index.js';
import type { CapabilityRunContext } from '@webpilot/capability-sdk';

const execFileAsync = promisify(execFile);
const COMPUTER_PATH = '/v1/computer';
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024;

type ComputerResult = Awaited<ReturnType<ComputerDriver['execute']>>;
type ContextValue<T> = T | ((context: CapabilityRunContext) => T | Promise<T>);

export type NodeComputerCapabilityOptions = {
  createDriver?: (context: CapabilityRunContext) => ComputerDriver | Promise<ComputerDriver>;
  screenshotDirectory?: ContextValue<string>;
};

type BuiltInDriverService = {
  authorization: string;
  endpoint: string;
  close(): Promise<void>;
};

let builtInDriverService: Promise<BuiltInDriverService> | undefined;

function optionalAuthorization(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? { authorization: text } : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeSegment(value: unknown, fallback: string) {
  const normalized = String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized.slice(0, 120) || fallback;
}

function disabledDriver(message: string): ComputerDriver {
  return {
    async execute() { throw new Error(message); },
    async health() { return { status: 'needs-runtime', message }; },
  };
}

function json(response: ServerResponse, status: number, payload: unknown) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': String(body.length),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(body);
}

function readJsonRequest(request: IncomingMessage) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error('Computer driver request is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        const payload = record(parsed);
        if (!payload) throw new Error('Computer driver request must be a JSON object.');
        resolve(payload);
      } catch (error) {
        reject(error);
      }
    });
    request.once('error', reject);
  });
}

function windowsPowerShellPath() {
  const windowsDirectory = String(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows');
  return path.join(windowsDirectory, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function windowsDriverScriptPath() {
  const fileName = 'windows-computer-driver.ps1';
  const candidates = [
    process.env.CAPABILITY_COMPUTER_RUNTIME_DIR
      ? path.join(process.env.CAPABILITY_COMPUTER_RUNTIME_DIR, fileName)
      : '',
    path.join(process.cwd(), 'capability-runtime', 'computer', fileName),
    path.join(process.cwd(), 'packages', 'capability-computer', 'runtime', fileName),
    fileURLToPath(new URL(`../runtime/${fileName}`, import.meta.url)),
  ].filter(Boolean);
  const scriptPath = candidates.find((candidate) => existsSync(candidate));
  if (!scriptPath) throw new Error('The bundled Windows computer driver runtime is missing.');
  return scriptPath;
}

async function executeWindowsAction(input: Record<string, unknown>) {
  const action = String(input.action || '').trim();
  if (!['observe', 'screenshot', 'click', 'type', 'key', 'scroll', 'wait'].includes(action)) {
    throw new Error(`Unsupported computer action: ${action || '(empty)'}.`);
  }
  const timeoutMs = Math.min(300_000, Math.max(1_000, Number(input.timeoutMs) || 30_000));
  const capture = action === 'observe' || action === 'screenshot';
  const temporaryDirectory = capture
    ? await mkdir(path.join(os.tmpdir(), 'webpilot-computer-driver'), { recursive: true }).then(() => path.join(os.tmpdir(), 'webpilot-computer-driver'))
    : undefined;
  const screenshotPath = temporaryDirectory ? path.join(temporaryDirectory, `${randomUUID()}.png`) : '';
  const encodedAction = Buffer.from(JSON.stringify(input), 'utf8').toString('base64');
  try {
    const { stdout } = await execFileAsync(windowsPowerShellPath(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-STA',
      '-File',
      windowsDriverScriptPath(),
      '-ActionBase64',
      encodedAction,
      ...(screenshotPath ? ['-ScreenshotPath', screenshotPath] : []),
    ], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      timeout: timeoutMs + 5_000,
      windowsHide: true,
    });
    const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const result = record(JSON.parse(lines.at(-1) || '{}')) || {};
    if (screenshotPath) {
      const screenshot = await readFile(screenshotPath);
      if (screenshot.length > MAX_SCREENSHOT_BYTES) throw new Error('Computer screenshot exceeds the 32 MiB limit.');
      return {
        ...result,
        mediaType: 'image/png',
        screenshotBase64: screenshot.toString('base64'),
      };
    }
    return result;
  } catch (error) {
    const errorWithStderr = error as Error & { stderr?: unknown };
    const details = [errorWithStderr.message, errorWithStderr.stderr]
      .filter((value): value is string => typeof value === 'string')
      .join('\n');
    if (/CopyFromScreen|handle is invalid|句柄无效/i.test(details)) {
      throw new Error(
        'Windows is locked or showing a secure desktop, so screenshots are unavailable. Unlock the desktop manually, then retry observe.',
      );
    }
    throw error;
  } finally {
    if (screenshotPath) await rm(screenshotPath, { force: true }).catch(() => undefined);
  }
}

async function startBuiltInWindowsDriverService(): Promise<BuiltInDriverService> {
  if (process.platform !== 'win32') {
    throw new Error('The built-in computer driver is available only on Windows.');
  }
  const authorization = `Bearer ${randomBytes(32).toString('base64url')}`;
  let queue = Promise.resolve<unknown>(undefined);
  const serial = <T>(operation: () => Promise<T>) => {
    const pending = queue.then(operation, operation);
    queue = pending.then(() => undefined, () => undefined);
    return pending;
  };
  const server = createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      if (requestUrl.pathname !== COMPUTER_PATH) {
        json(response, 404, { error: 'Not found.' });
        return;
      }
      if (request.headers.authorization !== authorization) {
        json(response, 401, { error: 'Unauthorized.' });
        return;
      }
      if (request.method === 'HEAD') {
        response.writeHead(204, { 'cache-control': 'no-store' });
        response.end();
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'HEAD, POST' });
        response.end();
        return;
      }
      const payload = await readJsonRequest(request);
      json(response, 200, await serial(() => executeWindowsAction(payload)));
    })().catch((error) => {
      if (!response.headersSent) {
        json(response, 500, { error: error instanceof Error ? error.message : String(error) });
      } else {
        response.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to resolve the built-in computer driver address.');
  }
  return {
    authorization,
    endpoint: `http://127.0.0.1:${address.port}${COMPUTER_PATH}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function sharedBuiltInWindowsDriver() {
  builtInDriverService ||= startBuiltInWindowsDriverService().catch((error) => {
    builtInDriverService = undefined;
    throw error;
  });
  const service = await builtInDriverService;
  return createRemoteComputerDriver({
    endpoint: service.endpoint,
    headers: { authorization: service.authorization },
  });
}

async function resolveContextValue<T>(value: ContextValue<T> | undefined, context: CapabilityRunContext) {
  if (value === undefined) return undefined;
  return typeof value === 'function'
    ? (value as (context: CapabilityRunContext) => T | Promise<T>)(context)
    : value;
}

function screenshotBuffer(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const base64 = value.trim().replace(/^data:image\/(?:png|jpeg);base64,/i, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('Computer driver returned invalid screenshot base64.');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length || buffer.length > MAX_SCREENSHOT_BYTES) {
    throw new Error('Computer driver returned an empty or oversized screenshot.');
  }
  return buffer;
}

async function persistScreenshot(
  result: ComputerResult,
  context: CapabilityRunContext,
  directorySetting?: ContextValue<string>,
): Promise<ComputerResult> {
  const payload = record(result);
  const screenshot = screenshotBuffer(payload?.screenshotBase64);
  if (!payload || !screenshot) return result;
  const mediaType = payload.mediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const extension = mediaType === 'image/jpeg' ? '.jpg' : '.png';
  const configuredDirectory = await resolveContextValue(directorySetting, context);
  const directory = path.resolve(configuredDirectory || path.join(
    os.tmpdir(),
    'webpilot-computer-artifacts',
    safeSegment(context.runId, 'shared'),
  ));
  await mkdir(directory, { recursive: true });
  const artifactId = path.join(directory, `computer-${randomUUID()}${extension}`);
  await writeFile(artifactId, screenshot, { flag: 'wx' });
  const observation = { ...payload };
  delete observation.screenshotBase64;
  return { ...observation, artifactId, mediaType };
}

function withScreenshotPersistence(
  driver: ComputerDriver,
  context: CapabilityRunContext,
  directory?: ContextValue<string>,
): ComputerDriver {
  return {
    async execute(action, executionContext) {
      return persistScreenshot(await driver.execute(action, executionContext), context, directory);
    },
    health: driver.health ? () => driver.health!() : undefined,
    dispose: driver.dispose ? () => driver.dispose!() : undefined,
  };
}

export function createRemoteComputerDriver(input: {
  endpoint: string;
  headers?: Readonly<Record<string, string>>;
  fetchImpl?: typeof fetch;
}): ComputerDriver {
  return {
    async execute(action, context) {
      const timeout = AbortSignal.timeout(action.timeoutMs);
      const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, timeout]) : timeout;
      const response = await (input.fetchImpl || fetch)(input.endpoint, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', accept: 'application/json', ...input.headers },
        body: JSON.stringify(action),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Computer driver returned HTTP ${response.status}: ${text.slice(0, 1000)}`);
      return JSON.parse(text) as Record<string, unknown>;
    },
    async health() {
      try {
        const response = await (input.fetchImpl || fetch)(input.endpoint, { method: 'HEAD', headers: input.headers });
        return response.ok
          ? { status: 'healthy' }
          : { status: 'unhealthy', message: `Driver returned HTTP ${response.status}.` };
      } catch (error) {
        return { status: 'unhealthy', message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

export function createNodeComputerCapability(input: NodeComputerCapabilityOptions = {}) {
  return createComputerCapability({
    async createDriver(context) {
      if (context.configuration.AGENT_COMPUTER_ENABLED !== 'true') {
        return disabledDriver('Computer control is disabled by host configuration.');
      }
      const customDriver = input.createDriver ? await input.createDriver(context) : undefined;
      const endpoint = String(context.configuration.AGENT_COMPUTER_ENDPOINT || '').trim();
      const driver = customDriver
        || (endpoint
          ? createRemoteComputerDriver({
            endpoint,
            headers: optionalAuthorization(context.configuration.AGENT_COMPUTER_AUTHORIZATION),
          })
          : process.platform === 'win32'
            ? await sharedBuiltInWindowsDriver()
            : disabledDriver('No computer driver endpoint is configured and the built-in driver requires Windows.'));
      return withScreenshotPersistence(driver, context, input.screenshotDirectory);
    },
  });
}
