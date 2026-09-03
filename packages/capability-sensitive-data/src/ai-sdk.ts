import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider';
import type { SensitiveDataFilterConfig } from './config.js';
import type { SensitiveDataRedactor } from './client.js';

type TextTransform = (value: string) => string;

const placeholderPattern = /^\[SENSITIVE_[A-Z0-9_]+_\d+\]$/;

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
        if (item.type === 'text' && typeof item.text === 'string') return { ...item, text: transform(item.text) };
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
  if (part.type === 'tool-call') return { ...part, input: mapUnknownStrings(part.input, transform) } as T;
  if (part.type === 'tool-result') return { ...part, output: mapToolResultOutput(part.output, transform) } as T;
  if (part.type === 'tool-approval-response' && typeof part.reason === 'string') {
    return { ...part, reason: transform(part.reason) } as T;
  }
  return part;
}

export function mapAiSdkPromptStrings(
  prompt: LanguageModelV4Prompt,
  transform: TextTransform,
): LanguageModelV4Prompt {
  return prompt.map((message) => {
    if (message.role === 'system') return { ...message, content: transform(message.content) };
    return {
      ...message,
      content: message.content.map((part) => mapContentPart(part, transform)),
    } as LanguageModelV4Prompt[number];
  });
}

export function createAiSdkSensitiveDataFilter(options: {
  getConfig: () => SensitiveDataFilterConfig;
  redact: SensitiveDataRedactor;
  onFailOpen?: (error: unknown) => void;
}) {
  return async (callOptions: LanguageModelV4CallOptions): Promise<LanguageModelV4CallOptions> => {
    const config = options.getConfig();
    if (!config.enabled) return callOptions;
    try {
      const collected: string[] = [];
      mapAiSdkPromptStrings(callOptions.prompt, (value) => {
        collected.push(value);
        return value;
      });
      if (!collected.length) return callOptions;

      const uniqueTexts: string[] = [];
      const uniqueIndexes = new Map<string, number>();
      const collectedIndexes = collected.map((text) => {
        if (!text.trim() || placeholderPattern.test(text)) return -1;
        const existing = uniqueIndexes.get(text);
        if (existing !== undefined) return existing;
        const index = uniqueTexts.length;
        uniqueTexts.push(text);
        uniqueIndexes.set(text, index);
        return index;
      });
      if (!uniqueTexts.length) return callOptions;

      const redaction = await options.redact(uniqueTexts, callOptions.abortSignal);
      const redactedTexts = collected.map((text, index) => {
        const uniqueIndex = collectedIndexes[index];
        return uniqueIndex < 0 ? text : redaction.texts[uniqueIndex];
      });
      let redactedIndex = 0;
      return {
        ...callOptions,
        prompt: mapAiSdkPromptStrings(callOptions.prompt, () => redactedTexts[redactedIndex++]),
      };
    } catch (error) {
      if (config.failureMode === 'open') {
        options.onFailOpen?.(error);
        return callOptions;
      }
      throw new Error('Sensitive-data filtering failed; the AI request was blocked.', { cause: error });
    }
  };
}
