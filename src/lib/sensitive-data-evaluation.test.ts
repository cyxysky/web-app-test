import { describe, expect, it } from 'vitest';
import {
  compareSensitiveDataEvaluationValues,
  DEFAULT_SENSITIVE_DATA_EVALUATION_CASES,
  normalizeSensitiveDataEvaluationCases,
} from './sensitive-data-evaluation';

describe('sensitive data evaluation helpers', () => {
  it('provides three realistic mixed scenarios with at least ten sensitive values each', () => {
    expect(DEFAULT_SENSITIVE_DATA_EVALUATION_CASES).toHaveLength(3);
    for (const item of DEFAULT_SENSITIVE_DATA_EVALUATION_CASES) {
      expect(item.text.split('\n').length).toBeGreaterThanOrEqual(8);
      expect(item.expectedValues.length).toBeGreaterThanOrEqual(10);
      expect(item.expectedValues).toHaveLength(21);
      for (const value of item.expectedValues) expect(item.text).toContain(value);
    }
  });

  it('normalizes cases and removes duplicate expected values', () => {
    expect(normalizeSensitiveDataEvaluationCases([
      {
        id: 'email',
        name: ' Email ',
        text: 'Contact a@example.com',
        expectedValues: ['a@example.com', ' A@EXAMPLE.COM ', ''],
      },
      { id: 'empty', text: '   ', expectedValues: [] },
    ])).toEqual([{
      id: 'email',
      name: 'Email',
      text: 'Contact a@example.com',
      expectedValues: ['a@example.com'],
    }]);
  });

  it('reports matched, missing, and unexpected values', () => {
    expect(compareSensitiveDataEvaluationValues(
      ['a@example.com', '13800138000'],
      ['A@example.com', '10.0.0.1'],
    )).toEqual({
      passed: false,
      matchedValues: ['a@example.com'],
      missingValues: ['13800138000'],
      unexpectedValues: ['10.0.0.1'],
    });
  });
});
