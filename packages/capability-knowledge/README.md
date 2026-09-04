# @webpilot/capability-knowledge

Durable document ingestion and retrieval for agents. The core uses a storage contract; the Node adapter provides a JSON-backed lexical store suitable for local deployments. Vector or hybrid stores can implement the same contract without changing the Agent tool.

## TypeScript Agent framework integration

```ts
import { createNodeKnowledgeCapability } from '@webpilot/capability-knowledge/node';

const provider = createNodeKnowledgeCapability({
  directory: './agent-data/knowledge',
});
```

Register this provider with `mountCapabilities()` and expose the resolved
`knowledge` tool through the consuming TypeScript Agent framework. Inject the
package Skill before ingestion or retrieval. A host-specific vector or hybrid
store can instead be supplied through the root `createKnowledgeCapability()`
factory. See the complete
[TypeScript Agent framework integration guide](../capability-sdk/FRAMEWORK_INTEGRATION.md).
