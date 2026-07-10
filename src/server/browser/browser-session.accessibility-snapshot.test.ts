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
      maxChars: 10000,
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

test('AX snapshot covers offscreen content and iframes, paginates records, and powers unified input', async (context) => {
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
  assert.ok(actionableSlices.length > 1, 'large actionable views should be paginated');
  assert.ok(allSlices.every((slice) => slice.content.length <= 10000));

  const actionable = actionableSlices.map((slice) => slice.content).join('\n');
  const full = fullSlices.map((slice) => slice.content).join('\n');
  const text = textSlices.map((slice) => slice.content).join('\n');
  assert.match(actionable, /Action 499/, 'offscreen actions must remain discoverable without scrolling');
  assert.match(actionable, /Frame action/, 'same-origin iframe actions must be included');
  assert.doesNotMatch(`${actionable}\n${full}\n${text}`, /Hidden child action/, 'display:none ancestors must prune descendants');
  assert.doesNotMatch(`${actionable}\n${full}\n${text}`, /Hidden frame action/, 'display:none iframe ancestors must prune the entire child document');
  assert.doesNotMatch(`${actionable}\n${full}`, /data-ai-interactive|data-ai-signals|signals=/, 'snapshot output must not spend tokens on redundant markers');

  const stableUid = actionable.match(/^\s*uid=(\S+)\s+button\s+"Stable action"/m)?.[1];
  assert.ok(stableUid, 'stable action UID should be present');
  const click = await session.mouse({ action: 'click', uid: stableUid });
  assert.equal(click.ok, true, click.actual);
  assert.equal(await page.locator('body').getAttribute('data-stable-clicked'), 'true');
  const staleClick = await session.mouse({ action: 'click', uid: stableUid });
  assert.equal(staleClick.ok, false, 'UIDs must be invalid after a browser-changing action');
  assert.match(staleClick.actual, /takeSnapshot/);

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
    views?: Record<string, { generationId?: string; chunks?: Array<{ charLength?: number; content?: string }> }>;
  };
  assert.equal(payload.version, 2);
  assert.equal(payload.format, 'chromium-accessibility-tree');
  assert.ok(payload.generationId);
  assert.deepEqual(Object.keys(payload.views || {}).sort(), ['actionable', 'full', 'text']);
  const exportedViews = Object.values(payload.views || {});
  assert.ok(exportedViews.every((view) => view.generationId === payload.generationId));
  const exportedChunks = exportedViews.flatMap((view) => view.chunks || []);
  assert.ok(exportedChunks.length > 0);
  assert.ok(exportedChunks.every((chunk) => (chunk.charLength || 0) <= 10000));
  assert.ok(exportedChunks.every((chunk) => !chunk.content?.includes('data-ai-interactive')));
  await unlink(exported.path);
});
