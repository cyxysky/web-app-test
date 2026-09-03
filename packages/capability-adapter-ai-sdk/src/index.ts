import { jsonSchema, tool, type ToolExecutionOptions, type ToolSet } from 'ai';
import {
  mountCapabilities,
  type CapabilitySkillInstructionMode,
  type MountedCapabilities,
  type MountCapabilitiesOptions,
} from '@webpilot/capability-host';
import {
  capabilitySkillReadJsonSchema,
  type CapabilityExecutionContext,
  type CapabilityRunSnapshot,
  type ResolvedCapabilityTool,
} from '@webpilot/capability-sdk';

export {
  EnvironmentCapabilityConfigStore,
  MemoryCapabilityConfigStore,
  createCapabilityConfigStore,
  createSplitCapabilityConfigStore,
  type CapabilityConfigScope,
  type CapabilityConfigStore,
} from '@webpilot/capability-host';

export type AISDKCapabilityInvocation = {
  resolvedTool: ResolvedCapabilityTool;
  input: unknown;
  context: CapabilityExecutionContext;
  execution: ToolExecutionOptions<unknown>;
  invoke(): Promise<unknown>;
};

export type AISDKCapabilitySkillOptions = {
  mode?: CapabilitySkillInstructionMode;
  toolName?: string;
  includeTool?: boolean;
  loadedSkillIds?: Set<string>;
};

export type AISDKCapabilityAdapterOptions = {
  metadata?: Readonly<Record<string, unknown>>;
  execute?: (invocation: AISDKCapabilityInvocation) => Promise<unknown>;
  skills?: AISDKCapabilitySkillOptions;
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

function createSkillTool(
  snapshot: CapabilityRunSnapshot,
  loadedSkillIds: Set<string>,
) {
  const byId = new Map(snapshot.skills.map((skill) => [skill.id, skill]));
  return tool({
    description: `Read one Capability Skill by exact id. Available ids: ${snapshot.skills.map((skill) => skill.id).join(', ')}.`,
    inputSchema: jsonSchema(capabilitySkillReadJsonSchema(snapshot.skills.map((skill) => skill.id)), {
      validate(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return { success: false as const, error: new Error('Skill input must be an object.') };
        }
        const input = value as Record<string, unknown>;
        const skillId = typeof input.skillId === 'string' ? input.skillId.trim() : '';
        if (input.action !== 'read' || !byId.has(skillId)) {
          return { success: false as const, error: new Error(`Unknown Capability Skill: ${skillId || '(empty)'}.`) };
        }
        return {
          success: true as const,
          value: {
            action: 'read' as const,
            skillId,
            reason: typeof input.reason === 'string' ? input.reason : undefined,
          },
        };
      },
    }),
    execute: async (input) => {
      const skill = byId.get(input.skillId)!;
      loadedSkillIds.add(skill.id);
      return {
        ok: true,
        summary: `Capability Skill ${skill.id} loaded.`,
        loadedRuntimeSkill: {
          id: skill.id,
          title: skill.title,
          content: skill.content,
        },
      };
    },
  });
}

export function toAISDKToolSet(
  snapshot: CapabilityRunSnapshot | MountedCapabilities,
  options: AISDKCapabilityAdapterOptions = {},
): ToolSet {
  const skillMode = options.skills?.mode || 'disabled';
  const loadedSkillIds = options.skills?.loadedSkillIds || new Set<string>();
  const entries: Array<readonly [string, ToolSet[string]]> = Object.entries(snapshot.tools).map(([publicName, resolvedTool]) => [
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
  ] as const);

  if (skillMode === 'lazy' && snapshot.skills.length && options.skills?.includeTool !== false) {
    const toolName = options.skills?.toolName || 'skill';
    if (entries.some(([name]) => name === toolName)) {
      throw new Error(`Capability Skill tool name collides with an existing tool: ${toolName}.`);
    }
    entries.push([toolName, createSkillTool(snapshot, loadedSkillIds)]);
  }
  return Object.fromEntries(entries);
}

export type MountAISDKCapabilitiesOptions = MountCapabilitiesOptions & {
  instructions?: string;
  adapter?: Omit<AISDKCapabilityAdapterOptions, 'skills'>;
  skills?: AISDKCapabilitySkillOptions;
};

export type MountedAISDKCapabilities = Omit<MountedCapabilities, 'tools'> & {
  tools: ToolSet;
  instructions: string;
  agentOptions: {
    tools: ToolSet;
    instructions: string;
  };
  snapshot: MountedCapabilities;
};

/** One-call Capability mounting for AI SDK ToolLoopAgent and streamText. */
export async function mountAISDKCapabilities(
  options: MountAISDKCapabilitiesOptions,
): Promise<MountedAISDKCapabilities> {
  const mounted = await mountCapabilities(options);
  const skills = { ...options.skills, mode: options.skills?.mode || 'lazy' };
  try {
    const tools = toAISDKToolSet(mounted, { ...options.adapter, skills });
    const capabilityInstructions = mounted.skillCatalog.instructions(skills.mode, {
      skillToolName: skills.toolName,
    });
    const instructions = [options.instructions, capabilityInstructions]
      .map((value) => value?.trim())
      .filter(Boolean)
      .join('\n\n');
    return Object.freeze({
      manifests: mounted.manifests,
      skills: mounted.skills,
      configurations: mounted.configurations,
      skillCatalog: mounted.skillCatalog,
      tools,
      instructions,
      agentOptions: Object.freeze({ tools, instructions }),
      snapshot: mounted,
      dispose: mounted.dispose,
    });
  } catch (error) {
    await mounted.dispose();
    throw error;
  }
}
