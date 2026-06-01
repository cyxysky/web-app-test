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

type ScreenshotMetrics = {
  path: string;
  image: { width: number; height: number };
  viewport: { width: number; height: number };
  viewportMetrics: ViewportMetrics;
  devicePixelRatio: number;
  scale: 'css';
};

type InteractiveCandidate = {
  id: string;
  path: string;
  tag: string;
  role?: string;
  type?: string;
  name?: string;
  text?: string;
  nearbyText?: string;
  href?: string;
  host?: string;
  placeholder?: string;
  ariaLabel?: string;
  title?: string;
  rect: { x: number; y: number; width: number; height: number };
  center: { x: number; y: number };
  clickable: boolean;
  input: boolean;
  disabled: boolean;
  /** True when the element lives inside a shadow root, so its DOM-index path
   * cannot be resolved from the light tree and clicks must use coordinates. */
  shadow?: boolean;
};

type ManualVerificationDetails = {
  detected: boolean;
  evidence?: string;
  /** Visible captcha/OTP-like inputs on the page. */
  captchaFields?: Array<{ label: string; valueLength: number; filled: boolean }>;
  /** True when any captcha-like input already has user-entered content. */
  captchaAppearsFilled?: boolean;
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
  private lastInteractiveCandidates: InteractiveCandidate[] = [];

  async start() {
    const { chromium } = await import('playwright');
    // Use a fixed, moderate viewport. A huge screenshot gets downsampled by the vision model, which is
    // a major cause of imprecise clicks; a moderate resolution keeps the screenshot close to the
    // model's effective resolution and makes the screenshot->viewport mapping an exact 1:1 ratio.
    // deviceScaleFactor:1 keeps screenshot pixels == CSS pixels. Configurable via env.
    const viewportWidth = Number(process.env.BROWSER_VIEWPORT_WIDTH || 1280);
    const viewportHeight = Number(process.env.BROWSER_VIEWPORT_HEIGHT || 800);
    this.browser = await chromium.launch({
      headless: process.env.HEADLESS_BROWSER === 'true',
      slowMo: Number(process.env.BROWSER_SLOW_MO_MS || 250),
      args: [`--window-size=${viewportWidth},${viewportHeight + 120}`, '--force-device-scale-factor=1', '--high-dpi-support=1'],
    });
    const context = await this.browser.newContext({
      viewport: { width: viewportWidth, height: viewportHeight },
      deviceScaleFactor: 1,
    });
    await context.addInitScript(() => {
      const originalAddEventListener = EventTarget.prototype.addEventListener;
      const listenerTypes = new WeakMap<EventTarget, Set<string>>();
      const interestingEvents = /^(click|dblclick|mousedown|mouseup|pointerdown|pointerup|touchstart|keydown|mouseenter|mouseover|pointerenter|pointerover)$/i;
      Object.defineProperty(window, '__aiGetEventListenerTypes', {
        value(target: EventTarget) {
          return Array.from(listenerTypes.get(target) || []);
        },
      });
      EventTarget.prototype.addEventListener = function addEventListener(type, listener, options) {
        if (this instanceof Element && interestingEvents.test(String(type))) {
          let types = listenerTypes.get(this);
          if (!types) {
            types = new Set<string>();
            listenerTypes.set(this, types);
          }
          types.add(String(type));
        }
        return originalAddEventListener.call(this, type, listener, options);
      };
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
    await this.activePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const note = await this.waitAfterAction();
    return { ok: true, actual: `Opened page: ${url}${note}` };
  }

  async readPageText() {
    return this.activePage.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  }

  async getPageContext(options: { includeDomTree?: boolean; includeText?: boolean; includeManualVerification?: boolean } = {}) {
    const includeText = options.includeText !== false || options.includeManualVerification !== false;
    const [title, text, viewportMetrics, focusedElement, domTree, interactiveCandidates] = await Promise.all([
      this.activePage.title().catch(() => ''),
      includeText ? this.readPageText() : Promise.resolve(''),
      this.getViewportMetrics(),
      this.getFocusedElement(),
      options.includeDomTree ? this.readSimplifiedDomTree().catch((error) => `Unable to read DOM tree: ${error instanceof Error ? error.message : String(error)}`) : Promise.resolve(undefined),
      this.refreshInteractiveCandidates().catch(() => this.lastInteractiveCandidates),
    ]);

    const manualVerification = options.includeManualVerification === false
      ? { detected: false }
      : await this.detectManualVerificationContext(title, this.activePage.url(), text);

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
      interactiveCandidates,
      manualVerification,
      isManualVerification: manualVerification.detected && !manualVerification.captchaAppearsFilled,
    };
  }

  private async detectManualVerificationContext(title: string, url: string, text: string): Promise<ManualVerificationDetails> {
    const base = this.detectManualVerificationDetails(title, url, text);
    const captchaFields = await this.scanCaptchaInputFields();
    const captchaAppearsFilled = captchaFields.some((field) => field.filled);
    return { ...base, captchaFields, captchaAppearsFilled };
  }

  private async scanCaptchaInputFields() {
    return this.activePage.evaluate(() => {
      function isVisible(element: Element) {
        const style = window.getComputedStyle(element);
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      function isCaptchaLikeInput(element: Element) {
        if (element.tagName.toLowerCase() !== 'input' && element.tagName.toLowerCase() !== 'textarea') return false;
        const input = element as HTMLInputElement;
        const hint = [
          input.placeholder,
          input.name,
          input.id,
          input.getAttribute('aria-label'),
          input.getAttribute('autocomplete'),
          input.labels?.length ? Array.from(input.labels).map((l) => l.textContent).join(' ') : '',
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (/验证码|captcha|verify\s*code|verification\s*code|otp|sms\s*code|动态码|校验码|图形验证/.test(hint)) return true;
        if ((input.type === 'tel' || input.type === 'text' || input.type === 'number') && /code|verify|验证/.test(hint)) return true;
        return false;
      }

      const fields: Array<{ label: string; valueLength: number; filled: boolean }> = [];
      for (const element of Array.from(document.querySelectorAll('input, textarea'))) {
        if (!isVisible(element) || !isCaptchaLikeInput(element)) continue;
        const input = element as HTMLInputElement;
        const valueLength = (input.value || '').trim().length;
        const label =
          input.placeholder ||
          input.getAttribute('aria-label') ||
          input.name ||
          input.id ||
          'captcha-input';
        fields.push({ label: label.slice(0, 80), valueLength, filled: valueLength > 0 });
      }
      return fields;
    }).catch(() => [] as Array<{ label: string; valueLength: number; filled: boolean }>);
  }

  async takeScreenshot(runId: string, stepIndex: number, phase: 'before' | 'after' | 'manual' = 'after') {
    const dir = path.join(process.cwd(), 'artifacts', runId);
    await mkdir(dir, { recursive: true });
    const fileName = phase === 'manual' ? `step-${stepIndex}.png` : `step-${stepIndex}-${phase}.png`;
    const filePath = path.join(dir, fileName);
    const candidateLabelsEnabled = phase === 'before' && process.env.SCREENSHOT_ELEMENT_LABELS !== 'false';
    const candidates = candidateLabelsEnabled
      ? await this.refreshInteractiveCandidates().catch(() => [] as InteractiveCandidate[])
      : [];
    if (candidateLabelsEnabled) await this.drawCandidateOverlay(candidates);
    try {
      await this.activePage.screenshot({ path: filePath, fullPage: false, scale: 'css', timeout: 15000 });
    } finally {
      if (candidateLabelsEnabled) await this.removeCandidateOverlay();
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

  async getInteractiveCandidates(): Promise<BrowserActionResult> {
    const candidates = await this.refreshInteractiveCandidates();
    return { ok: true, actual: JSON.stringify(candidates, null, 2) };
  }

  async getSimplifiedDomTree(): Promise<BrowserActionResult> {
    return { ok: true, actual: await this.readSimplifiedDomTree() };
  }

  async clickCandidate(candidateId: string): Promise<BrowserActionResult> {
    const resolved = await this.resolveCandidateTarget(candidateId);
    if (!resolved.target) return { ok: false, actual: resolved.error };

    const { candidate, target } = resolved;
    const context = this.activePage.context();
    const beforePages = context.pages().length;
    const beforeUrl = this.activePage.url();
    const popup = this.activePage.waitForEvent('popup', { timeout: 3000 }).catch(() => undefined);
    await this.activePage.mouse.click(target.x, target.y);
    await this.showClickMarker(target.x, target.y, 'click');
    const newPage = await popup;
    if (newPage) {
      this.page = newPage;
      this.attachPageListeners(newPage);
      await newPage.bringToFront();
    } else if (context.pages().length > beforePages) {
      this.page = context.pages().at(-1);
      await this.page?.bringToFront();
    }
    let note = await this.waitAfterAction();
    let fallbackNote = '';
    if (candidate.href && this.activePage.url() === beforeUrl && !newPage) {
      const fallback = await this.dispatchDomPathClick(candidate.path);
      if (fallback) {
        fallbackNote += ` Primary mouse click did not navigate; retried ${fallback} with DOM click.`;
        note += await this.waitAfterAction();
      }
      if (this.activePage.url() === beforeUrl && /^https?:\/\//i.test(candidate.href)) {
        await this.activePage.goto(candidate.href, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
        fallbackNote += ' Link href was opened directly as a final fallback.';
        note += await this.waitAfterAction();
      }
    }
    await this.showClickMarker(target.x, target.y, 'click');
    return {
      ok: true,
      actual: `Clicked candidate ${candidate.id} (${this.describeCandidate(candidate)}) at its visible center.${target.offscreen ? ' It was scrolled/clamped before clicking.' : ''}${fallbackNote}${note}`,
    };
  }

  async doubleClickCandidate(candidateId: string): Promise<BrowserActionResult> {
    const resolved = await this.resolveCandidateTarget(candidateId);
    if (!resolved.target) return { ok: false, actual: resolved.error };

    const { candidate, target } = resolved;
    await this.activePage.mouse.dblclick(target.x, target.y);
    await this.showClickMarker(target.x, target.y, 'double');
    const note = await this.waitAfterAction();
    await this.showClickMarker(target.x, target.y, 'double');
    return {
      ok: true,
      actual: `Double-clicked candidate ${candidate.id} (${this.describeCandidate(candidate)}) at its visible center.${target.offscreen ? ' It was scrolled/clamped before double-clicking.' : ''}${note}`,
    };
  }

  async rightClickCandidate(candidateId: string): Promise<BrowserActionResult> {
    const resolved = await this.resolveCandidateTarget(candidateId);
    if (!resolved.target) return { ok: false, actual: resolved.error };

    const { candidate, target } = resolved;
    await this.activePage.mouse.click(target.x, target.y, { button: 'right' });
    await this.showClickMarker(target.x, target.y, 'right');
    const note = await this.waitAfterAction();
    await this.showClickMarker(target.x, target.y, 'right');
    return {
      ok: true,
      actual: `Right-clicked candidate ${candidate.id} (${this.describeCandidate(candidate)}) at its visible center.${target.offscreen ? ' It was scrolled/clamped before right-clicking.' : ''}${note}`,
    };
  }

  async hoverCandidate(candidateId: string): Promise<BrowserActionResult> {
    const resolved = await this.resolveCandidateTarget(candidateId);
    if (!resolved.target) return { ok: false, actual: resolved.error };

    const { candidate, target } = resolved;
    await this.activePage.mouse.move(target.x, target.y);
    const note = await this.waitAfterAction();
    return {
      ok: true,
      actual: `Hovered candidate ${candidate.id} (${this.describeCandidate(candidate)}) at its visible center.${target.offscreen ? ' It was scrolled/clamped before hovering.' : ''}${note}`,
    };
  }

  async dragCandidate(fromCandidateId: string, toCandidateId: string): Promise<BrowserActionResult> {
    const fromResolved = await this.resolveCandidateTarget(fromCandidateId);
    if (!fromResolved.target) return { ok: false, actual: fromResolved.error };
    const toResolved = await this.resolveCandidateTarget(toCandidateId);
    if (!toResolved.target) return { ok: false, actual: toResolved.error };

    const { candidate: fromCandidate, target: fromTarget } = fromResolved;
    const { candidate: toCandidate, target: toTarget } = toResolved;
    await this.activePage.mouse.move(fromTarget.x, fromTarget.y);
    await this.activePage.mouse.down();
    await this.activePage.mouse.move(toTarget.x, toTarget.y, { steps: 12 });
    await this.activePage.mouse.up();
    await this.showClickMarker(toTarget.x, toTarget.y, 'drag');
    const note = await this.waitAfterAction();
    await this.showClickMarker(toTarget.x, toTarget.y, 'drag');
    return {
      ok: true,
      actual: `Dragged candidate ${fromCandidate.id} (${this.describeCandidate(fromCandidate)}) to candidate ${toCandidate.id} (${this.describeCandidate(toCandidate)}).${fromTarget.offscreen || toTarget.offscreen ? ' One or both candidates were scrolled/clamped before dragging.' : ''}${note}`,
    };
  }

  async focusCandidate(candidateId: string): Promise<BrowserActionResult> {
    const resolved = await this.resolveCandidateTarget(candidateId);
    if (!resolved.target) return { ok: false, actual: resolved.error };

    const { candidate, target } = resolved;
    await this.activePage.mouse.click(target.x, target.y);
    const note = await this.waitAfterAction();
    return {
      ok: true,
      actual: `Focused candidate ${candidate.id} (${this.describeCandidate(candidate)}) at its visible center.${target.offscreen ? ' It was scrolled/clamped before focusing.' : ''}${note}`,
    };
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
    return { ok: true, actual: `Clicked DOM node ${path} (${target.descriptor}) at browser point (${target.x}, ${target.y}).${offscreenNote}${note}` };
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
    return { ok: true, actual: `Focused DOM node ${path} (${target.descriptor}) at browser point (${target.x}, ${target.y}).${offscreenNote}${note}` };
  }

  async scroll(deltaY: number, deltaX = 0, target: { domPath?: string } = {}): Promise<BrowserActionResult> {
    const scrollTarget = await this.resolveScrollTarget(target);
    await this.activePage.mouse.move(scrollTarget.x, scrollTarget.y);
    await this.activePage.mouse.wheel(deltaX, deltaY);
    const note = await this.waitAfterAction();
    return { ok: true, actual: `Scrolled ${scrollTarget.descriptor} at browser point (${scrollTarget.x}, ${scrollTarget.y}) by x=${deltaX}, y=${deltaY}.${scrollTarget.note}${note}` };
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

  private async refreshInteractiveCandidates() {
    const limit = Math.max(10, Number(process.env.INTERACTIVE_CANDIDATE_LIMIT || 160));
    const candidates = await this.activePage.evaluate(({ limit: candidateLimit }) => {
      type Candidate = {
        id: string;
        path: string;
        tag: string;
        role?: string;
        type?: string;
        name?: string;
        text?: string;
        nearbyText?: string;
        href?: string;
        host?: string;
        placeholder?: string;
        ariaLabel?: string;
        title?: string;
        rect: { x: number; y: number; width: number; height: number };
        center: { x: number; y: number };
        clickable: boolean;
        input: boolean;
        disabled: boolean;
        shadow?: boolean;
      };

      type WindowWithAiListeners = Window & {
        __aiGetEventListenerTypes?: (target: EventTarget) => string[];
      };

      const skippedTags = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'head', 'br', 'hr', 'wbr']);
      const interactiveRoles = new Set([
        'button',
        'link',
        'menuitem',
        'menuitemcheckbox',
        'menuitemradio',
        'tab',
        'checkbox',
        'radio',
        'switch',
        'option',
        'searchbox',
        'combobox',
        'textbox',
        'listbox',
      ]);

      function isOverlay(element: Element) {
        return Boolean(element.closest('#__ai_candidate_overlay__, #__ai_last_click_marker__'));
      }

      function shadowRootOf(element: Element) {
        return (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot || undefined;
      }

      // Walk the *composed* (flattened) tree upwards, crossing shadow boundaries
      // via the shadow root's host. Plain `parentElement` / `Node.contains` stop
      // at shadow boundaries, which breaks containment checks for shadow content.
      function flatParentElement(node: Node): Element | undefined {
        const parent = node.parentNode;
        if (!parent) return undefined;
        if (parent.nodeType === 1) return parent as Element;
        const host = (parent as ShadowRoot).host;
        return host || undefined;
      }

      function composedContains(ancestor: Element, node: Element) {
        let current: Element | undefined = node;
        let guard = 0;
        while (current && guard < 256) {
          if (current === ancestor) return true;
          current = flatParentElement(current);
          guard += 1;
        }
        return false;
      }

      function isInsideShadow(element: Element) {
        const root = element.getRootNode();
        return Boolean(root && (root as ShadowRoot).host);
      }

      function isRenderable(element: Element) {
        if (!element || element.nodeType !== 1 || isOverlay(element)) return false;
        const tag = element.tagName.toLowerCase();
        if (skippedTags.has(tag)) return false;
        if (element.hasAttribute('hidden')) return false;
        if (element.getAttribute('aria-hidden') === 'true') return false;
        const style = window.getComputedStyle(element);
        if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        if (style.pointerEvents === 'none') return false;
        if (Number(style.opacity || '1') <= 0.01) return false;
        return true;
      }

      function visibleRectOf(element: Element) {
        if (!isRenderable(element)) return undefined;
        const rect = element.getBoundingClientRect();
        const left = Math.max(rect.left, 0);
        const top = Math.max(rect.top, 0);
        const right = Math.min(rect.right, window.innerWidth);
        const bottom = Math.min(rect.bottom, window.innerHeight);
        const width = right - left;
        const height = bottom - top;
        if (width <= 2 || height <= 2) return undefined;
        return { left, top, right, bottom, width, height, raw: rect };
      }

      function isVisibleInViewport(element: Element) {
        return Boolean(visibleRectOf(element));
      }

      // Traversal must not depend on visual/clickability CSS. A parent can be a
      // hidden or pointer-disabled wrapper while a deeper child still supplies the
      // actual interactive target, so candidate eligibility is checked only in
      // candidateFrom().
      function isTraversable(element: Element) {
        if (!element || element.nodeType !== 1 || isOverlay(element)) return false;
        const tag = element.tagName.toLowerCase();
        return !skippedTags.has(tag);
      }

      function children(element: Element) {
        const list = Array.from(element.children);
        const root = shadowRootOf(element);
        if (root) {
          for (const child of Array.from(root.children)) list.push(child);
        }
        return list.filter(isTraversable);
      }

      function ownText(element: Element) {
        let text = '';
        for (const node of Array.from(element.childNodes)) {
          if (node.nodeType === 3) text += node.textContent || '';
        }
        text = text.replace(/\s+/g, ' ').trim();
        const inner = ((element as HTMLElement).innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
        return (text || inner).slice(0, 140);
      }

      function contextText(element: Element) {
        const container = element.closest('li, article, tr, form, [role="listitem"], [role="row"], section, main') || element.parentElement || element;
        const text = ((container as HTMLElement).innerText || container.textContent || '').replace(/\s+/g, ' ').trim();
        return text.slice(0, 220);
      }

      function recordedEventTypes(element: Element) {
        try {
          return ((window as WindowWithAiListeners).__aiGetEventListenerTypes?.(element) || []).map((item) => item.toLowerCase());
        } catch {
          return [];
        }
      }

      function hasRecordedClickListener(element: Element) {
        return recordedEventTypes(element).some((type) => /^(click|dblclick|mousedown|mouseup|pointerdown|pointerup|touchstart|keydown)$/.test(type));
      }

      function hasRecordedHoverListener(element: Element) {
        return recordedEventTypes(element).some((type) => /^(mouseenter|mouseover|pointerenter|pointerover)$/.test(type));
      }

      function hasActionAttribute(element: Element) {
        if (element.hasAttribute('jsaction')) return true;
        for (const attr of Array.from(element.attributes)) {
          if (/^(data-.+?(click|action|href|url|target)|ng-click|@click|v-on:click)$/i.test(attr.name) && attr.value !== 'false') return true;
        }
        return false;
      }

      function hasOwnHoverSignal(element: Element) {
        if (element.hasAttribute('onmouseenter')) return true;
        if (element.hasAttribute('onmouseover')) return true;
        if (element.hasAttribute('onpointerenter')) return true;
        if (element.hasAttribute('onpointerover')) return true;
        if (hasRecordedHoverListener(element)) return true;
        return false;
      }

      const hoverSelectors = (() => {
        const selectors: string[] = [];
        for (const sheet of Array.from(document.styleSheets)) {
          let rules: CSSRuleList | undefined;
          try {
            rules = sheet.cssRules;
          } catch {
            continue;
          }
          for (const rule of Array.from(rules || [])) {
            const selectorText = (rule as CSSStyleRule).selectorText;
            if (!selectorText || !selectorText.includes(':hover')) continue;
            for (const part of selectorText.split(',')) {
              const normalized = part
                .replace(/:hover\b/g, '')
                .replace(/:(active|focus|focus-visible|focus-within|visited|link)\b/g, '')
                .trim();
              if (normalized && !/[>+~]\s*$/.test(normalized)) selectors.push(normalized);
            }
          }
        }
        return Array.from(new Set(selectors)).slice(0, 600);
      })();

      function hasCssHoverEffect(element: Element) {
        const className = typeof element.className === 'string' ? element.className : '';
        if (/(^|\s)hover[:_-]/.test(className)) return true;
        for (const selector of hoverSelectors) {
          try {
            if (element.matches(selector)) return true;
          } catch {
            // Ignore selectors that cannot be used with matches().
          }
        }
        return false;
      }

      function clickableReason(element: Element) {
        const tag = element.tagName.toLowerCase();
        if (['a', 'button', 'input', 'select', 'textarea', 'label', 'summary', 'option'].includes(tag)) return true;
        const role = element.getAttribute('role');
        if (role && interactiveRoles.has(role)) return true;
        if (element.hasAttribute('onclick')) return true;
        if (hasRecordedClickListener(element)) return true;
        if (hasActionAttribute(element)) return true;
        const tabindex = element.getAttribute('tabindex');
        if (tabindex !== null && tabindex !== '-1') return true;
        if ((element as HTMLElement).isContentEditable) return true;
        return false;
      }

      function nameOf(element: Element) {
        const input = element as HTMLInputElement;
        const labelText = input.labels?.length ? Array.from(input.labels).map((label) => label.textContent || '').join(' ') : '';
        const imageAlt = Array.from(element.querySelectorAll('img[alt]')).map((img) => img.getAttribute('alt') || '').join(' ');
        return [
          element.getAttribute('aria-label'),
          element.getAttribute('title'),
          element.getAttribute('alt'),
          imageAlt,
          input.placeholder,
          labelText,
          ownText(element),
          input.value,
        ]
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 180);
      }

      // Topmost renderable element at a point, drilling through shadow roots so a
      // shadow-hosted element is reported instead of just its host. `elementsFromPoint`
      // on the document stops at shadow boundaries; we recurse via the shadow root's
      // own hit-test to reach the real element painted there.
      function topmostRenderableAt(x: number, y: number) {
        let root: Document | ShadowRoot = document;
        let found: Element | undefined;
        let guard = 0;
        while (guard < 24) {
          guard += 1;
          const stack = root.elementsFromPoint(x, y) as Element[];
          let top: Element | undefined;
          for (const item of stack) {
            if (isRenderable(item) && !isOverlay(item)) {
              top = item;
              break;
            }
          }
          if (!top) break;
          found = top;
          const sub = shadowRootOf(top);
          if (!sub) break;
          root = sub;
        }
        return found;
      }

      // Sample a grid across the element's visible box and hit-test every point.
      // `elementsFromPoint` returns elements in paint/stacking order, so this
      // naturally respects z-index: a higher z-index popup / dialog / selector
      // panel that paints over this element is reported as the topmost element.
      function computeVisibility(element: Element, rect: ReturnType<typeof visibleRectOf>) {
        if (!rect) return undefined;
        const cols = rect.width >= 80 ? 5 : 3;
        const rows = rect.height >= 60 ? 5 : 3;
        const points: Array<[number, number]> = [
          [rect.left + rect.width / 2, rect.top + rect.height / 2],
        ];
        for (let row = 0; row < rows; row += 1) {
          for (let col = 0; col < cols; col += 1) {
            points.push([
              rect.left + ((col + 0.5) / cols) * rect.width,
              rect.top + ((row + 0.5) / rows) * rect.height,
            ]);
          }
        }

        let owned = 0;
        let covered = 0;
        let visiblePoint: { x: number; y: number } | undefined;
        for (const [x, y] of points) {
          const px = Math.min(Math.max(x, 0), window.innerWidth - 1);
          const py = Math.min(Math.max(y, 0), window.innerHeight - 1);
          const top = topmostRenderableAt(px, py);
          if (!top) continue;
          if (top === element || composedContains(element, top)) {
            // The element (or one of its descendants) is the topmost layer here.
            owned += 1;
            if (!visiblePoint) visiblePoint = { x: Math.round(px), y: Math.round(py) };
          } else if (!composedContains(top, element)) {
            // An unrelated element with a higher stacking order paints over this
            // point (e.g. an open modal / dropdown), so the element is occluded here.
            covered += 1;
          }
          // If `top` is an ancestor, the element's own box is simply transparent
          // at this point; treat it as neither owned nor occluded.
        }

        const total = points.length;
        return {
          visiblePoint,
          ownedRatio: owned / total,
          coveredRatio: covered / total,
        };
      }

      function candidateFrom(element: Element, path: number[], id: string): Candidate | undefined {
        const tag = element.tagName.toLowerCase();
        const role = element.getAttribute('role') || undefined;
        const input = element as HTMLInputElement;
        const isInput = ['input', 'textarea', 'select'].includes(tag) || Boolean((element as HTMLElement).isContentEditable);
        const clickable = clickableReason(element);
        const hoverable = hasOwnHoverSignal(element) || hasCssHoverEffect(element);
        if (!clickable && !isInput && !hoverable) return undefined;

        const rect = visibleRectOf(element);
        if (!rect) return undefined;
        const visibility = computeVisibility(element, rect);
        if (!visibility || !visibility.visiblePoint) return undefined;
        // Suppress elements that sit behind a higher z-index layer (popup, dialog,
        // dropdown / selector options): when most of the element is painted over by
        // an unrelated element on top, it is not actually clickable at this spot, so
        // the lower element must not get an E marker.
        if (visibility.coveredRatio > 0.5 && visibility.ownedRatio < 0.35) return undefined;
        const visiblePoint = visibility.visiblePoint;
        const viewportArea = window.innerWidth * window.innerHeight;
        const area = rect.width * rect.height;
        if (area > viewportArea * 0.75 && !['input', 'textarea', 'select', 'button', 'a'].includes(tag)) return undefined;

        const href = tag === 'a' ? ((element as HTMLAnchorElement).href || element.getAttribute('href') || undefined) : undefined;
        let host: string | undefined;
        try {
          host = href ? new URL(href).hostname : undefined;
        } catch {
          host = undefined;
        }

        const text = ownText(element);
        const name = nameOf(element);
        const placeholder = input.placeholder || undefined;
        const ariaLabel = element.getAttribute('aria-label') || undefined;
        const title = element.getAttribute('title') || undefined;
        const type = tag === 'input' || tag === 'button' ? element.getAttribute('type') || undefined : undefined;

        return {
          id,
          path: path.join('.'),
          tag,
          role,
          type,
          name: name || undefined,
          text: text || undefined,
          nearbyText: contextText(element) || undefined,
          href,
          host,
          placeholder,
          ariaLabel,
          title,
          rect: {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          center: {
            x: Math.round(visiblePoint.x),
            y: Math.round(visiblePoint.y),
          },
          clickable,
          input: isInput,
          disabled: Boolean((input as HTMLInputElement).disabled || element.getAttribute('aria-disabled') === 'true'),
          shadow: isInsideShadow(element),
        };
      }

      function isDomPathAncestor(ancestorPath: string, descendantPath: string) {
        return descendantPath.startsWith(`${ancestorPath}.`);
      }

      // If both a parent and a child are independently interactive, keep the child.
      // This matches the click target the model should use and avoids broad toolbar
      // / menu wrappers swallowing their icon buttons.
      function dropParentWhenChildExists(items: Candidate[]) {
        return items.filter(
          (candidate) =>
            !items.some(
              (other) => other !== candidate && isDomPathAncestor(candidate.path, other.path),
            ),
        );
      }

      function selectCandidatesAcrossViewport(items: Candidate[], limit: number) {
        if (items.length <= limit) return items;
        const bandCount = 5;
        const bandHeight = Math.max(1, window.innerHeight / bandCount);
        const bands: Candidate[][] = Array.from({ length: bandCount }, () => []);
        for (const candidate of items) {
          const band = Math.min(bandCount - 1, Math.floor(candidate.center.y / bandHeight));
          bands[band].push(candidate);
        }
        const perBand = Math.max(1, Math.ceil(limit / bandCount));
        const selected: Candidate[] = [];
        for (const band of bands) {
          // Prefer smaller, more specific targets so band limits are not consumed
          // by large wrapper elements.
          band.sort(
            (a, b) =>
              a.rect.width * a.rect.height - b.rect.width * b.rect.height ||
              a.rect.y - b.rect.y ||
              a.rect.x - b.rect.x,
          );
          selected.push(...band.slice(0, perBand));
        }
        return selected
          .slice(0, limit)
          .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.rect.width * a.rect.height - b.rect.width * b.rect.height);
      }

      function domPathOf(element: Element) {
        if (isInsideShadow(element)) return undefined;
        const segments: number[] = [];
        let current: Element | undefined = element;
        while (current && current !== document.documentElement) {
          const parent = flatParentElement(current);
          if (!parent) return undefined;
          const siblings = children(parent);
          const index = siblings.indexOf(current);
          if (index < 0) return undefined;
          segments.unshift(index);
          current = parent;
        }
        if (current !== document.documentElement) return undefined;
        return [0, ...segments];
      }

      const raw: Candidate[] = [];
      function walk(element: Element, path: number[], depth: number) {
        if (depth > 24) return;
        const candidate = candidateFrom(element, path, '');
        if (candidate) raw.push(candidate);
        const childNodes = children(element);
        for (let index = 0; index < childNodes.length; index += 1) {
          walk(childNodes[index], [...path, index], depth + 1);
        }
      }

      walk(document.documentElement, [0], 0);

      // Flat scan all elements as a backup to the composed-tree walk. Candidate
      // filtering still happens in candidateFrom; this is not a selector whitelist.
      const seenPaths = new Set(raw.map((item) => item.path));
      for (const element of Array.from(document.querySelectorAll('*'))) {
        if (!isTraversable(element) || !isVisibleInViewport(element)) continue;
        const pathParts = domPathOf(element);
        if (!pathParts) continue;
        const pathKey = pathParts.join('.');
        if (seenPaths.has(pathKey)) continue;
        const extra = candidateFrom(element, pathParts, '');
        if (extra) {
          raw.push(extra);
          seenPaths.add(pathKey);
        }
      }

      const deduped = dropParentWhenChildExists(raw);
      deduped.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.rect.width * a.rect.height - b.rect.width * b.rect.height);
      return selectCandidatesAcrossViewport(deduped, candidateLimit).map((candidate, index) => ({
        ...candidate,
        id: `${index + 1}`,
      }));
    }, { limit }).catch(() => [] as InteractiveCandidate[]);

    this.lastInteractiveCandidates = candidates;
    return candidates;
  }

  private describeCandidate(candidate: InteractiveCandidate) {
    const parts = [
      candidate.tag,
      candidate.role ? `role=${candidate.role}` : '',
      candidate.name ? `name="${candidate.name.slice(0, 80)}"` : '',
      candidate.href ? `href=${candidate.href.slice(0, 140)}` : '',
      `box=${candidate.rect.x},${candidate.rect.y},${candidate.rect.width}x${candidate.rect.height}`,
    ].filter(Boolean);
    return parts.join(' ');
  }

  private async resolveCandidateTarget(candidateId: string) {
    const normalized = candidateId.trim().toUpperCase().replace(/^E(?=\d+$)/, '');
    let candidate = this.lastInteractiveCandidates.find((item) => item.id.toUpperCase() === normalized);
    if (!candidate) {
      await this.refreshInteractiveCandidates();
      candidate = this.lastInteractiveCandidates.find((item) => item.id.toUpperCase() === normalized);
    }

    if (!candidate) {
      const available = this.lastInteractiveCandidates
        .slice(0, 30)
        .map((item) => `${item.id}: ${this.describeCandidate(item)}`)
        .join('\n');
      return {
        error: `Candidate ${candidateId} was not found. Use getInteractiveCandidates for fresh IDs. Available candidates:\n${available || '[none]'}`,
      };
    }

    if (candidate.disabled) {
      return { candidate, error: `Candidate ${candidate.id} is disabled: ${this.describeCandidate(candidate)}` };
    }

    // Shadow-DOM candidates have no resolvable light-tree index path, so click them
    // by their captured viewport coordinates (which share the host document's space).
    if (candidate.shadow) {
      const point = await this.resolveShadowCandidatePoint(candidate);
      if (!point) {
        return {
          candidate,
          error: `Candidate ${candidate.id} (shadow DOM) is no longer at its captured position. Call getInteractiveCandidates again; the DOM likely changed.`,
        };
      }
      return { candidate, target: point };
    }

    const target = await this.resolveDomPathToClickablePoint(candidate.path);
    if (!target) {
      return {
        candidate,
        error: `Candidate ${candidate.id} could not be resolved from DOM path ${candidate.path}. Call getInteractiveCandidates again; the DOM likely changed.`,
      };
    }

    return { candidate, target };
  }

  private async resolveShadowCandidatePoint(candidate: InteractiveCandidate) {
    const px = candidate.center?.x;
    const py = candidate.center?.y;
    if (typeof px !== 'number' || typeof py !== 'number') return undefined;
    return this.activePage
      .evaluate(({ x, y }) => {
        if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return undefined;
        function deepTopmost(pointX: number, pointY: number) {
          let root: Document | ShadowRoot = document;
          let found: Element | undefined;
          for (let depth = 0; depth < 24; depth += 1) {
            const stack = root.elementsFromPoint(pointX, pointY) as Element[];
            let top: Element | undefined;
            for (const item of stack) {
              if (!item) continue;
              if (item.closest && item.closest('#__ai_candidate_overlay__, #__ai_last_click_marker__')) continue;
              top = item;
              break;
            }
            if (!top) break;
            found = top;
            const sub = (top as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
            if (!sub) break;
            root = sub;
          }
          return found;
        }
        const element = deepTopmost(x, y);
        if (!element) return undefined;
        const tag = element.tagName.toLowerCase();
        const id = element.id ? `#${element.id}` : '';
        return { x, y, descriptor: `${tag}${id}`, offscreen: false };
      }, { x: px, y: py })
      .catch(() => undefined);
  }

  private async readSimplifiedDomTree() {
    const maxNodes = Number(process.env.DOM_TREE_MAX_NODES || 320);
    const maxDepth = Number(process.env.DOM_TREE_MAX_DEPTH || 14);
    return this.activePage.evaluate(({ maxNodes: nodeLimit, maxDepth: depthLimit }) => {
      // NOTE: the child-filtering predicate below (skippedTags + aiIsRendered + aiChildren +
      // aiElementFromPath) MUST stay byte-identical to the one used in resolveDomPathToClickablePoint
      // and resolveScrollTarget, otherwise the bracket paths printed here will not resolve to the
      // same elements when the model clicks/focuses them.
      type WindowWithAiListeners = Window & {
        __aiGetEventListenerTypes?: (target: EventTarget) => string[];
      };
      const skippedTags = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'head', 'br', 'hr', 'wbr']);
      function aiIsRenderable(element: Element) {
        if (!element || element.nodeType !== 1) return false;
        if (element.closest('#__ai_candidate_overlay__, #__ai_last_click_marker__')) return false;
        const tag = element.tagName.toLowerCase();
        if (skippedTags.has(tag)) return false;
        if (element.hasAttribute('hidden')) return false;
        if (element.getAttribute('aria-hidden') === 'true') return false;
        const style = window.getComputedStyle(element);
        if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        if (style.pointerEvents === 'none') return false;
        if (Number(style.opacity || '1') <= 0.01) return false;
        return true;
      }
      function aiIsTraversable(element: Element) {
        if (!element || element.nodeType !== 1) return false;
        if (element.closest('#__ai_candidate_overlay__, #__ai_last_click_marker__')) return false;
        return !skippedTags.has(element.tagName.toLowerCase());
      }
      function aiVisibleRect(element: Element) {
        if (!aiIsRenderable(element)) return undefined;
        const rect = element.getBoundingClientRect();
        const left = Math.max(rect.left, 0);
        const top = Math.max(rect.top, 0);
        const right = Math.min(rect.right, window.innerWidth);
        const bottom = Math.min(rect.bottom, window.innerHeight);
        const width = right - left;
        const height = bottom - top;
        if (width <= 2 || height <= 2) return undefined;
        return { left, top, right, bottom, width, height };
      }
      function aiIsRendered(element: Element) {
        return Boolean(aiVisibleRect(element));
      }
      function aiChildren(element: Element) {
        return Array.from(element.children).filter(aiIsTraversable);
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
        const push = (key: string, value: string | null | undefined, maxLength = 40) => {
          if (!value) return;
          const clean = String(value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
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
        if (tag === 'a') push('href', (element as HTMLAnchorElement).href || element.getAttribute('href'), 140);
        return parts.length ? ` {${parts.join(' ')}}` : '';
      }

      function recordedEventTypes(element: Element) {
        try {
          return ((window as WindowWithAiListeners).__aiGetEventListenerTypes?.(element) || []).map((item) => item.toLowerCase());
        } catch {
          return [];
        }
      }

      function hasActionAttribute(element: Element) {
        if (element.hasAttribute('jsaction')) return true;
        for (const attr of Array.from(element.attributes)) {
          if (/^(data-.+?(click|action|href|url|target)|ng-click|@click|v-on:click)$/i.test(attr.name) && attr.value !== 'false') return true;
        }
        return false;
      }

      function isClickable(element: Element) {
        const tag = element.tagName.toLowerCase();
        if (['a', 'button', 'input', 'select', 'textarea', 'label', 'summary', 'option'].includes(tag)) return true;
        const role = element.getAttribute('role');
        if (role && ['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'checkbox', 'radio', 'switch', 'option'].includes(role)) return true;
        if (element.hasAttribute('onclick')) return true;
        if (recordedEventTypes(element).some((type) => /^(click|dblclick|mousedown|mouseup|pointerdown|pointerup|touchstart|keydown|mouseenter|mouseover|pointerenter|pointerover)$/.test(type))) return true;
        if (hasActionAttribute(element)) return true;
        const tabindex = element.getAttribute('tabindex');
        if (tabindex !== null && tabindex !== '-1') return true;
        if ((element as HTMLElement).isContentEditable) return true;
        return false;
      }

      function describe(element: Element, path: number[]) {
        const tag = element.tagName.toLowerCase();
        const id = element.id ? `#${CSS.escape(element.id)}` : '';
        const classes = typeof element.className === 'string'
          ? element.className.split(/\s+/).filter(Boolean).slice(0, 4).map((item) => `.${CSS.escape(item)}`).join('')
          : '';
        const clickable = isClickable(element) ? ' *' : '';
        const rect = aiVisibleRect(element);
        const box = rect
          ? ` @${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)}x${Math.round(rect.height)}`
          : '';
        const attrs = attrSummary(element);
        const text = ownText(element);
        const textPart = text ? ` "${text}"` : '';
        return `[${path.join('.')}] ${tag}${id}${classes}${clickable}${box}${attrs}${textPart}`;
      }

      const lines: string[] = [];
      function walk(element: Element, path: number[], depth: number) {
        if (depth > depthLimit) return;
        const rect = aiVisibleRect(element);
        if (rect && count < nodeLimit) {
          lines.push(`${'  '.repeat(depth)}${describe(element, path)}`);
          count += 1;
        }
        const childNodes = aiChildren(element);
        for (let index = 0; index < childNodes.length; index += 1) {
          if (count >= nodeLimit) break;
          walk(childNodes[index], [...path, index], rect ? depth + 1 : depth);
        }
      }

      walk(document.documentElement, [0], 0);
      const legend = 'Legend: [path] tag#id.class * @x,y,w,h {attrs} "text" - "*" marks clickable/interactive elements; @ is the visible viewport box; "text" is the node text; only visible (rendered) elements are listed.';
      if (count >= nodeLimit) lines.push(`... truncated at ${nodeLimit} nodes`);
      return `${legend}\n${lines.join('\n')}`;
    }, { maxNodes, maxDepth });
  }

  private async resolveDomPathToClickablePoint(pathValue: string) {
    return this.activePage.evaluate((path) => {
      // Keep this predicate byte-identical to readSimplifiedDomTree so paths resolve consistently.
      const skippedTags = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'head', 'br', 'hr', 'wbr']);
      function aiIsRenderable(element: Element) {
        if (!element || element.nodeType !== 1) return false;
        if (element.closest('#__ai_candidate_overlay__, #__ai_last_click_marker__')) return false;
        const tag = element.tagName.toLowerCase();
        if (skippedTags.has(tag)) return false;
        if (element.hasAttribute('hidden')) return false;
        if (element.getAttribute('aria-hidden') === 'true') return false;
        const style = window.getComputedStyle(element);
        if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        if (style.pointerEvents === 'none') return false;
        if (Number(style.opacity || '1') <= 0.01) return false;
        return true;
      }
      function aiIsTraversable(element: Element) {
        if (!element || element.nodeType !== 1) return false;
        if (element.closest('#__ai_candidate_overlay__, #__ai_last_click_marker__')) return false;
        return !skippedTags.has(element.tagName.toLowerCase());
      }
      function aiVisibleRect(element: Element) {
        if (!aiIsRenderable(element)) return undefined;
        const rect = element.getBoundingClientRect();
        const left = Math.max(rect.left, 0);
        const top = Math.max(rect.top, 0);
        const right = Math.min(rect.right, window.innerWidth);
        const bottom = Math.min(rect.bottom, window.innerHeight);
        const width = right - left;
        const height = bottom - top;
        if (width <= 2 || height <= 2) return undefined;
        return { left, top, right, bottom, width, height, raw: rect };
      }
      function aiIsRendered(element: Element) {
        return Boolean(aiVisibleRect(element));
      }
      function aiChildren(element: Element) {
        return Array.from(element.children).filter(aiIsTraversable);
      }
      function pointBelongsToElement(element: Element, x: number, y: number) {
        const top = document.elementsFromPoint(x, y).find((item) => aiIsRenderable(item));
        return Boolean(top && (top === element || element.contains(top)));
      }
      function visiblePointForElement(element: Element) {
        const rect = aiVisibleRect(element);
        if (!rect) return undefined;
        const insetX = Math.min(10, Math.max(1, rect.width / 4));
        const insetY = Math.min(10, Math.max(1, rect.height / 4));
        const samples = [
          [rect.left + rect.width / 2, rect.top + rect.height / 2],
          [rect.left + insetX, rect.top + rect.height / 2],
          [rect.right - insetX, rect.top + rect.height / 2],
          [rect.left + rect.width / 2, rect.top + insetY],
          [rect.left + rect.width / 2, rect.bottom - insetY],
          [rect.left + insetX, rect.top + insetY],
          [rect.right - insetX, rect.top + insetY],
          [rect.left + insetX, rect.bottom - insetY],
          [rect.right - insetX, rect.bottom - insetY],
        ];
        for (const [x, y] of samples) {
          const px = Math.min(Math.max(x, 0), window.innerWidth - 1);
          const py = Math.min(Math.max(y, 0), window.innerHeight - 1);
          if (pointBelongsToElement(element, px, py)) return { x: px, y: py };
        }
        return undefined;
      }

      const parts = String(path).split('.').map((item) => Number(String(item).trim()));
      if (!parts.length || parts[0] !== 0 || parts.some((item) => !Number.isInteger(item) || item < 0)) return undefined;

      let element: Element | undefined = document.documentElement;
      for (const index of parts.slice(1)) {
        element = aiChildren(element)[index];
        if (!element) return undefined;
      }
      if (!element) return undefined;

      let rect = element.getBoundingClientRect();
      let point = visiblePointForElement(element);
      if (!point) {
        element.scrollIntoView({ block: 'center', inline: 'center' });
        rect = element.getBoundingClientRect();
        point = visiblePointForElement(element);
      }
      // Some wrappers have zero size but contain a visible interactive child. Descend to the first
      // rendered descendant that actually has a box so the click lands on something visible.
      if (!point || rect.width <= 0 || rect.height <= 0) {
        const queue = aiChildren(element);
        while (queue.length) {
          const candidate = queue.shift() as Element;
          const candidateRect = candidate.getBoundingClientRect();
          const candidatePoint = visiblePointForElement(candidate);
          if (candidateRect.width > 0 && candidateRect.height > 0 && candidatePoint) {
            element = candidate;
            rect = candidateRect;
            point = candidatePoint;
            break;
          }
          queue.push(...aiChildren(candidate));
        }
      }
      if (!point || rect.width <= 0 || rect.height <= 0) return undefined;

      const tag = element.tagName.toLowerCase();
      const id = element.id ? `#${element.id}` : '';
      const classes = typeof element.className === 'string'
        ? element.className.split(/\s+/).filter(Boolean).slice(0, 4).map((item) => `.${item}`).join('')
        : '';
      const centerX = point.x;
      const centerY = point.y;
      const offscreen = rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth;
      return {
        x: Math.min(Math.max(centerX, 0), window.innerWidth - 1),
        y: Math.min(Math.max(centerY, 0), window.innerHeight - 1),
        descriptor: `${tag}${id}${classes}`,
        offscreen,
      };
    }, pathValue).catch(() => undefined);
  }

  private async dispatchDomPathClick(pathValue: string) {
    return this.activePage.evaluate((path) => {
      const skippedTags = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'head', 'br', 'hr', 'wbr']);
      function aiIsRenderable(element: Element) {
        if (!element || element.nodeType !== 1) return false;
        if (element.closest('#__ai_candidate_overlay__, #__ai_last_click_marker__')) return false;
        const tag = element.tagName.toLowerCase();
        if (skippedTags.has(tag)) return false;
        if (element.hasAttribute('hidden')) return false;
        if (element.getAttribute('aria-hidden') === 'true') return false;
        const style = window.getComputedStyle(element);
        if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        if (style.pointerEvents === 'none') return false;
        if (Number(style.opacity || '1') <= 0.01) return false;
        return true;
      }
      function aiIsTraversable(element: Element) {
        if (!element || element.nodeType !== 1) return false;
        if (element.closest('#__ai_candidate_overlay__, #__ai_last_click_marker__')) return false;
        return !skippedTags.has(element.tagName.toLowerCase());
      }
      function aiIsRendered(element: Element) {
        if (!aiIsRenderable(element)) return false;
        const rect = element.getBoundingClientRect();
        const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
        const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
        return visibleWidth > 2 && visibleHeight > 2;
      }
      function aiChildren(element: Element) {
        return Array.from(element.children).filter(aiIsTraversable);
      }

      const parts = String(path).split('.').map((item) => Number(String(item).trim()));
      if (!parts.length || parts[0] !== 0 || parts.some((item) => !Number.isInteger(item) || item < 0)) return undefined;
      let element: Element | undefined = document.documentElement;
      for (const index of parts.slice(1)) {
        element = aiChildren(element)[index];
        if (!element) return undefined;
      }
      if (!element) return undefined;
      const tag = element.tagName.toLowerCase();
      const id = element.id ? `#${element.id}` : '';
      (element as HTMLElement).click();
      return `${tag}${id}`;
    }, pathValue).catch(() => undefined);
  }

  private async resolveScrollTarget(target: { domPath?: string }) {
    return this.activePage.evaluate(({ domPath }) => {
      // Keep this predicate byte-identical to readSimplifiedDomTree so domPath indexes line up.
      const skippedTags = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'head', 'br', 'hr', 'wbr']);
      function aiIsRenderable(element: Element) {
        if (!element || element.nodeType !== 1) return false;
        if (element.closest('#__ai_candidate_overlay__, #__ai_last_click_marker__')) return false;
        const tag = element.tagName.toLowerCase();
        if (skippedTags.has(tag)) return false;
        if (element.hasAttribute('hidden')) return false;
        if (element.getAttribute('aria-hidden') === 'true') return false;
        const style = window.getComputedStyle(element);
        if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        if (style.pointerEvents === 'none') return false;
        if (Number(style.opacity || '1') <= 0.01) return false;
        return true;
      }
      function aiIsTraversable(element: Element) {
        if (!element || element.nodeType !== 1) return false;
        if (element.closest('#__ai_candidate_overlay__, #__ai_last_click_marker__')) return false;
        return !skippedTags.has(element.tagName.toLowerCase());
      }
      function aiIsRendered(element: Element) {
        if (!aiIsRenderable(element)) return false;
        const rect = element.getBoundingClientRect();
        const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
        const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
        return visibleWidth > 2 && visibleHeight > 2;
      }
      function aiChildren(element: Element) {
        return Array.from(element.children).filter(aiIsTraversable);
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
        document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2) ||
        document.documentElement;
      const scrollElement = closestScrollable(sourceElement);
      const rect = scrollElement.getBoundingClientRect();
      const targetX = scrollElement === document.documentElement || scrollElement === document.body || scrollElement === document.scrollingElement
        ? window.innerWidth / 2
        : rect.left + rect.width / 2;
      const targetY = scrollElement === document.documentElement || scrollElement === document.body || scrollElement === document.scrollingElement
        ? window.innerHeight / 2
        : rect.top + rect.height / 2;

      return {
        x: Math.min(Math.max(targetX, 0), window.innerWidth - 1),
        y: Math.min(Math.max(targetY, 0), window.innerHeight - 1),
        descriptor: descriptor(scrollElement),
        note: ` Source element: ${descriptor(sourceElement)}.`,
      };
    }, {
      domPath: target.domPath,
    }).catch(() => ({
      x: 1,
      y: 1,
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

  private async drawCandidateOverlay(candidates: InteractiveCandidate[]) {
    const labelLimit = Math.max(10, Number(process.env.SCREENSHOT_ELEMENT_LABEL_LIMIT || process.env.INTERACTIVE_CANDIDATE_LIMIT || 160));
    const visible = candidates.slice(0, labelLimit);
    await this.activePage.evaluate((items) => {
      document.getElementById('__ai_candidate_overlay__')?.remove();
      const overlay = document.createElement('div');
      overlay.id = '__ai_candidate_overlay__';
      Object.assign(overlay.style, {
        position: 'fixed',
        inset: '0',
        pointerEvents: 'none',
        zIndex: '2147483647',
        margin: '0',
        padding: '0',
      });

      const placedLabels: Array<{ left: number; top: number; right: number; bottom: number }> = [];
      function overlaps(a: { left: number; top: number; right: number; bottom: number }, b: { left: number; top: number; right: number; bottom: number }) {
        return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      }
      function expanded(box: { left: number; top: number; right: number; bottom: number }, padding: number) {
        return {
          left: box.left - padding,
          top: box.top - padding,
          right: box.right + padding,
          bottom: box.bottom + padding,
        };
      }
      function clamp(value: number, min: number, max: number) {
        return Math.max(min, Math.min(max, value));
      }
      function labelPosition(rect: { x: number; y: number; width: number; height: number }, labelWidth: number, labelHeight: number) {
        const maxLeft = Math.max(0, window.innerWidth - labelWidth);
        const maxTop = Math.max(0, window.innerHeight - labelHeight);
        const preferred = [
          { left: rect.x + rect.width - labelWidth, top: rect.y + rect.height - labelHeight },
          { left: rect.x + rect.width, top: rect.y + rect.height - labelHeight },
          { left: rect.x + rect.width - labelWidth, top: rect.y + rect.height },
          { left: rect.x + rect.width - labelWidth, top: rect.y },
        ];
        for (const option of preferred) {
          const left = clamp(option.left, 0, maxLeft);
          const top = clamp(option.top, 0, maxTop);
          const box = { left, top, right: left + labelWidth, bottom: top + labelHeight };
          if (!placedLabels.some((placed) => overlaps(expanded(box, 1), expanded(placed, 1)))) {
            placedLabels.push(box);
            return box;
          }
        }
        const left = clamp(rect.x + rect.width - labelWidth, 0, maxLeft);
        const top = clamp(rect.y + rect.height - labelHeight, 0, maxTop);
        const finalBox = { left, top, right: left + labelWidth, bottom: top + labelHeight };
        placedLabels.push(finalBox);
        return finalBox;
      }

      for (const item of items) {
        const rect = item.rect;
        if (!rect || rect.width <= 0 || rect.height <= 0) continue;

        const box = document.createElement('div');
        const color = item.href ? '#1d4ed8' : item.input ? '#047857' : '#b45309';
        Object.assign(box.style, {
          position: 'absolute',
          left: `${Math.max(0, rect.x)}px`,
          top: `${Math.max(0, rect.y)}px`,
          width: `${Math.max(1, rect.width)}px`,
          height: `${Math.max(1, rect.height)}px`,
          border: `2px solid ${color}`,
          borderRadius: '3px',
          background: 'rgba(255,255,255,0.04)',
          boxShadow: '0 0 0 1px rgba(255,255,255,0.95)',
        });

        const label = document.createElement('div');
        label.textContent = item.id;
        const labelWidth = Math.max(14, item.id.length * 6 + 2);
        const labelHeight = 12;
        const labelBox = labelPosition(rect, labelWidth, labelHeight);
        Object.assign(label.style, {
          position: 'absolute',
          left: `${labelBox.left}px`,
          top: `${labelBox.top}px`,
          width: `${labelWidth}px`,
          height: `${labelHeight}px`,
          padding: '0',
          boxSizing: 'border-box',
          background: 'transparent',
          color: '#fff',
          font: `900 10px/10px Arial, sans-serif`,
          letterSpacing: '0',
          textAlign: 'center',
          textShadow: '-1px -1px 0 #000, 0 -1px 0 #000, 1px -1px 0 #000, -1px 0 0 #000, 1px 0 0 #000, -1px 1px 0 #000, 0 1px 0 #000, 1px 1px 0 #000',
        });

        overlay.appendChild(box);
        overlay.appendChild(label);
      }

      document.documentElement.appendChild(overlay);
    }, visible).catch(() => undefined);
  }

  private async removeCandidateOverlay() {
    await this.activePage
      .evaluate(() => {
        document.getElementById('__ai_candidate_overlay__')?.remove();
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
