import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserSession, type BrowserLiveNativeEvent } from '@webpilot/capability-browser/node';

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

describe('browser live-preview native controls', () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('bridges picker, datalist, file chooser, alert, confirm, and prompt', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'webpilot-live-native-'));
    cleanups.push(() => rm(temporaryDirectory, { force: true, recursive: true }));
    const uploadPath = path.join(temporaryDirectory, 'employee-note.txt');
    await writeFile(uploadPath, 'live preview upload');

    const session = new BrowserSession({
      headless: true,
      isolated: true,
      runId: 'browser-live-preview-native-controls-vitest',
    });
    cleanups.push(() => session.close());
    await session.start();
    const page = Reflect.get(session, 'activePage') as Page;
    await page.setContent(`
      <label>Start date <input id="start-date" type="date"></label>
      <label>Office <input id="office" list="offices"></label>
      <datalist id="offices"><option value="Hong Kong"><option value="Shenzhen"></datalist>
      <button id="upload-trigger" onclick="upload.click()">Upload employee note</button>
      <input id="upload" type="file" accept="text/plain" hidden>
      <button id="alert-trigger" onclick="alert('Saved successfully'); document.body.dataset.alert='done'">Alert</button>
      <button id="confirm-trigger" onclick="document.body.dataset.confirm=String(confirm('Approve this record?'))">Confirm</button>
      <button id="prompt-trigger" onclick="document.body.dataset.prompt=prompt('Employee ID', 'E-001') || ''">Prompt</button>
      <script>
        document.getElementById('start-date').addEventListener('change', (event) => { document.body.dataset.startDate = event.target.value; });
        document.getElementById('office').addEventListener('change', (event) => { document.body.dataset.office = event.target.value; });
        upload.addEventListener('change', () => { document.body.dataset.file = upload.files?.[0]?.name || ''; });
      </script>
    `);

    const click = async (selector: string) => {
      const box = await page.locator(selector).boundingBox();
      const viewport = page.viewportSize();
      expect(box).toBeTruthy();
      expect(viewport).toBeTruthy();
      return session.dispatchLiveInput({
        button: 'left',
        clickCount: 1,
        kind: 'click',
        xRatio: (box!.x + box!.width / 2) / viewport!.width,
        yRatio: (box!.y + box!.height / 2) / viewport!.height,
      });
    };

    const dateOpened = await click('#start-date');
    expect(dateOpened.liveControl?.kind).toBe('picker');
    if (dateOpened.liveControl?.kind !== 'picker') throw new Error('Date picker was not bridged');
    expect((await session.dispatchLiveInput({
      controlKind: 'picker',
      kind: 'controlValue',
      value: '2026-08-15',
      xRatio: dateOpened.liveControl.targetXRatio,
      yRatio: dateOpened.liveControl.targetYRatio,
    })).ok).toBe(true);
    expect(await page.locator('body').getAttribute('data-start-date')).toBe('2026-08-15');

    const datalistOpened = await click('#office');
    expect(datalistOpened.liveControl?.kind).toBe('datalist');
    if (datalistOpened.liveControl?.kind !== 'datalist') throw new Error('Datalist was not bridged');
    expect(datalistOpened.liveControl.options.map((option) => option.value)).toEqual(['Hong Kong', 'Shenzhen']);
    expect((await session.dispatchLiveInput({
      controlKind: 'datalist',
      kind: 'controlValue',
      value: 'Shenzhen',
      xRatio: datalistOpened.liveControl.targetXRatio,
      yRatio: datalistOpened.liveControl.targetYRatio,
    })).ok).toBe(true);
    expect(await page.locator('#office').inputValue()).toBe('Shenzhen');

    const nativeEvents: BrowserLiveNativeEvent[] = [];
    const screencast = await session.startScreencast({
      onFrame: () => undefined,
      onNativeEvent: (event) => nativeEvents.push(event),
    });
    cleanups.push(() => screencast.stop());

    await click('#upload-trigger');
    await waitFor(() => nativeEvents.some((event) => event.kind === 'controlOpened' && event.control.kind === 'file'));
    const fileEvent = nativeEvents.find((event) => event.kind === 'controlOpened' && event.control.kind === 'file');
    if (fileEvent?.kind !== 'controlOpened' || fileEvent.control.kind !== 'file') throw new Error('File chooser was not bridged');
    expect(fileEvent.control.accept).toBe('text/plain');
    expect((await session.dispatchLiveInput({
      controlId: fileEvent.control.controlId,
      files: [{ mimeType: 'text/plain', name: 'employee-note.txt', path: uploadPath }],
      kind: 'files',
    })).ok).toBe(true);
    expect(await page.locator('body').getAttribute('data-file')).toBe('employee-note.txt');
    expect(await page.locator('#upload').evaluate(async (input: HTMLInputElement) => input.files?.[0]?.text())).toBe('live preview upload');

    const resolveDialog = async (selector: string, expectedType: 'alert' | 'confirm' | 'prompt', accept: boolean, promptText?: string) => {
      const eventOffset = nativeEvents.length;
      await click(selector);
      await waitFor(() => nativeEvents.slice(eventOffset).some((event) => event.kind === 'dialogOpened'));
      const event = nativeEvents.slice(eventOffset).find((candidate) => candidate.kind === 'dialogOpened');
      if (event?.kind !== 'dialogOpened') throw new Error('Dialog was not bridged');
      expect(event.dialog.dialogType).toBe(expectedType);
      expect((await session.dispatchLiveInput({
        accept,
        dialogId: event.dialog.id,
        kind: 'dialog',
        ...(promptText === undefined ? {} : { promptText }),
      })).ok).toBe(true);
    };

    await resolveDialog('#alert-trigger', 'alert', true);
    await resolveDialog('#confirm-trigger', 'confirm', false);
    await resolveDialog('#prompt-trigger', 'prompt', true, 'E-007');
    expect(await page.locator('body').getAttribute('data-alert')).toBe('done');
    expect(await page.locator('body').getAttribute('data-confirm')).toBe('false');
    expect(await page.locator('body').getAttribute('data-prompt')).toBe('E-007');
  }, 60_000);

  it('keeps a live-preview popup in the background until it is selected', async () => {
    const session = new BrowserSession({
      headless: true,
      isolated: true,
      runId: 'browser-live-preview-background-popup-vitest',
    });
    cleanups.push(() => session.close());
    await session.start();
    const page = Reflect.get(session, 'activePage') as Page;
    await page.setContent(`
      <button id="open-detail" onclick="window.open('about:blank#download', '_blank')">Download in new tab</button>
    `);

    const initialTabs = await session.refreshTabsSnapshot();
    const originalTabId = initialTabs[0]?.id;
    expect(originalTabId).toBeTruthy();
    const frameUrls: string[] = [];
    const screencast = await session.startScreencast({
      onFrame: (frame) => { frameUrls.push(frame.url); },
    });
    cleanups.push(() => screencast.stop());

    const box = await page.locator('#open-detail').boundingBox();
    const viewport = page.viewportSize();
    expect(box).toBeTruthy();
    expect(viewport).toBeTruthy();
    expect((await session.dispatchLiveInput({
      button: 'left',
      clickCount: 1,
      kind: 'click',
      xRatio: (box!.x + box!.width / 2) / viewport!.width,
      yRatio: (box!.y + box!.height / 2) / viewport!.height,
    })).ok).toBe(true);

    await waitFor(async () => (await session.refreshTabsSnapshot()).length === 2);
    const popupTabs = await session.refreshTabsSnapshot();
    expect(popupTabs.find((tab) => tab.id === originalTabId)?.active).toBe(true);
    expect(frameUrls.some((url) => url.endsWith('#download'))).toBe(false);

    const popupTabId = popupTabs.find((tab) => tab.url.endsWith('#download'))?.id;
    expect(popupTabId).toBeTruthy();
    expect((await session.switchLivePreviewTab(popupTabId!)).ok).toBe(true);
    await waitFor(() => frameUrls.some((url) => url.endsWith('#download')));
  }, 60_000);

  it('cancels the controlled-browser download and relays its URL to the user browser', async () => {
    const runId = 'chat_browser_live_preview_download_vitest';
    const session = new BrowserSession({
      headless: true,
      isolated: true,
      runId,
    });
    cleanups.push(() => session.close());
    await session.start();
    const page = Reflect.get(session, 'activePage') as Page;
    await page.route('https://preview-download.test/report', (route) => route.fulfill({
      body: 'name,department\nTest User,R&D\n',
      contentType: 'text/csv',
      headers: { 'Content-Disposition': 'attachment; filename="employee report.csv"' },
      status: 200,
    }));
    await page.setContent(`
      <a id="download-report" href="https://preview-download.test/report">Open report</a>
    `);

    const nativeEvents: BrowserLiveNativeEvent[] = [];
    const screencast = await session.startScreencast({
      onFrame: () => undefined,
      onNativeEvent: (event) => nativeEvents.push(event),
    });
    cleanups.push(() => screencast.stop());

    const box = await page.locator('#download-report').boundingBox();
    const viewport = page.viewportSize();
    expect(box).toBeTruthy();
    expect(viewport).toBeTruthy();
    const controlledDownloadPromise = page.waitForEvent('download');
    expect((await session.dispatchLiveInput({
      button: 'left',
      clickCount: 1,
      kind: 'click',
      xRatio: (box!.x + box!.width / 2) / viewport!.width,
      yRatio: (box!.y + box!.height / 2) / viewport!.height,
    })).ok).toBe(true);
    const controlledDownload = await controlledDownloadPromise;

    await waitFor(() => nativeEvents.some((event) => event.kind === 'downloadReady'));
    expect(nativeEvents.some((event) => event.kind === 'downloadStarted')).toBe(true);
    const readyEvent = nativeEvents.find((event) => event.kind === 'downloadReady');
    if (readyEvent?.kind !== 'downloadReady') throw new Error('Browser download was not relayed');
    expect(readyEvent.download.fileName).toBe('employee report.csv');
    expect(readyEvent.download.bytes).toBeUndefined();
    expect(readyEvent.download.url).toBe('https://preview-download.test/report');
    expect(await controlledDownload.failure()).toBe('canceled');
    expect(page.url()).toBe('about:blank');
  }, 60_000);

  it('intercepts a visible download link before the controlled browser requests it', async () => {
    const session = new BrowserSession({
      headless: true,
      isolated: true,
      runId: 'chat_browser_live_preview_direct_download_vitest',
    });
    cleanups.push(() => session.close());
    await session.start();
    const page = Reflect.get(session, 'activePage') as Page;
    let requestCount = 0;
    await page.route('https://preview-download.test/direct/docx', (route) => {
      requestCount += 1;
      return route.fulfill({ body: 'should not be requested by the controlled browser', status: 200 });
    });
    await page.setContent(`
      <a id="direct-download" href="https://preview-download.test/direct/docx">下载 DOCX 示例</a>
    `);

    const nativeEvents: BrowserLiveNativeEvent[] = [];
    const screencast = await session.startScreencast({
      onFrame: () => undefined,
      onNativeEvent: (event) => nativeEvents.push(event),
    });
    cleanups.push(() => screencast.stop());
    const box = await page.locator('#direct-download').boundingBox();
    const viewport = page.viewportSize();
    expect(box).toBeTruthy();
    expect(viewport).toBeTruthy();
    const result = await session.dispatchLiveInput({
      button: 'left',
      clickCount: 1,
      kind: 'click',
      xRatio: (box!.x + box!.width / 2) / viewport!.width,
      yRatio: (box!.y + box!.height / 2) / viewport!.height,
    });

    expect(result.ok).toBe(true);
    expect(result.actual).toContain('Relayed download link to the user browser');
    const readyEvent = nativeEvents.find((event) => event.kind === 'downloadReady');
    if (readyEvent?.kind !== 'downloadReady') throw new Error('Download link was not intercepted');
    expect(readyEvent.download.fileName).toBe('DOCX 示例');
    expect(readyEvent.download.url).toBe('https://preview-download.test/direct/docx');
    expect(requestCount).toBe(0);
    expect(page.url()).toBe('about:blank');
  }, 60_000);
});
