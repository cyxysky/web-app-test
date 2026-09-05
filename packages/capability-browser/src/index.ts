import { z } from 'zod';
import {
  createCapabilityRuntime,
  defineCapabilityInput,
  defineCapabilityTool,
  type CapabilityExecutionContext,
  type CapabilityManifest,
  type CapabilityProvider,
  type CapabilityResult,
  type CapabilityRunContext,
  type CapabilityToolSet,
} from '@webpilot/capability-sdk';
import { browserCapabilitySettings } from './settings.js';
import { browserRuntimeSkill } from './runtime-skill.js';

export * from './output-settings.js';
export * from './runtime-skill.js';
export * from './settings.js';
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
  maxMs: z.number().int().min(1_000).max(30 * 60_000).optional(),
}).strict();
// Keep the provider-facing JSON Schema flat. Several OpenAI-compatible models
// treat the first `oneOf` branch as a default and then keep emitting `state`
// even when their reason describes a code/iframe operation. Runtime parsing
// below still validates the exact action-specific shape.
const browserParser = z.object({
  action: z.enum(['code', 'state', 'waitForHumanVerification']).describe(
    'Required operation. Use code for Playwright reads/interactions, including iframe or targeted DOM inspection. Use state only for the fixed top-level snapshot.',
  ),
  reason,
  code: z.string().min(1).max(40_000).optional().describe(
    'Required only when action=code. JavaScript executed in the persistent Playwright runtime.',
  ),
  maxOutputChars: z.number().int().min(1_000).optional().describe('Optional only when action=code.'),
  maxMs: z.number().int().min(1_000).max(30 * 60_000).optional().describe('Optional only when action=waitForHumanVerification.'),
}).strict();

/**
 * `action` is the browser tool's discriminant and therefore the authoritative
 * execution boundary. Models occasionally copy fields from a previous action;
 * prune those unrelated fields before the strict union parser sees them.
 */
export function normalizeBrowserToolInput(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  if (input.action === 'state') {
    return { action: 'state', reason: input.reason };
  }
  if (input.action === 'code') {
    return {
      action: 'code',
      reason: input.reason,
      code: input.code,
      ...(input.maxOutputChars !== undefined ? { maxOutputChars: input.maxOutputChars } : {}),
    };
  }
  if (input.action === 'waitForHumanVerification') {
    return {
      action: 'waitForHumanVerification',
      reason: input.reason,
      ...(input.maxMs !== undefined ? { maxMs: input.maxMs } : {}),
    };
  }
  return value;
}

export type ReadBrowserStateInput = z.infer<typeof readBrowserStateParser>;
export type BrowserCodeInput = z.infer<typeof browserCodeParser>;
export type WaitForHumanVerificationInput = z.infer<typeof waitForHumanVerificationParser>;
export type BrowserToolInput = ReadBrowserStateInput | BrowserCodeInput | WaitForHumanVerificationInput;

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
  (value): BrowserToolInput => {
    const normalized = browserParser.parse(normalizeBrowserToolInput(value));
    if (normalized.action === 'code') return browserCodeParser.parse(normalized);
    if (normalized.action === 'state') return readBrowserStateParser.parse(normalized);
    return waitForHumanVerificationParser.parse(normalized);
  },
);

export type BrowserOperationResult = {
  ok: boolean;
  actual: string;
  data?: unknown;
  summary?: string;
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
  return { ok: true, summary: result.summary || result.actual, data: envelope };
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
  configuration: { settings: browserCapabilitySettings },
  skills: [browserRuntimeSkill],
} satisfies CapabilityManifest);

export function createBrowserTools(operations: BrowserCapabilityOperations): CapabilityToolSet {
  return Object.freeze({
    [browserCapabilityToolNames.browser]: defineCapabilityTool<BrowserToolInput, unknown>({
      name: browserCapabilityToolNames.browser,
      description: 'Execute one bounded Playwright JavaScript cell, read a fresh fixed top-level browser snapshot, or pause for human verification. Use action=code for iframe/DOM inspection and interaction. The action field is authoritative and unrelated fields are discarded before validation.',
      input: browserToolInput,
      inputExamples: [
        { action: 'code', reason: 'Read the current page URL and title', code: 'nodeRepl.write({ url: page.url(), title: await page.title() })' },
        { action: 'state', reason: 'Read the current top-level browser state once' },
        { action: 'waitForHumanVerification', reason: 'Wait for the user to complete verification', maxMs: 180_000 },
      ],
      policy: {
        concurrency: 'serial',
        concurrencyGroup: 'browser',
        permissions: browserCapabilityManifest.permissions,
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
}): CapabilityProvider {
  return {
    manifest: browserCapabilityManifest,
    async createRuntime(context) {
      const operations = await options.createOperations(context);
      return createCapabilityRuntime({
        tools: createBrowserTools(operations),
        health: operations.health,
        dispose: operations.dispose,
      });
    },
  };
}
