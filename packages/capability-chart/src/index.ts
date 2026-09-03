import { z } from 'zod';
import {
  defineCapabilityInput,
  defineCapabilityTool,
  type CapabilityHealth,
  type CapabilityManifest,
  type CapabilityProvider,
  type CapabilityResult,
  type CapabilityRunContext,
} from '@webpilot/capability-sdk';
import {
  maxChartBytes,
  normalizeChartMaps,
  normalizeChartOption,
  type ChartOptionValidator,
  type ChartRecord,
  type CreateChartRecordInput,
} from './core.js';
import { chartCapabilitySettings } from './settings.js';
import { chartCapabilityRuntimeSkill } from './runtime-skill.js';
export * from './core.js';
export * from './runtime-skill.js';
export * from './settings.js';

export const chartCapabilityToolNames = Object.freeze({
  chart: 'chart',
} as const);

type EChartsApiModule = {
  examples: Array<Record<string, unknown>>;
  id: string;
  notes: string[];
  optionPaths: string[];
  summary: string;
  title: string;
};

export interface ChartArtifactStore {
  create(input: CreateChartRecordInput): Promise<ChartRecord>;
  read(chartId: string): Promise<ChartRecord | undefined>;
  health?(): Promise<CapabilityHealth>;
  dispose?(): Promise<void>;
}

const chartToolInputParser = z.object({
  action: z.enum(['api', 'create']).describe('api reads the indexed ECharts catalog; create persists one complete chart option.'),
  reason: z.string().trim().min(1).max(300).describe('Concise reason for this tool call.'),
  query: z.string().trim().min(1).max(120).optional().describe('For action=api: omit for the index or pass an exact module id returned by the index.'),
  offset: z.number().int().min(0).optional().describe('For action=api index pagination.'),
  limit: z.number().int().min(1).max(50).optional().describe('For action=api index pagination.'),
  title: z.string().trim().min(1).max(200).optional().describe('Accessible title rendered with the chart.'),
  description: z.string().trim().min(1).max(1_000).optional().describe('Accessible plain-language chart summary.'),
  height: z.number().int().min(240).max(720).optional().describe('Rendered height in pixels. Defaults to 380.'),
  renderer: z.enum(['canvas', 'svg']).optional().describe('ECharts renderer. Defaults to canvas.'),
  option: z.record(z.string(), z.unknown()).optional().describe('For action=create: complete JSON-serializable ECharts option.'),
  maps: z.array(z.object({
    name: z.string().trim().min(1).max(160),
    geoJson: z.union([z.record(z.string(), z.unknown()), z.string().min(1)]),
    specialAreas: z.record(z.string(), z.unknown()).optional(),
  })).max(12).optional().describe('Optional GeoJSON or SVG maps registered before rendering.'),
}).strict().superRefine((input, context) => {
  if (input.action === 'create' && !input.option) {
    context.addIssue({ code: 'custom', message: 'action=create requires option.', path: ['option'] });
  }
});

export type ChartToolInput = z.infer<typeof chartToolInputParser>;

export const chartToolInput = defineCapabilityInput<ChartToolInput>(
  z.toJSONSchema(chartToolInputParser) as Readonly<Record<string, unknown>>,
  (value) => chartToolInputParser.parse(value),
);

export const chartCapabilityManifest = Object.freeze({
  schemaVersion: 1,
  id: 'com.webpilot.chart',
  name: 'Chart',
  version: '0.1.0',
  description: 'Create and render persistent Apache ECharts resources.',
  permissions: ['artifact:read', 'artifact:write', 'renderer:chart'],
  runtimeRequirements: {
    node: '>=22.16',
  },
  configuration: { settings: chartCapabilitySettings },
  skills: [chartCapabilityRuntimeSkill],
} satisfies CapabilityManifest);

