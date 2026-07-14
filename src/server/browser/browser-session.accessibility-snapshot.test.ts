import assert from 'node:assert/strict';
import { readFile, unlink } from 'node:fs/promises';
import test from 'node:test';
import type { Page } from 'playwright';
import { BrowserSession } from './browser-session';
import { exportAccessibilitySnapshotJson } from './accessibility-snapshot-test.service';

type SnapshotMode = 'actionable' | 'full' | 'text';
type SnapshotSlice = Awaited<ReturnType<BrowserSession['readSnapshotSlice']>>;

async function readWholeView(session: BrowserSession, mode: SnapshotMode, refresh = false) {
  const slices: SnapshotSlice[] = [];
  let cursorIndex = 0;
  for (let guard = 0; guard < 100; guard += 1) {
    const slice = await session.readSnapshotSlice({
      cursorIndex,
      maxChars: 20000,
      refresh: refresh && guard === 0,
      mode,
    });
    slices.push(slice);
    if (!slice.hasMore) return slices;
    assert.ok(slice.nextIndex > cursorIndex, `${mode} cursor must advance`);
    cursorIndex = slice.nextIndex;
  }
  throw new Error(`${mode} snapshot did not finish within 100 chunks`);
}

test('DOMSnapshot covers offscreen content and iframes, paginates records, and powers unified input', async (context) => {
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'ax-snapshot-test' });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;

  const buttons = Array.from({ length: 500 }, (_, index) => (
    `<button style="display:block;margin-top:16px" data-testid="action-${index}">Action ${index}</button>`
  )).join('');
  const html = [
    '<!doctype html><html><body>',
    '<div style="display:none"><button>Hidden child action</button></div>',
    '<div style="display:none"><iframe srcdoc="<button>Hidden frame action</button>"></iframe></div>',
    '<div id="filter-action" class="filter-btn" style="width:32px;height:32px;cursor:pointer" onclick="document.body.dataset.filterClicked=\'true\'"><svg class="icon-Filter-Fill" aria-hidden="true"><path d="M0 0h10v10H0z"></path></svg></div>',
    '<section aria-label="Snapshot test tools"><div id="icon-only-action" onclick="document.body.dataset.iconOnlyClicked=\'true\'"><svg aria-hidden="true"><path d="M0 0h10v10H0z"></path></svg></div></section>',
    '<button data-testid="stable-action" onclick="document.body.dataset.stableClicked=\'true\'">Stable action</button>',
    '<input aria-label="Name" value="old value">',
    buttons,
    '<iframe srcdoc="<button data-testid=&quot;frame-action&quot;>Frame action</button>"></iframe>',
    '<button data-testid="coordinate-action" style="position:fixed;left:45vw;top:45vh;width:10vw;height:10vh" onclick="document.body.dataset.coordinateClicked=\'true\'">Coordinate action</button>',
    '</body></html>',
  ].join('');
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const actionableSlices = await readWholeView(session, 'actionable', true);
  const fullSlices = await readWholeView(session, 'full');
  const textSlices = await readWholeView(session, 'text');
  const allSlices = [...actionableSlices, ...fullSlices, ...textSlices];
  assert.equal(new Set(allSlices.map((slice) => slice.generationId)).size, 1, 'all views must share one cached generation');
  assert.ok((actionableSlices[0].timings.captureDomMs || 0) > 0, 'DOMSnapshot must be the primary capture source');
  assert.equal(actionableSlices[0].timings.captureAxMs, 0, 'full AX capture should not run when DOMSnapshot succeeds');
  assert.equal(actionableSlices[0].captureSource, 'dom-snapshot');
  assert.ok(actionableSlices.length > 1, 'large actionable views should be paginated');
  assert.ok(allSlices.every((slice) => slice.content.length <= 20000));
  const expandedActionableSlice = await session.readSnapshotSlice({ mode: 'actionable', maxChars: 25000 });
  assert.ok(expandedActionableSlice.content.length > 20000, 'requests above the 20k floor must not be capped at 20k');
  assert.ok(expandedActionableSlice.content.length <= 25000);

  const actionable = actionableSlices.map((slice) => slice.content).join('\n');
  const full = fullSlices.map((slice) => slice.content).join('\n');
  const text = textSlices.map((slice) => slice.content).join('\n');
  assert.match(actionable, /Action 499/, 'offscreen actions must remain discoverable without scrolling');
  assert.match(actionable, /Frame action/, 'same-origin iframe actions must be included');
  assert.match(full, /^RootWebArea/m, 'full view must retain the DOMSnapshot root');
  assert.ok(text.split('\n').every((line) => line === line.trim()), 'text view must remain indentation-free plain text');
  const hiddenSnapshotLines = `${actionable}\n${full}\n${text}`.split('\n').filter((line) => /Hidden (?:child|frame) action/.test(line));
  assert.equal(hiddenSnapshotLines.length, 0, `display:none content leaked into the snapshot:\n${hiddenSnapshotLines.join('\n')}`);
  assert.doesNotMatch(`${actionable}\n${full}`, /data-ai-interactive|data-ai-signals|signals=/, 'snapshot output must not spend tokens on redundant markers');

  const iconUid = actionable.match(/^\s*uid=(\S+)\s+generic\s+"\[无标签控件：Snapshot test tools\]".*actions=click/m)?.[1];
  const iconContextLines = actionable.split('\n').filter((line) => /Snapshot test tools|无标签控件/.test(line)).join('\n');
  assert.ok(iconUid, `a click-only SVG container must be retained with explicit, non-guessed context:\n${iconContextLines}`);
  const iconClick = await session.mouse({ action: 'click', uid: iconUid });
  assert.equal(iconClick.ok, true, iconClick.actual);
  assert.equal(await page.locator('body').getAttribute('data-icon-only-clicked'), 'true');

  const filterLine = actionable.split('\n').find((line) => (
    /^\s*uid=\S+\s+generic\b/.test(line)
    && line.includes('class=filter-btn')
    && line.includes('icon=svg.icon-Filter-Fill')
    && line.includes('actions=click')
  ));
  const filterUid = filterLine?.match(/^\s*uid=(\S+)/)?.[1];
  assert.ok(filterUid, `an unlabeled icon action must preserve its DOM class and nested SVG class:\n${actionable}`);
  assert.doesNotMatch(filterLine!, /过滤/, 'class names must not be translated into guessed business labels');
  const filterClick = await session.mouse({ action: 'click', uid: filterUid });
  assert.equal(filterClick.ok, true, filterClick.actual);
  assert.equal(await page.locator('body').getAttribute('data-filter-clicked'), 'true');

  const stableUid = actionable.match(/^\s*uid=(\S+)\s+button\s+"Stable action"/m)?.[1];
  assert.ok(stableUid, 'stable action UID should be present');
  const click = await session.mouse({ action: 'click', uid: stableUid });
  assert.equal(click.ok, true, click.actual);
  assert.equal(await page.locator('body').getAttribute('data-stable-clicked'), 'true');
  assert.match(click.actual, /Semantic DOM snapshot snapshot-\d+ is current \(refreshed\)/);
  assert.ok(session.currentSnapshotObservationViews()?.actionable?.includes('Stable action'), 'actions should retain a refreshed actionable snapshot');

  const refreshed = await readWholeView(session, 'actionable', true);
  const refreshedActionable = refreshed.map((slice) => slice.content).join('\n');
  const inputUid = refreshedActionable.match(/^\s*uid=(\S+)\s+textbox\s+"Name"/m)?.[1];
  assert.ok(inputUid, 'textbox UID should be present after refresh');
  const search = await session.searchSnapshot({ query: 'Name', roles: ['textbox'] });
  assert.equal(search.ok, true, search.actual);
  assert.match(search.actual, new RegExp(`uid=${inputUid}\\b`));
  const typed = await session.keyboard({ action: 'type', uid: inputUid, text: 'new value', replace: true });
  assert.equal(typed.ok, true, typed.actual);
  assert.equal(await page.locator('input[aria-label="Name"]').inputValue(), 'new value');

  await session.takeCurrentScreenshotOnly('ax-snapshot-test', 1, 'visual-1', { capture: 'viewport' });
  const coordinateClick = await session.mouse({ action: 'click', xThousandth: 500, yThousandth: 500 });
  assert.equal(coordinateClick.ok, true, coordinateClick.actual);
  assert.equal(await page.locator('body').getAttribute('data-coordinate-clicked'), 'true');

  const exported = await exportAccessibilitySnapshotJson(session);
  assert.equal(exported.ok, true, exported.error);
  assert.ok(exported.path);
  const payload = JSON.parse(await readFile(exported.path, 'utf8')) as {
    version?: number;
    format?: string;
    generationId?: string;
    views?: Record<string, { content?: string; generationId?: string; chunks?: Array<{ charLength?: number; content?: string }> }>;
  };
  assert.equal(payload.version, 4);
  assert.equal(payload.format, 'chromium-dom-snapshot-with-partial-ax');
  assert.ok(payload.generationId);
  assert.deepEqual(Object.keys(payload.views || {}).sort(), ['actionable', 'full', 'text']);
  const exportedViews = Object.values(payload.views || {});
  assert.ok(exportedViews.every((view) => view.generationId === payload.generationId));
  const exportedChunks = exportedViews.flatMap((view) => view.chunks || []);
  assert.ok(exportedChunks.length > 0);
  assert.ok(exportedChunks.every((chunk) => (chunk.charLength || 0) <= 20000));
  assert.ok(exportedChunks.every((chunk) => !chunk.content?.includes('data-ai-interactive')));
  assert.ok(exportedViews.every((view) => view.content === (view.chunks || []).map((chunk) => chunk.content).join('\n')));
  await unlink(exported.path);
});

