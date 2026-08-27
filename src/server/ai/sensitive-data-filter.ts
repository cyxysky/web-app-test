import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider';
import { prepareGlinerService } from './gliner-local-runtime';

type TextTransform = (value: string) => string;

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

const DEFAULT_TIMEOUT_MS = 60_000;
const PLACEHOLDER_PATTERN = /^\[SENSITIVE_[A-Z0-9_]+_\d+\]$/;
let lastFailOpenWarningAt = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mapUnknownStrings<T>(value: T, transform: TextTransform): T {
  if (typeof value === 'string') return transform(value) as T;
  if (Array.isArray(value)) return value.map((item) => mapUnknownStrings(item, transform)) as T;
  if (!isRecord(value)) return value;

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, mapUnknownStrings(item, transform)]),
  ) as T;
}

function mapFileData<T>(data: T, transform: TextTransform): T {
  if (!isRecord(data) || data.type !== 'text' || typeof data.text !== 'string') return data;
  return { ...data, text: transform(data.text) } as T;
}

function mapToolResultOutput<T>(output: T, transform: TextTransform): T {
  if (!isRecord(output) || typeof output.type !== 'string') return output;

  if ((output.type === 'text' || output.type === 'error-text') && typeof output.value === 'string') {
    return { ...output, value: transform(output.value) } as T;
  }
  if (output.type === 'json' || output.type === 'error-json') {
    return { ...output, value: mapUnknownStrings(output.value, transform) } as T;
  }
  if (output.type === 'execution-denied' && typeof output.reason === 'string') {
    return { ...output, reason: transform(output.reason) } as T;
  }
  if (output.type === 'content' && Array.isArray(output.value)) {
    return {
      ...output,
      value: output.value.map((item) => {
        if (!isRecord(item)) return item;
        if (item.type === 'text' && typeof item.text === 'string') {
          return { ...item, text: transform(item.text) };
        }
        if (item.type === 'file') {
          return {
            ...item,
            filename: typeof item.filename === 'string' ? transform(item.filename) : item.filename,
            data: mapFileData(item.data, transform),
          };
        }
        return item;
      }),
    } as T;
  }
  return output;
}

