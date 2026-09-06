import { randomUUID } from 'node:crypto';
import {
  createCapabilityMcpHandler,
  createCapabilityMcpServer,
  serveCapabilityMcpStdio,
  type CapabilityMcpServerOptions,
} from '@webpilot/capability-adapter-mcp';
import {
  defineCapabilityInput,
  defineCapabilityTool,
  raceWithAbort,
  type CapabilityProvider,
  type CapabilityResult,
  type CapabilityRunContext,
} from '@webpilot/capability-sdk';
import { z } from 'zod';
import {
  BrowserSession,
  type BrowserActionResult,
  type BrowserSessionOptions,
} from './node/browser-session.js';

const browserSessionId = z.string().uuid();
const openParser = z.object({
  url: z.string().url().max(8_000).optional(),
}).strict();
const codeParser = z.object({
  browserSessionId,
  code: z.string().min(1).max(40_000),
  maxOutputChars: z.number().int().min(1_000).max(200_000).optional(),
}).strict();
const snapshotParser = z.object({
  browserSessionId,
  scope: z.enum(['active', 'all']).optional(),
  frame: z.string().trim().min(1).max(200).optional(),
  selector: z.string().trim().min(1).max(2000).optional(),
  query: z.string().trim().min(1).max(300).optional(),
  cursor: z.string().min(1).max(1000).optional(),
  maxOutputChars: z.number().int().min(1_000).max(200_000).optional(),
}).strict();
const closeParser = z.object({ browserSessionId }).strict();

const input = <T>(parser: z.ZodType<T>) => defineCapabilityInput(
  z.toJSONSchema(parser) as Readonly<Record<string, unknown>>,
  (value): T => parser.parse(value),
);

type ManagedBrowserSession = {
  runId: string;
  session: BrowserSession;
  stepIndex: number;
  queue: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
  closing: boolean;
};

export type BrowserMcpSessionManagerOptions = {
  maxSessions?: number;
  /** Closes forgotten sessions after inactivity. Set to 0 to disable expiry. */
  idleTimeoutMs?: number;
  sessionOptions?: BrowserSessionOptions;
};

function browserResult(
  id: string,
  result: BrowserActionResult,
): CapabilityResult {
  const data = {
    browserSessionId: id,
    result: result.data ?? result.actual,
  };
  return result.ok
    ? { ok: true, summary: result.summary || result.actual, data }
    : {
        ok: false,
        error: {
          code: result.failureCategory || 'browser-operation-failed',
          message: result.actual,
          details: data,
        },
      };
}

/** Owns explicit browser session ids so MCP clients never depend on an implicit run id. */
export class BrowserMcpSessionManager {
  readonly #sessions = new Map<string, ManagedBrowserSession>();
  readonly #maxSessions: number;
  readonly #idleTimeoutMs: number;
  #openingSessions = 0;

  constructor(private readonly options: BrowserMcpSessionManagerOptions = {}) {
    const configuredMaxSessions = Number(options.maxSessions ?? 8);
    this.#maxSessions = Number.isFinite(configuredMaxSessions)
      ? Math.max(1, Math.min(100, Math.floor(configuredMaxSessions)))
      : 8;
    const configuredIdleTimeout = Number(options.idleTimeoutMs ?? 15 * 60_000);
    this.#idleTimeoutMs = Number.isFinite(configuredIdleTimeout)
      ? Math.max(0, Math.min(24 * 60 * 60_000, Math.floor(configuredIdleTimeout)))
      : 15 * 60_000;
  }

