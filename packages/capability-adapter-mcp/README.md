# @webpilot/capability-adapter-mcp

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
