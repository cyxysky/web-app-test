import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright';
import { BrowserSession } from './browser-session';

test('AI mouse actions own the shared cursor while live preview input supports drag without moving it', async (context) => {
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'live-preview-cursor-test' });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.goto(`data:text/html,${encodeURIComponent(`<!doctype html><html><body style="margin:0;padding:40px;display:flex;gap:120px;align-items:flex-start">
    <button id="apply" style="height:80px;width:180px">AI target</button>
    <button id="user-click" style="height:80px;width:180px" onclick="document.body.dataset.clicked='yes'">User target</button>
    <div id="source" draggable="true" style="width:120px;height:100px;background:#2563eb">Source</div>
    <div id="target" style="width:180px;height:140px;background:#e5e7eb">Target</div>
    <script>
      source.addEventListener('dragstart', (event) => event.dataTransfer.setData('text/plain', 'source'));
      target.addEventListener('dragover', (event) => event.preventDefault());
      target.addEventListener('drop', (event) => {
        event.preventDefault();
        document.body.dataset.dropped = event.dataTransfer.getData('text/plain');
      });
    </script>
  </body></html>`)}`);

  const observation = await session.readDomObservationSnapshot({ mode: 'actionable' });
  const applyUid = observation.content.match(/uid=(dom-\d+)[^\n]*id="apply"/)?.[1];
  assert.ok(applyUid, observation.content);
  const moved = await session.mouse({ action: 'move', uid: applyUid });
  assert.equal(moved.ok, true, moved.actual);

  const applyBox = await page.locator('#apply').boundingBox();
  const clickBox = await page.locator('#user-click').boundingBox();
  const sourceBox = await page.locator('#source').boundingBox();
  const targetBox = await page.locator('#target').boundingBox();
  const viewport = page.viewportSize();
  assert.ok(applyBox && clickBox && sourceBox && targetBox && viewport);
  const aiX = applyBox.x + applyBox.width / 2;
  const aiY = applyBox.y + applyBox.height / 2;

  const clicked = await session.dispatchLiveInput({
    kind: 'click',
    xRatio: (clickBox.x + clickBox.width / 2) / viewport.width,
    yRatio: (clickBox.y + clickBox.height / 2) / viewport.height,
    button: 'left',
    clickCount: 1,
  });
  assert.equal(clicked.ok, true, clicked.actual);
  assert.equal(await page.locator('body').getAttribute('data-clicked'), 'yes');
  const dragged = await session.dispatchLiveInput({
    kind: 'drag',
    xRatio: (sourceBox.x + sourceBox.width / 2) / viewport.width,
    yRatio: (sourceBox.y + sourceBox.height / 2) / viewport.height,
    toXRatio: (targetBox.x + targetBox.width / 2) / viewport.width,
    toYRatio: (targetBox.y + targetBox.height / 2) / viewport.height,
    button: 'left',
  });
  assert.equal(dragged.ok, true, dragged.actual);
  assert.equal(await page.locator('body').getAttribute('data-dropped'), 'source');

  const cursor = await page.locator('#__ai_mouse_cursor__').evaluate((element) => ({
    opacity: (element as HTMLElement).style.opacity,
    x: Number((element as HTMLElement).dataset.x),
    y: Number((element as HTMLElement).dataset.y),
  }));
  assert.equal(cursor.opacity, '1');
  assert.ok(Math.abs(cursor.x - aiX) <= 1);
  assert.ok(Math.abs(cursor.y - aiY) <= 1);
});

test('DOM-observation takeSnapshot pages actionable, text, and full views with stable DOM UIDs', async (context) => {
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'dom-observation-pagination-test' });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  const buttons = Array.from({ length: 200 }, (_, index) => (
    `<button type="button" data-testid="page-${index}" style="display:inline-block;width:55px;height:10px;font-size:1px;overflow:hidden">${`Pagination item ${index} with descriptive text `.repeat(3)}</button>`
  )).join('');
  await page.setContent(`<!doctype html><html><body><main>${buttons}</main></body></html>`);

  for (const mode of ['actionable', 'text', 'full'] as const) {
    const pages: string[] = [];
    let result = await session.readDomObservationSnapshot({ mode });
    pages.push(result.content);
    assert.ok(result.nextCursor, `${mode} must expose a next cursor`);
    for (let guard = 0; result.nextCursor && guard < 100; guard += 1) {
      result = await session.readDomObservationSnapshot({ cursor: result.nextCursor, mode });
      pages.push(result.content);
    }
    assert.equal(result.nextCursor, undefined, `${mode} cursor must reach the end`);
    assert.match(pages.join('\n'), /Pagination item 199 with descriptive text/, `${mode} must include content from every page`);
  }
});

