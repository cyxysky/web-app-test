import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import type { Browser, BrowserContext, BrowserContextOptions, BrowserServer, BrowserType, LaunchOptions } from 'playwright';
import { boundedPositiveIntegerEnv, cdpEndpointForPort, cdpPortFromEndpoint, clearManagedBrowserProfileCaches, type BrowserRuntimeEnvironment } from './browser-session-runtime.js';
import { type BrowserCodeConnection } from './browser-code-runner.js';
import { unknownErrorMessage } from './browser-session-diagnostics.js';

export type BrowserOwnership = 'launched' | 'connected' | 'persistent' | 'shared';

export type SharedBrowserOwnership = Exclude<BrowserOwnership, 'shared'>;

export type SharedBrowserLease = {
  browser?: Browser;
  browserServer?: BrowserServer;
  browserCodeConnection: BrowserCodeConnection;
  context: BrowserContext;
  ownership: SharedBrowserOwnership;
  release: (force?: boolean) => Promise<void>;
};

export type SharedBrowserState = {
  key?: string;
  browser?: Browser;
  browserServer?: BrowserServer;
  browserCodeConnection?: BrowserCodeConnection;
  context?: BrowserContext;
  ownership?: SharedBrowserOwnership;
  refCount: number;
  initPromise?: Promise<{
    browser?: Browser;
    browserServer?: BrowserServer;
    browserCodeConnection: BrowserCodeConnection;
    context: BrowserContext;
    ownership: SharedBrowserOwnership;
  }>;
  idleTimer?: ReturnType<typeof setTimeout>;
  closingPromise?: Promise<void>;
  generation: number;
  lifecycle: 'idle' | 'initializing' | 'ready' | 'closing' | 'failed';
  managedProfileDir?: string;
  environment?: BrowserRuntimeEnvironment;
};

export const sharedBrowserStates = ((globalThis as typeof globalThis & {
  __webPilotSharedBrowserStates?: Map<string, SharedBrowserState>;
}).__webPilotSharedBrowserStates ??= new Map<string, SharedBrowserState>());

export function sharedBrowserStateFor(runtimeKey: string) {
  let state = sharedBrowserStates.get(runtimeKey);
  if (!state) {
    state = { generation: 0, lifecycle: 'idle', refCount: 0 };
    sharedBrowserStates.set(runtimeKey, state);
  }
  state.generation ??= 0;
  state.lifecycle ??= state.context ? 'ready' : state.initPromise ? 'initializing' : 'idle';
  return state;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sharedBrowserKey(input: {
  cdpEndpoint: string;
  userDataDir: string;
  launchOptions: LaunchOptions;
  contextOptions: BrowserContextOptions;
}) {
  if (input.cdpEndpoint) return `cdp:${input.cdpEndpoint}`;
  if (input.userDataDir) return `persistent:${path.resolve(input.userDataDir)}`;
  return `launch:${JSON.stringify({ launch: input.launchOptions, context: input.contextOptions })}`;
}

export async function availableLoopbackPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('Unable to allocate a browserCode CDP port.');
  return address.port;
}

export async function launchPersistentContextWithBrowserCodeConnection(input: {
  chromium: BrowserType;
  userDataDir: string;
  launchOptions: LaunchOptions;
  contextOptions: BrowserContextOptions;
}) {
  const port = await availableLoopbackPort();
  const endpoint = cdpEndpointForPort(port);
  const context = await input.chromium.launchPersistentContext(input.userDataDir, {
    ...input.launchOptions,
    ...input.contextOptions,
    args: [
      ...(input.launchOptions.args || []).filter((arg) => !/^--remote-debugging-(?:pipe|port)(?:=|$)/.test(arg)),
      `--remote-debugging-port=${port}`,
    ],
  });
  return {
    browser: context.browser() || undefined,
    browserCodeConnection: { protocol: 'cdp', endpoint } satisfies BrowserCodeConnection,
    context,
    ownership: 'persistent' as const,
  };
}

