import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright';
import { BrowserSession } from './browser-session';

test('DOM keeps activeSurface facts while Code AX reads stay explicit and body-rooted', async (context) => {
  const session = new BrowserSession('dom', {
    headless: true,
    isolated: true,
    runId: 'active-surface-test',
  });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.setContent(`<!doctype html>
    <style>
      #calendar-panel {
        background: white;
        border: 1px solid #999;
        display: none;
        height: 260px;
        left: 180px;
        position: fixed;
        top: 100px;
        width: 360px;
        z-index: 1200;
      }
    </style>
    <button id="open-calendar" style="margin-top:64px" type="button">Choose date</button>
    <header style="position:fixed;left:0;right:0;top:0;height:48px;z-index:100">Persistent navigation</header>
    <main><button type="button">Background action</button></main>
    <div id="calendar-panel" aria-label="Delivery date calendar">
      <button type="button">31 July 2026</button>
    </div>
    <script>
      document.getElementById('open-calendar').addEventListener('click', () => {
        document.getElementById('calendar-panel').style.display = 'block';
      });
    </script>`);

  const before = await session.readDomObservationSnapshot({ mode: 'full' });
  assert.match(before.content, /^\[page-state\] /);
  assert.equal(before.observation.activeSurface, undefined);
  const openRef = before.content.match(/<button uid=(dom-\S+)[^>]*>Choose date<\/button>/)?.[1];
  assert.ok(openRef, before.content);

  const opened = await session.mouse({ action: 'click', uid: openRef });
  assert.equal(opened.ok, true, opened.actual);
  assert.equal(opened.verification?.status, 'passed');
  assert.equal(opened.observation?.surfaceTransition, 'opened');
  assert.equal(opened.observation?.activeSurface?.descriptor, 'div#calendar-panel');
  assert.equal(opened.observation?.activeSurface?.kind, 'overlay');
  assert.equal(opened.domChanges?.observation?.activeSurface?.id, opened.observation?.activeSurface?.id);
  assert.match(opened.observation?.activeSurface?.label || '', /Delivery date calendar|31 July 2026/);

  const codeProjection = await session.executeBrowserCode({
    code: `
      var sharedProjection = await page.domSnapshot();
      nodeRepl.write(sharedProjection);
    `,
    runId: 'active-surface-test',
    stepIndex: 2,
  });
  assert.equal(codeProjection.ok, true, codeProjection.actual);
  const codeActual = JSON.parse(codeProjection.actual) as { observation?: unknown; result?: string };
  assert.equal(codeActual.observation, undefined);
  assert.equal(codeProjection.observation, undefined);
  assert.match(codeActual.result || '', /^\[ax-tree\]\n/);
  assert.match(codeActual.result || '', /Delivery date calendar|31 July 2026/);
  assert.match(codeActual.result || '', /Background action/);
  assert.match(codeActual.result || '', /Choose date/);

  const automaticProjection = await session.executeBrowserCode({
    code: `
      await page.getByRole('button', { name: '31 July 2026' }).hover();
      nodeRepl.write({ hovered: true });
    `,
    runId: 'active-surface-test',
    stepIndex: 3,
  });
  assert.equal(automaticProjection.ok, true, automaticProjection.actual);
  const automaticActual = JSON.parse(automaticProjection.actual) as { axTree?: string; observation?: unknown };
  assert.equal(automaticActual.observation, undefined);
  assert.equal(automaticActual.axTree, undefined);

  await page.evaluate(() => {
    const topLayer = document.createElement('div');
    topLayer.id = 'top-layer';
    topLayer.setAttribute('role', 'listbox');
    topLayer.setAttribute('aria-label', 'Highest surface');
    topLayer.style.cssText = 'position:fixed;left:220px;top:130px;width:260px;height:180px;background:white;z-index:2000';
    topLayer.innerHTML = '<div role="option">Topmost option</div>';
    document.body.append(topLayer);
  });
  const highestProjection = await session.executeBrowserCode({
    code: 'nodeRepl.write(await page.domSnapshot());',
    runId: 'active-surface-test',
    stepIndex: 4,
  });
  assert.equal(highestProjection.ok, true, highestProjection.actual);
  const highestActual = JSON.parse(highestProjection.actual) as { result?: string };
  assert.match(highestActual.result || '', /Highest surface|Topmost option/);
  assert.match(highestActual.result || '', /31 July 2026/);
  assert.match(highestActual.result || '', /Background action/);

  const after = await session.readDomObservationSnapshot({ mode: 'full' });
  assert.equal(after.observation.activeSurface?.descriptor, 'div#top-layer');
  assert.match(after.content.split('\n')[0], /"activeSurface"/);
  assert.match(after.content, /Background action/, 'background DOM may remain readable while activeSurface owns action scope');
});

test('failed post-action verification is a hard BrowserActionResult failure', async (context) => {
  const session = new BrowserSession('dom', {
    headless: true,
    isolated: true,
    runId: 'hard-verification-test',
  });
  context.after(async () => session.close());
  await session.start();

  const completeVerifiedAction = Reflect.get(session, 'completeVerifiedAction') as (
    actual: string,
    generation: undefined,
    verify: () => Promise<{ ok: boolean; detail: string }>,
  ) => Promise<{ ok: boolean; actual: string; verification?: { status?: string } }>;
  const result = await completeVerifiedAction.call(
    session,
    'Synthetic operation dispatched.',
    undefined,
    async () => ({ ok: false, detail: 'expected business state did not appear' }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.verification?.status, 'failed');
  assert.match(result.actual, /Runtime verification is a hard condition/);
});
