import assert from 'node:assert/strict';
import test from 'node:test';
import { browserChatToolValidationSummary } from './browser-chat-tool-error';

test('summarizes validation errors without exposing the raw tool payload', () => {
  const error = 'Invalid input for tool file: AI_TypeValidationError: Type validation failed: Value: {"reason":"long raw value","blocks":""}.\nError message: [\n  {\n    "expected": "array",\n    "code": "invalid_type",\n    "path": ["blocks"],\n    "message": "Invalid input: expected array, received string"\n  },\n  {\n    "expected": "boolean",\n    "code": "invalid_type",\n    "path": ["render"],\n    "message": "Invalid input: expected boolean, received string"\n  }\n]';
  const summary = browserChatToolValidationSummary(error);
  assert.equal(summary, 'blocks：应为 array，实际为 string；render：应为 boolean，实际为 string');
  assert.doesNotMatch(summary, /long raw value|Value:/);
});

test('uses a bounded generic summary when no structured issues are available', () => {
  assert.equal(
    browserChatToolValidationSummary('Invalid input for tool file'),
    '工具输入不符合 schema；请打开详情查看完整错误',
  );
});
