import { jsonSchema, tool, type ToolExecutionOptions, type ToolSet } from 'ai';
import type {
  CapabilityExecutionContext,
  CapabilityRunSnapshot,
  ResolvedCapabilityTool,
} from '@webpilot/capability-sdk';

export type AISDKCapabilityInvocation = {
  resolvedTool: ResolvedCapabilityTool;
  input: unknown;
  context: CapabilityExecutionContext;
  execution: ToolExecutionOptions<unknown>;
  invoke(): Promise<unknown>;
};

export type AISDKCapabilityAdapterOptions = {
  metadata?: Readonly<Record<string, unknown>>;
  execute?: (invocation: AISDKCapabilityInvocation) => Promise<unknown>;
};

function inputSchema(resolvedTool: ResolvedCapabilityTool) {
  return jsonSchema(resolvedTool.tool.input.jsonSchema as Parameters<typeof jsonSchema>[0], {
    validate(value) {
      try {
        return { success: true as const, value: resolvedTool.tool.input.parse(value) };
      } catch (error) {
        return {
          success: false as const,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    },
  });
}

export function toAISDKToolSet(
  snapshot: CapabilityRunSnapshot,
  options: AISDKCapabilityAdapterOptions = {},
): ToolSet {
  return Object.fromEntries(Object.entries(snapshot.tools).map(([publicName, resolvedTool]) => [
    publicName,
    tool({
      description: resolvedTool.tool.description,
      inputSchema: inputSchema(resolvedTool),
      inputExamples: resolvedTool.tool.inputExamples?.map((input) => ({ input })),
      execute: async (input, execution) => {
        const context: CapabilityExecutionContext = {
          invocationId: execution.toolCallId,
          abortSignal: execution.abortSignal,
          metadata: options.metadata,
        };
        const invoke = () => resolvedTool.tool.execute(input, context);
        return options.execute
          ? options.execute({ resolvedTool, input, context, execution, invoke })
          : invoke();
      },
    }),
  ]));
}
