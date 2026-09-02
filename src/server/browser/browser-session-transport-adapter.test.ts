import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBrowserSessionTransportAdapter } from '@webpilot/capability-browser/node';

test('browser transport adapters are mutually exclusive and priority ordered', () => {
  assert.deepEqual(resolveBrowserSessionTransportAdapter({
    cdpEndpoint: 'http://127.0.0.1:9222',
    electronEmbedded: true,
    shared: true,
    userDataDir: 'profile',
  }), { kind: 'shared', ownership: 'shared' });

  assert.deepEqual(resolveBrowserSessionTransportAdapter({
    cdpEndpoint: 'http://127.0.0.1:9222',
    electronEmbedded: true,
    shared: false,
  }), { kind: 'electron-cdp', ownership: 'connected' });

  assert.deepEqual(resolveBrowserSessionTransportAdapter({
    autoTabGroupCdpEndpoint: 'http://127.0.0.1:9333',
    electronEmbedded: false,
    shared: false,
    userDataDir: 'profile',
  }), { kind: 'persistent-cdp', ownership: 'connected' });

  assert.deepEqual(resolveBrowserSessionTransportAdapter({
    electronEmbedded: false,
    shared: false,
  }), { kind: 'launched', ownership: 'launched' });
});
