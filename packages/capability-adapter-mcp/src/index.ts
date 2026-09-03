import { randomUUID } from 'node:crypto';
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  type CallToolResult,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import {
  capabilitySkillReadJsonSchema,
  type CapabilityContent,
  type CapabilityProvider,
  type CapabilityResult,
  type CapabilityRunContext,
} from '@webpilot/capability-sdk';
import {
  mountCapabilities,
  type CapabilityConfigScope,
  type CapabilityConfigStore,
  type CapabilitySkillInstructionMode,
} from '@webpilot/capability-host';

export type CapabilityMcpServerOptions = {
  providers: readonly CapabilityProvider[];
  name?: string;
  version?: string;
  instructions?: string;
  context?: Partial<CapabilityRunContext> | (() => Partial<CapabilityRunContext>);
  configurations?: Readonly<Record<string, CapabilityRunContext['configuration']>>;
  configStore?: CapabilityConfigStore;
  configScope?: CapabilityConfigScope;
  skillMode?: CapabilitySkillInstructionMode;
  skillToolName?: string;
};

function resolvedContext(options: CapabilityMcpServerOptions): CapabilityRunContext {
  const configured = typeof options.context === 'function' ? options.context() : options.context;
  return {
    runId: configured?.runId || `mcp-${randomUUID()}`,
    sessionId: configured?.sessionId,
    userId: configured?.userId,
    abortSignal: configured?.abortSignal,
    metadata: configured?.metadata,
    configuration: configured?.configuration || {},
  };
}

function mcpContent(content: CapabilityContent): CallToolResult['content'][number] {
  if (content.type === 'text') return content;
  if (content.type === 'artifact' && content.downloadUrl) {
    return {
      type: 'resource_link',
      name: content.artifactId,
      uri: content.downloadUrl,
      mimeType: content.mediaType,
    };
  }
  return {
    type: 'text',
    text: JSON.stringify(content),
  };
}

export function capabilityResultToMcpResult(result: CapabilityResult): CallToolResult {
  if (!result.ok) {
    return {
      isError: true,
      content: [{ type: 'text', text: result.error.message }],
      structuredContent: {
        ok: false,
        error: result.error,
      },
    };
  }
  const content = result.content?.map(mcpContent) || [];
  if (!content.some((item) => item.type === 'text')) {
    content.unshift({ type: 'text', text: result.summary });
  }
  return {
    content,
    structuredContent: {
      ok: true,
      summary: result.summary,
      ...(result.data === undefined ? {} : { data: result.data }),
      ...(result.content?.length ? { capabilityContent: result.content } : {}),
    },
  };
}

export async function createCapabilityMcpServer(
  options: CapabilityMcpServerOptions,
) {
  const runContext = resolvedContext(options);
  const snapshot = await mountCapabilities({
    providers: options.providers,
    context: runContext,
    configurations: options.configurations,
    configStore: options.configStore,
    configScope: options.configScope,
  });
  const skillMode = options.skillMode || 'eager';
  const skillToolName = options.skillToolName || 'skill';
  const skillInstructions = snapshot.skillCatalog.instructions(skillMode, { skillToolName });
  const instructions = [options.instructions, skillInstructions]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join('\n\n');
  try {
    const server = new McpServer({
      name: options.name || 'webpilot-capabilities',
      version: options.version || '0.1.0',
    }, instructions ? { instructions } : undefined);

    if (skillMode === 'lazy' && snapshot.skills.length) {
      if (snapshot.tools[skillToolName]) {
        throw new Error(`Capability Skill tool name collides with an existing tool: ${skillToolName}.`);
      }
      server.registerTool(skillToolName, {
        title: 'Read Capability Skill',
        description: `Read one Capability Skill by exact id. Available ids: ${snapshot.skills.map((skill) => skill.id).join(', ')}.`,
        inputSchema: fromJsonSchema(capabilitySkillReadJsonSchema(snapshot.skills.map((skill) => skill.id))),
        _meta: {
          'com.webpilot/capabilitySkillTool': true,
        },
      }, async (input: unknown) => {
        const value = input && typeof input === 'object' && !Array.isArray(input)
          ? input as Record<string, unknown>
          : {};
        const skillId = typeof value.skillId === 'string' ? value.skillId.trim() : '';
        const skill = value.action === 'read' ? snapshot.skillCatalog.get(skillId) : undefined;
        if (!skill) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Unknown Capability Skill: ${skillId || '(empty)'}.` }],
          };
        }
        return {
          content: [{ type: 'text', text: skill.content }],
          structuredContent: {
            ok: true,
            loadedRuntimeSkill: {
              id: skill.id,
              title: skill.title,
              content: skill.content,
            },
          },
        };
      });
    }

    for (const [publicName, resolved] of Object.entries(snapshot.tools)) {
      server.registerTool(publicName, {
        title: resolved.tool.name,
        description: resolved.tool.description,
        inputSchema: fromJsonSchema(resolved.tool.input.jsonSchema),
        _meta: {
          'com.webpilot/capabilityId': resolved.capabilityId,
          'com.webpilot/capabilityVersion': resolved.capabilityVersion,
          'com.webpilot/internalToolId': resolved.internalId,
        },
      }, async (input: unknown, context) => {
        try {
          const parsed = resolved.tool.input.parse(input);
          const abortSignal = runContext.abortSignal
            ? AbortSignal.any([runContext.abortSignal, context.mcpReq.signal])
            : context.mcpReq.signal;
          const result = await resolved.tool.execute(parsed, {
            invocationId: randomUUID(),
            abortSignal,
            metadata: {
              transport: context.http ? 'streamable-http' : 'stdio',
            },
          });
          return capabilityResultToMcpResult(result);
        } catch (error) {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: error instanceof Error ? error.message : String(error),
            }],
          };
        }
      });
    }

    const close = server.close.bind(server);
    let disposed = false;
    server.close = async () => {
      if (disposed) return;
      disposed = true;
      await Promise.allSettled([snapshot.dispose(), close()]);
    };
    return server;
  } catch (error) {
    await snapshot.dispose();
    throw error;
  }
}

export function createCapabilityMcpHandler(options: CapabilityMcpServerOptions): McpHttpHandler {
  return createMcpHandler(() => createCapabilityMcpServer(options));
}

export function serveCapabilityMcpStdio(options: CapabilityMcpServerOptions): StdioServerHandle {
  return serveStdio(() => createCapabilityMcpServer(options));
}
