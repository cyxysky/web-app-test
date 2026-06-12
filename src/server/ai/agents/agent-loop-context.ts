export type AgentLoopContextBudget = {
  estimatedTokens: number;
  windowTokens: number;
  thresholdTokens: number;
  thresholdRatio: number;
  imageCount: number;
  usageRatio: number;
  overThreshold: boolean;
};

export type ContextCompressionDetails = {
  turn: number;
  estimatedTokensBefore: number;
  thresholdTokens: number;
  thresholdRatio: number;
  windowTokens: number;
  beforeImageCount: number;
  afterImageCount: number;
  removedFrames: number;
  secondPass?: 'keepLatestOnly';
  estimatedTokensAfterFirstPass?: number;
  estimatedTokensAfter?: number;
};

export function contextWindowTokens() {
  const raw = Number(process.env.AI_CONTEXT_WINDOW_TOKENS || process.env.AI_MODEL_CONTEXT_TOKENS || '');
  if (Number.isFinite(raw) && raw > 1000) return Math.floor(raw);
  return 32000;
}

export function contextCompressionThresholdRatio() {
  const raw = Number(process.env.AI_CONTEXT_COMPRESSION_THRESHOLD || process.env.AI_CONTEXT_COMPRESSION_RATIO || 0.7);
  if (!Number.isFinite(raw) || raw <= 0) return 0.7;
  return raw > 1 ? Math.min(0.98, raw / 100) : Math.min(0.98, raw);
}

export function estimateTextTokens(text: string) {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) {
    if (char.charCodeAt(0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4 + nonAscii);
}

export function estimateContextTokens(text: string, imageCount: number) {
  const imageTokens = Math.max(0, Number(process.env.AI_IMAGE_CONTEXT_ESTIMATE_TOKENS || 1200));
  return estimateTextTokens(text) + imageCount * imageTokens;
}

export function estimateAgentLoopContextBudget(text: string, imageCount: number): AgentLoopContextBudget {
  const windowTokens = contextWindowTokens();
  const thresholdRatio = contextCompressionThresholdRatio();
  const thresholdTokens = Math.floor(windowTokens * thresholdRatio);
  const estimatedTokens = estimateContextTokens(text, imageCount);
  return {
    estimatedTokens,
    windowTokens,
    thresholdTokens,
    thresholdRatio,
    imageCount,
    usageRatio: Number((estimatedTokens / Math.max(1, windowTokens)).toFixed(4)),
    overThreshold: estimatedTokens > thresholdTokens,
  };
}

export function buildCompressionNote(details?: ContextCompressionDetails) {
  if (!details) return '';
  return [
    'Context budget manager:',
    `- Estimated context exceeded ${Math.round(details.thresholdRatio * 100)}%; historical visual frames and working memory were compressed.`,
    '- This request is a single reconstructed prompt built from current visual context, compact memory, and recent tool summaries.',
    details.secondPass === 'keepLatestOnly'
      ? '- Second pass kept only the latest actionable visual frame because the compacted prompt was still above threshold.'
      : '',
  ].filter(Boolean).join('\n');
}