test('snapshot lifecycle refreshes on page-state changes, ranks actionable matches, and rejects covered targets', async (context) => {
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'snapshot-lifecycle-test' });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  const contextualText = Array.from({ length: 60 }, (_, index) => `<p>Context ${index}</p>`).join('');
  const html = [
    '<!doctype html><html><body>',
    '<h2>Save settings</h2>',
    '<form>',
    contextualText,
    '<button id="save" type="button" onclick="document.body.dataset.saved=\'true\'">Save</button>',
    '<input id="renamed-editor" aria-label="Original editor" value="">',
    '</form>',
    '<button>Duplicate</button><button>Duplicate</button>',
    '<div id="cover" style="position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.1)"></div>',
    '</body></html>',
  ].join('');
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const initial = await readWholeView(session, 'actionable', true);
  const actionable = initial.map((slice) => slice.content).join('\n');
  const saveUid = actionable.match(/^\s*uid=(\S+)\s+button\s+"Save"/m)?.[1];
  const renamedEditorUid = actionable.match(/^\s*uid=(\S+)\s+textbox\s+"Original editor"/m)?.[1];
  assert.ok(saveUid && renamedEditorUid);
  assert.equal((actionable.match(/Context \d+/g) || []).length <= 24, true, 'context roots should be token-bounded');
  assert.equal((actionable.match(/button\s+"Duplicate"/g) || []).length, 2, 'same-name controls must not be deduplicated away');

  const search = await session.searchSnapshot({ query: 'Save' });
  assert.equal(search.ok, true, search.actual);
  assert.match(search.actual.split('\n')[1] || '', /button\s+"Save"/, 'exact actionable names should rank before structural text');

  const covered = await session.mouse({ action: 'click', uid: saveUid });
  assert.equal(covered.ok, false);
  assert.match(covered.actual, /covered/);

  await page.locator('#cover').evaluate((element) => element.remove());
  const mutationRefresh = await session.wait(100);
  assert.equal(mutationRefresh.ok, true, mutationRefresh.actual);
  assert.match(mutationRefresh.actual, /current \(refreshed\)/);
  assert.ok(session.currentSnapshotObservationViews()?.actionable?.includes('Save'));

  const unchangedReuse = await session.wait(100);
  assert.equal(unchangedReuse.ok, true, unchangedReuse.actual);
  assert.match(unchangedReuse.actual, /reused; no page-state change detected/);

  await page.mouse.move(3, 3);
  const interactionOnlyReuse = await session.wait(0);
  assert.equal(interactionOnlyReuse.ok, true, interactionOnlyReuse.actual);
  assert.match(interactionOnlyReuse.actual, /reused; no page-state change detected/, 'pointer events alone must not invalidate semantic DOM snapshots');

  await page.locator('#renamed-editor').evaluate((element) => element.setAttribute('aria-label', 'Renamed editor'));
  const renamedEditor = await session.keyboard({ action: 'type', uid: renamedEditorUid, text: 'retained', replace: true });
  assert.equal(renamedEditor.ok, true, renamedEditor.actual);
  assert.doesNotMatch(renamedEditor.actual, /target semantics changed|Capture a fresh snapshot/, 'a stable DOM node must remain actionable when its accessible name changes');
  assert.equal(await page.locator('#renamed-editor').inputValue(), 'retained');

  await page.locator('body').evaluate((body) => body.insertAdjacentHTML('beforeend', '<button>Late action</button>'));
  const clickAfterUnrelatedMutation = await session.mouse({ action: 'click', uid: saveUid });
  assert.equal(clickAfterUnrelatedMutation.ok, true, clickAfterUnrelatedMutation.actual);
  assert.doesNotMatch(clickAfterUnrelatedMutation.actual, /Capture a fresh snapshot/, 'stable UIDs should rebind after unrelated DOM mutations');
  assert.equal(await page.locator('body').getAttribute('data-saved'), 'true');

  const lateSearch = await session.searchSnapshot({ query: 'Late action', roles: ['button'] });
  assert.equal(lateSearch.ok, true, lateSearch.actual);
  assert.match(lateSearch.actual, /button\s+"Late action"/, 'search should refresh a mutation-stale cached generation');

  await page.locator('#save').evaluate((button) => button.replaceWith(button.cloneNode(true)));
  const replacedTarget = await session.mouse({ action: 'click', uid: saveUid });
  assert.equal(replacedTarget.ok, false, replacedTarget.actual);
  assert.match(replacedTarget.actual, /DOM node no longer exists in the refreshed snapshot/);
});

