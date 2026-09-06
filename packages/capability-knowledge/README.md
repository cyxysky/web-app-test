# @webpilot/capability-knowledge

Durable document ingestion and retrieval for agents. The Node adapter uses SQLite transactions and a persistent FTS5 chunk index with Chinese bigram tokenization. Writers in separate local processes can share the same directory. Vector or hybrid stores can implement the same core contract.

On first open, `knowledge.json` is imported once into `knowledge.db`; the original JSON is preserved. Subsequent writes use SQLite. Keep the database and its WAL files together during backup, and call `dispose()` on directly created stores before removing their directory. Use Node 22.16 or later.

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
