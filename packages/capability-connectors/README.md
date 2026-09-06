# @webpilot/capability-connectors

Provider-neutral discovery and invocation of external operations. The Node entrypoint includes an MCP Streamable HTTP client and an OpenAPI operation adapter. Authentication headers belong to host configuration and are never accepted from model tool input.

## TypeScript Agent framework integration

```ts
import {
  createMcpStreamableHttpConnector,
  createNodeConnectorsCapability,
} from '@webpilot/capability-connectors/node';

const provider = createNodeConnectorsCapability({
  connectors: [createMcpStreamableHttpConnector({
    id: 'business-system',
    url: process.env.BUSINESS_MCP_URL!,
    headers: { authorization: `Bearer ${process.env.BUSINESS_MCP_TOKEN!}` },
  })],
});
```

Register this provider with `mountCapabilities()` and expose the resolved
`connectors` tool through the consuming TypeScript Agent framework. Inject the
package Skill so the model discovers connector operations before invoking one.
See the complete
[TypeScript Agent framework integration guide](../capability-sdk/FRAMEWORK_INTEGRATION.md).

The MCP HTTP connector matches JSON-RPC response ids, reads multi-line SSE frames incrementally, follows bounded tool pagination and caches listings for 60 seconds. Disposal aborts active requests and closes the remote session. MCP `isError` results remain failures. OpenAPI operation paths preserve the base URL path prefix.
