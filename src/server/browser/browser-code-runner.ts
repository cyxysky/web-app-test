import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserTextSelectionSpec } from './editable-text-selection';

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

type BrowserCodePageObservation = {
  epoch: number;
  url: string;
  title: string;
  focusedElement?: { descriptor: string; label: string };
  activeSurface?: {
    id: string;
    descriptor: string;
    kind: 'dialog' | 'popover' | 'menu' | 'listbox' | 'panel' | 'overlay';
    label: string;
    modal: boolean;
    likelyOverlay: boolean;
    focusedInside: boolean;
    zIndex: number;
    rect: {
      bottom: number;
      height: number;
      left: number;
      right: number;
      top: number;
      width: number;
    };
    signals: string[];
    selector?: string;
    framePath?: string;
    parentId?: string;
    depth: number;
    activationOrder: number;
  };
  surfaces: Array<{
    id: string;
    descriptor: string;
    kind: 'dialog' | 'popover' | 'menu' | 'listbox' | 'panel' | 'overlay';
    label: string;
    modal: boolean;
    likelyOverlay: boolean;
    focusedInside: boolean;
    zIndex: number;
    rect: { bottom: number; height: number; left: number; right: number; top: number; width: number };
    signals: string[];
    selector?: string;
    framePath?: string;
    parentId?: string;
    depth: number;
    activationOrder: number;
  }>;
  surfaceStack: Array<{
    id: string;
    descriptor: string;
    kind: 'dialog' | 'popover' | 'menu' | 'listbox' | 'panel' | 'overlay';
    label: string;
    modal: boolean;
    likelyOverlay: boolean;
    focusedInside: boolean;
    zIndex: number;
    rect: { bottom: number; height: number; left: number; right: number; top: number; width: number };
    signals: string[];
    selector?: string;
    framePath?: string;
    parentId?: string;
    depth: number;
    activationOrder: number;
  }>;
  topSurfaceIds: string[];
  surfaceTransition: 'initial' | 'unchanged' | 'opened' | 'closed' | 'changed';
};

export type BrowserCodeActivity = {
  actions: string[];
  navigationChanged: boolean;
  tabChanged: boolean;
  verification?: {
    status: 'passed' | 'failed';
    detail: string;
  };
};

export type BrowserCodeRunResult = {
  ok: boolean;
  value?: unknown;
  error?: string;
  elapsedMs: number;
  logs: BrowserCodeExecutionLog[];
  images?: BrowserCodeImage[];
  selectedExecutionId?: string;
  activity?: BrowserCodeActivity;
  aborted?: boolean;
  kernelReset?: {
    reason: 'age-limit' | 'execution-limit' | 'heap-limit' | 'rss-limit';
    memoryUsage?: BrowserCodeKernelMemoryUsage;
  };
};

export type BrowserCodeKernelMemoryUsage = {
  arrayBuffers?: number;
  external: number;
  heapTotal: number;
  heapUsed: number;
  rss: number;
};

export type BrowserCodeRisk = {
  requiresConfirmation: boolean;
  reasons: string[];
};

function evaluateCallContainsDomClick(code: string) {
  const evaluatePattern = /\.evaluate(?:All|Handle)?\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = evaluatePattern.exec(code))) {
    const openingParen = code.indexOf('(', match.index);
    let depth = 0;
    let quote = '';
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = openingParen; index < code.length; index += 1) {
      const character = code[index];
      const next = code[index + 1];
      if (lineComment) {
        if (character === '\n' || character === '\r') lineComment = false;
        continue;
      }
      if (blockComment) {
        if (character === '*' && next === '/') {
          blockComment = false;
          index += 1;
        }
        continue;
      }
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = '';
        continue;
      }
      if (character === '/' && next === '/') {
        lineComment = true;
        index += 1;
        continue;
      }
      if (character === '/' && next === '*') {
        blockComment = true;
        index += 1;
        continue;
      }
      if (character === '"' || character === "'" || character === '`') {
        quote = character;
        continue;
      }
      if (character === '(') depth += 1;
      if (character !== ')') continue;
      depth -= 1;
      if (depth > 0) continue;
      const evaluateCall = code.slice(openingParen + 1, index);
      if (/\.click\s*\(/i.test(evaluateCall)) return true;
      evaluatePattern.lastIndex = index + 1;
      break;
    }
  }
  return false;
}

