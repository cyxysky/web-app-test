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
  private lastScreenshotMetrics?: {
    path: string;
    image: { width: number; height: number };
    viewport: { width: number; height: number };
    devicePixelRatio: number;
    scale: 'css';
  };

  async start() {
    const { chromium } = await import('playwright');
    this.browser = await chromium.launch({
      headless: process.env.HEADLESS_BROWSER === 'true',
      slowMo: Number(process.env.BROWSER_SLOW_MO_MS || 250),
      args: ['--start-maximized'],
    });
    const context = await this.browser.newContext({ viewport: process.env.HEADLESS_BROWSER === 'true' ? { width: 1440, height: 960 } : null });
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
    await this.activePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const note = await this.waitAfterAction();
    return { ok: true, actual: `Opened page: ${url}${note}` };
  }

  async readPageText() {
    return this.activePage.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  }

  async getPageContext() {
    const [title, text, viewportMetrics, focusedElement] = await Promise.all([
      this.activePage.title().catch(() => ''),
      this.readPageText(),
      this.getViewportMetrics(),
      this.getFocusedElement(),
    ]);

    const manualVerification = this.detectManualVerificationDetails(title, this.activePage.url(), text);

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
      manualVerification,
      isManualVerification: manualVerification.detected,
    };
  }

  async takeScreenshot(runId: string, stepIndex: number, phase: 'before' | 'after' | 'manual' = 'after') {
    const dir = path.join(process.cwd(), 'artifacts', runId);
    await mkdir(dir, { recursive: true });
    const fileName = phase === 'manual' ? `step-${stepIndex}.png` : `step-${stepIndex}-${phase}.png`;
    const filePath = path.join(dir, fileName);
    await this.activePage.screenshot({ path: filePath, fullPage: false, scale: 'css', timeout: 15000 });
    const [image, viewportMetrics] = await Promise.all([
      this.readPngSize(filePath),
      this.getViewportMetrics(),
    ]);
    this.lastScreenshotMetrics = {
      path: filePath,
      image,
      viewport: { width: viewportMetrics.width, height: viewportMetrics.height },
      devicePixelRatio: viewportMetrics.devicePixelRatio,
      scale: 'css',
    };
    return filePath;
  }

  getLastScreenshotMetrics() {
    return this.lastScreenshotMetrics;
  }

  async clickAt(x: number, y: number): Promise<BrowserActionResult> {
    const point = await this.screenshotPointToViewport(x, y);
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
    return { ok: true, actual: `Clicked screenshot coordinate (${x}, ${y}) mapped to viewport coordinate (${point.x}, ${point.y}).${point.note || ''}${note}` };
  }

  async doubleClickAt(x: number, y: number): Promise<BrowserActionResult> {
    const point = await this.screenshotPointToViewport(x, y);
    await this.activePage.mouse.dblclick(point.x, point.y);
    await this.showClickMarker(point.x, point.y, 'double');
    const note = await this.waitAfterAction();
    await this.showClickMarker(point.x, point.y, 'double');
    return { ok: true, actual: `Double-clicked screenshot coordinate (${x}, ${y}) mapped to viewport coordinate (${point.x}, ${point.y}).${point.note || ''}${note}` };
  }

  async rightClickAt(x: number, y: number): Promise<BrowserActionResult> {
    const point = await this.screenshotPointToViewport(x, y);
    await this.activePage.mouse.click(point.x, point.y, { button: 'right' });
    await this.showClickMarker(point.x, point.y, 'right');
    const note = await this.waitAfterAction();
    await this.showClickMarker(point.x, point.y, 'right');
    return { ok: true, actual: `Right-clicked screenshot coordinate (${x}, ${y}) mapped to viewport coordinate (${point.x}, ${point.y}).${point.note || ''}${note}` };
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

  async scroll(deltaY: number, deltaX = 0): Promise<BrowserActionResult> {
    await this.activePage.mouse.wheel(deltaX, deltaY);
    const note = await this.waitAfterAction();
    return { ok: true, actual: `Scrolled viewport by x=${deltaX}, y=${deltaY}.${note}` };
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
      width: Math.round(window.innerWidth),
      height: Math.round(window.innerHeight),
      devicePixelRatio: window.devicePixelRatio || 1,
      visualViewport: window.visualViewport
        ? {
            width: Math.round(window.visualViewport.width),
            height: Math.round(window.visualViewport.height),
            offsetLeft: Math.round(window.visualViewport.offsetLeft),
            offsetTop: Math.round(window.visualViewport.offsetTop),
            scale: window.visualViewport.scale || 1,
          }
        : undefined,
    })).catch(() => ({ ...fallback, devicePixelRatio: 1 }));
  }

  private async screenshotPointToViewport(x: number, y: number): Promise<ViewportPoint> {
    const metrics = this.lastScreenshotMetrics;
    const currentViewport = await this.getViewportSize();
    if (!metrics || metrics.image.width <= 0 || metrics.image.height <= 0) {
      const point = this.normalizePoint(x, y, currentViewport);
      return { ...point, note: ' No screenshot metrics were available; coordinate was treated as viewport CSS pixels.' };
    }

    const mappedX = (x / metrics.image.width) * currentViewport.width;
    const mappedY = (y / metrics.image.height) * currentViewport.height;
    const point = this.normalizePoint(mappedX, mappedY, currentViewport);
    const sourceViewport = `${metrics.viewport.width}x${metrics.viewport.height}`;
    const targetViewport = `${currentViewport.width}x${currentViewport.height}`;
    const note = ` Coordinate mapping used screenshot=${metrics.image.width}x${metrics.image.height}, screenshotViewport=${sourceViewport}, currentViewport=${targetViewport}, scale=${metrics.scale}, dpr=${metrics.devicePixelRatio}.`;
    return { ...point, note };
  }

  private normalizePoint(x: number, y: number, viewport: { width: number; height: number }): ViewportPoint {
    return {
      x: Math.min(Math.max(Math.round(x), 0), viewport.width - 1),
      y: Math.min(Math.max(Math.round(y), 0), viewport.height - 1),
    };
  }

  private async readPngSize(filePath: string) {
    const buffer = await readFile(filePath);
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
