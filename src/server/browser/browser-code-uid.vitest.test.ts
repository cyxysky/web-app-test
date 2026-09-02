import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { chromium, type Browser, type BrowserContext, type BrowserServer, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BrowserCodeKernel,
  type BrowserCodeUidReference,
} from '@webpilot/capability-browser/node';

describe('browserCode UID locators and zero-match diagnostics', () => {
  let browserServer: BrowserServer;
  let browser: Browser;
  let browserContext: BrowserContext;
  let page: Page;
  let kernel: BrowserCodeKernel;
  let cdpEndpoint: string;

  async function availablePort() {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (!address || typeof address === 'string') throw new Error('Unable to allocate test CDP port.');
    return address.port;
  }

  beforeAll(async () => {
    const port = await availablePort();
    browserServer = await chromium.launchServer({ headless: true, args: [`--remote-debugging-port=${port}`] });
    browser = await chromium.connect(browserServer.wsEndpoint());
    browserContext = await browser.newContext();
    page = await browserContext.newPage();
    cdpEndpoint = `http://127.0.0.1:${port}`;
    kernel = new BrowserCodeKernel({ protocol: 'cdp', endpoint: cdpEndpoint });
  }, 30_000);

  afterAll(async () => {
    await kernel.close();
    await browser.close().catch(() => undefined);
    await browserServer.close().catch(() => undefined);
  });

  async function run(code: string, uidReferences: BrowserCodeUidReference[] = []) {
    const executionId = randomUUID();
    await page.evaluate((id) => {
      Object.defineProperty(window, '__aiBrowserCodeExecutionId', {
        configurable: true,
        value: id,
      });
    }, executionId);
    return kernel.execute({ code, executionId, uidReferences });
  }

  it('turns an exposed DOM UID into a governed Locator and rejects unknown UIDs', async () => {
    await page.setContent('<button id="uid-save" onclick="document.body.dataset.uidClicked=\'true\'">Save by UID</button>');
    await page.evaluate(() => {
      Object.defineProperty(window, '__aiDomRuntime', {
        configurable: true,
        value: {
          visibleDomElement: (ref: string) => ref === '7' ? document.querySelector('#uid-save') : undefined,
          visibleDomSnapshot: () => ({
            items: [{
              ref: '7',
              tag: 'button',
              label: 'Save by UID',
              descriptor: 'button#uid-save',
              line: '<button node_id=7 id="uid-save">Save by UID</button>',
              surfaceId: undefined,
              capabilities: ['click'],
              locatorCandidates: ['#uid-save'],
              priority: 80,
            }],
          }),
          pageObservation: () => ({
            epoch: 12,
            url: location.href,
            title: document.title,
            surfaces: [],
            surfaceStack: [],
            topSurfaceIds: [],
            surfaceTransition: 'initial',
          }),
        },
      });
    });
    const uidReferences: BrowserCodeUidReference[] = [{
      uid: 'dom-1-7',
      observationId: 'dom-observation-1',
      localRef: '7',
      label: 'Save by UID',
      descriptor: 'button#uid-save',
      line: '<button uid=dom-1-7 id="uid-save">Save by UID</button>',
      capabilities: ['click'],
    }];

    const result = await run(`
      var uidVitestButton = page.getByUid('dom-1-7');
      await uidVitestButton.click();
      nodeRepl.write({
        clicked: await page.locator('body').getAttribute('data-uid-clicked'),
        getByUidType: typeof page.getByUid,
      });
    `, uidReferences);

    expect(result.ok, result.error).toBe(true);
    expect(result.value).toEqual({ clicked: 'true', getByUidType: 'function' });
    await expect(page.locator('#uid-save').getAttribute('data-ai-browser-code-uid')).resolves.toBeNull();

    const stale = await run(`page.getByUid('dom-9-9');`, uidReferences);
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatch(/STALE_DOM_EVIDENCE: UID dom-9-9 is not an exposed current DOM UID/i);

    const diagnosed = await run(`
      await page.getByRole('button', { name: 'Missing save button', exact: true }).click();
    `, uidReferences);
    expect(diagnosed.error).toContain('"uid":"dom-1-7"');
  });

  it('returns ranked visible candidates when a locator matches zero elements', async () => {
    await page.setContent('<button data-testid="create-department">创建部门（总公司）</button>');
    await page.evaluate(() => {
      delete (window as Window & { __aiDomRuntime?: unknown }).__aiDomRuntime;
    });

    const result = await run(`
      await page.getByRole('button', { name: '创建部门', exact: true }).click();
    `);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ACTIONABILITY_FAILED: click matched 0 elements/i);
    expect(result.error).toMatch(/ZERO_MATCH_DIAGNOSTICS/);
    expect(result.error).toMatch(/创建部门（总公司）/);
    expect(result.error).toMatch(/data-testid/);
  });

  it('returns synchronous agent.state validation errors without waiting for the cell timeout', async () => {
    const stateKernel = new BrowserCodeKernel(
      { protocol: 'cdp', endpoint: cdpEndpoint },
      {
        executionTimeoutMs: 5_000,
        runtimeState: () => {
          throw new Error('agent.state value must not contain circular references.');
        },
      },
    );
    const executionId = randomUUID();
    await page.evaluate((id) => {
      Object.defineProperty(window, '__aiBrowserCodeExecutionId', {
        configurable: true,
        value: id,
      });
    }, executionId);
    try {
      const startedAt = Date.now();
      const result = await stateKernel.execute({
        code: `await agent.state.set({key:'too-large',value:'x'});`,
        executionId,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/must not contain circular references/);
      expect(Date.now() - startedAt).toBeLessThan(4_000);
    } finally {
      await stateKernel.close();
    }
  });

});
