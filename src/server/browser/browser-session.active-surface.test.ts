import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright';
import { BrowserSession } from './browser-session';

test('initial high-z interface chrome stays metadata instead of becoming the active surface', async (context) => {
  const session = new BrowserSession('dom', {
    headless: true,
    isolated: true,
    runId: 'initial-surface-baseline-test',
  });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.setContent(`<!doctype html>
    <main><button type="button">Primary action</button></main>
    <div id="details" style="background:white;position:fixed;right:40px;top:80px;width:320px;height:420px;z-index:1200">
      <button type="button">Static details action</button>
    </div>`);

  const observed = await session.readDomObservationSnapshot({ mode: 'full' });
  assert.equal(observed.observation.activeSurface, undefined);
  assert.deepEqual(observed.observation.topSurfaceIds, []);
  assert.equal(observed.observation.surfaces.some((surface) => surface.descriptor === 'div#details'), true);
});

test('identical console errors are emitted once per document', async (context) => {
  const session = new BrowserSession('dom', {
    headless: true,
    isolated: true,
    runId: 'console-error-dedupe-test',
  });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.setContent('<main>Console fixture</main>');
  await session.readDomObservationSnapshot({ mode: 'full' });

  await page.evaluate(() => console.error('repeated fixture error'));
  const first = await session.readDomChanges();
  assert.deepEqual(first.domChanges?.extra.errors, ['[console] repeated fixture error']);

  await page.evaluate(() => console.error('repeated fixture error'));
  const second = await session.readDomChanges();
  assert.deepEqual(second.domChanges?.extra.errors, []);
});

test('Playwright trial overrides a legacy supplemental occlusion diagnosis', async (context) => {
  const session = new BrowserSession('dom', {
    headless: true,
    isolated: true,
    runId: 'playwright-trial-authority-test',
  });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.setContent('<button id="trial-authoritative" type="button" onclick="document.body.dataset.clicked=\'true\'">Continue</button>');
  await session.readDomObservationSnapshot({ mode: 'full' });
  await page.evaluate(() => {
    const runtime = (window as Window & {
      __aiDomRuntime?: {
        actionability: (
          element: Element,
          options?: { action?: string },
        ) => { ok: boolean; reason: string; descriptor: string; failureKind?: 'occluded' };
      };
    }).__aiDomRuntime;
    if (!runtime) throw new Error('Expected browser DOM runtime.');
    const originalActionability = runtime.actionability.bind(runtime);
    runtime.actionability = (element, options) => element.id === 'trial-authoritative'
      ? {
          ok: false,
          reason: 'button#trial-authoritative has no unobstructed actionable point',
          descriptor: 'button#trial-authoritative',
        }
      : originalActionability(element, options);
  });

  const clicked = await session.executeBrowserCode({
    code: `await page.locator('#trial-authoritative').click();`,
    runId: 'playwright-trial-authority-test',
    stepIndex: 1,
  });
  assert.equal(clicked.ok, true, clicked.actual);
  assert.equal(await page.getAttribute('body', 'data-clicked'), 'true');
});

test('actionability resolves eleven duplicate traps without surface-based target selection', async (context) => {
  const session = new BrowserSession('dom', {
    headless: true,
    isolated: true,
    runId: 'modal-trigger-duplicate-traps-test',
  });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  const trapButton = (attributes = '') => (
    `<button data-testid="region-cascader-trigger" ${attributes} type="button" onclick="document.body.dataset.background='clicked'">Trap</button>`
  );
  await page.setContent(`<!doctype html>
    <div style="opacity:0">${trapButton()}</div>
    <div style="position:fixed;left:-10000px;top:-10000px">${trapButton()}</div>
    <div>${trapButton()}</div>
    <div aria-hidden="true">${trapButton()}</div>
    <div inert>${trapButton()}</div>
    <div>${trapButton('disabled')}</div>
    <div>${trapButton()}</div>
    <div style="pointer-events:none">${trapButton()}</div>
    <div>${trapButton('readonly')}</div>
    <div style="position:relative">${trapButton()}<span style="position:absolute;inset:0;background:white"></span></div>
    <div style="align-items:center;background:rgba(0,0,0,.4);display:flex;inset:0;justify-content:center;position:fixed;z-index:1000">
      <section aria-label="Form dialog" aria-modal="true" role="dialog"
        style="background:white;height:300px;padding:24px;width:500px">
        <button data-testid="region-cascader-trigger" type="button"
          onclick="document.body.dataset.modal='clicked'">Open region</button>
      </section>
    </div>`);
  const observed = await session.readDomObservationSnapshot({ mode: 'full' });
  assert.equal(observed.observation.activeSurface?.descriptor, 'section');

  const clicked = await session.executeBrowserCode({
    code: `await page.getByTestId('region-cascader-trigger').click();`,
    runId: 'modal-trigger-duplicate-traps-test',
    stepIndex: 1,
  });
  assert.equal(clicked.ok, true, clicked.actual);
  assert.equal(await page.getAttribute('body', 'data-modal'), 'clicked');
  assert.equal(await page.getAttribute('body', 'data-background'), null);
});

