export type EChartsMapRegistration = {
  geoJson: Record<string, unknown> | string;
  name: string;
  specialAreas?: Record<string, unknown>;
};

export type ChartRecord = {
  chartId: string;
  createdAt: string;
  description?: string;
  height: number;
  maps?: EChartsMapRegistration[];
  option: Record<string, unknown>;
  renderer: 'canvas' | 'svg';
  title?: string;
  version: 2;
};

export type CreateChartRecordInput = Omit<ChartRecord, 'chartId' | 'createdAt'>;

export type ChartOptionValidationInput = {
  height: number;
  maps?: EChartsMapRegistration[];
  option: Record<string, unknown>;
  renderer: 'canvas' | 'svg';
};

export type ChartOptionValidator = (
  input: ChartOptionValidationInput,
) => Promise<void> | void;

export const maxChartBytes = 4 * 1024 * 1024;

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function serializableClone<T>(value: T, fieldName: string): T {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${fieldName} must be JSON-serializable.`);
  }
  if (serialized === undefined) throw new Error(`${fieldName} must be JSON-serializable.`);
  return JSON.parse(serialized) as T;
}

function hasOptionComponent(option: Record<string, unknown>, component: string) {
  const value = option[component];
  return Array.isArray(value) ? value.length > 0 : Boolean(recordFromUnknown(value));
}

const linesCoordinateComponents = Object.freeze({
  calendar: ['calendar'],
  cartesian2d: ['xAxis', 'yAxis'],
  geo: ['geo'],
  matrix: ['matrix'],
  polar: ['polar', 'radiusAxis', 'angleAxis'],
} satisfies Record<string, readonly string[]>);

export function normalizeChartOption(value: unknown) {
  const option = recordFromUnknown(value);
  if (!option) throw new Error('action=create requires option as an ECharts option object.');
  const series = option.series;
  const hasSeries = Array.isArray(series) ? series.length > 0 : Boolean(recordFromUnknown(series));
  const hasGraphic = Array.isArray(option.graphic) ? option.graphic.length > 0 : Boolean(recordFromUnknown(option.graphic));
  if (!hasSeries && !hasGraphic) throw new Error('option must contain at least one series item or one graphic element.');
  const graphic = recordFromUnknown(option.graphic);
  if (graphic && typeof graphic.type !== 'string' && !Array.isArray(graphic.elements)) {
    throw new Error('option.graphic must be an element, an element array, or an object with an elements array.');
  }
  const seriesItems = Array.isArray(series) ? series : series === undefined ? [] : [series];
  for (const [index, item] of seriesItems.entries()) {
    const seriesItem = recordFromUnknown(item);
    if (!seriesItem || typeof seriesItem.type !== 'string' || !seriesItem.type.trim()) {
      throw new Error(`option.series[${index}].type must be a non-empty ECharts series type.`);
    }
    if (seriesItem.data !== undefined && !Array.isArray(seriesItem.data)) {
      throw new Error(`option.series[${index}].data must be an array when provided.`);
    }
    const type = String(seriesItem.type).trim();
    if (type === 'custom') {
      throw new Error(`option.series[${index}] uses custom without a JSON-safe renderItem. Use option.graphic for static custom visuals.`);
    }
    if (type === 'lines') {
      const coordinateSystem = typeof seriesItem.coordinateSystem === 'string' && seriesItem.coordinateSystem.trim()
        ? seriesItem.coordinateSystem.trim()
        : 'geo';
      const requiredComponents = linesCoordinateComponents[coordinateSystem as keyof typeof linesCoordinateComponents];
      if (!requiredComponents) {
        throw new Error(`option.series[${index}].coordinateSystem ${JSON.stringify(coordinateSystem)} is not supported by the bundled ECharts lines series.`);
      }
      const missingComponents = requiredComponents.filter((component) => !hasOptionComponent(option, component));
      if (missingComponents.length) {
        throw new Error(`option.series[${index}] lines coordinateSystem ${JSON.stringify(coordinateSystem)} requires option.${missingComponents.join(' and option.')}.`);
      }
      if (Array.isArray(seriesItem.data)) {
        for (const [dataIndex, dataItem] of seriesItem.data.entries()) {
          const coords = recordFromUnknown(dataItem)?.coords;
          if (!Array.isArray(coords) || coords.length < 2 || coords.some((point) => !Array.isArray(point) || point.length < 2)) {
            throw new Error(`option.series[${index}].data[${dataIndex}].coords must contain at least two coordinate arrays.`);
          }
        }
      }
    }
    if (type === 'chord') {
      const links = seriesItem.links ?? seriesItem.edges;
      if (!Array.isArray(links) || links.length === 0) {
        throw new Error(`option.series[${index}] chord requires a non-empty links or edges array.`);
      }
    }
  }
  return serializableClone(option, 'option');
}

export function normalizeChartMaps(value: unknown): EChartsMapRegistration[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('maps must be an array.');
  if (value.length > 12) throw new Error('maps supports at most 12 registrations per chart.');
  const maps = value.map((item, index) => {
    const map = recordFromUnknown(item);
    const name = typeof map?.name === 'string' ? map.name.trim() : '';
    const geoJson = map?.geoJson;
    if (!name) throw new Error(`maps[${index}].name is required.`);
    if (!(typeof geoJson === 'string' && geoJson.trim()) && !recordFromUnknown(geoJson)) {
      throw new Error(`maps[${index}].geoJson must be a GeoJSON object or SVG XML string.`);
    }
    const specialAreas = map?.specialAreas === undefined ? undefined : recordFromUnknown(map.specialAreas);
    if (map?.specialAreas !== undefined && !specialAreas) throw new Error(`maps[${index}].specialAreas must be an object.`);
    return { name, geoJson: geoJson as Record<string, unknown> | string, specialAreas };
  });
  return serializableClone(maps, 'maps');
}

export function echartsMapDefinition(map: EChartsMapRegistration) {
  return typeof map.geoJson === 'string' ? { svg: map.geoJson } : map.geoJson;
}

export function parseChartRecord(value: unknown, expectedChartId?: string): ChartRecord {
  const record = recordFromUnknown(value);
  if (!record || record.version !== 2 || typeof record.chartId !== 'string') {
    throw new Error('Chart artifact has an unsupported or invalid record format.');
  }
  if (expectedChartId && record.chartId !== expectedChartId) {
    throw new Error('Chart artifact identity does not match its requested chart id.');
  }
  if (typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) {
    throw new Error('Chart artifact has an invalid creation timestamp.');
  }
  if (typeof record.height !== 'number' || !Number.isInteger(record.height) || record.height < 240 || record.height > 720) {
    throw new Error('Chart artifact has an invalid rendered height.');
  }
  if (record.renderer !== 'canvas' && record.renderer !== 'svg') {
    throw new Error('Chart artifact has an invalid renderer.');
  }
  if (record.title !== undefined && typeof record.title !== 'string') throw new Error('Chart artifact has an invalid title.');
  if (record.description !== undefined && typeof record.description !== 'string') throw new Error('Chart artifact has an invalid description.');
  return {
    chartId: record.chartId,
    createdAt: record.createdAt,
    description: record.description,
    height: record.height,
    maps: normalizeChartMaps(record.maps),
    option: normalizeChartOption(record.option),
    renderer: record.renderer,
    title: record.title,
    version: 2,
  };
}