export async function launchBrowserServerWithConnection(input: {
  chromium: BrowserType;
  launchOptions: LaunchOptions;
  contextOptions: BrowserContextOptions;
}) {
  const port = await availableLoopbackPort();
  const cdpEndpoint = cdpEndpointForPort(port);
  const browserServer = await input.chromium.launchServer({
    ...input.launchOptions,
    args: [
      ...(input.launchOptions.args || []).filter((arg) => !/^--remote-debugging-(?:pipe|port)(?:=|$)/.test(arg)),
      `--remote-debugging-port=${port}`,
    ],
  });
  const endpoint = browserServer.wsEndpoint();
  try {
    const browser = await input.chromium.connect(endpoint);
    const context = await browser.newContext(input.contextOptions);
    return {
      browser,
      browserServer,
      browserCodeConnection: { protocol: 'cdp', endpoint: cdpEndpoint } satisfies BrowserCodeConnection,
      context,
      ownership: 'launched' as const,
    };
  } catch (error) {
    await browserServer.close().catch(() => undefined);
    throw error;
  }
}

export async function connectExistingBrowserOverCdp(input: {
  chromium: BrowserType;
  endpoint: string;
  contextOptions: BrowserContextOptions;
  timeoutMs?: number;
}) {
  if (!input.endpoint) return undefined;
  const browser = await input.chromium.connectOverCDP(input.endpoint, { timeout: input.timeoutMs || 800 });
  const context = browser.contexts()[0] || await browser.newContext(input.contextOptions);
  return {
    browser,
    browserCodeConnection: { protocol: 'cdp', endpoint: input.endpoint } satisfies BrowserCodeConnection,
    context,
    ownership: 'connected' as const,
  };
}

export async function tryConnectExistingBrowserOverCdp(input: Parameters<typeof connectExistingBrowserOverCdp>[0]) {
  try {
    return {
      connection: await connectExistingBrowserOverCdp(input),
      error: '',
    };
  } catch (error) {
    return {
      connection: undefined,
      error: unknownErrorMessage(error).replace(/\s+/g, ' ').trim().slice(0, 2_000),
    };
  }
}

export async function tcpEndpointIsListening(endpoint: string) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: url.hostname, port });
    let settled = false;
    const finish = (listening: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(600);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

export async function windowsPersistentChromeDiagnostics(userDataDir: string, port: number) {
  if (process.platform !== 'win32') return '';
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$diagnosticProfile = [IO.Path]::GetFullPath($env:WEBPILOT_CHROME_DIAGNOSTIC_PROFILE)',
    '$port = [int]$env:WEBPILOT_CHROME_DIAGNOSTIC_PORT',
    '$profileProcesses = @(Get-CimInstance Win32_Process | Where-Object {',
    '  ($_.Name -eq "chrome.exe" -or $_.Name -eq "chromium.exe") -and',
    '  $_.CommandLine -and $_.CommandLine.IndexOf($diagnosticProfile, [StringComparison]::OrdinalIgnoreCase) -ge 0',
    '} | ForEach-Object {',
    '  $match = [regex]::Match($_.CommandLine, "--remote-debugging-port(?:=|\\s+)(\\d+)")',
    '  [pscustomobject]@{ processId = $_.ProcessId; cdpPort = $(if ($match.Success) { [int]$match.Groups[1].Value } else { $null }) }',
    '})',
    '$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | ForEach-Object {',
    '  [pscustomobject]@{ address = $_.LocalAddress; processId = $_.OwningProcess }',
    '})',
    '[pscustomobject]@{ profileProcesses = $profileProcesses; expectedPortListeners = $listeners } | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise<string>((resolve) => {
    const diagnosticProcess = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodedScript,
    ], {
      env: {
        ...process.env,
        WEBPILOT_CHROME_DIAGNOSTIC_PORT: String(port),
        WEBPILOT_CHROME_DIAGNOSTIC_PROFILE: userDataDir,
      },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let output = '';
    const timer = setTimeout(() => {
      diagnosticProcess.kill();
      resolve('');
    }, 5_000);
    timer.unref?.();
    diagnosticProcess.stdout?.on('data', (chunk: Buffer) => {
      output = `${output}${chunk.toString('utf8')}`.slice(-12_000);
    });
    diagnosticProcess.once('error', () => {
      clearTimeout(timer);
      resolve('');
    });
    diagnosticProcess.once('exit', () => {
      clearTimeout(timer);
      resolve(output.trim());
    });
  });
}