test('DOM and Code expose active nested surfaces without restricting actions', async (context) => {
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
  assert.equal(opened.observation?.surfaces.some((surface) => surface.descriptor === 'div#calendar-panel'), true);
  assert.equal(opened.observation?.surfaceStack.length, 1);
  assert.deepEqual(opened.observation?.topSurfaceIds, [opened.observation?.activeSurface?.id]);
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
  assert.match(codeActual.result || '', /^\[page-state\] /);
  assert.match(codeActual.result || '', /\[ax-tree scope=active\]/);
  assert.match(codeActual.result || '', /Delivery date calendar|31 July 2026/);
  const activeAxTree = (codeActual.result || '').split('[ax-tree scope=active]')[1] || '';
  assert.doesNotMatch(activeAxTree, /Background action/);
  assert.doesNotMatch(activeAxTree, /Choose date/);

  const allProjection = await session.executeBrowserCode({
    code: `nodeRepl.write(await page.domSnapshot({ scope: 'all' }));`,
    runId: 'active-surface-test',
    stepIndex: 3,
  });
  assert.equal(allProjection.ok, true, allProjection.actual);
  const allActual = JSON.parse(allProjection.actual) as { result?: string };
  assert.match(allActual.result || '', /\[ax-tree scope=all\]/);
  assert.match(allActual.result || '', /Background action/);

  const scopedDom = await session.readDomObservationSnapshot({ mode: 'full' });
  const backgroundRef = scopedDom.content.match(/<button uid=(dom-\S+)[^>]*>Background action<\/button>/)?.[1];
  assert.ok(backgroundRef, scopedDom.content);
  const backgroundDomClick = await session.mouse({ action: 'click', uid: backgroundRef });
  assert.equal(backgroundDomClick.ok, true, backgroundDomClick.actual);

  const backgroundCodeClick = await session.executeBrowserCode({
    code: `await page.getByRole('button', { name: 'Background action' }).click();`,
    runId: 'active-surface-test',
    stepIndex: 4,
  });
  assert.equal(backgroundCodeClick.ok, true, backgroundCodeClick.actual);

  const automaticProjection = await session.executeBrowserCode({
    code: `
      await page.getByRole('button', { name: '31 July 2026' }).hover();
      nodeRepl.write({ hovered: true });
    `,
    runId: 'active-surface-test',
    stepIndex: 5,
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
    document.getElementById('calendar-panel')!.append(topLayer);
  });
  const highestProjection = await session.executeBrowserCode({
    code: 'nodeRepl.write(await page.domSnapshot());',
    runId: 'active-surface-test',
    stepIndex: 6,
  });
  assert.equal(highestProjection.ok, true, highestProjection.actual);
  const highestActual = JSON.parse(highestProjection.actual) as { result?: string };
  assert.match(highestActual.result || '', /Highest surface|Topmost option/);
  const highestAxTree = (highestActual.result || '').split('[ax-tree scope=active]')[1] || '';
  assert.doesNotMatch(highestAxTree, /31 July 2026/);
  assert.doesNotMatch(highestAxTree, /Background action/);

  const after = await session.readDomObservationSnapshot({ mode: 'full' });
  assert.equal(after.observation.activeSurface?.descriptor, 'div#top-layer');
  assert.deepEqual(after.observation.surfaceStack.map((surface) => surface.descriptor), ['div#calendar-panel', 'div#top-layer']);
  assert.match(after.content.split('\n')[0], /"activeSurface"/);
  assert.match(after.content, /Background action/);
  assert.doesNotMatch(after.content, /inactive-by=/);
});

