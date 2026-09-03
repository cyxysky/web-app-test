import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ChartArtifactStore,
} from './index.js';
import { createChartCapability } from './index.js';
import {
  echartsMapDefinition,
  parseChartRecord,
  type ChartOptionValidationInput,
  type ChartRecord,
  type CreateChartRecordInput,
} from './core.js';
import type { CapabilityRunContext } from '@webpilot/capability-sdk';

const chartIdPattern = /^chart_(\d{6})$/;

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
    instance.setOption(input.option);
    const svg = instance.renderToSVGString();
    if (!svg.includes('<svg')) throw new Error('ECharts produced no SVG surface.');
  } catch (error) {
    throw new Error(`ECharts rejected option: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    instance.dispose();
  }
}

async function nextChartNumber(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.reduce((maximum, entry) => {
    if (!entry.isFile() || !entry.name.endsWith('.json')) return maximum;
    const matched = entry.name.slice(0, -5).match(chartIdPattern);
    return matched ? Math.max(maximum, Number(matched[1])) : maximum;
  }, 0) + 1;
}

export function createFileSystemChartStore(input: {
  directory: string;
}): ChartArtifactStore {
  const directory = path.resolve(input.directory);
  return {
    async create(candidate: CreateChartRecordInput) {
      await mkdir(directory, { recursive: true });
      let number = await nextChartNumber(directory);
      while (number <= 999_999) {
        const chartId = `chart_${String(number).padStart(6, '0')}`;
        const record: ChartRecord = {
          ...candidate,
          chartId,
          createdAt: new Date().toISOString(),
        };
        try {
          await writeFile(
            path.join(directory, `${chartId}.json`),
            `${JSON.stringify(record, null, 2)}\n`,
            { encoding: 'utf8', flag: 'wx' },
          );
          return record;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          number += 1;
        }
      }
      throw new Error('This chart store has reached its identifier limit.');
    },
    async read(chartId: string) {
      if (!chartIdPattern.test(chartId)) return undefined;
      try {
        const parsed = JSON.parse(await readFile(path.join(directory, `${chartId}.json`), 'utf8')) as unknown;
        return parseChartRecord(parsed, chartId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw new Error(
          `Unable to read chart artifact ${chartId}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    },
    async health() {
      try {
        await mkdir(directory, { recursive: true });
        await readdir(directory);
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
}) {
  return createChartCapability({
    echartsVersion: input.echartsVersion,
    validateOption: validateEChartsOption,
    createStore(context) {
      const directory = typeof input.directory === 'function'
        ? input.directory(context)
        : input.directory;
      return createFileSystemChartStore({ directory });
    },
  });
}