export function externalChromiumExecutablePath(chromium: BrowserType, launchOptions: LaunchOptions) {
  const explicit = typeof launchOptions.executablePath === 'string' ? launchOptions.executablePath.trim() : '';
  if (explicit) return explicit;
  if (launchOptions.channel) {
    throw new Error('BROWSER_CHANNEL cannot be used with automatic tab-group reuse unless AI_WEB_TEST_CHROMIUM_EXECUTABLE_PATH points to the browser executable.');
  }
  return chromium.executablePath();
}

export async function connectOrLaunchPersistentBrowserOverCdp(input: {
  chromium: BrowserType;
  endpoint: string;
  userDataDir: string;
  launchOptions: LaunchOptions;
  contextOptions: BrowserContextOptions;
  environment: BrowserRuntimeEnvironment;
}) {
  const connectTimeoutMs = boundedPositiveIntegerEnv('BROWSER_CDP_CONNECT_TIMEOUT_MS', 1_200, 500, 10_000, input.environment);
  const connectErrors: string[] = [];
  const connect = async () => {
    const attempt = await tryConnectExistingBrowserOverCdp({
      chromium: input.chromium,
      endpoint: input.endpoint,
      contextOptions: input.contextOptions,
      timeoutMs: connectTimeoutMs,
    });
    if (attempt.error && connectErrors.at(-1) !== attempt.error) connectErrors.push(attempt.error);
    return attempt.connection;
  };
  const existing = await connect();
  if (existing) return existing;

  const port = cdpPortFromEndpoint(input.endpoint);
  if (!port) throw new Error(`Automatic tab-group browser reuse needs a CDP port endpoint, got: ${input.endpoint || '[empty]'}`);
  const timeoutMs = boundedPositiveIntegerEnv('BROWSER_CDP_LAUNCH_TIMEOUT_MS', 15_000, 3_000, 120_000, input.environment);

  if (await tcpEndpointIsListening(input.endpoint)) {
    const existingDeadline = Date.now() + timeoutMs;
    while (Date.now() < existingDeadline) {
      const connected = await connect();
      if (connected) return connected;
      await sleep(250);
    }
    const windowsDiagnostics = await windowsPersistentChromeDiagnostics(input.userDataDir, port);
    throw new Error([
      `The expected Chrome CDP port ${input.endpoint} is already listening but did not complete a Playwright CDP handshake.`,
      `profile=${input.userDataDir}`,
      connectErrors.length ? `cdpConnectErrors=${JSON.stringify(connectErrors.slice(-3))}` : '',
      windowsDiagnostics ? `chromeProcessDiagnostics=${windowsDiagnostics}` : '',
      'A second Chrome was not launched because the expected port is already occupied. Inspect the listener process and its remote-debugging configuration.',
    ].filter(Boolean).join('\n'));
  }

  const executablePath = externalChromiumExecutablePath(input.chromium, input.launchOptions);
  const launchArgs = [
    ...(input.launchOptions.args || []).filter((arg) => !/^--remote-debugging-(?:pipe|port)(?:=|$)/.test(arg)),
    `--user-data-dir=${input.userDataDir}`,
    `--remote-debugging-port=${port}`,
    '--no-startup-window',
  ];
  const launchLogPath = path.join(input.userDataDir, 'chrome-cdp-launch.log');
  let launchLogOffset = 0;
  let launchLogHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    launchLogHandle = await open(launchLogPath, 'a+');
    launchLogOffset = (await launchLogHandle.stat()).size;
    await launchLogHandle.write(`\n[${new Date().toISOString()}] launch endpoint=${input.endpoint}\n`);
  } catch {
    await launchLogHandle?.close().catch(() => undefined);
    launchLogHandle = undefined;
  }

  let launchError = '';
  let launchExit = '';
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(executablePath, launchArgs, {
      detached: true,
      stdio: ['ignore', 'ignore', launchLogHandle ? launchLogHandle.fd : 'ignore'],
      windowsHide: false,
    });
  } catch (error) {
    await launchLogHandle?.close().catch(() => undefined);
    throw new Error(`Failed to launch test Chrome for tab-group reuse: ${unknownErrorMessage(error)}`);
  }
  await launchLogHandle?.close().catch(() => undefined);
  child.once('error', (error) => {
    launchError = unknownErrorMessage(error);
  });
  child.once('exit', (code, signal) => {
    launchExit = `code=${code ?? 'none'}, signal=${signal || 'none'}`;
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!launchError) {
      const connected = await connect();
      if (connected) return connected;
    }
    if (launchError) break;
    await sleep(250);
  }

  const [expectedPortListening, windowsDiagnostics, launchLog] = await Promise.all([
    tcpEndpointIsListening(input.endpoint),
    windowsPersistentChromeDiagnostics(input.userDataDir, port),
    readFile(launchLogPath, 'utf8')
      .then((content) => content.slice(launchLogOffset).trim().slice(-4_000))
      .catch(() => ''),
  ]);
  throw new Error([
    `Failed to connect to persistent test Chrome at ${input.endpoint}.`,
    `profile=${input.userDataDir}`,
    `executable=${executablePath}`,
    child.pid ? `launchedPid=${child.pid}` : '',
    launchError ? `launchError=${launchError}` : '',
    launchExit ? `launchExit=${launchExit}` : '',
    `expectedPortListening=${expectedPortListening}`,
    connectErrors.length ? `cdpConnectErrors=${JSON.stringify(connectErrors.slice(-3))}` : '',
    windowsDiagnostics ? `chromeProcessDiagnostics=${windowsDiagnostics}` : '',
    launchLog ? `chromeLaunchLog=${launchLog}` : '',
    expectedPortListening
      ? 'The expected port is listening but did not complete a Playwright CDP handshake; inspect chromeProcessDiagnostics for a port-owner or stale-process conflict.'
      : 'No CDP listener appeared before the launch timeout; inspect launchExit and chromeLaunchLog for a profile lock or Chrome startup failure.',
  ].filter(Boolean).join('\n'));
}