function mapContentPart<T>(part: T, transform: TextTransform): T {
  if (!isRecord(part) || typeof part.type !== 'string') return part;

  if ((part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string') {
    return { ...part, text: transform(part.text) } as T;
  }
  if (part.type === 'file') {
    return {
      ...part,
      filename: typeof part.filename === 'string' ? transform(part.filename) : part.filename,
      data: mapFileData(part.data, transform),
    } as T;
  }
  if (part.type === 'tool-call') {
    return { ...part, input: mapUnknownStrings(part.input, transform) } as T;
  }
  if (part.type === 'tool-result') {
    return { ...part, output: mapToolResultOutput(part.output, transform) } as T;
  }
  if (part.type === 'tool-approval-response' && typeof part.reason === 'string') {
    return { ...part, reason: transform(part.reason) } as T;
  }
  return part;
}

function mapPromptStrings(prompt: LanguageModelV4Prompt, transform: TextTransform): LanguageModelV4Prompt {
  return prompt.map((message) => {
    if (message.role === 'system') {
      return { ...message, content: transform(message.content) };
    }
    return {
      ...message,
      content: message.content.map((part) => mapContentPart(part, transform)),
    } as LanguageModelV4Prompt[number];
  });
}

function filterEnabled() {
  return process.env.AI_SENSITIVE_DATA_FILTER_ENABLED === 'true';
}

function failOpen() {
  return String(process.env.AI_SENSITIVE_DATA_FILTER_FAILURE_MODE || 'closed').trim().toLowerCase() === 'open';
}

function requestTimeoutMs() {
  const configured = Number(process.env.AI_SENSITIVE_DATA_FILTER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.min(configured, 600_000) : DEFAULT_TIMEOUT_MS;
}

function configuredLabels() {
  return String(process.env.AI_SENSITIVE_DATA_FILTER_LABELS || '')
    .split(/[,\n]/)
    .map((label) => label.trim())
    .filter(Boolean);
}

function configuredThreshold() {
  const threshold = Number(process.env.AI_SENSITIVE_DATA_FILTER_THRESHOLD || '');
  return Number.isFinite(threshold) && threshold > 0 && threshold <= 1 ? threshold : undefined;
}

async function serviceEndpoint() {
  const baseURL = String(process.env.GLINER_SERVICE_URL || '').trim();
  if (!baseURL) throw new Error('GLINER_SERVICE_URL is required when the sensitive-data filter is enabled.');
  const endpoint = await prepareGlinerService(baseURL);
  return new URL('redact', endpoint.endsWith('/') ? endpoint : `${endpoint}/`);
}

function requestSignal(abortSignal: AbortSignal | undefined) {
  const timeoutSignal = AbortSignal.timeout(requestTimeoutMs());
  return abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal;
}

function safeFailureMessage(error: unknown) {
  if (error instanceof Error) return error.name;
  return 'Unknown GLiNER filtering error';
}

function warnFailOpen(error: unknown) {
  const now = Date.now();
  if (now - lastFailOpenWarningAt < 30_000) return;
  lastFailOpenWarningAt = now;
  console.warn(`[sensitive-data-filter] GLiNER filtering failed; fail-open is enabled. ${safeFailureMessage(error)}`);
}

export async function redactSensitiveTexts(
  texts: string[],
  abortSignal?: AbortSignal,
): Promise<SensitiveDataRedactionResult> {
  const labels = configuredLabels();
  const threshold = configuredThreshold();
  const apiKey = String(process.env.GLINER_SERVICE_API_KEY || '').trim();
  const response = await fetch(await serviceEndpoint(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    },
    body: JSON.stringify({
      texts,
      ...(labels.length ? { labels } : {}),
      ...(threshold === undefined ? {} : { threshold }),
    }),
    signal: requestSignal(abortSignal),
  });

  if (!response.ok) {
    throw new Error(`GLiNER service returned HTTP ${response.status}.`);
  }
  const payload = await response.json() as Partial<GlinerRedactResponse>;
  if (!Array.isArray(payload.texts) || payload.texts.length !== texts.length || payload.texts.some((text) => typeof text !== 'string')) {
    throw new Error('GLiNER service returned an invalid response.');
  }
  const replacements = Array.isArray(payload.replacements)
    ? payload.replacements.filter((replacement): replacement is GlinerReplacement => (
      Boolean(replacement)
      && Number.isInteger(replacement.textIndex)
      && replacement.textIndex >= 0
      && replacement.textIndex < texts.length
      && Number.isInteger(replacement.start)
      && Number.isInteger(replacement.end)
      && replacement.start >= 0
      && replacement.end > replacement.start
      && replacement.end <= texts[replacement.textIndex].length
      && typeof replacement.label === 'string'
      && typeof replacement.placeholder === 'string'
    ))
    : [];
  return { texts: payload.texts, replacements };
}

/**
 * Redacts every model-visible text value immediately before an AI provider call.
 * Protocol fields such as roles, part types, tool names and tool-call IDs are
 * intentionally left untouched so the AI SDK conversation remains valid.
 */
export async function filterSensitiveData(
  options: LanguageModelV4CallOptions,
): Promise<LanguageModelV4CallOptions> {
  if (!filterEnabled()) return options;

  try {
    const collected: string[] = [];
    mapPromptStrings(options.prompt, (value) => {
      collected.push(value);
      return value;
    });

    if (!collected.length) return options;

    const uniqueTexts: string[] = [];
    const uniqueIndexes = new Map<string, number>();
    const collectedIndexes = collected.map((text) => {
      if (!text.trim() || PLACEHOLDER_PATTERN.test(text)) return -1;
      const existing = uniqueIndexes.get(text);
      if (existing !== undefined) return existing;
      const index = uniqueTexts.length;
      uniqueTexts.push(text);
      uniqueIndexes.set(text, index);
      return index;
    });

    if (!uniqueTexts.length) return options;
    const redaction = await redactSensitiveTexts(uniqueTexts, options.abortSignal);
    const redactedTexts = collected.map((text, index) => {
      const uniqueIndex = collectedIndexes[index];
      return uniqueIndex < 0 ? text : redaction.texts[uniqueIndex];
    });

    let redactedIndex = 0;
    return {
      ...options,
      prompt: mapPromptStrings(options.prompt, () => redactedTexts[redactedIndex++]),
    };
  } catch (error) {
    if (failOpen()) {
      warnFailOpen(error);
      return options;
    }
    throw new Error('Sensitive-data filtering failed; the AI request was blocked.', { cause: error });
  }
}
