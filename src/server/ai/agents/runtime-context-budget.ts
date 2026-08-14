export function runtimeContextWindowTokens() {
  const raw = Number(process.env.AI_CONTEXT_WINDOW_TOKENS || process.env.AI_MODEL_CONTEXT_TOKENS || '');
  if (Number.isFinite(raw) && raw > 1000) return Math.floor(raw);
  return 256000;
}

export function runtimeContextCompressionThresholdRatio() {
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
