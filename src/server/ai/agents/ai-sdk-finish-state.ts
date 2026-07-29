export type AiSdkFinishState = {
  finishReason?: string;
  retryRequest: boolean;
  terminatesTurn: boolean;
  status: 'passed' | 'failed' | 'blocked';
};

function normalizedFinishReason(value: unknown) {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as { raw?: unknown; unified?: unknown };
  if (typeof record.unified === 'string' && record.unified.trim()) return record.unified.trim();
  if (typeof record.raw === 'string' && record.raw.trim()) return record.raw.trim();
  return undefined;
}

export function aiSdkFinishState(value: unknown, options: { runtimeContinuationRequired?: boolean } = {}): AiSdkFinishState {
  const finishReason = normalizedFinishReason(value);
  if (options.runtimeContinuationRequired) {
    return { finishReason, retryRequest: false, terminatesTurn: false, status: 'passed' };
  }
  if (!finishReason || finishReason === 'tool-calls') {
    return { finishReason, retryRequest: false, terminatesTurn: false, status: 'passed' };
  }
  if (finishReason === 'stop') {
    return { finishReason, retryRequest: false, terminatesTurn: true, status: 'passed' };
  }
  if (finishReason === 'error') {
    return { finishReason, retryRequest: true, terminatesTurn: false, status: 'failed' };
  }
  if (finishReason === 'content-filter') {
    return { finishReason, retryRequest: false, terminatesTurn: true, status: 'blocked' };
  }
  return { finishReason, retryRequest: false, terminatesTurn: true, status: 'failed' };
}

export function aiSdkFinishMessage(finishReason?: string) {
  if (finishReason === 'length') return 'AI 回复因达到模型输出长度限制而结束。';
  if (finishReason === 'content-filter') return 'AI 回复被模型内容过滤器终止。';
  if (finishReason === 'error') return 'AI 请求返回了错误结束状态。';
  if (finishReason === 'other') return 'AI 请求已结束，但模型没有返回可识别的结束原因。';
  if (finishReason === 'stop') return 'AI 已正常结束本轮，但没有返回可展示的文本。';
  return `AI 请求已结束，结束原因：${finishReason || 'unknown'}。`;
}
