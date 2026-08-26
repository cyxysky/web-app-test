import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  duplicateExtraRequestParameterKeys,
  parseExtraRequestParameterPairs,
  serializeExtraRequestParameterPairs,
} from './extra-request-parameters';

test('parses saved JSON objects into editable key-value pairs', () => {
  assert.deepEqual(
    parseExtraRequestParameterPairs('{"reasoning_split":true,"thinking":{"type":"adaptive"},"service_tier":"priority"}'),
    [
      { key: 'reasoning_split', value: 'true' },
      { key: 'thinking', value: '{"type":"adaptive"}' },
      { key: 'service_tier', value: '"priority"' },
    ],
  );
});

test('serializes JSON values and treats unquoted values as strings', () => {
  assert.equal(
    serializeExtraRequestParameterPairs([
      { key: 'reasoning_split', value: 'true' },
      { key: 'temperature', value: '0.2' },
      { key: 'thinking', value: '{"type":"adaptive"}' },
      { key: 'service_tier', value: 'priority' },
      { key: '', value: 'ignored' },
    ]),
    '{"reasoning_split":true,"temperature":0.2,"thinking":{"type":"adaptive"},"service_tier":"priority"}',
  );
});

test('detects duplicate non-empty keys', () => {
  assert.deepEqual(duplicateExtraRequestParameterKeys([
    { key: 'temperature', value: '1' },
    { key: '', value: '' },
    { key: 'temperature', value: '0.5' },
  ]), ['temperature']);
});