  async open(inputValue: z.infer<typeof openParser>, abortSignal?: AbortSignal): Promise<CapabilityResult> {
    if (this.#sessions.size + this.#openingSessions >= this.#maxSessions) {
      return {
        ok: false,
        error: {
          code: 'browser-session-capacity-reached',
          message: `This MCP server allows at most ${this.#maxSessions} open browser sessions. Close one before opening another.`,
        },
      };
    }
    this.#openingSessions += 1;
    const id = randomUUID();
    const runId = `mcp-browser-${id}`;
    const session = new BrowserSession({
      headless: true,
      isolated: true,
      ...this.options.sessionOptions,
      runId,
      browserCodeStateSessionId: id,
    });
    try {
      await raceWithAbort(session.start(), abortSignal);
      if (inputValue.url) {
        const result = await session.open(inputValue.url, { abortSignal });
        if (!result.ok) {
          await session.close({ force: true }).catch(() => undefined);
          return browserResult(id, result);
        }
      }
      const managed: ManagedBrowserSession = {
        runId,
        session,
        stepIndex: 0,
        queue: Promise.resolve(),
        closing: false,
      };
      this.#sessions.set(id, managed);
      this.#armIdleTimer(id, managed);
      return {
        ok: true,
        summary: inputValue.url
          ? `Opened browser session ${id} at ${inputValue.url}.`
          : `Opened browser session ${id}.`,
        data: {
          browserSessionId: id,
          url: session.currentUrl(),
        },
      };
    } catch (error) {
      await session.close({ force: true }).catch(() => undefined);
      return {
        ok: false,
        error: {
          code: 'browser-open-failed',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      this.#openingSessions -= 1;
    }
  }

  async code(
    inputValue: z.infer<typeof codeParser>,
    abortSignal?: AbortSignal,
  ): Promise<CapabilityResult> {
    return this.#enqueue(inputValue.browserSessionId, async (managed) => {
      managed.stepIndex += 1;
      return browserResult(inputValue.browserSessionId, await managed.session.executeBrowserCode({
        code: inputValue.code,
        maxOutputChars: inputValue.maxOutputChars,
        runId: managed.runId,
        stepIndex: managed.stepIndex,
        abortSignal,
      }));
    });
  }

  snapshot(
    inputValue: z.infer<typeof snapshotParser>,
    abortSignal?: AbortSignal,
  ) {
    return this.#enqueue(inputValue.browserSessionId, async (managed) => browserResult(
      inputValue.browserSessionId,
      await managed.session.readBrowserState({
        ...inputValue,
        abortSignal,
        maxOutputChars: inputValue.maxOutputChars,
      }),
    ));
  }

  async close(id: string): Promise<CapabilityResult> {
    const managed = this.#sessions.get(id);
    if (!managed || managed.closing) return this.#missing(id);
    managed.closing = true;
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    managed.idleTimer = undefined;
    await managed.queue;
    if (this.#sessions.get(id) === managed) this.#sessions.delete(id);
    await managed.session.close({ force: true });
    return {
      ok: true,
      summary: `Closed browser session ${id}.`,
      data: { browserSessionId: id, closed: true },
    };
  }

  async dispose() {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    for (const managed of sessions) {
      managed.closing = true;
      if (managed.idleTimer) clearTimeout(managed.idleTimer);
      managed.idleTimer = undefined;
    }
    await Promise.allSettled(sessions.map(async (managed) => {
      await managed.queue;
      await managed.session.close({ force: true });
    }));
  }

  #enqueue(
    id: string,
    operation: (managed: ManagedBrowserSession) => Promise<CapabilityResult>,
  ): Promise<CapabilityResult> {
    const managed = this.#sessions.get(id);
    if (!managed || managed.closing) return Promise.resolve(this.#missing(id));
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    managed.idleTimer = undefined;
    const scheduled = managed.queue.then(() => operation(managed));
    const tail = scheduled.then(() => undefined, () => undefined);
    managed.queue = tail;
    void tail.then(() => {
      if (managed.queue === tail && !managed.closing && this.#sessions.get(id) === managed) {
        this.#armIdleTimer(id, managed);
      }
    });
    return scheduled;
  }

  #armIdleTimer(id: string, managed: ManagedBrowserSession) {
    if (!this.#idleTimeoutMs || managed.closing || this.#sessions.get(id) !== managed) return;
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    managed.idleTimer = setTimeout(() => {
      managed.idleTimer = undefined;
      void this.close(id).catch(() => undefined);
    }, this.#idleTimeoutMs);
    managed.idleTimer.unref?.();
  }

  #missing(id: string): CapabilityResult {
    return {
      ok: false,
      error: {
        code: 'browser-session-not-found',
        message: `Browser session ${id} does not exist or is already closed. Call browser.open first.`,
      },
    };
  }
}