test('a portal dialog opened from another surface forms a source-based stack', async (context) => {
  const session = new BrowserSession('dom', {
    headless: true,
    isolated: true,
    runId: 'portal-surface-stack-test',
  });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.setContent(`<!doctype html>
    <button type="button">Background action</button>
    <section id="first-drawer" role="dialog" aria-modal="true" aria-label="First drawer"
      style="position:fixed;left:320px;top:0;width:520px;height:700px;background:white;z-index:1000">
      <button id="open-second" type="button">Open second drawer</button>
    </section>
    <section id="second-drawer" role="dialog" aria-modal="true" aria-label="Second drawer"
      style="display:none;position:fixed;left:700px;top:0;width:320px;height:700px;background:white;z-index:1001">
      <button type="button">Second drawer action</button>
    </section>
    <script>
      document.getElementById('open-second').addEventListener('click', () => {
        document.getElementById('second-drawer').style.display = 'block';
      });
    </script>`);

  const before = await session.readDomObservationSnapshot({ mode: 'full' });
  assert.deepEqual(before.observation.surfaceStack.map((surface) => surface.descriptor), ['section#first-drawer']);
  const openSecondRef = before.content.match(/<button uid=(dom-\S+)[^>]*>Open second drawer<\/button>/)?.[1];
  assert.ok(openSecondRef, before.content);
  const opened = await session.mouse({ action: 'click', uid: openSecondRef });
  assert.equal(opened.ok, true, opened.actual);

  const after = await session.readDomObservationSnapshot({ mode: 'full' });
  assert.equal(after.observation.activeSurface?.descriptor, 'section#second-drawer');
  assert.deepEqual(
    after.observation.surfaceStack.map((surface) => surface.descriptor),
    ['section#first-drawer', 'section#second-drawer'],
  );
  assert.equal(after.observation.surfaceStack[1]?.parentId, after.observation.surfaceStack[0]?.id);
  assert.deepEqual(after.observation.topSurfaceIds, [after.observation.activeSurface?.id]);
});

