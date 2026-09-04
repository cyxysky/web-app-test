# @webpilot/capability-workflow

Durable dependency-aware workflow records and checkpoints for long-running agents. The core uses an injected store and the Node adapter provides a per-workspace JSON store with serialized writes.

## TypeScript Agent framework integration

```ts
import { createNodeWorkflowCapability } from '@webpilot/capability-workflow/node';

const provider = createNodeWorkflowCapability({
  directory: './agent-data/workflows',
});
```

Register this provider with `mountCapabilities()` and expose the resolved
`workflow` tool through the consuming TypeScript Agent framework. Inject the
package Skill so the model creates workflows only for durable multi-stage work
and checkpoints verified outcomes. See the complete
[TypeScript Agent framework integration guide](../capability-sdk/FRAMEWORK_INTEGRATION.md).