function seriesApiModule(
  type: string,
  title: string,
  summary: string,
  example: Record<string, unknown>,
  notes: string[] = [],
  optionPaths: string[] = [],
): EChartsApiModule {
  return {
    examples: [example],
    id: `series.${type}`,
    notes: [`在 option.series[] 中设置 type: "${type}"。`, ...notes],
    optionPaths: [`series-${type}`, ...optionPaths],
    summary,
    title,
  };
}

const seriesApiModules: EChartsApiModule[] = [
  seriesApiModule('line', '折线图', '折线、面积、堆叠、阶梯、平滑和多轴趋势图。', { xAxis: { type: 'category', data: ['一月', '二月', '三月'] }, yAxis: {}, series: [{ type: 'line', smooth: true, areaStyle: {}, data: [120, 138, 151] }] }, ['areaStyle 创建面积图；stack 创建堆叠图；step 创建阶梯线。'], ['xAxis', 'yAxis', 'grid']),
  seriesApiModule('bar', '柱状图', '纵向/横向、分组、堆叠、瀑布和大数据柱状图。', { xAxis: { type: 'category', data: ['A', 'B', 'C'] }, yAxis: {}, series: [{ type: 'bar', data: [23, 41, 35] }] }, ['横向柱状图交换 category/value 轴；相同 stack 值创建堆叠。'], ['xAxis', 'yAxis', 'grid']),
  seriesApiModule('pie', '饼图与环形图', '饼图、环形图与南丁格尔玫瑰图。', { tooltip: { trigger: 'item' }, series: [{ type: 'pie', radius: ['42%', '70%'], data: [{ name: 'A', value: 46 }, { name: 'B', value: 31 }, { name: 'C', value: 23 }] }] }, ['radius 数组创建环形图；roseType 创建玫瑰图。']),
  seriesApiModule('scatter', '散点图', '二维散点、气泡、抖动散点和多维视觉编码。', { xAxis: {}, yAxis: {}, series: [{ type: 'scatter', symbolSize: 14, data: [[10, 20], [15, 28], [22, 19]] }] }, ['symbolSize 可以是数值；函数式 symbolSize 不可通过 JSON 传递。'], ['visualMap']),
  seriesApiModule('effectScatter', '涟漪散点图', '带涟漪动画的重点散点，可用于直角、极坐标或地理坐标。', { xAxis: {}, yAxis: {}, series: [{ type: 'effectScatter', rippleEffect: { scale: 4 }, data: [[10, 20], [15, 28]] }] }, [], ['visualMap', 'geo']),
  seriesApiModule('radar', '雷达图', '多指标能力、评分或对比雷达图。', { radar: { indicator: [{ name: '质量', max: 100 }, { name: '速度', max: 100 }, { name: '服务', max: 100 }] }, series: [{ type: 'radar', data: [{ name: '方案 A', value: [88, 76, 91] }] }] }, ['radar.indicator 定义每个维度。'], ['radar']),
  seriesApiModule('tree', '树图', '正交、径向、折叠与可漫游的层级树。', { series: [{ type: 'tree', orient: 'LR', data: [{ name: '根节点', children: [{ name: '子节点 A' }, { name: '子节点 B' }] }] }] }, ['数据使用递归 children；layout 可为 orthogonal 或 radial。']),
  seriesApiModule('treemap', '矩形树图', '按面积和颜色展示层级数据。', { series: [{ type: 'treemap', data: [{ name: '产品', value: 100, children: [{ name: '硬件', value: 42 }, { name: '软件', value: 58 }] }] }] }, ['节点使用 value 与递归 children；levels 定义逐层样式。']),
  seriesApiModule('sunburst', '旭日图', '用同心圆展示多层占比和层级关系。', { series: [{ type: 'sunburst', radius: ['10%', '90%'], data: [{ name: '产品', children: [{ name: '硬件', value: 42 }, { name: '软件', value: 58 }] }] }] }, ['节点使用 value 与递归 children。']),
  seriesApiModule('boxplot', '箱线图', '展示分布、四分位数和异常值。', { xAxis: { type: 'category', data: ['A', 'B'] }, yAxis: {}, series: [{ type: 'boxplot', data: [[5, 20, 30, 42, 55], [8, 18, 29, 38, 49]] }] }, ['单项顺序通常是 [min, Q1, median, Q3, max]。'], ['xAxis', 'yAxis']),
  seriesApiModule('candlestick', 'K 线图', '股票、期货等开高低收金融数据。', { xAxis: { type: 'category', data: ['周一', '周二'] }, yAxis: {}, series: [{ type: 'candlestick', data: [[20, 34, 10, 38], [40, 35, 30, 50]] }] }, ['单项顺序为 [open, close, lowest, highest]。'], ['xAxis', 'yAxis', 'dataZoom']),
  seriesApiModule('heatmap', '热力图', '直角坐标、日历和地理热力图。', { xAxis: { type: 'category', data: ['周一', '周二'] }, yAxis: { type: 'category', data: ['上午', '下午'] }, visualMap: { min: 0, max: 10 }, series: [{ type: 'heatmap', data: [[0, 0, 5], [1, 0, 8], [0, 1, 7], [1, 1, 4]] }] }, ['通常配合 visualMap 映射颜色。'], ['visualMap', 'calendar', 'geo']),
  seriesApiModule('map', '地图', 'GeoJSON/SVG 区域分布图与多地图组合。', { maps: [{ name: 'region', geoJson: { type: 'FeatureCollection', features: [] } }], option: { visualMap: { min: 0, max: 100 }, series: [{ type: 'map', map: 'region', data: [{ name: 'A 区', value: 82 }] }] } }, ['action=create 的 maps 注册地图；series.map 必须与 maps[].name 一致。'], ['geo', 'visualMap']),
  seriesApiModule('parallel', '平行坐标图', '比较多维记录与聚类分布。', { parallelAxis: [{ dim: 0, name: '价格' }, { dim: 1, name: '销量' }, { dim: 2, name: '评分' }], series: [{ type: 'parallel', data: [[19, 84, 4.6], [25, 61, 4.2]] }] }, ['parallelAxis.dim 对应数据数组维度。'], ['parallel', 'parallelAxis']),
  seriesApiModule('lines', '路径与迁徙线', '直角或地理坐标上的路线、流向和轨迹。', { xAxis: {}, yAxis: {}, series: [{ type: 'lines', coordinateSystem: 'cartesian2d', data: [{ coords: [[0, 0], [8, 12], [16, 7]] }] }] }, ['必须显式声明 coordinateSystem 并配置对应坐标组件；cartesian2d 需要 xAxis/yAxis，geo 需要 geo。'], ['geo']),
  seriesApiModule('graph', '关系图', '力导向、环形或固定布局的节点关系网络。', { series: [{ type: 'graph', layout: 'force', roam: true, data: [{ name: 'A' }, { name: 'B' }], links: [{ source: 'A', target: 'B' }] }] }, ['data/nodes 定义节点，links/edges 定义关系；layout 可为 none、circular、force。']),
  seriesApiModule('sankey', '桑基图', '展示节点之间的数量流动。', { series: [{ type: 'sankey', data: [{ name: '访问' }, { name: '注册' }, { name: '购买' }], links: [{ source: '访问', target: '注册', value: 60 }, { source: '注册', target: '购买', value: 25 }] }] }, ['连接使用 source、target、value。']),
  seriesApiModule('funnel', '漏斗图', '展示流程转化、排序和阶段差异。', { series: [{ type: 'funnel', sort: 'descending', data: [{ name: '访问', value: 100 }, { name: '注册', value: 58 }, { name: '购买', value: 24 }] }] }, ['sort、gap、minSize、maxSize 控制布局。']),
  seriesApiModule('gauge', '仪表盘', '单值、多指针、进度环与分段仪表。', { series: [{ type: 'gauge', progress: { show: true }, detail: { formatter: '{value}%' }, data: [{ name: '完成率', value: 72 }] }] }, ['axisLine、progress、pointer、detail 控制外观。']),
  seriesApiModule('pictorialBar', '象形柱图', '用符号重复、裁剪或堆叠表达数量。', { xAxis: { data: ['A', 'B', 'C'] }, yAxis: {}, series: [{ type: 'pictorialBar', symbol: 'roundRect', symbolRepeat: true, symbolSize: [14, 8], data: [12, 18, 9] }] }, ['symbol、symbolRepeat、symbolClip 控制象形效果。'], ['xAxis', 'yAxis']),
  seriesApiModule('themeRiver', '主题河流图', '展示多个主题随时间变化的流量。', { singleAxis: { type: 'time' }, series: [{ type: 'themeRiver', data: [['2026/01/01', 10, 'A'], ['2026/02/01', 18, 'A'], ['2026/01/01', 7, 'B'], ['2026/02/01', 12, 'B']] }] }, ['单项数据为 [time, value, name]。'], ['singleAxis']),
  seriesApiModule('chord', '弦图', 'ECharts 6.1 内置的关系与流量弦图。', { series: [{ type: 'chord', data: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], links: [{ source: 'A', target: 'B', value: 8 }, { source: 'B', target: 'C', value: 5 }] }] }, ['使用节点 data 与 links 表达连接。']),
  seriesApiModule('custom', '自定义系列', 'ECharts 自定义渲染系列。', { graphic: [{ type: 'rect', left: 'center', top: 'middle', shape: { width: 180, height: 70 }, style: { fill: '#2563eb' } }] }, ['custom.renderItem 是 JavaScript 函数，不能通过 JSON 工具参数安全传递；静态自定义图形使用 graphic。'], ['graphic']),
];