test('open waits for a bounded DOM quiet window before capturing the navigation snapshot', async (context) => {
  const previousQuietMs = process.env.BROWSER_NAVIGATION_DOM_QUIET_MS;
  const previousTimeoutMs = process.env.BROWSER_NAVIGATION_DOM_STABILITY_TIMEOUT_MS;
  process.env.BROWSER_NAVIGATION_DOM_QUIET_MS = '120';
  process.env.BROWSER_NAVIGATION_DOM_STABILITY_TIMEOUT_MS = '800';
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'navigation-dom-stability-test' });
  context.after(async () => {
    if (previousQuietMs === undefined) delete process.env.BROWSER_NAVIGATION_DOM_QUIET_MS;
    else process.env.BROWSER_NAVIGATION_DOM_QUIET_MS = previousQuietMs;
    if (previousTimeoutMs === undefined) delete process.env.BROWSER_NAVIGATION_DOM_STABILITY_TIMEOUT_MS;
    else process.env.BROWSER_NAVIGATION_DOM_STABILITY_TIMEOUT_MS = previousTimeoutMs;
    await session.close();
  });
  await session.start();
  const html = `<!doctype html><html><body>
    <main id="app"><button type="button">Initial action</button></main>
    <script>
      const replaceAction = (label, finalAction) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        if (finalAction) button.addEventListener('click', () => document.body.dataset.finalClicked = 'true');
        document.getElementById('app').replaceChildren(button);
      };
      setTimeout(() => replaceAction('Intermediate action', false), 40);
      setTimeout(() => replaceAction('Final action', true), 180);
    </script>
  </body></html>`;

  const opened = await session.open(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  assert.equal(opened.ok, true, opened.actual);
  assert.match(opened.actual, /Navigation DOM stabilized for 120ms/);
  const actionable = session.currentSnapshotObservationViews()?.actionable || '';
  assert.match(actionable, /button\s+"Final action"/);
  assert.doesNotMatch(actionable, /Initial action|Intermediate action/);
  const finalUid = actionable.match(/^\s*uid=(\S+)\s+button\s+"Final action"/m)?.[1];
  assert.ok(finalUid, actionable);
  const clicked = await session.mouse({ action: 'click', uid: finalUid });
  assert.equal(clicked.ok, true, clicked.actual);
  const page = Reflect.get(session, 'activePage') as Page;
  assert.equal(await page.locator('body').getAttribute('data-final-clicked'), 'true');

  await page.reload({ waitUntil: 'commit' });
  const sameUrlNavigation = await session.wait(0);
  assert.match(sameUrlNavigation.actual, /Navigation DOM stabilized for 120ms/, 'same-URL navigations must also use the DOM quiet window');
  assert.match(session.currentSnapshotObservationViews()?.actionable || '', /button\s+"Final action"/);
});

