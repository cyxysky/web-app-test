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
  CapabilityRegistry,
  type CapabilityContent,
  type CapabilityProvider,
  type CapabilityResult,
  type CapabilityRunContext,
} from '@webpilot/capability-sdk';

export type CapabilityMcpServerOptions = {
  providers: readonly CapabilityProvider[];
  name?: string;
  version?: string;
  instructions?: string;
  context?: Partial<CapabilityRunContext> | (() => Partial<CapabilityRunContext>);
};

function resolvedContext(options: CapabilityMcpServerOptions): CapabilityRunContext {
  const configured = typeof options.context === 'function' ? options.context() : options.context;
  return {
    runId: configured?.runId || `mcp-${randomUUID()}`,
    sessionId: configured?.sessionId,
    userId: configured?.userId,
    abortSignal: configured?.abortSignal,
    metadata: configured?.metadata,
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
  const registry = new CapabilityRegistry();
  for (const provider of options.providers) registry.register(provider);
  const runContext = resolvedContext(options);
  const snapshot = await registry.resolve({ context: runContext });
  const instructions = options.instructions || snapshot.instructions
    .map((instruction) => `${instruction.title}\n${instruction.content}`)
    .join('\n\n');
  try {
    const server = new McpServer({
      name: options.name || 'webpilot-capabilities',
      version: options.version || '0.1.0',
    }, instructions ? { instructions } : undefined);

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