test('B-chain snapshot shares semantic UIDs with local AX, actions, search, and visual markers', async (context) => {
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'b-chain-unified-uid-test' });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.setContent(`<!doctype html><html><body>
    <label id="customer-label" for="customer">Customer name</label>
    <input id="customer" aria-describedby="customer-help">
    <p id="customer-help">Required billing identity</p>
    <div id="custom-submit" role="button" tabindex="0" aria-labelledby="submit-label"
      onclick="document.body.dataset.submitted='true'"><span id="submit-label">Submit order</span></div>
  </body></html>`);

  const baseline = await session.readDomObservationSnapshot({ mode: 'full' });
  assert.match(baseline.content, /<input\b[^>]*role="textbox"[^>]*accessible_name="Customer name"/);
  assert.match(baseline.content, /description="Required billing identity"/);
  const submitUid = baseline.content.match(/<div\b[^>]*uid=(dom-\d+)[^>]*role="button"[^>]*>Submit order<\/div>/)?.[1];
  assert.ok(submitUid, baseline.content);

  const inspected = await session.searchSnapshot({ uid: submitUid, includeAx: true });
  assert.equal(inspected.ok, true, inspected.actual);
  assert.match(inspected.actual, new RegExp(`uid=${submitUid}\\b`));
  assert.match(inspected.actual, /local-ax=.*button.*Submit order/i);

  const listed = await session.getInteractiveCandidates();
  assert.equal(listed.ok, true, listed.actual);
  assert.match(listed.actual, new RegExp(`uid=${submitUid}\\b`));

  let markerUids: string[] = [];
  Reflect.set(session, 'drawCandidateOverlay', async (candidates: Array<{ id: string }>) => {
    markerUids = candidates.map((candidate) => candidate.id);
  });
  await session.takeCurrentScreenshotOnly('b-chain-unified-uid-test', 1, 'visual-1', {
    capture: 'viewport',
    markers: true,
  });
  assert.ok(markerUids.includes(submitUid), `marker UIDs did not include ${submitUid}: ${markerUids.join(', ')}`);

  const clicked = await session.mouse({ action: 'click', uid: submitUid });
  assert.equal(clicked.ok, true, clicked.actual);
  assert.equal(await page.locator('body').getAttribute('data-submitted'), 'true');

  const rejectedDeepUid = await session.mouse({ action: 'click', uid: '123' });
  assert.equal(rejectedDeepUid.ok, false, rejectedDeepUid.actual);
  assert.match(rejectedDeepUid.actual, /B-chain DOM UID registry/);
});

