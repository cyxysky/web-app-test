import type { CapabilitySkill } from '@webpilot/capability-sdk';

/** Complete model-facing operating manual for the Chart Capability workflow. */
export const chartRuntimeSkillId = 'system-chart-runtime';

export const chartRuntimeSkillSummary = [
  '<system_skill>',
  `<id>${chartRuntimeSkillId}</id>`,
  '<title>Apache ECharts Runtime</title>',
  '<description>Hidden built-in operating manual for reading modular ECharts API guidance, creating inline charts, and placing chart identifiers in final replies.</description>',
  '<required>true</required>',
  '</system_skill>',
].join('\n');

export const chartRuntimeSkillContent = `# Apache ECharts Runtime

This Skill is authoritative for the chart model tool and is supplied by the chart package. The consuming Agent is responsible for loading it and deciding when the chart tool becomes available.

## Required workflow

1. When a visual chart materially improves the answer, explicitly read this Skill and wait for that read to succeed before calling chart.
2. Before creating a chart, call chart with action \`api\` and no query to read the compact API module index.
3. Call action \`api\` again with the exact module id needed for the requested chart. Read more than one module when the design combines series, coordinates, datasets, maps, or interactions.
4. Call action \`create\` with one complete JSON-serializable Apache ECharts \`option\`. The renderer imports the full \`echarts\` package, so no series whitelist is imposed.
5. Read the successful result and copy its exact chartId into a \`finalResponse\` chart block at the intended response position.
6. Never invent an identifier and never reference one after a failed call. The standalone \`chart_000001\` text-line renderer remains available, but structured Agent replies must use chart blocks.

The renderer recognizes only a standalone identifier with the exact form \`chart_000001\`. Ordinary mentions and identifiers inside code remain text.

## Supported ECharts surface

The complete ECharts 6.1 package is loaded. Standard built-in series include \`line\`, \`bar\`, \`pie\`, \`scatter\`, \`effectScatter\`, \`radar\`, \`tree\`, \`treemap\`, \`sunburst\`, \`boxplot\`, \`candlestick\`, \`heatmap\`, \`map\`, \`parallel\`, \`lines\`, \`graph\`, \`sankey\`, \`funnel\`, \`gauge\`, \`pictorialBar\`, \`themeRiver\`, \`chord\`, and \`custom\`. Mixed charts use multiple series items in one option.

All standard coordinate systems and JSON option components are available, including grid/cartesian, polar, radar, geo, parallel, singleAxis, calendar, matrix, dataset, transforms, visualMap, dataZoom, timeline, brush, title, legend, tooltip, toolbox, graphic, interaction states, transitions, and animations.

Every \`lines\` series must declare its coordinate system and include the matching top-level components: \`cartesian2d\` requires \`xAxis\` and \`yAxis\`; \`geo\` requires \`geo\`; \`polar\` requires \`polar\`, \`radiusAxis\`, and \`angleAxis\`; \`calendar\` requires \`calendar\`; and \`matrix\` requires \`matrix\`. Omitting \`coordinateSystem\` makes ECharts assume \`geo\`, so never omit it.

Map charts may pass \`maps\`; each map is registered before \`setOption\`. The \`geoJson\` value may be a GeoJSON object or SVG XML string.

Tool arguments are JSON. ECharts features that specifically require executable JavaScript callbacks—such as function formatters, arbitrary \`custom.renderItem\`, external event handlers, or third-party series registration—cannot be embedded in the persisted option. Use string templates and built-in JSON options when available. This is an executable-callback boundary, not a chart-type whitelist.

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
  option: Record<string, unknown>; // Complete ECharts option.
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

declare function chart(input: ChartApiInput | ChartCreateInput): Promise<{
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
  title: 'Apache ECharts Runtime',
  summary: chartRuntimeSkillSummary,
  content: chartRuntimeSkillContent,
  required: true,
  activation: [{ toolName: 'chart' }],
} satisfies CapabilitySkill);
