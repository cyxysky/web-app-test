# @webpilot/capability-workflow

Durable dependency-aware workflow records and checkpoints for long-running agents. The Node adapter uses per-workspace SQLite transactions across local processes. It imports `workflows.json` once into `workflows.db` and preserves the original JSON.

Completed, failed and cancelled steps are terminal. Repeating an identical checkpoint is idempotent; changing a terminal step or workflow is rejected. Create a new workflow to retry failed work. Dependencies must be completed before starting or completing a dependent step. Dispose directly created stores when finished.

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
