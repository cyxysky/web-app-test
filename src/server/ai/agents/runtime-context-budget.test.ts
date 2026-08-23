import assert from 'node:assert/strict';
import test from 'node:test';
import {
  estimateRuntimeMessageContext,
  estimateRuntimeTextTokens,
  runtimeContextCompressionThresholdRatio,
  runtimeContextWindowTokens,
} from './runtime-context-budget';

test('uses the configured one-million-token GLM context without an early compression threshold', () => {
  const originalGlm = process.env.AI_GLM_CONTEXT_WINDOW_TOKENS;
  const originalGlobal = process.env.AI_CONTEXT_WINDOW_TOKENS;
  process.env.AI_GLM_CONTEXT_WINDOW_TOKENS = '1000000';
  process.env.AI_CONTEXT_WINDOW_TOKENS = '256000';

  try {
    assert.equal(runtimeContextWindowTokens({ model: 'glm-5.3' }), 1_000_000);
    assert.equal(runtimeContextCompressionThresholdRatio({ model: 'glm-5.3' }), 0.85);
    assert.equal(runtimeContextWindowTokens({ model: 'other-model' }), 256_000);
  } finally {
    if (originalGlm === undefined) delete process.env.AI_GLM_CONTEXT_WINDOW_TOKENS;
    else process.env.AI_GLM_CONTEXT_WINDOW_TOKENS = originalGlm;
    if (originalGlobal === undefined) delete process.env.AI_CONTEXT_WINDOW_TOKENS;
    else process.env.AI_CONTEXT_WINDOW_TOKENS = originalGlobal;
  }
});

test('estimates non-zero context from persisted conversation messages', () => {
  const estimate = estimateRuntimeMessageContext([
    { role: 'user', content: '请帮我分析这个 React 项目' },
    { role: 'assistant', content: '我会先检查项目结构。' },
  ]);

  assert.ok(estimate.textTokens > 0);
  assert.equal(estimate.imageTokens, 0);
  assert.equal(estimate.totalTokens, estimate.textTokens);
});

test('counts image parts without treating base64 image data as text', () => {
  const estimate = estimateRuntimeMessageContext([{
    role: 'user',
    content: [
      { type: 'text', text: '查看图片' },
      { type: 'image', data: 'data:image/png;base64,' + 'a'.repeat(50_000) },
    ],
  }]);

  assert.equal(estimate.imageCount, 1);
  assert.ok(estimate.imageTokens > 0);
  assert.ok(estimate.textTokens < estimateRuntimeTextTokens('a'.repeat(50_000)));
});
