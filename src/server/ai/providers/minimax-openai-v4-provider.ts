import type {
  JSONArray,
  JSONObject,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  SharedV4ProviderMetadata,
} from '@ai-sdk/provider';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const reasoningDetailsMarker = '__webpilot_minimax_reasoning_details';

type MiniMaxReasoningDetail = JSONObject & {
  id?: string;
  text?: string;
  type?: string;
};

type MiniMaxOpenAIV4Options = {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
  extraRequestParameters?: Record<string, unknown>;
};

export type MiniMaxOpenAIV4Provider = {
  (modelId: string): LanguageModelV4;
  chat(modelId: string): LanguageModelV4;
  languageModel(modelId: string): LanguageModelV4;
  readonly specificationVersion: 'v4';
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function jsonReasoningDetails(value: unknown): MiniMaxReasoningDetail[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is MiniMaxReasoningDetail => isRecord(item))
    .map((item) => ({ ...item } as MiniMaxReasoningDetail));
}

function reasoningText(details: MiniMaxReasoningDetail[]) {
  return details
    .filter((detail) => !detail.type || detail.type === 'reasoning.text')
    .map((detail) => typeof detail.text === 'string' ? detail.text : '')
    .join('');
}

function mergeReasoningDetails(
  accumulated: MiniMaxReasoningDetail[],
  incoming: MiniMaxReasoningDetail[],
) {
  for (const detail of incoming) {
    const index = accumulated.findIndex((current) => (
      String(current.id || '') === String(detail.id || '')
      && String(current.type || '') === String(detail.type || '')
    ));
    if (index < 0) {
      accumulated.push({ ...detail });
      continue;
    }
    const previous = accumulated[index];
    const previousText = typeof previous.text === 'string' ? previous.text : '';
    const nextText = typeof detail.text === 'string' ? detail.text : '';
    accumulated[index] = {
      ...previous,
      ...detail,
      ...(nextText
        ? { text: nextText.startsWith(previousText) ? nextText : `${previousText}${nextText}` }
        : {}),
    };
  }
  return accumulated;
}

function normalizeMiniMaxPayload(value: unknown, streamReasoning = new Map<string, string>()) {
  if (!isRecord(value) || !Array.isArray(value.choices)) return value;
  let markerDetails: MiniMaxReasoningDetail[] = [];
  const choices = value.choices.map((choiceValue) => {
    if (!isRecord(choiceValue)) return choiceValue;
    const choice = { ...choiceValue };
    for (const key of ['message', 'delta'] as const) {
      if (!isRecord(choice[key])) continue;
      const message = { ...choice[key] };
      const details = jsonReasoningDetails(message.reasoning_details);
      if (!details.length) {
        choice[key] = message;
        continue;
      }
      markerDetails = details;
      let text = reasoningText(details);
      if (key === 'delta') {
        const streamKey = details.map((detail) => `${detail.type || ''}:${detail.id || ''}`).join('|');
        const previous = streamReasoning.get(streamKey) || '';
        if (previous && text.startsWith(previous)) text = text.slice(previous.length);
        streamReasoning.set(streamKey, reasoningText(details));
      }
      message.reasoning_content = text;
      choice[key] = message;
    }
    return choice;
  });
  return {
    ...value,
    choices,
    ...(markerDetails.length ? { [reasoningDetailsMarker]: markerDetails } : {}),
  };
}

function responseHeadersForTransformedBody(response: Response) {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return headers;
}

function transformEventStream(response: Response) {
  if (!response.body) return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const streamReasoning = new Map<string, string>();
  let buffer = '';

  const transformEvent = (event: string) => event.split(/\r?\n/).map((line) => {
    if (!line.startsWith('data:')) return line;
    const rawData = line.slice(5).trimStart();
    if (!rawData || rawData === '[DONE]') return line;
    try {
      return `data: ${JSON.stringify(normalizeMiniMaxPayload(JSON.parse(rawData), streamReasoning))}`;
    } catch {
      return line;
    }
  }).join('\n');

  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || '';
      for (const event of parts) controller.enqueue(encoder.encode(`${transformEvent(event)}\n\n`));
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(transformEvent(buffer)));
    },
  }));

  return new Response(body, {
    headers: responseHeadersForTransformedBody(response),
    status: response.status,
    statusText: response.statusText,
  });
}

async function transformMiniMaxResponse(response: Response) {
  if (!response.ok) return response;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) return transformEventStream(response);
  if (!contentType.includes('json')) return response;
  const text = await response.text();
  try {
    return new Response(JSON.stringify(normalizeMiniMaxPayload(JSON.parse(text))), {
      headers: responseHeadersForTransformedBody(response),
      status: response.status,
      statusText: response.statusText,
    });
  } catch {
    return new Response(text, {
      headers: responseHeadersForTransformedBody(response),
      status: response.status,
      statusText: response.statusText,
    });
  }
}

function miniMaxFetch(fetchImplementation: typeof globalThis.fetch) {
  return async (input: RequestInfo | URL, init?: RequestInit) => (
    transformMiniMaxResponse(await fetchImplementation(input, init))
  );
}

function reasoningDetailsFromPrompt(options: LanguageModelV4CallOptions) {
  return options.prompt
    .filter((message) => message.role === 'assistant')
    .map((message) => {
      for (const part of message.content) {
        if (part.type !== 'reasoning') continue;
        const minimax = part.providerOptions?.minimax;
        const details = isRecord(minimax) ? jsonReasoningDetails(minimax.reasoningDetails) : [];
        if (details.length) return details;
      }
      return [];
    });
}