export function isPersistentProfileAlreadyOpenError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /Target page, context or browser has been closed|browser session|user data directory|profile.*in use|already.*open/i.test(message);
}

export async function closeConnectedBrowserProcess(browser?: Browser) {
  if (!browser) return false;
  const client = await browser.newBrowserCDPSession().catch(() => undefined);
  if (!client) return false;
  const closed = await Promise.race([
    client.send('Browser.close').then(() => true).catch(() => false),
    sleep(1000).then(() => false),
  ]);
  await Promise.race([
    client.detach().catch(() => undefined),
    sleep(500),
  ]);
  return closed;
}

export async function closeIdleSharedBrowser(runtimeKey: string, sharedBrowserState: SharedBrowserState, force = false) {
  if (sharedBrowserState.refCount > 0) {
    if (sharedBrowserState.idleTimer) clearTimeout(sharedBrowserState.idleTimer);
    sharedBrowserState.idleTimer = undefined;
    return;
  }
  const environment = sharedBrowserState.environment || process.env;
  const closeImmediately = force || environment.BROWSER_CLOSE_SHARED_WHEN_IDLE === 'true';
  if (!closeImmediately) {
    if (!sharedBrowserState.idleTimer) {
      const configured = Number(environment.BROWSER_USER_BROWSER_IDLE_TIMEOUT_MS || 3 * 60 * 1000);
      const timeoutMs = Number.isFinite(configured)
        ? Math.min(24 * 60 * 60 * 1000, Math.max(60_000, Math.floor(configured)))
        : 3 * 60 * 1000;
      sharedBrowserState.idleTimer = setTimeout(() => {
        sharedBrowserState.idleTimer = undefined;
        void closeIdleSharedBrowser(runtimeKey, sharedBrowserState, true);
      }, timeoutMs);
      sharedBrowserState.idleTimer.unref?.();
    }
    return;
  }

  if (sharedBrowserState.closingPromise) return sharedBrowserState.closingPromise;

  if (sharedBrowserState.idleTimer) clearTimeout(sharedBrowserState.idleTimer);
  sharedBrowserState.idleTimer = undefined;
  const closeGeneration = sharedBrowserState.generation;
  sharedBrowserState.lifecycle = 'closing';
  const closingPromise = (async () => {
    const { browser, browserServer, context, ownership } = sharedBrowserState;
    const managedProfileDir = sharedBrowserState.managedProfileDir;
    let managedProfileBrowserClosed = false;
    if (ownership === 'persistent') {
      await context?.close().catch(() => undefined);
      managedProfileBrowserClosed = true;
    } else if (ownership === 'launched') {
      await browser?.close().catch(() => undefined);
      managedProfileBrowserClosed = true;
    } else if (ownership === 'connected' && (force || environment.BROWSER_CLOSE_CONNECTED_ON_SHARED_RESET === 'true')) {
      if (force) managedProfileBrowserClosed = await closeConnectedBrowserProcess(browser);
      await browser?.close({ reason: 'Shared browser launch settings changed.' }).catch(() => undefined);
    }
    await browserServer?.close().catch(() => undefined);
    if (sharedBrowserState.generation !== closeGeneration) return;
    sharedBrowserState.browser = undefined;
    sharedBrowserState.browserServer = undefined;
    sharedBrowserState.browserCodeConnection = undefined;
    sharedBrowserState.context = undefined;
    sharedBrowserState.ownership = undefined;
    sharedBrowserState.initPromise = undefined;
    sharedBrowserState.key = undefined;
    sharedBrowserState.managedProfileDir = undefined;
    sharedBrowserState.environment = undefined;
    sharedBrowserState.generation += 1;
    sharedBrowserState.lifecycle = 'idle';
    if (managedProfileDir && managedProfileBrowserClosed) await clearManagedBrowserProfileCaches(managedProfileDir, environment);
  })();
  sharedBrowserState.closingPromise = closingPromise;
  try {
    await closingPromise;
  } catch (error) {
    sharedBrowserState.lifecycle = 'failed';
    throw error;
  } finally {
    if (sharedBrowserState.closingPromise === closingPromise) sharedBrowserState.closingPromise = undefined;
  }
}