const apiModules: EChartsApiModule[] = [
  ...seriesApiModules,
  {
    id: 'option.core',
    title: '顶层配置与通用样式',
    summary: '顶层 option、动画、调色板、文本、状态、响应式 media 与无障碍配置。',
    optionPaths: ['backgroundColor', 'color', 'textStyle', 'animation', 'animationDuration', 'animationEasing', 'stateAnimation', 'aria', 'media'],
    notes: [
      'action=create 接收完整 ECharts option，并原样交给 setOption。',
      '所有值必须可 JSON 序列化；不能传 JavaScript 函数、回调或 DOM 对象。',
      'series 可以混合任意多个 ECharts 内置系列，不需要声明一个顶层图表类型。',
    ],
    examples: [{ backgroundColor: 'transparent', color: ['#2563eb', '#0d9488', '#f59e0b'], animationDuration: 700, aria: { enabled: true } }],
  },
  {
    id: 'series.cartesian',
    title: '直角坐标系列',
    summary: 'line、bar、scatter、effectScatter、pictorialBar，以及同一坐标系内的混合图。',
    optionPaths: ['series-line', 'series-bar', 'series-scatter', 'series-effectScatter', 'series-pictorialBar', 'grid', 'xAxis', 'yAxis'],
    notes: [
      '横向柱状图使用 category yAxis 与 value xAxis。',
      '折线面积图使用 areaStyle；堆叠使用相同 stack；阶梯线使用 step。',
      'effectScatter 使用 rippleEffect；pictorialBar 使用 symbol 与 symbolRepeat。',
    ],
    examples: [{ tooltip: { trigger: 'axis' }, legend: {}, xAxis: { type: 'category', data: ['Q1', 'Q2', 'Q3', 'Q4'] }, yAxis: [{ type: 'value' }, { type: 'value' }], series: [{ name: '销售额', type: 'bar', data: [320, 410, 465, 530] }, { name: '同比', type: 'line', yAxisIndex: 1, smooth: true, data: [8, 12, 10, 15] }] }],
  },
  {
    id: 'series.pie-funnel-gauge',
    title: '占比、漏斗与仪表盘',
    summary: 'pie、funnel、gauge；环形、玫瑰、进度仪表与多指针仪表均由系列 option 控制。',
    optionPaths: ['series-pie', 'series-funnel', 'series-gauge'],
    notes: ['环形图使用 pie.radius: [内半径, 外半径]；南丁格尔玫瑰图使用 roseType。', 'funnel 可配置 sort、gap、minSize、maxSize。', 'gauge 的 axisLine、progress、pointer、detail 控制外观。'],
    examples: [{ tooltip: { trigger: 'item' }, series: [{ name: '渠道占比', type: 'pie', radius: ['45%', '70%'], data: [{ name: '自然搜索', value: 46 }, { name: '付费投放', value: 28 }, { name: '合作伙伴', value: 18 }] }] }],
  },
  {
    id: 'series.radar-polar',
    title: '雷达与极坐标',
    summary: 'radar 系列，以及 line、bar、scatter 在 polar 坐标系中的用法。',
    optionPaths: ['series-radar', 'radar', 'polar', 'radiusAxis', 'angleAxis'],
    notes: ['radar.indicator 定义每个维度名称与最大值。', '普通 line、bar、scatter 设置 coordinateSystem: polar 后可复用极坐标。'],
    examples: [{ radar: { indicator: [{ name: '质量', max: 100 }, { name: '速度', max: 100 }, { name: '服务', max: 100 }] }, series: [{ type: 'radar', data: [{ name: '方案 A', value: [88, 76, 91] }] }] }],
  },
  {
    id: 'series.hierarchy',
    title: '层级关系系列',
    summary: 'tree、treemap、sunburst，支持折叠树、矩形树图与旭日图。',
    optionPaths: ['series-tree', 'series-treemap', 'series-sunburst'],
    notes: ['数据通常使用递归 children；treemap/sunburst 节点通常还需要 value。', 'tree 可通过 orient、layout、initialTreeDepth 调整方向和展开层级。'],
    examples: [{ series: [{ type: 'sunburst', radius: ['12%', '88%'], data: [{ name: '产品', children: [{ name: '硬件', value: 42 }, { name: '软件', value: 58 }] }] }] }],
  },
  {
    id: 'series.network-flow',
    title: '网络与流向系列',
    summary: 'graph、lines、sankey、chord，用于关系网、路线、流向与弦图。',
    optionPaths: ['series-graph', 'series-lines', 'series-sankey', 'series-chord'],
    notes: ['graph 使用 data/nodes 与 links/edges；layout 可为 none、circular 或 force。', 'lines 的 data 可由 coords 数组描述路径，也可配合 geo 绘制地图迁徙线。', 'sankey 与 chord 都使用节点和连接数据；chord 是 ECharts 6.1 内置系列。'],
    examples: [{ series: [{ type: 'sankey', data: [{ name: '访问' }, { name: '注册' }, { name: '购买' }], links: [{ source: '访问', target: '注册', value: 60 }, { source: '注册', target: '购买', value: 25 }] }] }],
  },
  {
    id: 'series.finance-statistics',
    title: '金融与统计系列',
    summary: 'candlestick、boxplot、heatmap、themeRiver，用于 K 线、箱线、热力与主题河流。',
    optionPaths: ['series-candlestick', 'series-boxplot', 'series-heatmap', 'series-themeRiver'],
    notes: ['candlestick 单项数据顺序为 [open, close, lowest, highest]。', 'boxplot 单项通常为 [min, Q1, median, Q3, max]。', 'heatmap 常与 visualMap 配合；themeRiver 使用 [time, value, name] 数据。'],
    examples: [{ xAxis: { type: 'category', data: ['周一', '周二', '周三'] }, yAxis: { type: 'category', data: ['上午', '下午'] }, visualMap: { min: 0, max: 10, calculable: true, orient: 'horizontal' }, series: [{ type: 'heatmap', data: [[0, 0, 5], [1, 0, 8], [2, 0, 3], [0, 1, 7], [1, 1, 4], [2, 1, 9]] }] }],
  },
  {
    id: 'series.parallel-coordinate',
    title: '平行坐标系列',
    summary: 'parallel 系列及 parallel/parallelAxis 坐标配置。',
    optionPaths: ['series-parallel', 'parallel', 'parallelAxis'],
    notes: ['每个 parallelAxis.dim 对应 series.data 数组中的一个维度。', '可通过 parallelAxis.type、data、name 配置数值轴或类目轴。'],
    examples: [{ parallelAxis: [{ dim: 0, name: '价格' }, { dim: 1, name: '销量' }, { dim: 2, name: '评分' }], parallel: { left: 60, right: 60 }, series: [{ type: 'parallel', data: [[19, 84, 4.6], [25, 61, 4.2], [32, 43, 4.8]] }] }],
  },
  {
    id: 'series.geo-map',
    title: '地图与地理坐标',
    summary: 'map 系列、geo 坐标，以及 scatter、effectScatter、lines 在地理坐标上的组合。',
    optionPaths: ['series-map', 'geo', 'series-scatter.coordinateSystem', 'series-effectScatter.coordinateSystem', 'series-lines.coordinateSystem'],
    notes: ['ECharts 不内置具体行政区地图数据。action=create 可传 maps: [{name, geoJson, specialAreas?}]，渲染前会调用 registerMap。', 'map/geo 的 map 字段必须与 maps[].name 完全一致。geoJson 可以是 GeoJSON 对象，也可以是 SVG XML 字符串。'],
    examples: [{ maps: [{ name: 'region', geoJson: { type: 'FeatureCollection', features: [] } }], option: { visualMap: { min: 0, max: 100 }, series: [{ type: 'map', map: 'region', data: [{ name: 'A', value: 80 }] }] } }],
  },
  {
    id: 'series.custom-and-graphic',
    title: '自定义系列',
    summary: 'custom 系列与 graphic 图形组件的边界。',
    optionPaths: ['series-custom', 'graphic'],
    notes: ['内置 custom 系列已随完整 echarts 包加载，但 renderItem 是 JavaScript 函数，不能通过 JSON 工具参数安全传递。', '仅需静态图形时优先使用 graphic；需要回调驱动的 renderItem 或外部 @echarts-x 系列时，当前持久化 JSON 渲染通道不适用。', '除上述可执行回调边界外，工具不会对白名单图表类型做限制。'],
    examples: [{ graphic: [{ type: 'rect', left: 'center', top: 'middle', shape: { width: 180, height: 70 }, style: { fill: '#2563eb' } }] }],
  },
  {
    id: 'coordinate.systems',
    title: '坐标系',
    summary: 'grid、polar、radar、geo、parallel、singleAxis、calendar 与 matrix 坐标系。',
    optionPaths: ['grid', 'xAxis', 'yAxis', 'polar', 'radiusAxis', 'angleAxis', 'radar', 'geo', 'parallel', 'parallelAxis', 'singleAxis', 'calendar', 'matrix'],
    notes: ['多个坐标系组件可使用 index/id，并由系列的 xAxisIndex、geoIndex 等字段关联。', 'calendar 常与 heatmap/scatter 配合；matrix 是 ECharts 6 的矩阵坐标系。'],
    examples: [{ calendar: { range: '2026', cellSize: ['auto', 16] }, visualMap: { min: 0, max: 100, show: false }, series: [{ type: 'heatmap', coordinateSystem: 'calendar', data: [['2026-01-01', 42], ['2026-01-02', 71]] }] }],
  },
  {
    id: 'component.data-visual',
    title: '数据、编码与视觉映射',
    summary: 'dataset、encode、dimensions、transform、visualMap、dataZoom、brush 与 timeline。',
    optionPaths: ['dataset', 'series.encode', 'series.dimensions', 'transform', 'visualMap', 'dataZoom', 'brush', 'timeline'],
    notes: ['dataset.source 可被多个系列复用；seriesDatasetIndex 与 encode 建立映射。', '内置 transform 包括 filter 与 sort；函数式自定义 transform 不属于 JSON 能力。', 'visualMap 支持 continuous 与 piecewise；dataZoom 支持 inside 与 slider。'],
    examples: [{ dataset: { source: [['月份', '收入'], ['1月', 120], ['2月', 138], ['3月', 151]] }, xAxis: { type: 'category' }, yAxis: {}, series: [{ type: 'bar', encode: { x: '月份', y: '收入' } }] }],
  },
  {
    id: 'component.presentation',
    title: '标题、图例、提示与工具栏',
    summary: 'title、legend、tooltip、axisPointer、toolbox 与 graphic。',
    optionPaths: ['title', 'legend', 'tooltip', 'axisPointer', 'toolbox', 'graphic'],
    notes: ['tooltip.formatter 若为字符串模板可直接使用；函数 formatter 不能通过 JSON 传递。', 'toolbox 可配置 saveAsImage、dataView、dataZoom、magicType 与 restore。', 'graphic 支持 group、image、text、rect、circle、ring、sector、arc、polygon、polyline、line、bezierCurve 等图形。'],
    examples: [{ title: { text: '季度趋势', left: 'center' }, tooltip: { trigger: 'axis' }, legend: { top: 30 }, toolbox: { feature: { saveAsImage: {}, restore: {} } } }],
  },
  {
    id: 'interaction-animation',
    title: '交互、状态与动画',
    summary: 'emphasis、blur、select、selectedMode、roam、brush、universalTransition 与关键帧动画。',
    optionPaths: ['series.emphasis', 'series.blur', 'series.select', 'series.selectedMode', 'series.roam', 'brush', 'animation', 'universalTransition', 'keyframeAnimation'],
    notes: ['交互配置可以随 option 持久化；外部事件监听与 dispatchAction 不属于静态 option。', 'universalTransition 适用于有稳定 id/groupId 的数据项之间的形变动画。'],
    examples: [{ animationDurationUpdate: 600, series: [{ type: 'bar', universalTransition: true, selectedMode: 'multiple', emphasis: { focus: 'series' }, data: [12, 24, 18] }] }],
  },
];