test('open continues when continuous DOM mutations reach the navigation stability cap', async (context) => {
  const previousQuietMs = process.env.BROWSER_NAVIGATION_DOM_QUIET_MS;
  const previousTimeoutMs = process.env.BROWSER_NAVIGATION_DOM_STABILITY_TIMEOUT_MS;
  process.env.BROWSER_NAVIGATION_DOM_QUIET_MS = '120';
  process.env.BROWSER_NAVIGATION_DOM_STABILITY_TIMEOUT_MS = '250';
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'navigation-dom-stability-cap-test' });
  context.after(async () => {
    if (previousQuietMs === undefined) delete process.env.BROWSER_NAVIGATION_DOM_QUIET_MS;
    else process.env.BROWSER_NAVIGATION_DOM_QUIET_MS = previousQuietMs;
    if (previousTimeoutMs === undefined) delete process.env.BROWSER_NAVIGATION_DOM_STABILITY_TIMEOUT_MS;
    else process.env.BROWSER_NAVIGATION_DOM_STABILITY_TIMEOUT_MS = previousTimeoutMs;
    await session.close();
  });
  await session.start();
  const html = `<!doctype html><html><body><button type="button">Live action</button><script>
    let tick = 0;
    setInterval(() => document.body.dataset.tick = String(++tick), 10);
  </script></body></html>`;

  const startedAt = Date.now();
  const opened = await session.open(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  assert.equal(opened.ok, true, opened.actual);
  assert.match(opened.actual, /Navigation DOM stability wait reached the 250ms cap/);
  assert.ok(Date.now() - startedAt < 5000, 'the bounded stability wait must not block indefinitely');
  assert.match(session.currentSnapshotObservationViews()?.actionable || '', /Live action/);
});

