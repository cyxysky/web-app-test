import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { WEBPILOT_EMBED_SDK } from './webpilot-sdk';

function loadSdk(scriptUrl: string) {
  const elements = new Map<string, unknown>();
  const requestedUrls: string[] = [];
  class TestElement {
    attachShadow() {
      return { innerHTML: '', querySelector: () => null };
    }
  }
  const windowObject: Record<string, unknown> = {
    location: {
      href: 'https://angular.example/app',
      origin: 'https://angular.example',
    },
    customElements: {
      define: (name: string, value: unknown) => elements.set(name, value),
      get: (name: string) => elements.get(name),
    },
  };
  const context = {
    console,
    CustomEvent: class TestCustomEvent {},
    document: {
      currentScript: { dataset: {}, src: scriptUrl },
      querySelector: () => null,
    },
    fetch: async (url: string) => {
      requestedUrls.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
      };
    },
    HTMLElement: TestElement,
    URL,
    window: windowObject,
  };
  vm.runInNewContext(WEBPILOT_EMBED_SDK, context);
  return {
    requestedUrls,
    sdk: windowObject.WebPilotQA as {
      apiBaseUrl: string;
      init: (options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
    },
  };
}

test('derives the public base URL from a prefixed SDK script URL', () => {
  const { sdk } = loadSdk('https://angular.example/webpilot/embed/webpilot.js');
  assert.equal(sdk.apiBaseUrl, 'https://angular.example/webpilot');
});

test('resolves a relative apiBaseUrl and keeps its prefix for init', async () => {
  const { requestedUrls, sdk } = loadSdk('https://angular.example/webpilot/embed/webpilot.js');
  await sdk.init({ apiBaseUrl: '/webpilot' });
  assert.deepEqual(requestedUrls, ['https://angular.example/webpilot/api/embed/browser-chat/init']);
});
