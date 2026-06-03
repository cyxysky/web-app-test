import { fsync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Frame, Page } from 'playwright';

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

export type BrowserSessionMode = 'dom' | 'visual-markers' | 'visual-coordinate';

function browserSessionModeFromEnv(): BrowserSessionMode {
  const raw = process.env.AI_BROWSER_MODE;
  if (/^(coordinate|coordinates|visual-coordinate|pure-visual|computer-use)$/i.test(String(raw || ''))) {
    return 'visual-coordinate';
  }
  return /^(true|1|yes|visual|vision|click|visual-markers)$/i.test(String(raw || ''))
    ? 'visual-markers'
    : 'dom';
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
  /** True when the screenshot scan found a meaningful interior click area that
   * belongs to this element without passing through another interactive descendant. */
  hasIndependentClickArea?: boolean;
  framePath?: string;
  frameUrl?: string;
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
  private lastScreenshotCandidates: InteractiveCandidate[] = [];
  private lastCandidateMarkerScreenshotPath?: string;

  constructor(private readonly mode: BrowserSessionMode = browserSessionModeFromEnv()) {}

  // 启动 Playwright 浏览器并注入事件监听记录脚本，用于后续识别可交互元素。
  async start() {
    const { chromium } = await import('playwright');
    const headless = process.env.HEADLESS_BROWSER === 'true';
    const fullscreen = process.env.BROWSER_FULLSCREEN !== 'false';
    const hasExplicitViewport = Boolean(process.env.BROWSER_VIEWPORT_WIDTH || process.env.BROWSER_VIEWPORT_HEIGHT);
    const viewportWidth = Number(process.env.BROWSER_VIEWPORT_WIDTH || (fullscreen ? 1920 : 1280));
    const viewportHeight = Number(process.env.BROWSER_VIEWPORT_HEIGHT || (fullscreen ? 1080 : 800));
    const ignoreHTTPSErrors = process.env.BROWSER_IGNORE_HTTPS_ERRORS !== 'false';
    this.browser = await chromium.launch({
      headless,
      slowMo: Number(process.env.BROWSER_SLOW_MO_MS || 250),
      args: [
        `--window-size=${viewportWidth},${viewportHeight + 120}`,
        fullscreen ? '--start-maximized' : '',
        ignoreHTTPSErrors ? '--ignore-certificate-errors' : '',
        '--force-device-scale-factor=1',
        '--high-dpi-support=1',
      ].filter(Boolean),
    });
    const useNativeFullscreenViewport = fullscreen && !headless && !hasExplicitViewport;
    const context = await this.browser.newContext({
      viewport: useNativeFullscreenViewport ? null : { width: viewportWidth, height: viewportHeight },
      ignoreHTTPSErrors,
      ...(useNativeFullscreenViewport ? {} : { deviceScaleFactor: 1 }),
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

  // 绑定 console 和网络失败监听，只记录会影响测试判断的关键异常。
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

  // 获取当前可用页面；如果活动页关闭，会从浏览器上下文中寻找替代页面。
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

  // 打开目标页面并等待基础加载完成。
  async open(url: string): Promise<BrowserActionResult> {
    await this.activePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const note = await this.waitAfterAction();
    return { ok: true, actual: `Opened page: ${url}${note}` };
  }

  // 读取当前页面正文文本，主要用于验证码/人工介入等文本判断。
  async readPageText() {
    return this.activePage.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  }

  // 汇总当前页面上下文，包括 URL、标题、焦点、候选元素、DOM 树和人工验证状态。
  async getPageContext(options: {
    includeDomTree?: boolean;
    includeText?: boolean;
    includeManualVerification?: boolean;
    includeInteractiveCandidates?: boolean;
    useCachedInteractiveCandidates?: boolean;
  } = {}) {
    const includeText = options.includeText !== false || options.includeManualVerification !== false;
    const includeInteractiveCandidates = options.includeInteractiveCandidates ?? this.mode !== 'visual-coordinate';
    const [title, text, viewportMetrics, focusedElement, domTree, interactiveCandidates] = await Promise.all([
      this.activePage.title().catch(() => ''),
      includeText ? this.readPageText() : Promise.resolve(''),
      this.getViewportMetrics(),
      this.getFocusedElement(),
      options.includeDomTree ? this.readSimplifiedDomTree().catch((error) => `Unable to read DOM tree: ${error instanceof Error ? error.message : String(error)}`) : Promise.resolve(undefined),
      !includeInteractiveCandidates
        ? Promise.resolve([] as InteractiveCandidate[])
        : options.useCachedInteractiveCandidates && this.lastScreenshotCandidates.length
        ? Promise.resolve(this.lastScreenshotCandidates)
        : options.useCachedInteractiveCandidates && this.lastInteractiveCandidates.length
          ? Promise.resolve(this.lastInteractiveCandidates)
        : this.refreshInteractiveCandidates().catch(() => this.lastInteractiveCandidates),
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

  // 结合页面文本和输入框扫描，判断是否需要人工处理验证码或安全校验。
  private async detectManualVerificationContext(title: string, url: string, text: string): Promise<ManualVerificationDetails> {
    const base = this.detectManualVerificationDetails(title, url, text);
    const captchaFields = await this.scanCaptchaInputFields();
    const captchaAppearsFilled = captchaFields.some((field) => field.filled);
    return { ...base, captchaFields, captchaAppearsFilled };
  }

  // 扫描可见的验证码/OTP 输入框，并判断用户是否已经填入内容。
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

  // 截取当前 viewport；视觉点击模式在 before 阶段额外生成一张与原图像素对齐的纯标识图。
  async takeScreenshot(runId: string, stepIndex: number, phase: 'before' | 'after' | 'manual' = 'after') {
    const dir = path.join(process.cwd(), 'artifacts', runId);
    await mkdir(dir, { recursive: true });
    const fileName = phase === 'manual' ? `step-${stepIndex}.png` : `step-${stepIndex}-${phase}.png`;
    const filePath = path.join(dir, fileName);
    const shouldCaptureCandidates = phase === 'before' && this.mode !== 'visual-coordinate';
    const candidateLabelsEnabled = shouldCaptureCandidates && this.mode === 'visual-markers' && process.env.SCREENSHOT_ELEMENT_LABELS !== 'false';
    const candidates = shouldCaptureCandidates
      ? await this.refreshInteractiveCandidates().catch(() => [] as InteractiveCandidate[])
      : [];
    if (shouldCaptureCandidates) {
      // This immutable-by-convention snapshot is the only source of candidate IDs
      // for the following AI request and click. Later context scans must not make a
      // screenshot label point at a different element.
      this.lastScreenshotCandidates = candidates.map((candidate) => ({
        ...candidate,
        rect: { ...candidate.rect },
        center: { ...candidate.center },
      }));
    }
    this.lastCandidateMarkerScreenshotPath = undefined;
    await this.removeCandidateOverlay();
    if (phase === 'before') await this.removeClickMarker();
    await this.activePage.screenshot({ path: filePath, fullPage: false, scale: 'css', timeout: 15000 });
    if (candidateLabelsEnabled) {
      const markerFilePath = path.join(dir, `step-${stepIndex}-before-markers.png`);
      await this.drawCandidateOverlay(candidates, true);
      try {
        await this.activePage.screenshot({ path: markerFilePath, fullPage: false, scale: 'css', timeout: 15000 });
        this.lastCandidateMarkerScreenshotPath = markerFilePath;
      } finally {
        await this.removeCandidateOverlay();
      }
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

  // 返回最近一次截图的尺寸和 viewport 信息，供 AI 请求上下文引用。
  getLastScreenshotMetrics() {
    return this.lastScreenshotMetrics;
  }

  // 返回最近一次操作前截图对应的纯标识图路径，视觉模式会把它作为第二张图片发送给 AI。
  getLastCandidateMarkerScreenshotPath() {
    return this.lastCandidateMarkerScreenshotPath;
  }

  // 返回当前可见交互候选元素，供 DOM 模式在无截图输入时定位控件。
  async getInteractiveCandidates(): Promise<BrowserActionResult> {
    const candidates = await this.refreshInteractiveCandidates();
    return { ok: true, actual: JSON.stringify(candidates, null, 2) };
  }

  // 返回简化后的 DOM 树文本，作为候选列表不足时的兜底定位信息。
  async getSimplifiedDomTree(): Promise<BrowserActionResult> {
    return { ok: true, actual: await this.readSimplifiedDomTree() };
  }

  // 点击指定编号的候选元素中心点。
  async clickCandidate(candidateId: string, text?: string): Promise<BrowserActionResult> {
    const resolved = await this.resolveCandidateTarget(candidateId);
    if (!resolved.target) return { ok: false, actual: resolved.error };

    const { candidate, target } = resolved;
    const context = this.activePage.context();
    const beforePages = context.pages().length;
    const beforeUrl = this.activePage.url();
    const popup = this.activePage.waitForEvent('popup', { timeout: 3000 }).catch(() => undefined);
    await this.activePage.mouse.click(target.x, target.y);
    await this.showClickMarker(target.x, target.y, 'click');
    if (text !== undefined) {
      await this.activePage.keyboard.type(text);
    }
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
    if (text === undefined && candidate.href && this.activePage.url() === beforeUrl && !newPage) {
      const fallback = candidate.framePath
        ? await this.dispatchFrameDomPathClick(candidate)
        : await this.dispatchDomPathClick(candidate.path);
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
      actual: `Clicked candidate ${candidate.id} (${this.describeCandidate(candidate)}) at its visible center.${text !== undefined ? ` Typed ${text.length} characters after clicking.` : ''}${target.offscreen ? ' It was scrolled/clamped before clicking.' : ''}${fallbackNote}${note}`,
    };
  }

  // 双击指定编号的候选元素，用于打开链接、表格行等双击场景。
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

  // 右键点击指定候选元素，用于上下文菜单类操作。
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

  // 悬停指定候选元素，用于触发下拉菜单、tooltip 或 hover 展开控件。
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

  // 将一个候选元素从起点拖拽到另一个候选元素位置。
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

  // 聚焦指定候选元素，通常在输入文本前调用。
  async focusCandidate(candidateId: string, text?: string): Promise<BrowserActionResult> {
    const resolved = await this.resolveCandidateTarget(candidateId);
    if (!resolved.target) return { ok: false, actual: resolved.error };

    const { candidate, target } = resolved;
    await this.activePage.mouse.click(target.x, target.y);
    if (text !== undefined) {
      await this.activePage.keyboard.type(text);
    }
    const note = await this.waitAfterAction();
    return {
      ok: true,
      actual: `Focused candidate ${candidate.id} (${this.describeCandidate(candidate)}) at its visible center.${text !== undefined ? ` Typed ${text.length} characters after focusing.` : ''}${target.offscreen ? ' It was scrolled/clamped before focusing.' : ''}${note}`,
    };
  }

  // 按纯视觉模型返回的 0-999 归一化坐标点击当前 viewport；可选文本会在点击后立即输入。
  async clickAt(x: number, y: number, text?: string): Promise<BrowserActionResult> {
    const target = await this.normalizedViewportPoint(x, y);
    const context = this.activePage.context();
    const beforePages = context.pages().length;
    const popup = this.activePage.waitForEvent('popup', { timeout: 3000 }).catch(() => undefined);
    await this.activePage.mouse.click(target.x, target.y);
    await this.showClickMarker(target.x, target.y, 'click');
    if (text !== undefined) await this.activePage.keyboard.type(text);

    const newPage = await Promise.race([
      popup,
      this.activePage.waitForTimeout(200).then(() => undefined).catch(() => undefined),
    ]);
    if (newPage) {
      this.page = newPage;
      this.attachPageListeners(newPage);
      await newPage.bringToFront();
    } else if (context.pages().length > beforePages) {
      this.page = context.pages().at(-1);
      await this.page?.bringToFront();
    }

    const note = await this.waitAfterAction();
    await this.showClickMarker(target.x, target.y, 'click');
    return {
      ok: true,
      actual: `Clicked normalized screenshot coordinate (${target.normalizedX}, ${target.normalizedY}) at browser point (${target.x}, ${target.y}).${text !== undefined ? ` Typed ${text.length} characters after clicking.` : ''}${note}`,
    };
  }

  // 按纯视觉坐标双击当前 viewport。
  async doubleClickAt(x: number, y: number): Promise<BrowserActionResult> {
    const target = await this.normalizedViewportPoint(x, y);
    await this.activePage.mouse.dblclick(target.x, target.y);
    await this.showClickMarker(target.x, target.y, 'double');
    const note = await this.waitAfterAction();
    await this.showClickMarker(target.x, target.y, 'double');
    return {
      ok: true,
      actual: `Double-clicked normalized screenshot coordinate (${target.normalizedX}, ${target.normalizedY}) at browser point (${target.x}, ${target.y}).${note}`,
    };
  }

  // 按纯视觉坐标右键点击当前 viewport。
  async rightClickAt(x: number, y: number): Promise<BrowserActionResult> {
    const target = await this.normalizedViewportPoint(x, y);
    await this.activePage.mouse.click(target.x, target.y, { button: 'right' });
    await this.showClickMarker(target.x, target.y, 'right');
    const note = await this.waitAfterAction();
    await this.showClickMarker(target.x, target.y, 'right');
    return {
      ok: true,
      actual: `Right-clicked normalized screenshot coordinate (${target.normalizedX}, ${target.normalizedY}) at browser point (${target.x}, ${target.y}).${note}`,
    };
  }

  // 按纯视觉坐标悬停，用于展开 hover 菜单或 tooltip。
  async hoverAt(x: number, y: number): Promise<BrowserActionResult> {
    const target = await this.normalizedViewportPoint(x, y);
    await this.activePage.mouse.move(target.x, target.y);
    const note = await this.waitAfterAction();
    return {
      ok: true,
      actual: `Hovered normalized screenshot coordinate (${target.normalizedX}, ${target.normalizedY}) at browser point (${target.x}, ${target.y}).${note}`,
    };
  }

  // 按纯视觉坐标从一个截图位置拖拽到另一个截图位置。
  async dragAt(fromX: number, fromY: number, toX: number, toY: number): Promise<BrowserActionResult> {
    const from = await this.normalizedViewportPoint(fromX, fromY);
    const to = await this.normalizedViewportPoint(toX, toY);
    await this.activePage.mouse.move(from.x, from.y);
    await this.activePage.mouse.down();
    await this.activePage.mouse.move(to.x, to.y, { steps: 12 });
    await this.activePage.mouse.up();
    await this.showClickMarker(to.x, to.y, 'drag');
    const note = await this.waitAfterAction();
    await this.showClickMarker(to.x, to.y, 'drag');
    return {
      ok: true,
      actual: `Dragged normalized screenshot coordinate (${from.normalizedX}, ${from.normalizedY}) to (${to.normalizedX}, ${to.normalizedY}), browser points (${from.x}, ${from.y}) to (${to.x}, ${to.y}).${note}`,
    };
  }

  // 在纯视觉模型指定的截图位置执行滚轮操作，使局部表格、侧边栏和弹窗可被直接滚动。
  async scrollAt(x: number, y: number, deltaY: number, deltaX = 0): Promise<BrowserActionResult> {
    const target = await this.normalizedViewportPoint(x, y);
    await this.activePage.mouse.move(target.x, target.y);
    await this.activePage.mouse.wheel(deltaX, deltaY);
    const note = await this.waitAfterAction();
    return {
      ok: true,
      actual: `Scrolled at normalized screenshot coordinate (${target.normalizedX}, ${target.normalizedY}), browser point (${target.x}, ${target.y}), by x=${deltaX}, y=${deltaY}.${note}`,
    };
  }

  // 通过简化 DOM 路径解析元素并点击，作为候选编号不可用时的兜底操作。
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

  // 通过简化 DOM 路径解析元素并聚焦，作为文本输入前的兜底聚焦方式。
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

  // 滚动页面或指定滚动容器，支持虚拟表格/列表的局部滚动。
  async scroll(deltaY: number, deltaX = 0, target: { domPath?: string } = {}): Promise<BrowserActionResult> {
    const scrollTarget = await this.resolveScrollTarget(target);
    await this.activePage.mouse.move(scrollTarget.x, scrollTarget.y);
    await this.activePage.mouse.wheel(deltaX, deltaY);
    const note = await this.waitAfterAction();
    return { ok: true, actual: `Scrolled ${scrollTarget.descriptor} at browser point (${scrollTarget.x}, ${scrollTarget.y}) by x=${deltaX}, y=${deltaY}.${scrollTarget.note}${note}` };
  }

  // 列出当前浏览器上下文中的所有标签页，供 AI 判断是否需要切换。
  async listTabs(): Promise<BrowserActionResult> {
    const pages = this.activePage.context().pages();
    return {
      ok: true,
      actual: pages.map((page, index) => `${index}: ${page.url()}`).join('\n') || 'No tabs found.',
    };
  }

  // 切换到指定标签页，并把它设为后续操作的活动页。
  async switchTab(index: number): Promise<BrowserActionResult> {
    const page = this.activePage.context().pages()[index];
    if (!page) return { ok: false, actual: `Tab ${index} not found.` };
    this.page = page;
    await page.bringToFront();
    return { ok: true, actual: `Switched to tab ${index}: ${page.url()}` };
  }

  // 向当前焦点元素输入文本。
  async typeText(input: string): Promise<BrowserActionResult> {
    await this.activePage.keyboard.type(input, { delay: 20 });
    const note = await this.waitAfterAction();
    return { ok: true, actual: `Typed text into the currently focused element: ${input}${note}` };
  }

  // 发送键盘按键，例如 Enter、Escape、Ctrl+A。
  async press(input: string): Promise<BrowserActionResult> {
    await this.activePage.keyboard.press(input);
    const note = await this.waitAfterAction();
    return { ok: true, actual: `Pressed key: ${input}${note}` };
  }

  // 等待页面进入较稳定状态，用于加载、跳转或动画后的观察。
  async waitForPage(): Promise<BrowserActionResult> {
    await this.activePage.waitForLoadState('domcontentloaded').catch((error) => {
      if (!this.isTargetClosedError(error)) throw error;
    });
    await this.waitForStableViewport(500);
    const note = await this.manualVerificationNote();
    return { ok: true, actual: `Page wait completed.${note}` };
  }

  // 等待固定时间，给短动画、下拉面板或异步更新留出渲染时间。
  async wait(ms = 800): Promise<BrowserActionResult> {
    await this.waitForStableViewport(Math.min(Math.max(ms, 100), 5000));
    return { ok: true, actual: `Waited ${ms}ms.` };
  }

  // 等待用户手动完成验证码/安全校验，超时后返回阻塞信息。
  async waitForManualVerification(maxMs = Number(process.env.MANUAL_VERIFICATION_TIMEOUT_MS || 180000)): Promise<BrowserActionResult> {
    const note = await this.manualVerificationNote();
    return {
      ok: !note,
      actual: note
        ? `Manual verification is visible. The run is paused for user intervention instead of waiting ${maxMs}ms inside the AI request.`
        : 'No manual verification page is currently detected.',
    };
  }

  // 返回本次会话采集到的关键 console 错误。
  getConsoleErrors() {
    return this.consoleErrors;
  }

  // 返回本次会话采集到的关键网络失败。
  getNetworkErrors() {
    return this.networkErrors;
  }

  // 关闭浏览器；调试场景可选择保留窗口。
  async close(options: { keepOpen?: boolean } = {}) {
    if (options.keepOpen || process.env.KEEP_BROWSER_OPEN_AFTER_RUN === 'true') return;
    await this.browser?.close().catch(() => undefined);
  }

  private async waitAfterAction() {
    const settleMs = Number(process.env.BROWSER_ACTION_SETTLE_MS || 0);
    await this.activePage.waitForLoadState('domcontentloaded').catch(() => undefined);
    if (Number.isFinite(settleMs) && settleMs > 0) {
      await this.waitForStableViewport(Math.min(Math.max(settleMs, 0), 2000));
    }
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

  // 将模型返回的 0-999 截图归一化坐标映射为 Playwright 使用的 CSS viewport 坐标。
  private async normalizedViewportPoint(x: number, y: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Invalid normalized screenshot coordinate: (${x}, ${y}).`);
    }
    const normalizedX = Math.min(999, Math.max(0, Math.round(x)));
    const normalizedY = Math.min(999, Math.max(0, Math.round(y)));
    const viewport = await this.getViewportMetrics();
    return {
      normalizedX,
      normalizedY,
      x: Math.round((normalizedX / 999) * Math.max(0, viewport.width - 1)),
      y: Math.round((normalizedY / 999) * Math.max(0, viewport.height - 1)),
    };
  }

  private async refreshInteractiveCandidates() {
    const limit = Math.max(10, Number(process.env.INTERACTIVE_CANDIDATE_LIMIT || 160));
    const scanLimit = Math.max(limit * 2, limit + 50);
    const mainCandidates = await this.activePage.evaluate(({ limit: candidateLimit }) => {
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
        hasIndependentClickArea?: boolean;
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
        const parent: Node | null = node.parentNode;
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
        if (['a', 'button', 'input', 'select', 'textarea', 'summary', 'option'].includes(tag)) return true;
        const role = element.getAttribute('role');
        if (role && interactiveRoles.has(role)) return true;
        if (element.hasAttribute('onclick')) return true;
        if (hasRecordedClickListener(element)) return true;
        if (hasActionAttribute(element)) return true;
        const tabindex = element.getAttribute('tabindex');
        if (tabindex !== null && tabindex !== '-1') return true;
        if (isContentEditableOwner(element)) return true;
        return false;
      }

      function isContentEditableOwner(element: Element) {
        const value = element.getAttribute('contenteditable');
        return value !== null && value.toLowerCase() !== 'false';
      }

      function isInteractiveDescendant(element: Element) {
        const tag = element.tagName.toLowerCase();
        if (tag === 'label') return true;
        const isInput = ['input', 'textarea', 'select'].includes(tag) || isContentEditableOwner(element);
        return clickableReason(element) || isInput || hasOwnHoverSignal(element) || hasCssHoverEffect(element);
      }

      function hasStrongOwnInteractionSemantics(element: Element) {
        const tag = element.tagName.toLowerCase();
        if (['a', 'button', 'input', 'select', 'textarea', 'summary', 'option'].includes(tag)) return true;
        if (isContentEditableOwner(element)) return true;
        const role = (element.getAttribute('role') || '').toLowerCase();
        if (['combobox', 'textbox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton'].includes(role)) return true;
        return Boolean(
          element.getAttribute('aria-label')?.trim() ||
          element.getAttribute('title')?.trim() ||
          element.getAttribute('placeholder')?.trim(),
        );
      }

      function hasMeaningfulContentOutsideInteractiveDescendants(element: Element) {
        let found = false;
        let visited = 0;
        const visualContentTags = new Set(['img', 'svg', 'canvas', 'video']);

        function visit(parent: Element) {
          if (found || visited > 2000) return;
          visited += 1;
          for (const node of Array.from(parent.childNodes)) {
            if (found) return;
            if (node.nodeType === Node.TEXT_NODE) {
              if ((node.textContent || '').replace(/\s+/g, ' ').trim()) found = true;
              continue;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            const child = node as Element;
            if (!isRenderable(child) || isInteractiveDescendant(child)) continue;
            if (visualContentTags.has(child.tagName.toLowerCase()) && visibleRectOf(child)) {
              found = true;
              return;
            }
            visit(child);
          }
        }

        visit(element);
        return found;
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

      function isIndependentPointForOwner(owner: Element, top: Element) {
        if (top !== owner && !composedContains(owner, top)) return false;
        let current: Element | undefined = top;
        let guard = 0;
        while (current && current !== owner && guard < 256) {
          if (isInteractiveDescendant(current)) return false;
          current = flatParentElement(current);
          guard += 1;
        }
        return current === owner;
      }

      function isInteriorSamplePoint(rect: NonNullable<ReturnType<typeof visibleRectOf>>, x: number, y: number) {
        const insetX = Math.min(12, Math.max(4, rect.width * 0.12));
        const insetY = Math.min(12, Math.max(4, rect.height * 0.12));
        if (rect.width <= insetX * 2 || rect.height <= insetY * 2) return false;
        return (
          x >= rect.left + insetX &&
          x <= rect.right - insetX &&
          y >= rect.top + insetY &&
          y <= rect.bottom - insetY
        );
      }

      function interactiveDescendantRects(owner: Element) {
        const rects: Array<NonNullable<ReturnType<typeof visibleRectOf>>> = [];
        const queue = [...children(owner)];
        let guard = 0;
        while (queue.length && guard < 4000) {
          const child = queue.shift() as Element;
          if (isInteractiveDescendant(child)) {
            const rect = visibleRectOf(child);
            if (rect) rects.push(rect);
          }
          queue.push(...children(child));
          guard += 1;
        }
        return rects;
      }

      function isSeparatedFromInteractiveDescendants(
        descendantRects: Array<NonNullable<ReturnType<typeof visibleRectOf>>>,
        x: number,
        y: number,
      ) {
        const clearance = 10;
        return descendantRects.every(
          (rect) =>
            x < rect.left - clearance ||
            x > rect.right + clearance ||
            y < rect.top - clearance ||
            y > rect.bottom + clearance,
        );
      }

      // Sample a grid across the element's visible box and hit-test every point.
      // `elementsFromPoint` returns elements in paint/stacking order, so this
      // naturally respects z-index: a higher z-index popup / dialog / selector
      // panel that paints over this element is reported as the topmost element.
      function computeVisibility(element: Element, rect: ReturnType<typeof visibleRectOf>) {
        if (!rect) return undefined;
        const cols = rect.width >= 80 ? 5 : 3;
        const rows = rect.height >= 60 ? 5 : 3;
        const points: Array<{ x: number; y: number; gridRow?: number; gridCol?: number }> = [
          { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        ];
        const edgeInsetX = Math.min(2, Math.max(0.5, rect.width / 8));
        const edgeInsetY = Math.min(2, Math.max(0.5, rect.height / 8));
        points.push(
          { x: rect.left + edgeInsetX, y: rect.top + edgeInsetY },
          { x: rect.right - edgeInsetX, y: rect.top + edgeInsetY },
          { x: rect.left + edgeInsetX, y: rect.bottom - edgeInsetY },
          { x: rect.right - edgeInsetX, y: rect.bottom - edgeInsetY },
          { x: rect.left + edgeInsetX, y: rect.top + rect.height / 2 },
          { x: rect.right - edgeInsetX, y: rect.top + rect.height / 2 },
          { x: rect.left + rect.width / 2, y: rect.top + edgeInsetY },
          { x: rect.left + rect.width / 2, y: rect.bottom - edgeInsetY },
        );
        for (let row = 0; row < rows; row += 1) {
          for (let col = 0; col < cols; col += 1) {
            points.push({
              x: rect.left + ((col + 0.5) / cols) * rect.width,
              y: rect.top + ((row + 0.5) / rows) * rect.height,
              gridRow: row,
              gridCol: col,
            });
          }
        }

        let owned = 0;
        let covered = 0;
        let visiblePoint: { x: number; y: number } | undefined;
        let independentInteriorPoint: { x: number; y: number } | undefined;
        let interiorPointCount = 0;
        const independentGridPoints = new Set<string>();
        const descendantRects = interactiveDescendantRects(element);
        for (const point of points) {
          const { x, y, gridRow, gridCol } = point;
          const px = Math.min(Math.max(x, 0), window.innerWidth - 1);
          const py = Math.min(Math.max(y, 0), window.innerHeight - 1);
          const isInteriorGridPoint =
            gridRow !== undefined &&
            gridCol !== undefined &&
            isInteriorSamplePoint(rect, px, py);
          if (isInteriorGridPoint) interiorPointCount += 1;
          const top = topmostRenderableAt(px, py);
          if (!top) continue;
          if (top === element || composedContains(element, top)) {
            // The element (or one of its descendants) is the topmost layer here.
            owned += 1;
            if (!visiblePoint) visiblePoint = { x: Math.round(px), y: Math.round(py) };
            if (
              isInteriorGridPoint &&
              isIndependentPointForOwner(element, top) &&
              isSeparatedFromInteractiveDescendants(descendantRects, px, py)
            ) {
              independentGridPoints.add(`${gridRow}:${gridCol}`);
              if (!independentInteriorPoint) {
                independentInteriorPoint = { x: Math.round(px), y: Math.round(py) };
              }
            }
          } else if (!composedContains(top, element)) {
            // An unrelated element with a higher stacking order paints over this
            // point (e.g. an open modal / dropdown), so the element is occluded here.
            covered += 1;
          }
          // If `top` is an ancestor, the element's own box is simply transparent
          // at this point; treat it as neither owned nor occluded.
        }

        const hasAdjacentIndependentPoints = Array.from(independentGridPoints).some((key) => {
          const [row, col] = key.split(':').map(Number);
          return (
            independentGridPoints.has(`${row - 1}:${col}`) ||
            independentGridPoints.has(`${row + 1}:${col}`) ||
            independentGridPoints.has(`${row}:${col - 1}`) ||
            independentGridPoints.has(`${row}:${col + 1}`)
          );
        });
        const total = points.length;
        return {
          visiblePoint,
          independentInteriorPoint,
          independentInteriorPointCount: independentGridPoints.size,
          interiorPointCount,
          hasAdjacentIndependentPoints,
          ownedRatio: owned / total,
          coveredRatio: covered / total,
        };
      }

      function visibleProxyForZeroSizeOwner(element: Element) {
        const queue = [...children(element)];
        while (queue.length) {
          const child = queue.shift() as Element;
          const tag = child.tagName.toLowerCase();
          const childInput = ['input', 'textarea', 'select'].includes(tag) || isContentEditableOwner(child);
          const childInteractive = clickableReason(child) || childInput || hasOwnHoverSignal(child) || hasCssHoverEffect(child);
          const rect = visibleRectOf(child);
          if (tag !== 'label' && !childInteractive && rect) {
            const visibility = computeVisibility(element, rect);
            if (visibility?.visiblePoint && !(visibility.coveredRatio > 0.5 && visibility.ownedRatio < 0.35)) {
              return { rect, visibility };
            }
          }
          queue.push(...children(child));
        }
        return undefined;
      }

      function candidateFrom(element: Element, path: number[], id: string): Candidate | undefined {
        const tag = element.tagName.toLowerCase();
        if (tag === 'label') return undefined;
        const role = element.getAttribute('role') || undefined;
        const input = element as HTMLInputElement;
        const isInput = ['input', 'textarea', 'select'].includes(tag) || isContentEditableOwner(element);
        const clickable = clickableReason(element);
        const hoverable = hasOwnHoverSignal(element) || hasCssHoverEffect(element);
        if (!clickable && !isInput && !hoverable) return undefined;

        let rect = visibleRectOf(element);
        let visibility = rect ? computeVisibility(element, rect) : undefined;
        if (!rect && clickable) {
          const proxy = visibleProxyForZeroSizeOwner(element);
          rect = proxy?.rect;
          visibility = proxy?.visibility;
        }
        if (!rect) return undefined;
        if (!visibility || !visibility.visiblePoint) return undefined;
        // Suppress elements that sit behind a higher z-index layer (popup, dialog,
        // dropdown / selector options): when most of the element is painted over by
        // an unrelated element on top, it is not actually clickable at this spot, so
        // the lower element must not get an E marker.
        if (visibility.coveredRatio > 0.5 && visibility.ownedRatio < 0.35) return undefined;
        const hasIndependentClickArea =
          clickable &&
          visibility.hasAdjacentIndependentPoints &&
          visibility.independentInteriorPointCount >= 2 &&
          visibility.independentInteriorPointCount / Math.max(1, visibility.interiorPointCount) >= 0.15;
        const visiblePoint = hasIndependentClickArea
          ? visibility.independentInteriorPoint || visibility.visiblePoint
          : visibility.visiblePoint;
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
          hasIndependentClickArea,
          shadow: isInsideShadow(element),
        };
      }

      function isDomPathAncestor(ancestorPath: string, descendantPath: string) {
        return descendantPath.startsWith(`${ancestorPath}.`);
      }

      function dropParentWhenChildExists(items: Candidate[], sourceElements: Map<string, Element>) {
        return items.filter((candidate) => {
          const hasChildCandidate = items.some(
            (other) => other !== candidate && isDomPathAncestor(candidate.path, other.path),
          );
          if (!hasChildCandidate) return true;
          if (!candidate.hasIndependentClickArea) return false;
          const element = sourceElements.get(candidate.path);
          return Boolean(
            element &&
            (hasStrongOwnInteractionSemantics(element) || hasMeaningfulContentOutsideInteractiveDescendants(element)),
          );
        });
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
          const parent: Element | undefined = flatParentElement(current);
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
      const sourceElements = new Map<string, Element>();
      function walk(element: Element, path: number[], depth: number) {
        if (depth > 24) return;
        const candidate = candidateFrom(element, path, '');
        if (candidate) {
          raw.push(candidate);
          sourceElements.set(candidate.path, element);
        }
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
          sourceElements.set(extra.path, element);
          seenPaths.add(pathKey);
        }
      }

      const deduped = dropParentWhenChildExists(raw, sourceElements);
      deduped.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.rect.width * a.rect.height - b.rect.width * b.rect.height);
      return selectCandidatesAcrossViewport(deduped, candidateLimit).map((candidate, index) => ({
        ...candidate,
        id: `${index + 1}`,
      }));
    }, { limit: scanLimit }).catch(() => [] as InteractiveCandidate[]);

    const frameCandidates = await this.refreshFrameInteractiveCandidates(scanLimit);
    const combinedCandidates: InteractiveCandidate[] = [...mainCandidates, ...frameCandidates];
    const candidates = combinedCandidates
      .filter((candidate) => {
        if (candidate.framePath) return true;
        return !frameCandidates.some((frameCandidate) => this.rectContains(candidate.rect, frameCandidate.rect));
      })
      .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.rect.width * a.rect.height - b.rect.width * b.rect.height)
      .slice(0, limit)
      .map((candidate, index) => ({
        ...candidate,
        id: `${index + 1}`,
      }));
    this.lastInteractiveCandidates = candidates;
    return candidates;
  }

  private rectContains(
    outer: { x: number; y: number; width: number; height: number },
    inner: { x: number; y: number; width: number; height: number },
  ) {
    const tolerance = 2;
    return (
      inner.x >= outer.x - tolerance &&
      inner.y >= outer.y - tolerance &&
      inner.x + inner.width <= outer.x + outer.width + tolerance &&
      inner.y + inner.height <= outer.y + outer.height + tolerance
    );
  }

  private async refreshFrameInteractiveCandidates(limit: number): Promise<InteractiveCandidate[]> {
    const frames = this.activePage.frames().filter((frame) => frame !== this.activePage.mainFrame());
    const viewport = await this.getViewportMetrics().catch(() => ({ width: 0, height: 0, devicePixelRatio: 1 }));
    const all: InteractiveCandidate[] = [];

    for (const frame of frames) {
      const framePath = this.getFramePath(frame);
      if (!framePath) continue;

      const box = await frame.frameElement().then((handle) => handle.boundingBox()).catch(() => undefined);
      if (!box || box.width <= 2 || box.height <= 2) continue;

      const localCandidates = await frame.evaluate(({ limit: candidateLimit }) => {
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
          hasIndependentClickArea?: boolean;
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

        function isTraversable(element: Element) {
          if (!element || element.nodeType !== 1 || isOverlay(element)) return false;
          return !skippedTags.has(element.tagName.toLowerCase());
        }

        function children(element: Element) {
          return Array.from(element.children).filter(isTraversable);
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
          return { left, top, right, bottom, width, height };
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

        function hasOwnHoverSignal(element: Element) {
          if (element.hasAttribute('onmouseenter')) return true;
          if (element.hasAttribute('onmouseover')) return true;
          if (element.hasAttribute('onpointerenter')) return true;
          if (element.hasAttribute('onpointerover')) return true;
          if (hasRecordedHoverListener(element)) return true;
          return false;
        }

        function hasActionAttribute(element: Element) {
          if (element.hasAttribute('jsaction')) return true;
          for (const attr of Array.from(element.attributes)) {
            if (/^(data-.+?(click|action|href|url|target)|ng-click|@click|v-on:click)$/i.test(attr.name) && attr.value !== 'false') return true;
          }
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
          if (['a', 'button', 'input', 'select', 'textarea', 'summary', 'option'].includes(tag)) return true;
          const role = element.getAttribute('role');
          if (role && interactiveRoles.has(role)) return true;
          if (element.hasAttribute('onclick')) return true;
          if (hasRecordedClickListener(element)) return true;
          if (hasActionAttribute(element)) return true;
          const tabindex = element.getAttribute('tabindex');
          if (tabindex !== null && tabindex !== '-1') return true;
          if (isContentEditableOwner(element)) return true;
          return false;
        }

        function isContentEditableOwner(element: Element) {
          const value = element.getAttribute('contenteditable');
          return value !== null && value.toLowerCase() !== 'false';
        }

        function isInteractiveDescendant(element: Element) {
          const tag = element.tagName.toLowerCase();
          if (tag === 'label') return true;
          const isInput = ['input', 'textarea', 'select'].includes(tag) || isContentEditableOwner(element);
          return clickableReason(element) || isInput || hasOwnHoverSignal(element) || hasCssHoverEffect(element);
        }

        function hasStrongOwnInteractionSemantics(element: Element) {
          const tag = element.tagName.toLowerCase();
          if (['a', 'button', 'input', 'select', 'textarea', 'summary', 'option'].includes(tag)) return true;
          if (isContentEditableOwner(element)) return true;
          const role = (element.getAttribute('role') || '').toLowerCase();
          if (['combobox', 'textbox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton'].includes(role)) return true;
          return Boolean(
            element.getAttribute('aria-label')?.trim() ||
            element.getAttribute('title')?.trim() ||
            element.getAttribute('placeholder')?.trim(),
          );
        }

        function hasMeaningfulContentOutsideInteractiveDescendants(element: Element) {
          let found = false;
          let visited = 0;
          const visualContentTags = new Set(['img', 'svg', 'canvas', 'video']);

          function visit(parent: Element) {
            if (found || visited > 2000) return;
            visited += 1;
            for (const node of Array.from(parent.childNodes)) {
              if (found) return;
              if (node.nodeType === Node.TEXT_NODE) {
                if ((node.textContent || '').replace(/\s+/g, ' ').trim()) found = true;
                continue;
              }
              if (node.nodeType !== Node.ELEMENT_NODE) continue;
              const child = node as Element;
              if (!isRenderable(child) || isInteractiveDescendant(child)) continue;
              if (visualContentTags.has(child.tagName.toLowerCase()) && visibleRectOf(child)) {
                found = true;
                return;
              }
              visit(child);
            }
          }

          visit(element);
          return found;
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

        function topmostRenderableAt(x: number, y: number) {
          return document.elementsFromPoint(x, y).find((item) => isRenderable(item));
        }

        function isIndependentPointForOwner(owner: Element, top: Element) {
          if (top !== owner && !owner.contains(top)) return false;
          let current: Element | null = top;
          while (current && current !== owner) {
            if (isInteractiveDescendant(current)) return false;
            current = current.parentElement;
          }
          return current === owner;
        }

        function isInteriorSamplePoint(rect: NonNullable<ReturnType<typeof visibleRectOf>>, x: number, y: number) {
          const insetX = Math.min(12, Math.max(4, rect.width * 0.12));
          const insetY = Math.min(12, Math.max(4, rect.height * 0.12));
          if (rect.width <= insetX * 2 || rect.height <= insetY * 2) return false;
          return (
            x >= rect.left + insetX &&
            x <= rect.right - insetX &&
            y >= rect.top + insetY &&
            y <= rect.bottom - insetY
          );
        }

        function interactiveDescendantRects(owner: Element) {
          const rects: Array<NonNullable<ReturnType<typeof visibleRectOf>>> = [];
          const queue = [...children(owner)];
          let guard = 0;
          while (queue.length && guard < 4000) {
            const child = queue.shift() as Element;
            if (isInteractiveDescendant(child)) {
              const rect = visibleRectOf(child);
              if (rect) rects.push(rect);
            }
            queue.push(...children(child));
            guard += 1;
          }
          return rects;
        }

        function isSeparatedFromInteractiveDescendants(
          descendantRects: Array<NonNullable<ReturnType<typeof visibleRectOf>>>,
          x: number,
          y: number,
        ) {
          const clearance = 10;
          return descendantRects.every(
            (rect) =>
              x < rect.left - clearance ||
              x > rect.right + clearance ||
              y < rect.top - clearance ||
              y > rect.bottom + clearance,
          );
        }

        function visibilityForElement(element: Element, rect: ReturnType<typeof visibleRectOf>) {
          if (!rect) return undefined;
          const cols = rect.width >= 80 ? 5 : 3;
          const rows = rect.height >= 60 ? 5 : 3;
          const samples: Array<{ x: number; y: number; gridRow?: number; gridCol?: number }> = [
            { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
          ];
          const edgeInsetX = Math.min(2, Math.max(0.5, rect.width / 8));
          const edgeInsetY = Math.min(2, Math.max(0.5, rect.height / 8));
          samples.push(
            { x: rect.left + edgeInsetX, y: rect.top + edgeInsetY },
            { x: rect.right - edgeInsetX, y: rect.top + edgeInsetY },
            { x: rect.left + edgeInsetX, y: rect.bottom - edgeInsetY },
            { x: rect.right - edgeInsetX, y: rect.bottom - edgeInsetY },
            { x: rect.left + edgeInsetX, y: rect.top + rect.height / 2 },
            { x: rect.right - edgeInsetX, y: rect.top + rect.height / 2 },
            { x: rect.left + rect.width / 2, y: rect.top + edgeInsetY },
            { x: rect.left + rect.width / 2, y: rect.bottom - edgeInsetY },
          );
          for (let row = 0; row < rows; row += 1) {
            for (let col = 0; col < cols; col += 1) {
              samples.push({
                x: rect.left + ((col + 0.5) / cols) * rect.width,
                y: rect.top + ((row + 0.5) / rows) * rect.height,
                gridRow: row,
                gridCol: col,
              });
            }
          }
          let visiblePoint: { x: number; y: number } | undefined;
          let independentInteriorPoint: { x: number; y: number } | undefined;
          let interiorPointCount = 0;
          const independentGridPoints = new Set<string>();
          const descendantRects = interactiveDescendantRects(element);
          for (const sample of samples) {
            const { x, y, gridRow, gridCol } = sample;
            const px = Math.min(Math.max(x, 0), window.innerWidth - 1);
            const py = Math.min(Math.max(y, 0), window.innerHeight - 1);
            const isInteriorGridPoint =
              gridRow !== undefined &&
              gridCol !== undefined &&
              isInteriorSamplePoint(rect, px, py);
            if (isInteriorGridPoint) interiorPointCount += 1;
            const top = topmostRenderableAt(px, py);
            if (!top || (top !== element && !element.contains(top))) continue;
            if (!visiblePoint) visiblePoint = { x: Math.round(px), y: Math.round(py) };
            if (
              isInteriorGridPoint &&
              isIndependentPointForOwner(element, top) &&
              isSeparatedFromInteractiveDescendants(descendantRects, px, py)
            ) {
              independentGridPoints.add(`${gridRow}:${gridCol}`);
              if (!independentInteriorPoint) {
                independentInteriorPoint = { x: Math.round(px), y: Math.round(py) };
              }
            }
          }
          const hasAdjacentIndependentPoints = Array.from(independentGridPoints).some((key) => {
            const [row, col] = key.split(':').map(Number);
            return (
              independentGridPoints.has(`${row - 1}:${col}`) ||
              independentGridPoints.has(`${row + 1}:${col}`) ||
              independentGridPoints.has(`${row}:${col - 1}`) ||
              independentGridPoints.has(`${row}:${col + 1}`)
            );
          });
          return visiblePoint
            ? {
                visiblePoint,
                independentInteriorPoint,
                independentInteriorPointCount: independentGridPoints.size,
                interiorPointCount,
                hasAdjacentIndependentPoints,
              }
            : undefined;
        }

        function visibleProxyForZeroSizeOwner(element: Element) {
          const queue = [...children(element)];
          while (queue.length) {
            const child = queue.shift() as Element;
            const tag = child.tagName.toLowerCase();
            const childInput = ['input', 'textarea', 'select'].includes(tag) || isContentEditableOwner(child);
            const childInteractive = clickableReason(child) || childInput || hasOwnHoverSignal(child) || hasCssHoverEffect(child);
            const rect = visibleRectOf(child);
            if (tag !== 'label' && !childInteractive && rect) {
              const visibility = visibilityForElement(element, rect);
              if (visibility?.visiblePoint) return { rect, visibility };
            }
            queue.push(...children(child));
          }
          return undefined;
        }

        function domPathOf(element: Element) {
          const segments: number[] = [];
          let current: Element | undefined = element;
          while (current && current !== document.documentElement) {
            const parent: Element | null = current.parentElement;
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

        function candidateFrom(element: Element, path: number[]): Candidate | undefined {
          const tag = element.tagName.toLowerCase();
          if (tag === 'label') return undefined;
          const role = element.getAttribute('role') || undefined;
          const input = element as HTMLInputElement;
          const isInput = ['input', 'textarea', 'select'].includes(tag) || isContentEditableOwner(element);
          const clickable = clickableReason(element);
          const hoverable = hasOwnHoverSignal(element) || hasCssHoverEffect(element);
          if (!clickable && !isInput && !hoverable) return undefined;

          let rect = visibleRectOf(element);
          let visibility = rect ? visibilityForElement(element, rect) : undefined;
          if (!rect && clickable) {
            const proxy = visibleProxyForZeroSizeOwner(element);
            rect = proxy?.rect;
            visibility = proxy?.visibility;
          }
          if (!rect) return undefined;
          if (!visibility?.visiblePoint) return undefined;
          const hasIndependentClickArea =
            clickable &&
            visibility.hasAdjacentIndependentPoints &&
            visibility.independentInteriorPointCount >= 2 &&
            visibility.independentInteriorPointCount / Math.max(1, visibility.interiorPointCount) >= 0.15;
          const point = hasIndependentClickArea
            ? visibility.independentInteriorPoint || visibility.visiblePoint
            : visibility.visiblePoint;

          const viewportArea = window.innerWidth * window.innerHeight;
          const area = rect.width * rect.height;
          if (area > viewportArea * 0.75 && !['input', 'textarea', 'select', 'button', 'a'].includes(tag)) return undefined;

          const href = tag === 'a' ? ((element as HTMLAnchorElement).href || element.getAttribute('href') || undefined) : undefined;
          const host = ((): string | undefined => {
            if (!href) return undefined;
            try {
              return new URL(href).hostname;
            } catch {
              return undefined;
            }
          })();

          const text = ownText(element);
          const name = nameOf(element);
          const placeholder = input.placeholder || undefined;
          const ariaLabel = element.getAttribute('aria-label') || undefined;
          const title = element.getAttribute('title') || undefined;
          const type = tag === 'input' || tag === 'button' ? element.getAttribute('type') || undefined : undefined;

          return {
            id: '',
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
            center: point,
            clickable,
            input: isInput,
            disabled: Boolean((input as HTMLInputElement).disabled || element.getAttribute('aria-disabled') === 'true'),
            hasIndependentClickArea,
          };
        }

        function isDomPathAncestor(ancestorPath: string, descendantPath: string) {
          return descendantPath.startsWith(`${ancestorPath}.`);
        }

        const raw: Candidate[] = [];
        const sourceElements = new Map<string, Element>();
        const seenPaths = new Set<string>();
        for (const element of Array.from(document.querySelectorAll('*'))) {
          if (!isTraversable(element)) continue;
          const path = domPathOf(element);
          if (!path) continue;
          const key = path.join('.');
          if (seenPaths.has(key)) continue;
          const candidate = candidateFrom(element, path);
          if (candidate) {
            raw.push(candidate);
            sourceElements.set(candidate.path, element);
            seenPaths.add(key);
          }
        }

        const deduped = raw.filter((candidate) => {
          const hasChildCandidate = raw.some(
            (other) => other !== candidate && isDomPathAncestor(candidate.path, other.path),
          );
          if (!hasChildCandidate) return true;
          if (!candidate.hasIndependentClickArea) return false;
          const element = sourceElements.get(candidate.path);
          return Boolean(
            element &&
            (hasStrongOwnInteractionSemantics(element) || hasMeaningfulContentOutsideInteractiveDescendants(element)),
          );
        });
        return deduped
          .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.rect.width * a.rect.height - b.rect.width * b.rect.height)
          .slice(0, candidateLimit);
      }, { limit }).catch(() => [] as Omit<InteractiveCandidate, 'framePath' | 'frameUrl' | 'shadow'>[]);

      for (const candidate of localCandidates) {
        const rect = {
          x: Math.round(box.x + candidate.rect.x),
          y: Math.round(box.y + candidate.rect.y),
          width: candidate.rect.width,
          height: candidate.rect.height,
        };
        const center = {
          x: Math.round(box.x + candidate.center.x),
          y: Math.round(box.y + candidate.center.y),
        };
        if (center.x < 0 || center.y < 0 || center.x >= viewport.width || center.y >= viewport.height) continue;
        all.push({
          ...candidate,
          id: '',
          rect,
          center,
          framePath,
          frameUrl: frame.url() || undefined,
        });
      }
    }

    return all;
  }

  private describeCandidate(candidate: InteractiveCandidate) {
    const parts = [
      candidate.tag,
      candidate.role ? `role=${candidate.role}` : '',
      candidate.name ? `name="${candidate.name.slice(0, 80)}"` : '',
      candidate.href ? `href=${candidate.href.slice(0, 140)}` : '',
      candidate.framePath ? `frame=${candidate.framePath}` : '',
      `box=${candidate.rect.x},${candidate.rect.y},${candidate.rect.width}x${candidate.rect.height}`,
    ].filter(Boolean);
    return parts.join(' ');
  }

  private candidateIdentityPayload(candidate: InteractiveCandidate) {
    return {
      tag: candidate.tag,
      role: candidate.role,
      type: candidate.type,
      href: candidate.href,
      ariaLabel: candidate.ariaLabel,
      placeholder: candidate.placeholder,
      title: candidate.title,
      text: candidate.text,
      name: candidate.name,
    };
  }

  private async validateMainCandidateIdentity(candidate: InteractiveCandidate) {
    return this.activePage.evaluate(({ path, expected }) => {
      const skippedTags = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'head', 'br', 'hr', 'wbr']);
      function traversableChildren(element: Element) {
        return Array.from(element.children).filter((child) => !skippedTags.has(child.tagName.toLowerCase()));
      }
      function elementFromPath(pathValue: string) {
        const parts = String(pathValue).split('.').map((item) => Number(String(item).trim()));
        if (!parts.length || parts[0] !== 0 || parts.some((item) => !Number.isInteger(item) || item < 0)) return undefined;
        let element: Element | undefined = document.documentElement;
        for (const index of parts.slice(1)) {
          element = traversableChildren(element)[index];
          if (!element) return undefined;
        }
        return element;
      }
      function normalized(value?: string | null) {
        return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
      }
      function ownText(element: Element) {
        let text = '';
        for (const node of Array.from(element.childNodes)) {
          if (node.nodeType === 3) text += node.textContent || '';
        }
        const inner = ((element as HTMLElement).innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
        return normalized(text || inner).slice(0, 140);
      }
      function currentName(element: Element) {
        const input = element as HTMLInputElement;
        const labelText = input.labels?.length ? Array.from(input.labels).map((label) => label.textContent || '').join(' ') : '';
        const imageAlt = Array.from(element.querySelectorAll('img[alt]')).map((img) => img.getAttribute('alt') || '').join(' ');
        return normalized([
          element.getAttribute('aria-label'),
          element.getAttribute('title'),
          element.getAttribute('alt'),
          imageAlt,
          input.placeholder,
          labelText,
          ownText(element),
          input.value,
        ].filter(Boolean).join(' '));
      }
      function compare(label: string, expectedValue?: string, actualValue?: string | null) {
        const left = normalized(expectedValue);
        const right = normalized(actualValue);
        if (!left) return undefined;
        return left === right ? undefined : `${label} changed from "${left}" to "${right || '[empty]'}"`;
      }

      const element = elementFromPath(path);
      if (!element) return { ok: false, reason: `DOM path ${path} no longer exists` };
      const input = element as HTMLInputElement;
      const actualTag = element.tagName.toLowerCase();
      if (actualTag !== expected.tag) return { ok: false, reason: `tag changed from ${expected.tag} to ${actualTag}` };
      const mismatches = [
        compare('role', expected.role, element.getAttribute('role')),
        compare('type', expected.type, element.getAttribute('type')),
        compare('href', expected.href, actualTag === 'a' ? (element as HTMLAnchorElement).href || element.getAttribute('href') : undefined),
        compare('aria-label', expected.ariaLabel, element.getAttribute('aria-label')),
        compare('placeholder', expected.placeholder, input.placeholder),
        compare('title', expected.title, element.getAttribute('title')),
      ].filter(Boolean);
      if (mismatches.length) return { ok: false, reason: mismatches.join('; ') };

      const expectedText = normalized(expected.text);
      const expectedName = normalized(expected.name);
      const actualText = ownText(element);
      const actualName = currentName(element);
      if (expectedText && actualText && expectedText !== actualText && expectedName && actualName && expectedName !== actualName) {
        return { ok: false, reason: `text/name changed from "${expectedText}" to "${actualText}"` };
      }
      return { ok: true, reason: '' };
    }, { path: candidate.path, expected: this.candidateIdentityPayload(candidate) }).catch((error) => ({
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }));
  }

  private async validateFrameCandidateIdentity(candidate: InteractiveCandidate) {
    const frame = this.frameFromPath(candidate.framePath);
    if (!frame) return { ok: false, reason: `iframe ${candidate.framePath} no longer exists` };
    return frame.evaluate(({ path, expected }) => {
      const skippedTags = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'head', 'br', 'hr', 'wbr']);
      function children(element: Element) {
        return Array.from(element.children).filter((child) => !skippedTags.has(child.tagName.toLowerCase()));
      }
      const parts = String(path).split('.').map((item) => Number(String(item).trim()));
      if (!parts.length || parts[0] !== 0 || parts.some((item) => !Number.isInteger(item) || item < 0)) {
        return { ok: false, reason: `invalid DOM path ${path}` };
      }
      let element: Element | undefined = document.documentElement;
      for (const index of parts.slice(1)) {
        element = children(element)[index];
        if (!element) return { ok: false, reason: `DOM path ${path} no longer exists` };
      }
      const normalize = (value?: string | null) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
      const actualTag = element.tagName.toLowerCase();
      if (actualTag !== expected.tag) return { ok: false, reason: `tag changed from ${expected.tag} to ${actualTag}` };
      for (const [label, expectedValue, actualValue] of [
        ['role', expected.role, element.getAttribute('role')],
        ['type', expected.type, element.getAttribute('type')],
        ['aria-label', expected.ariaLabel, element.getAttribute('aria-label')],
        ['placeholder', expected.placeholder, (element as HTMLInputElement).placeholder],
        ['title', expected.title, element.getAttribute('title')],
      ] as Array<[string, string | undefined, string | null | undefined]>) {
        if (normalize(expectedValue) && normalize(expectedValue) !== normalize(actualValue)) {
          return { ok: false, reason: `${label} changed from "${normalize(expectedValue)}" to "${normalize(actualValue) || '[empty]'}"` };
        }
      }
      return { ok: true, reason: '' };
    }, { path: candidate.path, expected: this.candidateIdentityPayload(candidate) }).catch((error) => ({
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }));
  }

  private async resolveCandidateTarget(candidateId: string) {
    const normalized = candidateId.trim().toUpperCase().replace(/^E(?=\d+$)/, '');
    const candidates = this.lastScreenshotCandidates;
    const candidate = candidates.find((item) => item.id.toUpperCase() === normalized);

    if (!candidate) {
      const available = candidates
        .slice(0, 30)
        .map((item) => `${item.id}: ${this.describeCandidate(item)}`)
        .join('\n');
      return {
        error: `Candidate ${candidateId} was not found in the current screenshot snapshot. Candidate clicks are only allowed after a fresh step screenshot. Available candidates:\n${available || '[none]'}`,
      };
    }

    if (candidate.disabled) {
      return { candidate, error: `Candidate ${candidate.id} is disabled: ${this.describeCandidate(candidate)}` };
    }

    if (candidate.framePath) {
      const identity = await this.validateFrameCandidateIdentity(candidate);
      if (!identity.ok) {
        return {
          candidate,
          error: `Candidate ${candidate.id} no longer matches the element shown in the screenshot: ${identity.reason}`,
        };
      }
      const point = this.resolveCapturedCandidatePoint(candidate, `iframe ${candidate.framePath} screenshot`);
      if (!point) {
        return {
          candidate,
          error: `Candidate ${candidate.id} (iframe ${candidate.framePath}) has no valid point in the current screenshot snapshot.`,
        };
      }
      return { candidate, target: point };
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

    const identity = await this.validateMainCandidateIdentity(candidate);
    if (!identity.ok) {
      return {
        candidate,
        error: `Candidate ${candidate.id} no longer matches the element shown in the screenshot: ${identity.reason}`,
      };
    }
    const target = this.resolveCapturedCandidatePoint(candidate, 'screenshot');
    if (!target) {
      return {
        candidate,
        error: `Candidate ${candidate.id} has no valid point in the current screenshot snapshot.`,
      };
    }

    return { candidate, target };
  }

  private getFramePath(frame: Frame) {
    const segments: number[] = [];
    let current: Frame | null = frame;
    while (current && current !== this.activePage.mainFrame()) {
      const parent: Frame | null = current.parentFrame();
      if (!parent) return undefined;
      const index = parent.childFrames().indexOf(current);
      if (index < 0) return undefined;
      segments.unshift(index);
      current = parent;
    }
    return segments.join('.');
  }

  private frameFromPath(pathValue?: string) {
    if (!pathValue) return this.activePage.mainFrame();
    const parts = String(pathValue).split('.').map((item) => Number(String(item).trim()));
    if (parts.some((item) => !Number.isInteger(item) || item < 0)) return undefined;
    let frame: Frame | undefined = this.activePage.mainFrame();
    for (const index of parts) {
      frame = frame.childFrames()[index];
      if (!frame) return undefined;
    }
    return frame;
  }

  private async resolveFrameCandidatePoint(candidate: InteractiveCandidate) {
    const frame = this.frameFromPath(candidate.framePath);
    if (!frame) return this.resolveCapturedCandidatePoint(candidate, 'iframe');
    const box = await frame.frameElement().then((handle) => handle.boundingBox()).catch(() => undefined);
    if (!box) return this.resolveCapturedCandidatePoint(candidate, 'iframe');
    const local = await this.resolveFrameDomPathToClickablePoint(frame, candidate.path);
    if (!local) return this.resolveCapturedCandidatePoint(candidate, 'iframe');
    const x = Math.round(box.x + local.x);
    const y = Math.round(box.y + local.y);
    const viewport = await this.getViewportMetrics().catch(() => ({ width: 0, height: 0, devicePixelRatio: 1 }));
    if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
      return this.resolveCapturedCandidatePoint(candidate, 'iframe');
    }
    return {
      x,
      y,
      descriptor: `iframe ${candidate.framePath} -> ${local.descriptor}`,
      offscreen: local.offscreen,
    };
  }

  private resolveCapturedCandidatePoint(candidate: InteractiveCandidate, descriptor: string) {
    const px = candidate.center?.x;
    const py = candidate.center?.y;
    if (typeof px !== 'number' || typeof py !== 'number') return undefined;
    const viewport = this.lastScreenshotMetrics?.viewport;
    if (viewport && (px < 0 || py < 0 || px >= viewport.width || py >= viewport.height)) return undefined;
    return {
      x: px,
      y: py,
      descriptor: `${descriptor} captured ${this.describeCandidate(candidate)}`,
      offscreen: false,
    };
  }

  private async resolveFrameDomPathToClickablePoint(frame: Frame, pathValue: string) {
    return frame.evaluate((path) => {
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
      const offscreen = rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth;
      return {
        x: Math.min(Math.max(point.x, 0), window.innerWidth - 1),
        y: Math.min(Math.max(point.y, 0), window.innerHeight - 1),
        descriptor: `${tag}${id}${classes}`,
        offscreen,
      };
    }, pathValue).catch(() => undefined);
  }

  private async resolveShadowCandidatePoint(candidate: InteractiveCandidate) {
    const px = candidate.center?.x;
    const py = candidate.center?.y;
    if (typeof px !== 'number' || typeof py !== 'number') return undefined;
    return this.activePage
      .evaluate(({ x, y, expected }) => {
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
        if (tag !== expected.tag) return undefined;
        const normalize = (value?: string | null) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
        if (normalize(expected.role) && normalize(expected.role) !== normalize(element.getAttribute('role'))) return undefined;
        if (normalize(expected.ariaLabel) && normalize(expected.ariaLabel) !== normalize(element.getAttribute('aria-label'))) return undefined;
        if (normalize(expected.title) && normalize(expected.title) !== normalize(element.getAttribute('title'))) return undefined;
        const id = element.id ? `#${element.id}` : '';
        return { x, y, descriptor: `${tag}${id}`, offscreen: false };
      }, { x: px, y: py, expected: this.candidateIdentityPayload(candidate) })
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
        if (['a', 'button', 'input', 'select', 'textarea', 'summary', 'option'].includes(tag)) return true;
        const role = element.getAttribute('role');
        if (role && ['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'checkbox', 'radio', 'switch', 'option'].includes(role)) return true;
        if (element.hasAttribute('onclick')) return true;
        if (recordedEventTypes(element).some((type) => /^(click|dblclick|mousedown|mouseup|pointerdown|pointerup|touchstart|keydown|mouseenter|mouseover|pointerenter|pointerover)$/.test(type))) return true;
        if (hasActionAttribute(element)) return true;
        const tabindex = element.getAttribute('tabindex');
        if (tabindex !== null && tabindex !== '-1') return true;
        const contentEditable = element.getAttribute('contenteditable');
        if (contentEditable !== null && contentEditable.toLowerCase() !== 'false') return true;
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

  private async dispatchFrameDomPathClick(candidate: InteractiveCandidate) {
    const frame = this.frameFromPath(candidate.framePath);
    if (!frame) return undefined;
    return frame.evaluate((path) => {
      const skippedTags = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'head', 'br', 'hr', 'wbr']);
      function aiIsTraversable(element: Element) {
        if (!element || element.nodeType !== 1) return false;
        if (element.closest('#__ai_candidate_overlay__, #__ai_last_click_marker__')) return false;
        return !skippedTags.has(element.tagName.toLowerCase());
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
      return `iframe DOM click ${tag}${id}`;
    }, candidate.path).catch(() => undefined);
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

  private async drawCandidateOverlay(candidates: InteractiveCandidate[], markersOnly = false) {
    const labelLimit = Math.max(10, Number(process.env.SCREENSHOT_ELEMENT_LABEL_LIMIT || process.env.INTERACTIVE_CANDIDATE_LIMIT || 160));
    const visible = candidates.slice(0, labelLimit);
    await this.activePage.evaluate(({ items, markersOnly: hidePageContent }) => {
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
        background: hidePageContent ? '#ffffff' : 'transparent',
      });

      type Point = { x: number; y: number };
      type LabelBox = { left: number; top: number; right: number; bottom: number };
      type TargetBox = LabelBox & { index: number };
      type Leader = { start: Point; end: Point };
      type LabelLayout = LabelBox & {
        external: boolean;
        compact: boolean;
        leader?: Leader;
      };
      const placedLabels: LabelBox[] = [];
      const placedLeaders: Leader[] = [];
      const targetBoxes: TargetBox[] = items
        .map((item, index) => ({ rect: item.rect, index }))
        .filter(({ rect }) => rect && rect.width > 0 && rect.height > 0)
        .map(({ rect, index }) => ({
          index,
          left: Math.max(0, rect.x),
          top: Math.max(0, rect.y),
          right: Math.min(window.innerWidth, rect.x + rect.width),
          bottom: Math.min(window.innerHeight, rect.y + rect.height),
        }));
      function overlaps(a: LabelBox, b: LabelBox) {
        return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      }
      function expanded(box: LabelBox, padding: number) {
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
      function pointInside(box: LabelBox, point: Point) {
        return point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
      }
      function segmentIntersectsBox(segment: Leader, box: LabelBox, padding = 0) {
        const target = expanded(box, padding);
        if (pointInside(target, segment.start) || pointInside(target, segment.end)) return true;
        const dx = segment.end.x - segment.start.x;
        const dy = segment.end.y - segment.start.y;
        let minT = 0;
        let maxT = 1;
        const checks: Array<[number, number]> = [
          [-dx, segment.start.x - target.left],
          [dx, target.right - segment.start.x],
          [-dy, segment.start.y - target.top],
          [dy, target.bottom - segment.start.y],
        ];
        for (const [p, q] of checks) {
          if (Math.abs(p) < 0.0001) {
            if (q < 0) return false;
            continue;
          }
          const ratio = q / p;
          if (p < 0) minT = Math.max(minT, ratio);
          else maxT = Math.min(maxT, ratio);
          if (minT > maxT) return false;
        }
        return true;
      }
      function segmentsIntersect(a: Leader, b: Leader) {
        function orientation(p: Point, q: Point, r: Point) {
          return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
        }
        const o1 = orientation(a.start, a.end, b.start);
        const o2 = orientation(a.start, a.end, b.end);
        const o3 = orientation(b.start, b.end, a.start);
        const o4 = orientation(b.start, b.end, a.end);
        return o1 * o2 < 0 && o3 * o4 < 0;
      }
      function canPlaceLabel(box: LabelBox, avoidTargets: boolean, currentTargetIndex: number) {
        const padded = expanded(box, 1);
        if (placedLabels.some((placed) => overlaps(padded, expanded(placed, 1)))) return false;
        if (placedLeaders.some((leader) => segmentIntersectsBox(leader, padded))) return false;
        if (
          avoidTargets &&
          targetBoxes.some(
            (target) => target.index !== currentTargetIndex && overlaps(padded, expanded(target, 1)),
          )
        ) return false;
        return true;
      }
      function canPlaceExternal(box: LabelBox, leader: Leader, currentTargetIndex: number) {
        if (!canPlaceLabel(box, true, currentTargetIndex)) return false;
        if (
          targetBoxes.some(
            (target) => target.index !== currentTargetIndex && segmentIntersectsBox(leader, target, 1),
          )
        ) return false;
        if (placedLabels.some((placed) => segmentIntersectsBox(leader, placed, 1))) return false;
        if (placedLeaders.some((placed) => segmentsIntersect(leader, placed))) return false;
        return true;
      }
      function isDenseSmallTarget(rect: { x: number; y: number; width: number; height: number }) {
        if (rect.width > 56 || rect.height > 36) return false;
        const current = {
          left: rect.x,
          top: rect.y,
          right: rect.x + rect.width,
          bottom: rect.y + rect.height,
        };
        let nearby = 0;
        for (const target of targetBoxes) {
          const same =
            Math.abs(target.left - current.left) < 0.5 &&
            Math.abs(target.top - current.top) < 0.5 &&
            Math.abs(target.right - current.right) < 0.5 &&
            Math.abs(target.bottom - current.bottom) < 0.5;
          if (same) continue;
          const gapX = Math.max(0, Math.max(target.left - current.right, current.left - target.right));
          const gapY = Math.max(0, Math.max(target.top - current.bottom, current.top - target.bottom));
          if (gapX <= 6 && gapY <= 6) nearby += 1;
          if (nearby >= 2) return true;
        }
        return false;
      }
      function edgePoint(rect: { x: number; y: number; width: number; height: number }, box: LabelBox) {
        const rectCenterX = rect.x + rect.width / 2;
        const rectCenterY = rect.y + rect.height / 2;
        const boxCenterX = (box.left + box.right) / 2;
        const boxCenterY = (box.top + box.bottom) / 2;
        const dx = boxCenterX - rectCenterX;
        const dy = boxCenterY - rectCenterY;
        if (Math.abs(dx / Math.max(1, rect.width)) > Math.abs(dy / Math.max(1, rect.height))) {
          return {
            x: dx >= 0 ? rect.x + rect.width : rect.x,
            y: clamp(boxCenterY, rect.y, rect.y + rect.height),
          };
        }
        return {
          x: clamp(boxCenterX, rect.x, rect.x + rect.width),
          y: dy >= 0 ? rect.y + rect.height : rect.y,
        };
      }
      function labelEdgePoint(rect: { x: number; y: number; width: number; height: number }, box: LabelBox) {
        const rectCenterX = rect.x + rect.width / 2;
        const rectCenterY = rect.y + rect.height / 2;
        const boxCenterX = (box.left + box.right) / 2;
        const boxCenterY = (box.top + box.bottom) / 2;
        const dx = rectCenterX - boxCenterX;
        const dy = rectCenterY - boxCenterY;
        if (Math.abs(dx / Math.max(1, box.right - box.left)) > Math.abs(dy / Math.max(1, box.bottom - box.top))) {
          return {
            x: dx >= 0 ? box.right : box.left,
            y: clamp(rectCenterY, box.top, box.bottom),
          };
        }
        return {
          x: clamp(rectCenterX, box.left, box.right),
          y: dy >= 0 ? box.bottom : box.top,
        };
      }
      function leaderFor(rect: { x: number; y: number; width: number; height: number }, box: LabelBox) {
        const start = edgePoint(rect, box);
        const end = labelEdgePoint(rect, box);
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = Math.max(1, Math.hypot(dx, dy));
        const outsideGap = Math.min(2, length / 2);
        return {
          start: {
            x: start.x + (dx / length) * outsideGap,
            y: start.y + (dy / length) * outsideGap,
          },
          end,
        };
      }
      function externalOptions(
        rect: { x: number; y: number; width: number; height: number },
        labelWidth: number,
        labelHeight: number,
      ) {
        const centerX = rect.x + rect.width / 2;
        const centerY = rect.y + rect.height / 2;
        const distances = [6, 16, 28, 44, 64];
        const options: Array<{ left: number; top: number }> = [];
        for (const gap of distances) {
          options.push(
            { left: rect.x + rect.width + gap, top: centerY - labelHeight / 2 },
            { left: rect.x - labelWidth - gap, top: centerY - labelHeight / 2 },
            { left: centerX - labelWidth / 2, top: rect.y - labelHeight - gap },
            { left: centerX - labelWidth / 2, top: rect.y + rect.height + gap },
          );
        }
        return options;
      }
      function labelPosition(
        rect: { x: number; y: number; width: number; height: number },
        normalLabelWidth: number,
        normalLabelHeight: number,
        compactLabelWidth: number,
        compactLabelHeight: number,
        denseSmall: boolean,
        currentTargetIndex: number,
      ): LabelLayout {
        const safeInset = 6;
        const minLeft = Math.min(safeInset, Math.max(0, window.innerWidth - normalLabelWidth));
        const minTop = Math.min(safeInset, Math.max(0, window.innerHeight - normalLabelHeight));
        const maxLeft = Math.max(minLeft, window.innerWidth - normalLabelWidth - safeInset);
        const maxTop = Math.max(minTop, window.innerHeight - normalLabelHeight - safeInset);
        const centerX = rect.x + rect.width / 2;
        const centerY = rect.y + rect.height / 2;
        const currentTarget = {
          left: Math.max(0, rect.x),
          top: Math.max(0, rect.y),
          right: Math.min(window.innerWidth, rect.x + rect.width),
          bottom: Math.min(window.innerHeight, rect.y + rect.height),
        };
        const currentTargetArea = Math.max(1, (currentTarget.right - currentTarget.left) * (currentTarget.bottom - currentTarget.top));
        const labelArea = normalLabelWidth * normalLabelHeight;
        const preferExternal =
          denseSmall ||
          rect.width < normalLabelWidth + 10 ||
          rect.height < normalLabelHeight + 8 ||
          labelArea / currentTargetArea > 0.16;
        const external = externalOptions(rect, normalLabelWidth, normalLabelHeight);
        const internal = [
          { left: rect.x + rect.width - normalLabelWidth, top: rect.y + rect.height - normalLabelHeight },
          { left: rect.x + rect.width - normalLabelWidth, top: rect.y },
          { left: rect.x, top: rect.y + rect.height - normalLabelHeight },
          { left: rect.x, top: rect.y },
        ];

        if (preferExternal) {
          for (const option of external) {
            if (
              option.left < safeInset ||
              option.top < safeInset ||
              option.left + normalLabelWidth > window.innerWidth - safeInset ||
              option.top + normalLabelHeight > window.innerHeight - safeInset
            ) continue;
            const box = {
              left: option.left,
              top: option.top,
              right: option.left + normalLabelWidth,
              bottom: option.top + normalLabelHeight,
            };
            const leader = leaderFor(rect, box);
            if (canPlaceExternal(box, leader, currentTargetIndex)) {
              placedLabels.push(box);
              placedLeaders.push(leader);
              return { ...box, external: true, compact: false, leader };
            }
          }
        }

        if (!denseSmall) {
          const preferred = preferExternal ? internal : [...internal, ...external];
          for (const option of preferred) {
            const left = clamp(option.left, 0, maxLeft);
            const top = clamp(option.top, 0, maxTop);
            const box = {
              left,
              top,
              right: left + normalLabelWidth,
              bottom: top + normalLabelHeight,
            };
            const labelOverlapsCurrentTarget = overlaps(box, currentTarget);
            if (!labelOverlapsCurrentTarget) {
              const leader = leaderFor(rect, box);
              if (!canPlaceExternal(box, leader, currentTargetIndex)) continue;
              placedLabels.push(box);
              placedLeaders.push(leader);
              return { ...box, external: true, compact: false, leader };
            }
            if (!canPlaceLabel(box, false, currentTargetIndex)) continue;
            placedLabels.push(box);
            return { ...box, external: false, compact: false };
          }
        }

        const compactMinLeft = Math.min(1, Math.max(0, window.innerWidth - compactLabelWidth));
        const compactMinTop = Math.min(1, Math.max(0, window.innerHeight - compactLabelHeight));
        const compactMaxLeft = Math.max(compactMinLeft, window.innerWidth - compactLabelWidth - 1);
        const compactMaxTop = Math.max(compactMinTop, window.innerHeight - compactLabelHeight - 1);
        const compactInternal = [
          { left: rect.x + rect.width - compactLabelWidth - 1, top: rect.y + rect.height - compactLabelHeight - 1 },
          { left: rect.x + rect.width - compactLabelWidth - 1, top: rect.y + 1 },
          { left: rect.x + 1, top: rect.y + rect.height - compactLabelHeight - 1 },
          { left: rect.x + 1, top: rect.y + 1 },
        ];
        for (const option of compactInternal) {
          const left = clamp(option.left, compactMinLeft, compactMaxLeft);
          const top = clamp(option.top, compactMinTop, compactMaxTop);
          const box = {
            left,
            top,
            right: left + compactLabelWidth,
            bottom: top + compactLabelHeight,
          };
          if (canPlaceLabel(box, false, currentTargetIndex)) {
            placedLabels.push(box);
            return { ...box, external: false, compact: true };
          }
        }

        const left = clamp(rect.x + rect.width - compactLabelWidth - 1, compactMinLeft, compactMaxLeft);
        const top = clamp(rect.y + rect.height - compactLabelHeight - 1, compactMinTop, compactMaxTop);
        const finalBox = {
          left,
          top,
          right: left + compactLabelWidth,
          bottom: top + compactLabelHeight,
        };
        placedLabels.push(finalBox);
        return { ...finalBox, external: false, compact: true };
      }
      function drawLeader(leader: Leader, color: string, width = 1) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', String(leader.start.x));
        line.setAttribute('y1', String(leader.start.y));
        line.setAttribute('x2', String(leader.end.x));
        line.setAttribute('y2', String(leader.end.y));
        line.setAttribute('stroke', color);
        line.setAttribute('stroke-width', String(width));
        line.setAttribute('stroke-linecap', 'butt');
        line.setAttribute('vector-effect', 'non-scaling-stroke');
        svg.appendChild(line);
      }

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      Object.assign(svg.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        width: '100%',
        height: '100%',
        overflow: 'visible',
      });
      svg.setAttribute('width', String(window.innerWidth));
      svg.setAttribute('height', String(window.innerHeight));
      overlay.appendChild(svg);

      for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
        const item = items[itemIndex];
        const rect = item.rect;
        if (!rect || rect.width <= 0 || rect.height <= 0) continue;

        const box = document.createElement('div');
        const color = '#2563eb';
        const boxLeft = clamp(rect.x, 1, Math.max(1, window.innerWidth - 2));
        const boxTop = clamp(rect.y, 1, Math.max(1, window.innerHeight - 2));
        const boxWidth = Math.max(1, Math.min(rect.width, window.innerWidth - boxLeft - 1));
        const boxHeight = Math.max(1, Math.min(rect.height, window.innerHeight - boxTop - 1));
        Object.assign(box.style, {
          position: 'absolute',
          left: `${boxLeft}px`,
          top: `${boxTop}px`,
          width: `${boxWidth}px`,
          height: `${boxHeight}px`,
          border: `1px solid ${color}`,
          borderRadius: '3px',
          boxSizing: 'border-box',
          background: 'transparent',
          boxShadow: 'none',
        });

        const label = document.createElement('div');
        label.textContent = item.id;
        const denseSmall = isDenseSmallTarget(rect);
        const normalLabelWidth = Math.max(18, item.id.length * 8 + 7);
        const normalLabelHeight = 16;
        const compactLabelWidth = Math.max(8, Math.min(normalLabelWidth, item.id.length * 4 + 3, Math.max(8, rect.width - 2)));
        const compactLabelHeight = Math.max(7, Math.min(9, Math.max(7, rect.height - 2)));
        const labelBox = labelPosition(
          rect,
          normalLabelWidth,
          normalLabelHeight,
          compactLabelWidth,
          compactLabelHeight,
          denseSmall,
          itemIndex,
        );
        const labelWidth = labelBox.right - labelBox.left;
        const labelHeight = labelBox.bottom - labelBox.top;
        if (labelBox.external && labelBox.leader) {
          drawLeader(labelBox.leader, color, 1);
        }
        Object.assign(label.style, {
          position: 'absolute',
          left: `${labelBox.left}px`,
          top: `${labelBox.top}px`,
          width: `${labelWidth}px`,
          height: `${labelHeight}px`,
          padding: '0',
          boxSizing: 'border-box',
          background: color,
          color: '#fff',
          border: '0',
          borderRadius: labelBox.compact ? '2px' : '999px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          font: labelBox.compact
            ? `900 ${item.id.length >= 3 ? 6 : 7}px/${labelHeight}px Arial, sans-serif`
            : `900 11px/13px Arial, sans-serif`,
          letterSpacing: '0',
          textAlign: 'center',
          boxShadow: labelBox.compact ? 'none' : '0 1px 4px rgba(0,0,0,0.35)',
          textShadow: '0 1px 1px rgba(0,0,0,0.85)',
        });

        overlay.appendChild(box);
        overlay.appendChild(label);
      }

      document.documentElement.appendChild(overlay);
    }, { items: visible, markersOnly }).catch(() => undefined);
  }

  private async removeCandidateOverlay() {
    await this.activePage
      .evaluate(() => {
        document.getElementById('__ai_candidate_overlay__')?.remove();
      })
      .catch(() => undefined);
  }

  // 操作前原图不应包含上一轮注入的点击位置标记。
  private async removeClickMarker() {
    await this.activePage
      .evaluate(() => {
        document.getElementById('__ai_last_click_marker__')?.remove();
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
