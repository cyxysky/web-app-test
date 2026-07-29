import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import test, { after, before } from 'node:test';
import { chromium, type Browser, type BrowserContext, type BrowserServer, type Page } from 'playwright';
import {
  analyzeBrowserCodeRisk,
  browserCodePolicyViolation,
  BrowserCodeKernel,
  type BrowserCodeCredentialBinding,
} from './browser-code-runner';

let browserServer: BrowserServer;
let browser: Browser;
let browserContext: BrowserContext;
let page: Page;
let cdpEndpoint: string;
let kernel: BrowserCodeKernel;

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

before(async () => {
  const port = await availablePort();
  cdpEndpoint = `http://127.0.0.1:${port}`;
  browserServer = await chromium.launchServer({ headless: true, args: [`--remote-debugging-port=${port}`] });
  browser = await chromium.connect(browserServer.wsEndpoint());
  browserContext = await browser.newContext();
  page = await browserContext.newPage();
  await page.setContent('<title>Editor</title><button>Save</button>');
  kernel = new BrowserCodeKernel({ protocol: 'cdp', endpoint: cdpEndpoint });
});

after(async () => {
  await kernel.close();
  await browser.close().catch(() => undefined);
  await browserServer.close().catch(() => undefined);
});

async function run(code: string, options: {
  abortSignal?: AbortSignal;
  maxOutputChars?: number;
  credentials?: BrowserCodeCredentialBinding[];
} = {}) {
  const executionId = randomUUID();
  await page.evaluate((id) => {
    Object.defineProperty(window, '__aiBrowserCodeExecutionId', {
      configurable: true,
      value: id,
    });
  }, executionId);
  return kernel.execute({
    code,
    executionId,
    ...options,
  });
}

test('browserCode sandbox executes ordinary Playwright code directly', async () => {
  const result = await run(`
    console.info('starting');
    var editorTitle = await page.title();
    var saveButton = page.getByRole('button', { name: 'Save' });
    var firstResult = {
      title: editorTitle,
      text: await saveButton.innerText(),
      snapshot: await page.domSnapshot(),
      url: page.url(),
      uidType: typeof page.uid,
    };
    nodeRepl.write(firstResult);
  `);

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value, {
    title: 'Editor',
    text: 'Save',
    snapshot: '- button "Save"',
    url: 'about:blank',
    uidType: 'undefined',
  });
  assert.equal(result.logs.length, 1);
  assert.equal(result.logs[0].text, 'starting');
  assert.equal(result.activity?.requiresPostActionObservation, false);
});

test('browserCode keeps JavaScript bindings across cells like the Codex kernel', async () => {
  const result = await run(`nodeRepl.write({ persistedTitle: editorTitle });`);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value, { persistedTitle: 'Editor' });
});

test('browserCode bounds a missing locator and preserves the kernel after the failed cell', async () => {
  const startedAt = Date.now();
  const failed = await run(`
    var bindingBeforeLocatorFailure = 'still-here';
    await page.getByRole('button', { name: 'Missing button' }).click({ timeout: 3000 });
  `);
  assert.equal(failed.ok, false);
  assert.match(failed.error || '', /Timeout 5000ms exceeded/i);
  assert.doesNotMatch(failed.error || '', /Timeout 3000ms exceeded/i);
  assert.equal(failed.activity?.requiresPostActionObservation, true);
  assert.ok(failed.activity?.actions.includes('locator.click'));
  assert.ok(Date.now() - startedAt < 8_000, 'missing locator should return control through the operation timeout');

  const recovered = await run(`nodeRepl.write({ bindingBeforeLocatorFailure });`);
  assert.equal(recovered.ok, true, recovered.error);
  assert.deepEqual(recovered.value, { bindingBeforeLocatorFailure: 'still-here' });
});

