import type { SensitiveDataFilterConfig } from './config.js';

type GlinerRedactResponse = {
  texts: string[];
  replacements?: GlinerReplacement[];
};

export type GlinerReplacement = {
  textIndex: number;
  start: number;
  end: number;
  label: string;
  placeholder: string;
};

export type SensitiveDataRedactionResult = {
  texts: string[];
  replacements: GlinerReplacement[];
};

export type SensitiveDataRedactor = (
  texts: string[],
  abortSignal?: AbortSignal,
) => Promise<SensitiveDataRedactionResult>;

export type SensitiveDataRedactorOptions = {
  fetch?: typeof globalThis.fetch;
  getConfig: () => SensitiveDataFilterConfig;
  prepareEndpoint?: (endpoint: string) => Promise<string>;
};

function redactEndpoint(endpoint: string) {
  return new URL('redact', endpoint.endsWith('/') ? endpoint : `${endpoint}/`);
}

function requestSignal(abortSignal: AbortSignal | undefined, timeoutMs: number) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal;
}

function validReplacement(
  value: unknown,
  texts: string[],
): value is GlinerReplacement {
  if (!value || typeof value !== 'object') return false;
  const replacement = value as Partial<GlinerReplacement>;
  return Number.isInteger(replacement.textIndex)
    && Number(replacement.textIndex) >= 0
    && Number(replacement.textIndex) < texts.length
    && Number.isInteger(replacement.start)
    && Number.isInteger(replacement.end)
    && Number(replacement.start) >= 0
    && Number(replacement.end) > Number(replacement.start)
    && Number(replacement.end) <= texts[Number(replacement.textIndex)].length
    && typeof replacement.label === 'string'
    && typeof replacement.placeholder === 'string';
}

export function createSensitiveDataRedactor(options: SensitiveDataRedactorOptions): SensitiveDataRedactor {
  const request = options.fetch || globalThis.fetch;
  if (!request) throw new Error('Sensitive-data filtering requires a Fetch API implementation.');

  return async (texts, abortSignal) => {
    const config = options.getConfig();
    if (!config.serviceUrl) {
      throw new Error('A sensitive-data filtering service URL is required.');
    }
    const endpoint = options.prepareEndpoint
      ? await options.prepareEndpoint(config.serviceUrl)
      : config.serviceUrl;
    const response = await request(redactEndpoint(endpoint), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
      },
      body: JSON.stringify({
        texts,
        ...(config.labels.length ? { labels: config.labels } : {}),
        ...(config.threshold === undefined ? {} : { threshold: config.threshold }),
      }),
      signal: requestSignal(abortSignal, config.timeoutMs),
    });
    if (!response.ok) throw new Error(`Sensitive-data service returned HTTP ${response.status}.`);

    const payload = await response.json() as Partial<GlinerRedactResponse>;
    if (
      !Array.isArray(payload.texts)
      || payload.texts.length !== texts.length
      || payload.texts.some((text) => typeof text !== 'string')
    ) {
      throw new Error('Sensitive-data service returned an invalid response.');
    }
    const replacements = Array.isArray(payload.replacements)
      ? payload.replacements.filter((replacement) => validReplacement(replacement, texts))
      : [];
    return { texts: payload.texts, replacements };
  };
}