test('a unique top modal scopes observations but does not disambiguate browser actions', async (context) => {
  const session = new BrowserSession('dom', {
    headless: true,
    isolated: true,
    runId: 'modal-disambiguation-test',
  });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.setContent(`<!doctype html>
    <main id="background-decoys">
      ${Array.from({ length: 40 }, (_, index) => (
        `<label>Background field ${index}<input class="shared-modal-field" value="background-${index}"></label>`
      )).join('')}
    </main>
    <section id="opacity-dialog" role="dialog" aria-modal="true"
      style="opacity:0;position:fixed;inset:40px;z-index:1000">Opacity trap</section>
    <section id="inert-dialog" role="dialog" aria-modal="true" inert
      style="position:fixed;inset:50px;z-index:1000">Inert trap</section>
    <section id="content-hidden-dialog" role="dialog" aria-modal="true"
      style="content-visibility:hidden;position:fixed;inset:60px;z-index:1000">Content visibility trap</section>
    <section id="live-dialog" role="dialog" aria-modal="true" aria-label="Edit record"
      style="background:white;position:fixed;left:180px;top:80px;width:520px;height:360px;z-index:1000">
      <label>Modal title<input id="modal-field" class="shared-modal-field"></label>
    </section>`);

  const observed = await session.readDomObservationSnapshot({ mode: 'full' });
  assert.equal(observed.observation.activeSurface?.descriptor, 'section#live-dialog');
  assert.deepEqual(observed.observation.topSurfaceIds, [observed.observation.activeSurface?.id]);
  assert.equal(observed.observation.surfaces.some((surface) => surface.descriptor === 'section#opacity-dialog'), false);
  assert.equal(observed.observation.surfaces.some((surface) => surface.descriptor === 'section#inert-dialog'), false);
  assert.equal(observed.observation.surfaces.some((surface) => surface.descriptor === 'section#content-hidden-dialog'), false);
  assert.doesNotMatch(observed.content, /Opacity trap|Inert trap|Content visibility trap/);

  const activeSnapshot = await session.executeBrowserCode({
    code: `nodeRepl.write(await page.domSnapshot());`,
    runId: 'modal-disambiguation-test',
    stepIndex: 1,
  });
  assert.equal(activeSnapshot.ok, true, activeSnapshot.actual);
  const activeActual = JSON.parse(activeSnapshot.actual) as { result?: string };
  assert.match(activeActual.result || '', /Modal title/);
  assert.doesNotMatch(activeActual.result || '', /Background field/);

  const ambiguousFill = await session.executeBrowserCode({
    code: `await page.locator('.shared-modal-field').fill('modal-value');`,
    runId: 'modal-disambiguation-test',
    stepIndex: 2,
  });
  assert.equal(ambiguousFill.ok, false);
  assert.match(ambiguousFill.actual, /ACTIONABILITY_FAILED/);
  assert.equal(await page.locator('#modal-field').inputValue(), '');

  const scopedFill = await session.executeBrowserCode({
    code: `await page.getByRole('dialog', { name: 'Edit record' }).locator('.shared-modal-field').fill('modal-value');`,
    runId: 'modal-disambiguation-test',
    stepIndex: 3,
  });
  assert.equal(scopedFill.ok, true, scopedFill.actual);
  assert.equal(await page.locator('#modal-field').inputValue(), 'modal-value');
  assert.deepEqual(
    await page.locator('#background-decoys .shared-modal-field').evaluateAll((elements) => (
      elements.map((element) => (element as HTMLInputElement).value)
    )),
    Array.from({ length: 40 }, (_, index) => `background-${index}`),
  );
});

test('parallel same-level dialogs remain visible as separate surface metadata', async (context) => {
  const session = new BrowserSession('dom', {
    headless: true,
    isolated: true,
    runId: 'parallel-surface-test',
  });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.setContent(`<!doctype html>
    <button id="background" type="button">Background action</button>
    <section id="left-dialog" role="dialog" aria-modal="true" aria-label="Left dialog"
      style="position:fixed;left:40px;top:80px;width:300px;height:260px;background:white;z-index:1000">
      <button id="left-action" class="parallel-action" type="button" onclick="document.body.dataset.left='done'">Left action</button>
    </section>
    <section id="right-dialog" role="dialog" aria-modal="true" aria-label="Right dialog"
      style="position:fixed;right:40px;top:80px;width:300px;height:260px;background:white;z-index:1000">
      <button id="right-action" class="parallel-action" type="button" onclick="document.body.dataset.right='done'">Right action</button>
    </section>`);

  const observed = await session.readDomObservationSnapshot({ mode: 'full' });
  const dialogs = observed.observation.surfaces.filter((surface) => (
    surface.descriptor === 'section#left-dialog' || surface.descriptor === 'section#right-dialog'
  ));
  assert.equal(dialogs.length, 2);
  assert.deepEqual(dialogs.map((surface) => surface.parentId), [undefined, undefined]);
  assert.deepEqual(new Set(observed.observation.topSurfaceIds), new Set(dialogs.map((surface) => surface.id)));
  assert.equal(observed.observation.surfaceStack.length, 1);

  const leftRef = observed.content.match(/<button uid=(dom-\S+)[^>]*>Left action<\/button>/)?.[1];
  const backgroundRef = observed.content.match(/<button uid=(dom-\S+)[^>]*>Background action<\/button>/)?.[1];
  assert.ok(leftRef, observed.content);
  assert.ok(backgroundRef, observed.content);
  assert.doesNotMatch(observed.content.match(/<button[^>]*>Left action<\/button>/)?.[0] || '', /inactive-by=/);
  assert.doesNotMatch(observed.content.match(/<button[^>]*>Right action<\/button>/)?.[0] || '', /inactive-by=/);

  const ambiguousParallelAction = await session.executeBrowserCode({
    code: `await page.locator('.parallel-action').click();`,
    runId: 'parallel-surface-test',
    stepIndex: 1,
  });
  assert.equal(ambiguousParallelAction.ok, false);
  assert.match(ambiguousParallelAction.actual, /2 passed full actionability/i);
  assert.equal(await page.getAttribute('body', 'data-left'), null);
  assert.equal(await page.getAttribute('body', 'data-right'), null);

  const clickedLeft = await session.mouse({ action: 'click', uid: leftRef });
  assert.equal(clickedLeft.ok, true, clickedLeft.actual);
  assert.equal(await page.getAttribute('body', 'data-left'), 'done');

  const clickedRight = await session.executeBrowserCode({
    code: `await page.getByRole('button', { name: 'Right action' }).click();`,
    runId: 'parallel-surface-test',
    stepIndex: 2,
  });
  assert.equal(clickedRight.ok, true, clickedRight.actual);
  assert.equal(await page.getAttribute('body', 'data-right'), 'done');

  const backgroundClick = await session.mouse({ action: 'click', uid: backgroundRef });
  assert.equal(backgroundClick.ok, true, backgroundClick.actual);

  const after = await session.readDomObservationSnapshot({ mode: 'full' });
  assert.equal(after.observation.activeSurface?.descriptor, 'section#right-dialog');
  assert.deepEqual(new Set(after.observation.topSurfaceIds), new Set(dialogs.map((surface) => surface.id)));
});