export type BrowserMcpOptions = {
  context?: CapabilityMcpServerOptions['context'];
  configurations?: CapabilityMcpServerOptions['configurations'];
  configStore?: CapabilityMcpServerOptions['configStore'];
  configScope?: CapabilityMcpServerOptions['configScope'];
  skillMode?: CapabilityMcpServerOptions['skillMode'];
  skillToolName?: CapabilityMcpServerOptions['skillToolName'];
  maxSessions?: number;
  idleTimeoutMs?: number;
  sessionOptions?: BrowserSessionOptions | ((context: CapabilityRunContext) => BrowserSessionOptions | Promise<BrowserSessionOptions>);
};

export function createBrowserMcpCapability(options: BrowserMcpOptions = {}): CapabilityProvider {
  const runtimeSkill = {
    id: 'com.webpilot.browser.mcp/runtime',
    title: 'Explicit browser sessions',
    summary: '<system_skill><id>com.webpilot.browser.mcp/runtime</id><title>Explicit browser sessions</title><required>true</required></system_skill>',
    required: true,
    content: 'Call browser.open first. Pass its exact browserSessionId to browser.code, browser.snapshot, and browser.close. Do not invent or reuse closed session ids.',
  } as const;
  return {
    manifest: {
      schemaVersion: 1,
      id: 'com.webpilot.browser.mcp',
      name: 'Browser MCP sessions',
      version: '0.1.0',
      description: 'Explicit, isolated Playwright browser sessions for MCP clients.',
      permissions: ['browser:launch', 'browser:cdp', 'network:access', 'artifact:write'],
      runtimeRequirements: { node: '>=22.16', playwright: '>=1.60' },
      skills: [runtimeSkill],
    },
    async createRuntime(context) {
      const sessionOptions = typeof options.sessionOptions === 'function'
        ? await options.sessionOptions(context)
        : options.sessionOptions;
      const manager = new BrowserMcpSessionManager({
        maxSessions: options.maxSessions,
        idleTimeoutMs: options.idleTimeoutMs,
        sessionOptions: {
          ...sessionOptions,
          configuration: {
            ...context.configuration,
            ...sessionOptions?.configuration,
          },
        },
      });
      return {
        tools: {
          open: defineCapabilityTool({
            name: 'browser.open',
            description: 'Open a new persistent browser session and return its explicit browserSessionId.',
            input: input(openParser),
            execute: (value, execution) => manager.open(value, execution.abortSignal),
          }),
          code: defineCapabilityTool({
            name: 'browser.code',
            description: 'Execute a bounded JavaScript cell in an explicitly selected browser session.',
            input: input(codeParser),
            execute: (value, execution) => manager.code(value, execution.abortSignal),
          }),
          snapshot: defineCapabilityTool({
            name: 'browser.snapshot',
            description: 'Read tabs, active page metadata, and DOM state from an explicitly selected browser session.',
            input: input(snapshotParser),
            execute: (value, execution) => manager.snapshot(value, execution.abortSignal),
          }),
          close: defineCapabilityTool({
            name: 'browser.close',
            description: 'Close an explicitly selected browser session and release its resources.',
            input: input(closeParser),
            execute: (value) => manager.close(value.browserSessionId),
          }),
        },
        health: async () => ({ status: 'healthy' as const }),
        dispose: () => manager.dispose(),
      };
    },
  };
}

function serverOptions(options: BrowserMcpOptions): CapabilityMcpServerOptions {
  return {
    name: 'webpilot-browser',
    version: '0.1.0',
    context: options.context,
    configurations: options.configurations,
    configStore: options.configStore,
    configScope: options.configScope,
    skillMode: options.skillMode,
    skillToolName: options.skillToolName,
    providers: [createBrowserMcpCapability(options)],
  };
}

export function createBrowserMcpServer(options: BrowserMcpOptions = {}) {
  return createCapabilityMcpServer(serverOptions(options));
}

export function createBrowserMcpHandler(options: BrowserMcpOptions = {}) {
  return createCapabilityMcpHandler(serverOptions(options));
}

export function serveBrowserMcpStdio(options: BrowserMcpOptions = {}) {
  return serveCapabilityMcpStdio(serverOptions(options));
}