function transformMiniMaxRequestBody(
  body: Record<string, unknown>,
  promptReasoningDetails: MiniMaxReasoningDetail[][],
  extraRequestParameters: Record<string, unknown>,
) {
  let assistantIndex = 0;
  const messages = Array.isArray(body.messages) ? body.messages.map((messageValue) => {
    if (!isRecord(messageValue) || messageValue.role !== 'assistant') return messageValue;
    const message = { ...messageValue };
    const preserved = promptReasoningDetails[assistantIndex++] || [];
    const reasoning = typeof message.reasoning_content === 'string'
      ? message.reasoning_content
      : typeof message.reasoning === 'string' ? message.reasoning : '';
    if (preserved.length || reasoning) {
      message.reasoning_details = preserved.length
        ? preserved
        : [{ type: 'reasoning.text', text: reasoning }];
      delete message.reasoning_content;
      delete message.reasoning;
    }
    return message;
  }) : body.messages;
  return { ...body, messages, ...extraRequestParameters, reasoning_split: true };
}

function detailsFromMetadata(metadata: SharedV4ProviderMetadata | undefined) {
  const minimax = metadata?.minimax;
  return isRecord(minimax) ? jsonReasoningDetails(minimax.reasoningDetails) : [];
}

function detailsMetadata(details: MiniMaxReasoningDetail[]): SharedV4ProviderMetadata | undefined {
  return details.length ? { minimax: { reasoningDetails: details as JSONArray } } : undefined;
}

function attachReasoningDetails(
  result: LanguageModelV4GenerateResult,
  details: MiniMaxReasoningDetail[],
): LanguageModelV4GenerateResult {
  if (!details.length) return result;
  return {
    ...result,
    content: result.content.map((part) => part.type === 'reasoning'
      ? {
          ...part,
          providerMetadata: {
            ...(part.providerMetadata || {}),
            ...detailsMetadata(details),
          },
        }
      : part),
  };
}

function metadataExtractor() {
  return {
    async extractMetadata({ parsedBody }: { parsedBody: unknown }) {
      const details = isRecord(parsedBody)
        ? jsonReasoningDetails(parsedBody[reasoningDetailsMarker])
        : [];
      return detailsMetadata(details);
    },
    createStreamExtractor() {
      const accumulated: MiniMaxReasoningDetail[] = [];
      return {
        processChunk(parsedChunk: unknown) {
          if (!isRecord(parsedChunk)) return;
          mergeReasoningDetails(accumulated, jsonReasoningDetails(parsedChunk[reasoningDetailsMarker]));
        },
        buildMetadata() {
          return detailsMetadata(accumulated);
        },
      };
    },
  };
}

class MiniMaxOpenAIV4LanguageModel implements LanguageModelV4 {
  readonly specificationVersion = 'v4';
  readonly provider = 'minimax.openai-compatible';
  readonly supportedUrls = {};

  constructor(
    readonly modelId: string,
    private readonly options: Required<Pick<MiniMaxOpenAIV4Options, 'baseURL'>> & MiniMaxOpenAIV4Options,
  ) {}

  private innerModel(callOptions: LanguageModelV4CallOptions) {
    const promptDetails = reasoningDetailsFromPrompt(callOptions);
    const provider = createOpenAICompatible({
      name: 'minimax',
      apiKey: this.options.apiKey,
      baseURL: this.options.baseURL,
      headers: this.options.headers,
      fetch: miniMaxFetch(this.options.fetch || globalThis.fetch),
      includeUsage: true,
      metadataExtractor: metadataExtractor(),
      supportedUrls: () => ({}),
      transformRequestBody: (body) => transformMiniMaxRequestBody(body, promptDetails, this.options.extraRequestParameters || {}),
    });
    return provider(this.modelId);
  }

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const result = await this.innerModel(options).doGenerate(options);
    return attachReasoningDetails(result, detailsFromMetadata(result.providerMetadata));
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    const result = await this.innerModel(options).doStream({ ...options, includeRawChunks: true });
    const accumulated: MiniMaxReasoningDetail[] = [];
    return {
      ...result,
      stream: result.stream.pipeThrough(new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        transform(part, controller) {
          if (part.type === 'raw') {
            if (isRecord(part.rawValue)) {
              mergeReasoningDetails(accumulated, jsonReasoningDetails(part.rawValue[reasoningDetailsMarker]));
            }
            if (options.includeRawChunks) controller.enqueue(part);
            return;
          }
          if (part.type === 'reasoning-end' && accumulated.length) {
            controller.enqueue({
              ...part,
              providerMetadata: {
                ...(part.providerMetadata || {}),
                ...detailsMetadata(accumulated),
              },
            });
            return;
          }
          if (part.type === 'finish' && accumulated.length) {
            controller.enqueue({
              ...part,
              providerMetadata: {
                ...(part.providerMetadata || {}),
                ...detailsMetadata(accumulated),
              },
            });
            return;
          }
          controller.enqueue(part);
        },
      })),
    };
  }
}

export function createMiniMaxOpenAIV4(options: MiniMaxOpenAIV4Options = {}): MiniMaxOpenAIV4Provider {
  const normalizedOptions = {
    ...options,
    baseURL: String(options.baseURL || 'https://api.minimax.io/v1').replace(/\/+$/, ''),
  };
  const createModel = (modelId: string) => new MiniMaxOpenAIV4LanguageModel(modelId, normalizedOptions);
  const provider = ((modelId: string) => createModel(modelId)) as unknown as MiniMaxOpenAIV4Provider;
  provider.chat = createModel;
  provider.languageModel = createModel;
  Object.defineProperty(provider, 'specificationVersion', { value: 'v4' });
  return provider;
}
