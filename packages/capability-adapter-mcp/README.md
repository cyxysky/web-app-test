# @webpilot/capability-adapter-mcp

Expose Capability providers through MCP stdio or Streamable HTTP. Providers,
configuration storage, tool registration, Skill instructions, and disposal are
handled together.

```ts
await serveCapabilityMcpStdio({
  providers,
  configStore,
  configScope: { userId: 'agent-user' },
  skillMode: 'eager',
});
```

MCP defaults to eager Skill injection because server instructions are shared by
the connected client. `skillMode: 'lazy'` publishes summaries and registers a
`skill` tool for explicit full-content reads. Capability calls do not load or
gate Skills as a side effect; the connected Agent owns that policy. Use
`disabled` when the client owns all context injection.

Maps a `CapabilityProvider` or resolved capability snapshot to the official MCP
TypeScript server SDK. It supports stdio and Web-standard Streamable HTTP while
keeping capability execution, health, and disposal in the original package.

```ts
import {
  createCapabilityMcpHandler,
  serveCapabilityMcpStdio,
} from '@webpilot/capability-adapter-mcp';

const options = { providers: [myCapability] };
serveCapabilityMcpStdio(options);

// A Web-standard handler for remote Streamable HTTP deployments:
const handler = createCapabilityMcpHandler(options);
```

Capability JSON Schemas become MCP input schemas, AbortSignal is propagated to
the capability execution context, artifact URLs become resource links, and all
resolved runtimes are disposed when the MCP server closes.
