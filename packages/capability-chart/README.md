# @webpilot/capability-chart

An agent-framework-neutral ECharts and Three.js capability.

The filesystem store caches its directory index and retains the latest 20 revision files plus the immutable original. Set `retainedRevisions` on the Node factory to change this limit (1–1000). Revision publication remains atomic, and stale edits are rejected. The React renderer reuses the ECharts instance for data updates; switching renderers or rebuilding Three.js geometry recreates the surface.

- `@webpilot/capability-chart` exports the portable capability, schemas, records, and store contracts.
- `@webpilot/capability-chart/node` exports the filesystem-backed Node store.
- `@webpilot/capability-chart/react` exports the renderer without Orbit API or session dependencies.
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

The React renderer includes fullscreen, PNG/JSON/CSV downloads, SVG export for
SVG-rendered ECharts, and table/JSON data editing in an accessible modal. Its compact
toolbar, icons, menus, dialog, focus handling, and styles are all bundled here;
the React entry point imports no Orbit application code, Next.js, session
state, API URLs, or application CSS. It makes no HTTP requests. Supply
`onSave(nextRecord, expectedRevision)` and optionally `onReload()` to connect
persistence; without `onSave`, edits apply only to the current page. Orbit
supplies both callbacks through its session-owned GET/PATCH chart endpoint.

JSON mode loads a local CodeMirror 6 editor on demand, with a dark theme, syntax
highlighting, line numbers, folding, undo/redo, indentation and JSON diagnostics.
Its editor dependencies belong to this package; no application editor or remote
worker is required. The selected editing mode has an explicit check mark and
highlight. Confirm is always visible: unchanged data closes the dialog, while
modified data is validated and saved through `onSave`.

Other React applications can pass their own `ChartRecord` and persistence callbacks:

```tsx
import { ChartRenderer } from '@webpilot/capability-chart/react';

<ChartRenderer
  chart={record}
  onSave={(next, expectedRevision) => myChartStore.save(next, expectedRevision)}
  onReload={() => myChartStore.read(record.chartId)}
/>
```

ECharts, React and Three.js are peer libraries; the capability tool contract uses
the framework-neutral capability SDK. Neither requires the Orbit application.

`chart` supports `api`, `create`, `read`, and `update`. Read before updating and
pass the returned `revision` as `expectedRevision`. The Node store preserves the
original JSON and atomically publishes immutable revision files, rejecting stale
writes. Existing version-2 chart files remain readable and editable.

ECharts formatters accept JSON string templates, such as `{b}: {c}`, rather than
strings containing JavaScript functions. Create/update validates these fields and
reports the offending path. When reading or rendering older records, function-source
formatters are omitted in memory so ECharts uses its default formatting; the original
artifact is preserved and no callback source is executed. Ordinary templates remain
unchanged. For waterfall charts, set `tooltip: { show: false }` on spacer series.

Set `engine: 'three'` to create native `bar3D`, `scatter3D`, `line3D`, or `surface3D`
charts. Points use `[x, y, z]` with z as height; surfaces additionally require a
row-major `grid: { rows, columns }`. Read `chart({ action: 'api', query: 'three',
reason: 'Read 3D schema' })` for the full schema. The optional Three.js peer is
required by React consumers; it loads only when displaying 3D. WebGL2 is required.
Simple ECharts bar/line/scatter options also offer a non-persistent 3D preview.