test('small CDK portal cascader remains actionable beside a same-level popup', async (context) => {
  const session = new BrowserSession('dom', {
    headless: true,
    isolated: true,
    runId: 'cdk-cascader-surface-test',
  });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.setViewportSize({ width: 1707, height: 932 });
  await page.setContent(`<!doctype html>
    <style>
      nz-cascader { display:inline-block;height:32px;width:220px }
      .cdk-overlay-container { inset:0;pointer-events:none;position:fixed;z-index:1000 }
      .cdk-overlay-connected-position-bounding-box { inset:0;pointer-events:none;position:fixed }
      .cdk-overlay-pane { background:white;height:180px;left:370px;pointer-events:auto;position:absolute;top:486px;width:111px;z-index:1000 }
      .ant-cascader-dropdown { height:180px;position:relative;width:111px;z-index:1050 }
      .ant-cascader-menu-item { display:block;height:32px;width:103px }
    </style>
    <nz-cascader role="textbox" tabindex="0">请选择</nz-cascader>
    <button type="button">Background action</button>
    ${'<span></span>'.repeat(6100)}
    <script>
      document.querySelector('nz-cascader').addEventListener('click', () => {
        const sibling = document.createElement('div');
        sibling.id = 'parallel-popup';
        sibling.setAttribute('role', 'menu');
        sibling.style.cssText = 'background:white;height:120px;left:900px;position:fixed;top:486px;width:160px;z-index:1000';
        sibling.innerHTML = '<div role="menuitem">Parallel action</div>';
        document.body.append(sibling);

        const container = document.createElement('div');
        container.className = 'cdk-overlay-container';
        container.innerHTML = '<div class="cdk-overlay-connected-position-bounding-box"><div id="cdk-overlay-0" class="cdk-overlay-pane"><div class="ant-cascader-dropdown"><ul class="ant-cascader-menu" role="menuitemcheckbox"><li class="ant-cascader-menu-item" title="Zhejiang">Zhejiang</li><li class="ant-cascader-menu-item" title="Jiangsu">Jiangsu</li></ul></div></div></div>';
        document.body.append(container);
        container.querySelector('[title="Zhejiang"]').addEventListener('click', () => {
          document.body.dataset.selected = 'Zhejiang';
        });
      }, { once: true });
    </script>`);

  const opened = await session.executeBrowserCode({
    code: `await page.locator('nz-cascader').click();`,
    runId: 'cdk-cascader-surface-test',
    stepIndex: 1,
  });
  assert.equal(opened.ok, true, opened.actual);

  const observed = await session.readDomObservationSnapshot({ mode: 'full' });
  const pane = observed.observation.surfaces.find((surface) => surface.descriptor.startsWith('div#cdk-overlay-0'));
  const sibling = observed.observation.surfaces.find((surface) => surface.descriptor === 'div#parallel-popup');
  assert.ok(pane, JSON.stringify(observed.observation));
  assert.ok(sibling, JSON.stringify(observed.observation));
  assert.equal(pane.signals.includes('interactive-descendant'), true);
  assert.equal(pane.likelyOverlay, true);
  assert.deepEqual(new Set(observed.observation.topSurfaceIds), new Set([pane.id, sibling.id]));

  const selected = await session.executeBrowserCode({
    code: `await page.locator('.ant-cascader-menu-item[title="Zhejiang"]').click();`,
    runId: 'cdk-cascader-surface-test',
    stepIndex: 2,
  });
  assert.equal(selected.ok, true, selected.actual);
  assert.equal(await page.getAttribute('body', 'data-selected'), 'Zhejiang');
});