test('browserCode requires coordinate screenshots to be reviewed in a previous cell', async () => {
  const forced = await run(`await page.getByRole('button', { name: 'Save' }).click({ force: true });`);
  assert.equal(forced.ok, false);
  assert.match(forced.error || '', /forbids Playwright force: true/);

  const unobservedCoordinate = await run(`await page.mouse.click(10, 10);`);
  assert.equal(unobservedCoordinate.ok, false);
  assert.match(unobservedCoordinate.error || '', /viewport screenshot/);

  const sameCellCoordinate = await run(`
    var coordinateScreenshot = await page.screenshot({ fullPage: false });
    await nodeRepl.emitImage(coordinateScreenshot);
    await page.mouse.click(10, 10);
  `);
  assert.equal(sameCellCoordinate.ok, false);
  assert.match(sameCellCoordinate.error || '', /previous browserCode cell/);
  assert.equal(sameCellCoordinate.images?.length, 1);

  const reviewedScreenshot = await run(`
    await nodeRepl.emitImage(await page.screenshot({ fullPage: false }));
    nodeRepl.write({ screenshotReady: true });
  `);
  assert.equal(reviewedScreenshot.ok, true, reviewedScreenshot.error);
  assert.deepEqual(reviewedScreenshot.value, { screenshotReady: true });

  const reviewedCoordinate = await run(`
    await page.mouse.click(10, 10);
    nodeRepl.write({ clicked: true });
  `);
  assert.equal(reviewedCoordinate.ok, true, reviewedCoordinate.error);
  assert.deepEqual(reviewedCoordinate.value, { clicked: true });
});

test('browserCode invalidates coordinate evidence after a DOM redraw', async () => {
  const screenshot = await run(`
    await nodeRepl.emitImage(await page.screenshot({ fullPage: false }));
  `);
  assert.equal(screenshot.ok, true, screenshot.error);

  await page.evaluate(() => {
    document.body.dataset.redrawn = String(Date.now());
  });
  const staleCoordinate = await run(`await page.mouse.click(10, 10);`);
  assert.equal(staleCoordinate.ok, false);
  assert.match(staleCoordinate.error || '', /screenshot is stale/);
});

