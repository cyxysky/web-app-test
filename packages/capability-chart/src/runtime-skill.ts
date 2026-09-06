import type { CapabilitySkill } from '@webpilot/capability-sdk';

/** Complete model-facing operating manual for the Chart Capability workflow. */
export const chartRuntimeSkillId = 'system-chart-runtime';

export const chartRuntimeSkillSummary = [
  '<system_skill>',
  `<id>${chartRuntimeSkillId}</id>`,
  '<title>ECharts and Three.js Chart Runtime</title>',
  '<description>Operating manual for creating, reading and updating persistent 2D/3D charts with fullscreen, downloads and manual data editing.</description>',
  '<required>true</required>',
  '</system_skill>',
].join('\n');

export const chartRuntimeSkillContent = `# ECharts and Three.js Chart Runtime

This Skill is authoritative for the chart model tool and is supplied by the chart package. The consuming Agent is responsible for loading it and deciding when the chart tool becomes available.

## Required workflow

1. When a visual chart materially improves the answer, explicitly read this Skill and wait for that read to succeed before calling chart.
2. Before creating a chart, call chart with action \`api\` and no query to read the compact API module index.
3. Call action \`api\` again with the exact module id needed for the requested chart. Read more than one module when the design combines series, coordinates, datasets, maps, or interactions.
4. Call action \`create\` with one complete JSON-serializable \`option\`. For 2D, engine defaults to \`echarts\` and loads the full ECharts package. For native 3D, read module \`three\`, set engine to \`three\`, and follow its separate data schema.
5. Read the successful result and copy its exact chartId into a \`finalResponse\` chart block at the intended response position.
6. Never invent an identifier and never reference one after a failed call. The standalone \`chart_000001\` text-line renderer remains available, but structured Agent replies must use chart blocks.

The renderer recognizes only a standalone identifier with the exact form \`chart_000001\`. Ordinary mentions and identifiers inside code remain text.

## Supported ECharts surface

The complete ECharts 6.1 package is loaded. Standard built-in series include \`line\`, \`bar\`, \`pie\`, \`scatter\`, \`effectScatter\`, \`radar\`, \`tree\`, \`treemap\`, \`sunburst\`, \`boxplot\`, \`candlestick\`, \`heatmap\`, \`map\`, \`parallel\`, \`lines\`, \`graph\`, \`sankey\`, \`funnel\`, \`gauge\`, \`pictorialBar\`, \`themeRiver\`, \`chord\`, and \`custom\`. Mixed charts use multiple series items in one option.

All standard coordinate systems and JSON option components are available, including grid/cartesian, polar, radar, geo, parallel, singleAxis, calendar, matrix, dataset, transforms, visualMap, dataZoom, timeline, brush, title, legend, tooltip, toolbox, graphic, interaction states, transitions, and animations.

Every \`lines\` series must declare its coordinate system and include the matching top-level components: \`cartesian2d\` requires \`xAxis\` and \`yAxis\`; \`geo\` requires \`geo\`; \`polar\` requires \`polar\`, \`radiusAxis\`, and \`angleAxis\`; \`calendar\` requires \`calendar\`; and \`matrix\` requires \`matrix\`. Omitting \`coordinateSystem\` makes ECharts assume \`geo\`, so never omit it.

Map charts may pass \`maps\`; each map is registered before \`setOption\`. The \`geoJson\` value may be a GeoJSON object or SVG XML string.

Tool arguments are JSON. ECharts features that specifically require executable JavaScript callbacks—such as function formatters, arbitrary \`custom.renderItem\`, external event handlers, or third-party series registration—cannot be embedded in the persisted option. Use string templates and built-in JSON options when available. This is an executable-callback boundary, not a chart-type whitelist.

Never put \`"function(params){...}"\` or \`"(params) => ..."\` strings into \`formatter\` or \`valueFormatter\`. ECharts treats formatter strings as text templates, not JavaScript, and chart create/update rejects function source with its exact option path. For tooltips prefer \`{ trigger: "axis" }\` (default formatting) or a template such as \`"{b}: {c}"\`; indexed templates such as \`"{b0}<br/>{a0}: {c0}<br/>{a1}: {c1}"\` support fixed multiple series. A waterfall's invisible spacer series should use \`tooltip: { show: false }\` so its offset is not reported as business data.

## Editing, export and 3D

Each rendered chart provides fullscreen, PNG and JSON downloads, CSV downloads for data arrays, and manual data editing through a table or complete option JSON. SVG-rendered ECharts additionally supports SVG downloads. In Orbit, saving persists to the original chart ID; refreshes and later tool reads see the saved version. Standalone React hosts must supply onSave to persist edits.

Before modifying an existing chart, call action \`read\` with its chartId. Use the returned chart.option and revision, preserve unrelated settings and user edits, then call action \`update\` with the complete option and expectedRevision. On chart-revision-conflict, read again and merge; do not blindly retry with a newer revision. A failed update leaves the saved chart unchanged.

Three.js supports \`bar3D\`, \`scatter3D\`, \`line3D\` and \`surface3D\`. Each point is [x,y,z], with z representing height. Surface data is row-major and requires grid.rows × grid.columns to equal the point count. Read module \`three\` for complete limits and examples. The viewport supports rotation, zoom, pan and PNG export. Simple 2D bar/line/scatter charts offer a temporary view toggle labeled "3D 视图" / "2D 视图"; complex coordinate encodings remain in their original 2D form. Data editing opens a modal with table and JSON modes. Native 3D requires WebGL2.

## API signature

\`\`\`ts
type ChartApiInput = {
  action: "api";
  reason: string;
  query?: string;  // Omit for the index; otherwise use one exact module id.
  offset?: number;
  limit?: number;
};

type ChartCreateInput = {
  action: "create";
  reason: string;
  engine?: "echarts" | "three";
  option: Record<string, unknown>; // Complete option for the selected engine.
  title?: string;
  description?: string;
  height?: number;                // 240..720, default 380.
  renderer?: "canvas" | "svg";  // default canvas.
  maps?: Array<{
    name: string;
    geoJson: Record<string, unknown> | string;
    specialAreas?: Record<string, unknown>;
  }>;
};

type ChartReadInput = { action: "read"; reason: string; chartId: string };
type ChartUpdateInput = Omit<ChartCreateInput, "action"> & { action: "update"; chartId: string; expectedRevision: number };

declare function chart(input: ChartApiInput | ChartCreateInput | ChartReadInput | ChartUpdateInput): Promise<{
  ok: boolean;
  actual: string;
  failureCategory?: string;
}>;
\`\`\`

## API examples

Read the API module index:

\`\`\`js
chart({
  action: "api",
  reason: "查看 ECharts API 模块索引"
})
\`\`\`

Read an exact module returned by the index:

\`\`\`js
chart({
  action: "api",
  reason: "读取直角坐标系列配置说明",
  query: "series.cartesian"
})
\`\`\`

Create a mixed bar and line chart:

\`\`\`js
chart({
  action: "create",
  reason: "同时展示销售额和同比增速",
  title: "销售额与同比增速",
  height: 380,
  renderer: "canvas",
  option: {
    tooltip: { trigger: "axis" },
    legend: { data: ["销售额", "同比增速"] },
    grid: { left: 48, right: 48, bottom: 36, containLabel: true },
    xAxis: { type: "category", data: ["Q1", "Q2", "Q3", "Q4"] },
    yAxis: [
      { type: "value", name: "万元" },
      { type: "value", name: "%" }
    ],
    series: [
      { name: "销售额", type: "bar", data: [320, 410, 465, 530] },
      { name: "同比增速", type: "line", yAxisIndex: 1, smooth: true, data: [8, 12, 10, 15] }
    ]
  }
})
\`\`\`

Create a registered map chart:

\`\`\`js
chart({
  action: "create",
  reason: "展示区域指标分布",
  title: "区域指标分布",
  maps: [{
    name: "sales-region",
    geoJson: {
      type: "FeatureCollection",
      features: []
    }
  }],
  option: {
    visualMap: { min: 0, max: 100, calculable: true },
    series: [{
      type: "map",
      map: "sales-region",
      data: [{ name: "A 区", value: 82 }]
    }]
  }
})
\`\`\`

After a successful call returns \`chart_000001\`, place it in the final response like this:

\`\`\`js
finalResponse({
  status: "passed",
  blocks: [
    { type: "markdown", text: "下面是销售额与同比增速的对比：" },
    { type: "chart", chartId: "chart_000001", title: "销售额与同比增速" },
    { type: "markdown", text: "第四季度两项指标同时达到全年最高点。" }
  ]
})
\`\`\`
`;

export const chartCapabilityRuntimeSkill = Object.freeze({
  id: chartRuntimeSkillId,
  title: 'ECharts and Three.js Chart Runtime',
  summary: chartRuntimeSkillSummary,
  content: chartRuntimeSkillContent,
  required: true,
  activation: [{ toolName: 'chart' }],
} satisfies CapabilitySkill);