test('B-chain reads open and intercepted closed shadow DOM by default, then pierces one missing closed root with local CDP and AX', async (context) => {
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'b-chain-shadow-test' });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.setContent(`<!doctype html><html><body>
    <section id="open-host" role="group" aria-label="Open shadow host"></section>
    <section id="captured-host" role="group" aria-label="Captured closed shadow host"></section>
    <section id="cdp-host" role="group" aria-label="CDP-only closed shadow host"></section>
    <script>
      const openRoot = document.querySelector('#open-host').attachShadow({ mode: 'open' });
      openRoot.innerHTML = '<button id="open-action">Open shadow action</button>';

      const capturedHost = document.querySelector('#captured-host');
      const capturedRoot = capturedHost.attachShadow({ mode: 'closed' });
      capturedRoot.innerHTML = '<button id="captured-action">Captured closed action</button>';

      const cdpHost = document.querySelector('#cdp-host');
      const cdpRoot = cdpHost.attachShadow({ mode: 'closed' });
      cdpRoot.innerHTML = '<button id="cdp-action" onclick="document.body.dataset.cdpClicked=\\'true\\'">CDP shadow action</button>';
      window.__aiClosedShadowRoots.delete(cdpHost);
    </script>
  </body></html>`);

  const baseline = await session.readDomObservationSnapshot({ mode: 'full' });
  assert.match(baseline.content, /Open shadow action/);
  assert.match(baseline.content, /Captured closed action/);
  assert.doesNotMatch(baseline.content, /CDP shadow action/);
  const hostUid = baseline.content.match(/<section\s+uid=(dom-\d+)[^>]*id="cdp-host"/)?.[1];
  assert.ok(hostUid, baseline.content);

  const inspected = await session.searchSnapshot({ uid: hostUid, includeShadow: true });
  assert.equal(inspected.ok, true, inspected.actual);
  assert.match(inspected.actual, /root types=closed/);
  assert.match(inspected.actual, /source="cdp-shadow"/);
  assert.match(inspected.actual, /local-ax=.*button.*CDP shadow action/i);
  const actionUid = inspected.actual.match(/<button\s+uid=(dom-\d+)[^>]*source="cdp-shadow"[^>]*>CDP shadow action<\/button>/)?.[1];
  assert.ok(actionUid, inspected.actual);

  const clicked = await session.mouse({ action: 'click', uid: actionUid });
  assert.equal(clicked.ok, true, clicked.actual);
  assert.equal(await page.locator('body').getAttribute('data-cdp-clicked'), 'true');
});

test('frozen snapshot cursors survive search, waiting, and asynchronous DOM changes', async (context) => {
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'frozen-dom-pagination-test' });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  const rows = Array.from({ length: 240 }, (_, index) => (
    `<button type="button">${`Frozen row ${index} `.repeat(12)}</button>`
  )).join('');
  await page.setContent(`<!doctype html><html><body>${rows}</body></html>`);

  const first = await session.readDomObservationSnapshot({ mode: 'full' });
  assert.ok(first.nextCursor, 'the test requires a paginated frozen result');
  await page.locator('body').evaluate((body) => body.insertAdjacentHTML('beforeend', '<button>Async addition</button>'));
  await page.waitForTimeout(20);
  const originalReadDomChanges = session.readDomChanges.bind(session);
  let readDomChangesCalls = 0;
  Reflect.set(session, 'readDomChanges', async () => {
    readDomChangesCalls += 1;
    return originalReadDomChanges();
  });

  const searched = await session.searchSnapshot({ query: 'Frozen row 1', roles: ['button'] });
  assert.equal(searched.ok, true, searched.actual);
  assert.match(searched.actual, /did not scroll, consume DOM changes, or alter snapshot pagination/);
  assert.equal(readDomChangesCalls, 0, 'searchSnapshot must not read or consume the mutation queue');
  await session.wait(0);
  const second = await session.readDomObservationSnapshot({ mode: 'full', cursor: first.nextCursor });
  assert.equal(second.pageNumber, 2);

  const refreshed = await session.readDomObservationSnapshot({ mode: 'full' });
  assert.ok(refreshed.nextCursor);
  const buttonUid = refreshed.content.match(/uid=(dom-\d+)[^\n]*Frozen row/)?.[1];
  assert.ok(buttonUid, refreshed.content);
  const clicked = await session.mouse({ action: 'click', uid: buttonUid });
  assert.equal(clicked.ok, true, clicked.actual);
  await assert.rejects(
    session.readDomObservationSnapshot({ mode: 'full', cursor: refreshed.nextCursor }),
    /cursor is no longer available/,
    'a UI-affecting interaction must invalidate the frozen cursor',
  );
});