test('browserCode emits screenshots from the same JavaScript cell', async () => {
  const result = await run(`
    var emittedScreenshot = await page.screenshot({ type: 'png' });
    await nodeRepl.emitImage(emittedScreenshot);
    nodeRepl.write({ emitted: true });
  `);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value, { emitted: true });
  assert.equal(result.images?.length, 1);
  assert.equal(result.images?.[0]?.mimeType, 'image/png');
  assert.equal(Buffer.from(result.images?.[0]?.data || '', 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('browserCode exposes browser and tab lifecycle as JavaScript APIs', async () => {
  const result = await run(`
    var runtimeBrowser = await agent.browsers.getDefault();
    var runtimeTab = await runtimeBrowser.tabs.new();
    await runtimeTab.playwright.setContent('<title>Runtime tab</title><button onclick="location.hash=&quot;runtime-ready&quot;">Continue</button>');
    await runtimeTab.playwright.expectNavigation(
      () => runtimeTab.playwright.getByRole('button', { name: 'Continue' }).click(),
      { url: /#runtime-ready$/, timeoutMs: 3000 },
    );
    var runtimeOpenTabs = await runtimeBrowser.user.openTabs();
    await runtimeBrowser.user.claimTab();
    await runtimeBrowser.tabs.finalize({ keep: [{ tab: runtimeTab, status: 'deliverable' }] });
    nodeRepl.write({
      browserCount: (await agent.browsers.list()).length,
      currentTitle: await page.title(),
      hasCua: typeof tab.cua.click === 'function',
      navigationUrl: page.url(),
      openTabCount: runtimeOpenTabs.length,
    });
  `);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value, {
    browserCount: 1,
    currentTitle: 'Runtime tab',
    hasCua: true,
    navigationUrl: 'about:blank#runtime-ready',
    openTabCount: 2,
  });
});

test('browserCode allows normal constructor and prototype DOM code without exposing direct Node globals', async () => {
  const result = await run(`
    // Axure prototypes usually render their content inside generated containers.
    var prototypeDom = await page.evaluate(() => ({
      constructorName: document.body.constructor.name,
      prototypeConstructorName: Object.getPrototypeOf(document.body).constructor.name,
    }));
    var workspaceRead = 'allowed';
    try {
      const hostProcess = page.url.constructor('return process')();
      const fs = hostProcess.getBuiltinModule('node:fs');
      fs.readFileSync(hostProcess.cwd() + '/package.json', 'utf8');
    } catch (error) {
      workspaceRead = error && typeof error === 'object' && 'code' in error ? error.code : 'denied';
    }
    var prototypeResult = {
      ...prototypeDom,
      prototypeNote: 'Axure prototypes are ordinary page content',
      processType: typeof process,
      requireType: typeof require,
      bufferType: typeof Buffer,
      workspaceRead,
    };
    nodeRepl.write(prototypeResult);
  `);

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value, {
    constructorName: 'HTMLBodyElement',
    prototypeConstructorName: 'HTMLBodyElement',
    prototypeNote: 'Axure prototypes are ordinary page content',
    processType: 'undefined',
    requireType: 'undefined',
    bufferType: 'undefined',
    workspaceRead: 'ERR_ACCESS_DENIED',
  });
});

test('browserCode stops an unbounded user promise on explicit abort', async () => {
  const controller = new AbortController();
  const pending = run(`
    await page.evaluate(() => { window.__browserCodeAbortTestStarted = true; });
    await new Promise(() => undefined);
  `, { abortSignal: controller.signal });
  let started = false;
  for (let attempt = 0; attempt < 100 && !started; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    started = await page.evaluate(() => Boolean((window as Window & { __browserCodeAbortTestStarted?: boolean }).__browserCodeAbortTestStarted));
  }
  assert.equal(started, true, 'browserCode cell should start before it is explicitly aborted');
  controller.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
  assert.match(result.error || '', /aborted/);
});

test('browserCode watchdog stops an unresponsive cell and restarts the kernel', async () => {
  const watchdogKernel = new BrowserCodeKernel(
    { protocol: 'cdp', endpoint: cdpEndpoint },
    { executionTimeoutMs: 250 },
  );
  const execute = async (code: string) => {
    const executionId = randomUUID();
    await page.evaluate((id) => {
      Object.defineProperty(window, '__aiBrowserCodeExecutionId', {
        configurable: true,
        value: id,
      });
    }, executionId);
    return watchdogKernel.execute({ code, executionId });
  };

  try {
    const startedAt = Date.now();
    const timedOut = await execute('await new Promise(() => undefined);');
    assert.equal(timedOut.ok, false);
    assert.match(timedOut.error || '', /timed out after 250ms/);
    assert.ok(Date.now() - startedAt < 5_000, 'watchdog should return control instead of leaving the cell pending');

    const recovered = await execute(`nodeRepl.write({ recovered: true, title: await page.title() });`);
    assert.equal(recovered.ok, true, recovered.error);
    assert.deepEqual(recovered.value, { recovered: true, title: 'Editor' });
  } finally {
    await watchdogKernel.close();
  }
});

test('browserCode truncates oversized return values', async () => {
  const result = await run(`nodeRepl.write('x'.repeat(5_000));`, { maxOutputChars: 1_000 });
  assert.equal(result.ok, true, result.error);
  assert.equal((result.value as { truncated?: boolean }).truncated, true);
  assert.equal((result.value as { originalChars?: number }).originalChars, 5_002);
});

test('browserCode restarts with a clean kernel after an aborted cell', async () => {
  const result = await run(`nodeRepl.write({ title: await page.title(), oldBinding: typeof editorTitle });`);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value, { title: 'Editor', oldBinding: 'undefined' });
});

