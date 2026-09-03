import { z } from 'zod';
import {
  defineCapabilityInput,
  defineCapabilityTool,
  normalizeBoundedInteger,
  type CapabilityExecutionContext,
  type CapabilityHealth,
  type CapabilityManifest,
  type CapabilityProvider,
  type CapabilityResult,
  type CapabilityRunContext,
} from '@webpilot/capability-sdk';
import { codeSandboxRuntimeSkill } from './runtime-skill.js';
import { codeSandboxCapabilitySettings } from './settings.js';
export * from './runtime-skill.js';
export * from './settings.js';

export const codeSandboxCapabilityToolNames = Object.freeze({ codeSandbox: 'codeSandbox' } as const);
export type CodeSandboxLanguage = 'javascript' | 'python';
export type CodeSandboxExecution = {
  language: CodeSandboxLanguage;
  code: string;
  args: string[];
  timeoutMs: number;
  maxOutputChars: number;
};
export type CodeSandboxExecutionResult = {
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
  elapsedMs: number;
};
export interface CodeSandboxExecutor {
  run(input: CodeSandboxExecution, context: CapabilityExecutionContext): Promise<CodeSandboxExecutionResult>;
  health?(): Promise<CapabilityHealth>;
  dispose?(): Promise<void>;
}

const parser = z.object({
  action: z.literal('run'),
  reason: z.string().trim().min(1).max(300),
  language: z.enum(['javascript', 'python']),
  code: z.string().min(1).max(100_000),
  args: z.array(z.string().max(2_000)).max(32).optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
}).strict();
export type CodeSandboxToolInput = z.infer<typeof parser>;
export const codeSandboxToolInput = defineCapabilityInput<CodeSandboxToolInput>(
  z.toJSONSchema(parser) as Readonly<Record<string, unknown>>,
  (value) => parser.parse(value),
);

export const codeSandboxCapabilityManifest = Object.freeze({
  schemaVersion: 1,
  id: 'com.webpilot.code-sandbox',
  name: 'Code Sandbox',
  version: '0.1.0',
  description: 'Run bounded JavaScript and Python computations in a host-selected execution backend.',
  permissions: ['process:execute', 'workspace:temporary'],
  runtimeRequirements: { node: '>=22.16' },
  configuration: { settings: codeSandboxCapabilitySettings },
  skills: [codeSandboxRuntimeSkill],
} satisfies CapabilityManifest);

export function createCodeSandboxTool(executor: CodeSandboxExecutor, configuration: CapabilityRunContext['configuration']) {
  return defineCapabilityTool<CodeSandboxToolInput, CodeSandboxExecutionResult>({
    name: codeSandboxCapabilityToolNames.codeSandbox,
    description: 'Run one bounded JavaScript or Python computation in the configured sandbox workspace. This is for computation and transformation, not browser automation or durable file delivery.',
    input: codeSandboxToolInput,
    policy: { concurrency: 'parallel', concurrencyGroup: 'code-sandbox', permissions: codeSandboxCapabilityManifest.permissions },
    async execute(input, context): Promise<CapabilityResult<CodeSandboxExecutionResult>> {
      if (configuration.AGENT_CODE_SANDBOX_ENABLED !== 'true') {
        return { ok: false, error: { code: 'code-sandbox-disabled', message: 'Code Sandbox is disabled by host configuration.' } };
      }
      try {
        const result = await executor.run({
          language: input.language,
          code: input.code,
          args: input.args || [],
          timeoutMs: input.timeoutMs ?? normalizeBoundedInteger(configuration.AGENT_CODE_SANDBOX_TIMEOUT_MS, 30_000, 1_000, 300_000),
          maxOutputChars: normalizeBoundedInteger(configuration.AGENT_CODE_SANDBOX_MAX_OUTPUT_CHARS, 30_000, 1_000, 200_000),
        }, context);
        return result.exitCode === 0
          ? { ok: true, summary: `${input.language} computation completed.`, data: result }
          : {
            ok: false,
            summary: `${input.language} computation failed.`,
            error: {
              code: 'code-execution-failed',
              message: [
                result.exitCode === null
                  ? `Process terminated${result.signal ? ` by signal ${result.signal}` : ' without an exit code'}.`
                  : `Process exited with code ${result.exitCode}.`,
                result.stderr.trim(),
              ].filter(Boolean).join('\n'),
              details: result,
            },
          };
      } catch (error) {
        return { ok: false, error: { code: 'code-execution-error', message: error instanceof Error ? error.message : String(error), retryable: false } };
      }
    },
  });
}

export function createCodeSandboxCapability(options: { createExecutor(context: CapabilityRunContext): CodeSandboxExecutor | Promise<CodeSandboxExecutor> }): CapabilityProvider {
  return {
    manifest: codeSandboxCapabilityManifest,
    async createRuntime(context) {
      const executor = await options.createExecutor(context);
      return {
        tools: Object.freeze({ [codeSandboxCapabilityToolNames.codeSandbox]: createCodeSandboxTool(executor, context.configuration) }),
        health: () => executor.health?.() || Promise.resolve({ status: context.configuration.AGENT_CODE_SANDBOX_ENABLED === 'true' ? 'healthy' : 'degraded', message: context.configuration.AGENT_CODE_SANDBOX_ENABLED === 'true' ? undefined : 'Disabled by configuration.' }),
        dispose: () => executor.dispose?.() || Promise.resolve(),
      };
    },
  };
}