test('inter-action changes retain all DOM mutations and request summaries until the next interaction', async (context) => {
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'inter-action-changes-test' });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.setContent('<!doctype html><html><body><main id="root"><span id="gone">temporary node</span></main></body></html>');
  await session.wait(100);
  await page.route('https://change-journal.test/inter-action-request', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ message: 'request completed' }),
  }));

  await page.evaluate(async () => {
    const root = document.querySelector('#root')!;
    root.insertAdjacentHTML('beforeend', '<section class="background-result"><span class="detail">Delayed validation detail</span></section>');
    document.querySelector('#gone')?.remove();
    await fetch('https://change-journal.test/inter-action-request');
  });
  await page.waitForTimeout(20);

  const first = await session.readDomObservationSnapshot({ mode: 'changes' });
  assert.match(first.content, /background-result/);
  assert.match(first.content, /Delayed validation detail/);
  assert.match(first.content, /id="gone"/);
  assert.match(first.content, /request id=.*change-journal\.test\/inter-action-request/);
  const requestId = first.content.match(/request id=(\S+)/)?.[1];
  assert.ok(requestId, 'changes must expose an ID for a later request-detail query');
  const requestDetail = await session.getCurrentTabHttpRequests({ ids: [requestId] });
  assert.match(requestDetail.actual, /request completed/);

  const second = await session.readDomObservationSnapshot({ mode: 'changes' });
  assert.match(second.content, /background-result/, 'reading changes must not clear the active journal');

  await session.wait(100);
  const afterNextInteraction = await session.readDomObservationSnapshot({ mode: 'changes' });
  assert.doesNotMatch(afterNextInteraction.content, /background-result/, 'the next interaction must start a new journal window');
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

  const searchWithoutBaseline = await session.searchSnapshot({ query: 'Save' });
  assert.equal(searchWithoutBaseline.ok, false, searchWithoutBaseline.actual);
  assert.match(searchWithoutBaseline.actual, /requires an active B-chain DOM baseline/);

  await page.locator('#cover').evaluate((element) => element.remove());
  const bBaseline = await session.readDomObservationSnapshot({ mode: 'full' });
  const bSaveUid = bBaseline.content.match(/uid=(dom-\d+)[^\n]*id="save"/)?.[1];
  const bEditorUid = bBaseline.content.match(/uid=(dom-\d+)[^\n]*id="renamed-editor"/)?.[1];
  assert.ok(bSaveUid && bEditorUid, bBaseline.content);
  await page.locator('body').evaluate((body) => {
    body.insertAdjacentHTML('beforeend', '<div id="cover" style="position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.1)"></div>');
  });
  const covered = await session.mouse({ action: 'click', uid: bSaveUid });
  assert.equal(covered.ok, false);
  assert.match(covered.actual, /covered/);

  await page.locator('#cover').evaluate((element) => element.remove());
  const mutationRefresh = await session.wait(100);
  assert.equal(mutationRefresh.ok, true, mutationRefresh.actual);
  assert.ok(mutationRefresh.domChanges, 'wait must expose observed changes structurally');
  assert.doesNotMatch(mutationRefresh.actual, /DOM incremental changes/);
  const unchangedReuse = await session.wait(100);
  assert.equal(unchangedReuse.ok, true, unchangedReuse.actual);
  assert.ok(unchangedReuse.domChanges);
  assert.doesNotMatch(unchangedReuse.actual, /DOM incremental changes/);

  await page.mouse.move(3, 3);
  const interactionOnlyReuse = await session.wait(0);
  assert.equal(interactionOnlyReuse.ok, true, interactionOnlyReuse.actual);
  assert.ok(interactionOnlyReuse.domChanges, 'pointer events alone must not force a full semantic snapshot');
  assert.doesNotMatch(interactionOnlyReuse.actual, /DOM incremental changes/);

  await page.locator('#renamed-editor').evaluate((element) => element.setAttribute('aria-label', 'Renamed editor'));
  const afterRename = (await session.readDomObservationSnapshot({ mode: 'actionable' })).content;
  const currentSaveUid = afterRename.match(/uid=(dom-\d+)[^\n]*id="save"/)?.[1];
  const currentRenamedEditorUid = afterRename.match(/uid=(dom-\d+)[^\n]*id="renamed-editor"/)?.[1];
  assert.ok(currentSaveUid && currentRenamedEditorUid);
  const renamedEditor = await session.keyboard({ action: 'type', uid: currentRenamedEditorUid, text: 'retained', replace: true });
  assert.equal(renamedEditor.ok, true, renamedEditor.actual);
  assert.doesNotMatch(renamedEditor.actual, /target semantics changed|Capture a fresh snapshot/, 'a stable DOM node must remain actionable when its accessible name changes');
  assert.ok(renamedEditor.domChanges, 'an action must return its page delta as structured domChanges');
  assert.equal('observationViews' in renamedEditor, false, 'an action must not return a duplicate text observation view');
  assert.doesNotMatch(renamedEditor.actual, /DOM incremental changes/, 'action text must not embed the DOM delta a second time');
  assert.equal(await page.locator('#renamed-editor').inputValue(), 'retained');

  await page.locator('body').evaluate((body) => body.insertAdjacentHTML('beforeend', '<button>Late action</button>'));
  const clickAfterUnrelatedMutation = await session.mouse({ action: 'click', uid: currentSaveUid });
  assert.equal(clickAfterUnrelatedMutation.ok, true, clickAfterUnrelatedMutation.actual);
  assert.doesNotMatch(clickAfterUnrelatedMutation.actual, /Capture a fresh snapshot/, 'stable UIDs should rebind after unrelated DOM mutations');
  assert.equal(await page.locator('body').getAttribute('data-saved'), 'true');

  const domBaseline = await session.readDomObservationSnapshot({ mode: 'actionable' });
  const domSaveUid = domBaseline.content.match(/uid=(dom-\d+)[^\n]*id="save"/)?.[1];
  assert.ok(domSaveUid, domBaseline.content);
  const domSearch = await session.searchSnapshot({ query: 'Save', roles: ['button'] });
  assert.equal(domSearch.ok, true, domSearch.actual);
  assert.match(domSearch.actual, new RegExp(`uid=${domSaveUid}\\b`), 'a DOM-baseline search must return the same dom-* namespace as takeSnapshot');
  const frozenLateSearch = await session.searchSnapshot({ query: 'Late action', roles: ['button'] });
  assert.equal(frozenLateSearch.ok, true, frozenLateSearch.actual);
  assert.match(frozenLateSearch.actual, /returned 0 result/, 'search must remain a pure read of the frozen baseline');
  await session.readDomObservationSnapshot({ mode: 'full' });
  const lateSearch = await session.searchSnapshot({ query: 'Late action', roles: ['button'] });
  assert.match(lateSearch.actual, /<button\b[^>]*>Late action<\/button>/, 'a fresh B-chain baseline must include the new offscreen action');
  const domUidClick = await session.mouse({ action: 'click', uid: domSaveUid });
  assert.equal(domUidClick.ok, true, domUidClick.actual);
  await page.locator('#save').evaluate((button) => button.replaceWith(button.cloneNode(true)));
  const replacementDelta = await session.readDomChanges();
  assert.ok(replacementDelta.domChanges?.removed.includes(domSaveUid), replacementDelta.actual);
  const replacedTarget = await session.mouse({ action: 'click', uid: domSaveUid });
  assert.equal(replacedTarget.ok, false, replacedTarget.actual);
  assert.match(replacedTarget.actual, /absent from the current B-chain DOM UID registry/);
});