test('browserCode fills credential references only on an allowed origin without returning the raw value', async () => {
  await browserContext.route('http://credential.test/**', (route) => route.fulfill({
    body: '<title>Login</title><label>Username<input></label><label>Password<input type="password"></label>',
    contentType: 'text/html',
  }));
  await page.goto('http://credential.test/login');
  const secret = 'vault-secret-value';
  try {
    const fakeLocatorResult = await run(`
      var capturedCredentialValue = 'not-exposed';
      var fakeCredentialLocator = {
        _frame: page.mainFrame(),
        _selector: 'input[type="password"]',
        fill(value) { capturedCredentialValue = value; },
      };
      await credentialVault.fill(fakeCredentialLocator, 'fake-locator-ref');
    `, {
      credentials: [{ ref: 'fake-locator-ref', value: secret, allowedOrigins: ['http://credential.test'] }],
    });
    assert.equal(fakeLocatorResult.ok, false);
    assert.match(fakeLocatorResult.error || '', /requires a Locator from the active browser session/);
    const fakeLocatorLeakCheck = await run(`nodeRepl.write(capturedCredentialValue);`);
    assert.equal(fakeLocatorLeakCheck.value, 'not-exposed');

    const result = await run(`
      var credentialFillResult = await credentialVault.fill(page.getByLabel('Password'), 'password-ref');
      nodeRepl.write(credentialFillResult);
    `, {
      credentials: [{ ref: 'password-ref', value: secret, allowedOrigins: ['http://credential.test'] }],
    });

    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.value, { filled: true, origin: 'http://credential.test' });
    assert.equal(await page.getByLabel('Password').inputValue(), secret);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));

    await page.getByLabel('Password').fill('');
    const rejected = await run(`
      await credentialVault.fill(page.getByLabel('Password'), 'wrong-origin-ref');
    `, {
      credentials: [{ ref: 'wrong-origin-ref', value: secret, allowedOrigins: ['http://other.test'] }],
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error || '', /not allowed for http:\/\/credential\.test/);
    assert.equal(await page.getByLabel('Password').inputValue(), '');
    assert.doesNotMatch(JSON.stringify(rejected), new RegExp(secret));
  } finally {
    await page.goto('about:blank');
    await page.setContent('<title>Editor</title><button>Save</button>');
    await browserContext.unroute('http://credential.test/**');
  }
});

test('browserCode risk analysis flags external effects and sensitive data', () => {
  assert.equal(analyzeBrowserCodeRisk(`await page.getByRole('button', { name: '删除' }).click()`).requiresConfirmation, true);
  assert.equal(analyzeBrowserCodeRisk(`await page.getByLabel('验证码').fill('123456')`).requiresConfirmation, true);
  assert.equal(analyzeBrowserCodeRisk(`return await page.getByRole('heading').innerText()`).requiresConfirmation, false);
});

test('browserCode policy rejects literal force clicks before execution', () => {
  assert.match(browserCodePolicyViolation(`await locator.click({ force: true })`) || '', /forbids Playwright force: true/);
  assert.equal(browserCodePolicyViolation(`await locator.click()`), undefined);
});

test('browserCode policy rejects scripted clicks that bypass actionability', () => {
  assert.match(
    browserCodePolicyViolation(`await page.locator('button').dispatchEvent('click')`) || '',
    /forbids dispatchEvent/,
  );
  assert.match(
    browserCodePolicyViolation(`await page.evaluate(() => document.querySelector('button').click())`) || '',
    /forbids DOM element\.click/,
  );
  assert.match(
    browserCodePolicyViolation(`await page.locator('button').evaluate((button) => button.click())`) || '',
    /forbids DOM element\.click/,
  );
  assert.match(
    browserCodePolicyViolation(`await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const button of buttons) {
        if (button.textContent.includes('确定')) {
          button.click();
          return true;
        }
      }
      return false;
    })`) || '',
    /forbids DOM element\.click/,
  );
  assert.equal(
    browserCodePolicyViolation(`await page.evaluate(() => document.title); await page.getByRole('button', { name: 'Save' }).click()`),
    undefined,
  );
});
