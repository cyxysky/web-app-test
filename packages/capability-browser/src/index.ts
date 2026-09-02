import { z } from 'zod';
import {
  defineCapabilityInput,
  defineCapabilityTool,
  type CapabilityExecutionContext,
  type CapabilityInstruction,
  type CapabilityManifest,
  type CapabilityProvider,
  type CapabilityResult,
  type CapabilityRunContext,
  type CapabilityToolSet,
} from '@webpilot/capability-sdk';

export * from './output-settings.js';
export * from './runtime-skill.js';
export * from './session-group.js';

const reason = z.string().trim().min(1).max(300);

const readBrowserStateParser = z.object({
  action: z.literal('state'),
  reason,
}).strict();
const browserCodeParser = z.object({
  action: z.literal('code'),
  reason,
  code: z.string().min(1).max(40_000),
  maxOutputChars: z.number().int().min(1_000).optional(),
}).strict();
const waitForHumanVerificationParser = z.object({
  action: z.literal('waitForHumanVerification'),
  reason,
  maxMs: z.number().int().positive().optional(),
}).strict();
const browserParser = z.discriminatedUnion('action', [
  readBrowserStateParser,
  browserCodeParser,
  waitForHumanVerificationParser,
]);

export type ReadBrowserStateInput = z.infer<typeof readBrowserStateParser>;
export type BrowserCodeInput = z.infer<typeof browserCodeParser>;
export type WaitForHumanVerificationInput = z.infer<typeof waitForHumanVerificationParser>;
export type BrowserToolInput = z.infer<typeof browserParser>;

export const browserCapabilityToolNames = Object.freeze({
  browser: 'browser',
} as const);

export const browserCapabilityActions = Object.freeze({
  state: 'state',
  code: 'code',
  waitForHumanVerification: 'waitForHumanVerification',
} as const);

export const browserToolInput = defineCapabilityInput(
  z.toJSONSchema(browserParser) as Readonly<Record<string, unknown>>,
  (value): BrowserToolInput => browserParser.parse(value),
);

export type BrowserOperationResult = {
  ok: boolean;
  actual: string;
  failureCategory?: string;
  referenceImagePath?: string;
  referenceImagePaths?: string[];
  [key: string]: unknown;
};

export type BrowserOperationEnvelope = {
  runtime: 'webpilot.browser-operation';
  result: BrowserOperationResult;
};

export function browserOperationToCapabilityResult(
  result: BrowserOperationResult,
): CapabilityResult<BrowserOperationEnvelope> {
  const envelope: BrowserOperationEnvelope = {
    runtime: 'webpilot.browser-operation',
    result,
  };
  if (!result.ok) {
    return {
      ok: false,
      error: {
        code: result.failureCategory || 'browser-operation-failed',
        message: result.actual,
        details: envelope,
      },
    };
  }
  return { ok: true, summary: result.actual, data: envelope };
}

export function browserOperationFromCapabilityResult(
  result: CapabilityResult,
): BrowserOperationResult {
  const value = result.ok ? result.data : result.error.details;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const envelope = value as Partial<BrowserOperationEnvelope>;
    if (envelope.runtime === 'webpilot.browser-operation' && envelope.result) return envelope.result;
  }
  return result.ok
    ? { ok: true, actual: result.summary }
    : { ok: false, actual: result.error.message, failureCategory: result.error.code };
}

export type BrowserCapabilityOperations = {
  readBrowserState(
    input: ReadBrowserStateInput,
    context: CapabilityExecutionContext,
  ): Promise<CapabilityResult>;
  browserCode(
    input: BrowserCodeInput,
    context: CapabilityExecutionContext,
  ): Promise<CapabilityResult>;
  waitForHumanVerification(
    input: WaitForHumanVerificationInput,
    context: CapabilityExecutionContext,
  ): Promise<CapabilityResult>;
  health?(): Promise<import('@webpilot/capability-sdk').CapabilityHealth>;
  dispose?(): Promise<void>;
};

export const browserCapabilityManifest = Object.freeze({
  schemaVersion: 1,
  id: 'com.webpilot.browser',
  name: 'Browser',
  version: '0.1.0',
  description: 'Persistent Playwright browser sessions, code execution, snapshots, and visual evidence.',
  permissions: ['browser:launch', 'browser:cdp', 'network:access', 'artifact:write'],
  runtimeRequirements: { node: '>=22.16', playwright: '>=1.60' },
} satisfies CapabilityManifest);

export const browserRuntimeInstruction: CapabilityInstruction = {
  id: 'com.webpilot.browser/runtime',
  title: 'Browser runtime',
  required: true,
  content: 'Use browser action=code for bounded Playwright inspection and interaction. Use action=state before depending on live page state. Use action=waitForHumanVerification instead of solving CAPTCHA, OTP, QR, login, or device-owned challenges.',
};

export function createBrowserTools(operations: BrowserCapabilityOperations): CapabilityToolSet {
  return Object.freeze({
    [browserCapabilityToolNames.browser]: defineCapabilityTool<BrowserToolInput, unknown>({
      name: browserCapabilityToolNames.browser,
      description: 'Read browser state, execute one bounded JavaScript cell in the persistent Playwright session, or pause for human verification. Select exactly one operation with action.',
      input: browserToolInput,
      inputExamples: [
        { action: 'state', reason: 'Read the current browser state' },
        { action: 'code', reason: 'Read the current page URL and title', code: 'nodeRepl.write({ url: page.url(), title: await page.title() })' },
        { action: 'waitForHumanVerification', reason: 'Wait for the user to complete verification', maxMs: 180_000 },
      ],
      policy: {
        concurrency: 'serial',
        concurrencyGroup: 'browser',
        permissions: browserCapabilityManifest.permissions,
        runtimeInstructionId: browserRuntimeInstruction.id,
      },
      execute: (input, context) => {
        if (input.action === 'state') return operations.readBrowserState(input, context);
        if (input.action === 'code') return operations.browserCode(input, context);
        return operations.waitForHumanVerification(input, context);
      },
    }),
  });
}

export function createBrowserCapability(options: {
  createOperations(
    context: CapabilityRunContext,
  ): BrowserCapabilityOperations | Promise<BrowserCapabilityOperations>;
  instruction?: CapabilityInstruction | false;
}): CapabilityProvider {
  return {
    manifest: browserCapabilityManifest,
    async createRuntime(context) {
      const operations = await options.createOperations(context);
      return {
        tools: createBrowserTools(operations),
        instructions: options.instruction === false ? [] : [options.instruction || browserRuntimeInstruction],
        health: operations.health || (() => Promise.resolve({ status: 'healthy' })),
        dispose: operations.dispose || (() => Promise.resolve()),
      };
    },
  };
}
