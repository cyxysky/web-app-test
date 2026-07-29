import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type BrowserCodeConnection = {
  protocol: 'playwright' | 'cdp';
  endpoint: string;
};

export type BrowserCodeExecutionLog = {
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
  elapsedMs: number;
};

export type BrowserCodeImage = {
  data: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
};

export type BrowserCodeRunResult = {
  ok: boolean;
  value?: unknown;
  error?: string;
  elapsedMs: number;
  logs: BrowserCodeExecutionLog[];
  images?: BrowserCodeImage[];
  selectedExecutionId?: string;
  aborted?: boolean;
};

export type BrowserCodeRisk = {
  requiresConfirmation: boolean;
  reasons: string[];
};

export function browserCodePolicyViolation(code: string) {
  if (/(?:\bforce\b|['"]force['"])\s*:\s*true\b/i.test(code)) {
    return 'browserCode forbids Playwright force: true. Refresh the page snapshot and resolve overlays, loading state, stale locators, or asynchronous redraws instead.';
  }
  if (/\.dispatchEvent\s*\(\s*(?:[^,()]+,\s*)?['"]click['"]/i.test(code)) {
    return 'browserCode forbids dispatchEvent("click") because it bypasses Playwright actionability. Refresh the DOM evidence and use one unique visible Playwright locator.';
  }
  if (/\.evaluate(?:All|Handle)?\s*\([\s\S]{0,300}?=>\s*\{[\s\S]{0,3000}?\.click\s*\(/i.test(code)
    || /\.evaluate(?:All|Handle)?\s*\([\s\S]{0,300}?=>\s*(?!\{)[^;\r\n]{0,1000}?\.click\s*\(/i.test(code)) {
    return 'browserCode forbids DOM element.click() inside evaluate callbacks because it bypasses Playwright actionability. Refresh the DOM evidence and use one unique visible Playwright locator.';
  }
  return undefined;
}

export type BrowserCodeCredentialBinding = {
  ref: string;
  value: string;
  allowedOrigins: string[];
};

export type BrowserCodeExecutionInput = {
  code: string;
  executionId: string;
  maxOutputChars?: number;
  credentials?: BrowserCodeCredentialBinding[];
  abortSignal?: AbortSignal;
};

export type BrowserCodeKernelOptions = {
  executionTimeoutMs?: number;
  readyTimeoutMs?: number;
};

type PendingExecution = {
  abortSignal?: AbortSignal;
  onAbort: () => void;
  requestId: string;
  resolve: (result: BrowserCodeRunResult) => void;
  startedAt: number;
};

const defaultMaxOutputChars = 20_000;
const maxOutputCharsLimit = 50_000;
const maxDiagnosticChars = 4_000;
const defaultBrowserCodeKernelReadyTimeoutMs = 10_000;
const defaultBrowserCodeExecutionTimeoutMs = 90_000;
export const BROWSER_CODE_KERNEL_RUNTIME_REVISION = 2;

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === 'number' ? value : Number(value);
  const normalized = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  return Math.min(max, Math.max(min, normalized));
}

export function analyzeBrowserCodeRisk(code: string): BrowserCodeRisk {
  const reasons: string[] = [];
  const checks: Array<[RegExp, string]> = [
    [/\b(?:submit|publish|send|delete|remove|destroy|approve|authorize|pay|purchase|checkout|order|transfer|upload|download|login|logout)\b/i, '代码包含可能对外产生影响或修改数据的操作'],
    [/(?:提交|发布|发送|删除|移除|确认|批准|授权|支付|购买|下单|转账|上传|下载|登录|退出)/, '代码包含可能对外产生影响或修改数据的操作'],
    [/\b(?:password|passwd|otp|verification\s*code|credit\s*card|bank\s*account|credential|secret|token)\b/i, '代码涉及凭据、验证或敏感信息'],
    [/(?:密码|口令|验证码|信用卡|银行卡|银行账户|凭据|密钥|令牌)/, '代码涉及凭据、验证或敏感信息'],
    [/\.evaluate\s*\([\s\S]{0,3000}\b(?:fetch|XMLHttpRequest|sendBeacon|\.submit\s*\(|\.click\s*\(|localStorage\s*\.\s*setItem|sessionStorage\s*\.\s*setItem)\b/i, '页面代码可能发起请求或修改页面状态'],
  ];
  for (const [pattern, reason] of checks) {
    if (pattern.test(code)) reasons.push(reason);
  }
  return { requiresConfirmation: reasons.length > 0, reasons };
}

function browserCodeKernelMain() {
  const browserCodeActionTimeoutMs = 5_000;
  const browserCodeNavigationTimeoutMs = 30_000;
  const browserCodePointerLookupTimeoutMs = 250;
  const maxBrowserCodeImages = 4;
  const maxBrowserCodeImageBytes = 8 * 1024 * 1024;
  const maxBrowserCodeImageBytesTotal = 20 * 1024 * 1024;
  const childRequire = eval('require') as typeof require;
  const {
    createHash: childCreateHash,
    randomUUID: childRandomUUID,
  } = childRequire('node:crypto') as typeof import('node:crypto');
  const repl = childRequire('node:repl') as typeof import('node:repl');
  const { PassThrough } = childRequire('node:stream') as typeof import('node:stream');
  const { Buffer: ChildBuffer } = childRequire('node:buffer') as typeof import('node:buffer');
  const hostProcess = process;
  type CoordinateClickEvidence = {
    capturedAt: number;
    devicePixelRatio: number;
    documentId: string;
    height: number;
    page: import('playwright').Page;
    revision: number;
    url: string;
    width: number;
  };
  let browser: import('playwright').Browser | undefined;
  let replServer: import('node:repl').REPLServer | undefined;
  let activeExecution: {
    logs: BrowserCodeExecutionLog[];
    images: BrowserCodeImage[];
    imageBytes: number;
    outputs: unknown[];
    startedAt: number;
    credentials: Map<string, BrowserCodeCredentialBinding>;
    pendingCoordinateClickEvidence: Map<import('playwright').Page, CoordinateClickEvidence>;
  } | undefined;
  const screenshotProvenance = new WeakMap<object, CoordinateClickEvidence & { fullPage: boolean }>();
  const screenshotProvenanceByDigest = new Map<string, CoordinateClickEvidence & { fullPage: boolean }>();
  const coordinateClickEvidenceByDocument = new Map<string, CoordinateClickEvidence>();
  let chain = Promise.resolve();

  const imageDigest = (value: Uint8Array) => childCreateHash('sha256').update(value).digest('hex');

  const send = (payload: Record<string, unknown>) => {
    if (typeof hostProcess.send === 'function') hostProcess.send(payload);
  };

  const jsonSafe = (value: unknown, maxOutputChars: number) => {
    const seen = new WeakSet<object>();
    const serialized = JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return String(item);
      if (typeof item === 'function' || typeof item === 'symbol') return undefined;
      if (item instanceof Error) return { name: item.name, message: item.message };
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    });
    if (serialized === undefined) return null;
    if (serialized.length > maxOutputChars) {
      return {
        truncated: true,
        originalChars: serialized.length,
        preview: serialized.slice(0, maxOutputChars),
      };
    }
    return JSON.parse(serialized);
  };

  const safeConsole = Object.freeze(Object.fromEntries((['log', 'info', 'warn', 'error'] as const).map((level) => [
    level,
    (...args: unknown[]) => {
      if (!activeExecution || activeExecution.logs.length >= 100) return;
      const text = args.map((value) => {
        if (typeof value === 'string') return value;
        try { return JSON.stringify(value); } catch { return String(value); }
      }).join(' ');
      activeExecution.logs.push({
        level,
        text: text.slice(0, 4_000),
        elapsedMs: Date.now() - activeExecution.startedAt,
      });
    },
  ])));

  const nodeRepl = Object.freeze({
    write(value: unknown) {
      if (!activeExecution) throw new Error('nodeRepl.write() is only available while browserCode is executing.');
      activeExecution.outputs.push(value);
    },
    async emitImage(value: unknown, options: { mimeType?: BrowserCodeImage['mimeType'] } = {}) {
      if (!activeExecution) throw new Error('nodeRepl.emitImage() is only available while browserCode is executing.');
      if (activeExecution.images.length >= maxBrowserCodeImages) {
        throw new Error(`browserCode can emit at most ${maxBrowserCodeImages} images per cell.`);
      }
      let mimeType = options.mimeType || 'image/png';
      let buffer: Buffer;
      if (typeof value === 'string') {
        const dataUrl = /^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/i.exec(value.trim());
        if (!dataUrl) throw new Error('nodeRepl.emitImage() string input must be a base64 image data URL.');
        mimeType = dataUrl[1].toLowerCase() as BrowserCodeImage['mimeType'];
        buffer = ChildBuffer.from(dataUrl[2], 'base64');
      } else if (ChildBuffer.isBuffer(value) || value instanceof Uint8Array) {
        buffer = ChildBuffer.from(value);
      } else {
        throw new Error('nodeRepl.emitImage() expects a Buffer, Uint8Array, or base64 image data URL.');
      }
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
        throw new Error(`nodeRepl.emitImage() does not support ${mimeType}.`);
      }
      if (!buffer.length || buffer.length > maxBrowserCodeImageBytes) {
        throw new Error(`browserCode image must contain 1-${maxBrowserCodeImageBytes} bytes.`);
      }
      if (activeExecution.imageBytes + buffer.length > maxBrowserCodeImageBytesTotal) {
        throw new Error(`browserCode emitted images exceed ${maxBrowserCodeImageBytesTotal} total bytes.`);
      }
      activeExecution.imageBytes += buffer.length;
      activeExecution.images.push({ data: buffer.toString('base64'), mimeType });
      if (value && typeof value === 'object') {
        const digest = imageDigest(buffer);
        const provenance = screenshotProvenance.get(value) || screenshotProvenanceByDigest.get(digest);
        screenshotProvenanceByDigest.delete(digest);
        if (provenance && !provenance.fullPage) {
          activeExecution.pendingCoordinateClickEvidence.set(provenance.page, provenance);
        }
      }
      return { bytes: buffer.length, index: activeExecution.images.length - 1, mimeType };
    },
  });

  const tabIds = new WeakMap<import('playwright').Page, string>();
  const tabPages = new WeakMap<object, import('playwright').Page>();
  const tabWrappers = new WeakMap<import('playwright').Page, object>();
  const agentCreatedPages = new Set<import('playwright').Page>();
  const nativeContextNewPages = new WeakMap<import('playwright').BrowserContext, () => Promise<import('playwright').Page>>();
  const pointerDecoratedPages = new WeakSet<import('playwright').Page>();
  const screenshotDecoratedPagePrototypes = new WeakSet<object>();
  const pointerDecoratedLocatorPrototypes = new WeakSet<object>();
  const credentialLocatorPrototypes = new WeakSet<object>();
  let nativeFrameLocator: ((this: object, selector: string) => import('playwright').Locator) | undefined;
  let nativeLocatorFill: ((this: object, value: string) => Promise<void>) | undefined;

  const actionArgsWithMinimumTimeout = (args: unknown[], optionsIndex: number) => {
    const options = args[optionsIndex];
    if (!options || typeof options !== 'object' || Array.isArray(options)) return args;
    const timeout = Number(Reflect.get(options, 'timeout'));
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout >= browserCodeActionTimeoutMs) return args;
    const normalized = [...args];
    normalized[optionsIndex] = { ...options, timeout: browserCodeActionTimeoutMs };
    return normalized;
  };

  const createSessionPage = async (targetContext: import('playwright').BrowserContext) => {
    const nativeNewPage = nativeContextNewPages.get(targetContext) || targetContext.newPage.bind(targetContext);
    const openerPage = replServer?.context.page as import('playwright').Page | undefined;
    if (!openerPage || openerPage.isClosed() || openerPage.context() !== targetContext) return nativeNewPage();
    const [popupPage] = await Promise.all([
      targetContext.waitForEvent('page', {
        predicate: async (candidatePage) => await candidatePage.opener().catch(() => undefined) === openerPage,
        timeout: browserCodeNavigationTimeoutMs,
      }),
      openerPage.evaluate(() => {
        if (!window.open('about:blank', '_blank')) throw new Error('The browser blocked the new tab.');
      }),
    ]);
    return popupPage;
  };

  const decorateContextNewPage = (browserContext: import('playwright').BrowserContext) => {
    if (nativeContextNewPages.has(browserContext)) return;
    nativeContextNewPages.set(browserContext, browserContext.newPage.bind(browserContext));
    try {
      Object.defineProperty(browserContext, 'newPage', {
        configurable: true,
        value: () => createSessionPage(browserContext),
        writable: true,
      });
    } catch {
      // browser.tabs.new still uses createSessionPage when the context object is immutable.
    }
  };

  const moveVisibleAiPointer = async (
    page: import('playwright').Page,
    point: { x: number; y: number } | undefined,
    kind = 'move',
  ) => {
    if (!activeExecution || !point || page.isClosed()) return;
    await page.evaluate(({ x, y, pointerKind }) => {
      const browserWindow = window as Window & {
        __aiMoveMouseCursor?: (cursorX: number, cursorY: number, options?: { kind?: string }) => void;
      };
      browserWindow.__aiMoveMouseCursor?.(x, y, { kind: pointerKind });
    }, { x: point.x, y: point.y, pointerKind: kind }).catch(() => undefined);
  };

  const locatorPage = (locator: object) => {
    const frame = Reflect.get(locator, '_frame') as { _page?: import('playwright').Page; page?: () => import('playwright').Page } | undefined;
    if (typeof frame?.page === 'function') return frame.page();
    return frame?._page;
  };

  const locatorCenter = async (locator: object) => {
    const candidate = locator as {
      evaluate?: <T>(
        callback: (element: Element) => T,
        argument?: unknown,
        options?: { timeout?: number },
      ) => Promise<T>;
    };
    return candidate.evaluate?.((element) => {
      element.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return undefined;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, undefined, { timeout: browserCodePointerLookupTimeoutMs }).catch(() => undefined);
  };

  const captureCoordinateClickState = async (
    page: import('playwright').Page,
  ): Promise<CoordinateClickEvidence | undefined> => {
    if (page.isClosed()) return undefined;
    const state = await page.evaluate<{
      devicePixelRatio: number;
      documentId: string;
      height: number;
      revision: number;
      url: string;
      width: number;
    }>(`(() => {
      const browserWindow = window;
      if (!browserWindow.__aiCoordinateEvidenceObserver) {
        browserWindow.__aiCoordinateEvidenceDocumentId = Date.now() + '-' + Math.random();
        browserWindow.__aiCoordinateEvidenceRevision = 0;
        const overlaySelector = '#__ai_candidate_overlay__, #__ai_mouse_cursor__, #__ai_dom_export_control__';
        const belongsToRuntimeOverlay = function (node) {
          const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
          return Boolean(element && (element.matches(overlaySelector) || element.closest(overlaySelector)));
        };
        browserWindow.__aiCoordinateEvidenceObserver = new MutationObserver(function (records) {
          const hasPageMutation = records.some(function (record) {
            if (record.type !== 'childList') return !belongsToRuntimeOverlay(record.target);
            const changedNodes = Array.from(record.addedNodes).concat(Array.from(record.removedNodes));
            return changedNodes.length
              ? changedNodes.some(function (node) { return !belongsToRuntimeOverlay(node); })
              : !belongsToRuntimeOverlay(record.target);
          });
          if (hasPageMutation) {
            browserWindow.__aiCoordinateEvidenceRevision = (browserWindow.__aiCoordinateEvidenceRevision || 0) + 1;
          }
        });
        browserWindow.__aiCoordinateEvidenceObserver.observe(document.documentElement, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        });
      }
      return {
        devicePixelRatio: window.devicePixelRatio,
        documentId: browserWindow.__aiCoordinateEvidenceDocumentId || '',
        height: window.innerHeight,
        revision: browserWindow.__aiCoordinateEvidenceRevision || 0,
        url: window.location.href,
        width: window.innerWidth,
      };
    })()`).catch(() => undefined);
    return state ? { ...state, capturedAt: Date.now(), page } : undefined;
  };

  const sameCoordinateClickState = (
    evidence: CoordinateClickEvidence,
    current: CoordinateClickEvidence | undefined,
  ) => Boolean(
    current
    && evidence.url === current.url
    && evidence.documentId === current.documentId
    && evidence.width === current.width
    && evidence.height === current.height
    && evidence.devicePixelRatio === current.devicePixelRatio
    && evidence.revision === current.revision
  );

  const consumeCoordinateClickEvidence = async (page: import('playwright').Page) => {
    const current = await captureCoordinateClickState(page);
    const evidence = current
      ? coordinateClickEvidenceByDocument.get(current.documentId)
      : undefined;
    if (!evidence || !current) {
      throw new Error('Coordinate clicking requires a viewport screenshot emitted by the previous browserCode cell and reviewed by the model before this cell.');
    }
    coordinateClickEvidenceByDocument.delete(current.documentId);
    if (Date.now() - evidence.capturedAt > 5 * 60_000 || !sameCoordinateClickState(evidence, current)) {
      throw new Error('The previously emitted viewport screenshot is stale because the page URL, viewport, or DOM changed. Emit and review a new screenshot in a separate browserCode cell.');
    }
  };

  const decoratePageScreenshotPrototype = (page: import('playwright').Page) => {
    const prototype = Object.getPrototypeOf(page) as Record<string, unknown> | null;
    if (!prototype || screenshotDecoratedPagePrototypes.has(prototype)) return;
    const nativeScreenshot = Reflect.get(prototype, 'screenshot');
    if (typeof nativeScreenshot !== 'function') return;
    try {
      Object.defineProperty(prototype, 'screenshot', {
        configurable: true,
        value: async function trackedPageScreenshot(
          this: import('playwright').Page,
          ...args: unknown[]
        ) {
          await captureCoordinateClickState(this);
          const image = await Reflect.apply(nativeScreenshot, this, args);
          const after = await captureCoordinateClickState(this);
          if (image && typeof image === 'object' && after) {
            const options = args[0] && typeof args[0] === 'object'
              ? args[0] as { fullPage?: boolean }
              : undefined;
            const provenance = {
              ...after,
              capturedAt: Date.now(),
              fullPage: options?.fullPage === true,
            };
            screenshotProvenance.set(image, provenance);
            if (ChildBuffer.isBuffer(image) || image instanceof Uint8Array) {
              screenshotProvenanceByDigest.set(imageDigest(ChildBuffer.from(image)), provenance);
              while (screenshotProvenanceByDigest.size > 20) {
                const oldestDigest = screenshotProvenanceByDigest.keys().next().value;
                if (typeof oldestDigest !== 'string') break;
                screenshotProvenanceByDigest.delete(oldestDigest);
              }
            }
          }
          return image;
        },
        writable: true,
      });
      screenshotDecoratedPagePrototypes.add(prototype);
    } catch {
      // Keep the native screenshot implementation when the Playwright prototype is immutable.
    }
  };

  const credentialVault = Object.freeze({
    async fill(locator: unknown, credentialRef: unknown) {
      if (!activeExecution) {
        throw new Error('credentialVault.fill() is only available while browserCode is executing.');
      }
      const ref = typeof credentialRef === 'string' ? credentialRef.trim() : '';
      const credential = ref ? activeExecution.credentials.get(ref) : undefined;
      if (!credential) {
        throw new Error('The requested credential reference is unavailable for this browserCode execution.');
      }
      if (!locator || typeof locator !== 'object') {
        throw new Error('credentialVault.fill() requires a real Playwright Locator as its first argument.');
      }
      const locatorPrototype = Object.getPrototypeOf(locator) as object | null;
      const targetFrame = Reflect.get(locator, '_frame') as import('playwright').Frame | undefined;
      const selector = Reflect.get(locator, '_selector');
      const targetPage = targetFrame
        ? currentPages().find((candidatePage) => candidatePage.frames().includes(targetFrame))
        : undefined;
      if (
        !locatorPrototype
        || !credentialLocatorPrototypes.has(locatorPrototype)
        || typeof selector !== 'string'
        || !targetFrame
        || !targetPage
        || targetPage.isClosed()
      ) {
        throw new Error('credentialVault.fill() requires a Locator from the active browser session.');
      }
      let origin = '';
      try {
        const currentUrl = new URL(targetPage.url());
        if (!['http:', 'https:'].includes(currentUrl.protocol)) throw new Error('unsupported protocol');
        origin = currentUrl.origin;
      } catch {
        throw new Error('credentialVault.fill() requires the target page to have an http(s) origin.');
      }
      if (!credential.allowedOrigins.includes(origin)) {
        throw new Error(`The requested credential reference is not allowed for ${origin}.`);
      }
      if (!nativeFrameLocator || !nativeLocatorFill) {
        throw new Error('credentialVault.fill() could not access the trusted Playwright locator implementation.');
      }
      const trustedLocator = Reflect.apply(nativeFrameLocator, targetFrame, [selector]);
      await Reflect.apply(nativeLocatorFill, trustedLocator, [credential.value]);
      return { filled: true, origin };
    },
  });

  const decorateLocatorPrototype = (page: import('playwright').Page) => {
    const prototype = Object.getPrototypeOf(page.locator('html')) as Record<string, unknown> | null;
    if (!prototype || pointerDecoratedLocatorPrototypes.has(prototype)) return;
    credentialLocatorPrototypes.add(prototype);
    const framePrototype = Object.getPrototypeOf(page.mainFrame()) as Record<string, unknown> | null;
    const frameLocator = framePrototype && Reflect.get(framePrototype, 'locator');
    const locatorFill = Reflect.get(prototype, 'fill');
    if (!nativeFrameLocator && typeof frameLocator === 'function') {
      nativeFrameLocator = frameLocator as (this: object, selector: string) => import('playwright').Locator;
    }
    if (!nativeLocatorFill && typeof locatorFill === 'function') {
      nativeLocatorFill = locatorFill as (this: object, value: string) => Promise<void>;
    }
    pointerDecoratedLocatorPrototypes.add(prototype);
    const patch = (name: string, kind: 'click' | 'double' | 'move') => {
      const original = Reflect.get(prototype, name);
      if (typeof original !== 'function') return;
      try {
        Object.defineProperty(prototype, name, {
          configurable: true,
          value: async function pointerVisualizedLocatorAction(this: object, ...args: unknown[]) {
            if (args.some((arg) => arg && typeof arg === 'object' && Reflect.get(arg, 'force') === true)) {
              throw new Error('browserCode forbids Playwright force: true. Inspect the fresh page snapshot and resolve the blocking page state.');
            }
            const normalizedArgs = actionArgsWithMinimumTimeout(args, name === 'dragTo' ? 1 : 0);
            const targetPage = locatorPage(this);
            if (targetPage && activeExecution) {
              await moveVisibleAiPointer(targetPage, await locatorCenter(this), kind);
              if (name === 'dragTo' && normalizedArgs[0] && typeof normalizedArgs[0] === 'object') {
                await moveVisibleAiPointer(targetPage, await locatorCenter(normalizedArgs[0]), 'move');
              }
            }
            return Reflect.apply(original, this, normalizedArgs);
          },
          writable: true,
        });
      } catch {
        // A future Playwright build may make this prototype immutable. Direct
        // page.mouse actions remain visualized even when a locator cannot be decorated.
      }
    };
    patch('click', 'click');
    patch('dblclick', 'double');
    patch('hover', 'move');
    patch('check', 'click');
    patch('uncheck', 'click');
    patch('setChecked', 'click');
    patch('tap', 'click');
    patch('dragTo', 'click');
  };

  const decoratePage = (page: import('playwright').Page) => {
    if (pointerDecoratedPages.has(page)) return;
    pointerDecoratedPages.add(page);
    decorateLocatorPrototype(page);
    decoratePageScreenshotPrototype(page);
    const pageRecord = page as unknown as Record<string, unknown>;
    const patchPageAction = (name: string, kind: 'click' | 'double' | 'move') => {
      const original = Reflect.get(pageRecord, name);
      if (typeof original !== 'function') return;
      try {
        Object.defineProperty(pageRecord, name, {
          configurable: true,
          value: async (...args: unknown[]) => {
            if (args.some((arg) => arg && typeof arg === 'object' && Reflect.get(arg, 'force') === true)) {
              throw new Error('browserCode forbids Playwright force: true. Inspect the fresh page snapshot and resolve the blocking page state.');
            }
            const normalizedArgs = actionArgsWithMinimumTimeout(args, 1);
            if (activeExecution && typeof normalizedArgs[0] === 'string') {
              await moveVisibleAiPointer(page, await locatorCenter(page.locator(normalizedArgs[0])), kind);
            }
            return Reflect.apply(original, page, normalizedArgs);
          },
          writable: true,
        });
      } catch {
        // Keep the native Playwright method when the page object is immutable.
      }
    };
    patchPageAction('click', 'click');
    patchPageAction('dblclick', 'double');
    patchPageAction('hover', 'move');
    patchPageAction('check', 'click');
    patchPageAction('uncheck', 'click');
    patchPageAction('tap', 'click');

    const mouse = page.mouse as unknown as Record<string, unknown>;
    const nativeMove = Reflect.get(mouse, 'move');
    if (typeof nativeMove === 'function') {
      try {
        Object.defineProperty(mouse, 'move', {
          configurable: true,
          value: async (x: number, y: number, options?: unknown) => {
            await moveVisibleAiPointer(page, { x, y }, 'move');
            return Reflect.apply(nativeMove, page.mouse, [x, y, options]);
          },
          writable: true,
        });
      } catch {
        // Keep the native mouse implementation when it cannot be decorated.
      }
    }
    const nativeClick = Reflect.get(mouse, 'click');
    if (typeof nativeClick === 'function') {
      try {
        Object.defineProperty(mouse, 'click', {
          configurable: true,
          value: async (x: number, y: number, options?: { button?: string; clickCount?: number }) => {
            await consumeCoordinateClickEvidence(page);
            const kind = options?.button === 'right' ? 'right' : (options?.clickCount || 1) > 1 ? 'double' : 'click';
            await moveVisibleAiPointer(page, { x, y }, kind);
            return Reflect.apply(nativeClick, page.mouse, [x, y, options]);
          },
          writable: true,
        });
      } catch {
        // Keep the native mouse implementation when it cannot be decorated.
      }
    }
  };

  const tabId = (page: import('playwright').Page) => {
    const existing = tabIds.get(page);
    if (existing) return existing;
    const id = childRandomUUID();
    tabIds.set(page, id);
    return id;
  };

  const selectPage = (page: import('playwright').Page) => {
    if (!replServer) throw new Error('browserCode JavaScript kernel is not initialized.');
    if (page.isClosed()) throw new Error('Cannot select a closed browser tab.');
    decoratePage(page);
    replServer.context.page = page;
    replServer.context.context = page.context();
    replServer.context.tab = tabForPage(page);
    return page;
  };

  const pageFromTab = (value: unknown) => {
    if (value && typeof value === 'object') {
      const direct = tabPages.get(value);
      if (direct) return direct;
      const candidate = value as import('playwright').Page;
      if (typeof candidate.url === 'function' && typeof candidate.context === 'function') return candidate;
      const id = typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : '';
      if (id && browser) {
        return browser.contexts().flatMap((candidateContext) => candidateContext.pages())
          .find((candidatePage) => tabId(candidatePage) === id);
      }
    }
    if (typeof value === 'string' && browser) {
      return browser.contexts().flatMap((candidateContext) => candidateContext.pages())
        .find((candidatePage) => tabId(candidatePage) === value);
    }
    return undefined;
  };

  function tabForPage(page: import('playwright').Page) {
    decoratePage(page);
    const existing = tabWrappers.get(page);
    if (existing) return existing;
    const extendedPage = page as import('playwright').Page & {
      domSnapshot?: () => Promise<string>;
      expectNavigation?: <T>(action: () => Promise<T>, options?: { timeoutMs?: number; url?: string | RegExp; waitUntil?: NonNullable<Parameters<import('playwright').Page['waitForURL']>[1]>['waitUntil'] }) => Promise<T>;
    };
    if (typeof extendedPage.domSnapshot !== 'function') {
      Object.defineProperty(extendedPage, 'domSnapshot', {
        configurable: false,
        enumerable: false,
        value: () => page.locator('body').ariaSnapshot({ timeout: browserCodeActionTimeoutMs }),
        writable: false,
      });
    }
    if (typeof extendedPage.expectNavigation !== 'function') {
      Object.defineProperty(extendedPage, 'expectNavigation', {
        configurable: false,
        enumerable: false,
        value: async <T>(action: () => Promise<T>, options: { timeoutMs?: number; url?: string | RegExp; waitUntil?: NonNullable<Parameters<import('playwright').Page['waitForURL']>[1]>['waitUntil'] } = {}) => {
          const navigation = options.url
            ? page.waitForURL(options.url, { timeout: options.timeoutMs, waitUntil: options.waitUntil })
            : page.waitForNavigation({ timeout: options.timeoutMs, waitUntil: options.waitUntil });
          const [actionResult] = await Promise.all([action(), navigation]);
          return actionResult;
        },
        writable: false,
      });
    }
    const cua = Object.freeze({
      click: async (input: { button?: 'left' | 'middle' | 'right'; clickCount?: number; x: number; y: number }) => {
        await page.mouse.click(input.x, input.y, { button: input.button, clickCount: input.clickCount });
      },
      keypress: async (input: { keys: string[] | string }) => {
        const keys = Array.isArray(input.keys) ? input.keys : [input.keys];
        for (const key of keys) await page.keyboard.press(key);
      },
      move: async (input: { steps?: number; x: number; y: number }) => {
        await page.mouse.move(input.x, input.y, { steps: input.steps });
      },
      type: async (input: { text: string }) => page.keyboard.type(input.text),
      wheel: async (input: { deltaX?: number; deltaY?: number }) => page.mouse.wheel(input.deltaX || 0, input.deltaY || 0),
    });
    const wrapper = Object.freeze({
      id: tabId(page),
      playwright: page,
      cua,
      close: () => page.close(),
      goto: (url: string, options?: Parameters<import('playwright').Page['goto']>[1]) => page.goto(url, options),
      screenshot: (options: Parameters<import('playwright').Page['screenshot']>[0] = {}) => page.screenshot(options),
      title: () => page.title(),
      url: () => page.url(),
      use: () => selectPage(page),
    });
    tabPages.set(wrapper, page);
    tabWrappers.set(page, wrapper);
    return wrapper;
  }

  const tabInfo = async (page: import('playwright').Page) => ({
    id: tabId(page),
    lastOpened: Date.now(),
    title: await page.title().catch(() => ''),
    url: page.url(),
  });

  const currentPages = () => browser
    ? browser.contexts().flatMap((candidateContext) => candidateContext.pages()).filter((candidatePage) => !candidatePage.isClosed())
    : [];

  const browserRuntime = Object.freeze({
    capabilities: Object.freeze({ cua: true, images: true, playwright: true, tabLifecycle: true }),
    documentation: async () => [
      'browserCode exposes one controlled browser runtime in ordinary JavaScript.',
      'Use browser.tabs.list()/new()/finalize(), browser.user.openTabs()/claimTab(), tab.playwright, tab.cua, page.domSnapshot(), page.expectNavigation(), and nodeRepl.emitImage().',
      `Playwright action timeout: ${browserCodeActionTimeoutMs}ms; navigation timeout: ${browserCodeNavigationTimeoutMs}ms.`,
    ].join('\n'),
    id: 'current',
    name: 'Current browser session',
    nameSession: async (name: string) => { void name; },
    tabs: Object.freeze({
      finalize: async (input: { keep?: Array<{ status: 'deliverable' | 'handoff'; tab: unknown }> } = {}) => {
        const keepPages = new Set((input.keep || []).map((item) => pageFromTab(item.tab)).filter(Boolean));
        const closing = [...agentCreatedPages].filter((candidatePage) => !candidatePage.isClosed() && !keepPages.has(candidatePage));
        await Promise.all(closing.map((candidatePage) => candidatePage.close().catch(() => undefined)));
        for (const candidatePage of [...agentCreatedPages]) {
          if (candidatePage.isClosed() || keepPages.has(candidatePage)) agentCreatedPages.delete(candidatePage);
        }
        return Promise.all([...keepPages].filter(Boolean).map((candidatePage) => tabInfo(candidatePage!)));
      },
      list: async () => currentPages().map(tabForPage),
      new: async (options: { url?: string } = {}) => {
        const selected = replServer?.context.context as import('playwright').BrowserContext | undefined;
        const targetContext = selected || browser?.contexts()[0];
        if (!targetContext) throw new Error('No browser context is available.');
        const newPage = await createSessionPage(targetContext);
        agentCreatedPages.add(newPage);
        selectPage(newPage);
        if (options.url) await newPage.goto(options.url);
        return tabForPage(newPage);
      },
    }),
    type: 'playwright',
    user: Object.freeze({
      claimTab: async (value: unknown) => {
        const currentPage = replServer?.context.page as import('playwright').Page | undefined;
        const claimedPage = value === undefined || value === null
          ? currentPage && !currentPage.isClosed() ? currentPage : currentPages().at(-1)
          : pageFromTab(value);
        if (!claimedPage) throw new Error('The requested browser tab is no longer available.');
        selectPage(claimedPage);
        return tabForPage(claimedPage);
      },
      openTabs: async () => Promise.all(currentPages().map(tabInfo)),
    }),
  });

  const agentRuntime = Object.freeze({
    browsers: Object.freeze({
      get: async (id: string) => {
        if (id !== browserRuntime.id && id !== 'default') throw new Error(`Unknown browser runtime: ${id}`);
        return browserRuntime;
      },
      getDefault: async () => browserRuntime,
      list: async () => [browserRuntime],
    }),
  });

  const evaluateCell = (code: string) => new Promise<unknown>((resolve, reject) => {
    if (!replServer) {
      reject(new Error('browserCode JavaScript kernel is not initialized.'));
      return;
    }
    const errorKey = `__browserCodeCellError_${childRandomUUID().replace(/-/g, '')}`;
    const wrappedCode = [
      `globalThis[${JSON.stringify(errorKey)}] = undefined;`,
      'try {',
      code,
      `\n} catch (__browserCodeCellError) { globalThis[${JSON.stringify(errorKey)}] = __browserCodeCellError; }`,
    ].join('\n');
    replServer.eval(wrappedCode, replServer.context, 'browserCode.js', (error, value) => {
      const cellError = replServer?.context[errorKey];
      if (replServer) delete replServer.context[errorKey];
      if (error) reject(error);
      else if (cellError) reject(cellError);
      else resolve(value);
    });
  });

  const initialize = async (input: { connection: BrowserCodeConnection }) => {
    if (browser || replServer) return;
    const { chromium } = childRequire('playwright') as typeof import('playwright');
    browser = input.connection.protocol === 'cdp'
      ? await chromium.connectOverCDP(input.connection.endpoint)
      : await chromium.connect(input.connection.endpoint);
    for (const candidateContext of browser.contexts()) {
      candidateContext.on('page', decoratePage);
      for (const candidatePage of candidateContext.pages()) decoratePage(candidatePage);
    }

    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.resume();
    replServer = repl.start({
      input: inputStream,
      output: outputStream,
      prompt: '',
      terminal: false,
      useGlobal: false,
    });
    Object.defineProperties(replServer.context, {
      Buffer: { configurable: false, enumerable: false, value: undefined, writable: false },
      console: { configurable: false, enumerable: true, value: safeConsole, writable: false },
      global: { configurable: false, enumerable: false, value: undefined, writable: false },
      module: { configurable: false, enumerable: false, value: undefined, writable: false },
      nodeRepl: { configurable: false, enumerable: true, value: nodeRepl, writable: false },
      credentialVault: { configurable: false, enumerable: true, value: credentialVault, writable: false },
      agent: { configurable: false, enumerable: true, value: agentRuntime, writable: false },
      browser: { configurable: false, enumerable: true, value: browserRuntime, writable: false },
      process: { configurable: false, enumerable: false, value: undefined, writable: false },
      require: { configurable: false, enumerable: false, value: undefined, writable: false },
    });
    send({ type: 'ready' });
  };

  const findExecutionPage = async (executionId: string) => {
    if (!browser) throw new Error('browserCode browser connection is not initialized.');
    for (const candidate of browser.contexts().flatMap((browserContext) => browserContext.pages())) {
      const matches = await candidate.evaluate((id) => {
        const win = window as Window & { __aiBrowserCodeExecutionId?: string };
        return win.__aiBrowserCodeExecutionId === id;
      }, executionId).catch(() => false);
      if (matches) return candidate;
    }
    throw new Error('browserCode could not find the active Playwright page.');
  };

  const execute = async (input: {
    code: string;
    credentials?: BrowserCodeCredentialBinding[];
    executionId: string;
    maxOutputChars: number;
    requestId: string;
  }) => {
    if (!replServer) throw new Error('browserCode JavaScript kernel is not initialized.');
    const page = await findExecutionPage(input.executionId);
    const browserContext = page.context();
    decorateContextNewPage(browserContext);
    browserContext.setDefaultTimeout(browserCodeActionTimeoutMs);
    browserContext.setDefaultNavigationTimeout(browserCodeNavigationTimeoutMs);
    for (const contextPage of browserContext.pages()) {
      decoratePage(contextPage);
      contextPage.setDefaultTimeout(browserCodeActionTimeoutMs);
      contextPage.setDefaultNavigationTimeout(browserCodeNavigationTimeoutMs);
    }
    replServer.context.page = page;
    replServer.context.context = browserContext;
    replServer.context.tab = tabForPage(page);
    activeExecution = {
      imageBytes: 0,
      images: [],
      logs: [],
      outputs: [],
      startedAt: Date.now(),
      credentials: new Map((input.credentials || []).map((credential) => [credential.ref, credential])),
      pendingCoordinateClickEvidence: new Map(),
    };
    const publishPendingCoordinateClickEvidence = async () => {
      if (!activeExecution) return;
      for (const evidence of activeExecution.pendingCoordinateClickEvidence.values()) {
        coordinateClickEvidenceByDocument.delete(evidence.documentId);
        coordinateClickEvidenceByDocument.set(evidence.documentId, evidence);
        while (coordinateClickEvidenceByDocument.size > 20) {
          const oldestDocumentId = coordinateClickEvidenceByDocument.keys().next().value;
          if (typeof oldestDocumentId !== 'string') break;
          coordinateClickEvidenceByDocument.delete(oldestDocumentId);
        }
      }
    };

    try {
      await evaluateCell(String(input.code));
      await publishPendingCoordinateClickEvidence();
      const outputs = activeExecution.outputs;
      const images = activeExecution.images;
      const logs = activeExecution.logs;
      const selectedPage = replServer.context.page as import('playwright').Page | undefined;
      let selectedExecutionId: string | undefined;
      if (selectedPage && typeof selectedPage.evaluate === 'function' && !selectedPage.isClosed()) {
        selectedExecutionId = childRandomUUID();
        await selectedPage.evaluate((id) => {
          Object.defineProperty(window, '__aiBrowserCodeSelectedExecutionId', {
            configurable: true,
            enumerable: false,
            value: id,
            writable: false,
          });
        }, selectedExecutionId).catch(() => {
          selectedExecutionId = undefined;
        });
      }
      const value = outputs.length === 0 ? null : outputs.length === 1 ? outputs[0] : outputs;
      send({
        type: 'result',
        requestId: input.requestId,
        ok: true,
        value: jsonSafe(value, input.maxOutputChars),
        logs,
        images,
        selectedExecutionId,
      });
    } catch (error: unknown) {
      await publishPendingCoordinateClickEvidence();
      send({
        type: 'result',
        requestId: input.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        images: activeExecution.images,
        logs: activeExecution.logs,
      });
    } finally {
      activeExecution = undefined;
    }
  };

  hostProcess.on('message', (rawInput: unknown) => {
    if (!rawInput || typeof rawInput !== 'object') return;
    const input = rawInput as Record<string, unknown>;
    chain = chain.then(async () => {
      if (input.type === 'init') {
        await initialize(input as { connection: BrowserCodeConnection });
        return;
      }
      if (input.type === 'execute') {
        await execute(input as {
          code: string;
          credentials?: BrowserCodeCredentialBinding[];
          executionId: string;
          maxOutputChars: number;
          requestId: string;
        });
      }
    }).catch((error: unknown) => {
      if (input.type === 'init') {
        send({
          type: 'init-error',
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      send({
        type: 'result',
        requestId: typeof input.requestId === 'string' ? input.requestId : '',
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        logs: activeExecution?.logs || [],
      });
      activeExecution = undefined;
    });
  });
  hostProcess.on('disconnect', () => hostProcess.exit(0));
}

function childSource() {
  return `const __name = (target) => target;\n(${browserCodeKernelMain.toString()})();`;
}

function browserCodeModuleReadRoots() {
  const roots = [path.resolve(process.cwd(), 'node_modules')];
  for (const entry of String(process.env.NODE_PATH || '').split(path.delimiter)) {
    if (entry.trim()) roots.push(path.resolve(entry.trim()));
  }
  return Array.from(new Set(roots));
}

function browserCodeChildArgs(tempDir: string) {
  return [
    '--permission',
    '--experimental-vm-modules',
    ...browserCodeModuleReadRoots().map((root) => `--allow-fs-read=${root}`),
    `--allow-fs-read=${tempDir}`,
    `--allow-fs-write=${tempDir}`,
    '--max-old-space-size=128',
    '--max-semi-space-size=32',
    '--stack-size=4096',
    '-',
  ];
}

function browserCodeChildEnv(tempDir: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    ['SystemRoot', 'WINDIR', 'HOME', 'ELECTRON_RUN_AS_NODE']
      .flatMap((name) => process.env[name] ? [[name, process.env[name] as string]] : []),
  );
  return {
    ...env,
    NODE_ENV: 'production',
    NODE_PATH: browserCodeModuleReadRoots().join(path.delimiter),
    TEMP: tempDir,
    TMP: tempDir,
    TMPDIR: tempDir,
  };
}

function removeBrowserCodeTempDir(tempDir?: string) {
  if (!tempDir) return;
  try {
    rmSync(tempDir, { force: true, recursive: true });
  } catch {
    // The child may still be releasing a Playwright transport handle on Windows.
  }
}

export class BrowserCodeKernel {
  private child?: ChildProcess;
  private closed = false;
  private executionTimer?: ReturnType<typeof setTimeout>;
  private pending?: PendingExecution;
  private readyPromise?: Promise<void>;
  private readyReject?: (error: Error) => void;
  private readyResolve?: () => void;
  private readyTimer?: ReturnType<typeof setTimeout>;
  private stderr = '';
  private tail = Promise.resolve();
  private tempDir?: string;

  constructor(
    private readonly connection: BrowserCodeConnection,
    private readonly options: BrowserCodeKernelOptions = {},
  ) {}

  execute(input: BrowserCodeExecutionInput): Promise<BrowserCodeRunResult> {
    const task = this.tail.then(() => this.executeNow(input));
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }

  async close() {
    this.closed = true;
    this.rejectReady(new Error('browserCode JavaScript kernel was closed.'));
    if (this.pending) {
      this.finishPending({ ok: false, error: 'browserCode execution was aborted.', aborted: true, logs: [] });
    }
    this.stopChild();
    await this.tail.catch(() => undefined);
  }

  private async executeNow(input: BrowserCodeExecutionInput): Promise<BrowserCodeRunResult> {
    const startedAt = Date.now();
    if (input.abortSignal?.aborted) {
      return { ok: false, error: 'browserCode execution was aborted.', aborted: true, elapsedMs: 0, logs: [] };
    }

    try {
      await this.ensureReady();
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - startedAt,
        logs: [],
      };
    }
    if (input.abortSignal?.aborted) {
      return { ok: false, error: 'browserCode execution was aborted.', aborted: true, elapsedMs: Date.now() - startedAt, logs: [] };
    }
    if (!this.child?.connected) {
      return { ok: false, error: 'browserCode JavaScript kernel is not connected.', elapsedMs: Date.now() - startedAt, logs: [] };
    }

    const maxOutputChars = boundedInteger(input.maxOutputChars, defaultMaxOutputChars, 1_000, maxOutputCharsLimit);
    const requestId = randomUUID();
    return new Promise<BrowserCodeRunResult>((resolve) => {
      const onAbort = () => {
        this.finishPending({ ok: false, error: 'browserCode execution was aborted.', aborted: true, logs: [] });
        this.stopChild();
      };
      this.pending = {
        abortSignal: input.abortSignal,
        onAbort,
        requestId,
        resolve,
        startedAt,
      };
      input.abortSignal?.addEventListener('abort', onAbort, { once: true });
      const executionTimeoutMs = boundedInteger(
        this.options.executionTimeoutMs ?? process.env.AI_BROWSER_CODE_EXECUTION_TIMEOUT_MS,
        defaultBrowserCodeExecutionTimeoutMs,
        100,
        10 * 60_000,
      );
      this.executionTimer = setTimeout(() => {
        if (this.pending?.requestId !== requestId) return;
        this.finishPending({
          ok: false,
          error: `browserCode execution timed out after ${executionTimeoutMs}ms; the JavaScript kernel was restarted.`,
          logs: [],
        });
        this.stopChild();
      }, executionTimeoutMs);
      this.child?.send({
        type: 'execute',
        code: input.code,
        credentials: (input.credentials || []).map((credential) => ({
          ref: String(credential.ref || ''),
          value: String(credential.value || ''),
          allowedOrigins: Array.from(new Set((credential.allowedOrigins || []).map((origin) => String(origin)))),
        })),
        executionId: input.executionId,
        maxOutputChars,
        requestId,
      }, (error) => {
        if (!error) return;
        this.finishPending({ ok: false, error: error.message, logs: [] });
        this.stopChild();
      });
    });
  }

  private ensureReady() {
    if (this.closed) return Promise.reject(new Error('browserCode JavaScript kernel is closed.'));
    if (this.readyPromise) return this.readyPromise;

    const kernelId = randomUUID();
    const tempDir = path.join(os.tmpdir(), 'webpilot-browser-code', kernelId);
    mkdirSync(tempDir, { recursive: true });
    this.tempDir = tempDir;
    this.stderr = '';
    const readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.readyPromise = readyPromise;
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, browserCodeChildArgs(tempDir), {
        cwd: process.cwd(),
        env: browserCodeChildEnv(tempDir),
        stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
        windowsHide: true,
      });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.rejectReady(normalized);
      this.tempDir = undefined;
      removeBrowserCodeTempDir(tempDir);
      return readyPromise;
    }
    this.child = child;
    child.stdin?.end(childSource(), 'utf8');
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-maxDiagnosticChars);
    });
    child.on('message', (message: unknown) => this.handleMessage(message));
    child.on('error', (error) => {
      if (this.child !== child) return;
      this.rejectReady(error);
      this.finishPending({ ok: false, error: error.message, logs: [] });
      this.stopChild();
    });
    child.on('exit', (code, signal) => {
      removeBrowserCodeTempDir(tempDir);
      if (this.child !== child) return;
      const diagnostic = this.stderr.trim() ? ` ${this.stderr.trim()}` : '';
      const error = new Error(`browserCode JavaScript kernel exited (code ${code ?? 'none'}, signal ${signal || 'none'}).${diagnostic}`);
      this.child = undefined;
      this.readyPromise = undefined;
      this.rejectReady(error);
      this.finishPending({ ok: false, error: error.message, logs: [] });
    });
    const readyTimeoutMs = boundedInteger(
      this.options.readyTimeoutMs ?? process.env.AI_BROWSER_CODE_KERNEL_READY_TIMEOUT_MS,
      defaultBrowserCodeKernelReadyTimeoutMs,
      100,
      60_000,
    );
    this.readyTimer = setTimeout(() => {
      if (this.child !== child) return;
      const error = new Error(`browserCode JavaScript kernel startup timed out after ${readyTimeoutMs}ms.`);
      this.rejectReady(error);
      this.stopChild();
    }, readyTimeoutMs);
    child.send({ type: 'init', connection: this.connection }, (error) => {
      if (!error) return;
      this.rejectReady(error);
      this.stopChild();
    });
    return readyPromise;
  }

  private handleMessage(message: unknown) {
    if (!message || typeof message !== 'object') return;
    const record = message as Record<string, unknown>;
    if (record.type === 'ready') {
      this.resolveReady();
      return;
    }
    if (record.type === 'init-error') {
      const error = new Error(typeof record.error === 'string' ? record.error : 'browserCode JavaScript kernel failed to initialize.');
      this.rejectReady(error);
      this.stopChild();
      return;
    }
    if (!this.pending || record.requestId !== this.pending.requestId) return;
    if (record.type !== 'result') return;
      const logs = Array.isArray(record.logs) ? record.logs as BrowserCodeExecutionLog[] : [];
    const images = Array.isArray(record.images) ? record.images as BrowserCodeImage[] : [];
    if (record.ok === true) {
      this.finishPending({
        ok: true,
        value: record.value,
        logs,
        images,
        selectedExecutionId: typeof record.selectedExecutionId === 'string' ? record.selectedExecutionId : undefined,
      });
    } else {
      this.finishPending({
        ok: false,
        error: typeof record.error === 'string' ? record.error : 'browserCode execution failed.',
        images,
        logs,
      });
    }
  }

  private finishPending(result: Omit<BrowserCodeRunResult, 'elapsedMs'>) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    this.clearExecutionTimer();
    pending.abortSignal?.removeEventListener('abort', pending.onAbort);
    pending.resolve({ ...result, elapsedMs: Date.now() - pending.startedAt });
  }

  private rejectReady(error: Error) {
    this.clearReadyTimer();
    this.readyReject?.(error);
    this.readyReject = undefined;
    this.readyResolve = undefined;
    this.readyPromise = undefined;
  }

  private resolveReady() {
    const resolve = this.readyResolve;
    this.clearReadyTimer();
    this.readyReject = undefined;
    this.readyResolve = undefined;
    resolve?.();
  }

  private clearExecutionTimer() {
    if (!this.executionTimer) return;
    clearTimeout(this.executionTimer);
    this.executionTimer = undefined;
  }

  private clearReadyTimer() {
    if (!this.readyTimer) return;
    clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
  }

  private stopChild() {
    const child = this.child;
    const tempDir = this.tempDir;
    this.child = undefined;
    this.readyPromise = undefined;
    this.tempDir = undefined;
    this.clearExecutionTimer();
    this.clearReadyTimer();
    if (child && !child.killed) child.kill();
    removeBrowserCodeTempDir(tempDir);
  }
}