function normalizedText(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function normalizedHeight(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(240, Math.min(720, Math.round(value))) : 380;
}

function normalizedPageNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.trunc(value))) : fallback;
}

export async function readChartApi(
  input: { limit?: unknown; offset?: unknown; query?: unknown },
  options: { echartsVersion?: string } = {},
): Promise<CapabilityResult<Record<string, unknown>>> {
  const echartsVersion = options.echartsVersion || '6.x';
  const query = normalizedText(input.query, 120);
  if (!query) {
    const offset = normalizedPageNumber(input.offset, 0, 0, apiModules.length);
    const limit = normalizedPageNumber(input.limit, 50, 1, 50);
    const modules = apiModules.slice(offset, offset + limit).map(({ id, summary, title }) => ({ id, summary, title }));
    const nextOffset = offset + modules.length < apiModules.length ? offset + modules.length : undefined;
    return {
      ok: true,
      summary: 'Apache ECharts API module index.',
      data: {
        engine: 'Apache ECharts',
        installedVersion: echartsVersion,
        instruction: '使用 chart action=api，并把某个 modules[].id 原样作为 query，再读取该模块的配置路径、注意事项和例子。读取足够信息后再调用 action=create。',
        kind: 'echarts-api-index',
        limit,
        modules,
        nextOffset,
        offset,
        total: apiModules.length,
      },
    };
  }
  const apiModule = apiModules.find((entry) => entry.id === query);
  if (!apiModule) {
    return {
      ok: false,
      error: {
        code: 'chart-api-module-not-found',
        message: `Unknown ECharts API module: ${query}. Call chart action=api without query to read the module index, then use an exact module id.`,
      },
    };
  }
  return {
    ok: true,
    summary: `Apache ECharts API module: ${apiModule.title}.`,
    data: {
      createSignature: { action: 'create', description: 'string?', height: 'number? (240..720)', maps: 'Array<{name, geoJson, specialAreas?}>?', option: 'EChartsOption', reason: 'string', renderer: 'canvas | svg?', title: 'string?' },
      engine: 'Apache ECharts',
      installedVersion: echartsVersion,
      kind: 'echarts-api-module',
      module: apiModule,
    },
  };
}