test('DOM baseline ranks modal duplicates and describes virtual lists', async (context) => {
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'dom-ranking-and-virtual-list-test' });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.setContent(`<!doctype html><html><body>
    <button data-testid="page-delete" type="button">Delete</button>
    <dialog open aria-modal="true"><h2>Delete account</h2><button data-testid="modal-delete" type="button">Delete</button></dialog>
    <div id="virtual-list" aria-label="Results" style="height:100px;overflow-y:auto">
      ${Array.from({ length: 20 }, (_, index) => `<div style="height:30px">Result ${index + 1}</div>`).join('')}
    </div>
  </body></html>`);

  const baseline = await session.readDomObservationSnapshot({ mode: 'actionable' });
  assert.match(baseline.content, /virtualized="possible"/);
  assert.match(baseline.content, /actions="scroll,search"/);
  assert.match(baseline.content, /visible_range="\d+-\d+"/);

  const modalUid = baseline.content.match(/uid=(dom-\d+)[^\n]*data-testid="modal-delete"/)?.[1];
  assert.ok(modalUid, baseline.content);
  assert.ok(
    baseline.content.indexOf('data-testid="modal-delete"') < baseline.content.indexOf('data-testid="page-delete"'),
    `modal actions should receive the first budget tier:\n${baseline.content}`,
  );
  const indexedReferences = Reflect.get(session, 'lastDomNodeReferences') as Map<string, { searchText?: string; semanticRoles?: string[] }>;
  assert.ok([...indexedReferences.values()].every((reference) => reference.searchText && reference.semanticRoles?.length), 'DOM references should be indexed when the baseline is created');
  const ranked = await session.searchSnapshot({ query: 'Delete', roles: ['button'] });
  assert.equal(ranked.ok, true, ranked.actual);
  assert.equal(ranked.actual.match(/uid=(dom-\d+)/)?.[1], modalUid, ranked.actual);
});

