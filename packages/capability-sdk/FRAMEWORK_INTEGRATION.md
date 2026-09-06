# TypeScript Agent framework integration

Orbit Capability packages are framework-neutral. AI SDK and MCP are optional
adapters, not requirements. Any TypeScript Agent framework can consume a
Capability package when it can expose named tools with JSON Schema inputs and
invoke asynchronous TypeScript functions.

The integration boundary is:

```text
CapabilityProvider
  -> mountCapabilities()
  -> CapabilityRunSnapshot.tools
  -> framework-native tool objects
  -> Agent loop
```

The Agent framework owns the model, messages, loop, approvals, persistence, and
UI. Capability packages own their manifests, settings, Skills, input validation,
execution, results, health checks, and disposal.

## 1. Create providers

Install the framework-neutral host, SDK, and the concrete Capability packages
the application needs:

```sh
npm install @webpilot/capability-sdk @webpilot/capability-host \
  @webpilot/capability-browser @webpilot/capability-file
```

Each concrete package exports a `CapabilityProvider` factory. Node-specific
packages normally expose their ready-to-run factory from `/node`:

```ts
import type { CapabilityProvider } from '@webpilot/capability-sdk';
import { BrowserSession, createNodeBrowserCapability } from '@webpilot/capability-browser/node';
import { createNodeFileCapability } from '@webpilot/capability-file/node';

const browserSession = new BrowserSession({ headless: true, isolated: true });

const providers: CapabilityProvider[] = [
  createNodeBrowserCapability({
    createOptions: (context) => ({
      session: browserSession,
      runId: context.runId,
      ensureStarted: () => browserSession.start(),
      disposeSession: true,
    }),
  }),
  createNodeFileCapability({
    workspace: { artifactsRoot: './artifacts' },
    visualInputAvailable: false,
  }),
];
```

Use the root `create*Capability()` factory instead when the application supplies
its own database, browser, storage, network, media, or execution backend.

## 2. Mount one runtime snapshot

Mount providers before constructing the framework's Agent. A mounted runtime is
an immutable tool and Skill snapshot for one run or host-selected session:

```ts
import { EnvironmentCapabilityConfigStore, mountCapabilities } from '@webpilot/capability-host';

const capabilities = await mountCapabilities({
  providers,
  context: {
    runId: crypto.randomUUID(),
    userId: currentUser.id,
    abortSignal: request.signal,
  },
  configStore: new EnvironmentCapabilityConfigStore(process.env),
  enabledCapabilityIds: new Set([
    'com.webpilot.browser',
    'com.webpilot.file',
  ]),
});
```

Use `configScope` for tenant, user, workspace, or profile-specific settings.
Use `allowedToolNames` when an Agent should see only part of the mounted tool
set. Always call `capabilities.dispose()` when the run or owning session ends.

## 3. Convert tools to the framework's tool type

Every entry in `capabilities.tools` contains the same portable information:

| Capability field | Agent framework field |
| --- | --- |
| `publicName` | tool name |
| `tool.description` | model-facing tool description |
| `tool.input.jsonSchema` | input schema |
| `tool.inputExamples` | input examples, when supported |
| `tool.input.parse()` | authoritative runtime validation |
| `tool.execute()` | asynchronous tool implementation |
| `tool.policy` | permissions, concurrency, and prerequisites |

The following minimal adapter shape can be translated to the native tool type
of any TypeScript Agent framework:

```ts
import { randomUUID } from 'node:crypto';
import type { CapabilityRunSnapshot } from '@webpilot/capability-sdk';

type FrameworkToolCall = {
  id?: string;
  abortSignal?: AbortSignal;
  metadata?: Readonly<Record<string, unknown>>;
  onProgress?: (event: {
    phase: string;
    message: string;
    current?: number;
    total?: number;
    data?: unknown;
  }) => void | Promise<void>;
};

export function toFrameworkTools(snapshot: CapabilityRunSnapshot) {
  return Object.values(snapshot.tools).map((resolved) => ({
    name: resolved.publicName,
    description: resolved.tool.description,
    inputSchema: resolved.tool.input.jsonSchema,
    inputExamples: resolved.tool.inputExamples,
    execute: async (rawInput: unknown, call: FrameworkToolCall = {}) => {
      const input = resolved.tool.input.parse(rawInput);
      return resolved.tool.execute(input, {
        invocationId: call.id || randomUUID(),
        abortSignal: call.abortSignal,
        metadata: call.metadata,
        reportProgress: call.onProgress,
      });
    },
  }));
}
```

