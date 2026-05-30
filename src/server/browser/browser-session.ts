import { fsync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Page } from 'playwright';

function shouldIgnoreNetworkFailure(url: string, errorText?: string) {
  if (errorText === 'net::ERR_ABORTED' && /analytics|collector|apm|beacon|log|track/i.test(url)) return true;
  return /zhihu-web-analytics|datahub\.zhihu|apm\.zhihu|local\.adspower|118\.89\.204\.198/i.test(url);
}

function shouldIgnoreConsoleError(text: string) {
  return (
    /zhihu-web-analytics|datahub\.zhihu|apm\.zhihu|local\.adspower|118\.89\.204\.198/i.test(text) ||
    /collector|analytics|beacon|mixed content|cors policy|failed to load resource/i.test(text)
  );
}

export type BrowserActionResult = {
  ok: boolean;
  actual: string;
};

type FocusedElementSummary = {
  hasFocus: boolean;
  summary: string;
  tagName?: string;
  type?: string;
  role?: string;
  ariaLabel?: string;
  placeholder?: string;
  name?: string;
  id?: string;
  className?: string;
  text?: string;
  valueLength?: number;
  contentEditable?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  selectionStart?: number;
  selectionEnd?: number;
  rect?: { x: number; y: number; width: number; height: number };
  isTextEntryTarget?: boolean;
};

type ViewportMetrics = {
  width: number;
  height: number;
  devicePixelRatio: number;
  visualViewport?: {
    width: number;
    height: number;
    offsetLeft: number;
    offsetTop: number;
    scale: number;
  };
};

type ViewportPoint = {
  x: number;
  y: number;
  note?: string;
};

type ScreenshotMetrics = {
  path: string;
  image: { width: number; height: number };
  viewport: { width: number; height: number };
  viewportMetrics: ViewportMetrics;
  devicePixelRatio: number;
  scale: 'css';
};

type ManualVerificationDetails = {
  detected: boolean;
  evidence?: string;
};

const manualVerificationUrlPattern = /captcha|security-check|safecheck|abnormal|robot|challenge/i;
const manualVerificationTextPatterns = [
  /captcha/i,
  /security\s*check/i,
  /verify\s+(that\s+)?you\s+are\s+(a\s+)?human/i,
  /are\s+you\s+(a\s+)?robot/i,
  /unusual|abnormal\s+traffic/i,
  /verification\s+code/i,
  /two[-\s]?factor|\b2fa\b|\botp\b/i,
  /请输入验证码/,
  /验证码错误/,
  /请完成验证/,
  /安全验证/,
  /安全校验/,
  /人机验证/,
  /拖动滑块|滑块验证/,
  /身份验证/,
];

export class BrowserSession {
  private browser?: Browser;
  private page?: Page;
  private consoleErrors: string[] = [];
  private networkErrors: string[] = [];
  private lastScreenshotMetrics?: ScreenshotMetrics;
  private lastClickPoint?: { x: number; y: number };
  private repeatClickCount = 0;

  async start() {
    const { chromium } = await import('playwright');
    // Use a fixed full-HD viewport so the page (and screenshot) is exactly 1920x1080 regardless of the
    // host screen size or taskbar. deviceScaleFactor:1 keeps screenshot pixels == CSS pixels, so the
    // screenshot->viewport coordinate mapping stays an exact 1:1 ratio. Configurable via env.
    const viewportWidth = Number(process.env.BROWSER_VIEWPORT_WIDTH || 1920);
    const viewportHeight = Number(process.env.BROWSER_VIEWPORT_HEIGHT || 1080);
    this.browser = await chromium.launch({
      headless: process.env.HEADLESS_BROWSER === 'true',
      slowMo: Number(process.env.BROWSER_SLOW_MO_MS || 250),
      args: [`--window-size=${viewportWidth},${viewportHeight + 120}`, '--force-device-scale-factor=1', '--high-dpi-support=1'],
    });
    const context = await this.browser.newContext({
      viewport: { width: viewportWidth, height: viewportHeight },
      deviceScaleFactor: 1,
    });
    context.on('page', (page) => {
      this.page = page;
      this.attachPageListeners(page);
    });
    this.page = await context.newPage();
    this.attachPageListeners(this.page);
  }

  private attachPageListeners(page: Page) {
    page.setDefaultTimeout(8000);
    page.on('console', (message) => {
      const text = message.text();
      if (message.type() === 'error' && !shouldIgnoreConsoleError(text)) this.consoleErrors.push(text);
    });
    page.on('requestfailed', (request) => {
      const errorText = request.failure()?.errorText || '';
      if (shouldIgnoreNetworkFailure(request.url(), errorText)) return;
      this.networkErrors.push(`${request.method()} ${request.url()} ${errorText}`);
    });
  }

  private get activePage() {
    if (!this.page) throw new Error('Browser session has not started');
    if (this.page.isClosed()) {
      const replacement = this.browser?.contexts().flatMap((context) => context.pages()).find((page) => !page.isClosed());
      if (!replacement) throw new Error('Active browser page has been closed and no replacement page is available.');
      this.page = replacement;
      this.attachPageListeners(replacement);
    }
    return this.page;
  }

  async open(url: string): Promise<BrowserActionResult> {
    this.lastClickPoint = undefined;
    this.repeatClickCount = 0;
    await this.activePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const note = await this.waitAfterAction();
    return { ok: true, actual: `Opened page: ${url}${note}` };
  }

  async readPageText() {
    return this.activePage.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  }

