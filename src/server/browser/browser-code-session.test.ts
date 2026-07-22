import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { Page } from 'playwright';
import { BrowserSession } from './browser-session';

test('BrowserSession executes browserCode against the controlled Playwright page', async (context) => {
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'browser-code-session-test' });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.setContent(`
    <!doctype html>
    <html><body>
      <label>Name <input aria-label="Name"></label>
      <label>Password <input type="password" aria-label="Password"></label>
      <label>Role
        <select aria-label="Role">
          <option value="viewer">Viewer</option>
          <option value="admin">Admin</option>
        </select>
      </label>
      <button type="button" onclick="document.body.dataset.applied = 'yes'">Apply</button>
    </body></html>
  `);

  const action = await session.executeBrowserCode({
    code: `
      const name = page.locator('[aria-label="Name"]');
      await name.click();
      const nameBox = await name.boundingBox();
      const locatorCursor = await page.locator('#__ai_mouse_cursor__').evaluate((element) => ({
        x: Number(element.dataset.x),
        y: Number(element.dataset.y),
      }));
      await page.keyboard.type('Alice');
      await page.getByLabel('Role').selectOption('admin');
      const button = page.getByRole('button', { name: 'Apply' });
      const buttonLabel = await button.evaluate((element, suffix) => element.textContent + suffix, '!');
      const buttonBox = await button.boundingBox();
      if (!buttonBox) throw new Error('Apply button is not visible');
      await page.mouse.click(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2);
      const state = await page.evaluate(() => ({
        name: document.querySelector('[aria-label="Name"]').value,
        role: document.querySelector('[aria-label="Role"]').value,
        applied: document.body.dataset.applied,
      }));
      var sessionResult = {
        buttonLabel,
        locatorCursor,
        nameBox,
        state,
        url: page.url(),
        uidType: typeof page.uid,
        nativeContext: typeof context.newCDPSession === 'function',
        pageCount: context.pages().length,
      };
      await nodeRepl.emitImage(await page.screenshot({ type: 'png' }));
      nodeRepl.write(sessionResult);
    `,
    runId: 'browser-code-session-test',
    stepIndex: 1,
  });

  assert.equal(action.ok, true, action.actual);
  const result = JSON.parse(action.actual) as {
    result?: {
      buttonLabel?: string;
      locatorCursor?: { x: number; y: number };
      nameBox?: { height: number; width: number; x: number; y: number };
      state?: { name?: string; role?: string; applied?: string };
      url?: string;
      uidType?: string;
      nativeContext?: boolean;
      pageCount?: number;
    };
  };
  assert.deepEqual(result.result?.state, { name: 'Alice', role: 'admin', applied: 'yes' });
  assert.equal(result.result?.buttonLabel, 'Apply!');
  assert.ok(result.result?.nameBox);
  assert.ok(Math.abs((result.result?.locatorCursor?.x || 0) - (result.result.nameBox.x + result.result.nameBox.width / 2)) <= 1);
  assert.ok(Math.abs((result.result?.locatorCursor?.y || 0) - (result.result.nameBox.y + result.result.nameBox.height / 2)) <= 1);
  assert.match(result.result?.url || '', /^about:blank$/);
  assert.equal(result.result?.uidType, 'undefined');
  assert.equal(result.result?.nativeContext, true);
  assert.equal(result.result?.pageCount, 1);
  assert.equal(action.referenceImagePaths?.length, 1);
  assert.equal((await readFile(action.referenceImagePaths?.[0] || '')).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(await page.getByLabel('Name').inputValue(), 'Alice');
  assert.equal(await page.getByLabel('Role').inputValue(), 'admin');
  const cursorState = await page.locator('#__ai_mouse_cursor__').evaluate((element) => ({
    opacity: (element as HTMLElement).style.opacity,
    x: Number((element as HTMLElement).dataset.x),
    y: Number((element as HTMLElement).dataset.y),
  }));
  const applyBox = await page.getByRole('button', { name: 'Apply' }).boundingBox();
  assert.equal(cursorState.opacity, '1');
  assert.ok(applyBox);
  assert.ok(Math.abs(cursorState.x - (applyBox.x + applyBox.width / 2)) <= 1);
  assert.ok(Math.abs(cursorState.y - (applyBox.y + applyBox.height / 2)) <= 1);
});