test('searchSnapshot is a pure frozen-baseline read and never scrolls virtual lists', async (context) => {
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'virtual-list-progressive-search-test' });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.setContent(`<!doctype html><html><body>
    <div id="virtual-results" aria-label="Virtual results" style="height:120px;overflow-y:auto;border:1px solid black">
      ${Array.from({ length: 50 }, (_, index) => `<button type="button" style="display:block;height:30px;width:180px" onclick="this.dataset.clicked='true'">Virtual item ${index + 1}</button>`).join('')}
    </div>
  </body></html>`);
  const baseline = await session.readDomObservationSnapshot({ mode: 'actionable' });
  assert.match(baseline.content, /virtualized="possible"/);
  assert.doesNotMatch(baseline.content, /Virtual item 40/);

  const searched = await session.searchSnapshot({ query: 'Virtual item 40', roles: ['button'] });
  assert.equal(searched.ok, true, searched.actual);
  assert.match(searched.actual, /returned 0 result/);
  assert.equal(await page.locator('#virtual-results').evaluate((element) => element.scrollTop), 0);
  const scrollBeforeMissingSearch = await page.locator('#virtual-results').evaluate((element) => element.scrollTop);
  const missing = await session.searchSnapshot({ query: 'Virtual item 999', roles: ['button'] });
  assert.equal(missing.ok, true, missing.actual);
  assert.match(missing.actual, /returned 0 result/);
  const scrollAfterMissingSearch = await page.locator('#virtual-results').evaluate((element) => element.scrollTop);
  assert.ok(Math.abs(scrollAfterMissingSearch - scrollBeforeMissingSearch) <= 1, `${scrollBeforeMissingSearch} -> ${scrollAfterMissingSearch}`);
});

test('searchSnapshot tag returns every matching element from the frozen full DOM', async (context) => {
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'snapshot-tag-search-test' });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.setContent(`<!doctype html><html><body>
    <a href="/one">First link</a>
    <main style="margin-top:2000px"><a href="/two">Offscreen link</a></main>
    <button type="button">Not a link</button>
  </body></html>`);
  await session.readDomObservationSnapshot({ mode: 'full' });

  const result = await session.searchSnapshot({ tag: 'a', limit: 1 });
  assert.equal(result.ok, true, result.actual);
  assert.match(result.actual, /returned 2 result/);
  assert.match(result.actual, /First link/);
  assert.match(result.actual, /Offscreen link/);
  assert.doesNotMatch(result.actual, /Not a link/);
});

test('DOM mutation deltas coalesce repeated attributes and promote nested text changes to interactive roots', async (context) => {
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'dom-mutation-coalescing-test' });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.setContent(`<!doctype html><html><body>
    <button data-testid="label-button" type="button"><span>Before label</span></button>
    <button data-testid="changing" type="button" aria-label="Before">Changing</button>
  </body></html>`);
  await session.readDomObservationSnapshot({ mode: 'actionable' });

  await page.evaluate(() => {
    const changing = document.querySelector('[data-testid="changing"]')!;
    for (let index = 0; index < 50; index += 1) changing.setAttribute('aria-label', `After ${index}`);
    document.querySelector('[data-testid="label-button"] span')!.textContent = 'After label';
  });

  const delta = await session.readDomChanges();
  const changingUpdates = delta.domChanges?.updated.filter((line) => line.includes('data-testid="changing"')) || [];
  const labelUpdates = delta.domChanges?.updated.filter((line) => line.includes('data-testid="label-button"')) || [];
  assert.equal(changingUpdates.length, 1, JSON.stringify(delta.domChanges));
  assert.match(changingUpdates[0], /aria-label="After 49"/);
  assert.equal(labelUpdates.length, 1, JSON.stringify(delta.domChanges));
  assert.match(labelUpdates[0], />After label<\/button>/);
});