Do not replace `tool.input.parse()` with the Agent framework's validation. The
framework schema guides the model; the Capability parser remains the execution
boundary.

Production adapters must enforce `tool.policy` before calling `tool.execute()`:

- authorize every item in `policy.permissions`;
- serialize calls in the same `concurrencyGroup` when `concurrency` is `serial`;
- satisfy `policy.prerequisite` before execution;
- propagate cancellation and progress events;
- retain the complete structured `CapabilityResult` for logs and recovery.

If the framework accepts only text tool results, serialize the complete result
instead of returning only `summary`. `data`, `content`, `error.code`,
`error.retryable`, and `error.details` contain information required by hosts,
artifact renderers, and subsequent Agent steps.

## 4. Inject Capability Skills

README files explain integration to developers and coding Agents. Runtime
Agents should receive package-owned `CapabilitySkill` content from the mounted
Skill catalog.

For eager loading, append the generated instructions to the framework's system
or Agent instructions before the first model call:

```ts
const capabilityInstructions = capabilities.skillCatalog.instructions('eager');
const systemInstructions = [applicationInstructions, capabilityInstructions]
  .filter(Boolean)
  .join('\n\n');
```

For lazy loading:

1. expose a framework-native `skill` tool;
2. validate the requested id against `capabilities.skillCatalog.skills`;
3. return `capabilities.skillCatalog.get(skillId)`;
4. record loaded Skill ids for the current run;
5. enforce required Skill activation before exposing or executing related
   tools.

Capability packages publish Skill content but do not decide when an Agent has
read it. That lifecycle belongs to the consuming framework integration.

## 5. Run the Agent and dispose resources

The complete host lifecycle is:

```ts
const capabilities = await mountCapabilities(options);

try {
  const tools = toFrameworkTools(capabilities);
  const instructions = capabilities.skillCatalog.instructions('eager');

  const agent = createAgentWithYourFramework({ tools, instructions });
  return await agent.run(userInput);
} finally {
  await capabilities.dispose();
}
```

The model never registers packages. The host creates and mounts providers; the
model reads the supplied tool descriptions and Skills, produces valid tool
input, observes the complete result, and continues its Agent loop.

## 6. Adding a dedicated framework adapter

A reusable adapter for another TypeScript Agent framework should be a separate
package named `@webpilot/capability-adapter-<framework>`. It should depend on
`@webpilot/capability-sdk` and `@webpilot/capability-host` and only implement:

- tool-schema conversion;
- execution-context conversion;
- Skill injection or lazy Skill-tool registration;
- result/content conversion;
- cancellation, progress, policy, and disposal integration.

Framework adapters must not contain Browser, File, Data, or other business
Capability logic. The same `CapabilityProvider` must remain usable through a
custom Agent loop, a dedicated framework adapter, AI SDK, or MCP.

## Provider factory reference

| Package | Ready-to-register provider factory |
| --- | --- |
| `capability-browser` | `createNodeBrowserCapability()` from `/node` |
| `capability-chart` | `createNodeChartCapability()` from `/node` |
| `capability-file` | `createNodeFileCapability()` from `/node` |
| `capability-code-sandbox` | `createNodeCodeSandboxCapability()` from `/node` |
| `capability-research` | `createNodeResearchCapability()` from `/node` |
| `capability-connectors` | `createNodeConnectorsCapability()` from `/node` |
| `capability-knowledge` | `createNodeKnowledgeCapability()` from `/node` |
| `capability-data` | `createTypeOrmDataCapability()` from `/typeorm` |
| `capability-media` | `createMediaCapability()` with host-supplied operations |
| `capability-communication` | `createNodeCommunicationCapability()` from `/node` |
| `capability-git` | `createNodeGitCapability()` from `/node` |
| `capability-computer` | `createNodeComputerCapability()` from `/node` |
| `capability-workflow` | `createNodeWorkflowCapability()` from `/node` |

`capability-sensitive-data` is provider-call middleware rather than an Agent
tool. Wrap the final model provider boundary with its framework-neutral client,
or use `/ai-sdk` only when the consuming application is built on AI SDK.
