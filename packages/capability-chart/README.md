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

The included `webpilot-chart-mcp` executable stores each MCP run below
`CAPABILITY_CHART_ARTIFACTS_DIR` (or `ARTIFACTS_DIR`).