export async function createChart(store: ChartArtifactStore, input: {
  description?: unknown;
  height?: unknown;
  maps?: unknown;
  option?: unknown;
  renderer?: unknown;
  title?: unknown;
}, options: { validateOption?: ChartOptionValidator } = {}): Promise<CapabilityResult<{ chartId: string }>> {
  try {
    const option = normalizeChartOption(input.option);
    const maps = normalizeChartMaps(input.maps);
    if (new TextEncoder().encode(JSON.stringify({ maps, option })).byteLength > maxChartBytes) {
      throw new Error('option and maps must be no larger than 4 MB in total.');
    }
    const height = normalizedHeight(input.height);
    const renderer = input.renderer === 'svg' ? 'svg' : 'canvas';
    await options.validateOption?.({ height, maps, option, renderer });
    const record = await store.create({
      description: normalizedText(input.description, 1_000),
      height,
      maps,
      option,
      renderer,
      title: normalizedText(input.title, 200),
      version: 2,
    });
    return {
      ok: true,
      summary: `Chart ${record.chartId} created.`,
      data: { chartId: record.chartId },
      content: [{
        type: 'ui',
        renderer: 'com.webpilot.chart/echarts',
        resourceId: record.chartId,
      }],
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'chart-generation-failed',
        message: `Chart generation failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

export function createChartTool(
  store: ChartArtifactStore,
  options: { echartsVersion?: string; validateOption?: ChartOptionValidator } = {},
) {
  return defineCapabilityTool<ChartToolInput, Record<string, unknown> | { chartId: string }>({
    name: chartCapabilityToolNames.chart,
    description: 'Read modular Apache ECharts API guidance or create one persistent chart resource. Read the API index and relevant modules before action=create. A successful create returns a chartId and a structured UI resource.',
    input: chartToolInput,
    inputExamples: [
      { action: 'api', reason: '查看 ECharts API 模块索引' },
      { action: 'api', reason: '读取直角坐标系列配置说明', query: 'series.cartesian' },
      {
        action: 'create',
        reason: '展示最近六个月收入趋势',
        title: '最近六个月收入趋势',
        option: {
          tooltip: { trigger: 'axis' },
          xAxis: { type: 'category', data: ['1月', '2月', '3月', '4月', '5月', '6月'] },
          yAxis: { type: 'value' },
          series: [{ name: '收入（万元）', type: 'line', smooth: true, areaStyle: {}, data: [120, 138, 151, 149, 182, 205] }],
        },
      },
    ],
    policy: {
      concurrency: 'serial',
      concurrencyGroup: 'chart-artifacts',
      permissions: chartCapabilityManifest.permissions,
    },
    execute: (input) => input.action === 'api'
      ? readChartApi(
          { limit: input.limit, offset: input.offset, query: input.query },
          { echartsVersion: options.echartsVersion },
        )
      : createChart(store, input, { validateOption: options.validateOption }),
  });
}

export function createChartCapability(options: {
  createStore(context: CapabilityRunContext): ChartArtifactStore | Promise<ChartArtifactStore>;
  echartsVersion?: string;
  validateOption?: ChartOptionValidator;
}): CapabilityProvider {
  return {
    manifest: chartCapabilityManifest,
    async createRuntime(context) {
      const store = await options.createStore(context);
      return {
        tools: Object.freeze({
          [chartCapabilityToolNames.chart]: createChartTool(store, {
            echartsVersion: options.echartsVersion,
            validateOption: options.validateOption,
          }),
        }),
        health: () => store.health?.() || Promise.resolve({ status: 'healthy' }),
        dispose: () => store.dispose?.() || Promise.resolve(),
      };
    },
  };
}

export async function readChart(store: ChartArtifactStore, chartId: string) {
  return store.read(chartId);
}