test('DOM mutation deltas expose non-actionable semantic context and page diagnostics under extra', async (context) => {
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'dom-mutation-extra-test' });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.setContent('<!doctype html><html><body><button type="button">Open</button></body></html>');
  await session.readDomObservationSnapshot({ mode: 'actionable' });

  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<section><p data-testid="notice">Saved successfully</p></section>');
    console.error('post-action validation failed');
  });

  const delta = await session.readDomChanges();
  assert.match(delta.domChanges?.extra.added.join('\n') || '', /data-testid="notice"[^>]*>Saved successfully<\/p>/);
  assert.doesNotMatch(delta.domChanges?.extra.added.join('\n') || '', /\buid=|\bnode_id=/);
  assert.ok(delta.domChanges?.extra.errors.some((entry) => entry.includes('[console] post-action validation failed')));
});

test('post-action form validation errors are elevated instead of remaining only in extra context', async (context) => {
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'dom-validation-error-test' });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.setContent(`<!doctype html><html><body>
    <button id="submit" type="button" onclick="document.body.insertAdjacentHTML('beforeend', '<div class=&quot;error&quot;>Link is required</div>')">Submit</button>
  </body></html>`);
  const baseline = await session.readDomObservationSnapshot({ mode: 'actionable' });
  const uid = baseline.content.match(/uid=(dom-\d+)[^\n]*>Submit<\/button>/)?.[1];
  assert.ok(uid, baseline.content);

  const result = await session.mouse({ action: 'click', uid });
  assert.match(result.actual, /Post-action form validation failed: Link is required/);
  assert.deepEqual(result.domChanges?.extra.validationErrors, ['Link is required']);
});

test('SVG parents and children with independent click boundaries remain separate actions', async (context) => {
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'svg-action-boundary-test' });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.setContent(`<!doctype html><html><body>
    <svg id="chart" role="button" aria-label="Chart action" width="220" height="100" style="cursor:pointer;border:1px solid black">
      <rect id="bar" role="button" aria-label="Chart action" x="20" y="20" width="80" height="60" fill="teal" style="cursor:pointer" />
      ${Array.from({ length: 400 }, (_, index) => `<path d="M ${120 + index % 80} ${10 + index % 80} h 1" />`).join('')}
    </svg>
    <script>
      document.getElementById('chart').addEventListener('click', () => document.body.dataset.parentClicked = 'true');
      document.getElementById('bar').addEventListener('click', event => { event.stopPropagation(); document.body.dataset.childClicked = 'true'; });
    </script>
  </body></html>`);

  const baseline = await session.readDomObservationSnapshot({ mode: 'actionable' });
  assert.match(baseline.content, /<svg\b[^>]*action_scope="container"/);
  assert.match(baseline.content, /<rect\b[^>]*action_scope="own"/);
  const liveUids = baseline.content.match(/uid=dom-\d+/g) || [];
  assert.equal(liveUids.length >= 2, true, baseline.content);

  const semantic = (await session.readDomObservationSnapshot({ mode: 'actionable' })).content;
  assert.equal((semantic.match(/aria-label="Chart action"/g) || []).length, 2, semantic);
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
  const actionable = (await session.readDomObservationSnapshot({ mode: 'actionable' })).content;
  assert.match(actionable, />Final action<\/button>/);
  assert.doesNotMatch(actionable, /Initial action|Intermediate action/);
  const bActionable = await session.readDomObservationSnapshot({ mode: 'actionable' });
  const finalUid = bActionable.content.match(/uid=(dom-\d+)[^\n]*>Final action<\/button>/)?.[1];
  assert.ok(finalUid, bActionable.content);
  const clicked = await session.mouse({ action: 'click', uid: finalUid });
  assert.equal(clicked.ok, true, clicked.actual);
  const page = Reflect.get(session, 'activePage') as Page;
  assert.equal(await page.locator('body').getAttribute('data-final-clicked'), 'true');

  await page.reload({ waitUntil: 'commit' });
  const sameUrlNavigation = await session.wait(0);
  assert.equal(sameUrlNavigation.ok, true, sameUrlNavigation.actual);
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
  assert.match((await session.readDomObservationSnapshot({ mode: 'actionable' })).content, /Live action/);
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

  const actionable = (await session.readDomObservationSnapshot({ mode: 'full' })).content;
  const uidForId = (id: string) => actionable.match(new RegExp(`uid=(dom-\\d+)[^\\n]*id="${id}"`))?.[1];
  const hoverUid = uidForId('hover-target');
  const editorUid = uidForId('editor');
  const sourceUid = uidForId('source');
  const dropUid = uidForId('drop');
  const scrollerUid = uidForId('scroller');
  const deepUid = actionable.match(/uid=(dom-\d+)[^\n]*>Deep action<\/button>/)?.[1];
  assert.ok(hoverUid && editorUid && sourceUid && dropUid && scrollerUid && deepUid, actionable);

  const move = await session.mouse({ action: 'move', uid: hoverUid });
  assert.equal(move.ok, true, move.actual);
  assert.match(move.actual, /Playwright hover|viewport coordinates/);
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

