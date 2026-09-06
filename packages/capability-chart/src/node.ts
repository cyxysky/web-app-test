import { link, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  ChartArtifactStore,
} from './index.js';
import { createChartCapability } from './index.js';
import {
  echartsMapDefinition,
  parseChartRecord,
  normalizeChartOption,
  normalizeChartUpdate,
  ChartRevisionConflict,
  type ChartOptionValidationInput,
  type ChartRecord,
  type CreateChartRecordInput,
} from './core.js';
import type { CapabilityRunContext } from '@webpilot/capability-sdk';

const chartIdPattern = /^chart_(\d{6})$/;

// Publish only complete files. Hard-link creation is atomic and refuses to overwrite
// a revision published by another process; abandoned temporary files are invisible.
async function publishRecord(directory: string, filename: string, record: ChartRecord) {
  const temporary = path.join(directory, `.chart-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx' });
    await link(temporary, path.join(directory, filename));
  } finally { await unlink(temporary).catch(() => undefined); }
}

export async function validateEChartsOption(input: ChartOptionValidationInput) {
  const echarts = await import('echarts');
  for (const map of input.maps || []) {
    echarts.registerMap(
      map.name,
      echartsMapDefinition(map) as unknown as Parameters<typeof echarts.registerMap>[1],
      map.specialAreas as Parameters<typeof echarts.registerMap>[2],
    );
  }
  const instance = echarts.init(null, undefined, {
    height: input.height,
    renderer: 'svg',
    ssr: true,
    width: 960,
  });
  try {
    instance.setOption(normalizeChartOption(input.option));
    const svg = instance.renderToSVGString();
    if (!svg.includes('<svg')) throw new Error('ECharts produced no SVG surface.');
  } catch (error) {
    throw new Error(`ECharts rejected option: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    instance.dispose();
  }
}

export function createFileSystemChartStore(input: {
  directory: string;
  /** Number of recent revisions to retain, in addition to the immutable original. */
  retainedRevisions?: number;
}): ChartArtifactStore {
  const directory = path.resolve(input.directory);
  const keep = Math.max(1, Math.min(1000, Math.floor(input.retainedRevisions || 20)));
  let index: { signature: string; checkedAt: number; next: number; revisions: Map<string, number[]> } | undefined;
  let maintenanceError: unknown;
  async function directoryIndex() {
    const info = await stat(directory, { bigint: true });
    const signature = `${info.mtimeNs}:${info.ctimeNs}:${info.size}`;
    if (index?.signature === signature && Date.now() - index.checkedAt < 1000) return index;
    const revisions = new Map<string, number[]>();
    let next = 1;
    for (const entry of await readdir(directory)) {
      const match = /^(chart_(\d{6}))(?:\.revision-(\d+))?\.json$/.exec(entry);
      if (!match) continue;
      next = Math.max(next, Number(match[2]) + 1);
      if (match[3] && Number.isSafeInteger(Number(match[3]))) {
        const values = revisions.get(match[1]) || [];
        values.push(Number(match[3])); revisions.set(match[1], values);
      }
    }
    for (const values of revisions.values()) values.sort((a, b) => a - b);
    // A concurrent publication changes the directory signature and invalidates this snapshot.
    index = { signature, checkedAt: Date.now(), next, revisions };
    return index;
  }
  async function readLatest(chartId: string, retried = false): Promise<ChartRecord | undefined> {
    if (!chartIdPattern.test(chartId)) return undefined;
    try {
      const latest = (await directoryIndex()).revisions.get(chartId)?.at(-1) ?? -1;
      const filename = latest < 0 ? `${chartId}.json` : `${chartId}.revision-${latest}.json`;
      const record = parseChartRecord(JSON.parse(await readFile(path.join(directory, filename), 'utf8')), chartId);
      if (latest >= 0 && record.revision !== latest) throw new Error('Chart revision identity mismatch.');
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (retried) return undefined;
        index = undefined;
        return readLatest(chartId, true);
      }
      throw new Error(`Unable to read chart artifact ${chartId}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return {
    async create(candidate: CreateChartRecordInput) {
      await mkdir(directory, { recursive: true });
      let number = (await directoryIndex()).next;
      while (number <= 999_999) {
        const chartId = `chart_${String(number).padStart(6, '0')}`;
        const record: ChartRecord = {
          ...candidate,
          chartId,
          createdAt: new Date().toISOString(),
          revision: 1,
        };
        try {
          await publishRecord(directory, `${chartId}.json`, record);
          index = undefined;
          return record;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          number += 1;
        }
      }
      throw new Error('This chart store has reached its identifier limit.');
    },
    read: readLatest,
    async update(chartId, candidate, expectedRevision) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid expectedRevision.');
      const previous = await readLatest(chartId);
      if (!previous) return undefined;
      if ((previous.revision || 0) !== expectedRevision) throw new ChartRevisionConflict();
      const next = normalizeChartUpdate(previous, candidate);
      try {
        await publishRecord(directory, `${chartId}.revision-${next.revision}.json`, next);
        index = undefined;
        // Retention cannot delete a concurrent writer's newer revision or the original.
        try {
          const revisions = (await directoryIndex()).revisions.get(chartId) || [];
          for (const revision of revisions.filter((value) => value <= next.revision!).slice(0, -keep)) {
            await unlink(path.join(directory, `${chartId}.revision-${revision}.json`)).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error;
            });
          }
          maintenanceError = undefined;
        } catch (error) { maintenanceError = error; }
        finally { index = undefined; }
        return next;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ChartRevisionConflict();
        throw error;
      }
    },
    async health() {
      try {
        await mkdir(directory, { recursive: true });
        await readdir(directory);
        if (maintenanceError) throw maintenanceError;
        return { status: 'healthy' as const };
      } catch (error) {
        return {
          status: 'unhealthy' as const,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

export function createNodeChartCapability(input: {
  directory: string | ((context: CapabilityRunContext) => string);
  echartsVersion?: string;
  retainedRevisions?: number;
}) {
  return createChartCapability({
    echartsVersion: input.echartsVersion,
    validateOption: validateEChartsOption,
    createStore(context) {
      const directory = typeof input.directory === 'function'
        ? input.directory(context)
        : input.directory;
      return createFileSystemChartStore({ directory, retainedRevisions: input.retainedRevisions });
    },
  });
}
