import assert from 'node:assert/strict';
import test from 'node:test';
import { aiStreamTimeouts } from './ai-sdk-runtime';

test('does not let stream timeouts expire while a tool is still allowed to run', () => {
  const original = {
    request: process.env.AI_REQUEST_TIMEOUT_MS,
    firstChunk: process.env.AI_STREAM_FIRST_CHUNK_TIMEOUT_MS,
    chunk: process.env.AI_STREAM_CHUNK_TIMEOUT_MS,
    tool: process.env.AI_TOOL_TIMEOUT_MS,
  };

  process.env.AI_REQUEST_TIMEOUT_MS = '30000';
  process.env.AI_STREAM_FIRST_CHUNK_TIMEOUT_MS = '20000';
  process.env.AI_STREAM_CHUNK_TIMEOUT_MS = '15000';
  process.env.AI_TOOL_TIMEOUT_MS = '120000';

  try {
    assert.deepEqual(aiStreamTimeouts(), {
      firstChunkMs: 30000,
      chunkMs: 150000,
      toolMs: 120000,
    });
  } finally {
    for (const [key, value] of Object.entries({
      AI_REQUEST_TIMEOUT_MS: original.request,
      AI_STREAM_FIRST_CHUNK_TIMEOUT_MS: original.firstChunk,
      AI_STREAM_CHUNK_TIMEOUT_MS: original.chunk,
      AI_TOOL_TIMEOUT_MS: original.tool,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