test('typing followed by Enter accepts navigation when the old document telemetry is replaced', async (context) => {
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'keyboard-navigation-verification-test' });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
    <form action="about:blank">
      <input aria-label="Navigate away" name="query" value="">
    </form>`));

  const actionable = (await session.readDomObservationSnapshot({ mode: 'actionable' })).content;
  const inputUid = actionable.match(/<input\s+uid=(dom-\S+)[^>]*aria-label="Navigate away"/m)?.[1];
  assert.ok(inputUid, actionable);

  const typed = await session.keyboard({ action: 'type', followByEnter: true, text: 'go', uid: inputUid });
  assert.equal(typed.ok, true, typed.actual);
  assert.match(typed.actual, /navigation=true/);
  assert.equal(page.url(), 'about:blank?query=go');
});

test('native select options and rich-text iframe entry use explicit DOM-baseline actions', async (context) => {
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'select-and-rich-text-test' });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body>
    <select id="category" aria-label="故障分类"><option value="">无</option><option value="15002">新增需求或本身的bug</option><option value="15004">其他问题</option></select>
    <iframe title="Rich Text Area" srcdoc="<!doctype html><body contenteditable='true' aria-label='Rich Text Area'></body>"></iframe>
  </body></html>`)} `);
  const actionable = await session.readDomObservationSnapshot({ mode: 'actionable' });
  const selectUid = actionable.content.match(/<select\s+uid=(dom-\S+)[^>]*options="[^"]*15002=新增需求或本身的bug/)?.[1];
  assert.ok(selectUid, actionable.content);
  const clicked = await session.mouse({ action: 'click', uid: selectUid });
  assert.equal(clicked.ok, true, clicked.actual);
  assert.match(clicked.actual, /Use interact action=selectOption .* exact option value or full label/);
  assert.match(clicked.domChanges?.updated.join('\n') || '', /<select\s+uid=dom-\S+[^>]*options="[^"]*15002=/);
  const rejectedKeyboardSelection = await session.keyboard({ action: 'press', key: 'ArrowDown' });
  assert.equal(rejectedKeyboardSelection.ok, false, rejectedKeyboardSelection.actual);
  assert.match(rejectedKeyboardSelection.actual, /Use interact action=selectOption/);
  assert.equal(await page.locator('#category').inputValue(), '');
  const selected = await session.selectOption({ uid: selectUid, value: '15002' });
  assert.equal(selected.ok, true, selected.actual);
  assert.equal(await page.locator('#category').inputValue(), '15002');

  const full = await session.readDomObservationSnapshot({ mode: 'full' });
  const iframeUid = full.content.match(/<iframe\s+uid=(dom-\S+)[^>]*title="Rich Text Area"/)?.[1];
  assert.ok(iframeUid, full.content);
  const typed = await session.keyboard({ action: 'type', uid: iframeUid, text: '富文本内容', replace: true });
  assert.equal(typed.ok, true, typed.actual);
  const richTextFrame = page.frames().find((frame) => frame !== page.mainFrame());
  assert.equal(await richTextFrame?.locator('body').textContent(), '富文本内容');
});
