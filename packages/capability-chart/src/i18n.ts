export type ChartTranslate = (value: string, params?: Record<string, string | number>) => string;

// Hosts can supply their translator without coupling this package to an app context.
export const defaultChartTranslate: ChartTranslate = (value, params) => value.replace(/\{(\w+)\}/g,
  (match, key: string) => params?.[key] === undefined ? match : String(params[key]));
