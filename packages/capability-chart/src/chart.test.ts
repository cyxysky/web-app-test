import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChartRevisionConflict, normalizeChartOption, normalizeThreeChartOption, parseChartRecord, echartsToThree, threeChartBounds } from './core.js';
import { createChart, createChartTool, updateChart } from './index.js';
import { createFileSystemChartStore, validateEChartsOption } from './node.js';
import { chartDataTables, replaceTableRows, tableColumns, tableCsv } from './editor-core.js';

const option = { xAxis: { type: 'category', data: ['A', 'B'] }, yAxis: {}, series: [{ type: 'bar', itemStyle: { color: '#2563eb' }, data: [4, -2] }] };
async function removeTestDirectory(directory: string) {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('webpilot-chart-'));
  await rm(resolved, { recursive: true, force: true });
}

test('a saved chart survives reopening; simultaneous stale updates cannot overwrite each other', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-chart-'));
  try {
    const store = createFileSystemChartStore({ directory });
    const result = await createChart(store, { option }, { validateOption: validateEChartsOption });
    assert.equal(result.ok, true);
    const chartId = result.data!.chartId;
    const original = await readFile(path.join(directory, `${chartId}.json`), 'utf8');
    const a = { ...option, series: [{ type: 'bar', data: [12, 20] }] };
    const b = { ...option, series: [{ type: 'bar', data: [30, 40] }] };
    const results = await Promise.allSettled([updateChart(store, chartId, { option: a }, 1), updateChart(createFileSystemChartStore({ directory }), chartId, { option: b }, 1)]);
    assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1);
    const failed = results.find((entry) => entry.status === 'rejected') as PromiseRejectedResult;
    assert.ok(failed.reason instanceof ChartRevisionConflict);
    const saved = await createFileSystemChartStore({ directory }).read(chartId);
    assert.equal(saved?.revision, 2);
    assert.deepEqual(saved?.option, (results.find((entry) => entry.status === 'fulfilled') as PromiseFulfilledResult<typeof saved>).value?.option);
    assert.equal(await readFile(path.join(directory, `${chartId}.json`), 'utf8'), original);
    assert.equal((await readdir(directory)).some((file) => file.endsWith('.tmp')), false);
    await assert.rejects(updateChart(store, chartId, { option }, 1), ChartRevisionConflict);
    assert.equal(await store.read('../chart_000001'), undefined);
    assert.equal(await updateChart(store, 'chart_999999', { option }, 0), undefined);
  } finally { await removeTestDirectory(directory); }
});

test('legacy version 2 opens at revision zero and can be edited without rewriting the original', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-chart-'));
  try {
    const legacy = { chartId: 'chart_000001', version: 2, createdAt: new Date().toISOString(), height: 380, renderer: 'svg', option: { ...option, tooltip: { trigger: 'axis', formatter: 'function(params){return params[0].value;}' } } };
    await writeFile(path.join(directory, 'chart_000001.json'), JSON.stringify(legacy));
    const store = createFileSystemChartStore({ directory });
    assert.equal((await store.read(legacy.chartId))?.engine, 'echarts');
    assert.deepEqual((await store.read(legacy.chartId))?.option.tooltip, { trigger: 'axis' });
    await assert.rejects(updateChart(store, legacy.chartId, { option: legacy.option }, 0), /option\.tooltip\.formatter/);
    assert.equal((await store.read(legacy.chartId))?.revision, 0);
    const saved = await updateChart(store, legacy.chartId, { option, title: 'Edited' }, 0, { validateOption: validateEChartsOption });
    assert.equal(saved?.revision, 1); assert.equal(saved?.version, 3);
    assert.equal((await store.read(legacy.chartId))?.title, 'Edited');
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'chart_000001.json'), 'utf8')), legacy);
    assert.throws(() => parseChartRecord({ ...legacy, version: '2' }));
  } finally { await removeTestDirectory(directory); }
});