  async getPageContext(options: { includeDomTree?: boolean; includeText?: boolean; includeManualVerification?: boolean } = {}) {
    const includeText = options.includeText !== false || options.includeManualVerification !== false;
    const [title, text, viewportMetrics, focusedElement, domTree] = await Promise.all([
      this.activePage.title().catch(() => ''),
      includeText ? this.readPageText() : Promise.resolve(''),
      this.getViewportMetrics(),
      this.getFocusedElement(),
      options.includeDomTree ? this.readSimplifiedDomTree().catch((error) => `Unable to read DOM tree: ${error instanceof Error ? error.message : String(error)}`) : Promise.resolve(undefined),
    ]);

    const manualVerification = options.includeManualVerification === false
      ? { detected: false }
      : this.detectManualVerificationDetails(title, this.activePage.url(), text);

    return {
      url: this.activePage.url(),
      title,
      text: text.slice(0, 2400),
      textLength: text.length,
      viewport: { width: viewportMetrics.width, height: viewportMetrics.height },
      viewportMetrics,
      tabs: this.activePage.context().pages().map((page, index) => ({
        index,
        url: page.url(),
        active: page === this.activePage,
      })),
      focusedElement,
      domTree,
      manualVerification,
      isManualVerification: manualVerification.detected,
    };
  }

  async takeScreenshot(runId: string, stepIndex: number, phase: 'before' | 'after' | 'manual' = 'after') {
    const dir = path.join(process.cwd(), 'artifacts', runId);
    await mkdir(dir, { recursive: true });
    const fileName = phase === 'manual' ? `step-${stepIndex}.png` : `step-${stepIndex}-${phase}.png`;
    const filePath = path.join(dir, fileName);
    const gridEnabled = process.env.SCREENSHOT_COORDINATE_GRID !== 'false';
    if (gridEnabled) await this.drawCoordinateGrid();
    try {
      await this.activePage.screenshot({ path: filePath, fullPage: false, scale: 'css', timeout: 15000 });
    } finally {
      if (gridEnabled) await this.removeCoordinateGrid();
    }
    const [image, viewportMetrics] = await Promise.all([
      this.readPngSize(filePath),
      this.getViewportMetrics(),
    ]);
    this.lastScreenshotMetrics = {
      path: filePath,
      image,
      viewport: { width: viewportMetrics.width, height: viewportMetrics.height },
      viewportMetrics,
      devicePixelRatio: viewportMetrics.devicePixelRatio,
      scale: 'css',
    };
    return filePath;
  }

  getLastScreenshotMetrics() {
    return this.lastScreenshotMetrics;
  }

  async clickAt(x: number, y: number): Promise<BrowserActionResult> {
    const point = await this.resolveClickPoint(x, y);
    const repeatNote = this.noteRepeatClick(point.x, point.y);
    const targetNote = await this.inspectViewportPoint(point.x, point.y);
    const context = this.activePage.context();
    const beforePages = context.pages().length;
    const popup = this.activePage.waitForEvent('popup', { timeout: 3000 }).catch(() => undefined);
    await this.activePage.mouse.click(point.x, point.y);
    await this.showClickMarker(point.x, point.y, 'click');
    const newPage = await popup;
    if (newPage) {
      this.page = newPage;
      this.attachPageListeners(newPage);
      await newPage.bringToFront();
    } else if (context.pages().length > beforePages) {
      this.page = context.pages().at(-1);
      await this.page?.bringToFront();
    }
    const note = await this.waitAfterAction();
    await this.showClickMarker(point.x, point.y, 'click');
    return { ok: true, actual: `Clicked screenshot coordinate (${x}, ${y}) mapped to viewport coordinate (${point.x}, ${point.y}).${point.note || ''}${repeatNote}${targetNote}${note}` };
  }

  async doubleClickAt(x: number, y: number): Promise<BrowserActionResult> {
    const point = await this.resolveClickPoint(x, y);
    const repeatNote = this.noteRepeatClick(point.x, point.y);
    const targetNote = await this.inspectViewportPoint(point.x, point.y);
    await this.activePage.mouse.dblclick(point.x, point.y);
    await this.showClickMarker(point.x, point.y, 'double');
    const note = await this.waitAfterAction();
    await this.showClickMarker(point.x, point.y, 'double');
    return { ok: true, actual: `Double-clicked screenshot coordinate (${x}, ${y}) mapped to viewport coordinate (${point.x}, ${point.y}).${point.note || ''}${repeatNote}${targetNote}${note}` };
  }

  async rightClickAt(x: number, y: number): Promise<BrowserActionResult> {
    const point = await this.resolveClickPoint(x, y);
    const repeatNote = this.noteRepeatClick(point.x, point.y);
    const targetNote = await this.inspectViewportPoint(point.x, point.y);
    await this.activePage.mouse.click(point.x, point.y, { button: 'right' });
    await this.showClickMarker(point.x, point.y, 'right');
    const note = await this.waitAfterAction();
    await this.showClickMarker(point.x, point.y, 'right');
    return { ok: true, actual: `Right-clicked screenshot coordinate (${x}, ${y}) mapped to viewport coordinate (${point.x}, ${point.y}).${point.note || ''}${repeatNote}${targetNote}${note}` };
  }

  async drag(startX: number, startY: number, endX: number, endY: number): Promise<BrowserActionResult> {
    const start = await this.screenshotPointToViewport(startX, startY);
    const end = await this.screenshotPointToViewport(endX, endY);
    await this.activePage.mouse.move(start.x, start.y);
    await this.activePage.mouse.down();
    await this.activePage.mouse.move(end.x, end.y, { steps: 12 });
    await this.activePage.mouse.up();
    await this.showClickMarker(end.x, end.y, 'drag');
    const note = await this.waitAfterAction();
    await this.showClickMarker(end.x, end.y, 'drag');
    return { ok: true, actual: `Dragged screenshot coordinates (${startX}, ${startY}) -> (${endX}, ${endY}), mapped to viewport (${start.x}, ${start.y}) -> (${end.x}, ${end.y}).${note}` };
  }

  async getSimplifiedDomTree(): Promise<BrowserActionResult> {
    return { ok: true, actual: await this.readSimplifiedDomTree() };
  }