test('navigation stability cap also bounds a stalled DOM sample', async (context) => {
  const previousQuietMs = process.env.BROWSER_NAVIGATION_DOM_QUIET_MS;
  const previousTimeoutMs = process.env.BROWSER_NAVIGATION_DOM_STABILITY_TIMEOUT_MS;
  process.env.BROWSER_NAVIGATION_DOM_QUIET_MS = '120';
  process.env.BROWSER_NAVIGATION_DOM_STABILITY_TIMEOUT_MS = '150';
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'navigation-dom-sample-cap-test' });
  context.after(async () => {
    if (previousQuietMs === undefined) delete process.env.BROWSER_NAVIGATION_DOM_QUIET_MS;
    else process.env.BROWSER_NAVIGATION_DOM_QUIET_MS = previousQuietMs;
    if (previousTimeoutMs === undefined) delete process.env.BROWSER_NAVIGATION_DOM_STABILITY_TIMEOUT_MS;
    else process.env.BROWSER_NAVIGATION_DOM_STABILITY_TIMEOUT_MS = previousTimeoutMs;
    await session.close();
  });
  await session.start();
  Reflect.set(session, 'readNavigationDomStabilitySample', () => new Promise<never>(() => undefined));

  const startedAt = Date.now();
  const opened = await session.open('data:text/html;charset=utf-8,<button>Bounded action</button>');

  assert.equal(opened.ok, true, opened.actual);
  assert.match(opened.actual, /Navigation DOM stability wait reached the 150ms cap/);
  assert.ok(Date.now() - startedAt < 3000, 'a stalled DOM sample must remain bounded by the navigation deadline');
});

