import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserChatToolFailureSummary,
  browserChatToolValidationSummary,
} from './browser-chat-tool-error';

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

test('summarizes nested office source validation failures and ignores secondary warnings', () => {
  const value = {
    ok: false,
    actual: JSON.stringify({
      kind: 'uno-draft-validation',
      validation: 'failed',
      diagnostics: [
        { code: 'JS1005', line: 414, column: 54, message: "'}' expected.", severity: 'error' },
        { code: 'OUTPUT_WRITE_NOT_OBSERVED', message: 'No definite write was observed.', severity: 'warning' },
      ],
      error: "414:54 '}' expected.",
    }),
    failureCategory: 'file-workflow',
  };

  assert.equal(
    browserChatToolFailureSummary(value),
    '文件源码第 414 行第 54 列语法错误：缺少“}”（草稿已保留）',
  );
});

test('labels presentation layout diagnostics by their actual failure category', () => {
  assert.equal(
    browserChatToolFailureSummary({
      kind: 'uno-draft-validation',
      validation: 'failed',
      diagnostics: [{
        code: 'PRESENTATION_OVERLAP',
        line: 377,
        column: 1,
        message: "Presentation content 'p14/ft' overlaps existing 'p14/card'",
        severity: 'error',
      }],
    }),
    "文件源码第 377 行第 1 列布局重叠：Presentation content 'p14/ft' overlaps existing 'p14/card'（草稿已保留）",
  );
});

test('does not relabel unrelated tool failures as source validation failures', () => {
  assert.equal(browserChatToolFailureSummary({ ok: false, error: 'network error' }), undefined);
});
