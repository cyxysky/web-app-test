import { z } from 'zod';
import { defaultChartTranslate, type ChartTranslate } from './i18n.js';

const point = z.tuple([z.number().finite().min(-1e12).max(1e12), z.number().finite().min(-1e12).max(1e12), z.number().finite().min(-1e12).max(1e12)]);
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
const axis = z.object({ name: z.string().max(120).optional(), categories: z.array(z.string().max(120)).max(1000).optional() }).strict();
export const threeChartOptionSchema = z.object({
  background: color.optional(),
  axes: z.object({ x: axis.optional(), y: axis.optional(), z: axis.optional() }).strict().optional(),
  series: z.array(z.object({
    type: z.enum(['bar3D', 'scatter3D', 'line3D', 'surface3D']),
    name: z.string().max(120).optional(), color: color.optional(),
    size: z.number().finite().min(0.02).max(2).optional(),
    data: z.array(point).min(1).max(50_000),
    grid: z.object({ rows: z.number().int().min(2).max(256), columns: z.number().int().min(2).max(256) }).strict().optional(),
  }).strict()).min(1).max(32),
}).strict().superRefine((option, ctx) => {
  if (option.series.reduce((sum, series) => sum + series.data.length, 0) > 50_000) ctx.addIssue({ code: 'custom', message: '3D charts support at most 50,000 points in total.' });
  option.series.forEach((series, index) => {
    if (series.type === 'surface3D' && (!series.grid || series.grid.rows * series.grid.columns !== series.data.length)) {
      ctx.addIssue({ code: 'custom', path: ['series', index, 'grid'], message: 'surface3D requires a rows × columns grid matching the data length, ordered row by row.' });
    }
    if (series.type === 'line3D' && series.data.length < 2) ctx.addIssue({ code: 'custom', path: ['series', index, 'data'], message: 'line3D requires at least two points.' });
  });
});
export type ThreeChartOption = z.infer<typeof threeChartOptionSchema>;
export function normalizeThreeChartOption(value: unknown): ThreeChartOption {
  return threeChartOptionSchema.parse(value);
}

/** Z is the measured height. World Y is up; the renderer maps [x,y,z] to [x,z,y]. */
export function threeChartBounds(option: ThreeChartOption) {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const series of option.series) for (const point of series.data) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis], point[axis]); max[axis] = Math.max(max[axis], point[axis]);
  }
  if (option.series.some((series) => series.type === 'bar3D')) { min[2] = Math.min(0, min[2]); max[2] = Math.max(0, max[2]); }
  for (let axis = 0; axis < 3; axis++) if (min[axis] === max[axis]) { min[axis] -= 0.5; max[axis] += 0.5; }
  return { min, max };
}

/** Convert simple 2D numeric series without changing the persisted source option. */
export function echartsToThree(option: Record<string, unknown>, t: ChartTranslate = defaultChartTranslate): ThreeChartOption | undefined {
  if (option.dataset || option.timeline) return undefined;
  const entries = Array.isArray(option.series) ? option.series : [option.series];
  const xAxis = (Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis) as { data?: unknown[]; type?: string } | undefined;
  const yAxis = (Array.isArray(option.yAxis) ? option.yAxis[0] : option.yAxis) as { type?: string } | undefined;
  if ((Array.isArray(option.xAxis) && option.xAxis.length > 1) || (Array.isArray(option.yAxis) && option.yAxis.length > 1) || yAxis?.type === 'category' || ['time', 'log'].includes(xAxis?.type || '') || yAxis?.type === 'log') return undefined;
  const categories = Array.isArray(xAxis?.data) ? xAxis.data.map(String) : undefined;
  const series: ThreeChartOption['series'] = [];
  for (const [index, raw] of entries.entries()) {
    if (!raw || typeof raw !== 'object') return undefined;
    const item = raw as Record<string, unknown>;
    if (!['bar', 'line', 'scatter'].includes(String(item.type)) || !Array.isArray(item.data) || item.stack || item.coordinateSystem || item.encode || Number(item.xAxisIndex || 0) !== 0 || Number(item.yAxisIndex || 0) !== 0) return undefined;
    const data: Array<[number, number, number]> = [];
    for (const [row, rawPoint] of item.data.entries()) {
      const value = rawPoint && typeof rawPoint === 'object' && !Array.isArray(rawPoint) ? (rawPoint as Record<string, unknown>).value : rawPoint;
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'number') data.push([value[0], index, value[1]]);
      else if (typeof value === 'number' && Number.isFinite(value)) data.push([row, index, value]);
      else return undefined; // Never turn a missing/complex value into zero.
    }
    series.push({ type: item.type === 'bar' ? 'bar3D' : item.type === 'line' ? 'line3D' : 'scatter3D', name: typeof item.name === 'string' ? item.name : t('系列 {index}', { index: index + 1 }), data });
  }
  const parsed = threeChartOptionSchema.safeParse({ axes: { x: { name: 'X', categories }, y: { name: t('系列'), categories: series.map((item) => item.name || '') }, z: { name: t('数值') } }, series });
  return parsed.success ? parsed.data : undefined;
}
