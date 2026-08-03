import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { browserSessionGroupLabel } from './browser-session-group';

test('uses one stable short label for a browser conversation group', () => {
  assert.equal(browserSessionGroupLabel('chat_5ebaac21fdeb'), 'ai-21fdeb');
  assert.equal(browserSessionGroupLabel(' chat_5ebaac21fdeb '), 'ai-21fdeb');
  assert.equal(browserSessionGroupLabel('browser-code-tab-group-test'), 'ai-p-test');
});

test('the Chrome tab-group extension uses the same canonical label', () => {
  const source = readFileSync(path.join(
    process.cwd(),
    'src/server/browser/session-tab-grouper-extension/group-title.js',
  ), 'utf8');
  const sandbox: { result?: string } = {};
  runInNewContext(`${source}\nglobalThis.result = aiWebTestSessionGroupTitle('chat_5ebaac21fdeb');`, sandbox);
  assert.equal(sandbox.result, browserSessionGroupLabel('chat_5ebaac21fdeb'));
});
