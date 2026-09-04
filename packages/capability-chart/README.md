# @webpilot/capability-chart

An agent-framework-neutral Apache ECharts capability.

- `@webpilot/capability-chart` exports the portable capability, schemas, records, and store contracts.
- `@webpilot/capability-chart/node` exports the filesystem-backed Node store.
- `@webpilot/capability-chart/react` exports the renderer without WebPilot API or session dependencies.
- `@webpilot/capability-chart/mcp` exports stdio and Streamable HTTP MCP entrypoints.

```ts
import { createNodeChartCapability } from '@webpilot/capability-chart/node';

const provider = createNodeChartCapability({ directory: './artifacts/charts' });
```

Pass this provider to the framework-neutral `mountCapabilities()` entrypoint,
map the resolved `chart` tool to the consuming TypeScript Agent framework, and
inject the package Skill before chart execution. See the complete
[TypeScript Agent framework integration guide](../capability-sdk/FRAMEWORK_INTEGRATION.md).

`mountAISDKCapabilities()` remains available as the optional AI SDK convenience
path. Its returned `agentOptions` contains the chart tool and eager/lazy Skill
instructions; settings are loaded before the chart runtime is created.

The included `webpilot-chart-mcp` executable stores each MCP run below
`CAPABILITY_CHART_ARTIFACTS_DIR` (or `ARTIFACTS_DIR`).
