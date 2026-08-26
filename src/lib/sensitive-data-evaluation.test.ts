import { describe, expect, it } from 'vitest';
import {
  compareSensitiveDataEvaluationValues,
  normalizeSensitiveDataEvaluationCases,
} from './sensitive-data-evaluation';

describe('sensitive data evaluation helpers', () => {
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