export function browserCodePolicyViolation(code: string) {
  if (/\.dispatchEvent\s*\(\s*(?:[^,()]+,\s*)?['"]click['"]/i.test(code)) {
    return 'browserCode forbids dispatchEvent("click") because it bypasses Playwright actionability. Refresh the DOM evidence and use one unique visible Playwright locator.';
  }
  if (evaluateCallContainsDomClick(code)) {
    return 'browserCode forbids DOM element.click() inside evaluate callbacks because it bypasses Playwright actionability. Refresh the DOM evidence and use one unique visible Playwright locator.';
  }
  const uploadSource = browserCodeWithoutComments(code).replace(
    /\battachmentVault\s*\.\s*setInputFiles\s*\(/gi,
    '(',
  );
  if (/\.\s*(?:setInputFiles|setFiles)\s*\(/i.test(uploadSource)) {
    return 'Use attachmentVault.setInputFiles(locator, attachmentId) for a registered user attachment. Direct paths, reconstructed file payloads, Locator/Page.setInputFiles(), and FileChooser.setFiles() are unavailable to browserCode.';
  }
  return undefined;
}

export type BrowserCodeCredentialBinding = {
  ref: string;
  value: string;
  allowedOrigins: string[];
};

export type BrowserCodeAttachmentBinding = {
  name: string;
  path: string;
  ref: string;
};

export type BrowserCodeExecutionInput = {
  code: string;
  executionId: string;
  maxOutputChars?: number;
  attachments?: BrowserCodeAttachmentBinding[];
  credentials?: BrowserCodeCredentialBinding[];
  abortSignal?: AbortSignal;
};

export type BrowserCodeKernelOptions = {
  executionTimeoutMs?: number;
  maxAgeMs?: number;
  maxExecutions?: number;
  maxHeapBytes?: number;
  maxRssBytes?: number;
  readyTimeoutMs?: number;
  sessionGroupId?: string;
};

type PendingExecution = {
  abortSignal?: AbortSignal;
  onAbort: () => void;
  requestId: string;
  resolve: (result: BrowserCodeRunResult) => void;
  startedAt: number;
};

const maxDiagnosticChars = 4_000;
const defaultBrowserCodeKernelReadyTimeoutMs = 10_000;
const defaultBrowserCodeExecutionTimeoutMs = 90_000;
export const BROWSER_CODE_KERNEL_RUNTIME_REVISION = 29;

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === 'number' ? value : Number(value);
  const normalized = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  return Math.min(max, Math.max(min, normalized));
}

function browserCodeWithoutComments(code: string) {
  let result = '';
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < code.length; index += 1) {
    const character = code[index];
    const next = code[index + 1];
    if (lineComment) {
      if (character === '\n' || character === '\r') {
        lineComment = false;
        result += character;
      } else {
        result += ' ';
      }
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        result += '  ';
        index += 1;
      } else {
        result += character === '\n' || character === '\r' ? character : ' ';
      }
      continue;
    }
    if (quote) {
      result += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      result += '  ';
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      result += '  ';
      index += 1;
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') quote = character;
    result += character;
  }
  return result;
}

export function browserCodeHasCommittingAction(code: string) {
  const source = browserCodeWithoutComments(code);
  return /\.(?:click|dblclick|check|uncheck|press|setInputFiles|selectOption|submit)\s*\(/i.test(source)
    || /\bfetch\s*\([\s\S]*?\bmethod\s*:\s*['"`](?:POST|PUT|PATCH|DELETE)['"`]/i.test(source)
    || /\.open\s*\(\s*['"`](?:POST|PUT|PATCH|DELETE)['"`]/i.test(source)
    || /\bsendBeacon\s*\(/i.test(source)
    || /\b(?:localStorage|sessionStorage)\s*\.\s*(?:setItem|removeItem|clear)\s*\(/i.test(source);
}

export function analyzeBrowserCodeRisk(code: string): BrowserCodeRisk {
  const source = browserCodeWithoutComments(code);
  if (!browserCodeHasCommittingAction(source)) return { requiresConfirmation: false, reasons: [] };
  const reasons: string[] = [];
  const checks: Array<[RegExp, string]> = [
    [/\b(?:submit|publish|send|delete|remove|destroy|approve|authorize|pay|purchase|checkout|order|transfer|upload|download|login|logout)\b/i, '代码包含可能对外产生影响或修改数据的操作'],
    [/(?:提交|发布|发送|删除|移除|确认|批准|授权|支付|购买|下单|转账|上传|下载|登录|退出)/, '代码包含可能对外产生影响或修改数据的操作'],
    [/\bfetch\s*\([\s\S]*?\bmethod\s*:\s*['"`](?:POST|PUT|PATCH|DELETE)['"`]|\.open\s*\(\s*['"`](?:POST|PUT|PATCH|DELETE)['"`]|\bsendBeacon\s*\(|\b(?:localStorage|sessionStorage)\s*\.\s*(?:setItem|removeItem|clear)\s*\(/i, '页面代码可能发起写请求或修改页面状态'],
  ];
  for (const [pattern, reason] of checks) {
    if (pattern.test(source)) reasons.push(reason);
  }
  return { requiresConfirmation: reasons.length > 0, reasons };
}

function browserCodeKernelMain() {
  const browserCodeActionTimeoutMs = 5_000;
  const browserCodeNavigationTimeoutMs = 30_000;
  // Screenshots may wait for web fonts before capture. Keep their timeout
  // independent from the intentionally short locator/action timeout so a
  // slow font response does not make an otherwise healthy capture fail.
  const browserCodeScreenshotTimeoutMs = 30_000;
  const browserCodePointerLookupTimeoutMs = 250;
  const browserCodeFrameObservationTimeoutMs = 1_500;
  const browserCodePageObservationTimeoutMs = 2_500;
  const browserCodeAxSnapshotTimeoutMs = 6_000;
  const browserCodeSnapshotFallbackTimeoutMs = 1_500;
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

  const settleKernelTask = <T>(promise: Promise<T>, timeoutMs: number, label: string) => (
    new Promise<{ ok: true; value: T } | { ok: false; error: string }>((resolve) => {
      let settled = false;
      const finish = (result: { ok: true; value: T } | { ok: false; error: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        finish({ ok: false, error: `${label} timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      timer.unref?.();
      promise.then(
        (value) => finish({ ok: true, value }),
        (error) => finish({ ok: false, error: `${label} failed: ${error instanceof Error ? error.message : String(error)}` }),
      );
    })
  );
  const hostProcess = process;
  type CoordinateClickEvidence = {
    capturedAt: number;
    devicePixelRatio: number;
    documentId: string;
    height: number;
    page: import('playwright').Page;
    scrollX: number;
    scrollY: number;
    url: string;
    width: number;
  };
  type KernelPageObservation = BrowserCodePageObservation;
  type ActionObservation = {
    action: string;
    before?: KernelPageObservation;
    after?: KernelPageObservation;
  };
  const compactObservationUrl = (value: string) => (
    value.length <= 2048
      ? value
      : `${value.slice(0, 2000)}...[truncated; length=${value.length}]`
  );
  let browser: import('playwright').Browser | undefined;
  let replServer: import('node:repl').REPLServer | undefined;
  let sessionGroupId = '';
  let activeExecution: {
    actions: string[];
    logs: BrowserCodeExecutionLog[];
    images: BrowserCodeImage[];
    imageBytes: number;
    outputs: unknown[];
    startedAt: number;
    attachments: Map<string, BrowserCodeAttachmentBinding>;
    credentials: Map<string, BrowserCodeCredentialBinding>;
    pendingCoordinateClickEvidence: Map<import('playwright').Page, CoordinateClickEvidence>;
    observationsBeforeAction: WeakMap<import('playwright').Page, KernelPageObservation>;
    verification?: BrowserCodeActivity['verification'];
  } | undefined;
  const screenshotProvenance = new WeakMap<object, CoordinateClickEvidence & { fullPage: boolean }>();
  const screenshotProvenanceByDigest = new Map<string, CoordinateClickEvidence & { fullPage: boolean }>();
  const coordinateClickEvidenceByDocument = new Map<string, CoordinateClickEvidence>();
  const lastActionObservationByPage = new WeakMap<import('playwright').Page, ActionObservation>();
  let chain = Promise.resolve();

  const imageDigest = (value: Uint8Array) => childCreateHash('sha256').update(value).digest('hex');

  const recordAction = (action: string) => {
    activeExecution?.actions.push(action);
  };

  const send = (payload: Record<string, unknown>) => {
    if (typeof hostProcess.send === 'function') hostProcess.send(payload);
  };

  const jsonSafe = (value: unknown, maxOutputChars?: number) => {
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
    if (maxOutputChars && serialized.length > maxOutputChars) {
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
  const rawLocatorByExistingLocator = new WeakMap<object, import('playwright').Locator>();
  let nativeFrameLocator: ((this: object, selector: string) => import('playwright').Locator) | undefined;
  let nativeLocatorFilter: ((this: object, options?: unknown) => import('playwright').Locator) | undefined;
  let nativeLocatorFill: ((this: object, value: string) => Promise<void>) | undefined;
  const nativeLocatorActions = new Map<
    string,
    (this: object, ...args: unknown[]) => Promise<unknown>
  >();

  const actionArgsWithMinimumTimeout = (args: unknown[], optionsIndex: number) => {
    const options = args[optionsIndex];
    if (!options || typeof options !== 'object' || Array.isArray(options)) return args;
    const timeout = Number(Reflect.get(options, 'timeout'));
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout >= browserCodeActionTimeoutMs) return args;
    const normalized = [...args];
    normalized[optionsIndex] = { ...options, timeout: browserCodeActionTimeoutMs };
    return normalized;
  };

  const screenshotArgsWithDefaultTimeout = (args: unknown[]) => {
    const options = args[0];
    if (options && typeof options === 'object' && !Array.isArray(options)) {
      const timeout = Number(Reflect.get(options, 'timeout'));
      if (Number.isFinite(timeout) && timeout > 0) return args;
      return [{ ...options, timeout: browserCodeScreenshotTimeoutMs }, ...args.slice(1)];
    }
    return [{ timeout: browserCodeScreenshotTimeoutMs }, ...args];
  };

  const existingLocator = (locator: import('playwright').Locator) => {
    if (!nativeLocatorFilter) return locator;
    const filtered = Reflect.apply(nativeLocatorFilter, locator, [{ visible: true }]);
    rawLocatorByExistingLocator.set(filtered, locator);
    return filtered;
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

  const readUnifiedPageObservation = async (
    page: import('playwright').Page,
  ): Promise<KernelPageObservation> => {
    const mainFrame = page.mainFrame();
    const observations = await Promise.all(page.frames().slice(0, 25).map(async (frame) => {
      const observationResult = await settleKernelTask(frame.evaluate(() => {
        const browserWindow = window as Window & {
          __aiDomMutationState?: { epoch?: number };
          __aiDomRuntime?: { pageObservation?: () => KernelPageObservation };
        };
        const shared = browserWindow.__aiDomRuntime?.pageObservation?.();
        if (shared) return shared;
        const visible = (element: Element) => {
          if (
            !element.isConnected
            || element.hasAttribute('hidden')
            || (element as HTMLElement).inert
            || element.hasAttribute('inert')
          ) return false;
          let current: Element | null = element;
          while (current) {
            const style = getComputedStyle(current);
            if (
              style.display === 'none'
              || style.visibility === 'hidden'
              || style.visibility === 'collapse'
              || style.contentVisibility === 'hidden'
              || Number(style.opacity || '1') <= 0.01
            ) return false;
            current = current.parentElement;
          }
          const rect = element.getBoundingClientRect();
          return rect.width > 2 && rect.height > 2;
        };
        const surfaceElements = Array.from(document.querySelectorAll(
          'dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
        )).filter(visible);
        const descriptor = (element: Element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}`;
        const surfaces = surfaceElements.map((surface, index) => {
          const rect = surface.getBoundingClientRect();
          return {
          id: `${descriptor(surface)}|${String(surface.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80)}`,
          descriptor: descriptor(surface),
          kind: surface.getAttribute('role') === 'menu'
            ? 'menu'
            : surface.getAttribute('role') === 'listbox' ? 'listbox' : 'dialog',
          label: String(surface.getAttribute('aria-label') || surface.getAttribute('title') || surface.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
          modal: surface.getAttribute('aria-modal') === 'true' || surface instanceof HTMLDialogElement,
          likelyOverlay: true,
          focusedInside: Boolean(document.activeElement && surface.contains(document.activeElement)),
          zIndex: Number.parseInt(getComputedStyle(surface).zIndex, 10) || 0,
          rect: {
            bottom: rect.bottom,
            height: rect.height,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            width: rect.width,
          },
          signals: ['fallback-semantic-surface'],
          ...(surface.id ? { selector: `#${CSS.escape(surface.id)}` } : {}),
          depth: 0,
          activationOrder: index + 1,
        };
        });
        const activeSurface = surfaces.at(-1);
        const focused = document.activeElement instanceof Element && document.activeElement !== document.body
          ? document.activeElement
          : undefined;
        return {
          epoch: Number(browserWindow.__aiDomMutationState?.epoch || 0),
          url: (() => {
            const currentUrl = window.location.href;
            return currentUrl.length <= 2048
              ? currentUrl
              : `${currentUrl.slice(0, 2000)}...[truncated; length=${currentUrl.length}]`;
          })(),
          title: document.title,
          ...(focused ? {
            focusedElement: {
              descriptor: descriptor(focused),
              label: String(
                focused.getAttribute('aria-label')
                || focused.getAttribute('title')
                || focused.getAttribute('placeholder')
                || focused.textContent
                || '',
              ).replace(/\s+/g, ' ').trim().slice(0, 120),
            },
          } : {}),
          ...(activeSurface ? { activeSurface } : {}),
          surfaces,
          surfaceStack: activeSurface ? [activeSurface] : [],
          topSurfaceIds: surfaces.map((surface) => surface.id),
          surfaceTransition: 'initial' as const,
        };
      }), browserCodeFrameObservationTimeoutMs, `frame observation ${compactObservationUrl(frame.url()) || 'about:blank'}`);
      const observation = observationResult.ok ? observationResult.value : undefined;
      if (!observation) return undefined;
      return {
        ...observation,
        surfaces: observation.surfaces.map((surface) => ({
          ...surface,
          ...(frame !== mainFrame ? { framePath: frame.url() || 'iframe' } : {}),
        })),
        surfaceStack: observation.surfaceStack.map((surface) => ({
          ...surface,
          ...(frame !== mainFrame ? { framePath: frame.url() || 'iframe' } : {}),
        })),
        ...(observation.activeSurface && frame !== mainFrame ? {
          activeSurface: {
            ...observation.activeSurface,
            framePath: frame.url() || 'iframe',
          },
        } : {}),
      } as KernelPageObservation;
    }));
    const available = observations.filter((item): item is KernelPageObservation => Boolean(item));
    const main = available[0];
    const selectedSurface = available
      .flatMap((item) => item.activeSurface ? [{ observation: item, surface: item.activeSurface }] : [])
      .sort((left, right) => (
        Number(right.surface.likelyOverlay) - Number(left.surface.likelyOverlay)
        || Number(right.surface.modal) - Number(left.surface.modal)
        || right.surface.activationOrder - left.surface.activationOrder
        || right.surface.zIndex - left.surface.zIndex
      ))[0];
    const titleResult = main
      ? undefined
      : await settleKernelTask(page.title(), browserCodeSnapshotFallbackTimeoutMs, 'page title');
    return {
      epoch: available.reduce((max, item) => Math.max(max, item.epoch), 0),
      url: main?.url || compactObservationUrl(page.url()),
      title: main?.title || (titleResult?.ok ? titleResult.value : ''),
      ...(main?.focusedElement ? { focusedElement: main.focusedElement } : {}),
      ...(selectedSurface ? { activeSurface: selectedSurface.surface } : {}),
      surfaces: available.flatMap((item) => item.surfaces),
      surfaceStack: selectedSurface?.observation.surfaceStack || main?.surfaceStack || [],
      topSurfaceIds: available.flatMap((item) => item.topSurfaceIds),
      surfaceTransition: selectedSurface?.observation.surfaceTransition || main?.surfaceTransition || 'initial',
    };
  };

  const markPageObserved = async (page: import('playwright').Page) => {
    if (!activeExecution) throw new Error('Page observation is only available while browserCode is executing.');
    const observation = await readUnifiedPageObservation(page);
    activeExecution.observationsBeforeAction.set(page, observation);
    return observation;
  };

  const prepareStateChangingAction = (
    page: import('playwright').Page | undefined,
    action: string,
  ) => {
    void page;
    recordAction(action);
  };

  const completeStateChangingAction = async (
    page: import('playwright').Page | undefined,
    action: string,
  ) => {
    if (!activeExecution || !page) return;
    const before = activeExecution.observationsBeforeAction.get(page);
    const after = await readUnifiedPageObservation(page);
    lastActionObservationByPage.set(page, { action, before, after });
    activeExecution.observationsBeforeAction.set(page, after);
  };

  const resolveActionableLocator = async (
    locator: object,
    action: string,
  ) => {
    if (
      !locator
      || typeof locator !== 'object'
      || typeof Reflect.get(locator, 'count') !== 'function'
      || typeof Reflect.get(locator, 'evaluate') !== 'function'
      || typeof Reflect.get(locator, 'evaluateAll') !== 'function'
      || typeof Reflect.get(locator, 'filter') !== 'function'
    ) {
      throw new Error(
        `ACTIONABILITY_FAILED: ${action} requires a real Playwright Locator from the active browser session.`,
      );
    }
    const originalCandidate = locator as import('playwright').Locator;
    const originalCount = await originalCandidate.count();
    const skipVisibleFilter = action.toLowerCase() === 'setinputfiles';
    const candidateSet = skipVisibleFilter
      ? originalCandidate
      : originalCandidate.filter({ visible: true });
    let results = await candidateSet.evaluateAll((elements, operation) => {
      const browserWindow = window as Window & {
        __aiDomRuntime?: {
          actionability?: (
            target: Element,
            options?: { action?: string },
          ) => {
            ok: boolean;
            reason: string;
            descriptor: string;
            coveredBy?: string;
            failureKind?: 'occluded';
            preserveScroll?: boolean;
          };
        };
      };
      const runtime = browserWindow.__aiDomRuntime;
      return elements.map((element): {
        ok: boolean;
        reason: string;
        descriptor: string;
        coveredBy?: string;
        failureKind?: 'occluded';
        preserveScroll?: boolean;
      } => {
        const descriptor = `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}`;
        const pointerAction = /^(click|dblclick|hover|tap|check|uncheck|setchecked|dragto|draganddrop)$/.test(operation.toLowerCase());
        let blockingLayer: Element | undefined;
        if (pointerAction) {
          const foregroundSurfaceSelector = [
            'dialog[open]',
            '[aria-modal="true"]',
            '[role="dialog"]',
            '[role="alertdialog"]',
            '[role="menu"]',
            '[role="listbox"]',
            '[popover]',
          ].join(',');
          const foregroundSurfaces = Array.from(document.querySelectorAll(foregroundSurfaceSelector)).filter((surface) => {
            if (surface.hasAttribute('popover')) {
              try {
                if (!surface.matches(':popover-open')) return false;
              } catch {
                return false;
              }
            }
            const surfaceStyle = getComputedStyle(surface);
            const surfaceRect = surface.getBoundingClientRect();
            return surface.isConnected
              && surfaceStyle.display !== 'none'
              && surfaceStyle.visibility !== 'hidden'
              && Number(surfaceStyle.opacity || '1') > 0.01
              && surfaceStyle.pointerEvents !== 'none'
              && surfaceRect.width > 0
              && surfaceRect.height > 0
              && surfaceRect.right > 0
              && surfaceRect.bottom > 0
              && surfaceRect.left < window.innerWidth
              && surfaceRect.top < window.innerHeight;
          });
          const targetBelongsToForegroundSurface = foregroundSurfaces.some((surface) => (
            surface === element || surface.contains(element)
          ));
          if (!targetBelongsToForegroundSurface) {
            blockingLayer = foregroundSurfaces.filter((surface) => !element.contains(surface)).at(-1);
          }
          const rect = element.getBoundingClientRect();
          const intersectsViewport = rect.right > 0
            && rect.bottom > 0
            && rect.left < window.innerWidth
            && rect.top < window.innerHeight;
          if (!intersectsViewport && !blockingLayer) {
            const candidate = document.elementFromPoint(
              Math.max(0, Math.floor(window.innerWidth / 2)),
              Math.max(0, Math.floor(window.innerHeight / 2)),
            );
            if (candidate && !candidate.contains(element) && !element.contains(candidate)) {
              const style = getComputedStyle(candidate);
              const blockerRect = candidate.getBoundingClientRect();
              const horizontalCoverage = Math.max(0, Math.min(window.innerWidth, blockerRect.right) - Math.max(0, blockerRect.left));
              const verticalCoverage = Math.max(0, Math.min(window.innerHeight, blockerRect.bottom) - Math.max(0, blockerRect.top));
              if (
                ['fixed', 'absolute', 'sticky'].includes(style.position)
                && horizontalCoverage >= window.innerWidth * 0.8
                && verticalCoverage >= window.innerHeight * 0.8
              ) blockingLayer = candidate;
            }
          }
        }
        const shared = runtime?.actionability?.(element, { action: operation });
        if (shared) {
          if (!blockingLayer) return shared;
          if (!shared.ok && shared.failureKind !== 'occluded') return shared;
          const blockerDescriptor = `${blockingLayer.tagName.toLowerCase()}${blockingLayer.id ? `#${blockingLayer.id}` : ''}`;
          return {
            ok: false,
            reason: `${descriptor} is outside the active foreground surface ${blockerDescriptor}; close or dismiss that surface before targeting the background`,
            descriptor,
            failureKind: 'occluded',
            coveredBy: blockerDescriptor,
            preserveScroll: true,
          };
        }
        if (!element.isConnected) {
          return { ok: false, reason: 'target is detached from the current document', descriptor };
        }
        const fileInputAction = operation.toLowerCase() === 'setinputfiles';
        if (blockingLayer) {
          const blockerDescriptor = `${blockingLayer.tagName.toLowerCase()}${blockingLayer.id ? `#${blockingLayer.id}` : ''}`;
          return {
            ok: false,
            reason: `${descriptor} is outside the viewport behind viewport-blocking layer ${blockerDescriptor}`,
            descriptor,
            failureKind: 'occluded',
            coveredBy: blockerDescriptor,
            preserveScroll: true,
          };
        }
        const targetStyle = getComputedStyle(element);
        if (pointerAction && targetStyle.pointerEvents === 'none') {
          return { ok: false, reason: `${descriptor} has computed pointer-events:none`, descriptor };
        }
        let current: Element | null = element;
        while (current) {
          const currentDescriptor = `${current.tagName.toLowerCase()}${current.id ? `#${current.id}` : ''}`;
          if (!fileInputAction && current.hasAttribute('hidden')) return { ok: false, reason: `${currentDescriptor} has the hidden attribute`, descriptor };
          if ((current as HTMLElement).inert || current.hasAttribute('inert')) return { ok: false, reason: `${currentDescriptor} or an ancestor is inert`, descriptor };
          const style = getComputedStyle(current);
          if (!fileInputAction && style.display === 'none') return { ok: false, reason: `${currentDescriptor} or an ancestor has display:none`, descriptor };
          if (!fileInputAction && (style.visibility === 'hidden' || style.visibility === 'collapse')) return { ok: false, reason: `${currentDescriptor} or an ancestor has visibility:${style.visibility}`, descriptor };
          if (!fileInputAction && (style.contentVisibility === 'hidden' || Number(style.opacity || '1') <= 0.01)) return { ok: false, reason: `${currentDescriptor} or an ancestor is not visibly rendered`, descriptor };
          current = current.parentElement;
        }
        const disabled = (() => {
          try {
            return element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true';
          } catch {
            return element.getAttribute('aria-disabled') === 'true';
          }
        })();
        if (disabled) return { ok: false, reason: `${descriptor} is disabled`, descriptor };
        if (!fileInputAction) {
          const rect = Array.from(element.getClientRects()).find((item) => item.width > 0 && item.height > 0);
          if (!rect) return { ok: false, reason: `${descriptor} has no rendered client rectangle`, descriptor };
          if (
            pointerAction
            && targetStyle.position === 'fixed'
            && (rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight)
          ) {
            return { ok: false, reason: `${descriptor} is fixed outside the viewport`, descriptor };
          }
        }
        if (/^(fill|type|clear|presssequentially)$/.test(operation.toLowerCase())) {
          const field = element as HTMLInputElement | HTMLTextAreaElement;
          if (!(element as HTMLElement).isContentEditable && !(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
            return { ok: false, reason: `${descriptor} is not editable`, descriptor };
          }
          if (!(element as HTMLElement).isContentEditable && (field.readOnly || field.disabled)) {
            return { ok: false, reason: `${descriptor} is readonly or disabled`, descriptor };
          }
        }
        if (operation.toLowerCase() === 'selectoption' && !(element instanceof HTMLSelectElement)) {
          return { ok: false, reason: `${descriptor} is not a native select element`, descriptor };
        }
        return { ok: true, reason: 'exact live element is actionable', descriptor };
      });
    }, action);
    const normalizedAction = action.toLowerCase();
    const trialMethod = normalizedAction === 'setchecked'
      || normalizedAction === 'dragto'
      || normalizedAction === 'draganddrop'
      ? 'click'
      : ['click', 'dblclick', 'hover', 'tap', 'check', 'uncheck'].includes(normalizedAction)
        ? normalizedAction
        : undefined;
    if (trialMethod) {
      const nativeTrialAction = nativeLocatorActions.get(trialMethod);
      const trialResults: typeof results = [];
      for (const [index, result] of results.entries()) {
        const supplementalOcclusion = result.failureKind === 'occluded'
          || /no unobstructed actionable point/i.test(result.reason);
        if (!result.ok && result.preserveScroll) {
          trialResults.push({
            ...result,
            reason: `${result.reason}; Playwright ${trialMethod} trial skipped to preserve the current background scroll position`,
          });
          continue;
        }
        if (!result.ok && !supplementalOcclusion) {
          trialResults.push(result);
          continue;
        }
        if (!nativeTrialAction) {
          trialResults.push({
            ...result,
            ok: false,
            reason: `${result.ok ? '' : `${result.reason}; `}native Locator.${trialMethod} trial is unavailable`,
          });
          continue;
        }
        const trialCandidate = candidateSet.nth(index);
        const scrollState = await trialCandidate.evaluate((element) => {
          const ancestors: Array<{ left: number; top: number }> = [];
          let current = element.parentElement;
          while (current) {
            ancestors.push({ left: current.scrollLeft, top: current.scrollTop });
            current = current.parentElement;
          }
          const scrolling = document.scrollingElement;
          return {
            ancestors,
            documentLeft: scrolling?.scrollLeft || window.scrollX,
            documentTop: scrolling?.scrollTop || window.scrollY,
          };
        }).catch(() => undefined);
        try {
          await Reflect.apply(nativeTrialAction, trialCandidate, [{
            timeout: supplementalOcclusion || results.length > 1
              ? browserCodePointerLookupTimeoutMs
              : browserCodeActionTimeoutMs,
            trial: true,
          }]);
          trialResults.push({
            ...result,
            ok: true,
            reason: result.ok
              ? `Playwright ${trialMethod} trial passed`
              : `${result.reason}; Playwright ${trialMethod} trial passed and is authoritative`,
            coveredBy: undefined,
          });
        } catch (error) {
          if (scrollState) {
            await trialCandidate.evaluate((element, state) => {
              let current = element.parentElement;
              let ancestorIndex = 0;
              while (current && ancestorIndex < state.ancestors.length) {
                const position = state.ancestors[ancestorIndex];
                current.scrollTo(position.left, position.top);
                current = current.parentElement;
                ancestorIndex += 1;
              }
              const scrolling = document.scrollingElement;
              if (scrolling) scrolling.scrollTo(state.documentLeft, state.documentTop);
              else window.scrollTo(state.documentLeft, state.documentTop);
            }, scrollState).catch(() => undefined);
          }
          const detail = (error instanceof Error ? error.message : String(error))
            .replace(/\s+/g, ' ')
            .slice(0, 600);
          trialResults.push({
            ...result,
            ok: false,
            reason: `${result.ok ? '' : `${result.reason}; `}Playwright ${trialMethod} trial failed: ${detail}`,
          });
        }
      }
      results = trialResults;
    }
    const actionableIndices = results
      .map((result, index) => result.ok ? index : -1)
      .filter((index) => index >= 0);
    if (actionableIndices.length !== 1) {
      const visibilityStage = skipVisibleFilter
        ? `${results.length} candidates entered the file-input exception path`
        : `${results.length} passed automatic visible filtering`;
      const diagnostics = results
        .map((result, index) => ({ index, result }))
        .slice(0, 12)
        .map(({ index, result }) => (
          `#${index + 1} ${result.descriptor}: ${result.ok ? 'actionable' : result.reason}`
          + (result.coveredBy ? `; covered by ${result.coveredBy}` : '')
        )).join(' | ');
      throw new Error(
        `ACTIONABILITY_FAILED: ${action} matched ${originalCount} elements; ${visibilityStage}; `
        + `${actionableIndices.length} passed full actionability. Exactly one candidate must pass both stages.`
        + (diagnostics ? ` ${diagnostics}` : ''),
      );
    }
    return candidateSet.nth(actionableIndices[0]);
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
      scrollX: number;
      scrollY: number;
      url: string;
      width: number;
    }>(`(() => {
      const browserWindow = window;
      if (!browserWindow.__aiCoordinateEvidenceDocumentId) {
        browserWindow.__aiCoordinateEvidenceDocumentId = Date.now() + '-' + Math.random();
      }
      return {
        devicePixelRatio: window.devicePixelRatio,
        documentId: browserWindow.__aiCoordinateEvidenceDocumentId || '',
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
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
    && evidence.scrollX === current.scrollX
    && evidence.scrollY === current.scrollY
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
      throw new Error('The previously emitted viewport screenshot is stale because the page document, URL, viewport, zoom, or scroll position changed. Emit and review a new screenshot in a separate browserCode cell.');
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
          const screenshotArgs = screenshotArgsWithDefaultTimeout(args);
          const image = await Reflect.apply(nativeScreenshot, this, screenshotArgs);
          const after = await captureCoordinateClickState(this);
          if (image && typeof image === 'object' && after) {
            const options = screenshotArgs[0] && typeof screenshotArgs[0] === 'object'
              ? screenshotArgs[0] as { fullPage?: boolean }
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
      const actionableLocator = await resolveActionableLocator(trustedLocator, 'fill');
      prepareStateChangingAction(targetPage, 'credential.fill');
      await moveVisibleAiPointer(targetPage, await locatorCenter(actionableLocator), 'click');
      await Reflect.apply(nativeLocatorFill, actionableLocator, [credential.value]);
      await completeStateChangingAction(targetPage, 'credential.fill');
      return { filled: true, origin };
    },
  });

  const attachmentVault = Object.freeze({
    async setInputFiles(locator: unknown, attachmentRef: unknown) {
      if (!activeExecution) {
        throw new Error('attachmentVault.setInputFiles() is only available while browserCode is executing.');
      }
      const ref = typeof attachmentRef === 'string' ? attachmentRef.trim() : '';
      const attachment = ref ? activeExecution.attachments.get(ref) : undefined;
      if (!attachment) {
        throw new Error('The requested user attachment is unavailable for this browserCode execution.');
      }
      if (!locator || typeof locator !== 'object') {
        throw new Error('attachmentVault.setInputFiles() requires a real Playwright Locator.');
      }
      const sourceLocator = rawLocatorByExistingLocator.get(locator) || locator;
      const locatorPrototype = Object.getPrototypeOf(sourceLocator) as object | null;
      const targetFrame = Reflect.get(sourceLocator, '_frame') as import('playwright').Frame | undefined;
      const selector = Reflect.get(sourceLocator, '_selector');
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
        throw new Error('attachmentVault.setInputFiles() requires a Locator from the active browser session.');
      }
      const nativeSetInputFiles = nativeLocatorActions.get('setInputFiles');
      if (!nativeFrameLocator || !nativeSetInputFiles) {
        throw new Error('attachmentVault.setInputFiles() could not access the trusted Playwright file-input implementation.');
      }
      const trustedLocator = Reflect.apply(nativeFrameLocator, targetFrame, [selector]);
      const fileInput = await resolveActionableLocator(trustedLocator, 'setInputFiles');
      prepareStateChangingAction(targetPage, 'attachment.setInputFiles');
      await Reflect.apply(nativeSetInputFiles, fileInput, [attachment.path]);
      await completeStateChangingAction(targetPage, 'attachment.setInputFiles');
      const selectedFiles = await fileInput.evaluate((element) => Array.from(
        (element as HTMLInputElement).files || [],
        (file) => ({ name: file.name, size: file.size, type: file.type }),
      ));
      if (!selectedFiles.some((file) => file.name === attachment.name)) {
        throw new Error(`The browser file input did not retain the selected attachment ${attachment.name}.`);
      }
      return {
        attachmentId: attachment.ref,
        fileName: attachment.name,
        selectedFiles,
        uploaded: true,
      };
    },
  });

  const decorateLocatorPrototype = (page: import('playwright').Page) => {
    const prototype = Object.getPrototypeOf(page.locator('html')) as Record<string, unknown> | null;
    if (!prototype || pointerDecoratedLocatorPrototypes.has(prototype)) return;
    credentialLocatorPrototypes.add(prototype);
    const framePrototype = Object.getPrototypeOf(page.mainFrame()) as Record<string, unknown> | null;
    const frameLocator = framePrototype && Reflect.get(framePrototype, 'locator');
    const locatorFilter = Reflect.get(prototype, 'filter');
    const locatorFill = Reflect.get(prototype, 'fill');
    if (!nativeFrameLocator && typeof frameLocator === 'function') {
      nativeFrameLocator = frameLocator as (this: object, selector: string) => import('playwright').Locator;
    }
    if (!nativeLocatorFill && typeof locatorFill === 'function') {
      nativeLocatorFill = locatorFill as (this: object, value: string) => Promise<void>;
    }
    if (!nativeLocatorFilter && typeof locatorFilter === 'function') {
      nativeLocatorFilter = locatorFilter as (this: object, options?: unknown) => import('playwright').Locator;
    }
    pointerDecoratedLocatorPrototypes.add(prototype);
    for (const name of ['locator', 'getByAltText', 'getByLabel', 'getByPlaceholder', 'getByRole', 'getByTestId', 'getByText', 'getByTitle']) {
      const original = Reflect.get(prototype, name);
      if (typeof original !== 'function') continue;
      try {
        Object.defineProperty(prototype, name, {
          configurable: true,
          value: function existingChainedLocator(this: import('playwright').Locator, ...args: unknown[]) {
            const rawBase = rawLocatorByExistingLocator.get(this) || this;
            const locator = Reflect.apply(original, rawBase, args) as import('playwright').Locator;
            return existingLocator(locator);
          },
          writable: true,
        });
      } catch {
        // Keep the native locator factory when its prototype is immutable.
      }
    }
    const patch = (name: string, kind: 'click' | 'double' | 'move', changesState = true) => {
      const original = Reflect.get(prototype, name);
      if (typeof original !== 'function') return;
      if (!nativeLocatorActions.has(name)) {
        nativeLocatorActions.set(
          name,
          original as (this: object, ...args: unknown[]) => Promise<unknown>,
        );
      }
      try {
        Object.defineProperty(prototype, name, {
          configurable: true,
          value: async function pointerVisualizedLocatorAction(this: object, ...args: unknown[]) {
            const forced = args.some((arg) => arg && typeof arg === 'object' && Reflect.get(arg, 'force') === true);
            const normalizedArgs = actionArgsWithMinimumTimeout(
              args,
              name === 'dragTo' || name === 'setChecked' ? 1 : 0,
            );
            const targetPage = locatorPage(this);
            let actionableLocator = this as import('playwright').Locator;
            const executionArgs = [...normalizedArgs];
            if (targetPage && activeExecution) {
              actionableLocator = forced
                ? this as import('playwright').Locator
                : await resolveActionableLocator(this, name);
              if (name === 'dragTo' && normalizedArgs[0] && typeof normalizedArgs[0] === 'object') {
                executionArgs[0] = forced
                  ? normalizedArgs[0]
                  : await resolveActionableLocator(normalizedArgs[0], name);
              }
              if (changesState) prepareStateChangingAction(targetPage, `locator.${name}`);
              await moveVisibleAiPointer(targetPage, await locatorCenter(actionableLocator), kind);
              if (name === 'dragTo' && executionArgs[0] && typeof executionArgs[0] === 'object') {
                await moveVisibleAiPointer(targetPage, await locatorCenter(executionArgs[0]), 'move');
              }
            }
            const result = await Reflect.apply(original, actionableLocator, executionArgs);
            if (changesState) await completeStateChangingAction(targetPage, `locator.${name}`);
            return result;
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
    for (const name of [
      'fill',
      'type',
      'press',
      'pressSequentially',
      'selectOption',
      'clear',
      'setInputFiles',
      'focus',
      'blur',
      'selectText',
      'scrollIntoViewIfNeeded',
    ]) {
      const original = Reflect.get(prototype, name);
      if (typeof original !== 'function') continue;
      if (!nativeLocatorActions.has(name)) {
        nativeLocatorActions.set(
          name,
          original as (this: object, ...args: unknown[]) => Promise<unknown>,
        );
      }
      try {
        Object.defineProperty(prototype, name, {
          configurable: true,
          value: async function observedLocatorAction(this: object, ...args: unknown[]) {
            if (name === 'setInputFiles' && activeExecution) {
              throw new Error('Use attachmentVault.setInputFiles(locator, attachmentId); direct file paths and reconstructed payloads are unavailable to browserCode.');
            }
            const targetPage = locatorPage(this);
            let actionableLocator = this as import('playwright').Locator;
            if (targetPage && activeExecution) {
              const locatorToResolve = name === 'setInputFiles'
                ? rawLocatorByExistingLocator.get(this) || this
                : this;
              actionableLocator = await resolveActionableLocator(locatorToResolve, name);
              prepareStateChangingAction(targetPage, `locator.${name}`);
              await moveVisibleAiPointer(targetPage, await locatorCenter(actionableLocator), 'click');
            } else {
              recordAction(`locator.${name}`);
            }
            const result = await Reflect.apply(original, actionableLocator, args);
            await completeStateChangingAction(targetPage, `locator.${name}`);
            return result;
          },
          writable: true,
        });
      } catch {
        // Keep the native Playwright method when the locator prototype is immutable.
      }
    }
  };

  const decoratePage = (page: import('playwright').Page) => {
    if (pointerDecoratedPages.has(page)) return;
    pointerDecoratedPages.add(page);
    decorateLocatorPrototype(page);
    decoratePageScreenshotPrototype(page);
    const pageRecord = page as unknown as Record<string, unknown>;
    for (const name of ['locator', 'getByAltText', 'getByLabel', 'getByPlaceholder', 'getByRole', 'getByTestId', 'getByText', 'getByTitle']) {
      const original = Reflect.get(pageRecord, name);
      if (typeof original !== 'function') continue;
      try {
        Object.defineProperty(pageRecord, name, {
          configurable: true,
          value: (...args: unknown[]) => existingLocator(
            Reflect.apply(original, page, args) as import('playwright').Locator,
          ),
          writable: true,
        });
      } catch {
        // Keep the native page locator factory when the page object is immutable.
      }
    }
    const patchPageAction = (
      name: string,
      kind: 'click' | 'double' | 'move',
      changesState = true,
      optionsIndex = 1,
      targetIndices = [0],
    ) => {
      const original = Reflect.get(pageRecord, name);
      if (typeof original !== 'function') return;
      try {
        Object.defineProperty(pageRecord, name, {
          configurable: true,
          value: async (...args: unknown[]) => {
            const forced = args.some((arg) => arg && typeof arg === 'object' && Reflect.get(arg, 'force') === true);
            const normalizedArgs = actionArgsWithMinimumTimeout(args, optionsIndex);
            const targetLocators = new Map<number, import('playwright').Locator>();
            if (activeExecution) {
              for (const targetIndex of targetIndices) {
                if (typeof normalizedArgs[targetIndex] !== 'string') continue;
                const locator = page.locator(normalizedArgs[targetIndex] as string);
                const locatorToResolve = name === 'setInputFiles'
                  ? rawLocatorByExistingLocator.get(locator) || locator
                  : locator;
                targetLocators.set(
                  targetIndex,
                  forced
                    ? locatorToResolve
                    : await resolveActionableLocator(locatorToResolve, name === 'dragAndDrop' ? 'dragTo' : name),
                );
              }
              if (changesState) prepareStateChangingAction(page, `page.${name}`);
              const orderedTargets = targetIndices
                .map((targetIndex) => targetLocators.get(targetIndex))
                .filter((locator): locator is import('playwright').Locator => Boolean(locator));
              for (const [index, locator] of orderedTargets.entries()) {
                await moveVisibleAiPointer(
                  page,
                  await locatorCenter(locator),
                  index === orderedTargets.length - 1 ? kind : 'move',
                );
              }
            }
            let result: unknown;
            const sourceLocator = targetLocators.get(0);
            if (activeExecution && sourceLocator) {
              const locatorMethod = name === 'dragAndDrop' ? 'dragTo' : name;
              const nativeLocatorAction = nativeLocatorActions.get(locatorMethod);
              if (!nativeLocatorAction) {
                throw new Error(`browserCode could not access the native Locator.${locatorMethod} implementation.`);
              }
              if (name === 'dragAndDrop') {
                const targetLocator = targetLocators.get(1);
                if (!targetLocator) {
                  throw new Error('page.dragAndDrop() requires one resolved source and target locator.');
                }
                const rawOptions = normalizedArgs[2];
                const locatorOptions = rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions)
                  ? { ...rawOptions as Record<string, unknown> }
                  : rawOptions;
                if (locatorOptions && typeof locatorOptions === 'object') {
                  delete (locatorOptions as Record<string, unknown>).strict;
                }
                result = await Reflect.apply(nativeLocatorAction, sourceLocator, [
                  targetLocator,
                  locatorOptions,
                ]);
              } else {
                const locatorArgs = normalizedArgs.slice(1).map((arg) => {
                  if (!arg || typeof arg !== 'object' || Array.isArray(arg) || !Reflect.has(arg, 'strict')) return arg;
                  const normalized = { ...arg as Record<string, unknown> };
                  delete normalized.strict;
                  return normalized;
                });
                result = await Reflect.apply(nativeLocatorAction, sourceLocator, locatorArgs);
              }
            } else {
              result = await Reflect.apply(original, page, normalizedArgs);
            }
            if (changesState) await completeStateChangingAction(page, `page.${name}`);
            return result;
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
    patchPageAction('setChecked', 'click', true, 2);
    patchPageAction('focus', 'click');
    patchPageAction('dragAndDrop', 'click', true, 2, [0, 1]);
    for (const name of ['fill', 'type', 'press', 'selectOption', 'setInputFiles', 'goto', 'reload', 'goBack', 'goForward', 'setContent']) {
      const original = Reflect.get(pageRecord, name);
      if (typeof original !== 'function') continue;
      try {
        Object.defineProperty(pageRecord, name, {
          configurable: true,
          value: async (...args: unknown[]) => {
            const selectorAction = ['fill', 'type', 'press', 'selectOption', 'setInputFiles'].includes(name);
            let actionableLocator: import('playwright').Locator | undefined;
            if (activeExecution && selectorAction && typeof args[0] === 'string') {
              const locator = page.locator(args[0]);
              const locatorToResolve = name === 'setInputFiles'
                ? rawLocatorByExistingLocator.get(locator) || locator
                : locator;
              actionableLocator = await resolveActionableLocator(locatorToResolve, name);
              await moveVisibleAiPointer(page, await locatorCenter(actionableLocator), 'click');
            }
            prepareStateChangingAction(page, `page.${name}`);
            let result: unknown;
            if (activeExecution && actionableLocator) {
              const nativeLocatorAction = nativeLocatorActions.get(name);
              if (!nativeLocatorAction) {
                throw new Error(`browserCode could not access the native Locator.${name} implementation.`);
              }
              const locatorArgs = args.slice(1).map((arg) => {
                if (!arg || typeof arg !== 'object' || Array.isArray(arg) || !Reflect.has(arg, 'strict')) return arg;
                const normalized = { ...arg as Record<string, unknown> };
                delete normalized.strict;
                return normalized;
              });
              result = await Reflect.apply(nativeLocatorAction, actionableLocator, locatorArgs);
            } else {
              result = await Reflect.apply(original, page, args);
            }
            await completeStateChangingAction(page, `page.${name}`);
            return result;
          },
          writable: true,
        });
      } catch {
        // Keep the native Playwright method when the page object is immutable.
      }
    }

    const mouse = page.mouse as unknown as Record<string, unknown>;
    const nativeMove = Reflect.get(mouse, 'move');
    if (typeof nativeMove === 'function') {
      try {
        Object.defineProperty(mouse, 'move', {
          configurable: true,
          value: async (x: number, y: number, options?: unknown) => {
            prepareStateChangingAction(page, 'mouse.move');
            await moveVisibleAiPointer(page, { x, y }, 'move');
            const result = await Reflect.apply(nativeMove, page.mouse, [x, y, options]);
            await completeStateChangingAction(page, 'mouse.move');
            return result;
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
            await markPageObserved(page);
            prepareStateChangingAction(page, 'mouse.click');
            const kind = options?.button === 'right' ? 'right' : (options?.clickCount || 1) > 1 ? 'double' : 'click';
            await moveVisibleAiPointer(page, { x, y }, kind);
            const result = await Reflect.apply(nativeClick, page.mouse, [x, y, options]);
            await completeStateChangingAction(page, 'mouse.click');
            return result;
          },
          writable: true,
        });
      } catch {
        // Keep the native mouse implementation when it cannot be decorated.
      }
    }
    const patchInputDevice = (
      device: Record<string, unknown>,
      name: string,
      action: string,
      options: { componentOnly?: boolean } = {},
    ) => {
      const original = Reflect.get(device, name);
      if (typeof original !== 'function') return;
      try {
        Object.defineProperty(device, name, {
          configurable: true,
          value: async (...args: unknown[]) => {
            if (options.componentOnly) {
              recordAction(action);
              return Reflect.apply(original, device, args);
            }
            prepareStateChangingAction(page, action);
            const result = await Reflect.apply(original, device, args);
            await completeStateChangingAction(page, action);
            return result;
          },
          writable: true,
        });
      } catch {
        // Keep the native input method when it cannot be decorated.
      }
    };
    patchInputDevice(mouse, 'wheel', 'mouse.wheel');
    patchInputDevice(mouse, 'down', 'mouse.down', { componentOnly: true });
    patchInputDevice(mouse, 'up', 'mouse.up', { componentOnly: true });
    const keyboard = page.keyboard as unknown as Record<string, unknown>;
    patchInputDevice(keyboard, 'press', 'keyboard.press');
    patchInputDevice(keyboard, 'type', 'keyboard.type');
    patchInputDevice(keyboard, 'insertText', 'keyboard.insertText');
    const extendedPage = page as import('playwright').Page & {
      setTextSelection?: (locator: import('playwright').Locator, input: BrowserTextSelectionSpec) => Promise<unknown>;
    };
    if (typeof extendedPage.setTextSelection !== 'function') {
      Object.defineProperty(extendedPage, 'setTextSelection', {
        configurable: false,
        enumerable: false,
        value: (locator: import('playwright').Locator, input: BrowserTextSelectionSpec) => setTextSelection(page, locator, input),
        writable: false,
      });
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
    recordAction('tab.use');
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

  type BrowserCodeVerifyStateInput = {
    description: string;
    locator?: import('playwright').Locator | string;
    state?: 'visible' | 'hidden' | 'attached' | 'detached' | 'editable' | 'enabled' | 'checked' | 'filled' | 'value' | 'text' | 'attribute';
    attribute?: string;
    equals?: string;
    includes?: string;
    url?: string | RegExp;
    activeSurface?: 'opened' | 'closed' | 'changed' | 'present' | 'absent';
  };

  const verifyPageState = async (
    page: import('playwright').Page,
    input: BrowserCodeVerifyStateInput,
  ) => {
    if (!activeExecution) throw new Error('page.verifyState() is only available while browserCode is executing.');
    const lastAction = lastActionObservationByPage.get(page);
    const description = String(input?.description || '').trim();
    if (!description) throw new Error('page.verifyState() requires a concise expected business-state description.');
    const checks: Array<{ name: string; ok: boolean; actual: unknown }> = [];
    const current = await readUnifiedPageObservation(page);
    if (input.url !== undefined) {
      const expected = input.url;
      const currentUrl = page.url();
      const regexLike = expected && typeof expected === 'object' && typeof Reflect.get(expected, 'test') === 'function';
      const ok = regexLike
        ? Boolean(Reflect.apply(Reflect.get(expected, 'test') as (...args: unknown[]) => unknown, expected, [currentUrl]))
        : currentUrl === String(expected);
      checks.push({ name: 'url', ok, actual: compactObservationUrl(currentUrl) });
    }
    if (input.activeSurface) {
      if (
        ['opened', 'closed', 'changed'].includes(input.activeSurface)
        && !lastAction?.before
      ) {
        throw new Error(
          `page.verifyState() activeSurface="${input.activeSurface}" requires a preceding browser action observation. `
          + 'Use activeSurface="present"/"absent" for a standalone current-state check.',
        );
      }
      const beforeId = lastAction?.before?.activeSurface?.id || '';
      const currentId = current.activeSurface?.id || '';
      const ok = input.activeSurface === 'opened'
        ? !beforeId && Boolean(currentId)
        : input.activeSurface === 'closed'
          ? Boolean(beforeId) && !currentId
          : input.activeSurface === 'changed'
            ? beforeId !== currentId
            : input.activeSurface === 'present'
              ? Boolean(currentId)
              : !currentId;
      checks.push({
        name: `activeSurface:${input.activeSurface}`,
        ok,
        actual: current.activeSurface || null,
      });
    }
    const locatorInput = input?.locator;
    let locator: import('playwright').Locator | undefined;
    if (typeof locatorInput === 'string') {
      locator = page.locator(locatorInput);
    } else if (locatorInput !== undefined) {
      if (
        !locatorInput
        || typeof locatorInput !== 'object'
        || typeof Reflect.get(locatorInput, 'count') !== 'function'
        || typeof Reflect.get(locatorInput, 'evaluate') !== 'function'
      ) {
        throw new Error(
          'page.verifyState() locator must be a Playwright Locator from the active page or a selector string.',
        );
      }
      locator = locatorInput;
    }
    if (locator) {
      const count = await locator.count();
      const state = input.state || (input.equals !== undefined || input.includes !== undefined ? 'text' : undefined);
      if (!state) throw new Error('page.verifyState() locator verification requires state, equals, or includes.');
      if (state === 'detached') {
        checks.push({ name: 'locator:detached', ok: count === 0, actual: { count } });
      } else if (state === 'hidden') {
        const hidden = count === 0 || count === 1 && !await locator.isVisible().catch(() => false);
        checks.push({ name: 'locator:hidden', ok: hidden, actual: { count } });
      } else {
        if (count !== 1) {
          checks.push({ name: `locator:${state}`, ok: false, actual: { count } });
        } else {
          let actual: unknown;
          let ok = false;
          if (state === 'visible') {
            actual = await locator.isVisible().catch(() => false);
            ok = actual === true;
          } else if (state === 'attached') {
            actual = { count };
            ok = true;
          } else if (state === 'editable') {
            actual = await locator.isEditable().catch(() => false);
            ok = actual === true;
          } else if (state === 'enabled') {
            actual = await locator.isEnabled().catch(() => false);
            ok = actual === true;
          } else if (state === 'checked') {
            actual = await locator.isChecked().catch(() => false);
            ok = actual === true;
          } else {
            actual = state === 'filled'
              ? await locator.evaluate((element) => {
                if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
                  return element.value.length;
                }
                return ((element as HTMLElement).innerText || element.textContent || '').length;
              }).catch(() => 0)
              : state === 'text'
              ? await locator.innerText().catch(() => '')
              : state === 'attribute'
                ? input.attribute
                  ? await locator.getAttribute(input.attribute).catch(() => null)
                  : null
                : await locator.evaluate((element) => {
                if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
                  return element.value;
                }
                return (element as HTMLElement).innerText || element.textContent || '';
              }).catch(() => '');
            const text = String(actual ?? '');
            if (state === 'attribute' && !input.attribute) {
              ok = false;
            } else if (state === 'filled') ok = Number(actual) > 0;
            else if (input.equals !== undefined) ok = text === String(input.equals);
            else if (input.includes !== undefined) ok = text.includes(String(input.includes));
            else ok = true;
          }
          checks.push({ name: `locator:${state}`, ok, actual });
        }
      }
    }
    if (!checks.length) {
      throw new Error('page.verifyState() requires url, activeSurface, or locator state evidence.');
    }
    const passed = checks.every((check) => check.ok);
    const detail = `${description}: ${checks.map((check) => `${check.name}=${check.ok}`).join(', ')}`;
    activeExecution.verification = {
      status: passed ? 'passed' : 'failed',
      detail,
    };
    if (!passed) {
      throw new Error(
        `BUSINESS_STATE_VERIFICATION_FAILED: ${detail}. `
        + 'Do not repeat the operation. Re-observe the latest page state and decide the next single step.',
      );
    }
    return {
      ok: true,
      description,
      checks,
      observation: current,
    };
  };

  const setTextSelection = async (
    page: import('playwright').Page,
    locatorInput: import('playwright').Locator,
    input: BrowserTextSelectionSpec,
  ) => {
    if (!activeExecution) throw new Error('page.setTextSelection() is only available while browserCode is executing.');
    if (
      !locatorInput
      || typeof locatorInput !== 'object'
      || typeof Reflect.get(locatorInput, 'evaluate') !== 'function'
      || locatorPage(locatorInput) !== page
    ) {
      throw new Error('page.setTextSelection() requires a real Playwright Locator from the same Page, including a locator inside one of its frames. Call the method on the locator owner Page.');
    }
    const actionableLocator = await resolveActionableLocator(locatorInput, 'focus');
    await actionableLocator.focus();
    const before = await actionableLocator.evaluate((element) => {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value;
      if (element instanceof HTMLElement && element.isContentEditable) {
        const editable = element.closest('[contenteditable=""], [contenteditable="true"]') || element;
        return editable.textContent || '';
      }
      throw new Error('Target is not an editable input, textarea, or contenteditable element.');
    });
    const occurrenceOffset = (needle: string, occurrenceValue: unknown, label: string) => {
      if (!needle) throw new Error(`${label} text cannot be empty.`);
      const occurrence = occurrenceValue === undefined ? 1 : Number(occurrenceValue);
      if (!Number.isInteger(occurrence) || occurrence < 1) throw new Error(`${label} occurrence must be a positive integer.`);
      let offset = -1;
      let searchFrom = 0;
      for (let index = 0; index < occurrence; index += 1) {
        offset = before.indexOf(needle, searchFrom);
        if (offset < 0) break;
        searchFrom = offset + needle.length;
      }
      if (offset < 0) throw new Error(`${label} occurrence ${occurrence} was not found in the editable text.`);
      return offset;
    };
    const anchorOffset = (anchor: { offset?: number; afterText?: string; beforeText?: string; occurrence?: number }, label: string) => {
      const hasOffset = anchor?.offset !== undefined;
      const hasAfterText = anchor?.afterText !== undefined;
      const hasBeforeText = anchor?.beforeText !== undefined;
      if (Number(hasOffset) + Number(hasAfterText) + Number(hasBeforeText) !== 1) {
        throw new Error(`${label} requires exactly one of offset, afterText, or beforeText.`);
      }
      if (hasOffset) {
        if (!Number.isInteger(anchor.offset) || Number(anchor.offset) < 0) throw new Error(`${label} offset must be a non-negative integer.`);
        if (anchor.occurrence !== undefined) throw new Error(`${label} occurrence is available only with afterText or beforeText.`);
        return Number(anchor.offset);
      }
      const needle = hasAfterText ? String(anchor.afterText) : String(anchor.beforeText);
      const found = occurrenceOffset(needle, anchor.occurrence, label);
      return hasAfterText ? found + needle.length : found;
    };
    let start: number;
    let end: number;
    if ('exactText' in input) {
      start = occurrenceOffset(input.exactText, input.occurrence, 'Selection text');
      end = start + input.exactText.length;
    } else {
      start = anchorOffset(input.start, 'Selection start');
      end = input.end ? anchorOffset(input.end, 'Selection end') : start;
    }
    if (start > before.length || end > before.length) throw new Error(`Selection range ${start}-${end} exceeds editable text length ${before.length}.`);
    if (end < start) throw new Error(`Selection end ${end} cannot precede start ${start}.`);
    const selection = {
      before,
      collapsed: start === end,
      direction: input.direction === 'backward' ? 'backward' as const : 'forward' as const,
      end,
      selectedText: before.slice(start, end),
      start,
    };
    await actionableLocator.evaluate((element, range) => {
      const inputElement = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element
        : undefined;
      const editable = inputElement
        ? inputElement
        : element instanceof HTMLElement && element.isContentEditable
          ? element.closest('[contenteditable=""], [contenteditable="true"]') || element
          : undefined;
      if (!editable) throw new Error('Target is not an editable input, textarea, or contenteditable element.');
      if (inputElement) {
        inputElement.setSelectionRange(range.start, range.end, range.direction);
        return;
      }
      const startWalker = editable.ownerDocument.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
      let startTraversed = 0;
      let startNode: Node = editable;
      let startOffset = editable.childNodes.length;
      let startMapped = range.start === 0 && !startWalker.currentNode.textContent;
      let startTextNode = startWalker.nextNode();
      while (startTextNode) {
        const nodeLength = startTextNode.textContent?.length || 0;
        if (range.start <= startTraversed + nodeLength) {
          startNode = startTextNode;
          startOffset = range.start - startTraversed;
          startMapped = true;
          break;
        }
        startTraversed += nodeLength;
        startTextNode = startWalker.nextNode();
      }
      if (!startMapped && range.start !== startTraversed) throw new Error(`Selection offset ${range.start} could not be mapped to the editable DOM.`);
      const endWalker = editable.ownerDocument.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
      let endTraversed = 0;
      let endNode: Node = editable;
      let endOffset = editable.childNodes.length;
      let endMapped = range.end === 0 && !endWalker.currentNode.textContent;
      let endTextNode = endWalker.nextNode();
      while (endTextNode) {
        const nodeLength = endTextNode.textContent?.length || 0;
        if (range.end <= endTraversed + nodeLength) {
          endNode = endTextNode;
          endOffset = range.end - endTraversed;
          endMapped = true;
          break;
        }
        endTraversed += nodeLength;
        endTextNode = endWalker.nextNode();
      }
      if (!endMapped && range.end !== endTraversed) throw new Error(`Selection offset ${range.end} could not be mapped to the editable DOM.`);
      const browserSelection = editable.ownerDocument.defaultView?.getSelection();
      if (!browserSelection) throw new Error('The editable document does not expose a text selection.');
      browserSelection.removeAllRanges();
      if (range.direction === 'backward' && typeof browserSelection.setBaseAndExtent === 'function') {
        browserSelection.setBaseAndExtent(endNode, endOffset, startNode, startOffset);
      } else {
        const domRange = editable.ownerDocument.createRange();
        domRange.setStart(startNode, startOffset);
        domRange.setEnd(endNode, endOffset);
        browserSelection.addRange(domRange);
      }
    }, { direction: selection.direction, end: selection.end, start: selection.start });
    return {
      collapsed: selection.collapsed,
      direction: selection.direction,
      editableTextLength: selection.before.length,
      end: selection.end,
      selectedText: selection.selectedText,
      start: selection.start,
      verified: true,
    };
  };

  function tabForPage(page: import('playwright').Page) {
    decoratePage(page);
    const existing = tabWrappers.get(page);
    if (existing) return existing;
    const extendedPage = page as import('playwright').Page & {
      domSnapshot?: (options?: { scope?: 'active' | 'all' }) => Promise<string>;
      activeSurface?: () => Promise<Pick<KernelPageObservation, 'activeSurface' | 'surfaces' | 'surfaceStack' | 'topSurfaceIds'>>;
      setTextSelection?: (locator: import('playwright').Locator, input: BrowserTextSelectionSpec) => Promise<unknown>;
      verifyState?: (input: BrowserCodeVerifyStateInput) => Promise<unknown>;
      expectNavigation?: <T>(action: () => Promise<T>, options?: { timeoutMs?: number; url?: string | RegExp; waitUntil?: NonNullable<Parameters<import('playwright').Page['waitForURL']>[1]>['waitUntil'] }) => Promise<T>;
    };
    if (typeof extendedPage.domSnapshot !== 'function') {
      Object.defineProperty(extendedPage, 'domSnapshot', {
        configurable: false,
        enumerable: false,
        value: async (options: { scope?: 'active' | 'all' } = {}) => {
          const observationResult = await settleKernelTask(
            readUnifiedPageObservation(page),
            browserCodePageObservationTimeoutMs,
            'page observation',
          );
          const observation: KernelPageObservation = observationResult.ok
            ? observationResult.value
            : {
              epoch: 0,
              url: compactObservationUrl(page.url()),
              title: '',
              surfaces: [],
              surfaceStack: [],
              topSurfaceIds: [],
              surfaceTransition: 'initial',
            };
          const scope = options.scope || 'active';
          const targetFrame = observation.activeSurface?.framePath
            ? page.frames().find((frame) => frame.url() === observation.activeSurface?.framePath) || page.mainFrame()
            : page.mainFrame();
          const axResult = await settleKernelTask((async () => {
            if (scope === 'active' && observation.activeSurface) {
              const semanticSurfaceSelector = 'dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';
              const selectedSurface = observation.activeSurface.selector
                ? targetFrame.locator(observation.activeSurface.selector).filter({ visible: true })
                : targetFrame.locator(semanticSurfaceSelector).filter({ visible: true }).last();
              return await selectedSurface.count()
                ? selectedSurface.first().ariaSnapshot({ timeout: browserCodeActionTimeoutMs })
                : targetFrame.locator('body').ariaSnapshot({ timeout: browserCodeActionTimeoutMs });
            }
            return page.locator('body').ariaSnapshot({ timeout: browserCodeActionTimeoutMs });
          })(), browserCodeAxSnapshotTimeoutMs, 'AX snapshot');
          const warnings = [
            ...(!observationResult.ok ? [observationResult.error] : []),
            ...(!axResult.ok ? [axResult.error] : []),
          ];
          let snapshot = axResult.ok ? axResult.value : '';
          if (!snapshot) {
            const fallbackResult = await settleKernelTask(
              targetFrame.locator('body').innerText({ timeout: browserCodeSnapshotFallbackTimeoutMs }),
              browserCodeSnapshotFallbackTimeoutMs,
              'snapshot text fallback',
            );
            snapshot = fallbackResult.ok && fallbackResult.value.trim()
              ? `[text-fallback]\n${fallbackResult.value.trim().slice(0, 12_000)}`
              : '[snapshot unavailable]';
            if (!fallbackResult.ok) warnings.push(fallbackResult.error);
          }
          return [
            `[page-state] ${JSON.stringify(observation)}`,
            ...(warnings.length ? [`[snapshot-warning] ${warnings.join('; ')}`] : []),
            `[ax-tree scope=${scope}]`,
            snapshot,
          ].join('\n');
        },
        writable: false,
      });
    }
    if (typeof extendedPage.activeSurface !== 'function') {
      Object.defineProperty(extendedPage, 'activeSurface', {
        configurable: false,
        enumerable: false,
        value: async () => {
          const observation = await readUnifiedPageObservation(page);
          return {
            activeSurface: observation.activeSurface,
            surfaces: observation.surfaces,
            surfaceStack: observation.surfaceStack,
            topSurfaceIds: observation.topSurfaceIds,
          };
        },
        writable: false,
      });
    }
    if (typeof extendedPage.verifyState !== 'function') {
      Object.defineProperty(extendedPage, 'verifyState', {
        configurable: false,
        enumerable: false,
        value: (input: BrowserCodeVerifyStateInput) => verifyPageState(page, input),
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
      close: () => {
        recordAction('tab.close');
        return page.close();
      },
      goto: (url: string, options?: Parameters<import('playwright').Page['goto']>[1]) => {
        recordAction('tab.goto');
        return page.goto(url, options);
      },
      screenshot: (options: Parameters<import('playwright').Page['screenshot']>[0] = {}) => page.screenshot(options),
      title: () => page.title(),
      url: () => page.url(),
      use: () => selectPage(page),
    });
    tabPages.set(wrapper, page);
    tabWrappers.set(page, wrapper);
    return wrapper;
  }

  const tabInfo = async (page: import('playwright').Page) => {
    const group = await page.evaluate(() => ({
      id: document.documentElement.getAttribute('data-ai-web-test-session-group-id') || undefined,
      title: document.documentElement.getAttribute('data-ai-web-test-session-group-title') || undefined,
    })).catch(() => ({ id: undefined, title: undefined }));
    return {
      id: tabId(page),
      active: replServer?.context.page === page,
      groupId: group.id,
      groupTitle: group.title,
      lastOpened: Date.now(),
      title: await page.title().catch(() => ''),
      url: page.url(),
    };
  };

  const currentPages = () => browser
    ? browser.contexts().flatMap((candidateContext) => candidateContext.pages()).filter((candidatePage) => !candidatePage.isClosed())
    : [];

  const currentSessionTabEntries = async () => {
    const entries = await Promise.all(currentPages().map(async (candidatePage) => ({
      info: await tabInfo(candidatePage),
      page: candidatePage,
    })));
    if (!sessionGroupId) return entries;
    return entries.filter((entry) => entry.info.groupId === sessionGroupId);
  };

  const browserRuntime = Object.freeze({
    capabilities: Object.freeze({ cua: true, images: true, playwright: true, tabLifecycle: true }),
    documentation: async () => [
      'browserCode exposes one controlled browser runtime in ordinary JavaScript.',
      'Use browser.tabs.list()/new()/use()/finalize(), browser.user.openTabs()/claimTab(), tab.playwright, tab.cua, page.domSnapshot(), page.activeSurface(), page.setTextSelection(), page.verifyState(), page.expectNavigation(), attachmentVault.setInputFiles(), and nodeRepl.emitImage().',
      'page.domSnapshot() returns page-state plus a read-only Playwright AX tree scoped to the active surface by default; pass { scope: "all" } only for background context. browser.user.openTabs() reports only tabs owned by the current conversation group, with active-tab and tab-group metadata.',
      'Page and Locator factory methods expose only currently rendered matches: CSS-hidden descendants and zero-rectangle nodes are excluded before count() and positional selection. aria-hidden changes accessibility exposure but does not by itself make a geometrically rendered target invisible or unactionable. Element actions then validate target computed style and hit testing, run an action-specific Playwright trial for every remaining pointer candidate, and execute only the unique candidate that passes all stages; CSS-hidden file inputs used by setInputFiles are recovered only at that action boundary.',
      'page.verifyState() is an optional read-only assertion helper; it never gates later actions or successful cell completion.',
      'Every session Page exposes setTextSelection(locator, spec). Call it on the Page that owns the locator, including for frame locators, then use that same Page keyboard.insertText()/press() in the same cell. Use browser.tabs.use(tab) or tab.use() when the global page binding should switch tabs.',
      `Playwright action timeout: ${browserCodeActionTimeoutMs}ms; navigation timeout: ${browserCodeNavigationTimeoutMs}ms.`,
      `Playwright screenshot timeout: ${browserCodeScreenshotTimeoutMs}ms unless an explicit positive timeout is provided.`,
    ].join('\n'),
    id: 'current',
    name: 'Current browser session',
    nameSession: async (name: string) => { void name; },
    tabs: Object.freeze({
      finalize: async (input: { keep?: Array<{ status: 'deliverable' | 'handoff'; tab: unknown }> } = {}) => {
        recordAction('tabs.finalize');
        const keepPages = new Set((input.keep || []).map((item) => pageFromTab(item.tab)).filter(Boolean));
        const closing = [...agentCreatedPages].filter((candidatePage) => !candidatePage.isClosed() && !keepPages.has(candidatePage));
        await Promise.all(closing.map((candidatePage) => candidatePage.close().catch(() => undefined)));
        for (const candidatePage of [...agentCreatedPages]) {
          if (candidatePage.isClosed() || keepPages.has(candidatePage)) agentCreatedPages.delete(candidatePage);
        }
        return Promise.all([...keepPages].filter(Boolean).map((candidatePage) => tabInfo(candidatePage!)));
      },
      list: async () => (await currentSessionTabEntries()).map((entry) => tabForPage(entry.page)),
      new: async (options: { url?: string } = {}) => {
        recordAction('tabs.new');
        const selected = replServer?.context.context as import('playwright').BrowserContext | undefined;
        const targetContext = selected || browser?.contexts()[0];
        if (!targetContext) throw new Error('No browser context is available.');
        const newPage = await createSessionPage(targetContext);
        agentCreatedPages.add(newPage);
        selectPage(newPage);
        if (options.url) await newPage.goto(options.url);
        return tabForPage(newPage);
      },
      use: async (value: unknown) => {
        const selectedPage = pageFromTab(value);
        if (!selectedPage) throw new Error('The requested browser tab is no longer available.');
        if (sessionGroupId) {
          const selectedTabInfo = await tabInfo(selectedPage);
          if (selectedTabInfo.groupId !== sessionGroupId) {
            throw new Error('The requested browser tab does not belong to the current conversation tab group.');
          }
        }
        selectPage(selectedPage);
        return tabForPage(selectedPage);
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
        if (sessionGroupId) {
          const claimedTabInfo = await tabInfo(claimedPage);
          if (claimedTabInfo.groupId !== sessionGroupId) {
            throw new Error('The requested browser tab does not belong to the current conversation tab group.');
          }
        }
        selectPage(claimedPage);
        return tabForPage(claimedPage);
      },
      openTabs: async () => (await currentSessionTabEntries()).map((entry) => entry.info),
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

  const initialize = async (input: { connection: BrowserCodeConnection; sessionGroupId?: string }) => {
    if (browser || replServer) return;
    sessionGroupId = String(input.sessionGroupId || '').trim();
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
      attachmentVault: { configurable: false, enumerable: true, value: attachmentVault, writable: false },
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
    attachments?: BrowserCodeAttachmentBinding[];
    credentials?: BrowserCodeCredentialBinding[];
    executionId: string;
    maxOutputChars?: number;
    requestId: string;
  }) => {
    if (!replServer) throw new Error('browserCode JavaScript kernel is not initialized.');
    const page = await findExecutionPage(input.executionId);
    const browserContext = page.context();
    const initialPage = page;
    const initialUrl = page.url();
    const initialPageCount = browserContext.pages().filter((candidatePage) => !candidatePage.isClosed()).length;
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
      actions: [],
      imageBytes: 0,
      images: [],
      logs: [],
      outputs: [],
      startedAt: Date.now(),
      attachments: new Map((input.attachments || []).map((attachment) => [attachment.ref, attachment])),
      credentials: new Map((input.credentials || []).map((credential) => [credential.ref, credential])),
      pendingCoordinateClickEvidence: new Map(),
      observationsBeforeAction: new WeakMap(),
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
      const finalPage = selectedPage && !selectedPage.isClosed() ? selectedPage : undefined;
      const finalPageCount = browserContext.pages().filter((candidatePage) => !candidatePage.isClosed()).length;
      const navigationChanged = Boolean(finalPage && finalPage.url() !== initialUrl);
      const tabChanged = finalPage !== initialPage || finalPageCount !== initialPageCount;
      const activity: BrowserCodeActivity = {
        actions: [...activeExecution.actions],
        navigationChanged,
        tabChanged,
        ...(activeExecution.verification ? { verification: activeExecution.verification } : {}),
      };
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
        activity,
        memoryUsage: hostProcess.memoryUsage(),
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
        activity: {
          actions: [...activeExecution.actions],
          navigationChanged: false,
          tabChanged: false,
          ...(activeExecution.verification ? { verification: activeExecution.verification } : {}),
        },
        memoryUsage: hostProcess.memoryUsage(),
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
        await initialize(input as { connection: BrowserCodeConnection; sessionGroupId?: string });
        return;
      }
      if (input.type === 'execute') {
        await execute(input as {
          code: string;
          attachments?: BrowserCodeAttachmentBinding[];
          credentials?: BrowserCodeCredentialBinding[];
          executionId: string;
          maxOutputChars?: number;
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
        memoryUsage: hostProcess.memoryUsage(),
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
  private childStartedAt = 0;
  private closed = false;
  private executionCount = 0;
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

    const maxOutputChars = typeof input.maxOutputChars === 'number'
      ? Math.max(1_000, Math.floor(input.maxOutputChars))
      : undefined;
    let attachmentBindings: BrowserCodeAttachmentBinding[] = [];
    if (/\battachmentVault\s*\.\s*setInputFiles\s*\(/i.test(browserCodeWithoutComments(input.code))) {
      try {
        if (!this.tempDir) throw new Error('browserCode attachment staging directory is unavailable.');
        attachmentBindings = (input.attachments || []).map((attachment, index) => {
          const fileName = path.basename(String(attachment.name || '').trim()) || 'attachment';
          const stagingDir = path.join(this.tempDir!, 'attachments', `${index}-${randomUUID()}`);
          mkdirSync(stagingDir, { recursive: true });
          const stagedPath = path.join(stagingDir, fileName);
          copyFileSync(attachment.path, stagedPath);
          return { name: fileName, path: stagedPath, ref: String(attachment.ref || '') };
        });
      } catch (error) {
        return {
          ok: false,
          error: `Unable to stage the registered user attachment: ${error instanceof Error ? error.message : String(error)}`,
          elapsedMs: Date.now() - startedAt,
          logs: [],
        };
      }
    }
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
        attachments: attachmentBindings.map((attachment) => ({
          name: String(attachment.name || ''),
          path: String(attachment.path || ''),
          ref: String(attachment.ref || ''),
        })),
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
    this.childStartedAt = Date.now();
    this.executionCount = 0;
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
    child.send({
      type: 'init',
      connection: this.connection,
      sessionGroupId: String(this.options.sessionGroupId || '').trim(),
    }, (error) => {
      if (!error) return;
      this.rejectReady(error);
      this.stopChild();
    });
    return readyPromise;
  }

  private kernelResetAfterResult(record: Record<string, unknown>): BrowserCodeRunResult['kernelReset'] {
    this.executionCount += 1;
    const memoryRecord = record.memoryUsage && typeof record.memoryUsage === 'object' && !Array.isArray(record.memoryUsage)
      ? record.memoryUsage as Record<string, unknown>
      : undefined;
    const numberValue = (key: string) => {
      const value = Number(memoryRecord?.[key]);
      return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
    };
    const memoryUsage: BrowserCodeKernelMemoryUsage | undefined = memoryRecord ? {
      arrayBuffers: numberValue('arrayBuffers'),
      external: numberValue('external'),
      heapTotal: numberValue('heapTotal'),
      heapUsed: numberValue('heapUsed'),
      rss: numberValue('rss'),
    } : undefined;
    const mb = 1024 * 1024;
    const maxHeapBytes = boundedInteger(
      this.options.maxHeapBytes ?? Number(process.env.AI_BROWSER_CODE_KERNEL_MAX_HEAP_MB || 96) * mb,
      96 * mb,
      16 * mb,
      1024 * mb,
    );
    const maxRssBytes = boundedInteger(
      this.options.maxRssBytes ?? Number(process.env.AI_BROWSER_CODE_KERNEL_MAX_RSS_MB || 384) * mb,
      384 * mb,
      32 * mb,
      4 * 1024 * mb,
    );
    const maxExecutions = boundedInteger(
      this.options.maxExecutions ?? process.env.AI_BROWSER_CODE_KERNEL_MAX_EXECUTIONS,
      80,
      1,
      1_000,
    );
    const maxAgeMs = boundedInteger(
      this.options.maxAgeMs ?? process.env.AI_BROWSER_CODE_KERNEL_MAX_AGE_MS,
      20 * 60_000,
      60_000,
      4 * 60 * 60_000,
    );
    if (memoryUsage && memoryUsage.heapUsed >= maxHeapBytes) return { reason: 'heap-limit', memoryUsage };
    if (memoryUsage && memoryUsage.rss >= maxRssBytes) return { reason: 'rss-limit', memoryUsage };
    if (this.executionCount >= maxExecutions) return { reason: 'execution-limit', memoryUsage };
    if (this.childStartedAt && Date.now() - this.childStartedAt >= maxAgeMs) return { reason: 'age-limit', memoryUsage };
    return undefined;
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
    const kernelReset = this.kernelResetAfterResult(record);
    if (record.ok === true) {
      this.finishPending({
        ok: true,
        value: record.value,
        logs,
        images,
        selectedExecutionId: typeof record.selectedExecutionId === 'string' ? record.selectedExecutionId : undefined,
        activity: record.activity && typeof record.activity === 'object'
          ? record.activity as BrowserCodeActivity
          : undefined,
        kernelReset,
      });
    } else {
      this.finishPending({
        ok: false,
        error: typeof record.error === 'string' ? record.error : 'browserCode execution failed.',
        images,
        logs,
        activity: record.activity && typeof record.activity === 'object'
          ? record.activity as BrowserCodeActivity
          : undefined,
        kernelReset,
      });
    }
    if (kernelReset) this.stopChild();
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
    this.childStartedAt = 0;
    this.executionCount = 0;
    this.readyPromise = undefined;
    this.tempDir = undefined;
    this.clearExecutionTimer();
    this.clearReadyTimer();
    if (child && !child.killed) child.kill();
    removeBrowserCodeTempDir(tempDir);
  }
}