test('unified mouse and keyboard actions emit real browser events', async (context) => {
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'input-events-test' });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  const html = `<!doctype html><html><head><style>
    #hover-menu { display: none; }
    #hover-target:hover + #hover-menu { display: block; }
    #source, #drop { width: 140px; height: 48px; margin: 8px; border: 1px solid #333; }
    #scroller { width: 240px; height: 100px; overflow: auto; border: 1px solid #333; }
    #scroll-content { height: 900px; padding-top: 780px; }
  </style></head><body>
    <button id="hover-target" type="button">Hover target</button><div id="hover-menu">Hover menu</div>
    <input id="editor" aria-label="Editor" value="old">
    <div id="source" role="button" tabindex="0" draggable="true" aria-label="Drag source">Drag source</div>
    <div id="drop" role="button" tabindex="0" aria-label="Drop target">Drop target</div>
    <div id="scroller" role="region" tabindex="0" aria-label="Scroll box"><div id="scroll-content"><button type="button">Deep action</button></div></div>
    <script>
      window.inputEvents = [];
      const hover = document.getElementById('hover-target');
      hover.addEventListener('mousemove', () => document.body.dataset.hovered = 'true');
      hover.addEventListener('contextmenu', event => { event.preventDefault(); document.body.dataset.contextmenu = 'true'; });
      hover.addEventListener('dblclick', () => document.body.dataset.doubleClicked = 'true');
      const editor = document.getElementById('editor');
      for (const type of ['keydown', 'keypress', 'input', 'keyup', 'change']) editor.addEventListener(type, () => window.inputEvents.push(type));
      document.addEventListener('keydown', event => {
        if (event.key === 'Enter') document.body.dataset.enterPressed = 'true';
        if (event.ctrlKey && event.key.toLowerCase() === 'k') document.body.dataset.shortcutPressed = 'true';
      });
      document.getElementById('source').addEventListener('dragstart', event => {
        document.body.dataset.dragStarted = 'true';
        event.dataTransfer.setData('text/plain', 'dragged');
      });
      const drop = document.getElementById('drop');
      drop.addEventListener('dragover', event => event.preventDefault());
      drop.addEventListener('drop', event => {
        event.preventDefault();
        document.body.dataset.dropped = event.dataTransfer.getData('text/plain');
      });
    </script>
  </body></html>`;
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const initial = await readWholeView(session, 'actionable', true);
  const actionable = initial.map((slice) => slice.content).join('\n');
  const uidFor = (role: string, name: string) => actionable.match(new RegExp(`^\\s*uid=(\\S+)\\s+${role}\\s+"${name}"`, 'm'))?.[1];
  const hoverUid = uidFor('button', 'Hover target');
  const editorUid = uidFor('textbox', 'Editor');
  const sourceUid = uidFor('button', 'Drag source');
  const dropUid = uidFor('button', 'Drop target');
  const scrollerUid = uidFor('region', 'Scroll box');
  const deepUid = uidFor('button', 'Deep action');
  assert.ok(hoverUid && editorUid && sourceUid && dropUid && scrollerUid && deepUid, actionable);

  const move = await session.mouse({ action: 'move', uid: hoverUid });
  assert.equal(move.ok, true, move.actual);
  assert.match(move.actual, /Playwright hover/);
  assert.match(move.actual, /Post-action check: \d+ mousemove event/);
  assert.equal(await page.locator('body').getAttribute('data-hovered'), 'true');
  assert.equal(await page.locator('#hover-menu').evaluate((element) => getComputedStyle(element).display), 'block');

  const rightClick = await session.mouse({ action: 'click', uid: hoverUid, button: 'right' });
  assert.equal(rightClick.ok, true, rightClick.actual);
  assert.equal(await page.locator('body').getAttribute('data-contextmenu'), 'true');

  const doubleClick = await session.mouse({ action: 'click', uid: hoverUid, clickCount: 2 });
  assert.equal(doubleClick.ok, true, doubleClick.actual);
  assert.equal(await page.locator('body').getAttribute('data-double-clicked'), 'true');

  const drag = await session.mouse({ action: 'drag', uid: sourceUid, toUid: dropUid });
  assert.equal(drag.ok, true, drag.actual);
  assert.match(drag.actual, /Post-action check: \d+ mousemove and \d+ drop event/);
  assert.equal(await page.locator('body').getAttribute('data-drag-started'), 'true');
  assert.equal(await page.locator('body').getAttribute('data-dropped'), 'dragged');

  const typed = await session.keyboard({ action: 'type', uid: editorUid, text: 'hello', replace: true });
  assert.equal(typed.ok, true, typed.actual);
  assert.match(typed.actual, /keydown and \d+ input event/);
  const inputState = await page.evaluate(() => ({
    activeId: (document.activeElement as HTMLElement | null)?.id || '',
    events: (window as Window & { inputEvents?: string[] }).inputEvents || [],
    value: (document.getElementById('editor') as HTMLInputElement).value,
  }));
  assert.equal(inputState.value, 'hello', JSON.stringify(inputState));
  const inputEvents = await page.evaluate(() => (window as Window & { inputEvents?: string[] }).inputEvents || []);
  assert.ok(inputEvents.includes('keydown'));
  assert.ok(inputEvents.includes('keypress'));
  assert.ok(inputEvents.includes('input'));
  assert.ok(inputEvents.includes('keyup'));

  const press = await session.keyboard({ action: 'press', key: 'Enter' });
  assert.equal(press.ok, true, press.actual);
  assert.equal(await page.locator('body').getAttribute('data-enter-pressed'), 'true');

  const shortcut = await session.keyboard({ action: 'shortcut', keys: ['Control', 'k'] });
  assert.equal(shortcut.ok, true, shortcut.actual);
  assert.equal(await page.locator('body').getAttribute('data-shortcut-pressed'), 'true');

  const scroll = await session.mouse({ action: 'scroll', uid: scrollerUid, deltaY: 420 });
  assert.equal(scroll.ok, true, scroll.actual);
  assert.ok(await page.locator('#scroller').evaluate((element) => element.scrollTop) > 0);

  const scrollIntoView = await session.mouse({ action: 'scrollIntoView', uid: deepUid });
  assert.equal(scrollIntoView.ok, true, scrollIntoView.actual);
  const deepVisible = await page.locator('text=Deep action').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const scroller = document.getElementById('scroller')!.getBoundingClientRect();
    return rect.top >= scroller.top && rect.bottom <= scroller.bottom;
  });
  assert.equal(deepVisible, true);

  await page.locator('body').evaluate((body) => {
    delete body.dataset.dragStarted;
    delete body.dataset.dropped;
  });
  await session.takeCurrentScreenshotOnly('coordinate-drag-test', 1, 'visual-1', { capture: 'viewport' });
  const viewport = page.viewportSize();
  const sourceBox = await page.locator('#source').boundingBox();
  const dropBox = await page.locator('#drop').boundingBox();
  assert.ok(viewport && sourceBox && dropBox);
  const thousandth = (value: number, size: number) => Math.max(1, Math.min(999, Math.round(value / size * 1000)));
  const coordinateDrag = await session.mouse({
    action: 'drag',
    xThousandth: thousandth(sourceBox.x + sourceBox.width / 2, viewport.width),
    yThousandth: thousandth(sourceBox.y + sourceBox.height / 2, viewport.height),
    toXThousandth: thousandth(dropBox.x + dropBox.width / 2, viewport.width),
    toYThousandth: thousandth(dropBox.y + dropBox.height / 2, viewport.height),
  });
  assert.equal(coordinateDrag.ok, true, coordinateDrag.actual);
  assert.match(coordinateDrag.actual, /viewport-coordinate pointer input/);
  assert.equal(await page.locator('body').getAttribute('data-dropped'), 'dragged');

  const coalescing = await page.evaluate(async () => {
    const state = (window as Window & {
      __aiDomMutationState?: { epoch: number; interactionCounts: Record<string, number> };
    }).__aiDomMutationState!;
    const epochBefore = state.epoch;
    const countBefore = state.interactionCounts.mousemove || 0;
    for (let index = 0; index < 5; index += 1) {
      document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    }
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    return {
      countDelta: (state.interactionCounts.mousemove || 0) - countBefore,
      epochDelta: state.epoch - epochBefore,
    };
  });
  assert.equal(coalescing.countDelta, 5);
  assert.equal(coalescing.epochDelta, 0, 'interaction telemetry must not invalidate the semantic DOM generation');
});

