export type RuntimeContextModel = {
  provider?: string;
  model?: string;
};

function isGlmModel(input: RuntimeContextModel) {
  return /(^|[\/:._-])glm(?:[\/:._-]|$)/i.test(String(input.model || '').trim());
}

export function runtimeContextWindowTokens(input: RuntimeContextModel = {}) {
  if (isGlmModel(input)) {
    const glmRaw = Number(process.env.AI_GLM_CONTEXT_WINDOW_TOKENS || '');
    if (Number.isFinite(glmRaw) && glmRaw > 1000) return Math.floor(glmRaw);
    return 1_000_000;
  }
  const raw = Number(process.env.AI_CONTEXT_WINDOW_TOKENS || process.env.AI_MODEL_CONTEXT_TOKENS || '');
  if (Number.isFinite(raw) && raw > 1000) return Math.floor(raw);
  return 256000;
}

export function runtimeContextCompressionThresholdRatio(input: RuntimeContextModel = {}) {
  void input;
  return 0.85;
}

export function runtimeContextCompressionTargetFloorRatio() {
  return 0.1;
}

export function runtimeContextCompressionTargetCeilingRatio() {
  return 0.2;
}

export function estimateRuntimeTextTokens(text: string) {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) {
    if (char.charCodeAt(0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4 + nonAscii);
}

export type RuntimeMessageContextEstimate = {
  imageCount: number;
  imageTokens: number;
  textTokens: number;
  totalTokens: number;
};

function runtimeImageContextEstimateTokens() {
  const configured = Number(process.env.AI_IMAGE_CONTEXT_ESTIMATE_TOKENS || 1200);
  return Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : 1200;
}

export function estimateRuntimeMessageContext(messages: unknown): RuntimeMessageContextEstimate {
  const text: string[] = [];
  const visited = new WeakSet<object>();
  let imageCount = 0;

  const walk = (value: unknown, key = '') => {
    if (typeof value === 'string') {
      if (key === 'data' || key === 'image' || value.startsWith('data:image/')) return;
      text.push(value);
      return;
    }
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item));
      return;
    }
    const record = value as Record<string, unknown>;
    const mediaType = typeof record.mediaType === 'string'
      ? record.mediaType
      : typeof record.type === 'string'
        ? record.type
        : '';
    const isImage = record.type === 'image'
      || mediaType.startsWith('image/')
      || (record.image !== undefined && typeof record.image !== 'string');
    if (isImage) imageCount += 1;
    for (const [childKey, child] of Object.entries(record)) {
      if (isImage && (childKey === 'data' || childKey === 'image')) continue;
      walk(child, childKey);
    }
  };

  walk(messages);
  const messageOverhead = Array.isArray(messages) ? messages.length * 4 : 0;
  const textTokens = estimateRuntimeTextTokens(text.join('\n')) + messageOverhead;
  const imageTokens = imageCount * runtimeImageContextEstimateTokens();
  return {
    imageCount,
    imageTokens,
    textTokens,
    totalTokens: textTokens + imageTokens,
  };
}