  async clickDomNode(path: string): Promise<BrowserActionResult> {
    const target = await this.resolveDomPathToClickablePoint(path);
    if (!target) {
      return {
        ok: false,
        actual: `DOM path ${path} was not found or is not visible. Call getDomTree again to get fresh paths; the DOM may have changed or the node is hidden.`,
      };
    }
    const offscreenNote = target.offscreen ? ' Note: the node center was outside the viewport and was clamped; scroll it into view first for a reliable click.' : '';
    await this.activePage.mouse.click(target.x, target.y);
    await this.showClickMarker(target.x, target.y, 'click');
    const note = await this.waitAfterAction();
    await this.showClickMarker(target.x, target.y, 'click');
    return { ok: true, actual: `Clicked DOM node ${path} (${target.descriptor}) at viewport coordinate (${target.x}, ${target.y}).${offscreenNote}${note}` };
  }

  async focusDomNode(path: string): Promise<BrowserActionResult> {
    const target = await this.resolveDomPathToClickablePoint(path);
    if (!target) {
      return {
        ok: false,
        actual: `DOM path ${path} was not found or is not visible. Call getDomTree again to get fresh paths; the DOM may have changed or the node is hidden.`,
      };
    }
    const offscreenNote = target.offscreen ? ' Note: the node center was outside the viewport and was clamped; scroll it into view first for a reliable focus.' : '';
    await this.activePage.mouse.click(target.x, target.y);
    const note = await this.waitAfterAction();
    return { ok: true, actual: `Focused DOM node ${path} (${target.descriptor}) at viewport coordinate (${target.x}, ${target.y}).${offscreenNote}${note}` };
  }

  async scroll(deltaY: number, deltaX = 0, target: { screenshotX?: number; screenshotY?: number; domPath?: string } = {}): Promise<BrowserActionResult> {
    const scrollTarget = await this.resolveScrollTarget(target);
    await this.activePage.mouse.move(scrollTarget.x, scrollTarget.y);
    await this.activePage.mouse.wheel(deltaX, deltaY);
    const note = await this.waitAfterAction();
    return { ok: true, actual: `Scrolled ${scrollTarget.descriptor} at viewport coordinate (${scrollTarget.x}, ${scrollTarget.y}) by x=${deltaX}, y=${deltaY}.${scrollTarget.note}${note}` };
  }

  async listTabs(): Promise<BrowserActionResult> {
    const pages = this.activePage.context().pages();
    return {
      ok: true,
      actual: pages.map((page, index) => `${index}: ${page.url()}`).join('\n') || 'No tabs found.',
    };
  }

  async switchTab(index: number): Promise<BrowserActionResult> {
    const page = this.activePage.context().pages()[index];
    if (!page) return { ok: false, actual: `Tab ${index} not found.` };
    this.page = page;
    await page.bringToFront();
    return { ok: true, actual: `Switched to tab ${index}: ${page.url()}` };
  }

  async typeText(input: string): Promise<BrowserActionResult> {
    await this.activePage.keyboard.type(input, { delay: 20 });
    const note = await this.waitAfterAction();
    return { ok: true, actual: `Typed text into the currently focused element: ${input}${note}` };
  }

  async press(input: string): Promise<BrowserActionResult> {
    await this.activePage.keyboard.press(input);
    const note = await this.waitAfterAction();
    return { ok: true, actual: `Pressed key: ${input}${note}` };
  }

  async waitForPage(): Promise<BrowserActionResult> {
    await this.activePage.waitForLoadState('domcontentloaded').catch((error) => {
      if (!this.isTargetClosedError(error)) throw error;
    });
    await this.waitForStableViewport(500);
    const note = await this.manualVerificationNote();
    return { ok: true, actual: `Page wait completed.${note}` };
  }

  async wait(ms = 800): Promise<BrowserActionResult> {
    await this.waitForStableViewport(Math.min(Math.max(ms, 100), 5000));
    return { ok: true, actual: `Waited ${ms}ms.` };
  }

  async waitForManualVerification(maxMs = Number(process.env.MANUAL_VERIFICATION_TIMEOUT_MS || 180000)): Promise<BrowserActionResult> {
    const note = await this.manualVerificationNote();
    return {
      ok: !note,
      actual: note
        ? `Manual verification is visible. The run is paused for user intervention instead of waiting ${maxMs}ms inside the AI request.`
        : 'No manual verification page is currently detected.',
    };
  }

  getConsoleErrors() {
    return this.consoleErrors;
  }

  getNetworkErrors() {
    return this.networkErrors;
  }

  async close(options: { keepOpen?: boolean } = {}) {
    if (options.keepOpen || process.env.KEEP_BROWSER_OPEN_AFTER_RUN === 'true') return;
    await this.browser?.close().catch(() => undefined);
  }

  private async waitAfterAction() {
    await this.activePage.waitForLoadState('domcontentloaded').catch(() => undefined);
    await this.waitForStableViewport(350);
    const [manualNote, focusNote] = await Promise.all([this.manualVerificationNote(), this.focusNote()]);
    return `${manualNote}${focusNote}`;
  }

  private async waitForStableViewport(ms: number) {
    try {
      await this.activePage.waitForTimeout(ms);
    } catch (error) {
      if (!this.isTargetClosedError(error)) throw error;
      const replacement = this.browser?.contexts().flatMap((context) => context.pages()).find((page) => !page.isClosed());
      if (!replacement) throw error;
      this.page = replacement;
      this.attachPageListeners(replacement);
      await this.activePage.waitForTimeout(Math.min(ms, 100)).catch(() => undefined);
    }
  }

  private isTargetClosedError(error: unknown) {
    return /Target page, context or browser has been closed|Target closed|Page closed|Context closed|Browser has been closed/i.test(
      error instanceof Error ? error.message : String(error),
    );
  }