test('actionable view preserves flattened DOMSnapshot order across paginated slices', async (context) => {
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'actionable-priority-test' });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  const links = Array.from({ length: 260 }, (_, index) => (
    `<li tabindex="0"><a href="#item-${index}">Streaming result ${index} with a deliberately long accessible label</a></li>`
  )).join('');
  await page.setContent(`<!doctype html><html><body>
    <a href="/room/5351842" style="cursor:pointer"><span><strong>Sylar card</strong></span></a>
    <ul>${links}</ul>
    <input aria-label="Search streams" value="sylar">
    <button type="button">Apply filter</button>
    <div id="custom" tabindex="0" aria-label="Focusable panel">Focusable panel</div>
  </body></html>`);

  const firstSlice = await session.readSnapshotSlice({ mode: 'actionable', refresh: true, maxChars: 20000 });
  assert.equal(firstSlice.hasMore, true);
  const slices = await readWholeView(session, 'actionable');
  const actionable = slices.map((slice) => slice.content).join('\n');
  const cardIndex = actionable.indexOf('Sylar card');
  const firstLinkIndex = actionable.indexOf('link "Streaming result');
  const textboxIndex = actionable.indexOf('textbox "Search streams"');
  const buttonIndex = actionable.indexOf('button "Apply filter"');
  const panelIndex = actionable.indexOf('generic "Focusable panel"');
  assert.ok(cardIndex >= 0, actionable);
  assert.ok(firstLinkIndex >= 0, actionable);
  assert.ok(textboxIndex >= 0, actionable);
  assert.ok(buttonIndex >= 0, actionable);
  assert.ok(panelIndex >= 0, actionable);
  assert.ok(cardIndex < firstLinkIndex, actionable);
  assert.ok(firstLinkIndex < textboxIndex, actionable);
  assert.ok(textboxIndex < buttonIndex, actionable);
  assert.ok(buttonIndex < panelIndex, actionable);
  assert.equal((actionable.match(/Sylar card/g) || []).length, 1, 'nested pointer descendants should collapse into one card target');
});