test('fixed edge affix does not block a small CDK tree-select portal', async (context) => {
  const session = new BrowserSession('dom', {
    headless: true,
    isolated: true,
    runId: 'cdk-tree-select-affix-test',
  });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.setViewportSize({ width: 1707, height: 932 });
  await page.setContent(`<!doctype html>
    <style>
      .ant-affix { background:white;height:364px;position:fixed;right:35px;top:16px;width:128px;z-index:9 }
      nz-tree-select { display:block;height:32px;margin-left:360px;margin-top:440px;width:250px }
      #tree-pane { background:white;display:none;height:36px;left:370px;position:fixed;top:486px;width:250px;z-index:1000 }
      .ant-select-tree-dropdown { height:36px;width:250px }
      .ant-select-tree-switcher { display:block;height:24px;width:24px }
    </style>
    <div class="ant-affix"><a href="#usage">何时使用</a><a href="#api">API</a></div>
    <nz-tree-select role="textbox" tabindex="0">leaf 1-0-0</nz-tree-select>
    <div id="tree-pane" class="cdk-overlay-pane">
      <div class="ant-select-dropdown ant-select-tree-dropdown">
        <nz-tree-node-switcher class="ant-select-tree-switcher" tabindex="-1">parent 1</nz-tree-node-switcher>
      </div>
    </div>
    <script>
      document.querySelector('nz-tree-select').addEventListener('click', () => {
        document.getElementById('tree-pane').style.display = 'block';
      });
      document.querySelector('nz-tree-node-switcher').addEventListener('click', () => {
        document.body.dataset.expanded = 'true';
      });
    </script>`);

  const before = await session.readDomObservationSnapshot({ mode: 'full' });
  assert.equal(before.observation.topSurfaceIds.length, 0);
  assert.equal(before.observation.surfaces.some((surface) => surface.descriptor === 'div.ant-affix'), false);

  const opened = await session.executeBrowserCode({
    code: `await page.locator('nz-tree-select').click();`,
    runId: 'cdk-tree-select-affix-test',
    stepIndex: 1,
  });
  assert.equal(opened.ok, true, opened.actual);

  const observed = await session.readDomObservationSnapshot({ mode: 'full' });
  const pane = observed.observation.surfaces.find((surface) => surface.descriptor.startsWith('div#tree-pane'));
  assert.ok(pane, JSON.stringify(observed.observation));
  assert.equal(pane.likelyOverlay, true);
  assert.equal(pane.signals.includes('interactive-descendant'), true);
  assert.deepEqual(observed.observation.topSurfaceIds, [pane.id]);

  const expanded = await session.executeBrowserCode({
    code: `await page.locator('nz-tree-node-switcher.ant-select-tree-switcher').click();`,
    runId: 'cdk-tree-select-affix-test',
    stepIndex: 2,
  });
  assert.equal(expanded.ok, true, expanded.actual);
  assert.equal(await page.getAttribute('body', 'data-expanded'), 'true');
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
