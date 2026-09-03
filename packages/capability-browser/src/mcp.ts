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
  type CapabilityProvider,
  type CapabilityResult,
  type CapabilityRunContext,
} from '@webpilot/capability-sdk';
import { z } from 'zod';
import { readBrowserStateCode } from './node/capability.js';
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
};

export type BrowserMcpSessionManagerOptions = {
  maxSessions?: number;
  sessionOptions?: BrowserSessionOptions;
};

function parsedActual(actual: string): unknown {
  try {
    return JSON.parse(actual) as unknown;
  } catch {
    return actual;
  }
}

function browserResult(
  id: string,
  result: BrowserActionResult,
): CapabilityResult {
  const data = {
    browserSessionId: id,
    result: parsedActual(result.actual),
  };
  return result.ok
    ? { ok: true, summary: result.actual, data }
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
  #openingSessions = 0;

  constructor(private readonly options: BrowserMcpSessionManagerOptions = {}) {
    this.#maxSessions = Math.max(1, Math.min(100, Math.floor(options.maxSessions || 8)));
  }

  async open(inputValue: z.infer<typeof openParser>): Promise<CapabilityResult> {
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
      await session.start();
      if (inputValue.url) {
        const result = await session.open(inputValue.url);
        if (!result.ok) {
          await session.close({ force: true }).catch(() => undefined);
          return browserResult(id, result);
        }
      }
      this.#sessions.set(id, { runId, session, stepIndex: 0 });
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
    const managed = this.#sessions.get(inputValue.browserSessionId);
    if (!managed) return this.#missing(inputValue.browserSessionId);
    managed.stepIndex += 1;
    return browserResult(inputValue.browserSessionId, await managed.session.executeBrowserCode({
      code: inputValue.code,
      maxOutputChars: inputValue.maxOutputChars,
      runId: managed.runId,
      stepIndex: managed.stepIndex,
      abortSignal,
    }));
  }

  snapshot(
    inputValue: z.infer<typeof snapshotParser>,
    abortSignal?: AbortSignal,
  ) {
    return this.code({
      browserSessionId: inputValue.browserSessionId,
      code: readBrowserStateCode,
      maxOutputChars: inputValue.maxOutputChars,
    }, abortSignal);
  }

  async close(id: string): Promise<CapabilityResult> {
    const managed = this.#sessions.get(id);
    if (!managed) return this.#missing(id);
    this.#sessions.delete(id);
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
    await Promise.allSettled(sessions.map(({ session }) => session.close({ force: true })));
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
        sessionOptions,
      });
      return {
        tools: {
          open: defineCapabilityTool({
            name: 'browser.open',
            description: 'Open a new persistent browser session and return its explicit browserSessionId.',
            input: input(openParser),
            execute: (value) => manager.open(value),
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