  private async manualVerificationNote() {
    const details = await this.detectManualVerification();
    if (!details.detected) return '';
    return ` Manual verification is visible (${details.evidence || 'matched verification challenge'}). The run UI should pause and wait for the user to complete it.`;
  }

  private async focusNote() {
    const focusedElement = await this.getFocusedElement();
    return ` Focused element after action: ${focusedElement.summary}`;
  }

  private async getFocusedElement(): Promise<FocusedElementSummary> {
    return this.activePage.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element || element === document.body || element === document.documentElement) {
        return {
          hasFocus: false,
          summary: 'No focused form/control element; document/body is active.',
        };
      }

      const field = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const rect = element.getBoundingClientRect();
      const tagName = element.tagName.toLowerCase();
      const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) || undefined;
      const value = 'value' in field ? field.value : undefined;
      const selectableField = field as HTMLInputElement | HTMLTextAreaElement;
      const inputType = tagName === 'input' ? (field as HTMLInputElement).type : undefined;
      const isTextEntryTarget =
        element.isContentEditable ||
        tagName === 'textarea' ||
        tagName === 'select' ||
        (tagName === 'input' && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(inputType || 'text'));

      const summaryParts = [
        `<${tagName}${inputType ? ` type="${inputType}"` : ''}>`,
        element.id ? `id="${element.id}"` : '',
        field.name ? `name="${field.name}"` : '',
        element.getAttribute('aria-label') ? `aria-label="${element.getAttribute('aria-label')}"` : '',
        element.getAttribute('placeholder') ? `placeholder="${element.getAttribute('placeholder')}"` : '',
        isTextEntryTarget ? 'text-entry target' : 'not a text-entry target',
        'value' in field ? `valueLength=${value?.length || 0}` : '',
        typeof selectableField.selectionStart === 'number' ? `selection=${selectableField.selectionStart}-${selectableField.selectionEnd}` : '',
        (field as HTMLInputElement).disabled ? 'disabled' : '',
        (field as HTMLInputElement).readOnly ? 'readOnly' : '',
        `rect=${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)}x${Math.round(rect.height)}`,
      ].filter(Boolean);

      return {
        hasFocus: true,
        summary: summaryParts.join(', '),
        tagName,
        type: inputType,
        role: element.getAttribute('role') || undefined,
        ariaLabel: element.getAttribute('aria-label') || undefined,
        placeholder: element.getAttribute('placeholder') || undefined,
        name: field.name || undefined,
        id: element.id || undefined,
        className: typeof element.className === 'string' ? element.className.slice(0, 120) || undefined : undefined,
        text,
        valueLength: 'value' in field ? value?.length || 0 : undefined,
        contentEditable: element.isContentEditable,
        disabled: Boolean((field as HTMLInputElement).disabled),
        readOnly: Boolean((field as HTMLInputElement).readOnly),
        selectionStart: typeof selectableField.selectionStart === 'number' ? selectableField.selectionStart : undefined,
        selectionEnd: typeof selectableField.selectionEnd === 'number' ? selectableField.selectionEnd : undefined,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        isTextEntryTarget,
      };
    }).catch((error) => ({
      hasFocus: false,
      summary: `Unable to inspect focused element: ${error instanceof Error ? error.message : String(error)}`,
    }));
  }

  private async detectManualVerification(): Promise<ManualVerificationDetails> {
    const [title, text] = await Promise.all([
      this.activePage.title().catch(() => ''),
      this.readPageText(),
    ]);
    return this.detectManualVerificationDetails(title, this.activePage.url(), text);
  }

  private detectManualVerificationDetails(title: string, url: string, text: string): ManualVerificationDetails {
    const urlWithoutQuery = url.replace(/[?#].*$/, '');
    if (manualVerificationUrlPattern.test(urlWithoutQuery)) {
      return { detected: true, evidence: 'url path matched verification challenge pattern' };
    }

    const lines = [title, ...text
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 80)];

    for (const line of lines) {
      const pattern = manualVerificationTextPatterns.find((item) => item.test(line));
      if (pattern) return { detected: true, evidence: line.slice(0, 160) };
    }

    return { detected: false };
  }

  private async getViewportSize() {
    const viewport = await this.getViewportMetrics();
    return { width: viewport.width, height: viewport.height };
  }

  private async getViewportMetrics(): Promise<ViewportMetrics> {
    const fallback = this.activePage.viewportSize() || { width: 1280, height: 720 };
    return this.activePage.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      visualViewport: window.visualViewport
        ? {
            width: window.visualViewport.width,
            height: window.visualViewport.height,
            offsetLeft: window.visualViewport.offsetLeft,
            offsetTop: window.visualViewport.offsetTop,
            scale: window.visualViewport.scale || 1,
          }
        : undefined,
    })).catch(() => ({ ...fallback, devicePixelRatio: 1 }));
  }

  private async screenshotPointToViewport(x: number, y: number): Promise<ViewportPoint> {
    const metrics = this.lastScreenshotMetrics;
    const currentMetrics = await this.getViewportMetrics();
    const currentViewport = { width: currentMetrics.width, height: currentMetrics.height };
    if (!metrics || metrics.image.width <= 0 || metrics.image.height <= 0) {
      const point = this.normalizePoint(x, y, currentViewport);
      return { ...point, note: ' No screenshot metrics were available; coordinate was treated as viewport CSS pixels.' };
    }

    // The screenshot is captured with scale:'css', so 1 image pixel maps to 1 CSS pixel of the
    // layout viewport. Mouse coordinates are also layout/CSS pixels. The most accurate mapping is a
    // direct ratio between the current layout viewport and the captured image dimensions. We only
    // route through the visual viewport when the page is actually pinch-zoomed (scale != 1).
    const visual = currentMetrics.visualViewport;
    const zoomed = !!visual && Math.abs((visual.scale || 1) - 1) > 0.01;

    let mappedX: number;
    let mappedY: number;
    let basis: string;
    if (zoomed && visual) {
      const scaleX = visual.width / metrics.image.width;
      const scaleY = visual.height / metrics.image.height;
      mappedX = visual.offsetLeft + x * scaleX;
      mappedY = visual.offsetTop + y * scaleY;
      basis = `visual viewport ${Math.round(visual.width)}x${Math.round(visual.height)} scale=${visual.scale} offset=${Math.round(visual.offsetLeft)},${Math.round(visual.offsetTop)}`;
    } else {
      const scaleX = currentViewport.width / metrics.image.width;
      const scaleY = currentViewport.height / metrics.image.height;
      mappedX = x * scaleX;
      mappedY = y * scaleY;
      basis = `layout viewport ${currentViewport.width}x${currentViewport.height}, scaleX=${scaleX.toFixed(4)}, scaleY=${scaleY.toFixed(4)}`;
    }

    const point = this.normalizePoint(mappedX, mappedY, currentViewport);
    const note = [
      ` Coordinate mapping used screenshot=${metrics.image.width}x${metrics.image.height}`,
      `mappedTo=${basis}`,
      `scale=${metrics.scale}`,
      `dpr=${metrics.devicePixelRatio}`,
    ].join(', ') + '.';
    return { ...point, note };
  }

  private normalizePoint(x: number, y: number, viewport: { width: number; height: number }): ViewportPoint {
    return {
      x: Math.min(Math.max(Number(x.toFixed(2)), 0), viewport.width - 1),
      y: Math.min(Math.max(Number(y.toFixed(2)), 0), viewport.height - 1),
    };
  }

  private async resolveClickPoint(x: number, y: number): Promise<ViewportPoint> {
    const mapped = await this.screenshotPointToViewport(x, y);
    // Snapping is opt-in (CLICK_SNAP_TO_TARGET=true). When enabled, it corrects small visual
    // estimation errors by clicking the center of the clickable element under the mapped point.
    if (process.env.CLICK_SNAP_TO_TARGET !== 'true') return mapped;
    const refined = await this.refineClickPoint(mapped.x, mapped.y);
    return { x: refined.x, y: refined.y, note: `${mapped.note || ''}${refined.note || ''}` };
  }

  private noteRepeatClick(x: number, y: number) {
    const threshold = 6;
    if (
      this.lastClickPoint &&
      Math.abs(this.lastClickPoint.x - x) <= threshold &&
      Math.abs(this.lastClickPoint.y - y) <= threshold
    ) {
      this.repeatClickCount += 1;
      this.lastClickPoint = { x, y };
      return ` ❌ REPEATED CLICK ERROR (repeat #${this.repeatClickCount}): you clicked the SAME coordinate as last time and it already failed. STOP repeating it. In the next screenshot, read the red marker's grid position and the target's grid position, compute the difference, and MOVE your next click by at least 20-40px in the corrected direction (recheck Y from the left "y=" labels). Do NOT submit this coordinate again.`;
    }
    this.repeatClickCount = 0;
    this.lastClickPoint = { x, y };
    return '';
  }

  /**
   * Opt-in click correction (CLICK_SNAP_TO_TARGET=true). Snaps the mapped point to the center of the
   * clickable element it landed on. It only snaps when the recomputed center still hits the same
   * element, so it never moves the click onto an unrelated element.
   */
  private async refineClickPoint(x: number, y: number): Promise<ViewportPoint> {
    const refined = await this.activePage
      .evaluate(({ px, py }) => {
        function isClickable(node: Element | null): boolean {
          if (!node || node.nodeType !== 1) return false;
          const tag = node.tagName.toLowerCase();
          if (['a', 'button', 'input', 'select', 'textarea', 'label', 'summary', 'option'].includes(tag)) return true;
          const role = node.getAttribute('role');
          if (role && ['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'checkbox', 'radio', 'switch', 'option'].includes(role)) return true;
          if (node.hasAttribute('onclick')) return true;
          const tabindex = node.getAttribute('tabindex');
          if (tabindex !== null && tabindex !== '-1') return true;
          try {
            if (window.getComputedStyle(node).cursor === 'pointer') return true;
          } catch {
            /* ignore */
          }
          return false;
        }

        const hit = document.elementFromPoint(px, py);
        if (!hit) return { x: px, y: py, note: ' no element under mapped point; not snapped.' };

        let target: Element | null = hit;
        for (let depth = 0; depth < 6 && target; depth += 1) {
          if (isClickable(target)) break;
          target = target.parentElement;
        }
        if (!target || !isClickable(target)) {
          return { x: px, y: py, note: ` mapped point on <${hit.tagName.toLowerCase()}>; no clickable ancestor, not snapped.` };
        }

        const rect = target.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return { x: px, y: py, note: '' };
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const atCenter = document.elementFromPoint(cx, cy);
        const stillTarget = !!atCenter && (atCenter === target || target.contains(atCenter) || atCenter.contains(target));
        if (!stillTarget) {
          return { x: px, y: py, note: ` clickable <${target.tagName.toLowerCase()}> center is occluded; clicked original point.` };
        }
        return { x: cx, y: cy, note: ` snapped to <${target.tagName.toLowerCase()}> center.` };
      }, { px: x, py: y })
      .catch(() => ({ x, y, note: '' }));

    const clamped = this.normalizePoint(refined.x, refined.y, await this.getViewportSize());
    return { x: clamped.x, y: clamped.y, note: refined.note };
  }

  private async inspectViewportPoint(x: number, y: number) {
    return this.activePage.evaluate(({ x: pointX, y: pointY }) => {
      const element = document.elementFromPoint(pointX, pointY);
      if (!element) return ' Target element at mapped point: none.';
      const tag = element.tagName.toLowerCase();
      const id = element.id ? `#${element.id}` : '';
      const className = typeof element.className === 'string'
        ? element.className.split(/\s+/).filter(Boolean).slice(0, 4).map((item) => `.${item}`).join('')
        : '';
      const rect = element.getBoundingClientRect();
      return ` Target element at mapped point: ${tag}${id}${className} rect=${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)}x${Math.round(rect.height)}.`;
    }, { x, y }).catch(() => '');
  }

  private async readSimplifiedDomTree() {
    const maxNodes = Number(process.env.DOM_TREE_MAX_NODES || 320);
    const maxDepth = Number(process.env.DOM_TREE_MAX_DEPTH || 14);
    return this.activePage.evaluate(({ maxNodes: nodeLimit, maxDepth: depthLimit }) => {
      // NOTE: the child-filtering predicate below (skippedTags + aiIsRendered + aiChildren +
      // aiElementFromPath) MUST stay byte-identical to the one used in resolveDomPathToClickablePoint
      // and resolveScrollTarget, otherwise the bracket paths printed here will not resolve to the
      // same elements when the model clicks/focuses them.
      const skippedTags = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'svg', 'path', 'head', 'br', 'hr', 'wbr']);
      function aiIsRendered(element: Element) {
        if (!element || element.nodeType !== 1) return false;
        const tag = element.tagName.toLowerCase();
        if (skippedTags.has(tag)) return false;
        if (element.hasAttribute('hidden')) return false;
        if (element.getAttribute('aria-hidden') === 'true') return false;
        const style = window.getComputedStyle(element);
        if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        return true;
      }
      function aiChildren(element: Element) {
        return Array.from(element.children).filter(aiIsRendered);
      }

      let count = 0;

      function ownText(element: Element) {
        let text = '';
        for (const node of Array.from(element.childNodes)) {
          if (node.nodeType === 3) text += node.textContent || '';
        }
        text = text.replace(/\s+/g, ' ').trim();
        if (!text) {
          const inner = (element as HTMLElement).innerText || element.textContent || '';
          const condensed = inner.replace(/\s+/g, ' ').trim();
          if (condensed && condensed.length <= 40) text = condensed;
        }
        return text.slice(0, 60);
      }

      function attrSummary(element: Element) {
        const parts: string[] = [];
        const push = (key: string, value: string | null | undefined) => {
          if (!value) return;
          const clean = String(value).replace(/\s+/g, ' ').trim().slice(0, 40);
          if (clean) parts.push(`${key}="${clean}"`);
        };
        const tag = element.tagName.toLowerCase();
        if (tag === 'input' || tag === 'button') push('type', element.getAttribute('type'));
        push('name', element.getAttribute('name'));
        push('placeholder', element.getAttribute('placeholder'));
        push('aria-label', element.getAttribute('aria-label'));
        push('role', element.getAttribute('role'));
        push('title', element.getAttribute('title'));
        push('alt', element.getAttribute('alt'));
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          const value = (element as HTMLInputElement).value;
          push('value', value);
        }
        if (tag === 'a') push('href', element.getAttribute('href'));
        return parts.length ? ` {${parts.join(' ')}}` : '';
      }

      function isClickable(element: Element) {
        const tag = element.tagName.toLowerCase();
        if (['a', 'button', 'input', 'select', 'textarea', 'label', 'summary', 'option'].includes(tag)) return true;
        const role = element.getAttribute('role');
        if (role && ['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'checkbox', 'radio', 'switch', 'option'].includes(role)) return true;
        if (element.hasAttribute('onclick')) return true;
        const tabindex = element.getAttribute('tabindex');
        if (tabindex !== null && tabindex !== '-1') return true;
        try {
          if (window.getComputedStyle(element).cursor === 'pointer') return true;
        } catch {
          /* ignore */
        }
        return false;
      }

      function describe(element: Element, path: number[]) {
        const tag = element.tagName.toLowerCase();
        const id = element.id ? `#${CSS.escape(element.id)}` : '';
        const classes = typeof element.className === 'string'
          ? element.className.split(/\s+/).filter(Boolean).slice(0, 4).map((item) => `.${CSS.escape(item)}`).join('')
          : '';
        const clickable = isClickable(element) ? ' *' : '';
        const attrs = attrSummary(element);
        const text = ownText(element);
        const textPart = text ? ` "${text}"` : '';
        return `[${path.join('.')}] ${tag}${id}${classes}${clickable}${attrs}${textPart}`;
      }

      const lines: string[] = [];
      function walk(element: Element, path: number[], depth: number) {
        if (count >= nodeLimit || depth > depthLimit) return;
        lines.push(`${'  '.repeat(depth)}${describe(element, path)}`);
        count += 1;
        const children = aiChildren(element);
        for (let index = 0; index < children.length; index += 1) {
          walk(children[index], [...path, index], depth + 1);
          if (count >= nodeLimit) break;
        }
      }

      walk(document.documentElement, [0], 0);
      const legend = 'Legend: [path] tag#id.class * {attrs} "text" — "*" marks clickable/interactive elements; "text" is the node text; only visible (rendered) elements are listed.';
      if (count >= nodeLimit) lines.push(`... truncated at ${nodeLimit} nodes`);
      return `${legend}\n${lines.join('\n')}`;
    }, { maxNodes, maxDepth });
  }

  private async resolveDomPathToClickablePoint(pathValue: string) {
    return this.activePage.evaluate((path) => {
      // Keep this predicate byte-identical to readSimplifiedDomTree so paths resolve consistently.
      const skippedTags = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'svg', 'path', 'head', 'br', 'hr', 'wbr']);
      function aiIsRendered(element: Element) {
        if (!element || element.nodeType !== 1) return false;
        const tag = element.tagName.toLowerCase();
        if (skippedTags.has(tag)) return false;
        if (element.hasAttribute('hidden')) return false;
        if (element.getAttribute('aria-hidden') === 'true') return false;
        const style = window.getComputedStyle(element);
        if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        return true;
      }
      function aiChildren(element: Element) {
        return Array.from(element.children).filter(aiIsRendered);
      }

      const parts = String(path).split('.').map((item) => Number(String(item).trim()));
      if (!parts.length || parts[0] !== 0 || parts.some((item) => !Number.isInteger(item) || item < 0)) return undefined;

      let element: Element | undefined = document.documentElement;
      for (const index of parts.slice(1)) {
        element = aiChildren(element)[index];
        if (!element) return undefined;
      }
      if (!element) return undefined;

      element.scrollIntoView({ block: 'center', inline: 'center' });
      let rect = element.getBoundingClientRect();
      // Some wrappers have zero size but contain a visible interactive child. Descend to the first
      // rendered descendant that actually has a box so the click lands on something visible.
      if (rect.width <= 0 || rect.height <= 0) {
        const queue = aiChildren(element);
        while (queue.length) {
          const candidate = queue.shift() as Element;
          const candidateRect = candidate.getBoundingClientRect();
          if (candidateRect.width > 0 && candidateRect.height > 0) {
            element = candidate;
            rect = candidateRect;
            break;
          }
          queue.push(...aiChildren(candidate));
        }
      }
      if (rect.width <= 0 || rect.height <= 0) return undefined;

      const tag = element.tagName.toLowerCase();
      const id = element.id ? `#${element.id}` : '';
      const classes = typeof element.className === 'string'
        ? element.className.split(/\s+/).filter(Boolean).slice(0, 4).map((item) => `.${item}`).join('')
        : '';
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const offscreen = centerY < 0 || centerY > window.innerHeight || centerX < 0 || centerX > window.innerWidth;
      return {
        x: Math.min(Math.max(centerX, 0), window.innerWidth - 1),
        y: Math.min(Math.max(centerY, 0), window.innerHeight - 1),
        descriptor: `${tag}${id}${classes}`,
        offscreen,
      };
    }, pathValue).catch(() => undefined);
  }

  private async resolveScrollTarget(target: { screenshotX?: number; screenshotY?: number; domPath?: string }) {
    const point = typeof target.screenshotX === 'number' && typeof target.screenshotY === 'number'
      ? await this.screenshotPointToViewport(target.screenshotX, target.screenshotY)
      : undefined;

    return this.activePage.evaluate(({ x, y, domPath }) => {
      // Keep this predicate byte-identical to readSimplifiedDomTree so domPath indexes line up.
      const skippedTags = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'svg', 'path', 'head', 'br', 'hr', 'wbr']);
      function aiIsRendered(element: Element) {
        if (!element || element.nodeType !== 1) return false;
        const tag = element.tagName.toLowerCase();
        if (skippedTags.has(tag)) return false;
        if (element.hasAttribute('hidden')) return false;
        if (element.getAttribute('aria-hidden') === 'true') return false;
        const style = window.getComputedStyle(element);
        if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        return true;
      }
      function aiChildren(element: Element) {
        return Array.from(element.children).filter(aiIsRendered);
      }

      function elementFromDomPath(pathValue?: string) {
        if (!pathValue) return undefined;
        const parts = String(pathValue).split('.').map((item) => Number(String(item).trim()));
        if (!parts.length || parts[0] !== 0 || parts.some((item) => !Number.isInteger(item) || item < 0)) return undefined;
        let element: Element | undefined = document.documentElement;
        for (const index of parts.slice(1)) {
          element = aiChildren(element)[index];
          if (!element) return undefined;
        }
        return element;
      }

      function descriptor(element: Element | Document) {
        if (element === document) return 'document';
        const targetElement = element as Element;
        const tag = targetElement.tagName.toLowerCase();
        const id = targetElement.id ? `#${targetElement.id}` : '';
        const classes = typeof targetElement.className === 'string'
          ? targetElement.className.split(/\s+/).filter(Boolean).slice(0, 4).map((item) => `.${item}`).join('')
          : '';
        return `${tag}${id}${classes}`;
      }

      function isScrollable(element: Element) {
        const style = window.getComputedStyle(element);
        const overflowY = style.overflowY;
        const overflowX = style.overflowX;
        const canScrollY = element.scrollHeight > element.clientHeight + 1 && /(auto|scroll|overlay)/i.test(overflowY);
        const canScrollX = element.scrollWidth > element.clientWidth + 1 && /(auto|scroll|overlay)/i.test(overflowX);
        return canScrollY || canScrollX;
      }

      function closestScrollable(element?: Element | null) {
        let current: Element | null | undefined = element;
        while (current && current !== document.documentElement) {
          if (isScrollable(current)) return current;
          current = current.parentElement;
        }
        return document.scrollingElement || document.documentElement;
      }

      const sourceElement =
        elementFromDomPath(domPath) ||
        (typeof x === 'number' && typeof y === 'number' ? document.elementFromPoint(x, y) : undefined) ||
        document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2) ||
        document.documentElement;
      const scrollElement = closestScrollable(sourceElement);
      const rect = scrollElement.getBoundingClientRect();
      const targetX = scrollElement === document.documentElement || scrollElement === document.body || scrollElement === document.scrollingElement
        ? (typeof x === 'number' ? x : window.innerWidth / 2)
        : rect.left + rect.width / 2;
      const targetY = scrollElement === document.documentElement || scrollElement === document.body || scrollElement === document.scrollingElement
        ? (typeof y === 'number' ? y : window.innerHeight / 2)
        : rect.top + rect.height / 2;

      return {
        x: Math.min(Math.max(targetX, 0), window.innerWidth - 1),
        y: Math.min(Math.max(targetY, 0), window.innerHeight - 1),
        descriptor: descriptor(scrollElement),
        note: ` Source element: ${descriptor(sourceElement)}.`,
      };
    }, {
      x: point?.x,
      y: point?.y,
      domPath: target.domPath,
    }).catch(() => ({
      x: point?.x ?? 1,
      y: point?.y ?? 1,
      descriptor: 'document',
      note: ' Scroll target resolution failed; fell back to document.',
    }));
  }

  private async readPngSize(filePath: string) {
    const buffer = await readFile(filePath);
    return this.readPngSizeFromBuffer(buffer);
  }

  private async readPngSizeFromBuffer(buffer: Buffer) {
    const isPng =
      buffer.length >= 24 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47;
    if (!isPng) return this.getViewportSize();
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  /**
   * Overlay a labeled coordinate grid on the page so the screenshot sent to the model carries an
   * explicit reference frame. Lines every `step` px; EVERY line is labeled right on it — x values on
   * the bottom edge, y values on the left edge — so the model can read the target's x/y instead of
   * guessing. This is the main aid for accurate clicks. Removed again right after the screenshot.
   */
  private async drawCoordinateGrid() {
    const step = Math.max(10, Number(process.env.SCREENSHOT_GRID_STEP || 50));
    await this.activePage.evaluate((step) => {
      const existing = document.getElementById('__ai_coord_grid__');
      if (existing) existing.remove();
      const width = window.innerWidth;
      const height = window.innerHeight;
      const grid = document.createElement('div');
      grid.id = '__ai_coord_grid__';
      Object.assign(grid.style, {
        position: 'fixed',
        left: '0',
        top: '0',
        width: `${width}px`,
        height: `${height}px`,
        pointerEvents: 'none',
        zIndex: '2147483646',
        margin: '0',
        padding: '0',
      });

      const lineColor = 'rgba(0, 122, 255, 0.28)';
      // x labels are rendered VERTICALLY (writing-mode) so adjacent labels along the dense bottom edge
      // don't overlap horizontally — each only takes ~1 char width. y labels stay horizontal on the left.
      const xLabelCss =
        'position:absolute;font:700 16px/16px Arial,sans-serif;color:#fff;background:rgba(0,90,200,0.82);padding:2px 1px;border-radius:2px;white-space:nowrap;writing-mode:vertical-rl;text-orientation:mixed;transform:translateX(-50%);';
      const yLabelCss =
        'position:absolute;font:700 16px/16px Arial,sans-serif;color:#fff;background:rgba(180,60,0,0.82);padding:1px 2px;border-radius:2px;white-space:nowrap;transform:translateY(-50%);';

      // Vertical lines = constant X. EVERY line gets an "x=" label sitting on the line (bottom edge).
      for (let x = step; x < width; x += step) {
        const line = document.createElement('div');
        Object.assign(line.style, {
          position: 'absolute',
          left: `${x}px`,
          top: '0',
          width: '1px',
          height: `${height}px`,
          background: lineColor,
        });
        grid.appendChild(line);
        const label = document.createElement('div');
        label.textContent = `x=${x}`;
        label.setAttribute('style', `${xLabelCss}left:${x}px;bottom:1px;`);
        grid.appendChild(label);
      }

      // Horizontal lines = constant Y. EVERY line gets a "y=" label sitting on the line (left edge).
      for (let y = step; y < height; y += step) {
        const line = document.createElement('div');
        Object.assign(line.style, {
          position: 'absolute',
          left: '0',
          top: `${y}px`,
          width: `${width}px`,
          height: '1px',
          background: lineColor,
        });
        grid.appendChild(line);
        const label = document.createElement('div');
        label.textContent = `y=${y}`;
        label.setAttribute('style', `${yLabelCss}left:1px;top:${y}px;`);
        grid.appendChild(label);
      }

      // Single origin/legend marker at the top-left corner explaining the axes direction.
      const legend = document.createElement('div');
      legend.textContent = '0,0  x→  y↓';
      legend.setAttribute(
        'style',
        'position:absolute;left:1px;top:1px;font:700 10px/10px Arial,sans-serif;color:#fff;background:rgba(200,0,0,0.85);padding:1px 2px;border-radius:2px;white-space:nowrap;',
      );
      grid.appendChild(legend);

      document.documentElement.appendChild(grid);
    }, step).catch(() => undefined);
  }

  private async removeCoordinateGrid() {
    await this.activePage
      .evaluate(() => {
        const grid = document.getElementById('__ai_coord_grid__');
        if (grid) grid.remove();
      })
      .catch(() => undefined);
  }

  private async showClickMarker(x: number, y: number, kind: string) {
    await this.activePage.evaluate(({ x: markerX, y: markerY, kind: markerKind }) => {
      const previous = document.getElementById('__ai_last_click_marker__');
      previous?.remove();
      const marker = document.createElement('div');
      marker.id = '__ai_last_click_marker__';
      marker.textContent = markerKind === 'double' ? '2x' : markerKind === 'right' ? 'R' : markerKind === 'drag' ? 'D' : '';
      Object.assign(marker.style, {
        position: 'fixed',
        left: `${markerX}px`,
        top: `${markerY}px`,
        width: '22px',
        height: '22px',
        marginLeft: '-11px',
        marginTop: '-11px',
        borderRadius: '999px',
        background: 'rgba(239, 68, 68, 0.92)',
        border: '4px solid rgba(255, 255, 255, 0.98)',
        boxShadow: '0 0 0 7px rgba(239, 68, 68, 0.28), 0 10px 26px rgba(0, 0, 0, 0.32)',
        color: '#fff',
        font: '700 10px/16px Arial, sans-serif',
        textAlign: 'center',
        pointerEvents: 'none',
        zIndex: '2147483647',
      });
      document.documentElement.appendChild(marker);
    }, { x, y, kind }).catch(() => undefined);
  }
}
