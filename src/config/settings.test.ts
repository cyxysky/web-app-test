import assert from 'node:assert/strict';
import test from 'node:test';
import {
  modelListForProvider,
  modelProviderDefinition,
  normalizeMiniMaxOpenAIBaseURL,
  normalizeRuntimeEnvValue,
  runtimeEnvDefinition,
} from './settings';

test('MiniMax exposes its official AI SDK endpoint and language models', () => {
  const definition = modelProviderDefinition('minimax');
  assert.equal(definition.defaultModel, 'minimax-m3');
  assert.equal(definition.defaultBaseURL, 'https://api.minimax.io/v1');
  assert.deepEqual(modelListForProvider(definition), [
    'minimax-m3',
    'minimax-m2.7',
    'minimax-m2.7-highspeed',
    'minimax-m2.5',
    'minimax-m2.5-highspeed',
    'minimax-m2.1',
    'minimax-m2.1-highspeed',
    'minimax-m2',
  ]);
});

test('custom OpenAI-compatible APIs have a dedicated provider entry', () => {
  const definition = modelProviderDefinition('openai-compatible');
  assert.equal(definition.label, 'OpenAI 兼容接口');
  assert.equal(definition.defaultModel, 'custom-model');
  assert.equal(definition.baseUrlLabel, '兼容接口 Base URL');
  assert.equal(definition.defaultBaseURL, undefined);
});

test('MiniMax migrates saved official Anthropic endpoints to OpenAI endpoints', () => {
  assert.equal(
    normalizeMiniMaxOpenAIBaseURL('https://api.minimax.io/anthropic/v1'),
    'https://api.minimax.io/v1',
  );
  assert.equal(
    normalizeMiniMaxOpenAIBaseURL('https://api.minimaxi.com/anthropic/v1'),
    'https://api.minimaxi.com/v1',
  );
  assert.equal(
    normalizeMiniMaxOpenAIBaseURL('https://minimax-proxy.example/v1'),
    'https://minimax-proxy.example/v1',
  );
});

test('browser preview FPS setting is a bounded integer input', () => {
  const definition = runtimeEnvDefinition('BROWSER_PREVIEW_FPS');
  assert.ok(definition);
  assert.equal(definition.control, 'number');
  assert.equal(definition.defaultValue, '20');
  assert.equal(definition.min, 1);
  assert.equal(definition.max, 60);
  assert.equal(definition.step, 1);
  assert.equal(normalizeRuntimeEnvValue(definition, '0'), '1');
  assert.equal(normalizeRuntimeEnvValue(definition, '24.6'), '25');
  assert.equal(normalizeRuntimeEnvValue(definition, '100'), '60');
  assert.equal(normalizeRuntimeEnvValue(definition, ''), '20');
});

test('browser preview exposes H.264 video transport with 2K and 4K encoder settings', () => {
  const transport = runtimeEnvDefinition('BROWSER_PREVIEW_TRANSPORT');
  assert.equal(transport?.control, 'select');
  assert.equal(transport?.defaultValue, 'video');
  assert.deepEqual(transport?.options?.map((option) => option.value), ['video', 'image']);

  const bitrate = runtimeEnvDefinition('BROWSER_PREVIEW_VIDEO_BITRATE_KBPS');
  assert.equal(bitrate?.defaultValue, '');
  assert.equal(bitrate?.min, 500);
  assert.equal(bitrate?.max, undefined);
  assert.equal(normalizeRuntimeEnvValue(bitrate!, '100'), '500');
  assert.equal(normalizeRuntimeEnvValue(bitrate!, '120000'), '120000');

  const videoSourceFormat = runtimeEnvDefinition('BROWSER_PREVIEW_VIDEO_SOURCE_FORMAT');
  assert.equal(videoSourceFormat?.defaultValue, 'png');
  assert.deepEqual(videoSourceFormat?.options?.map((option) => option.value), ['png', 'jpeg']);

  assert.equal(runtimeEnvDefinition('BROWSER_PREVIEW_VIDEO_MAX_WIDTH')?.max, 4096);
  assert.equal(runtimeEnvDefinition('BROWSER_PREVIEW_VIDEO_MAX_HEIGHT')?.max, 2160);
  assert.equal(runtimeEnvDefinition('BROWSER_PROFILE_DISK_CACHE_MB'), undefined);
  assert.equal(runtimeEnvDefinition('BROWSER_PROFILE_MEDIA_CACHE_MB'), undefined);

  const idleTimeout = runtimeEnvDefinition('BROWSER_USER_BROWSER_IDLE_TIMEOUT_MS');
  assert.equal(idleTimeout?.defaultValue, '180000');
  assert.equal(idleTimeout?.min, 60000);
  assert.equal(idleTimeout?.max, 86400000);

  assert.equal(runtimeEnvDefinition('FFMPEG_PATH')?.control, 'text');
});

test('browser viewport size and output quality are configured independently', () => {
  const maximize = runtimeEnvDefinition('BROWSER_FULLSCREEN');
  assert.equal(maximize?.label, '浏览器启动时最大化');
  assert.match(maximize?.description || '', /打开实时预览不会改变/);

  const viewport = runtimeEnvDefinition('BROWSER_VIEWPORT_MODE');
  assert.ok(viewport);
  assert.equal(viewport.control, 'select');
  assert.deepEqual(viewport.options?.map((option) => option.value), ['auto', 'fixed']);
  assert.equal(runtimeEnvDefinition('BROWSER_VIEWPORT_RESOLUTION'), undefined);

  const pixelRatio = runtimeEnvDefinition('BROWSER_OUTPUT_PIXEL_RATIO');
  assert.ok(pixelRatio);
  assert.equal(pixelRatio.control, 'number');
  assert.equal(pixelRatio.defaultValue, '1.5');
  assert.equal(pixelRatio.min, 1);
  assert.equal(pixelRatio.max, 2);
  assert.equal(pixelRatio.step, 0.25);
  assert.equal(normalizeRuntimeEnvValue(pixelRatio, '0.5'), '1');
  assert.equal(normalizeRuntimeEnvValue(pixelRatio, '1.6'), '1.5');
  assert.equal(normalizeRuntimeEnvValue(pixelRatio, '3'), '2');

  const format = runtimeEnvDefinition('BROWSER_SCREENCAST_FORMAT');
  assert.ok(format);
  assert.deepEqual(format.options?.map((option) => option.value), ['jpeg', 'png']);
});

test('settings omit unused automatic screenshot and context compression controls', () => {
  for (const key of [
    'SCREENSHOT_STABILIZE_MS',
    'BROWSER_CHAT_DOM_SCREENSHOTS',
    'AI_AGENT_LOOP_SUMMARY_INPUT_MAX_CHARS',
    'AI_AGENT_LOOP_SUMMARY_OUTPUT_MAX_CHARS',
    'AI_VISUAL_COMPRESSED_HISTORY_LIMIT',
    'AI_VISUAL_COMPRESSED_PINNED_LIMIT',
    'AI_PROMPT_SCREENSHOT_REFERENCE_LIMIT',
  ]) {
    assert.equal(runtimeEnvDefinition(key), undefined, `${key} should not be exposed`);
  }
  assert.equal(runtimeEnvDefinition('SEND_SCREENSHOT_TO_AI')?.label, 'AI 图片输入');
});
