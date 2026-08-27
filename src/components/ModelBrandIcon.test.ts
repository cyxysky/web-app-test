import { describe, expect, it } from 'vitest';
import { modelBrandName } from './ModelBrandIcon';

describe('modelBrandName', () => {
  it('matches the model family before the configured provider', () => {
    expect(modelBrandName('deepseek-v4-flash', 'openai-compatible')).toBe('deepseek');
    expect(modelBrandName('MiniMax-M3', 'openai-compatible')).toBe('minimax');
    expect(modelBrandName('meta-llama/Llama-3.3-70B', 'togetherai')).toBe('meta');
    expect(modelBrandName('claude-sonnet-4-5', 'openrouter')).toBe('anthropic');
    expect(modelBrandName('qwen3.6-27b', 'ollama')).toBe('qwen');
  });

  it('falls back to the provider brand for custom model names', () => {
    expect(modelBrandName('custom-model', 'deepseek')).toBe('deepseek');
    expect(modelBrandName('custom-model', 'openai-compatible')).toBeUndefined();
  });
});