test('formatter source is rejected before persistence while valid templates and ordinary chart text survive', async () => {
  let writes = 0;
  const store = { async create() { writes++; throw new Error('Invalid formatters must not reach the store'); }, async read() { return undefined; } };
  for (const formatter of ['function(params){return params[0].value;}', '(params) => params.value', 'params => params.value', '/* note */ (function fmt(params) { return params.value; })', 'async (params) => params.value']) {
    const result = await createChart(store, { option: { ...option, tooltip: { trigger: 'axis', formatter } } });
    assert.equal(result.ok, false);
    assert.match(result.error!.message, /option\.tooltip\.formatter/);
  }
  assert.equal(writes, 0);
  const valid = { ...option, tooltip: { formatter: '{b0}<br/>{a0}: {c0}<br/>{a1}: {c1}' }, xAxis: { axisLabel: { formatter: '{value} 件' } }, title: { text: 'function(params) example' }, dataset: { source: [['code'], ['(x) => x']] } };
  assert.deepEqual(normalizeChartOption(valid), valid);
  const source = { ...option, dataset: [{ source: [{ formatter: '(value) => value', tooltip: { formatter: 'function(x) {}' } }] }] };
  assert.deepEqual(normalizeChartOption(source), source);
  assert.deepEqual(normalizeChartOption(source, { invalidFormatters: 'omit' }), source);
  assert.throws(() => normalizeChartOption({ ...option, series: [{ ...option.series[0], label: { formatter: '(p) => p.value' } }] }), /option\.series\[0\]\.label\.formatter/);
  assert.throws(() => normalizeChartOption({ ...option, tooltip: { valueFormatter: 'value => value + "%"' } }), /option\.tooltip\.valueFormatter/);
  assert.throws(() => normalizeChartOption({ ...option, tooltip: { formatter: () => 'text' } }), /option\.tooltip\.formatter/);
});

test('native 3D tool create/read/update skips ECharts validation and rejects malformed surfaces', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-chart-'));
  try {
    const store = createFileSystemChartStore({ directory });
    const tool = createChartTool(store, { validateOption() { throw new Error('Must not validate 3D using ECharts'); } });
    const three = { series: [{ type: 'surface3D', grid: { rows: 2, columns: 2 }, data: [[0, 0, -2], [1, 0, 2], [0, 1, 3], [1, 1, 4]] }] };
    const context = { invocationId: 'test-chart' };
    const created = await tool.execute(tool.input.parse({ action: 'create', reason: 'test', engine: 'three', option: three }), context);
    assert.equal(created.ok, true);
    const chartId = created.data!.chartId as string;
    const read = await tool.execute(tool.input.parse({ action: 'read', reason: 'test', chartId }), context);
    assert.equal(read.ok, true);
    assert.equal((read.data as Record<string, unknown>).revision, 1);
    const updated = await tool.execute(tool.input.parse({ action: 'update', reason: 'test', chartId, option: three, expectedRevision: 1 }), context);
    assert.equal(updated.ok, true); assert.equal((updated.data as Record<string, unknown>).revision, 2);
    const bad = await tool.execute(tool.input.parse({ action: 'update', reason: 'test', chartId, expectedRevision: 2, option: { series: [{ type: 'surface3D', data: [[0, 0, 1]] }] } }), context);
    assert.equal(bad.ok, false); assert.equal((await store.read(chartId))?.revision, 2);
    assert.throws(() => tool.input.parse({ action: 'update', reason: 'test', chartId, option: three }));
  } finally { await removeTestDirectory(directory); }
});

test('3D projection preserves signed values and does not silently flatten incompatible coordinates', () => {
  const converted = echartsToThree(option)!;
  assert.deepEqual(converted.series[0].data, [[0, 0, 4], [1, 0, -2]]);
  assert.equal(threeChartBounds(converted).min[2], -2);
  assert.equal(echartsToThree({ ...option, series: [{ type: 'bar', data: [1, null] }] }), undefined);
  assert.equal(echartsToThree({ ...option, xAxis: {}, yAxis: { type: 'category' } }), undefined);
  assert.equal(echartsToThree({ ...option, series: [{ type: 'scatter', data: [[1, 2, 3]] }] }), undefined);
  assert.throws(() => normalizeThreeChartOption({ series: [{ type: 'scatter3D', data: [[Infinity, 0, 1]] }] }));
});

test('table edits preserve styles, extra dimensions and object metadata; CSV escapes formulas and quotes', () => {
  const tables = chartDataTables(option);
  const series = tables.find((table) => table.path[0] === 'series')!;
  const edited = replaceTableRows(option, series, [100, -2]);
  assert.deepEqual((edited.series as typeof option.series)[0].itemStyle, option.series[0].itemStyle);
  assert.deepEqual(edited.xAxis, option.xAxis);
  assert.deepEqual(option.series[0].data, [4, -2]);
  const object = chartDataTables({ series: [{ type: 'pie', data: [{ name: '="test"', value: 12, itemStyle: { color: 'red' } }] }] })[0];
  assert.equal(tableColumns(object).length, 3);
  assert.match(tableCsv(object), /'=""test""/);
});
