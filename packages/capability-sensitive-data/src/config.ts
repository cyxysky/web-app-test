export const defaultGlinerOpenLabelModel = 'fastino/gliner2.5-multi-v1';
export const defaultLiquidPiiModel = 'LiquidAI/LFM2.5-Encoder-350M-PII-Detector';
export const defaultChineseNerModel = 'uer/roberta-base-finetuned-cluener2020-chinese';
export const defaultSensitiveDataFilterTimeoutMs = 60_000;

export type SensitiveDataFilterFailureMode = 'closed' | 'open';

export type SensitiveDataFilterConfig = {
  apiKey?: string;
  enabled: boolean;
  failureMode: SensitiveDataFilterFailureMode;
  labels: string[];
  serviceUrl: string;
  threshold?: number;
  timeoutMs: number;
};

export type SensitiveDataEnvironment = Record<string, string | undefined>;

export function normalizedGlinerModelName(value: unknown) {
  const configured = String(value || '').trim();
  return !configured || configured === 'urchade/gliner_multi-v2.1'
    ? defaultGlinerOpenLabelModel
    : configured;
}

export function sensitiveDataFilterConfigFromEnvironment(
  environment: SensitiveDataEnvironment,
): SensitiveDataFilterConfig {
  const configuredTimeout = Number(environment.AI_SENSITIVE_DATA_FILTER_TIMEOUT_MS || defaultSensitiveDataFilterTimeoutMs);
  const configuredThreshold = Number(environment.AI_SENSITIVE_DATA_FILTER_THRESHOLD || '');
  return {
    enabled: environment.AI_SENSITIVE_DATA_FILTER_ENABLED === 'true',
    failureMode: String(environment.AI_SENSITIVE_DATA_FILTER_FAILURE_MODE || 'closed').trim().toLowerCase() === 'open'
      ? 'open'
      : 'closed',
    timeoutMs: Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.min(Math.floor(configuredTimeout), 600_000)
      : defaultSensitiveDataFilterTimeoutMs,
    labels: String(environment.AI_SENSITIVE_DATA_FILTER_LABELS || '')
      .split(/[,\n]/)
      .map((label) => label.trim())
      .filter(Boolean),
    threshold: Number.isFinite(configuredThreshold) && configuredThreshold > 0 && configuredThreshold <= 1
      ? configuredThreshold
      : undefined,
    serviceUrl: String(environment.GLINER_SERVICE_URL || '').trim(),
    apiKey: String(environment.GLINER_SERVICE_API_KEY || '').trim() || undefined,
  };
}
