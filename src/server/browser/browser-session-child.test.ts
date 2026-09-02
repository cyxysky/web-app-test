import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { BrowserSession } from '@webpilot/capability-browser/node';

test('child browser sessions share parent auth state while owning independent pages', async (context) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Shared auth test</title><main>ready</main>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;

  const parent = new BrowserSession({ headless: true, isolated: true, runId: 'child-session-parent-test' });
  let child: BrowserSession | undefined;
  context.after(async () => {
    await child?.close({ force: true }).catch(() => undefined);
    await parent.close({ force: true }).catch(() => undefined);
  });

  await parent.start();
  await parent.open(origin);
  await parent.injectCookies([{ name: 'auth', url: origin, value: 'parent-cookie' }]);
  const seedSessionStorage = await parent.executeBrowserCode({
    code: "await page.evaluate(() => sessionStorage.setItem('auth-session', 'parent-session')); nodeRepl.write(true);",
    runId: 'child-session-parent-test',
    stepIndex: 1,
  });
  assert.equal(seedSessionStorage.ok, true, seedSessionStorage.actual);

  child = await parent.forkChildSession({
    background: true,
    inheritSessionStorage: true,
    isMarked: true,
    runId: 'child-session-child-test',
  });
  assert.equal(parent.getTabsSnapshot().length, 1);
  assert.equal(child.getTabsSnapshot().length, 1);

  await child.open(origin);
  const childAuth = await child.executeBrowserCode({
    code: `nodeRepl.write(await page.evaluate(() => ({
      cookie: document.cookie,
      session: sessionStorage.getItem('auth-session'),
    })));`,
    runId: 'child-session-child-test',
    stepIndex: 1,
  });
  assert.equal(childAuth.ok, true, childAuth.actual);
  const childAuthResult = JSON.parse(childAuth.actual) as {
    result?: { cookie?: string; session?: string | null };
  };
  assert.match(childAuthResult.result?.cookie || '', /auth=parent-cookie/);
  assert.equal(childAuthResult.result?.session, 'parent-session');

  await child.injectCookies([{ name: 'auth', url: origin, value: 'child-cookie' }]);
  const parentState = await parent.exportStorageState();
  assert.equal(parentState?.cookies.find((cookie) => cookie.name === 'auth')?.value, 'child-cookie');

  await child.close();
  child = undefined;
  assert.equal(parent.isUsable(), true);
  assert.equal(parent.getTabsSnapshot().length, 1);
  assert.equal(parent.currentUrl(), `${origin}/`);
});