export async function acquireSharedBrowser(input: {
  runtimeKey?: string;
  chromium: BrowserType;
  cdpEndpoint: string;
  reconnectCdpEndpoint?: string;
  userDataDir: string;
  launchOptions: LaunchOptions;
  contextOptions: BrowserContextOptions;
  managedProfileDir?: string;
  environment: BrowserRuntimeEnvironment;
}): Promise<SharedBrowserLease> {
  const runtimeKey = input.runtimeKey?.trim() || 'global';
  const sharedBrowserState = sharedBrowserStateFor(runtimeKey);
  await sharedBrowserState.closingPromise?.catch(() => undefined);
  if (sharedBrowserState.idleTimer) clearTimeout(sharedBrowserState.idleTimer);
  sharedBrowserState.idleTimer = undefined;
  const key = input.runtimeKey ? `runtime:${runtimeKey}` : sharedBrowserKey(input);
  if (sharedBrowserState.key && sharedBrowserState.key !== key && sharedBrowserState.refCount > 0) {
    throw new Error('A shared browser is already running with different launch settings. Stop active runs or set BROWSER_SHARED_TABS=false.');
  }
  if (sharedBrowserState.key && sharedBrowserState.key !== key && sharedBrowserState.refCount === 0) {
    await closeIdleSharedBrowser(runtimeKey, sharedBrowserState, true);
  }

  const browserStillConnected = !sharedBrowserState.browser || sharedBrowserState.browser.isConnected();
  if (!sharedBrowserState.initPromise || sharedBrowserState.key !== key || !browserStillConnected || !sharedBrowserState.context) {
    const initGeneration = ++sharedBrowserState.generation;
    sharedBrowserState.lifecycle = 'initializing';
    sharedBrowserState.key = key;
    sharedBrowserState.managedProfileDir = input.managedProfileDir;
    sharedBrowserState.environment = input.environment;
    sharedBrowserState.initPromise = (async () => {
      if (input.cdpEndpoint) {
        const browser = await input.chromium.connectOverCDP(input.cdpEndpoint);
        const context = browser.contexts()[0] || await browser.newContext(input.contextOptions);
        return {
          browser,
          browserCodeConnection: { protocol: 'cdp', endpoint: input.cdpEndpoint } satisfies BrowserCodeConnection,
          context,
          ownership: 'connected' as const,
        };
      }

      if (input.userDataDir) {
        if (input.reconnectCdpEndpoint) {
          return connectOrLaunchPersistentBrowserOverCdp({
            chromium: input.chromium,
            endpoint: input.reconnectCdpEndpoint,
            userDataDir: input.userDataDir,
            launchOptions: input.launchOptions,
            contextOptions: input.contextOptions,
            environment: input.environment,
          });
        }
        try {
          return await launchPersistentContextWithBrowserCodeConnection({
            chromium: input.chromium,
            userDataDir: input.userDataDir,
            launchOptions: input.launchOptions,
            contextOptions: input.contextOptions,
          });
        } catch (error) {
          const retryConnected = await connectExistingBrowserOverCdp({
            chromium: input.chromium,
            endpoint: input.reconnectCdpEndpoint || '',
            contextOptions: input.contextOptions,
          });
          if (retryConnected) return retryConnected;
          if (input.reconnectCdpEndpoint && isPersistentProfileAlreadyOpenError(error)) {
            throw new Error([
              '无法接管上一次的浏览器 tab 组：该 persistent profile 已经被一个旧浏览器进程占用，但旧进程没有可连接的 CDP 端口。',
              `profile=${input.userDataDir}`,
              `expectedCdp=${input.reconnectCdpEndpoint}`,
              '请关闭这个旧的自动化浏览器窗口一次；之后新启动的窗口会带 CDP 端口，继续时会优先连接并接管旧 tab 组。',
              error instanceof Error ? error.message : String(error),
            ].join('\n'));
          }
          throw error;
        }
      }

      return launchBrowserServerWithConnection({
        chromium: input.chromium,
        launchOptions: input.launchOptions,
        contextOptions: input.contextOptions,
      });
    })().then((lease) => {
      if (sharedBrowserState.generation !== initGeneration) throw new Error('Shared browser initialization was superseded.');
      sharedBrowserState.browser = lease.browser;
      sharedBrowserState.browserServer = 'browserServer' in lease ? lease.browserServer : undefined;
      sharedBrowserState.browserCodeConnection = lease.browserCodeConnection;
      sharedBrowserState.context = lease.context;
      sharedBrowserState.ownership = lease.ownership;
      sharedBrowserState.lifecycle = 'ready';
      return lease;
    }).catch((error) => {
      if (sharedBrowserState.generation === initGeneration) {
        sharedBrowserState.lifecycle = 'failed';
        sharedBrowserState.initPromise = undefined;
        sharedBrowserState.key = undefined;
      }
      throw error;
    });
  }

  const lease = await sharedBrowserState.initPromise;
  sharedBrowserState.refCount += 1;
  let released = false;
  return {
    ...lease,
    release: async (force = false) => {
      if (released) return;
      released = true;
      sharedBrowserState.refCount = Math.max(0, sharedBrowserState.refCount - 1);
      await closeIdleSharedBrowser(runtimeKey, sharedBrowserState, force);
    },
  };
}