test('snapshot UID mappings evict identities outside the retention window', async (context) => {
  const previousRetention = process.env.SNAPSHOT_UID_RETENTION_GENERATIONS;
  process.env.SNAPSHOT_UID_RETENTION_GENERATIONS = '2';
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'snapshot-uid-prune-test' });
  context.after(async () => {
    if (previousRetention === undefined) delete process.env.SNAPSHOT_UID_RETENTION_GENERATIONS;
    else process.env.SNAPSHOT_UID_RETENTION_GENERATIONS = previousRetention;
    await session.close();
  });
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  const snapshotUid = Reflect.get(session, 'snapshotUid').bind(session) as (page: Page, identity: string) => string;
  const pruneSnapshotUidMappings = Reflect.get(session, 'pruneSnapshotUidMappings').bind(session) as () => void;

  Reflect.set(session, 'snapshotGenerationSequence', 1);
  const expiredUid = snapshotUid(page, 'expired-identity');
  for (let generation = 2; generation <= 4; generation += 1) {
    Reflect.set(session, 'snapshotGenerationSequence', generation);
    snapshotUid(page, `current-${generation}`);
  }
  pruneSnapshotUidMappings();

  const mappings = Reflect.get(session, 'snapshotUidByIdentity') as Map<string, { uid: string }>;
  assert.equal([...mappings.values()].some((entry) => entry.uid === expiredUid), false);
});
