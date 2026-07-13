import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Browser, BrowserContext, BrowserContextOptions, BrowserType, ElementHandle, Frame, LaunchOptions, Locator, Page, Request, Worker as PlaywrightWorker } from 'playwright';
import { artifactPath } from '@/server/storage/paths';
import {
  boundedNonNegativeIntegerEnv,
  boundedPositiveIntegerEnv,
  browserTabTitlePrefixEnabled,
  cdpEndpointForPort,
  cdpPortFromEndpoint,
  electronEmbeddedBrowserCdpEndpoint,
  electronEmbeddedBrowserEnabled,
  normalizePageGroupId,
  numericLimitFromEnv,
  positiveIntegerEnv,
  sessionTabGrouperDebugPort,
  sessionTabGrouperEnabled,
  sessionTabGrouperProfileDir,
  sharedBrowserTabsEnabled,
  withSessionTabGrouperArgs,
} from './browser-session-runtime';
import {
  buildSnapshotViews,
  captureAxSnapshot,
  snapshotRoleIsActionable,
  type CapturedSnapshotFrame,
  type SnapshotNodeWithUid,
  type SnapshotRecord,
  type SnapshotView,
} from './ax-snapshot';
import { captureDomSnapshot } from './dom-snapshot';

function shouldIgnoreNetworkFailure(url: string, errorText?: string) {
  if (errorText === 'net::ERR_ABORTED' && /analytics|collector|apm|beacon|log|track/i.test(url)) return true;
  return /zhihu-web-analytics|datahub\.zhihu|apm\.zhihu|local\.adspower|118\.89\.204\.198/i.test(url);
}

function snapshotFrameUrl(value?: string) {
  try {
    const url = new URL(value || '');
    url.hash = '';
    return url.href;
  } catch {
    return String(value || '').split('#', 1)[0];
  }
}

function shouldIgnoreConsoleError(text: string) {
  return (
    /zhihu-web-analytics|datahub\.zhihu|apm\.zhihu|local\.adspower|118\.89\.204\.198/i.test(text) ||
    /collector|analytics|beacon|mixed content|cors policy|failed to load resource/i.test(text)
  );
}


const DEFAULT_SCREENSHOT_TIMEOUT_MS = 15000;
const MIN_SCREENSHOT_TIMEOUT_MS = 1000;
const MAX_SCREENSHOT_TIMEOUT_MS = 120000;
const SCREENSHOT_FAILURE_CONTEXT_TIMEOUT_MS = 2000;
const DEFAULT_BROWSER_ACTION_LOAD_STATE_TIMEOUT_MS = 3000;
const DEFAULT_BROWSER_POPUP_WAIT_MS = 0;
const DEFAULT_BROWSER_WAIT_FOR_PAGE_LOAD_STATE_TIMEOUT_MS = 1500;
const DEFAULT_BROWSER_WAIT_FOR_PAGE_STABLE_MS = 250;



function compactDiagnosticText(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function unknownErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function stringifyDiagnosticValue(value: unknown) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export type BrowserSessionMode = 'dom';

export type BrowserSessionOptions = {
  isMarked?: boolean;
  runId?: string;
  preferExistingPage?: boolean;
  browserProfileKey?: string;
  debugDevtools?: boolean;
  headless?: boolean;
  isolated?: boolean;
};

export type AccessibilitySnapshotExportControlResult = {
  ok: boolean;
  fileName?: string;
  path?: string;
  downloadUrl?: string;
  error?: string;
};

/**
 * 浏览器请求鉴定模式
 * @returns 鉴定模式
 */
function browserSessionModeFromEnv(): BrowserSessionMode {
  return 'dom';
}

export type BrowserSnapshotView = 'actionable' | 'full' | 'text' | 'changes';

export type BrowserSnapshotViews = Partial<Record<BrowserSnapshotView, string>> & {
  defaultType?: BrowserSnapshotView;
};

export type BrowserActionResult = {
  ok: boolean;
  actual: string;
  observationViews?: BrowserSnapshotViews;
  autoSnapshot?: {
    generationId: string;
    refreshed: boolean;
  };
  debug?: {
    fullDomSnapshot?: string;
    fullDomSnapshotCharLength?: number;
    domSnapshotPromptCharLimit?: number;
    domSnapshotTruncatedForModel?: boolean;
  };
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

type CandidateDomState = {
  descriptor?: string;
  tagName?: string;
  type?: string;
  valueLength?: number;
  checked?: boolean;
  selectedIndex?: number;
  ariaPressed?: string;
  ariaExpanded?: string;
  disabled?: boolean;
  text?: string;
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
  capture: ScreenshotCaptureMode;
  generation: number;
  page: Page;
  url: string;
  scrollX: number;
  scrollY: number;
  capturedAt: number;
};

type ScreenshotTimingStep = {
  name: string;
  elapsedMs: number;
  skipped?: boolean;
  count?: number;
  path?: string;
  error?: string;
};

type ScreenshotTiming = {
  phase: string;
  capture: ScreenshotCaptureMode;
  totalMs: number;
  path: string;
  markerPath?: string;
  originalPath?: string;
  candidateCount: number;
  scrollAreaCount: number;
  candidateLabelsEnabled: boolean;
  scrollAreaLabelsEnabled: boolean;
  separateMarkerMap: boolean;
  steps: ScreenshotTimingStep[];
};

function formatScreenshotTimingStep(step: ScreenshotTimingStep) {
  const parts = [`${step.name}=${step.elapsedMs}ms`];
  if (step.count !== undefined) parts.push(`count=${step.count}`);
  if (step.skipped) parts.push('skip');
  if (step.error) parts.push(`error=${step.error}`);
  return parts.join(' ');
}

function formatScreenshotTimingSummary(timing?: ScreenshotTiming) {
  if (!timing) return '';
  const steps = timing.steps.map(formatScreenshotTimingStep).join(' | ');
  return `screenshot timing: total=${timing.totalMs}ms, candidates=${timing.candidateCount}, scrollAreas=${timing.scrollAreaCount}; ${steps}`;
}

export type ScreenshotCaptureMode = 'viewport' | 'fullPage';

type ScreenshotCaptureOptions = {
  capture?: ScreenshotCaptureMode;
};

type InteractiveCandidate = {
  id: string;
  path: string;
  tag: string;
  role?: string;
  type?: string;
  name?: string;
  text?: string;
  className?: string;
  signals?: string[];
  nearbyText?: string;
  href?: string;
  host?: string;
  opensExternalApp?: boolean;
  externalAppProtocol?: string;
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

type DomNodeReference = {
  id: string;
  interactive: boolean;
  capabilities?: DomActionCapability[];
  confidence?: DomActionConfidence;
  contextId?: string;
  label: string;
  line: string;
  locatorCandidates?: string[];
  localRef?: string;
  path: string;
  signals?: string[];
  framePath?: string;
  frameUrl?: string;
  descriptor: string;
  state: string;
  tag: string;
  viewportClip?: BrowserUseViewportClip;
};

type PageInteractiveCandidate = Omit<InteractiveCandidate, 'framePath' | 'frameUrl'>;

type PageDomObservationPayload = {
  structuredText: string;
  interactiveCandidates: PageInteractiveCandidate[];
};

type ScrollableArea = {
  id: string;
  path: string;
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  rect: { x: number; y: number; width: number; height: number };
  center: { x: number; y: number };
  scroll: {
    top: number;
    left: number;
    height: number;
    width: number;
    clientHeight: number;
    clientWidth: number;
    maxTop: number;
    maxLeft: number;
    remainingUp: number;
    remainingDown: number;
    remainingLeft: number;
    remainingRight: number;
    atTop: boolean;
    atBottom: boolean;
    atLeft: boolean;
    atRight: boolean;
    canScrollUp: boolean;
    canScrollDown: boolean;
    canScrollLeft: boolean;
    canScrollRight: boolean;
  };
};

type AiDomVisibleRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  raw: DOMRect;
};

type AiDomElementBox = {
  raw: DOMRect;
  visible?: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  vertical: string;
  horizontal: string;
};

type BrowserUseViewportClip = {
  bottom: number;
  left: number;
  right: number;
  top: number;
};

type DomActionCapability = 'click' | 'drag' | 'fill' | 'focus' | 'hover' | 'select';
type DomActionConfidence = 'high' | 'medium' | 'low';

type BrowserUseVisibleDomSnapshot = {
  frameElements: Array<{
    rect: BrowserUseViewportClip;
    ref: string;
    size?: { height: number; width: number };
    url?: string;
  }>;
  items: Array<{
    capabilities: DomActionCapability[];
    confidence: DomActionConfidence;
    contextText: string;
    descriptor: string;
    interactive: boolean;
    label: string;
    line: string;
    locatorCandidates: string[];
    path: string;
    rect?: BrowserUseViewportClip;
    ref: string;
    signals: string[];
    state: string;
    tag: string;
    text: string;
  }>;
  candidateEstimate?: number;
  hasMore?: boolean;
  stateKey: string;
  nextIndex?: number;
  returnedEntries?: number;
  scannedCandidates?: number;
  startIndex?: number;
  totalEntries?: number;
  viewport: BrowserUseViewportClip;
};

export type BrowserDomObservation = {
  actions: string;
  actionsCharLength: number;
  elements: string;
  elementsCharLength: number;
  text: string;
  textCharLength: number;
  tree: string;
  treeCharLength: number;
  domNodeCount: number;
  interactiveNodeCount: number;
  usedWorkers: boolean;
  errors: string[];
  timings: {
    totalMs: number;
  };
};

type BrowserSimplifiedDomTreeResult = {
  tree: string;
  observation: BrowserDomObservation;
};

type AiDomRuntime = {
  version: number;
  mutationState: () => AiDomMutationStateSnapshot;
  isOverlay: (element: Element) => boolean;
  isTraversable: (element: Element) => boolean;
  isRenderable: (element: Element, options?: { requirePointerEvents?: boolean }) => boolean;
  children: (element: Element) => Element[];
  flatParentElement: (node: Node) => Element | undefined;
  composedContains: (ancestor: Element, node: Element) => boolean;
  elementFromPath: (pathValue?: string) => Element | undefined;
  pathOf: (element: Element) => string | undefined;
  descriptor: (element: Element | Document) => string;
  textOf: (element: Element, maxLength?: number) => string;
  recordedEventTypes: (element: Element) => string[];
  hasActionAttribute: (element: Element) => boolean;
  isActionable: (element: Element) => boolean;
  actionableTargetFor: (element: Element) => Element;
  visibleRect: (element: Element, options?: { requirePointerEvents?: boolean }) => AiDomVisibleRect | undefined;
  elementBox: (element: Element) => AiDomElementBox | undefined;
  topmostRenderableAt: (x: number, y: number, options?: { requirePointerEvents?: boolean }) => Element | undefined;
  pointBelongsToElement: (element: Element, x: number, y: number, options?: { requirePointerEvents?: boolean }) => boolean;
  visiblePointForElement: (element: Element, options?: { requirePointerEvents?: boolean }) => ({ x: number; y: number } | undefined);
  visibleDomSnapshot: (options: {
    maxChars: number;
    maxElements: number;
    preserveExistingRefs?: boolean;
    viewportClip?: BrowserUseViewportClip;
  }) => BrowserUseVisibleDomSnapshot;
  fullDomSnapshot: (options: {
    maxChars: number;
    maxElements: number;
    preserveExistingRefs?: boolean;
  }) => BrowserUseVisibleDomSnapshot;
  elementText: (pathValue: string, options?: { maxChars?: number }) => ({ descriptor: string; text: string; textLength: number } | undefined);
  visibleDomPoint: (
    ref: string,
    viewportClip?: BrowserUseViewportClip,
  ) => ({ x: number; y: number; descriptor: string } | undefined);
  visibleDomText: (ref: string, options?: { maxChars?: number }) => ({ descriptor: string; text: string; textLength: number } | undefined);
};

type AiDomMutationStateSnapshot = {
  epoch: number;
  lastMutationAt: number;
};

type BrowserInteractionCounts = Record<string, number>;

type BrowserScrollPosition = {
  descriptor: string;
  left: number;
  top: number;
};

type BrowserActionVerification = {
  ok: boolean;
  detail: string;
};

const aiDomMutationObserverScript = `(() => {
  const win = window;
  if (typeof win.__name !== 'function') {
    Object.defineProperty(win, '__name', {
      configurable: true,
      enumerable: false,
      value(target, value) {
        try { Object.defineProperty(target, 'name', { configurable: true, value }); } catch {}
        return target;
      },
    });
  }
  const state = win.__aiDomMutationState || { epoch: 0, lastMutationAt: Date.now() };
  state.interactionCounts = state.interactionCounts || {};
  state.interactionSequence = Number(state.interactionSequence) || 0;
  win.__aiDomMutationState = state;
  if (!state.observer) {
    state.observer = new MutationObserver((mutations) => {
      let meaningful = false;
      for (const mutation of mutations) {
        const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        if (!target || !target.closest || !target.closest('#__ai_candidate_overlay__, #__ai_last_click_marker__, #__ai_dom_export_control__')) {
          meaningful = true;
          break;
        }
      }
      if (!meaningful) return;
      state.epoch += 1;
      state.lastMutationAt = Date.now();
    });
    state.observer.observe(document, { attributes: true, characterData: true, childList: true, subtree: true });
  }
  if (!state.interactionListenersInstalled) {
    state.interactionListenersInstalled = true;
    const markInteraction = (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target && target.closest('#__ai_candidate_overlay__, #__ai_last_click_marker__, #__ai_dom_export_control__')) return;
      state.interactionSequence += 1;
      state.interactionCounts[event.type] = (state.interactionCounts[event.type] || 0) + 1;
      state.lastInteractionType = event.type;
      state.lastInteractionAt = Date.now();
    };
    for (const type of ['click', 'auxclick', 'contextmenu', 'dblclick', 'input', 'change', 'focusin', 'focusout', 'keydown', 'keyup', 'mousemove', 'mouseover', 'wheel', 'scroll', 'dragstart', 'dragover', 'drop']) {
      document.addEventListener(type, markInteraction, { capture: true, passive: true });
    }
  }
})()`;

type SnapshotReference = {
  uid: string;
  generationId: string;
  page: Page;
  documentId: string;
  frameId: string;
  framePath?: string;
  frameUrl?: string;
  axNodeId?: string;
  backendDOMNodeId?: number;
  selector?: string;
  role: string;
  name: string;
  url?: string;
  actionable: boolean;
  actions: string[];
};

type SnapshotGeneration = {
  id: string;
  createdAt: string;
  page: Page;
  url: string;
  frames: CapturedSnapshotFrame[];
  references: Map<string, SnapshotReference>;
  views: Record<SnapshotView, SnapshotRecord[]>;
  nodeCount: number;
  actionableCount: number;
  skippedFrameCount: number;
  captureSource: 'dom-snapshot' | 'full-ax-fallback';
  mutationEpochs: Record<string, number>;
  timings: {
    totalMs: number;
    captureAxMs: number;
    captureDomMs: number;
    frameTreeMs: number;
    axTreeMs: number;
    axEnrichmentMs: number;
    domFallbackMs: number;
  };
};

export type BrowserMouseAction = {
  action: 'click' | 'move' | 'drag' | 'scroll' | 'scrollIntoView';
  uid?: string;
  xThousandth?: number;
  yThousandth?: number;
  toUid?: string;
  toXThousandth?: number;
  toYThousandth?: number;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
};

export type BrowserKeyboardAction = {
  action: 'type' | 'press' | 'shortcut';
  uid?: string;
  xThousandth?: number;
  yThousandth?: number;
  text?: string;
  key?: string;
  keys?: string[];
  replace?: boolean;
  followByEnter?: boolean;
};

type ResolvedBrowserActionPoint = {
  error?: string;
  reference?: SnapshotReference;
  point?: {
    x: number;
    y: number;
    descriptor: string;
    source: string;
  };
};

type WindowWithAiDomRuntime = Window & {
  __aiBrowserPageRuntimeInstalled?: boolean;
  __aiGetEventListenerTypes?: (target: EventTarget) => string[];
  __aiDomRuntime?: AiDomRuntime;
  __aiDomMutationState?: AiDomMutationStateSnapshot & { observer?: MutationObserver };
  __browserUseVisibleDomState?: {
    elementToRef: WeakMap<Element, string>;
    instanceId: string;
    nextId: number;
    refToElement: Map<string, Element>;
  };
};

type ManualVerificationDetails = {
  detected: boolean;
  evidence?: string;
  /** Visible captcha/OTP-like inputs on the page. */
  captchaFields?: Array<{ label: string; valueLength: number; filled: boolean }>;
  /** True when any captcha-like input already has user-entered content. */
  captchaAppearsFilled?: boolean;
};

type HttpRequestRecord = {
  id: string;
  startedAt: string;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  ok?: boolean;
  failed?: boolean;
  errorText?: string;
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


type BrowserOwnership = 'launched' | 'connected' | 'persistent' | 'shared';
type SharedBrowserOwnership = Exclude<BrowserOwnership, 'shared'>;

export type BrowserTabSnapshot = {
  index: number;
  url: string;
  active: boolean;
  groupId: string;
};

export type BrowserScreencastFrame = {
  data: string;
  contentType: 'image/png';
  capturedAt: string;
  url: string;
  tabs: BrowserTabSnapshot[];
  viewport: { width: number; height: number };
  metadata?: unknown;
};

export type BrowserScreencastHandle = {
  stop: () => Promise<void>;
};

type NativeTabGroupPage = {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
  groupId: number;
  windowId: number;
};

type NativeTabGroupLookup = {
  found: boolean;
  tabs: NativeTabGroupPage[];
};

type NativeTabGroupActivation = {
  ok: boolean;
  tab?: NativeTabGroupPage;
  lookup?: NativeTabGroupLookup;
};

type SharedBrowserLease = {
  browser?: Browser;
  context: BrowserContext;
  ownership: SharedBrowserOwnership;
  release: () => Promise<void>;
};

const preparedContextInitScripts = new WeakSet<BrowserContext>();
const sharedPageOwners = new WeakMap<Page, string>();
const sharedBrowserState: {
  key?: string;
  browser?: Browser;
  context?: BrowserContext;
  ownership?: SharedBrowserOwnership;
  refCount: number;
  initPromise?: Promise<{ browser?: Browser; context: BrowserContext; ownership: SharedBrowserOwnership }>;
} = {
  refCount: 0,
};














function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function timedBrowserStep<T>(
  timings: Record<string, number> | undefined,
  name: string,
  action: () => Promise<T>,
) {
  const startedAt = Date.now();
  try {
    return await action();
  } finally {
    if (timings) timings[name] = (timings[name] || 0) + Date.now() - startedAt;
  }
}


function isBlankPage(page: Page) {
  const url = page.url();
  return isBlankBrowserUrlLike(url);
}

function isBlankBrowserUrlLike(url: string) {
  return !url
    || url === 'about:blank'
    || /^(about:newtab|chrome:\/\/new-tab-page|edge:\/\/newtab)/i.test(url)
    || (
      /^data:text\/html/i.test(url)
      && /data-webpilot-embedded-browser|WebPilot(?:%20|\+)Embedded(?:%20|\+)Browser|WebPilot embedded browser/i.test(url)
    );
}

function installAccessibilitySnapshotExportControl() {
  if (window.top !== window) return;
  const controlId = '__ai_dom_export_control__';
  const browserWindow = window as Window & {
    __webPilotExportAccessibilitySnapshot?: () => Promise<AccessibilitySnapshotExportControlResult>;
  };
  const mount = () => {
    if (!document.documentElement || document.getElementById(controlId)) return;
    const button = document.createElement('button');
    button.id = controlId;
    button.type = 'button';
    button.textContent = '导出页面快照';
    button.title = '获取当前页面及全部 iframe 的语义 DOM 快照，并按每段 20000 字符导出 JSON';
    button.setAttribute('aria-label', '导出当前页面语义 DOM 快照');
    Object.assign(button.style, {
      alignItems: 'center',
      appearance: 'none',
      background: '#171717',
      border: '1px solid rgba(255,255,255,.18)',
      borderRadius: '8px',
      boxShadow: '0 8px 24px rgba(0,0,0,.24)',
      color: '#fff',
      cursor: 'pointer',
      display: 'inline-flex',
      font: '600 13px/1 system-ui, sans-serif',
      height: '34px',
      padding: '0 12px',
      position: 'fixed',
      right: '16px',
      top: '16px',
      zIndex: '2147483647',
    });
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      button.style.cursor = 'wait';
      button.textContent = '正在采集...';
      try {
        const result = await browserWindow.__webPilotExportAccessibilitySnapshot?.();
        if (!result?.ok) throw new Error(result?.error || '页面快照导出失败');
        button.textContent = '导出完成';
        button.title = result.path || result.fileName || '页面快照已导出';
        if (result.downloadUrl) {
          const link = document.createElement('a');
          link.href = result.downloadUrl;
          link.download = result.fileName || 'accessibility-snapshot.json';
          link.style.display = 'none';
          document.documentElement.appendChild(link);
          link.click();
          link.remove();
        }
      } catch (error) {
        button.textContent = '导出失败';
        button.title = error instanceof Error ? error.message : String(error);
      } finally {
        window.setTimeout(() => {
          button.disabled = false;
          button.style.cursor = 'pointer';
          button.textContent = '导出页面快照';
        }, 1800);
      }
    });
    document.documentElement.appendChild(button);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
}

function installAiBrowserPageRuntime() {
  const win = window as WindowWithAiDomRuntime;
  if (!win.__aiBrowserPageRuntimeInstalled) {
    const originalAddEventListener = EventTarget.prototype.addEventListener;
    const listenerTypes = new WeakMap<EventTarget, Set<string>>();
    const interestingEvents = /^(click|dblclick|mousedown|mouseup|pointerdown|pointerup|touchstart|keydown|mouseenter|mouseover|pointerenter|pointerover)$/i;

    Object.defineProperty(window, '__aiGetEventListenerTypes', {
      configurable: true,
      enumerable: false,
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

    win.__aiBrowserPageRuntimeInstalled = true;
  }

  const mutationState = win.__aiDomMutationState || { epoch: 0, lastMutationAt: Date.now() };
  win.__aiDomMutationState = mutationState;
  if (!mutationState.observer) {
    mutationState.observer = new MutationObserver((mutations) => {
      const meaningful = mutations.some((mutation) => {
        const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        return !target?.closest?.('#__ai_candidate_overlay__, #__ai_last_click_marker__, #__ai_dom_export_control__');
      });
      if (!meaningful) return;
      mutationState.epoch += 1;
      mutationState.lastMutationAt = Date.now();
    });
    mutationState.observer.observe(document, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
  }

  if (win.__aiDomRuntime?.version === 9) return;

  const skippedTags = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'head', 'br', 'hr', 'wbr']);
  const nativeActionableTags = new Set(['button', 'details', 'input', 'option', 'select', 'summary', 'textarea']);
  const normalize = (value?: string | null) => String(value || '').replace(/\s+/g, ' ').trim();

  function isOverlay(element: Element) {
    return Boolean(element.closest('#__ai_candidate_overlay__, #__ai_last_click_marker__, #__ai_dom_export_control__'));
  }

  function shadowRootOf(element: Element) {
    return (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot || undefined;
  }

  function flatParentElement(node: Node): Element | undefined {
    const parent: Node | null = node.parentNode;
    if (!parent) return undefined;
    if (parent.nodeType === Node.ELEMENT_NODE) return parent as Element;
    return (parent as ShadowRoot).host || undefined;
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

  function isTraversable(element: Element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE || isOverlay(element)) return false;
    return !skippedTags.has(element.tagName.toLowerCase());
  }

  function isDisplayNone(element: Element) {
    try {
      return window.getComputedStyle(element).display === 'none';
    } catch {
      return false;
    }
  }

  function children(element: Element) {
    if (isDisplayNone(element)) return [];
    const list = Array.from(element.children);
    const root = shadowRootOf(element);
    if (root) list.push(...Array.from(root.children));
    return list.filter(isTraversable);
  }

  function isRenderable(element: Element, options: { requirePointerEvents?: boolean } = {}) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE || isOverlay(element)) return false;
    const tag = element.tagName.toLowerCase();
    if (skippedTags.has(tag)) return false;
    if (element.hasAttribute('hidden')) return false;
    if (element.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(element);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (options.requirePointerEvents && style.pointerEvents === 'none') return false;
    if (Number(style.opacity || '1') <= 0.01) return false;
    return true;
  }

  function visibleRect(element: Element, options: { requirePointerEvents?: boolean } = {}) {
    if (!isRenderable(element, options)) return undefined;
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

  function elementBox(element: Element) {
    if (!isRenderable(element)) return undefined;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) return undefined;
    const left = Math.max(rect.left, 0);
    const top = Math.max(rect.top, 0);
    const right = Math.min(rect.right, window.innerWidth);
    const bottom = Math.min(rect.bottom, window.innerHeight);
    const width = right - left;
    const height = bottom - top;
    const visible = width > 2 && height > 2 ? { left, top, right, bottom, width, height } : undefined;
    const vertical = rect.bottom < 0 ? 'above' : rect.top > window.innerHeight ? 'below' : 'overlaps-y';
    const horizontal = rect.right < 0 ? 'left' : rect.left > window.innerWidth ? 'right' : 'overlaps-x';
    return { raw: rect, visible, vertical, horizontal };
  }

  function recordedEventTypes(element: Element) {
    try {
      return (win.__aiGetEventListenerTypes?.(element) || []).map((item) => item.toLowerCase());
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

  function hasPointerCursor(element: Element) {
    const style = window.getComputedStyle(element);
    if (!/\bpointer\b/i.test(style.cursor || '')) return false;
    const parent = flatParentElement(element);
    if (!parent) return true;
    const parentStyle = window.getComputedStyle(parent);
    if (!/\bpointer\b/i.test(parentStyle.cursor || '')) return true;
    return /(?:^|;)\s*cursor\s*:\s*pointer\b/i.test(element.getAttribute('style') || '');
  }

  function isContentEditableOwner(element: Element) {
    const value = element.getAttribute('contenteditable');
    return value !== null && value.toLowerCase() !== 'false';
  }

  function labelControlFor(element: Element) {
    if (element.tagName.toLowerCase() !== 'label') return undefined;
    const control = (element as HTMLLabelElement).control || undefined;
    const fallback = control ||
      (element.getAttribute('for') ? document.getElementById(element.getAttribute('for') || '') || undefined : undefined);
    const target = fallback ||
      element.querySelector('button, input, select, textarea, [contenteditable=""], [contenteditable="true"]') ||
      undefined;
    if (!target) return undefined;
    const tag = target.tagName.toLowerCase();
    return ['button', 'input', 'select', 'textarea'].includes(tag) || isContentEditableOwner(target) ? target : undefined;
  }

  function hasNativeActionSignal(element: Element, tag = element.tagName.toLowerCase()) {
    if (tag === 'a') return element.hasAttribute('href');
    if (tag === 'label') return Boolean(labelControlFor(element));
    return nativeActionableTags.has(tag);
  }

  function isActionable(element: Element) {
    const tag = element.tagName.toLowerCase();
    if (hasNativeActionSignal(element, tag)) return true;
    if (element.hasAttribute('onclick') || hasActionAttribute(element)) return true;
    if (recordedEventTypes(element).some((type) => /^(click|dblclick|mousedown|mouseup|pointerdown|pointerup|touchstart|keydown|mouseenter|mouseover|pointerenter|pointerover)$/.test(type))) return true;
    if (hasPointerCursor(element)) return true;
    const tabindex = element.getAttribute('tabindex');
    if (tabindex !== null && tabindex !== '-1') return true;
    return isContentEditableOwner(element);
  }

  function actionableTargetFor(element: Element) {
    let current: Element | undefined = element;
    while (current && current !== document.documentElement) {
      if (isActionable(current)) return current;
      current = flatParentElement(current);
    }
    if (element !== document.documentElement && element !== document.body) {
      const queue = children(element);
      let onlyActionableDescendant: Element | undefined;
      while (queue.length) {
        const candidate = queue.shift() as Element;
        if (isActionable(candidate)) {
          if (onlyActionableDescendant) return element;
          onlyActionableDescendant = candidate;
        }
        queue.push(...children(candidate));
      }
      if (onlyActionableDescendant) return onlyActionableDescendant;
    }
    return element;
  }

  function elementFromPath(pathValue?: string) {
    if (!pathValue) return undefined;
    const parts = String(pathValue).split('.').map((item) => Number(String(item).trim()));
    if (!parts.length || parts[0] !== 0 || parts.some((item) => !Number.isInteger(item) || item < 0)) return undefined;
    let element: Element | undefined = document.documentElement;
    for (const index of parts.slice(1)) {
      element = children(element)[index];
      if (!element) return undefined;
    }
    return element;
  }

  function pathOf(element: Element) {
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
    return [0, ...segments].join('.');
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

  function textOf(element: Element, maxLength = 160) {
    return normalize((element as HTMLElement).innerText || element.textContent || '').slice(0, maxLength);
  }

  function topmostRenderableAt(x: number, y: number, options: { requirePointerEvents?: boolean } = {}) {
    let root: Document | ShadowRoot = document;
    let found: Element | undefined;
    for (let guard = 0; guard < 24; guard += 1) {
      const stack = root.elementsFromPoint(x, y) as Element[];
      // Occlusion must follow the visual paint stack. Modal backdrops often use
      // pointer-events:none but still make the covered page unusable for the agent.
      const renderOptions = options.requirePointerEvents
        ? { ...options, requirePointerEvents: false }
        : options;
      const top = stack.find((item) => item && isRenderable(item, renderOptions));
      if (!top) break;
      found = top;
      const sub = shadowRootOf(top);
      if (!sub) break;
      root = sub;
    }
    return found;
  }

  function pointBelongsToElement(element: Element, x: number, y: number, options: { requirePointerEvents?: boolean } = {}) {
    const top = topmostRenderableAt(x, y, options);
    return Boolean(top && (top === element || composedContains(element, top)));
  }

  function visiblePointForElement(element: Element, options: { requirePointerEvents?: boolean } = {}) {
    const rect = visibleRect(element, options);
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
      if (pointBelongsToElement(element, px, py, options)) return { x: px, y: py };
    }
    return undefined;
  }

  const visibleDomRenderedAttributes = [
    'id',
    'class',
    'aria-disabled',
    'aria-label',
    'aria-labelledby',
    'aria-describedby',
    'aria-controls',
    'aria-expanded',
    'aria-pressed',
    'alt',
    'contenteditable',
    'data-testid',
    'data-test',
    'data-qa',
    'data-cy',
    'data-action',
    'data-click',
    'data-href',
    'data-url',
    'data-target',
    'href',
    'jsaction',
    'name',
    'ng-click',
    'onclick',
    'placeholder',
    'role',
    'tabindex',
    'title',
    'type',
    'value',
    'v-on:click',
    '@click',
  ];
  const visibleDomMeaningfulAttributes = visibleDomRenderedAttributes
    .filter((name) => !['id', 'class', 'aria-describedby', 'aria-controls'].includes(name));
  const visibleDomBooleanAttributes = ['checked', 'disabled', 'multiple', 'readonly', 'required', 'selected'];
  const visibleDomSkippedTextTags = new Set(['noscript', 'script', 'style', 'template']);

  function visibleDomState() {
    if (!win.__browserUseVisibleDomState) {
      win.__browserUseVisibleDomState = {
        elementToRef: new WeakMap<Element, string>(),
        instanceId: Math.random().toString(36).slice(2),
        nextId: 1,
        refToElement: new Map<string, Element>(),
      };
    }
    return win.__browserUseVisibleDomState;
  }

  function visualViewportRect() {
    const viewport = window.visualViewport;
    return viewport
      ? {
        bottom: viewport.offsetTop + viewport.height,
        left: viewport.offsetLeft,
        right: viewport.offsetLeft + viewport.width,
        top: viewport.offsetTop,
      }
      : { bottom: window.innerHeight, left: 0, right: window.innerWidth, top: 0 };
  }

  function intersectClip(left: BrowserUseViewportClip, right: BrowserUseViewportClip) {
    const clip = {
      bottom: Math.min(left.bottom, right.bottom),
      left: Math.max(left.left, right.left),
      right: Math.min(left.right, right.right),
      top: Math.max(left.top, right.top),
    };
    return clip.right > clip.left && clip.bottom > clip.top ? clip : undefined;
  }

  function visibleDomElementName(element: Element) {
    return (element.localName || element.nodeName || '').toLowerCase();
  }

  function isVisibleDomHidden(element: Element) {
    const tag = visibleDomElementName(element);
    return element.getAttribute('aria-hidden') === 'true'
      || element.hasAttribute('hidden')
      || (tag === 'input' && element.getAttribute('type') === 'hidden');
  }

  function visibleDomStyle(element: Element) {
    try {
      return window.getComputedStyle(element);
    } catch {
      return undefined;
    }
  }

  function isVisibleDomStyleHidden(element: Element) {
    const style = visibleDomStyle(element);
    if (!style) return true;
    return style.display === 'none'
      || style.visibility === 'hidden'
      || style.visibility === 'collapse'
      || Number(style.opacity || '1') <= 0.01;
  }

  function hasVisibleDomPointerEvents(element: Element) {
    return visibleDomStyle(element)?.pointerEvents !== 'none';
  }

  function isVisibleDomSubtreeHidden(element: Element) {
    return !isTraversable(element)
      || isOverlay(element)
      || isVisibleDomHidden(element)
      || isVisibleDomStyleHidden(element);
  }

  const visibleDomClickEventPattern = /^(click|dblclick|mousedown|mouseup|pointerdown|pointerup|touchstart|keydown)$/;
  const visibleDomHoverEventPattern = /^(mouseenter|mouseover|pointerenter|pointerover)$/;
  const visibleDomActionRolePattern = /^(button|checkbox|combobox|link|menuitem|menuitemcheckbox|menuitemradio|option|radio|slider|spinbutton|switch|tab|textbox|treeitem)$/;

  function hasVisibleDomOwnHoverAttribute(element: Element) {
    return element.hasAttribute('onmouseenter')
      || element.hasAttribute('onmouseover')
      || element.hasAttribute('onpointerenter')
      || element.hasAttribute('onpointerover');
  }

  function visibleDomHoverSelectors() {
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
  }

  function hasVisibleDomCssHoverEffect(element: Element, hoverSelectors: string[]) {
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

  function visibleDomInteractionSignals(element: Element, hoverSelectors: string[] = []) {
    const signals: string[] = [];
    const tag = visibleDomElementName(element);
    if (hasNativeActionSignal(element, tag)) signals.push('native');
    if (element.hasAttribute('onclick')) signals.push('onclick');
    const role = normalizeVisibleDomText(element.getAttribute('role') || '').toLowerCase();
    if (visibleDomActionRolePattern.test(role)) signals.push(`role:${role}`);
    for (const type of recordedEventTypes(element)) {
      if (visibleDomClickEventPattern.test(type) || visibleDomHoverEventPattern.test(type)) signals.push(`listener:${type}`);
    }
    if (hasActionAttribute(element)) signals.push('action-attr');
    if (hasPointerCursor(element)) signals.push('cursor=pointer');
    const tabindex = element.getAttribute('tabindex');
    if (tabindex !== null && tabindex !== '-1') signals.push('tabindex');
    if (isContentEditableOwner(element)) signals.push('contenteditable');
    if (hasVisibleDomOwnHoverAttribute(element)) signals.push('hover-attribute');
    const shouldInspectCssHover = signals.some((signal) => !/^listener:(mousedown|mouseup|pointerdown|pointerup|touchstart|keydown)$/.test(signal));
    if (shouldInspectCssHover && hoverSelectors.length && hasVisibleDomCssHoverEffect(element, hoverSelectors)) signals.push('hover-css');
    return Array.from(new Set(signals));
  }

  function visibleDomActionCapabilities(element: Element, signals: string[]) {
    const capabilities = new Set<DomActionCapability>();
    const tag = visibleDomElementName(element);
    const type = normalizeVisibleDomText(element.getAttribute('type') || '').toLowerCase();
    const role = normalizeVisibleDomText(element.getAttribute('role') || '').toLowerCase();
    if (tag === 'input') {
      if (/^(button|checkbox|color|file|image|radio|range|reset|submit)$/i.test(type)) capabilities.add('click');
      else capabilities.add('fill');
      capabilities.add('focus');
    } else if (tag === 'textarea') {
      capabilities.add('fill');
      capabilities.add('focus');
    } else if (tag === 'select' || tag === 'option') {
      capabilities.add('select');
      capabilities.add('focus');
    } else if (['a', 'button', 'details', 'label', 'summary'].includes(tag)) {
      capabilities.add('click');
    }
    if (isContentEditableOwner(element) || role === 'textbox') {
      capabilities.add('fill');
      capabilities.add('focus');
    }
    if (visibleDomActionRolePattern.test(role) && role !== 'textbox' && role !== 'combobox') capabilities.add('click');
    if (role === 'combobox') {
      capabilities.add('select');
      capabilities.add('focus');
    }
    if (signals.some((signal) => /^(onclick|action-attr|listener:(click|dblclick|mouseup|pointerup))$/.test(signal))) capabilities.add('click');
    if (signals.includes('cursor=pointer')) capabilities.add('click');
    if (signals.includes('tabindex')) capabilities.add('focus');
    if (signals.some((signal) => /^(hover-attribute|hover-css|listener:(mouseenter|mouseover|pointerenter|pointerover))$/.test(signal))) capabilities.add('hover');
    const dragSignal = signals.some((signal) => /^listener:(mousedown|pointerdown|touchstart)$/.test(signal));
    if (dragSignal && (
      element.getAttribute('draggable') === 'true'
      || element.hasAttribute('cdkdraghandle')
      || element.hasAttribute('data-drag-handle')
    )) capabilities.add('drag');
    return Array.from(capabilities);
  }

  function visibleDomActionConfidence(element: Element, signals: string[], capabilities: DomActionCapability[]): DomActionConfidence {
    if (signals.some((signal) => /^(native|onclick|action-attr|role:|listener:(click|dblclick))/.test(signal))) return 'high';
    if (signals.includes('cursor=pointer') || signals.includes('contenteditable')) return 'medium';
    if (capabilities.includes('fill') || capabilities.includes('select')) return 'high';
    if (signals.some((signal) => /^(tabindex|hover-attribute|listener:(mouseenter|pointerenter))$/.test(signal))) return 'medium';
    if (element.getAttribute('draggable') === 'true' || element.hasAttribute('cdkdraghandle') || element.hasAttribute('data-drag-handle')) return 'medium';
    return 'low';
  }

  function visibleDomLocatorCandidates(element: Element) {
    const values: string[] = [];
    const quote = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const addAttribute = (name: string, value?: string | null, prefix = '') => {
      const normalized = normalizeVisibleDomText(value || '');
      if (!normalized || normalized.length > 240) return;
      values.push(`${prefix}[${name}="${quote(normalized)}"]`);
    };
    const tag = visibleDomElementName(element);
    for (const name of ['data-testid', 'data-test', 'data-qa', 'data-cy']) addAttribute(name, element.getAttribute(name));
    const id = normalizeVisibleDomText(element.id || '');
    if (id && id.length <= 120) {
      try {
        values.push(`#${CSS.escape(id)}`);
      } catch {
        addAttribute('id', id);
      }
    }
    if (tag === 'a') addAttribute('href', element.getAttribute('href'), 'a');
    const role = element.getAttribute('role');
    const ariaLabel = element.getAttribute('aria-label');
    if (role && ariaLabel) values.push(`[role="${quote(role)}"][aria-label="${quote(ariaLabel)}"]`);
    const name = element.getAttribute('name');
    if (name) addAttribute('name', name, tag);
    return Array.from(new Set(values)).slice(0, 8);
  }

  function visibleDomRect(element: Element, viewportClip: BrowserUseViewportClip) {
    const style = window.getComputedStyle(element);
    if (
      style.visibility !== 'visible'
      || style.display === 'none'
      || style.pointerEvents === 'none'
      || Number(style.opacity) <= 0.01
    ) {
      return undefined;
    }
    for (const rect of Array.from(element.getClientRects())) {
      if (
        rect.width > 0
        && rect.height > 0
        && rect.right > viewportClip.left
        && rect.left < viewportClip.right
        && rect.bottom > viewportClip.top
        && rect.top < viewportClip.bottom
      ) {
        return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top };
      }
    }
    return undefined;
  }

  function renderedDomRect(element: Element) {
    if (!isRenderable(element, { requirePointerEvents: true })) return undefined;
    for (const rect of Array.from(element.getClientRects())) {
      if (rect.width > 0 && rect.height > 0) {
        return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top };
      }
    }
    return undefined;
  }

  function visibleDomClickablePoint(element: Element, viewportClip: BrowserUseViewportClip) {
    const rect = visibleDomRect(element, viewportClip);
    if (!rect) return undefined;
    const insetX = Math.min(10, Math.max(1, (rect.right - rect.left) / 4));
    const insetY = Math.min(10, Math.max(1, (rect.bottom - rect.top) / 4));
    const samples = [
      [rect.left + (rect.right - rect.left) / 2, rect.top + (rect.bottom - rect.top) / 2],
      [rect.left + insetX, rect.top + (rect.bottom - rect.top) / 2],
      [rect.right - insetX, rect.top + (rect.bottom - rect.top) / 2],
      [rect.left + (rect.right - rect.left) / 2, rect.top + insetY],
      [rect.left + (rect.right - rect.left) / 2, rect.bottom - insetY],
      [rect.left + insetX, rect.top + insetY],
      [rect.right - insetX, rect.top + insetY],
      [rect.left + insetX, rect.bottom - insetY],
      [rect.right - insetX, rect.bottom - insetY],
    ];
    for (const [x, y] of samples) {
      const px = Math.min(Math.max(x, 0), window.innerWidth - 1);
      const py = Math.min(Math.max(y, 0), window.innerHeight - 1);
      if (pointBelongsToElement(element, px, py, { requirePointerEvents: true })) return { x: px, y: py };
    }
    return undefined;
  }

  function normalizeVisibleDomText(value: string) {
    return value.replace(/\s+/g, ' ').trim();
  }

  function escapeVisibleDomText(value: string) {
    return value
      .replace(/[\t\n\f\r]+/g, ' ')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function visibleDomAttributeValue(element: Element, name: string) {
    const value = element.getAttribute(name);
    if (value === null || value === '') return undefined;
    const normalized = normalizeVisibleDomText(value);
    if (!normalized) return undefined;
    if (name === 'class') {
      const classes = normalized.split(/\s+/).filter(Boolean).slice(0, 10).join(' ');
      return classes || undefined;
    }
    if (name === 'href') return normalized.slice(0, 240);
    if (name === 'value') return normalized.slice(0, 180);
    return normalized.slice(0, 140);
  }

  function visibleDomTextContent(element: Element, maxChars = 160) {
    const parts: string[] = [];
    let chars = 0;
    const visit = (node: Node) => {
      if (chars >= maxChars) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const text = normalizeVisibleDomText(node.nodeValue || '');
        if (text) {
          parts.push(text);
          chars += text.length + 1;
        }
        return;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        if (isVisibleDomSubtreeHidden(element) || visibleDomSkippedTextTags.has(visibleDomElementName(element))) return;
      }
      for (const child of Array.from(node.childNodes || [])) {
        if (chars >= maxChars) break;
        visit(child);
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        if (isVisibleDomSubtreeHidden(element)) return;
        const root = shadowRootOf(element);
        if (!root) return;
        for (const child of Array.from(root.childNodes)) {
          if (chars >= maxChars) break;
          visit(child);
        }
      }
    };
    visit(element);
    return normalizeVisibleDomText(parts.join(' ')).slice(0, maxChars);
  }

  function visibleDomOwnTextContent(element: Element) {
    const parts: string[] = [];
    let chars = 0;
    const visitTextChildren = (node: Node) => {
      for (const child of Array.from(node.childNodes || [])) {
        if (chars >= 160) break;
        if (child.nodeType === Node.TEXT_NODE) {
          const text = normalizeVisibleDomText(child.nodeValue || '');
          if (text) {
            parts.push(text);
            chars += text.length + 1;
          }
        }
      }
    };
    visitTextChildren(element);
    const root = shadowRootOf(element);
    if (root) visitTextChildren(root);
    return normalizeVisibleDomText(parts.join(' ')).slice(0, 160);
  }

  function visibleDomUniqueText(values: string[]) {
    const seen = new Set<string>();
    const output: string[] = [];
    for (const value of values) {
      const text = normalizeVisibleDomText(value);
      const key = text.toLowerCase();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      output.push(text);
    }
    return output;
  }

  const visibleDomLabelAttributeNames = ['aria-label', 'alt', 'placeholder', 'title', 'value'];
  const visibleDomDescendantSemanticAttributeNames = ['aria-label', 'title', 'alt', 'data-testid', 'data-test', 'data-qa', 'data-cy'];
  const visibleDomInteractiveStateAttributes = [
    'id',
    'class',
    'aria-disabled',
    'aria-label',
    'placeholder',
    'title',
    'role',
    'type',
    'name',
    'value',
    'href',
    'aria-expanded',
    'aria-pressed',
    'checked',
    'disabled',
    'readonly',
    'required',
    'selected',
    'contenteditable',
    'data-testid',
    'data-test',
    'data-qa',
    'data-cy',
    'data-action',
    'data-click',
    'data-href',
    'data-target',
    'data-url',
    'jsaction',
    'ng-click',
    'onclick',
    'tabindex',
    'v-on:click',
    '@click',
  ];

  function visibleDomDescendantSemanticText(element: Element) {
    const values: string[] = [];
    let chars = 0;
    const append = (value?: string | null) => {
      if (chars >= 160) return;
      const text = normalizeVisibleDomText(value || '');
      if (!text) return;
      values.push(text);
      chars += text.length + 1;
    };
    const visit = (node: Node, root = false) => {
      if (chars >= 160) return;
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const child = node as Element;
      if (!root && isVisibleDomSubtreeHidden(child)) return;
      if (!root) {
        for (const name of visibleDomDescendantSemanticAttributeNames) append(child.getAttribute(name));
      }
      const rootNode = shadowRootOf(child);
      for (const nested of Array.from(child.childNodes || [])) {
        if (chars >= 160) break;
        visit(nested, false);
      }
      if (rootNode) {
        for (const nested of Array.from(rootNode.childNodes || [])) {
          if (chars >= 160) break;
          visit(nested, false);
        }
      }
    };
    visit(element, true);
    return visibleDomUniqueText(values).join(' | ').slice(0, 160);
  }

  function visibleDomLineText(element: Element, interactive: boolean) {
    const text = visibleDomTextContent(element);
    if (text || !interactive) return text;
    return visibleDomDescendantSemanticText(element);
  }

  function visibleDomLabelForElement(element: Element, interactive: boolean, lineText: string) {
    const values = visibleDomUniqueText([
      lineText,
      ...visibleDomLabelAttributeNames.map((name) => visibleDomAttributeValue(element, name) || ''),
      visibleDomAttributeValue(element, 'name') || '',
    ]);
    if (values.length) return values.join(' | ').slice(0, 180);
    if (!interactive) return '';
    return 'icon-only/unlabeled interactive';
  }

  function visibleDomInteractiveStateForElement(element: Element, signals: string[]) {
    const values = visibleDomInteractiveStateAttributes
      .map((name) => {
        const value = visibleDomAttributeValue(element, name);
        return value ? `${name}=${JSON.stringify(value)}` : '';
      })
      .filter(Boolean);
    if (signals.length) values.push(`signals=${JSON.stringify(Array.from(new Set(signals)).join('|'))}`);
    return values.join(' ');
  }

  function renderedTextFromNode(rootNode: Node, maxChars: number) {
    const limit = Math.max(1, Math.floor(Number(maxChars) || 200000));
    const parts: string[] = [];
    let chars = 0;
    let textLength = 0;
    const textAttributes = ['alt', 'aria-label', 'placeholder', 'title'];
    const append = (value?: string | null) => {
      const text = normalizeVisibleDomText(value || '');
      if (!text) return;
      textLength += text.length + (textLength ? 1 : 0);
      if (chars >= limit) return;
      const remaining = limit - chars;
      const chunk = text.length > remaining ? text.slice(0, remaining) : text;
      if (chunk) {
        parts.push(chunk);
        chars += chunk.length + 1;
      }
    };
    const visit = (node: Node) => {
      if (chars >= limit) return;
      if (node.nodeType === Node.TEXT_NODE) {
        append(node.nodeValue || '');
        return;
      }
      if (node.nodeType === Node.DOCUMENT_NODE) {
        const root = document.documentElement;
        if (root) visit(root);
        return;
      }
      if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        for (const child of Array.from(node.childNodes || [])) {
          if (chars >= limit) break;
          visit(child);
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const element = node as Element;
      if (isVisibleDomSubtreeHidden(element)) return;
      const tag = visibleDomElementName(element);
      for (const name of textAttributes) append(element.getAttribute(name));
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        const value = (element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
        append(value);
      }
      for (const child of Array.from(element.childNodes || [])) {
        if (chars >= limit) break;
        visit(child);
      }
      const root = shadowRootOf(element);
      if (root) visit(root);
    };
    visit(rootNode);
    return {
      text: normalizeVisibleDomText(parts.join(' ')).slice(0, limit),
      textLength,
    };
  }

  function visibleDomRef(element: Element) {
    const state = visibleDomState();
    let ref = state.elementToRef.get(element);
    if (!ref) {
      ref = String(state.nextId++);
      state.elementToRef.set(element, ref);
    }
    return ref;
  }

  function visibleDomItem(element: Element, ref: string, signals: string[] = []) {
    const attrs = [`node_id=${ref}`];
    for (const name of visibleDomRenderedAttributes) {
      const value = visibleDomAttributeValue(element, name);
      if (value) attrs.push(`${name}="${escapeVisibleDomText(value)}"`);
    }
    for (const name of visibleDomBooleanAttributes) {
      if (element.hasAttribute(name)) attrs.push(`${name}="true"`);
    }
    if (signals.length) {
      attrs.push(`signals="${escapeVisibleDomText(Array.from(new Set(signals)).join('|'))}"`);
    }
    const tag = visibleDomElementName(element);
    const capabilities = visibleDomActionCapabilities(element, signals);
    const confidence = visibleDomActionConfidence(element, signals, capabilities);
    const interactive = capabilities.length > 0;
    const text = visibleDomLineText(element, interactive);
    const ownText = visibleDomOwnTextContent(element);
    const semanticTextTags = new Set(['a', 'button', 'dd', 'dt', 'figcaption', 'label', 'legend', 'li', 'option', 'p', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
    const formText = ['input', 'select', 'textarea'].includes(tag)
      ? visibleDomUniqueText(['aria-label', 'placeholder', 'value', 'name'].map((name) => visibleDomAttributeValue(element, name) || '')).join(' | ')
      : '';
    const textEntry = ownText || formText || (semanticTextTags.has(tag) ? text : '');
    const contextText = tag === 'tr'
      ? visibleDomTextContent(element, 800)
      : ['article', 'dialog', 'fieldset', 'form', 'li', 'nav', 'section'].includes(tag)
        ? visibleDomTextContent(element, 320)
        : '';
    const rect = renderedDomRect(element);
    const line = text.length === 0
      ? `<${tag} ${attrs.join(' ')} />`
      : `<${tag} ${attrs.join(' ')}>${escapeVisibleDomText(text)}</${tag}>`;
    return {
      capabilities,
      confidence,
      contextText,
      interactive,
      label: visibleDomLabelForElement(element, interactive, text),
      line,
      locatorCandidates: visibleDomLocatorCandidates(element),
      rect,
      signals,
      state: interactive ? visibleDomInteractiveStateForElement(element, signals) : '',
      tag,
      text: textEntry,
    };
  }

  function visibleDomSnapshot(options: { maxChars: number; maxElements: number; preserveExistingRefs?: boolean; viewportClip?: BrowserUseViewportClip }) {
    const state = visibleDomState();
    if (!options.preserveExistingRefs) state.refToElement.clear();

    const rawViewport = visualViewportRect();
    const viewportClip = options.viewportClip ? intersectClip(rawViewport, options.viewportClip) || rawViewport : rawViewport;
    const maxElements = Math.max(1, Math.floor(Number(options.maxElements) || 200));
    const maxChars = Math.max(1, Math.floor(Number(options.maxChars) || 20000));
    const frameElements: BrowserUseVisibleDomSnapshot['frameElements'] = [];
    const items: BrowserUseVisibleDomSnapshot['items'] = [];
    let chars = 0;
    let truncated = false;
    const hoverSelectors = visibleDomHoverSelectors();

    const stop = () => truncated || items.length >= maxElements || chars >= maxChars;
    const pushItem = (element: Element, signals: string[] = []) => {
      if (stop()) return;
      const ref = visibleDomRef(element);
      const item = visibleDomItem(element, ref, signals);
      const line = item.line;
      const lineChars = line.length + (items.length === 0 ? 0 : 1);
      if (chars + lineChars > maxChars) {
        truncated = true;
        return;
      }
      state.refToElement.set(ref, element);
      items.push({
        ...item,
        descriptor: descriptor(element),
        path: pathOf(element) || '',
        ref,
      });
      chars += lineChars;
    };
    const pushFrame = (element: Element) => {
      if (frameElements.length >= maxElements) return;
      const rect = visibleDomRect(element, viewportClip);
      if (!rect) return;
      const ref = visibleDomRef(element);
      state.refToElement.set(ref, element);
      const frameElement = element as HTMLIFrameElement;
      const width = frameElement.clientWidth > 0 ? frameElement.clientWidth : rect.right - rect.left;
      const height = frameElement.clientHeight > 0 ? frameElement.clientHeight : rect.bottom - rect.top;
      frameElements.push({
        rect,
        ref,
        size: { height, width },
        ...(frameElement.src ? { url: frameElement.src } : {}),
      });
    };
    const visit = (node: Node) => {
      if (stop()) return;
      if (node.nodeType === Node.DOCUMENT_NODE) {
        const root = document.documentElement;
        if (root) visit(root);
        return;
      }
      if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        for (const child of Array.from((node as DocumentFragment).children)) {
          if (stop()) break;
          visit(child);
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const element = node as Element;
      if (isDisplayNone(element)) return;
      const tag = visibleDomElementName(element);
      if (tag === 'frame' || tag === 'iframe') pushFrame(element);
      const signals = visibleDomInteractionSignals(element, hoverSelectors);
      if (
        signals.length
        && !isVisibleDomSubtreeHidden(element)
        && hasVisibleDomPointerEvents(element)
        && visibleDomClickablePoint(element, viewportClip)
      ) {
        pushItem(element, signals);
      }
      const root = shadowRootOf(element);
      if (root && !stop()) visit(root);
      for (const child of Array.from(element.children)) {
        if (stop()) break;
        visit(child);
      }
    };

    visit(document);
    return { frameElements, items, stateKey: state.instanceId, viewport: rawViewport };
  }

  function fullDomSnapshot(options: { maxChars: number; maxElements: number; preserveExistingRefs?: boolean }) {
    const state = visibleDomState();
    if (!options.preserveExistingRefs) state.refToElement.clear();

    const viewport = visualViewportRect();
    const maxElements = Math.max(1, Math.floor(Number(options.maxElements) || 500));
    const maxChars = Math.max(1, Math.floor(Number(options.maxChars) || 60000));
    const frameElements: BrowserUseVisibleDomSnapshot['frameElements'] = [];
    const items: BrowserUseVisibleDomSnapshot['items'] = [];
    let chars = 0;
    let truncated = false;
    const hoverSelectors = visibleDomHoverSelectors();

    const structuralTextTags = new Set([
      'a', 'button', 'dd', 'details', 'dt', 'figcaption', 'input', 'label', 'legend', 'li',
      'option', 'p', 'select', 'summary', 'td', 'textarea', 'th',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    ]);
    const directTextContainerTags = new Set(['article', 'aside', 'div', 'fieldset', 'footer', 'form', 'header', 'main', 'nav', 'section', 'span']);
    const stop = () => truncated || items.length >= maxElements || chars >= maxChars;
    const hasMeaningfulAttributes = (element: Element) => visibleDomMeaningfulAttributes.some((name) => Boolean(visibleDomAttributeValue(element, name)));
    const actionableSignals = (element: Element) => {
      const signals = visibleDomInteractionSignals(element, hoverSelectors);
      return signals.length && renderedDomRect(element) ? signals : [];
    };
    const shouldIncludeElement = (element: Element) => {
      if (isVisibleDomSubtreeHidden(element) || !hasVisibleDomPointerEvents(element)) return false;
      const tag = visibleDomElementName(element);
      if (actionableSignals(element).length) return true;
      if (structuralTextTags.has(tag) && visibleDomTextContent(element)) return true;
      if (directTextContainerTags.has(tag) && visibleDomOwnTextContent(element)) return true;
      return hasMeaningfulAttributes(element);
    };
    const pushItem = (element: Element, signals: string[] = []) => {
      if (stop()) return;
      const ref = visibleDomRef(element);
      const item = visibleDomItem(element, ref, signals);
      const line = item.line;
      const lineChars = line.length + (items.length === 0 ? 0 : 1);
      if (chars + lineChars > maxChars) {
        truncated = true;
        return;
      }
      state.refToElement.set(ref, element);
      items.push({
        ...item,
        descriptor: descriptor(element),
        path: pathOf(element) || '',
        ref,
      });
      chars += lineChars;
    };
    const pushFrame = (element: Element) => {
      if (frameElements.length >= maxElements) return;
      const box = elementBox(element);
      const rect = box?.visible || (box?.raw
        ? { bottom: box.raw.bottom, height: box.raw.height, left: box.raw.left, right: box.raw.right, top: box.raw.top, width: box.raw.width }
        : undefined);
      if (!rect) return;
      const ref = visibleDomRef(element);
      state.refToElement.set(ref, element);
      const frameElement = element as HTMLIFrameElement;
      frameElements.push({
        rect,
        ref,
        size: { height: Math.max(0, frameElement.clientHeight || rect.height), width: Math.max(0, frameElement.clientWidth || rect.width) },
        ...(frameElement.src ? { url: frameElement.src } : {}),
      });
    };
    const visit = (node: Node) => {
      if (stop()) return;
      if (node.nodeType === Node.DOCUMENT_NODE) {
        const root = document.documentElement;
        if (root) visit(root);
        return;
      }
      if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        for (const child of Array.from((node as DocumentFragment).children)) {
          if (stop()) break;
          visit(child);
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const element = node as Element;
      if (isDisplayNone(element)) return;
      const tag = visibleDomElementName(element);
      if (tag === 'frame' || tag === 'iframe') pushFrame(element);
      if (shouldIncludeElement(element)) pushItem(element, actionableSignals(element));
      const root = shadowRootOf(element);
      if (root && !stop()) visit(root);
      for (const child of Array.from(element.children)) {
        if (stop()) break;
        visit(child);
      }
    };

    visit(document);
    return { frameElements, items, stateKey: state.instanceId, viewport };
  }

  function visibleDomPoint(ref: string, viewportClip?: BrowserUseViewportClip) {
    const element = visibleDomState().refToElement.get(ref);
    if (!element?.isConnected) return undefined;
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const clip = viewportClip || visualViewportRect();
    const clickablePoint = visibleDomClickablePoint(element, clip);
    if (clickablePoint) return { ...clickablePoint, descriptor: descriptor(element) };
    const pointInRect = (rect: DOMRect | ClientRect) => {
      if (rect.width <= 0 || rect.height <= 0) return undefined;
      const left = Math.max(rect.left, clip.left);
      const right = Math.min(rect.right, clip.right);
      const top = Math.max(rect.top, clip.top);
      const bottom = Math.min(rect.bottom, clip.bottom);
      return right > left && bottom > top
        ? { x: left + (right - left) / 2, y: top + (bottom - top) / 2 }
        : undefined;
    };
    for (const rect of Array.from(element.getClientRects())) {
      const point = pointInRect(rect);
      if (point) return { ...point, descriptor: descriptor(element) };
    }
    const point = pointInRect(element.getBoundingClientRect());
    return point ? { ...point, descriptor: descriptor(element) } : undefined;
  }

  function elementText(pathValue: string, options: { maxChars?: number } = {}) {
    const element = elementFromPath(pathValue);
    if (!element) return undefined;
    const result = renderedTextFromNode(element, options.maxChars || 200000);
    return {
      descriptor: descriptor(element),
      text: result.text,
      textLength: result.textLength,
    };
  }

  function visibleDomText(ref: string, options: { maxChars?: number } = {}) {
    const element = visibleDomState().refToElement.get(ref);
    if (!element?.isConnected) return undefined;
    const result = renderedTextFromNode(element, options.maxChars || 200000);
    return {
      descriptor: descriptor(element),
      text: result.text,
      textLength: result.textLength,
    };
  }

  win.__aiDomRuntime = {
    version: 9,
    mutationState: () => ({ epoch: mutationState.epoch, lastMutationAt: mutationState.lastMutationAt }),
    isOverlay,
    isTraversable,
    isRenderable,
    children,
    flatParentElement,
    composedContains,
    elementFromPath,
    pathOf,
    descriptor,
    textOf,
    recordedEventTypes,
    hasActionAttribute,
    isActionable,
    actionableTargetFor,
    visibleRect,
    elementBox,
    topmostRenderableAt,
    pointBelongsToElement,
    visiblePointForElement,
    visibleDomSnapshot,
    fullDomSnapshot,
    elementText,
    visibleDomPoint,
    visibleDomText,
  };
}

function collectAiDomObservation(input: { includeInteractiveCandidates?: boolean; requirePointerEvents?: boolean; structuredTextMaxChars?: number; debugPause?: boolean; candidateTextQuery?: string }): PageDomObservationPayload {
  if (input.debugPause) {
    debugger;
  }
  const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime!;
  if (!runtime) return { structuredText: '', interactiveCandidates: [] };

  const includeInteractiveCandidates = input.includeInteractiveCandidates !== false;
  const requirePointerEvents = input.requirePointerEvents === true;
  const maxStructuredTextChars = Math.max(0, Math.floor(Number(input.structuredTextMaxChars) || 0));
  const structuredLines: string[] = [];
  let structuredChars = 0;
  const normalizeText = (value?: string | null) => String(value || '').replace(/\s+/g, ' ').trim();
  const candidateTextQuery = normalizeText(input.candidateTextQuery).toLowerCase();
  const candidateTextQueryParts = candidateTextQuery.split(/\s+/).filter((item) => item.length >= 2);
  const overlaySelector = '#__ai_candidate_overlay__, #__ai_last_click_marker__, #__ai_dom_export_control__';
  const skippedTextTags = new Set(['script', 'style', 'template', 'noscript']);
  const structuralTextTags = new Set([
    'article',
    'aside',
    'body',
    'details',
    'dialog',
    'fieldset',
    'footer',
    'form',
    'header',
    'li',
    'main',
    'menu',
    'nav',
    'ol',
    'section',
    'summary',
    'table',
    'tbody',
    'td',
    'th',
    'thead',
    'tr',
    'ul',
  ]);

  function classNameOf(element: Element) {
    return typeof element.className === 'string'
      ? normalizeText(element.className).split(/\s+/).filter(Boolean).slice(0, 8).join(' ')
      : '';
  }

  function compactClassNameOf(element: Element) {
    return typeof element.className === 'string'
      ? element.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.')
      : '';
  }

  function isHiddenForStructuredText(element: Element) {
    if (element.closest(overlaySelector)) return true;
    if (element.getAttribute('aria-hidden') === 'true') return true;
    const style = window.getComputedStyle(element);
    return style.display === 'none'
      || style.visibility === 'hidden'
      || style.visibility === 'collapse'
      || Number(style.opacity || '1') <= 0.01;
  }

  function appendStructuredText(depth: number, text: string) {
    if (!maxStructuredTextChars || !text || structuredChars >= maxStructuredTextChars) return;
    const line = `${'  '.repeat(Math.min(depth, 12))}${text}`;
    const remaining = maxStructuredTextChars - structuredChars;
    const chunk = line.length > remaining ? line.slice(0, remaining) : line;
    if (!chunk) return;
    structuredLines.push(chunk);
    structuredChars += chunk.length + 1;
  }

  function structuredTextLine(element: Element) {
    const tag = element.tagName.toLowerCase();
    if (skippedTextTags.has(tag) || isHiddenForStructuredText(element)) return undefined;
    const role = element.getAttribute('role');
    const classes = compactClassNameOf(element);
    const descriptor = `${tag}${classes ? `.${classes}` : ''}${role ? `[role=${role}]` : ''}`;
    const inputElement = element as HTMLInputElement;
    const label = [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('alt'),
      inputElement.placeholder,
      inputElement.value,
      ownText(element),
    ].map(normalizeText).find(Boolean) || '';
    const shouldShow = Boolean(label)
      || structuralTextTags.has(tag)
      || ['button', 'a', 'input', 'select', 'textarea', 'option'].includes(tag);
    return shouldShow ? { shown: true, text: label ? `${descriptor}: ${label}` : descriptor } : { shown: false, text: '' };
  }

  function flatParentElement(node: Node) {
    return runtime.flatParentElement(node);
  }

  function hasPointerCursor(element: Element) {
    const style = window.getComputedStyle(element);
    if (!/\bpointer\b/i.test(style.cursor || '')) return false;
    const parent = flatParentElement(element);
    if (!parent) return true;
    const parentStyle = window.getComputedStyle(parent);
    if (!/\bpointer\b/i.test(parentStyle.cursor || '')) return true;
    return /(?:^|;)\s*cursor\s*:\s*pointer\b/i.test(element.getAttribute('style') || '');
  }

  function composedContains(ancestor: Element, node: Element) {
    return runtime.composedContains(ancestor, node);
  }

  function isInsideShadow(element: Element) {
    const root = element.getRootNode();
    return Boolean(root && (root as ShadowRoot).host);
  }

  function visibleRectOf(element: Element) {
    return runtime.visibleRect(element, { requirePointerEvents });
  }

  function children(element: Element) {
    return runtime.children(element);
  }

  function ownText(element: Element) {
    let text = '';
    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent || '';
    }
    const inner = normalizeText((element as HTMLElement).innerText || element.textContent || '');
    return (normalizeText(text) || inner).slice(0, 140);
  }

  function contextText(element: Element) {
    const container = element.closest('li, article, tr, form, [role="listitem"], [role="row"], section, main') || element.parentElement || element;
    return normalizeText((container as HTMLElement).innerText || container.textContent || '').slice(0, 220);
  }

  function labelMatchesCandidateTextQuery(value?: string | null) {
    if (!candidateTextQuery) return true;
    const label = normalizeText(value).toLowerCase();
    if (!label) return false;
    if (label === candidateTextQuery) return true;
    if (label.startsWith(candidateTextQuery)) return true;
    if (label.includes(candidateTextQuery)) return true;
    return candidateTextQueryParts.length >= 2 && candidateTextQueryParts.every((part) => label.includes(part));
  }

  function labelsMatchCandidateTextQuery(labels: Array<string | undefined>) {
    return !candidateTextQuery || labels.some(labelMatchesCandidateTextQuery);
  }

  function recordedEventTypes(element: Element) {
    return runtime.recordedEventTypes(element);
  }

  function hasRecordedClickListener(element: Element) {
    return recordedEventTypes(element).some((type) => /^(click|dblclick|mousedown|mouseup|pointerdown|pointerup|touchstart|keydown)$/.test(type));
  }

  function hasRecordedHoverListener(element: Element) {
    return recordedEventTypes(element).some((type) => /^(mouseenter|mouseover|pointerenter|pointerover)$/.test(type));
  }

  function hasActionAttribute(element: Element) {
    return runtime.hasActionAttribute(element);
  }

  function hasOwnHoverSignal(element: Element) {
    if (element.hasAttribute('onmouseenter')) return true;
    if (element.hasAttribute('onmouseover')) return true;
    if (element.hasAttribute('onpointerenter')) return true;
    if (element.hasAttribute('onpointerover')) return true;
    return hasRecordedHoverListener(element);
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

  function isContentEditableOwner(element: Element) {
    const value = element.getAttribute('contenteditable');
    return value !== null && value.toLowerCase() !== 'false';
  }

  function labelControlFor(element: Element) {
    if (element.tagName.toLowerCase() !== 'label') return undefined;
    const control = (element as HTMLLabelElement).control || undefined;
    const fallback = control ||
      (element.getAttribute('for') ? document.getElementById(element.getAttribute('for') || '') || undefined : undefined);
    const target = fallback ||
      element.querySelector('button, input, select, textarea, [contenteditable=""], [contenteditable="true"]') ||
      undefined;
    if (!target) return undefined;
    const tag = target.tagName.toLowerCase();
    return ['button', 'input', 'select', 'textarea'].includes(tag) || isContentEditableOwner(target) ? target : undefined;
  }

  function interactionSignals(element: Element, tag = element.tagName.toLowerCase()) {
    const signals: string[] = [];
    if (
      ['button', 'details', 'input', 'select', 'textarea', 'summary', 'option'].includes(tag) ||
      (tag === 'a' && element.hasAttribute('href')) ||
      (tag === 'label' && labelControlFor(element))
    ) {
      signals.push('native');
    }
    if (element.hasAttribute('onclick')) signals.push('onclick');
    if (hasRecordedClickListener(element)) signals.push('listener');
    if (hasActionAttribute(element)) signals.push('action-attr');
    if (hasPointerCursor(element)) signals.push('cursor=pointer');
    const tabindex = element.getAttribute('tabindex');
    if (tabindex !== null && tabindex !== '-1') signals.push('tabindex');
    if (isContentEditableOwner(element)) signals.push('contenteditable');
    if (hasOwnHoverSignal(element)) signals.push('hover-listener');
    if (hasCssHoverEffect(element)) signals.push('hover-css');
    return signals;
  }

  function clickableReason(element: Element) {
    return interactionSignals(element).length > 0;
  }

  function isInteractiveDescendant(element: Element) {
    const tag = element.tagName.toLowerCase();
    if (tag === 'label' && labelControlFor(element)) return true;
    const isInput = ['input', 'textarea', 'select'].includes(tag) || isContentEditableOwner(element);
    return clickableReason(element) || isInput || hasOwnHoverSignal(element) || hasCssHoverEffect(element);
  }

  function externalAppTargetForUrl(value?: string | null) {
    const url = normalizeText(value);
    const match = url.match(/^([a-z][a-z0-9+.-]*):/i);
    if (!match) return undefined;
    const protocol = match[1].toLowerCase();
    if ([
      'http',
      'https',
      'about',
      'blob',
      'data',
      'javascript',
      'file',
      'chrome',
      'chrome-extension',
      'edge',
      'devtools',
      'view-source',
    ].includes(protocol)) return undefined;
    return { protocol };
  }

  function externalAppTargetForElement(element: Element, href?: string) {
    const direct = externalAppTargetForUrl(href || element.getAttribute('href'));
    if (direct) return direct;

    const attributeNames = [
      'data-href',
      'data-url',
      'data-link',
      'data-uri',
      'data-deeplink',
      'data-deep-link',
      'data-scheme',
      'data-target-url',
    ];
    for (const name of attributeNames) {
      const value = element.getAttribute(name);
      const result = externalAppTargetForUrl(value)
        || (name === 'data-scheme' && /^[a-z][a-z0-9+.-]*$/i.test(normalizeText(value))
          ? externalAppTargetForUrl(`${normalizeText(value)}:`)
          : undefined);
      if (result) return result;
    }

    const inlineHandler = element.getAttribute('onclick') || '';
    const handlerMatch = inlineHandler.match(/['"]([a-z][a-z0-9+.-]*:[^'"]*)['"]/i);
    return externalAppTargetForUrl(handlerMatch?.[1]);
  }

  function nameOf(element: Element) {
    const inputElement = element as HTMLInputElement;
    const labelText = inputElement.labels?.length ? Array.from(inputElement.labels).map((label) => label.textContent || '').join(' ') : '';
    const imageAlt = Array.from(element.querySelectorAll('img[alt]')).map((img) => img.getAttribute('alt') || '').join(' ');
    return [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('alt'),
      imageAlt,
      inputElement.placeholder,
      labelText,
      ownText(element),
      inputElement.value,
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);
  }

  function topmostRenderableAt(x: number, y: number) {
    return runtime.topmostRenderableAt(x, y, { requirePointerEvents });
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
        owned += 1;
        if (!visiblePoint) visiblePoint = { x: Math.round(px), y: Math.round(py) };
        if (
          isInteriorGridPoint &&
          isIndependentPointForOwner(element, top) &&
          isSeparatedFromInteractiveDescendants(descendantRects, px, py)
        ) {
          independentGridPoints.add(`${gridRow}:${gridCol}`);
          if (!independentInteriorPoint) independentInteriorPoint = { x: Math.round(px), y: Math.round(py) };
        }
      } else if (!composedContains(top, element)) {
        covered += 1;
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
    let guard = 0;
    while (queue.length && guard < 4000) {
      const child = queue.shift() as Element;
      const tag = child.tagName.toLowerCase();
      const childInput = ['input', 'textarea', 'select'].includes(tag) || isContentEditableOwner(child);
      const childInteractive = clickableReason(child) || childInput || hasOwnHoverSignal(child) || hasCssHoverEffect(child);
      const rect = visibleRectOf(child);
      if (tag !== 'label' && !childInteractive && rect) {
        const visibility = computeVisibility(element, rect);
        if (visibility?.visiblePoint && !(visibility.coveredRatio > 0.5 && visibility.ownedRatio < 0.35)) return { rect, visibility };
      }
      queue.push(...children(child));
      guard += 1;
    }
    return undefined;
  }

  function candidateFrom(element: Element, path: number[]): PageInteractiveCandidate | undefined {
    const tag = element.tagName.toLowerCase();
    const labelControl = labelControlFor(element);
    const role = element.getAttribute('role') || undefined;
    const inputElement = element as HTMLInputElement;
    const isInput = ['input', 'textarea', 'select'].includes(tag) || isContentEditableOwner(element);
    const signals = interactionSignals(element, tag);
    const clickable = signals.length > 0;
    if (!clickable && !isInput) return undefined;

    const href = tag === 'a' ? ((element as HTMLAnchorElement).href || element.getAttribute('href') || undefined) : undefined;
    const text = ownText(element);
    const name = nameOf(element);
    const placeholder = inputElement.placeholder || undefined;
    const ariaLabel = element.getAttribute('aria-label') || undefined;
    const title = element.getAttribute('title') || undefined;
    let nearbyText: string | undefined;
    if (!labelsMatchCandidateTextQuery([name, text, ariaLabel || undefined, title || undefined, placeholder, href])) {
      nearbyText = contextText(element) || undefined;
      if (!labelsMatchCandidateTextQuery([nearbyText])) return undefined;
    }

    let rect = visibleRectOf(element);
    let visibility = rect ? computeVisibility(element, rect) : undefined;
    if (!rect && clickable) {
      const proxy = visibleProxyForZeroSizeOwner(element);
      rect = proxy?.rect;
      visibility = proxy?.visibility;
    }
    if (!rect || !visibility?.visiblePoint) return undefined;
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

    let host: string | undefined;
    try {
      host = href ? new URL(href).hostname : undefined;
    } catch {
      host = undefined;
    }
    const externalAppTarget = externalAppTargetForElement(element, href);

    const className = classNameOf(element);
    const type = tag === 'input' || tag === 'button' ? element.getAttribute('type') || undefined : undefined;
    nearbyText ||= contextText(element) || undefined;

    return {
      id: '',
      path: path.join('.'),
      tag,
      role,
      type,
      name: name || undefined,
      text: text || undefined,
      className: className || undefined,
      signals: signals.length ? signals : undefined,
      nearbyText,
      href,
      host,
      opensExternalApp: externalAppTarget ? true : undefined,
      externalAppProtocol: externalAppTarget?.protocol,
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
      disabled: Boolean(
        inputElement.disabled ||
        (labelControl && (labelControl as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement).disabled) ||
        element.getAttribute('aria-disabled') === 'true',
      ),
      hasIndependentClickArea,
      shadow: isInsideShadow(element),
    };
  }

  function pathParts(value: string) {
    return value.split('.').map((item) => Number(item));
  }

  function comparePath(a: string, b: string) {
    const ap = pathParts(a);
    const bp = pathParts(b);
    const length = Math.min(ap.length, bp.length);
    for (let index = 0; index < length; index += 1) {
      if (ap[index] !== bp[index]) return ap[index] - bp[index];
    }
    return ap.length - bp.length;
  }

  const raw: PageInteractiveCandidate[] = [];
  const seenPaths = new Set<string>();
  let visitedElements = 0;

  function pushCandidate(element: Element, path: number[]) {
    const pathKey = path.join('.');
    if (seenPaths.has(pathKey)) return;
    if (!includeInteractiveCandidates) return;
    const candidate = candidateFrom(element, path);
    if (!candidate) return;
    raw.push(candidate);
    seenPaths.add(pathKey);
  }

  function walk(element: Element, path: number[], depth: number, textDepth: number) {
    visitedElements += 1;
    if (visitedElements > 50000 || depth > 128) return;
    if (window.getComputedStyle(element).display === 'none') return;
    const structured = maxStructuredTextChars ? structuredTextLine(element) : undefined;
    const nextTextDepth = structured?.shown ? textDepth + 1 : textDepth;
    if (structured?.text) appendStructuredText(textDepth, structured.text);
    pushCandidate(element, path);
    const childNodes = children(element);
    for (let index = 0; index < childNodes.length; index += 1) {
      walk(childNodes[index], [...path, index], depth + 1, nextTextDepth);
    }
  }

  walk(document.documentElement, [0], 0, 0);

  const candidates = raw
    .sort((a, b) => comparePath(a.path, b.path) || a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  return {
    structuredText: structuredLines.join('\n'),
    interactiveCandidates: candidates.map((candidate, index) => ({ ...candidate, id: `${index + 1}` })),
  };
}

function applyPageGroupMarker(input: { id: string; title: string; prefix: string; applyPrefix: boolean }) {
  Object.defineProperty(window, '__aiWebTestSessionGroupId', {
    configurable: true,
    enumerable: false,
    value: input.id,
    writable: true,
  });
  document.documentElement?.setAttribute('data-ai-web-test-session-group-id', input.id);
  const windowNameMarker = `AI_WEB_TEST_SESSION_GROUP:${input.id};`;
  const previousWindowName = String(window.name || '').replace(/^AI_WEB_TEST_SESSION_GROUP:[^;]*;/, '');
  window.name = `${windowNameMarker}${previousWindowName}`;
  window.postMessage({
    source: 'AI_WEB_TEST_SESSION_TAB_GROUP',
    type: 'group-tab',
    sessionId: input.id,
    groupTitle: input.title,
  }, '*');

  if (!input.applyPrefix) return;
  const stateKey = '__aiWebTestTabGroupTitleState';
  const win = window as Window & {
    [stateKey]?: {
      applying?: boolean;
      observer?: MutationObserver;
      prefix: string;
    };
  };
  const state = win[stateKey] || { prefix: input.prefix };
  state.prefix = input.prefix;
  win[stateKey] = state;
  const apply = () => {
    if (state.applying) return;
    const current = document.title || '';
    const prefixes = /^【(?:AI会话|ai-)[^】]*】\s*/i;
    const clean = current.replace(prefixes, '').trim();
    const next = `${state.prefix}${clean ? ` ${clean}` : ''}`;
    if (current === next) return;
    state.applying = true;
    document.title = next;
    state.applying = false;
  };
  apply();
  if (!state.observer) {
    state.observer = new MutationObserver(apply);
    const titleElement = document.querySelector('title');
    if (titleElement) state.observer.observe(titleElement, { childList: true, characterData: true, subtree: true });
  }
}

function sharedBrowserKey(input: {
  cdpEndpoint: string;
  userDataDir: string;
  launchOptions: LaunchOptions;
  contextOptions: BrowserContextOptions;
}) {
  if (input.cdpEndpoint) return `cdp:${input.cdpEndpoint}`;
  if (input.userDataDir) return `persistent:${path.resolve(input.userDataDir)}`;
  return `launch:${JSON.stringify({ launch: input.launchOptions, context: input.contextOptions })}`;
}

async function connectExistingBrowserOverCdp(input: {
  chromium: BrowserType;
  endpoint: string;
  contextOptions: BrowserContextOptions;
}) {
  if (!input.endpoint) return undefined;
  const browser = await input.chromium.connectOverCDP(input.endpoint, { timeout: 800 }).catch(() => undefined);
  if (!browser) return undefined;
  const context = browser.contexts()[0] || await browser.newContext(input.contextOptions);
  return { browser, context, ownership: 'connected' as const };
}

function externalChromiumExecutablePath(chromium: BrowserType, launchOptions: LaunchOptions) {
  const explicit = typeof launchOptions.executablePath === 'string' ? launchOptions.executablePath.trim() : '';
  if (explicit) return explicit;
  if (launchOptions.channel) {
    throw new Error('BROWSER_CHANNEL cannot be used with automatic tab-group reuse unless AI_WEB_TEST_CHROMIUM_EXECUTABLE_PATH points to the browser executable.');
  }
  return chromium.executablePath();
}

async function connectOrLaunchPersistentBrowserOverCdp(input: {
  chromium: BrowserType;
  endpoint: string;
  userDataDir: string;
  launchOptions: LaunchOptions;
  contextOptions: BrowserContextOptions;
}) {
  const existing = await connectExistingBrowserOverCdp({
    chromium: input.chromium,
    endpoint: input.endpoint,
    contextOptions: input.contextOptions,
  });
  if (existing) return existing;

  const port = cdpPortFromEndpoint(input.endpoint);
  if (!port) throw new Error(`Automatic tab-group browser reuse needs a CDP port endpoint, got: ${input.endpoint || '[empty]'}`);

  const executablePath = externalChromiumExecutablePath(input.chromium, input.launchOptions);
  const launchArgs = [
    ...(input.launchOptions.args || []).filter((arg) => !/^--remote-debugging-(?:pipe|port)(?:=|$)/.test(arg)),
    `--user-data-dir=${input.userDataDir}`,
    `--remote-debugging-port=${port}`,
    '--no-startup-window',
  ];
  let spawnError: unknown;
  const child = spawn(executablePath, launchArgs, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.once('error', (error) => {
    spawnError = error;
  });
  child.unref();

  const timeoutMs = Math.max(3000, Number(process.env.BROWSER_CDP_LAUNCH_TIMEOUT_MS || 15000));
  const deadline = Date.now() + timeoutMs;
  let lastConnectError = '';
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new Error(`Failed to launch test Chrome for tab-group reuse: ${spawnError instanceof Error ? spawnError.message : String(spawnError)}`);
    }
    const connected = await connectExistingBrowserOverCdp({
      chromium: input.chromium,
      endpoint: input.endpoint,
      contextOptions: input.contextOptions,
    }).catch((error) => {
      lastConnectError = error instanceof Error ? error.message : String(error);
      return undefined;
    });
    if (connected) return connected;
    await sleep(250);
  }

  throw new Error([
    `Failed to connect to test Chrome at ${input.endpoint} after launching it.`,
    `profile=${input.userDataDir}`,
    `executable=${executablePath}`,
    'If an old test Chrome already has this profile open but was launched without the expected CDP port, close that old window once and retry.',
    lastConnectError ? `lastConnectError=${lastConnectError}` : '',
  ].filter(Boolean).join('\n'));
}

function isPersistentProfileAlreadyOpenError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /Target page, context or browser has been closed|browser session|user data directory|profile.*in use|already.*open/i.test(message);
}

async function closeIdleSharedBrowser(force = false) {
  if (sharedBrowserState.refCount > 0) return;
  const shouldClose = force || process.env.BROWSER_CLOSE_SHARED_WHEN_IDLE === 'true';
  if (!shouldClose) return;

  const { browser, context, ownership } = sharedBrowserState;
  if (ownership === 'persistent') {
    await context?.close().catch(() => undefined);
  } else if (ownership === 'launched') {
    await browser?.close().catch(() => undefined);
  } else if (ownership === 'connected' && process.env.BROWSER_CLOSE_CONNECTED_ON_SHARED_RESET === 'true') {
    await browser?.close({ reason: 'Shared browser launch settings changed.' }).catch(() => undefined);
  }
  sharedBrowserState.browser = undefined;
  sharedBrowserState.context = undefined;
  sharedBrowserState.ownership = undefined;
  sharedBrowserState.initPromise = undefined;
  sharedBrowserState.key = undefined;
}

async function acquireSharedBrowser(input: {
  chromium: BrowserType;
  cdpEndpoint: string;
  reconnectCdpEndpoint?: string;
  userDataDir: string;
  launchOptions: LaunchOptions;
  contextOptions: BrowserContextOptions;
}): Promise<SharedBrowserLease> {
  const key = sharedBrowserKey(input);
  if (sharedBrowserState.key && sharedBrowserState.key !== key && sharedBrowserState.refCount > 0) {
    throw new Error('A shared browser is already running with different launch settings. Stop active runs or set BROWSER_SHARED_TABS=false.');
  }
  if (sharedBrowserState.key && sharedBrowserState.key !== key && sharedBrowserState.refCount === 0) {
    await closeIdleSharedBrowser(true);
  }

  const browserStillConnected = !sharedBrowserState.browser || sharedBrowserState.browser.isConnected();
  if (!sharedBrowserState.initPromise || sharedBrowserState.key !== key || !browserStillConnected || !sharedBrowserState.context) {
    sharedBrowserState.key = key;
    sharedBrowserState.initPromise = (async () => {
      if (input.cdpEndpoint) {
        const browser = await input.chromium.connectOverCDP(input.cdpEndpoint);
        const context = browser.contexts()[0] || await browser.newContext(input.contextOptions);
        return { browser, context, ownership: 'connected' as const };
      }

      if (input.userDataDir) {
        if (input.reconnectCdpEndpoint) {
          return connectOrLaunchPersistentBrowserOverCdp({
            chromium: input.chromium,
            endpoint: input.reconnectCdpEndpoint,
            userDataDir: input.userDataDir,
            launchOptions: input.launchOptions,
            contextOptions: input.contextOptions,
          });
        }
        try {
          const context = await input.chromium.launchPersistentContext(input.userDataDir, {
            ...input.launchOptions,
            ...input.contextOptions,
          });
          return { browser: context.browser() || undefined, context, ownership: 'persistent' as const };
        } catch (error) {
          const retryConnected = await connectExistingBrowserOverCdp({
            chromium: input.chromium,
            endpoint: input.reconnectCdpEndpoint || '',
            contextOptions: input.contextOptions,
          });
          if (retryConnected) return retryConnected;
          if (input.reconnectCdpEndpoint && isPersistentProfileAlreadyOpenError(error)) {
            throw new Error([
              '无法接管上一次的浏览器 tab 组：该 persistent profile 已经被一个旧浏览器进程占用，但旧进程没有可连接的 CDP 端口。',
              `profile=${input.userDataDir}`,
              `expectedCdp=${input.reconnectCdpEndpoint}`,
              '请关闭这个旧的自动化浏览器窗口一次；之后新启动的窗口会带 CDP 端口，继续时会优先连接并接管旧 tab 组。',
              error instanceof Error ? error.message : String(error),
            ].join('\n'));
          }
          throw error;
        }
      }

      const browser = await input.chromium.launch(input.launchOptions);
      const context = await browser.newContext(input.contextOptions);
      return { browser, context, ownership: 'launched' as const };
    })().then((lease) => {
      sharedBrowserState.browser = lease.browser;
      sharedBrowserState.context = lease.context;
      sharedBrowserState.ownership = lease.ownership;
      return lease;
    });
  }

  const lease = await sharedBrowserState.initPromise;
  sharedBrowserState.refCount += 1;
  let released = false;
  return {
    ...lease,
    release: async () => {
      if (released) return;
      released = true;
      sharedBrowserState.refCount = Math.max(0, sharedBrowserState.refCount - 1);
      await closeIdleSharedBrowser();
    },
  };
}

export class BrowserSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private consoleErrors: string[] = [];
  private networkErrors: string[] = [];
  private attachedPages = new WeakSet<Page>();
  private httpRequestsByPage = new WeakMap<Page, HttpRequestRecord[]>();
  private httpRequestByRequest = new WeakMap<Request, HttpRequestRecord>();
  private lastScreenshotMetrics?: ScreenshotMetrics;
  private screenshotGenerationSequence = 0;
  private lastInteractiveCandidates: InteractiveCandidate[] = [];
  private lastScreenshotCandidates: InteractiveCandidate[] = [];
  private lastDomNodeReferences = new Map<string, DomNodeReference>();
  private domVisiblePublicIdByFrameLocalRef = new Map<string, string>();
  private domVisibleSnapshotKey?: string;
  private domVisibleNextPublicId = 1;
  private lastScrollableAreas: ScrollableArea[] = [];
  private lastCandidateMarkerScreenshotPath?: string;
  private lastOriginalScreenshotPath?: string;
  private lastScreenshotTiming?: ScreenshotTiming;
  private ownedPages = new Set<Page>();
  private browserOwnership: BrowserOwnership = 'launched';
  private releaseSharedBrowser?: () => Promise<void>;
  private pageDiscoveryListener?: (page: Page) => void;
  private pageGroupInitScriptPages = new WeakSet<Page>();
  private snapshotGeneration?: SnapshotGeneration;
  private snapshotGenerationPromise?: Promise<SnapshotGeneration>;
  private snapshotGenerationSequence = 0;
  private snapshotUidSequence = 0;
  private snapshotUidByIdentity = new Map<string, { uid: string; lastSeenGeneration: number }>();
  private snapshotPageSequence = 0;
  private snapshotPageIds = new WeakMap<Page, string>();
  private accessibilitySnapshotExportControlInstalled = false;
  private accessibilitySnapshotExporter?: () => Promise<AccessibilitySnapshotExportControlResult>;
  private readonly pageGroupId: string;

  constructor(
    private readonly mode: BrowserSessionMode = browserSessionModeFromEnv(),
    private readonly options: BrowserSessionOptions = {},
  ) {
    this.pageGroupId = normalizePageGroupId(options.runId);
  }

  isUsable() {
    try {
      if (!this.context) return false;
      if (this.browser && !this.browser.isConnected()) return false;
      return this.sessionPages().length > 0;
    } catch {
      return false;
    }
  }

  currentUrl() {
    try {
      return this.activePage.url();
    } catch {
      return '';
    }
  }

  hasNonBlankActivePage() {
    try {
      return !isBlankPage(this.activePage);
    } catch {
      return false;
    }
  }

  // 启动 Playwright 浏览器并注入事件监听记录脚本，用于后续识别可交互元素。
  async start() {
    const { chromium } = await import('playwright');
    const headless = this.options.debugDevtools ? false : this.options.headless ?? process.env.HEADLESS_BROWSER === 'true';
    const isolated = this.options.isolated === true;
    const fullscreen = process.env.BROWSER_FULLSCREEN !== 'false';
    const configuredViewportWidth = positiveIntegerEnv('BROWSER_VIEWPORT_WIDTH');
    const configuredViewportHeight = positiveIntegerEnv('BROWSER_VIEWPORT_HEIGHT');
    const hasConfiguredViewport = configuredViewportWidth !== undefined && configuredViewportHeight !== undefined;
    const rawViewportMode = process.env.BROWSER_VIEWPORT_MODE?.trim().toLowerCase();
    const viewportMode = rawViewportMode === 'fixed' || (!rawViewportMode && hasConfiguredViewport) ? 'fixed' : 'auto';
    const fixedViewport = viewportMode === 'fixed' && hasConfiguredViewport
      ? { width: configuredViewportWidth, height: configuredViewportHeight }
      : undefined;
    const headlessFallbackViewport = { width: fullscreen ? 1920 : 1280, height: fullscreen ? 1080 : 800 };
    const useNativeViewport = !headless && !fixedViewport;
    const contextViewport = useNativeViewport ? null : fixedViewport || headlessFallbackViewport;
    const windowSizeArg = fixedViewport
      ? `--window-size=${fixedViewport.width},${fixedViewport.height + 120}`
      : headless
        ? `--window-size=${headlessFallbackViewport.width},${headlessFallbackViewport.height + 120}`
        : '';
    const ignoreHTTPSErrors = process.env.BROWSER_IGNORE_HTTPS_ERRORS !== 'false';
    const useElectronEmbeddedBrowser = !isolated && electronEmbeddedBrowserEnabled();
    const forceBundledBrowser = isolated || (process.env.AI_WEB_TEST_FORCE_PLAYWRIGHT_BROWSER === 'true' && !useElectronEmbeddedBrowser);
    const channel = forceBundledBrowser ? undefined : process.env.BROWSER_CHANNEL?.trim() || undefined;
    const executablePath = process.env.AI_WEB_TEST_CHROMIUM_EXECUTABLE_PATH?.trim() || undefined;
    const browserProfileKey = this.options.browserProfileKey ? normalizePageGroupId(this.options.browserProfileKey) : '';
    const rawCdpEndpoint = forceBundledBrowser
      ? ''
      : process.env.BROWSER_CDP_ENDPOINT?.trim()
        || process.env.BROWSER_CONNECT_CDP_ENDPOINT?.trim()
        || process.env.CHROME_REMOTE_DEBUGGING_URL?.trim()
        || electronEmbeddedBrowserCdpEndpoint()
        || '';
    const cdpEndpoint = browserProfileKey && rawCdpEndpoint && !useElectronEmbeddedBrowser
      ? /\{(?:browserProfileKey|profileKey)\}/.test(rawCdpEndpoint)
        ? rawCdpEndpoint
          .replace(/\{browserProfileKey\}/g, encodeURIComponent(browserProfileKey))
          .replace(/\{profileKey\}/g, encodeURIComponent(browserProfileKey))
        : ''
      : rawCdpEndpoint;
    const configuredUserDataDir = isolated
      ? ''
      : process.env.BROWSER_USER_DATA_DIR?.trim()
        || process.env.AI_WEB_TEST_BROWSER_PROFILE_DIR?.trim()
        || '';
    const requestedUserDataDir = configuredUserDataDir && browserProfileKey
      ? path.join(configuredUserDataDir, browserProfileKey)
      : configuredUserDataDir;
    const tabGrouperEnabled = !isolated && sessionTabGrouperEnabled(headless);
    const useSharedBrowserTabs = !isolated && sharedBrowserTabsEnabled() && !useElectronEmbeddedBrowser && !browserProfileKey;
    const useSessionGroupPageSelection = tabGrouperEnabled || Boolean(browserProfileKey);
    const restoreLastSession = tabGrouperEnabled && process.env.BROWSER_RESTORE_LAST_SESSION !== 'false';
    const autoTabGroupProfileKey = browserProfileKey || (useSharedBrowserTabs ? 'shared' : this.pageGroupId);
    const autoTabGroupProfileDir = tabGrouperEnabled && !cdpEndpoint && !requestedUserDataDir
      ? sessionTabGrouperProfileDir(autoTabGroupProfileKey)
      : '';
    const autoTabGroupDebugPort = (autoTabGroupProfileDir || (tabGrouperEnabled && browserProfileKey && !cdpEndpoint))
      ? sessionTabGrouperDebugPort(autoTabGroupProfileKey)
      : undefined;
    const autoTabGroupCdpEndpoint = cdpEndpointForPort(autoTabGroupDebugPort);
    const userDataDir = requestedUserDataDir || autoTabGroupProfileDir;
    if (userDataDir) await mkdir(userDataDir, { recursive: true });
    const launchOptions: LaunchOptions = {
      headless,
      slowMo: Number(process.env.BROWSER_SLOW_MO_MS || 250),
      ...(channel ? { channel } : {}),
      ...(executablePath && !channel ? { executablePath } : {}),
      ...(tabGrouperEnabled ? { ignoreDefaultArgs: ['--disable-extensions'] } : {}),
      args: withSessionTabGrouperArgs([
        windowSizeArg,
        fullscreen ? '--start-maximized' : '',
        ignoreHTTPSErrors ? '--ignore-certificate-errors' : '',
        '--force-device-scale-factor=1',
        '--high-dpi-support=1',
        '--no-first-run',
        '--no-default-browser-check',
        this.options.debugDevtools ? '--auto-open-devtools-for-tabs' : '',
        restoreLastSession ? '--restore-last-session' : '',
        autoTabGroupDebugPort ? `--remote-debugging-port=${autoTabGroupDebugPort}` : '',
      ].filter(Boolean), headless, { exclusive: Boolean(autoTabGroupProfileDir) }),
    };
    const contextOptions: BrowserContextOptions = {
      viewport: contextViewport,
      ignoreHTTPSErrors,
      ...(contextViewport ? { deviceScaleFactor: 1 } : {}),
    };

    if (useSharedBrowserTabs) {
      const lease = await acquireSharedBrowser({ chromium, cdpEndpoint, reconnectCdpEndpoint: autoTabGroupCdpEndpoint, userDataDir, launchOptions, contextOptions });
      this.browserOwnership = 'shared';
      this.browser = lease.browser;
      this.context = lease.context;
      this.releaseSharedBrowser = lease.release;
      await this.selectInitialSessionGroupPage(lease.context);
      return;
    }

    if (cdpEndpoint) {
      this.browserOwnership = 'connected';
      this.browser = await chromium.connectOverCDP(cdpEndpoint);
      const existingContext = this.browser.contexts()[0];
      const context = existingContext || await this.browser.newContext(contextOptions);
      this.context = context;
      if (useElectronEmbeddedBrowser) {
        await this.prepareContext(context, { claimPages: false });
        this.installElectronEmbeddedBrowserPageDiscovery(context);
        const embeddedPages = await this.findInitialElectronEmbeddedBrowserPages(context);
        const embeddedPage = this.chooseInitialPage(embeddedPages);
        if (embeddedPage) {
          this.page = embeddedPage;
          await embeddedPage.bringToFront().catch(() => undefined);
          return;
        }
        throw new Error('Electron embedded browser tab for this session is not ready.');
      }
      if (useSessionGroupPageSelection) {
        await this.selectInitialSessionGroupPage(context);
      } else {
        await this.prepareContext(context);
        await this.selectInitialPage(context);
      }
      return;
    }

    if (userDataDir) {
      if (autoTabGroupCdpEndpoint) {
        const connected = await connectOrLaunchPersistentBrowserOverCdp({
          chromium,
          endpoint: autoTabGroupCdpEndpoint,
          userDataDir,
          launchOptions,
          contextOptions,
        });
        this.browserOwnership = 'connected';
        this.browser = connected.browser;
        this.context = connected.context;
        if (useSessionGroupPageSelection) {
          await this.selectInitialSessionGroupPage(connected.context);
        } else {
          await this.prepareContext(connected.context);
          await this.selectInitialPage(connected.context);
        }
        return;
      }
      this.browserOwnership = 'persistent';
      let context: BrowserContext;
      try {
        context = await chromium.launchPersistentContext(userDataDir, {
          ...launchOptions,
          ...contextOptions,
        });
      } catch (error) {
        const connected = await connectExistingBrowserOverCdp({ chromium, endpoint: autoTabGroupCdpEndpoint, contextOptions });
        if (!connected) throw error;
        this.browserOwnership = 'connected';
        this.browser = connected.browser;
        this.context = connected.context;
        if (useSessionGroupPageSelection) {
          await this.selectInitialSessionGroupPage(connected.context);
        } else {
          await this.prepareContext(connected.context);
          await this.selectInitialPage(connected.context);
        }
        return;
      }
      this.context = context;
      this.browser = context.browser() || undefined;
      if (useSessionGroupPageSelection) {
        await this.selectInitialSessionGroupPage(context);
      } else {
        await this.prepareContext(context);
        await this.selectInitialPage(context);
      }
      return;
    }

    this.browserOwnership = 'launched';
    this.browser = await chromium.launch(launchOptions);
    const context = await this.browser.newContext(contextOptions);
    this.context = context;
    await this.prepareContext(context);
    this.claimPage(await context.newPage());
  }

  private async selectInitialSessionGroupPage(context: BrowserContext) {
    await this.prepareContext(context, { claimPages: false });
    this.installOwnedPageDiscovery(context);
    const page = await this.findInitialSharedPage(context);
    await page.bringToFront().catch(() => undefined);
    return page;
  }

  private async findInitialSharedPage(context: BrowserContext) {
    const reclaimedPages = await this.reclaimSessionPagesByMarker(context);
    const reclaimed = this.chooseInitialPage(reclaimedPages);
    if (reclaimed) {
      this.page = reclaimed;
      return reclaimed;
    }

    const embeddedPage = await this.findElectronEmbeddedBrowserPage(context);
    if (embeddedPage && this.claimPage(embeddedPage, { allowSteal: true })) {
      await embeddedPage.bringToFront().catch(() => undefined);
      return embeddedPage;
    }

    const nativeGroup = await this.reclaimPagesFromNativeTabGroup(context);
    const nativeGroupPage = this.chooseInitialPage(nativeGroup.pages);
    if (nativeGroupPage) {
      this.page = nativeGroupPage;
      return nativeGroupPage;
    }
    if (nativeGroup.found) {
      const page = await context.newPage();
      this.claimPage(page);
      return page;
    }

    if (this.options.preferExistingPage) {
      const unmarkedPages: Page[] = [];
      for (const page of context.pages()) {
        if (page.isClosed() || isBlankPage(page)) continue;
        if (await this.isElectronAppShellPage(page)) continue;
        if (sharedPageOwners.has(page)) continue;
        const groupId = await this.readPageGroupId(page);
        if (groupId) continue;
        unmarkedPages.push(page);
      }
      const existingPage = unmarkedPages.at(-1);
      if (existingPage && this.claimPage(existingPage)) return existingPage;
    }

    for (const page of context.pages()) {
      if (page.isClosed() || !isBlankPage(page)) continue;
      if (await this.isElectronAppShellPage(page)) continue;
      if (sharedPageOwners.has(page)) continue;
      const groupId = await this.readPageGroupId(page);
      if (groupId) continue;
      if (this.claimPage(page)) return page;
    }

    const page = await context.newPage();
    this.claimPage(page);
    return page;
  }

  private chooseInitialPage(pages: Page[]) {
    return pages.find((page) => !isBlankPage(page)) || pages.at(-1);
  }

  private async isElectronEmbeddedBrowserPage(page: Page) {
    if (!electronEmbeddedBrowserEnabled() || page.isClosed()) return false;
    return page.evaluate(() => {
      const win = window as Window & { __webPilotEmbeddedBrowserView?: unknown };
      return win.__webPilotEmbeddedBrowserView === true
        || document.documentElement?.getAttribute('data-webpilot-embedded-browser') === 'true';
    }).catch(() => false);
  }

  private async isElectronEmbeddedBrowserSessionPage(page: Page) {
    if (!await this.isElectronEmbeddedBrowserPage(page)) return false;
    const sessionId = await page.evaluate(() => {
      const win = window as Window & { __webPilotEmbeddedBrowserSessionId?: unknown };
      if (typeof win.__webPilotEmbeddedBrowserSessionId === 'string') return win.__webPilotEmbeddedBrowserSessionId;
      const attributeId = document.documentElement?.getAttribute('data-webpilot-embedded-browser-session-id');
      if (attributeId) return attributeId;
      return String(window.name || '').match(/^AI_WEB_TEST_SESSION_GROUP:([^;]+);/)?.[1] || '';
    }).catch(() => '');
    return sessionId === this.options.runId || normalizePageGroupId(sessionId) === this.pageGroupId;
  }

  private async isElectronAppShellPage(page: Page) {
    if (!electronEmbeddedBrowserEnabled() || page.isClosed()) return false;
    return page.evaluate(() => {
      const win = window as Window & { __webPilotAppShell?: unknown };
      return win.__webPilotAppShell === true
        || document.documentElement?.getAttribute('data-webpilot-app-shell') === 'true';
    }).catch(() => false);
  }

  private async findElectronEmbeddedBrowserPage(context: BrowserContext) {
    if (!electronEmbeddedBrowserEnabled()) return undefined;
    for (const page of [...context.pages()].reverse()) {
      if (page.isClosed()) continue;
      if (await this.isElectronEmbeddedBrowserPage(page)) return page;
    }
    return undefined;
  }

  private async findInitialElectronEmbeddedBrowserPages(context: BrowserContext) {
    if (!electronEmbeddedBrowserEnabled()) return [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const pages: Page[] = [];
      for (const page of [...context.pages()].reverse()) {
        if (page.isClosed()) continue;
        if (await this.isElectronEmbeddedBrowserSessionPage(page) && this.claimPage(page, { allowSteal: true, makeActive: false })) {
          pages.push(page);
        }
      }
      if (pages.length) return pages.reverse();
      if (attempt < 11) await sleep(160);
    }
    return [];
  }

  private async reclaimSessionPagesByMarker(context: BrowserContext) {
    const reclaimedPages: Page[] = [];
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      const groupId = await this.readPageGroupId(page);
      if (groupId === this.pageGroupId && this.claimPage(page, { makeActive: false })) {
        reclaimedPages.push(page);
      }
    }
    return reclaimedPages;
  }

  private async reclaimPagesFromNativeTabGroup(context: BrowserContext): Promise<{ found: boolean; pages: Page[] }> {
    const lookup = await this.findNativeTabGroupTabs(context);
    if (!lookup?.found) return { found: false, pages: [] };

    const existingPages = await this.waitForNativeGroupPages(context, lookup.tabs, 4);
    if (existingPages.length) return { found: true, pages: existingPages };

    await this.activateNativeTabGroupTab(context, lookup.tabs);
    const activatedPages = await this.waitForNativeGroupPages(context, lookup.tabs, 8);
    return { found: true, pages: activatedPages };
  }

  private async sessionTabGrouperWorker(context: BrowserContext) {
    const isGrouperWorker = (worker: PlaywrightWorker) => {
      const url = worker.url();
      return url.startsWith('chrome-extension://') && url.endsWith('/service-worker.js');
    };
    const existing = context.serviceWorkers().find(isGrouperWorker);
    if (existing) return existing;
    return context.waitForEvent('serviceworker', { predicate: isGrouperWorker, timeout: 800 }).catch(() => undefined);
  }

  private async findNativeTabGroupTabs(context: BrowserContext): Promise<NativeTabGroupLookup | undefined> {
    const worker = await this.sessionTabGrouperWorker(context);
    if (!worker) return undefined;
    return worker.evaluate(async (input: { sessionId: string; groupTitle: string }) => {
      const global = globalThis as unknown as {
        aiWebTestSessionTabGrouper?: {
          findSessionGroupTabs?: (input: { sessionId: string; groupTitle: string }) => Promise<NativeTabGroupLookup>;
        };
      };
      return global.aiWebTestSessionTabGrouper?.findSessionGroupTabs?.(input);
    }, {
      sessionId: this.pageGroupId,
      groupTitle: this.tabGroupLabel(),
    }).catch(() => undefined);
  }

  private chooseNativeTabGroupTab(tabs: NativeTabGroupPage[]) {
    return tabs.find((tab) => tab.active && tab.url && !isBlankBrowserUrlLike(tab.url))
      || tabs.find((tab) => tab.url && !isBlankBrowserUrlLike(tab.url))
      || tabs.find((tab) => tab.active)
      || tabs.at(-1);
  }

  private async activateNativeTabGroupTab(context: BrowserContext, tabs: NativeTabGroupPage[]) {
    const tab = this.chooseNativeTabGroupTab(tabs);
    if (!tab?.tabId) return undefined;
    const worker = await this.sessionTabGrouperWorker(context);
    if (!worker) return undefined;
    return worker.evaluate(async (input: { sessionId: string; groupTitle: string; tabId: number }) => {
      const global = globalThis as unknown as {
        aiWebTestSessionTabGrouper?: {
          activateSessionGroupTab?: (input: { sessionId: string; groupTitle: string; tabId: number }) => Promise<NativeTabGroupActivation>;
        };
      };
      return global.aiWebTestSessionTabGrouper?.activateSessionGroupTab?.(input);
    }, {
      sessionId: this.pageGroupId,
      groupTitle: this.tabGroupLabel(),
      tabId: tab.tabId,
    }).catch(() => undefined);
  }

  private async waitForNativeGroupPages(context: BrowserContext, tabs: NativeTabGroupPage[], attempts: number) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const markedPages = await this.reclaimSessionPagesByMarker(context);
      if (markedPages.length) return markedPages;

      const urlClaimedPages = await this.claimPagesByNativeTabUrls(context, tabs);
      if (urlClaimedPages.length) return urlClaimedPages;

      if (attempt < attempts - 1) await sleep(150);
    }
    return [] as Page[];
  }

  private async claimPagesByNativeTabUrls(context: BrowserContext, tabs: NativeTabGroupPage[]) {
    const remainingByUrl = new Map<string, number>();
    for (const tab of tabs) {
      if (!tab.url || isBlankBrowserUrlLike(tab.url)) continue;
      remainingByUrl.set(tab.url, (remainingByUrl.get(tab.url) || 0) + 1);
    }
    if (!remainingByUrl.size) return [];

    const claimedPages: Page[] = [];
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      const url = page.url();
      const remaining = remainingByUrl.get(url) || 0;
      if (remaining <= 0) continue;
      remainingByUrl.set(url, remaining - 1);
      if (this.claimPage(page, { makeActive: false })) claimedPages.push(page);
    }
    return claimedPages;
  }

  private async prepareContext(context: BrowserContext, options: { claimPages?: boolean } = {}) {
    if (!preparedContextInitScripts.has(context)) {
      preparedContextInitScripts.add(context);
      await context.addInitScript({ content: aiDomMutationObserverScript }).catch((error) => {
        preparedContextInitScripts.delete(context);
        throw error;
      });
      await context.addInitScript(installAiBrowserPageRuntime).catch((error) => {
        preparedContextInitScripts.delete(context);
        throw error;
      });
    }
    if (options.claimPages === false) return;
    context.on('page', (page) => this.claimPage(page));
    for (const page of context.pages()) this.claimPage(page, { makeActive: false });
  }

  private installOwnedPageDiscovery(context: BrowserContext) {
    if (this.pageDiscoveryListener) return;
    this.pageDiscoveryListener = (page) => {
      void this.claimPopupIfOwned(page);
    };
    context.on('page', this.pageDiscoveryListener);
  }

  private installElectronEmbeddedBrowserPageDiscovery(context: BrowserContext) {
    if (this.pageDiscoveryListener) return;
    this.pageDiscoveryListener = (page) => {
      void (async () => {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          if (page.isClosed()) return;
          if (await this.isElectronEmbeddedBrowserSessionPage(page)) {
            if (this.claimPage(page, { allowSteal: true })) {
              await page.bringToFront().catch(() => undefined);
            }
            return;
          }
          if (attempt < 7) await sleep(120);
        }
      })();
    };
    context.on('page', this.pageDiscoveryListener);
  }

  private async claimPopupIfOwned(page: Page) {
    const opener = await page.opener().catch(() => null);
    if (!opener || !this.ownedPages.has(opener)) return;
    if (this.claimPage(page)) await page.bringToFront().catch(() => undefined);
  }

  async startTrace(runId: string) {
    if (!this.context || process.env.PLAYWRIGHT_TRACE === 'false') return;
    if (this.browserOwnership === 'shared' && process.env.PLAYWRIGHT_TRACE_SHARED !== 'true') return;
    await this.context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
      title: `AI browser run ${runId}`,
    }).catch(() => undefined);
  }

  async stopTrace(runId: string) {
    if (!this.context || process.env.PLAYWRIGHT_TRACE === 'false') return undefined;
    if (this.browserOwnership === 'shared' && process.env.PLAYWRIGHT_TRACE_SHARED !== 'true') return undefined;
    const dir = artifactPath(runId);
    await mkdir(dir, { recursive: true });
    const tracePath = path.join(dir, 'trace.zip');
    await this.context.tracing.stop({ path: tracePath }).catch(() => undefined);
    return tracePath;
  }

  private claimPage(page: Page, options: { allowSteal?: boolean; makeActive?: boolean } = {}) {
    if (page.isClosed()) return false;
    if (this.browserOwnership === 'shared') {
      const owner = sharedPageOwners.get(page);
      if (owner && owner !== this.pageGroupId && !options.allowSteal) return false;
      sharedPageOwners.set(page, this.pageGroupId);
    }
    const alreadyOwned = this.ownedPages.has(page);
    this.ownedPages.add(page);
    this.attachPageListeners(page);
    void this.markPageGroup(page);
    if (!alreadyOwned) {
      page.once('close', () => {
        this.ownedPages.delete(page);
        if (sharedPageOwners.get(page) === this.pageGroupId) sharedPageOwners.delete(page);
        if (this.page === page) {
          this.page = this.sessionPages()[0];
        }
      });
    }
    if (options.makeActive !== false) this.page = page;
    return true;
  }

  private sessionPages() {
    return Array.from(this.ownedPages).filter((page) => !page.isClosed());
  }

  private async selectInitialPage(context: BrowserContext) {
    const pages = this.sessionPages();
    const preferred = this.options.preferExistingPage
      ? pages.filter((page) => !isBlankPage(page)).at(-1)
      : undefined;
    const page = preferred || pages[0] || await context.newPage();
    this.claimPage(page);
    await page.bringToFront().catch(() => undefined);
    return page;
  }

  private tabGroupShortId() {
    const parts = this.pageGroupId.split('_');
    return (parts.at(-1) || this.pageGroupId).slice(-6).toLowerCase();
  }

  private tabGroupLabel() {
    return `ai-${this.tabGroupShortId()}`;
  }

  private tabTitlePrefix() {
    return `【${this.tabGroupLabel()}】`;
  }

  private stripTabTitlePrefix(title: string) {
    const prefix = this.tabTitlePrefix();
    return title.startsWith(prefix) ? title.slice(prefix.length).trim() : title;
  }

  private pageGroupMarkerInput() {
    return {
      id: this.pageGroupId,
      title: this.tabGroupLabel(),
      prefix: this.tabTitlePrefix(),
      applyPrefix: browserTabTitlePrefixEnabled(),
    };
  }

  private async markPageGroup(page: Page) {
    const markerInput = this.pageGroupMarkerInput();
    if (!this.pageGroupInitScriptPages.has(page)) {
      this.pageGroupInitScriptPages.add(page);
      await page.addInitScript(applyPageGroupMarker, markerInput).catch(() => {
        this.pageGroupInitScriptPages.delete(page);
      });
    }
    await this.ensureBrowserPageRuntime(page);
    await page.evaluate(applyPageGroupMarker, markerInput).catch(() => undefined);
  }

  private async ensureBrowserPageRuntime(target: Page | Frame = this.activePage) {
    await target.evaluate(aiDomMutationObserverScript).catch(() => undefined);
    await target.evaluate(installAiBrowserPageRuntime).catch(() => undefined);
  }

  async currentTitle() {
    try {
      return await this.activePage.title();
    } catch {
      return '';
    }
  }

  async bringToFront() {
    await this.activePage.bringToFront();
  }

  async installAccessibilitySnapshotExportControl(exporter: () => Promise<AccessibilitySnapshotExportControlResult>) {
    if (!this.context) throw new Error('Browser session has not started');
    this.accessibilitySnapshotExporter = exporter;
    if (!this.accessibilitySnapshotExportControlInstalled) {
      this.accessibilitySnapshotExportControlInstalled = true;
      await this.context.exposeBinding('__webPilotExportAccessibilitySnapshot', async (source) => {
        if (source.page && !source.page.isClosed()) {
          this.claimPage(source.page, { allowSteal: true });
          await source.page.bringToFront().catch(() => undefined);
        }
        const handler = this.accessibilitySnapshotExporter;
        if (!handler) return { ok: false, error: 'Semantic DOM snapshot exporter is unavailable.' };
        try {
          return await handler();
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      });
      await this.context.addInitScript(installAccessibilitySnapshotExportControl);
    }
    await Promise.all(this.sessionPages().map((page) => page.evaluate(installAccessibilitySnapshotExportControl).catch(() => undefined)));
  }

  private async readPageGroupId(page: Page) {
    if (page.isClosed()) return undefined;
    return page.evaluate(() => {
      const win = window as Window & { __aiWebTestSessionGroupId?: unknown };
      if (typeof win.__aiWebTestSessionGroupId === 'string') return win.__aiWebTestSessionGroupId;
      const attributeId = document.documentElement?.getAttribute('data-ai-web-test-session-group-id');
      if (attributeId) return attributeId;
      const match = String(window.name || '').match(/^AI_WEB_TEST_SESSION_GROUP:([^;]+);/);
      return match?.[1];
    }).catch(() => undefined);
  }

  getTabsSnapshot(): BrowserTabSnapshot[] {
    const pages = this.sessionPages();
    const active = this.page && !this.page.isClosed() ? this.page : pages[0];
    return pages.map((page, index) => ({
      index,
      url: page.url(),
      active: page === active,
      groupId: this.pageGroupId,
    }));
  }

  async startScreencast(options: {
    onActivePageChanged?: () => void;
    everyNthFrame?: number;
    onError?: (error: unknown) => void;
    onFrame: (frame: BrowserScreencastFrame) => void | Promise<void>;
  }): Promise<BrowserScreencastHandle> {
    const page = this.activePage;
    const client = await page.context().newCDPSession(page);
    const contentType: BrowserScreencastFrame['contentType'] = 'image/png';
    const rawEveryNthFrame = Number(options.everyNthFrame ?? process.env.BROWSER_SCREENCAST_EVERY_NTH_FRAME ?? 1);
    const everyNthFrame = Math.min(8, Math.max(1, Math.floor(Number.isFinite(rawEveryNthFrame) ? rawEveryNthFrame : 1)));
    let stopped = false;
    const onFrame = (event: {
      data?: string;
      metadata?: { deviceHeight?: number; deviceWidth?: number };
      sessionId?: number;
    }) => {
      if (event.sessionId !== undefined) {
        void client.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined);
      }
      if (stopped || !event.data) return;
      const activePage = this.page && !this.page.isClosed() ? this.page : this.sessionPages()[0];
      if (!activePage || activePage !== page || page.isClosed()) {
        stopped = true;
        void Promise.resolve(options.onActivePageChanged?.())
          .finally(() => {
            void client.send('Page.stopScreencast').catch(() => undefined);
            void client.detach().catch(() => undefined);
          });
        return;
      }
      const fallback = page.viewportSize() || { width: 1280, height: 720 };
      const width = Math.floor(Number(event.metadata?.deviceWidth) || fallback.width);
      const height = Math.floor(Number(event.metadata?.deviceHeight) || fallback.height);
      void Promise.resolve(options.onFrame({
        capturedAt: new Date().toISOString(),
        contentType,
        data: event.data,
        metadata: event.metadata,
        tabs: this.getTabsSnapshot(),
        url: page.url(),
        viewport: { width, height },
      })).catch((error) => options.onError?.(error));
    };
    client.on('Page.screencastFrame', onFrame);
    try {
      await client.send('Page.startScreencast', {
        everyNthFrame,
        format: 'png',
      });
    } catch (error) {
      client.off('Page.screencastFrame', onFrame);
      await client.detach().catch(() => undefined);
      throw error;
    }
    return {
      stop: async () => {
        if (stopped) return;
        stopped = true;
        client.off('Page.screencastFrame', onFrame);
        await client.send('Page.stopScreencast').catch(() => undefined);
        await client.detach().catch(() => undefined);
      },
    };
  }

  private async closeOwnedPages() {
    const pages = this.sessionPages();
    await Promise.all(pages.map((page) => page.close().catch(() => undefined)));
    this.ownedPages.clear();
    this.page = undefined;
  }

  // 绑定 console 和网络失败监听，只记录会影响测试判断的关键异常。
  private attachPageListeners(page: Page) {
    if (this.attachedPages.has(page)) return;
    this.attachedPages.add(page);
    page.setDefaultTimeout(8000);
    page.on('console', (message) => {
      const text = message.text();
      if (message.type() === 'error' && !shouldIgnoreConsoleError(text)) this.consoleErrors.push(text);
    });
    page.on('request', (request) => {
      this.recordHttpRequest(page, request);
    });
    page.on('response', (response) => {
      const record = this.httpRequestByRequest.get(response.request()) || this.recordHttpRequest(page, response.request());
      record.status = response.status();
      record.statusText = response.statusText();
      record.ok = response.ok();
    });
    page.on('requestfailed', (request) => {
      const record = this.httpRequestByRequest.get(request) || this.recordHttpRequest(page, request);
      const errorText = request.failure()?.errorText || '';
      record.failed = true;
      record.ok = false;
      record.errorText = errorText;
      if (shouldIgnoreNetworkFailure(request.url(), errorText)) return;
      this.networkErrors.push(`${request.method()} ${request.url()} ${errorText}`);
    });
  }

  private recordHttpRequest(page: Page, request: Request) {
    const existing = this.httpRequestByRequest.get(request);
    if (existing) return existing;
    const records = this.httpRequestsByPage.get(page) || [];
    const record: HttpRequestRecord = {
      id: `${Date.now().toString(36)}-${records.length + 1}`,
      startedAt: new Date().toISOString(),
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
    };
    records.push(record);
    const rawMaxRecords = Number(process.env.BROWSER_HTTP_REQUEST_HISTORY_LIMIT || 400);
    const maxRecords = Math.max(50, Math.floor(Number.isFinite(rawMaxRecords) ? rawMaxRecords : 400));
    if (records.length > maxRecords) records.splice(0, records.length - maxRecords);
    this.httpRequestsByPage.set(page, records);
    this.httpRequestByRequest.set(request, record);
    return record;
  }

  // 获取当前可用页面；如果活动页关闭，会从浏览器上下文中寻找替代页面。
  private get activePage() {
    if (!this.page) throw new Error('Browser session has not started');
    if (this.page.isClosed()) {
      const replacement = this.sessionPages()[0];
      if (!replacement) throw new Error('Active browser page has been closed and no replacement page is available.');
      this.page = replacement;
      this.attachPageListeners(replacement);
    }
    return this.page;
  }

  // 打开目标页面，只等待导航提交；页面稳定与新快照由模型显式触发。
  async open(url: string): Promise<BrowserActionResult> {
    const previousGeneration = this.snapshotGeneration;
    const beforeUrl = this.activePage.url();
    let navigationNote = '';
    try {
      await this.activePage.goto(url, { waitUntil: 'commit', timeout: 0 });
    } catch (error) {
      const currentUrl = this.activePage.url();
      const unchanged = currentUrl === beforeUrl && currentUrl !== url;
      if (!currentUrl || isBlankBrowserUrlLike(currentUrl) || unchanged) {
        return {
          ok: false,
          actual: `Open page failed before navigation committed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      navigationNote = ` Navigation reported an error before commit; continuing from current URL: ${currentUrl}.`;
    }
    void this.markPageGroup(this.activePage);
    return this.completeActionWithSnapshot(`Opened page: ${url}${navigationNote}`, previousGeneration);
  }

  async readStructuredPageText() {
    return (await this.readDomObservation({ includeInteractiveCandidates: false })).structuredText;
  }

  private async readDomObservation(options: {
    includeInteractiveCandidates: boolean;
    maxChars?: number;
    timings?: Record<string, number>;
  }) {
    const fallbackMaxChars = numericLimitFromEnv('DOM_STRUCTURED_TEXT_MAX_CHARS', numericLimitFromEnv('DOM_PAGE_TEXT_READ_MAX_CHARS', 200000));
    const maxChars = options.maxChars ?? fallbackMaxChars;
    const frameLimit = numericLimitFromEnv('DOM_STRUCTURED_TEXT_FRAME_LIMIT', numericLimitFromEnv('DOM_CUA_FRAME_LIMIT', Number.MAX_SAFE_INTEGER));
    const mainFrame = this.activePage.mainFrame();
    const frames = [mainFrame, ...this.activePage.frames().filter((frame) => frame !== mainFrame).slice(0, frameLimit)];
    const parts: string[] = [];
    let chars = 0;
    const mainCandidates: PageInteractiveCandidate[] = [];
    const frameCandidates: InteractiveCandidate[] = [];
    const viewport = options.includeInteractiveCandidates
      ? await timedBrowserStep(options.timings, 'getViewportForFrameCandidatesMs', () => this.getViewportMetrics().catch(() => ({ width: 0, height: 0, devicePixelRatio: 1 })))
      : undefined;

    const append = (label: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed || chars >= maxChars) return;
      const block = label ? `${label}\n${trimmed}` : trimmed;
      const remaining = maxChars - chars;
      const chunk = block.length > remaining ? block.slice(0, remaining) : block;
      if (!chunk) return;
      parts.push(chunk);
      chars += chunk.length + 2;
    };

    for (const frame of frames) {
      if (chars >= maxChars && !options.includeInteractiveCandidates) break;
      const framePath = frame === mainFrame ? undefined : this.getFramePath(frame);
      if (frame !== mainFrame && framePath === undefined) continue;
      const frameBox = framePath && options.includeInteractiveCandidates
        ? await timedBrowserStep(options.timings, 'getFrameBoxMs', () => frame.frameElement().then((handle) => handle.boundingBox()).catch(() => undefined))
        : undefined;
      if (framePath && options.includeInteractiveCandidates && (!frameBox || frameBox.width <= 2 || frameBox.height <= 2)) continue;
      const observation = await timedBrowserStep(
        options.timings,
        framePath ? 'readFrameDomObservationMs' : 'readMainDomObservationMs',
        async () => {
          await this.ensureBrowserPageRuntime(frame);
          return frame.evaluate(collectAiDomObservation, {
            includeInteractiveCandidates: options.includeInteractiveCandidates,
            requirePointerEvents: true,
            structuredTextMaxChars: Math.max(0, maxChars - chars),
          }).catch(() => ({ structuredText: '', interactiveCandidates: [] as PageInteractiveCandidate[] }));
        },
      );
      const label = framePath ? `[iframe ${framePath}${frame.url() ? ` ${frame.url()}` : ''}]` : '';
      append(label, observation.structuredText);
      if (!options.includeInteractiveCandidates || !observation.interactiveCandidates.length) continue;
      if (!framePath) {
        mainCandidates.push(...observation.interactiveCandidates);
        continue;
      }
      if (!frameBox || !viewport) continue;
      for (const candidate of observation.interactiveCandidates) {
        const rect = {
          x: Math.round(frameBox.x + candidate.rect.x),
          y: Math.round(frameBox.y + candidate.rect.y),
          width: candidate.rect.width,
          height: candidate.rect.height,
        };
        const center = {
          x: Math.round(frameBox.x + candidate.center.x),
          y: Math.round(frameBox.y + candidate.center.y),
        };
        if (center.x < 0 || center.y < 0 || center.x >= viewport.width || center.y >= viewport.height) continue;
        frameCandidates.push({
          ...candidate,
          id: '',
          rect,
          center,
          framePath,
          frameUrl: frame.url() || undefined,
        });
      }
    }

    return {
      structuredText: parts.join('\n\n'),
      interactiveCandidates: options.includeInteractiveCandidates
        ? this.finalizeInteractiveCandidates(mainCandidates, frameCandidates)
        : [] as InteractiveCandidate[],
    };
  }

  // 汇总当前页面上下文，包括 URL、标题、焦点、候选元素、DOM 树和人工验证状态。
  async getPageContext(options: {
    domScope?: 'visible' | 'full';
    includeDomTree?: boolean;
    includeText?: boolean;
    includeManualVerification?: boolean;
    includeInteractiveCandidates?: boolean;
    textMaxChars?: number;
    useCachedInteractiveCandidates?: boolean;
  } = {}) {
    const includeText = options.includeText !== false || options.includeManualVerification !== false;
    const includeInteractiveCandidates = options.includeInteractiveCandidates ?? true;
    const useCachedInteractiveCandidates = Boolean(options.useCachedInteractiveCandidates && !options.includeDomTree);
    const timings: Record<string, number> = {};
    const canUseCombinedDomObservation = includeText
      && includeInteractiveCandidates
      && !useCachedInteractiveCandidates
      && !options.includeDomTree;
    const domObservationPromise = canUseCombinedDomObservation
      ? timedBrowserStep(timings, 'readDomObservationMs', () => this.readDomObservation({
          includeInteractiveCandidates: true,
          maxChars: numericLimitFromEnv('DOM_STRUCTURED_TEXT_MAX_CHARS', numericLimitFromEnv('DOM_PAGE_TEXT_READ_MAX_CHARS', 200000)),
          timings,
        }))
      : undefined;
    const [title, domObservation, structuredTextFallback, viewportMetrics, focusedElement, domTreeResult, interactiveCandidatesFallback, scrollableAreas, pageScrollState] = await Promise.all([
      timedBrowserStep(timings, 'readTitleMs', () => this.activePage.title().catch(() => '').then((value) => this.stripTabTitlePrefix(value))),
      domObservationPromise || Promise.resolve(undefined),
      !domObservationPromise && includeText
        ? timedBrowserStep(timings, 'readStructuredPageTextMs', () => this.readStructuredPageText())
        : Promise.resolve(''),
      timedBrowserStep(timings, 'getViewportMetricsMs', () => this.getViewportMetrics()),
      timedBrowserStep(timings, 'getFocusedElementMs', () => this.getFocusedElement()),
      options.includeDomTree
        ? timedBrowserStep(timings, 'readSimplifiedDomTreeMs', () => this.readSimplifiedDomTree({ scope: options.domScope || 'visible', timings }).catch((error) => {
            const tree = `Unable to read DOM tree: ${error instanceof Error ? error.message : String(error)}`;
            return { tree, observation: this.emptySimplifiedDomObservation(tree) };
          }))
        : Promise.resolve(undefined),
      domObservationPromise || !includeInteractiveCandidates
        ? Promise.resolve([] as InteractiveCandidate[])
        : useCachedInteractiveCandidates && this.lastInteractiveCandidates.length
            ? Promise.resolve(this.lastInteractiveCandidates)
            : timedBrowserStep(timings, 'refreshInteractiveCandidatesMs', () => this.refreshInteractiveCandidates().catch(() => this.lastInteractiveCandidates)),
      timedBrowserStep(timings, 'refreshScrollableAreasMs', () => this.refreshScrollableAreas().catch(() => this.lastScrollableAreas)),
      timedBrowserStep(timings, 'getPageScrollStateMs', () => this.getPageScrollState().catch(() => undefined)),
    ]);
    const structuredText = domObservation?.structuredText ?? structuredTextFallback;
    const interactiveCandidates = domObservation?.interactiveCandidates ?? interactiveCandidatesFallback;
    const text = structuredText;

    const manualVerification = options.includeManualVerification === false
      ? { detected: false }
      : await this.detectManualVerificationContext(title, this.activePage.url(), text);

    return {
      url: this.activePage.url(),
      title,
      text: typeof options.textMaxChars === 'number'
        ? options.textMaxChars > 0 ? text.slice(0, options.textMaxChars) : text
        : text.slice(0, 2400),
      textLength: text.length,
      structuredText,
      structuredTextLength: structuredText.length,
      viewport: { width: viewportMetrics.width, height: viewportMetrics.height },
      viewportMetrics,
      tabs: this.getTabsSnapshot(),
      focusedElement,
      domTree: domTreeResult?.tree,
      domObservation: domTreeResult?.observation,
      interactiveCandidates,
      scrollableAreas,
      pageScrollState,
      manualVerification,
      isManualVerification: manualVerification.detected && !manualVerification.captchaAppearsFilled,
      timings,
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

  private async buildScreenshotFailureError(error: unknown, details: {
    phase: string;
    capture: ScreenshotCaptureMode;
    timeoutMs: number;
    filePath: string;
  }) {
    const diagnosticLines = await this.collectScreenshotFailureDiagnostics(details);
    const message = `${unknownErrorMessage(error)}\n\nScreenshot diagnostics:\n${diagnosticLines.join('\n')}`;
    const enriched = new Error(message);
    if (error instanceof Error) {
      enriched.name = error.name;
    }
    return enriched;
  }

  private async collectScreenshotFailureDiagnostics(details: {
    phase: string;
    capture: ScreenshotCaptureMode;
    timeoutMs: number;
    filePath: string;
  }) {
    const title = await this.activePage.title().catch((error) => `<unavailable: ${unknownErrorMessage(error)}>`);
    const viewport = this.activePage.viewportSize();
    const pageContext = await Promise.race([
      this.getPageContext({
        includeDomTree: false,
        includeInteractiveCandidates: false,
        includeManualVerification: false,
        includeText: true,
        textMaxChars: 1000,
      }).then((context) => ({
        url: context.url,
        title: context.title,
        textLength: context.textLength,
        textSample: compactDiagnosticText(context.text, 700),
        viewport: context.viewport,
        pageScrollState: context.pageScrollState,
        tabs: context.tabs.slice(0, 8),
      })),
      new Promise<{ error: string }>((resolve) => {
        setTimeout(() => {
          resolve({ error: `Timed out collecting pageContext after ${SCREENSHOT_FAILURE_CONTEXT_TIMEOUT_MS}ms` });
        }, SCREENSHOT_FAILURE_CONTEXT_TIMEOUT_MS);
      }),
    ]).catch((contextError) => ({ error: unknownErrorMessage(contextError) }));

    return [
      `phase=${details.phase}`,
      `mode=${this.mode}`,
      `capture=${details.capture}`,
      `timeoutMs=${details.timeoutMs}`,
      `filePath=${details.filePath}`,
      `url=${this.activePage.url()}`,
      `title=${title}`,
      `viewport=${viewport ? `${viewport.width}x${viewport.height}` : 'unknown'}`,
      `pageContext=${stringifyDiagnosticValue(pageContext)}`,
    ];
  }

  // Capture the current viewport. Candidate marker overlays are no longer captured automatically.
  async takeScreenshot(runId: string, stepIndex: number, phase: 'before' | 'after' | 'manual' | `visual-${number}` | `tool-${number}` = 'after', options: ScreenshotCaptureOptions = {}) {
    const totalStartedAt = Date.now();
    const timingSteps: ScreenshotTimingStep[] = [];
    const timed = async <T>(
      name: string,
      action: () => Promise<T>,
      details?: (result: T) => Partial<ScreenshotTimingStep>,
    ) => {
      const startedAt = Date.now();
      try {
        const result = await action();
        timingSteps.push({ name, elapsedMs: Date.now() - startedAt, ...details?.(result) });
        return result;
      } catch (error) {
        timingSteps.push({
          name,
          elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };
    const skipped = (name: string) => timingSteps.push({ name, elapsedMs: 0, skipped: true });
    const stabilizeMs = Number(process.env.SCREENSHOT_STABILIZE_MS || 0);
    if (Number.isFinite(stabilizeMs) && stabilizeMs > 0) {
      await timed('stabilizeViewport', () => this.waitForStableViewport(Math.min(Math.max(stabilizeMs, 0), 5000)));
    } else skipped('stabilizeViewport');
    const capture: ScreenshotCaptureMode = options.capture === 'fullPage' ? 'fullPage' : 'viewport';
    const dir = artifactPath(runId);
    await timed('prepareArtifactDir', () => mkdir(dir, { recursive: true }));
    const fileName = phase === 'manual' ? `step-${stepIndex}.png` : `step-${stepIndex}-${phase}.png`;
    const filePath = path.join(dir, fileName);
    const shouldCaptureCandidates = false;
    const candidateLabelsEnabled = false;
    const scrollAreaLabelsEnabled = false;
    const candidates = shouldCaptureCandidates
      ? await timed('refreshInteractiveCandidates', () => this.refreshInteractiveCandidates().catch(() => [] as InteractiveCandidate[]), (items) => ({ count: items.length }))
      : [];
    const scrollAreas = shouldCaptureCandidates
      ? await timed('refreshScrollableAreas', () => this.refreshScrollableAreas().catch(() => this.lastScrollableAreas), (items) => ({ count: items.length }))
      : [];
    if (!shouldCaptureCandidates) {
      skipped('refreshInteractiveCandidates');
      skipped('refreshScrollableAreas');
    }
    if (shouldCaptureCandidates) {
      // This immutable-by-convention snapshot is the only source of candidate IDs
      // for the following AI request and click. Later context scans must not make a
      // screenshot label point at a different element.
      this.lastScreenshotCandidates = candidates.map((candidate) => ({
        ...candidate,
        rect: { ...candidate.rect },
        center: { ...candidate.center },
      }));
    } else {
      this.lastScreenshotCandidates = [];
    }
    this.lastCandidateMarkerScreenshotPath = undefined;
    this.lastOriginalScreenshotPath = undefined;
    const separateMarkerMap = false;
    await timed('removeCandidateOverlayBefore', () => this.removeCandidateOverlay());
    if (phase === 'before' || String(phase).startsWith('visual-')) {
      await timed('removeClickMarker', () => this.removeClickMarker());
    } else skipped('removeClickMarker');
    const screenshotTimeoutMs = boundedPositiveIntegerEnv(
      'SCREENSHOT_TIMEOUT_MS',
      DEFAULT_SCREENSHOT_TIMEOUT_MS,
      MIN_SCREENSHOT_TIMEOUT_MS,
      MAX_SCREENSHOT_TIMEOUT_MS,
    );
    const screenshotOptions = {
      animations: 'disabled' as const,
      caret: 'hide' as const,
      path: filePath,
      fullPage: capture === 'fullPage',
      scale: 'css' as const,
      timeout: screenshotTimeoutMs,
    };
    // Original clean screenshots are disabled globally; keep only the primary screenshot
    // and, when configured, the separate marker map.
    skipped('captureOriginalScreenshot');
    if ((candidateLabelsEnabled || scrollAreaLabelsEnabled) && !separateMarkerMap) {
      await timed('drawInlineOverlay', () => this.drawCandidateOverlay(
        candidateLabelsEnabled ? candidates : [],
        false,
        scrollAreaLabelsEnabled ? scrollAreas : [],
      ));
    } else skipped('drawInlineOverlay');
    try {
      await timed('capturePrimaryScreenshot', () => this.activePage.screenshot(screenshotOptions), () => ({ path: filePath }));
    } catch (error) {
      throw await this.buildScreenshotFailureError(error, {
        phase: String(phase),
        capture,
        timeoutMs: screenshotTimeoutMs,
        filePath,
      });
    } finally {
      if ((candidateLabelsEnabled || scrollAreaLabelsEnabled) && !separateMarkerMap) {
        await timed('removeInlineOverlay', () => this.removeCandidateOverlay());
      } else skipped('removeInlineOverlay');
    }
    if (separateMarkerMap) {
      const markerFilePath = path.join(dir, `step-${stepIndex}-${phase}-markers.png`);
      await timed('drawMarkerOverlay', () => this.drawCandidateOverlay(candidates, true, scrollAreaLabelsEnabled ? scrollAreas : []));
      try {
        await timed('captureMarkerScreenshot', () => this.activePage.screenshot({ ...screenshotOptions, path: markerFilePath }), () => ({ path: markerFilePath }));
        this.lastCandidateMarkerScreenshotPath = markerFilePath;
      } catch (error) {
        throw await this.buildScreenshotFailureError(error, {
          phase: `${String(phase)}-markers`,
          capture,
          timeoutMs: screenshotTimeoutMs,
          filePath: markerFilePath,
        });
      } finally {
        await timed('removeMarkerOverlay', () => this.removeCandidateOverlay());
      }
    } else {
      skipped('drawMarkerOverlay');
      skipped('captureMarkerScreenshot');
      skipped('removeMarkerOverlay');
    }
    const [image, viewportMetrics, scrollPosition] = await timed('readScreenshotMetadata', () => Promise.all([
      this.readPngSize(filePath),
      this.getViewportMetrics(),
      this.activePage.evaluate(() => ({ x: window.scrollX, y: window.scrollY })).catch(() => ({ x: 0, y: 0 })),
    ]));
    this.lastScreenshotMetrics = {
      path: filePath,
      image,
      viewport: { width: viewportMetrics.width, height: viewportMetrics.height },
      viewportMetrics,
      devicePixelRatio: viewportMetrics.devicePixelRatio,
      scale: 'css',
      capture,
      generation: ++this.screenshotGenerationSequence,
      page: this.activePage,
      url: this.activePage.url(),
      scrollX: scrollPosition.x,
      scrollY: scrollPosition.y,
      capturedAt: Date.now(),
    };
    this.lastScreenshotTiming = {
      phase: String(phase),
      capture,
      totalMs: Date.now() - totalStartedAt,
      path: filePath,
      markerPath: this.lastCandidateMarkerScreenshotPath,
      originalPath: this.lastOriginalScreenshotPath,
      candidateCount: candidates.length,
      scrollAreaCount: scrollAreas.length,
      candidateLabelsEnabled,
      scrollAreaLabelsEnabled,
      separateMarkerMap,
      steps: timingSteps,
    };
    return filePath;
  }

  // Minimal takeScreenshot path: save the browser screenshot without DOM, overlay, metadata, or visual-context work.
  async takeCurrentScreenshotOnly(runId: string, stepIndex: number, phase: `visual-${number}`, options: ScreenshotCaptureOptions = {}) {
    const capture: ScreenshotCaptureMode = options.capture === 'fullPage' ? 'fullPage' : 'viewport';
    const dir = artifactPath(runId);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `step-${stepIndex}-${phase}.png`);
    const screenshotTimeoutMs = boundedPositiveIntegerEnv(
      'SCREENSHOT_TIMEOUT_MS',
      DEFAULT_SCREENSHOT_TIMEOUT_MS,
      MIN_SCREENSHOT_TIMEOUT_MS,
      MAX_SCREENSHOT_TIMEOUT_MS,
    );
    await this.activePage.screenshot({
      path: filePath,
      fullPage: capture === 'fullPage',
      timeout: screenshotTimeoutMs,
      scale: 'css',
    });
    const [image, viewportMetrics, scrollPosition] = await Promise.all([
      this.readPngSize(filePath),
      this.getViewportMetrics(),
      this.activePage.evaluate(() => ({ x: window.scrollX, y: window.scrollY })).catch(() => ({ x: 0, y: 0 })),
    ]);
    this.lastScreenshotMetrics = {
      path: filePath,
      image,
      viewport: { width: viewportMetrics.width, height: viewportMetrics.height },
      viewportMetrics,
      devicePixelRatio: viewportMetrics.devicePixelRatio,
      scale: 'css',
      capture,
      generation: ++this.screenshotGenerationSequence,
      page: this.activePage,
      url: this.activePage.url(),
      scrollX: scrollPosition.x,
      scrollY: scrollPosition.y,
      capturedAt: Date.now(),
    };
    return filePath;
  }

  getLastScreenshotMetrics() {
    return this.lastScreenshotMetrics;
  }

  getLastScreenshotTiming() {
    return this.lastScreenshotTiming;
  }

  formatLastScreenshotTiming() {
    return formatScreenshotTimingSummary(this.lastScreenshotTiming);
  }

  // 返回最近一次操作前截图对应的纯标识图路径；仅双截图兼容模式会使用。
  getLastCandidateMarkerScreenshotPath() {
    return this.lastCandidateMarkerScreenshotPath;
  }

  getLastOriginalScreenshotPath() {
    return this.lastOriginalScreenshotPath;
  }

  // 返回当前可见交互候选元素，供 DOM 模式在无截图输入时定位控件。
  async getInteractiveCandidates(): Promise<BrowserActionResult> {
    const candidates = await this.refreshInteractiveCandidates();
    return {
      ok: true,
      actual: candidates.map((candidate) => {
        const depth = Math.max(0, candidate.path.split('.').filter(Boolean).length - 1);
        const indent = '  '.repeat(Math.min(depth, 10));
        const className = candidate.className
          ? `.${candidate.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.')}`
          : '';
        const role = [candidate.role, candidate.type].filter(Boolean).join('/');
        const label = [
          candidate.name,
          candidate.text,
          candidate.ariaLabel,
          candidate.placeholder,
          candidate.title,
          candidate.nearbyText,
        ].map((value) => value?.replace(/\s+/g, ' ').trim()).find(Boolean) || '[unlabeled]';
        const state = [
          candidate.clickable ? 'clickable' : '',
          candidate.input ? 'input' : '',
          candidate.disabled ? 'disabled' : '',
          candidate.opensExternalApp ? `external-app=${candidate.externalAppProtocol || 'custom-protocol'}` : '',
          candidate.signals?.length ? `signals=${candidate.signals.join('|')}` : '',
          candidate.href ? `href=${candidate.href}` : '',
          candidate.framePath ? `frame=${candidate.framePath}` : '',
          candidate.shadow ? 'shadow' : '',
        ].filter(Boolean).join(', ');
        return `${indent}- #${candidate.id} ${candidate.tag}${className}${role ? `[${role}]` : ''}: "${label.slice(0, 160)}"${state ? ` (${state})` : ''}`;
      }).join('\n') || '[no visible interactive elements detected]',
    };
  }

  // Debug entrypoint for stepping through interactive candidate collection on a real page.
  async debugInteractiveCandidateScan(input: { pause?: boolean; includeScreenshot?: boolean; runId?: string } = {}) {
    await this.ensureBrowserPageRuntime();
    const pageUrl = this.activePage.url();
    const pageTitle = await this.activePage.title().catch(() => '');
    const directObservation = await this.activePage.evaluate(collectAiDomObservation, {
      includeInteractiveCandidates: true,
      requirePointerEvents: true,
      structuredTextMaxChars: 12000,
      debugPause: input.pause !== false,
    });
    const candidates = this.finalizeInteractiveCandidates(directObservation.interactiveCandidates, []);
    let screenshotPath: string | undefined;
    let screenshotTiming: ScreenshotTiming | undefined;
    if (input.includeScreenshot !== false) {
      screenshotPath = await this.takeScreenshot(input.runId || `debug_interactive_${Date.now()}`, 1, 'visual-1', { capture: 'viewport' });
      screenshotTiming = this.getLastScreenshotTiming();
    }
    return {
      url: pageUrl,
      title: pageTitle,
      directCandidateCount: directObservation.interactiveCandidates.length,
      finalizedCandidateCount: candidates.length,
      screenshotPath,
      screenshotTiming,
      candidates: candidates.slice(0, 80).map((candidate) => ({
        id: candidate.id,
        tag: candidate.tag,
        role: candidate.role,
        type: candidate.type,
        name: candidate.name,
        text: candidate.text,
        className: candidate.className,
        signals: candidate.signals,
        rect: candidate.rect,
        center: candidate.center,
        clickable: candidate.clickable,
        input: candidate.input,
        disabled: candidate.disabled,
        hasIndependentClickArea: candidate.hasIndependentClickArea,
        href: candidate.href,
        placeholder: candidate.placeholder,
        ariaLabel: candidate.ariaLabel,
        nearbyText: candidate.nearbyText,
      })),
      structuredTextPreview: directObservation.structuredText.slice(0, 2000),
    };
  }

  // 返回简化后的 DOM 树文本，作为候选列表不足时的兜底定位信息。
  async getSimplifiedDomTree(): Promise<BrowserActionResult> {
    const result = await this.readSimplifiedDomTree({ scope: 'full' });
    return { ok: true, actual: result.tree };
  }

  async listTabs(): Promise<BrowserActionResult> {
    const tabs = this.getTabsSnapshot();
    return {
      ok: true,
      actual: tabs.length
        ? [`Tab group: ${this.pageGroupId}`, ...tabs.map((tab) => `${tab.index}${tab.active ? ' [active]' : ''}: ${tab.url}`)].join('\n')
        : 'No tabs found for this run.',
    };
  }

  // 返回当前活动标签页最近的 HTTP 请求，供 AI 定位接口错误、状态码异常和静态资源问题。
  async getCurrentTabHttpRequests(): Promise<BrowserActionResult> {
    const rawLimit = Number(process.env.AI_HTTP_REQUEST_TOOL_LIMIT || 80);
    const limit = Math.max(1, Math.floor(Number.isFinite(rawLimit) ? rawLimit : 80));
    const records = (this.httpRequestsByPage.get(this.activePage) || []).slice(-limit);
    if (!records.length) {
      return { ok: true, actual: 'Current tab has no captured HTTP requests yet.' };
    }
    return {
      ok: true,
      actual: JSON.stringify(records.map((record) => ({
        time: record.startedAt,
        method: record.method,
        url: record.url,
        resourceType: record.resourceType,
        status: record.status ?? null,
        statusText: record.statusText ?? null,
        ok: record.ok ?? null,
        failed: record.failed || false,
        errorText: record.errorText || null,
      })), null, 2),
    };
  }

  // 切换到指定标签页，并把它设为后续操作的活动页。
  async switchTab(index: number): Promise<BrowserActionResult> {
    const previousGeneration = this.snapshotGeneration;
    const page = this.sessionPages()[index];
    if (!page) return { ok: false, actual: `Tab ${index} not found.` };
    this.page = page;
    await page.bringToFront();
    return this.completeActionWithSnapshot(`Switched to tab ${index}: ${page.url()}`, previousGeneration);
  }

  // 向当前焦点元素输入文本。
  async waitForPage(): Promise<BrowserActionResult> {
    const previousGeneration = this.snapshotGeneration;
    const loadStateTimeoutMs = boundedPositiveIntegerEnv(
      'BROWSER_WAIT_FOR_PAGE_LOAD_STATE_TIMEOUT_MS',
      DEFAULT_BROWSER_WAIT_FOR_PAGE_LOAD_STATE_TIMEOUT_MS,
      100,
      30000,
    );
    await this.activePage.waitForLoadState('domcontentloaded', { timeout: loadStateTimeoutMs }).catch((error) => {
      if (!this.isTargetClosedError(error)) throw error;
    });
    const stableMs = boundedNonNegativeIntegerEnv(
      'BROWSER_WAIT_FOR_PAGE_STABLE_MS',
      DEFAULT_BROWSER_WAIT_FOR_PAGE_STABLE_MS,
      5000,
    );
    if (stableMs > 0) await this.waitForStableViewport(stableMs);
    const note = await this.manualVerificationNote();
    return this.completeActionWithSnapshot(`Page wait completed.${note}`, previousGeneration);
  }

  // 等待固定时间，给短动画、下拉面板或异步更新留出渲染时间。
  async wait(ms = 800): Promise<BrowserActionResult> {
    const previousGeneration = this.snapshotGeneration;
    await this.waitForStableViewport(Math.min(Math.max(ms, 100), 5000));
    return this.completeActionWithSnapshot(`Waited ${ms}ms.`, previousGeneration);
  }

  // 等待用户手动完成验证码/安全校验，超时后返回阻塞信息。
  async waitForManualVerification(maxMs = Number(process.env.MANUAL_VERIFICATION_TIMEOUT_MS || 180000)): Promise<BrowserActionResult> {
    void maxMs;
    const note = await this.manualVerificationNote();
    return {
      ok: true,
      actual: note
        ? '已暂停自动操作：页面需要人工完成验证。请在浏览器中完成验证码、登录/安全验证或其他需要本人确认的步骤；完成后在对话中发送“验证已完成”，我会重新读取当前页面并继续。'
        : '已暂停自动操作，等待您检查浏览器并完成可能需要的人工验证；完成后请发送“验证已完成”继续。',
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
    try {
      if (this.context && this.pageDiscoveryListener) {
        this.context.off('page', this.pageDiscoveryListener);
        this.pageDiscoveryListener = undefined;
      }
      if (this.browserOwnership === 'shared') {
        if (!electronEmbeddedBrowserEnabled() && !options.keepOpen && process.env.KEEP_BROWSER_OPEN_AFTER_RUN !== 'true') {
          await this.closeOwnedPages();
        }
        await this.releaseSharedBrowser?.();
        this.releaseSharedBrowser = undefined;
        return;
      }
      if (options.keepOpen || process.env.KEEP_BROWSER_OPEN_AFTER_RUN === 'true') return;
      if (this.browserOwnership === 'connected') {
        if (electronEmbeddedBrowserEnabled()) return;
        await this.browser?.close({ reason: 'AI test run finished; disconnecting from existing browser.' }).catch(() => undefined);
        return;
      }
      if (this.browserOwnership === 'persistent') {
        await this.context?.close().catch(() => undefined);
        return;
      }
      await this.browser?.close().catch(() => undefined);
    } finally {
      if (!options.keepOpen && process.env.KEEP_BROWSER_OPEN_AFTER_RUN !== 'true') {
        this.page = undefined;
        this.context = undefined;
        this.browser = undefined;
        this.ownedPages.clear();
      }
    }
  }

  private async waitAfterAction() {
    const settleMs = Number(process.env.BROWSER_ACTION_SETTLE_MS || 0);
    const loadStateTimeoutMs = boundedPositiveIntegerEnv(
      'BROWSER_ACTION_LOAD_STATE_TIMEOUT_MS',
      DEFAULT_BROWSER_ACTION_LOAD_STATE_TIMEOUT_MS,
      100,
      30000,
    );
    await this.activePage.waitForLoadState('domcontentloaded', { timeout: loadStateTimeoutMs }).catch(() => undefined);
    await this.markPageGroup(this.activePage);
    if (Number.isFinite(settleMs) && settleMs > 0) {
      await this.waitForStableViewport(Math.min(Math.max(settleMs, 0), 2000));
    }
    const [manualNote, focusNote] = await Promise.all([this.manualVerificationNote(), this.focusNote()]);
    return `${manualNote}${focusNote}`;
  }

  private async replaceFocusedText(text: string, clearFirst: boolean) {
    if (clearFirst) {
      await this.activePage.keyboard.press('Control+A').catch(() => undefined);
      await this.activePage.keyboard.press('Backspace').catch(() => undefined);
    }
    if (text) await this.activePage.keyboard.type(text, { delay: 20 });
  }

  private async insertFocusedTextFast(text: string, timings?: Record<string, number>) {
    if (!text) return;
    const domInserted = await timedBrowserStep(timings, 'domTextMs', () => this.insertTextIntoFocusedElement(text));
    if (domInserted) return;
    const timeoutMs = boundedPositiveIntegerEnv('BROWSER_FAST_TEXT_TIMEOUT_MS', 1500, 100, 10000);
    await timedBrowserStep(timings, 'insertTextMs', () => Promise.race([
      this.activePage.keyboard.insertText(text).then(() => undefined),
      sleep(timeoutMs).then(() => false),
    ]));
  }

  private async insertTextIntoFocusedElement(text: string) {
    return Boolean(await this.activePage.evaluate((value) => {
      const active = document.activeElement;
      if (!active) return false;
      const input = active as HTMLInputElement;
      const isTextControl = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
      if (isTextControl) {
        const currentValue = String(input.value || '');
        const start = typeof input.selectionStart === 'number' ? input.selectionStart : currentValue.length;
        const end = typeof input.selectionEnd === 'number' ? input.selectionEnd : start;
        const nextValue = `${currentValue.slice(0, start)}${value}${currentValue.slice(end)}`;
        const prototype = active instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (setter) setter.call(input, nextValue);
        else input.value = nextValue;
        const cursor = start + value.length;
        try {
          input.setSelectionRange?.(cursor, cursor);
        } catch {
          // Some input types do not support selection ranges; the value update still succeeded.
        }
        active.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          data: value,
          inputType: 'insertText',
        }));
        active.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      const editable = active.closest('[contenteditable=""], [contenteditable="true"]') as HTMLElement | null;
      if (editable) {
        editable.focus();
        document.execCommand('insertText', false, value);
        editable.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          data: value,
          inputType: 'insertText',
        }));
        return true;
      }
      return false;
    }, text).catch(() => false));
  }

  private async waitForStableViewport(ms: number) {
    try {
      await this.activePage.waitForTimeout(ms);
    } catch (error) {
      if (!this.isTargetClosedError(error)) throw error;
      const replacement = this.sessionPages()[0];
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
    return ' 检测到页面需要人工验证，请等待用户在浏览器中完成后再继续。';
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

  private async candidateDomState(candidate: InteractiveCandidate): Promise<CandidateDomState | undefined> {
    if (candidate.shadow) return undefined;
    const target = candidate.framePath ? this.frameFromPath(candidate.framePath) : this.activePage.mainFrame();
    if (!target) return undefined;
    await this.ensureBrowserPageRuntime(target);
    return target.evaluate((pathValue) => {
      const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime!;
      if (!runtime) return undefined;
      let element = runtime.elementFromPath(pathValue);
      if (!element) return undefined;
      element = runtime.actionableTargetFor(element);
      const field = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const tagName = element.tagName.toLowerCase();
      const text = (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160) || undefined;
      return {
        descriptor: runtime.descriptor(element),
        tagName,
        type: tagName === 'input' ? (field as HTMLInputElement).type : undefined,
        valueLength: 'value' in field ? (field.value || '').length : undefined,
        checked: 'checked' in field ? Boolean((field as HTMLInputElement).checked) : undefined,
        selectedIndex: 'selectedIndex' in field ? Number((field as HTMLSelectElement).selectedIndex) : undefined,
        ariaPressed: element.getAttribute('aria-pressed') || undefined,
        ariaExpanded: element.getAttribute('aria-expanded') || undefined,
        disabled: Boolean((field as HTMLInputElement).disabled || element.getAttribute('aria-disabled') === 'true'),
        text,
      };
    }, candidate.path).catch(() => undefined);
  }

  private candidateDomStateSummary(state?: CandidateDomState) {
    if (!state) return 'unavailable';
    return [
      state.descriptor,
      state.tagName ? `tag=${state.tagName}` : '',
      state.type ? `type=${state.type}` : '',
      typeof state.valueLength === 'number' ? `valueLength=${state.valueLength}` : '',
      typeof state.checked === 'boolean' ? `checked=${state.checked}` : '',
      typeof state.selectedIndex === 'number' ? `selectedIndex=${state.selectedIndex}` : '',
      state.ariaPressed ? `aria-pressed=${state.ariaPressed}` : '',
      state.ariaExpanded ? `aria-expanded=${state.ariaExpanded}` : '',
      state.disabled ? 'disabled=true' : '',
      state.text ? `text="${state.text}"` : '',
    ].filter(Boolean).join(', ');
  }

  private candidateDomStateChanged(before?: CandidateDomState, after?: CandidateDomState) {
    if (!before || !after) return false;
    return JSON.stringify(before) !== JSON.stringify(after);
  }

  private async detectManualVerification(): Promise<ManualVerificationDetails> {
    const [title, text] = await Promise.all([
      this.activePage.title().catch(() => '').then((value) => this.stripTabTitlePrefix(value)),
      this.readStructuredPageText(),
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

  private async getPageScrollState() {
    return this.activePage.evaluate(() => {
      const root = document.scrollingElement || document.documentElement;
      const top = Math.round(root.scrollTop);
      const left = Math.round(root.scrollLeft);
      const height = Math.round(root.scrollHeight);
      const width = Math.round(root.scrollWidth);
      const clientHeight = Math.round(root.clientHeight);
      const clientWidth = Math.round(root.clientWidth);
      const maxTop = Math.max(0, height - clientHeight);
      const maxLeft = Math.max(0, width - clientWidth);
      const remainingUp = Math.max(0, top);
      const remainingDown = Math.max(0, maxTop - top);
      const remainingLeft = Math.max(0, left);
      const remainingRight = Math.max(0, maxLeft - left);
      return {
        top,
        left,
        height,
        width,
        clientHeight,
        clientWidth,
        maxTop,
        maxLeft,
        remainingUp,
        remainingDown,
        remainingLeft,
        remainingRight,
        atTop: remainingUp <= 1,
        atBottom: remainingDown <= 1,
        atLeft: remainingLeft <= 1,
        atRight: remainingRight <= 1,
        canScrollUp: remainingUp > 1,
        canScrollDown: remainingDown > 1,
        canScrollLeft: remainingLeft > 1,
        canScrollRight: remainingRight > 1,
      };
    });
  }

  private async refreshScrollableAreas(): Promise<ScrollableArea[]> {
    await this.ensureBrowserPageRuntime();
    const areas = await this.activePage.evaluate(() => {
      const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime!;
      if (!runtime) return [];

      function visibleRectOf(element: Element) {
        const rect = runtime.visibleRect(element);
        if (!rect || rect.width < 24 || rect.height < 24) return undefined;
        return { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
      }

      function isScrollable(element: Element) {
        const style = window.getComputedStyle(element);
        const overflowY = style.overflowY;
        const overflowX = style.overflowX;
        const canScrollY = element.scrollHeight > element.clientHeight + 2 && /(auto|scroll|overlay)/i.test(overflowY);
        const canScrollX = element.scrollWidth > element.clientWidth + 2 && /(auto|scroll|overlay)/i.test(overflowX);
        return canScrollY || canScrollX;
      }

      function textOf(element: Element) {
        return runtime.textOf(element, 160);
      }

      function nameOf(element: Element) {
        return [
          element.getAttribute('aria-label'),
          element.getAttribute('title'),
          element.getAttribute('role'),
          textOf(element),
        ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 140);
      }

      function composedElements() {
        const output: Element[] = [];
        const queue = runtime.children(document.documentElement);
        let guard = 0;
        while (queue.length && guard < 5000) {
          const element = queue.shift() as Element;
          output.push(element);
          queue.push(...runtime.children(element));
          guard += 1;
        }
        return output;
      }

      const root = document.scrollingElement || document.documentElement;
      const elements = [root, ...composedElements().filter(isScrollable)];
      const seen = new Set<Element>();
      const output: Array<Omit<ScrollableArea, 'id'>> = [];
      for (const element of elements) {
        if (seen.has(element)) continue;
        seen.add(element);
        const rect = element === root
          ? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }
          : visibleRectOf(element);
        if (!rect) continue;
        const path = element === root ? 'document' : runtime.pathOf(element);
        if (!path) continue;
        const tag = element === root ? 'document' : element.tagName.toLowerCase();
        const role = element === root ? undefined : element.getAttribute('role') || undefined;
        const top = Math.round(element.scrollTop);
        const left = Math.round(element.scrollLeft);
        const height = Math.round(element.scrollHeight);
        const width = Math.round(element.scrollWidth);
        const clientHeight = Math.round(element.clientHeight);
        const clientWidth = Math.round(element.clientWidth);
        const maxTop = Math.max(0, height - clientHeight);
        const maxLeft = Math.max(0, width - clientWidth);
        const remainingUp = Math.max(0, top);
        const remainingDown = Math.max(0, maxTop - top);
        const remainingLeft = Math.max(0, left);
        const remainingRight = Math.max(0, maxLeft - left);
        output.push({
          path,
          tag,
          role,
          name: element === root ? 'page viewport' : nameOf(element),
          text: element === root ? undefined : textOf(element),
          rect,
          center: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) },
          scroll: {
            top,
            left,
            height,
            width,
            clientHeight,
            clientWidth,
            maxTop,
            maxLeft,
            remainingUp,
            remainingDown,
            remainingLeft,
            remainingRight,
            atTop: remainingUp <= 1,
            atBottom: remainingDown <= 1,
            atLeft: remainingLeft <= 1,
            atRight: remainingRight <= 1,
            canScrollUp: remainingUp > 1,
            canScrollDown: remainingDown > 1,
            canScrollLeft: remainingLeft > 1,
            canScrollRight: remainingRight > 1,
          },
        });
      }
      return output
        .sort((a, b) => {
          const aPage = a.path === 'document' ? -1 : 0;
          const bPage = b.path === 'document' ? -1 : 0;
          if (aPage !== bPage) return aPage - bPage;
          return (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height);
        })
        .slice(0, 30)
        .map((area, index) => ({ id: `S${index + 1}`, ...area }));
    });
    this.lastScrollableAreas = areas;
    return areas;
  }

  private finalizeInteractiveCandidates(
    mainCandidates: PageInteractiveCandidate[],
    frameCandidates: InteractiveCandidate[],
  ) {
    const combinedCandidates: InteractiveCandidate[] = [...mainCandidates, ...frameCandidates];
    const candidates = combinedCandidates
      .filter((candidate) => {
        if (candidate.framePath) return true;
        return !frameCandidates.some((frameCandidate) => this.rectContains(candidate.rect, frameCandidate.rect));
      })
      .sort((a, b) => this.compareCandidateOrder(a, b))
      .map((candidate, index) => ({
        ...candidate,
        id: `${index + 1}`,
      }));
    this.lastInteractiveCandidates = candidates;
    return candidates;
  }

  private async refreshInteractiveCandidates(options: { candidateTextQuery?: string } = {}) {
    await this.ensureBrowserPageRuntime();
    const mainCandidates = await this.activePage
      .evaluate(collectAiDomObservation, { includeInteractiveCandidates: true, requirePointerEvents: true, candidateTextQuery: options.candidateTextQuery })
      .then((observation) => observation.interactiveCandidates)
      .catch(() => [] as PageInteractiveCandidate[]);

    const frameCandidates = await this.refreshFrameInteractiveCandidates(options);
    return this.finalizeInteractiveCandidates(mainCandidates, frameCandidates);
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

  private async refreshFrameInteractiveCandidates(options: { candidateTextQuery?: string } = {}): Promise<InteractiveCandidate[]> {
    const frames = this.activePage.frames().filter((frame) => frame !== this.activePage.mainFrame());
    const viewport = await this.getViewportMetrics().catch(() => ({ width: 0, height: 0, devicePixelRatio: 1 }));
    const all: InteractiveCandidate[] = [];

    for (const frame of frames) {
      const framePath = this.getFramePath(frame);
      if (!framePath) continue;

      const box = await frame.frameElement().then((handle) => handle.boundingBox()).catch(() => undefined);
      if (!box || box.width <= 2 || box.height <= 2) continue;

      await this.ensureBrowserPageRuntime(frame);
      const localCandidates = await frame
        .evaluate(collectAiDomObservation, { includeInteractiveCandidates: true, requirePointerEvents: true, candidateTextQuery: options.candidateTextQuery })
        .then((observation) => observation.interactiveCandidates)
        .catch(() => [] as PageInteractiveCandidate[]);

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
      candidate.signals?.length ? `signals=${candidate.signals.join('|')}` : '',
      candidate.opensExternalApp ? `external-app=${candidate.externalAppProtocol || 'custom-protocol'}` : '',
      candidate.href ? `href=${candidate.href.slice(0, 140)}` : '',
      candidate.framePath ? `frame=${candidate.framePath}` : '',
    ].filter(Boolean);
    return parts.join(' ');
  }

  private externalAppCandidateNote(candidate: InteractiveCandidate) {
    if (!candidate.opensExternalApp) return '';
    const protocol = candidate.externalAppProtocol ? ` (${candidate.externalAppProtocol}:)` : '';
    return ` This candidate is marked as an external-application link${protocol}; the browser URL/page may remain unchanged. No host process check is performed, so ok=true means the click was delivered as an external-app launch attempt, not that the native app launch was server-verifiable.`;
  }

  private watchForPopup(page: Page) {
    const waitMs = boundedNonNegativeIntegerEnv('BROWSER_POPUP_WAIT_MS', DEFAULT_BROWSER_POPUP_WAIT_MS, 3000);
    return {
      waitMs,
      popup: waitMs > 0
        ? page.waitForEvent('popup', { timeout: waitMs }).catch(() => undefined)
        : Promise.resolve(undefined),
    };
  }

  private async claimPopupPage(newPage: Page | undefined, timings?: Record<string, number>) {
    if (!newPage) return undefined;
    this.claimPage(newPage);
    await timedBrowserStep(timings, 'bringPopupToFrontMs', () => newPage.bringToFront().catch(() => undefined));
    return newPage;
  }

  private async settlePopupAfterAction(popup: Promise<Page | undefined>, waitMs: number, timings?: Record<string, number>) {
    if (waitMs <= 0) return undefined;
    const fastWaitMs = Math.min(waitMs, boundedNonNegativeIntegerEnv('BROWSER_POPUP_FAST_WAIT_MS', 250, 1000));
    const newPage = await timedBrowserStep(timings, 'popupFastWaitMs', () => Promise.race([
      popup,
      sleep(fastWaitMs).then(() => undefined),
    ]));
    if (newPage) return this.claimPopupPage(newPage, timings);
    void popup.then((latePage) => this.claimPopupPage(latePage).catch(() => undefined));
    return undefined;
  }

  private compareCandidateOrder(a: InteractiveCandidate, b: InteractiveCandidate) {
    const frameCompare =
      (a.framePath || '').localeCompare(b.framePath || '') ||
      a.rect.y - b.rect.y ||
      a.rect.x - b.rect.x;
    if (a.framePath || b.framePath) {
      const sameFrame = (a.framePath || '') === (b.framePath || '');
      if (!sameFrame) return frameCompare;
    }
    const pathCompare = this.comparePathString(a.path, b.path);
    return pathCompare || a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.rect.width * a.rect.height - b.rect.width * b.rect.height;
  }

  private comparePathString(a: string, b: string) {
    const ap = a.split('.').map((item) => Number(item));
    const bp = b.split('.').map((item) => Number(item));
    const length = Math.min(ap.length, bp.length);
    for (let index = 0; index < length; index += 1) {
      if (ap[index] !== bp[index]) return ap[index] - bp[index];
    }
    return ap.length - bp.length;
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
              if (item.closest && item.closest('#__ai_candidate_overlay__, #__ai_last_click_marker__, #__ai_dom_export_control__')) continue;
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

  private async elementHandleForDomPath(frame: Frame, pathValue: string, locatorCandidates: string[] = []) {
    for (const selector of locatorCandidates) {
      try {
        const locator = frame.locator(selector);
        if (await locator.count() !== 1) continue;
        const element = await locator.elementHandle();
        if (element) return element;
      } catch {
        // A stale or unsupported selector falls back to the generation DOM path.
      }
    }
    await this.ensureBrowserPageRuntime(frame);
    const handle = await frame.evaluateHandle((path) => {
      const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime;
      const element = runtime?.elementFromPath(path);
      return element ? runtime?.actionableTargetFor(element) || element : null;
    }, pathValue).catch(() => undefined);
    const element = handle?.asElement();
    if (!element) {
      await handle?.dispose().catch(() => undefined);
      return undefined;
    }
    return element;
  }

  private async describeTopmostAtViewportPoint(x: number, y: number) {
    return this.activePage.evaluate(({ pointX, pointY }) => {
      if (pointX < 0 || pointY < 0 || pointX >= window.innerWidth || pointY >= window.innerHeight) {
        return `point outside viewport ${Math.round(pointX)},${Math.round(pointY)}`;
      }
      function describe(element: Element) {
        const tag = element.tagName.toLowerCase();
        const id = element.id ? `#${element.id}` : '';
        const cls = typeof element.className === 'string'
          ? element.className.split(/\s+/).filter(Boolean).slice(0, 4).map((item) => `.${item}`).join('')
          : '';
        const role = element.getAttribute('role') ? `[role="${element.getAttribute('role')}"]` : '';
        const text = ((element as HTMLElement).innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        return `${tag}${id}${cls}${role}${text ? ` text="${text}"` : ''}`;
      }
      return (document.elementsFromPoint(pointX, pointY) as Element[])
        .filter((element) => !element.closest?.('#__ai_candidate_overlay__, #__ai_last_click_marker__, #__ai_dom_export_control__'))
        .slice(0, 5)
        .map(describe)
        .join(' > ') || '[none]';
    }, { pointX: x, pointY: y }).catch(() => undefined);
  }

  private snapshotPageId(page: Page) {
    let id = this.snapshotPageIds.get(page);
    if (!id) {
      id = `p${++this.snapshotPageSequence}`;
      this.snapshotPageIds.set(page, id);
    }
    return id;
  }

  private snapshotUid(page: Page, identity: string) {
    const key = `${this.snapshotPageId(page)}:${identity}`;
    let entry = this.snapshotUidByIdentity.get(key);
    if (!entry) {
      entry = {
        uid: String(++this.snapshotUidSequence),
        lastSeenGeneration: this.snapshotGenerationSequence,
      };
      this.snapshotUidByIdentity.set(key, entry);
    } else {
      entry.lastSeenGeneration = this.snapshotGenerationSequence;
    }
    return entry.uid;
  }

  private pruneSnapshotUidMappings() {
    const retentionGenerations = boundedPositiveIntegerEnv('SNAPSHOT_UID_RETENTION_GENERATIONS', 12, 2, 200);
    const maxEntries = boundedPositiveIntegerEnv('SNAPSHOT_UID_MAX_ENTRIES', 20000, 1000, 200000);
    const oldestGeneration = Math.max(0, this.snapshotGenerationSequence - retentionGenerations);
    for (const [key, entry] of this.snapshotUidByIdentity) {
      if (entry.lastSeenGeneration < oldestGeneration) this.snapshotUidByIdentity.delete(key);
    }
    if (this.snapshotUidByIdentity.size <= maxEntries) return;
    const overflow = this.snapshotUidByIdentity.size - maxEntries;
    const oldest = [...this.snapshotUidByIdentity.entries()]
      .sort((left, right) => left[1].lastSeenGeneration - right[1].lastSeenGeneration)
      .slice(0, overflow);
    for (const [key] of oldest) this.snapshotUidByIdentity.delete(key);
  }

  private snapshotActionsForNode(node: SnapshotNodeWithUid) {
    const role = node.role.toLowerCase();
    const actions = new Set<string>();
    if (snapshotRoleIsActionable(role) || node.properties.actions) actions.add('click');
    if (node.properties.focusable) actions.add('focus');
    if (['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(role)) {
      actions.add('focus');
      actions.add('type');
    }
    if (['slider', 'scrollbar'].includes(role)) actions.add('scroll');
    return [...actions];
  }

  private async collectSnapshotDomFallback(
    page: Page,
    frames: CapturedSnapshotFrame[],
    axNodes: SnapshotNodeWithUid[],
    playwrightFrames: Frame[],
  ) {
    type FallbackCandidate = {
      selector: string;
      role: string;
      name: string;
      description: string;
      value: string;
      url: string;
      properties: Record<string, string | number | boolean>;
      actions: string[];
      depth: number;
      actionable: boolean;
    };
    const hasPrimaryAxTree = axNodes.some((item) => item.source === 'ax');
    const duplicateName = (name: string, properties: Record<string, string | number | boolean> = {}) => {
      const readable = name.replace(/\p{Co}/gu, '').trim().toLowerCase();
      if (readable) return `name:${readable}`;
      const className = String(properties.class || '').trim().toLowerCase();
      const icon = String(properties.icon || '').trim().toLowerCase();
      return className || icon ? `marker:${className}|${icon}` : 'unnamed';
    };
    const remainingAxDuplicates = new Map<string, number>();
    for (const node of axNodes.filter((item) => item.actionable && !hasPrimaryAxTree)) {
      const key = `${node.frameId}:${node.role.toLowerCase()}:${duplicateName(node.name, node.properties)}`;
      remainingAxDuplicates.set(key, (remainingAxDuplicates.get(key) || 0) + 1);
    }
    const fallbackIdentities = new Set<string>();
    const fallbackNodes: SnapshotNodeWithUid[] = [];
    const usedFrameIds = new Set<string>();
    for (const [frameIndex, frame] of playwrightFrames.entries()) {
      const privateFrameId = (frame as unknown as { _id?: string })._id;
      let frameInfo = privateFrameId ? frames.find((item) => item.frameId === privateFrameId) : undefined;
      if (!frameInfo) {
        const frameUrl = snapshotFrameUrl(frame.url());
        frameInfo = frames.find((item) => (
          !usedFrameIds.has(item.frameId)
          && snapshotFrameUrl(item.url) === frameUrl
        ));
      }
      const framePath = frame === page.mainFrame() ? undefined : this.getFramePath(frame);
      if (!frameInfo) {
        frameInfo = {
          frameId: `dom-frame-${frameIndex}`,
          documentId: `dom-document-${frameIndex}`,
          parentFrameId: undefined,
          url: frame.url() || undefined,
          depth: framePath ? framePath.split('.').length : 0,
        };
        frames.push(frameInfo);
      }
      usedFrameIds.add(frameInfo.frameId);
      const includeSemanticFallback = Boolean(frameInfo.error) || !axNodes.some((node) => node.frameId === frameInfo.frameId);
      const candidates = await frame.evaluate((includeSemantic): FallbackCandidate[] => {
        const win = window as Window & { __aiGetEventListenerTypes?: (target: EventTarget) => string[] };
        const flatParent = (element: Element): Element | null => {
          if (element.parentElement) return element.parentElement;
          const root = element.getRootNode();
          return root instanceof ShadowRoot ? root.host : null;
        };
        const selectorFor = (element: Element) => {
          const id = element.getAttribute('id');
          if (id) return `#${CSS.escape(id)}`;
          for (const attribute of ['data-testid', 'data-test', 'name']) {
            const value = element.getAttribute(attribute);
            if (value) return `${element.tagName.toLowerCase()}[${attribute}="${CSS.escape(value)}"]`;
          }
          const parts: string[] = [];
          let current: Element | null = element;
          while (current && parts.length < 10) {
            const tag = current.tagName.toLowerCase();
            const parent = flatParent(current);
            if (!parent) {
              parts.unshift(tag);
              break;
            }
            const siblings = Array.from(parent.children).filter((child) => child.tagName === current!.tagName);
            const index = Math.max(1, siblings.indexOf(current) + 1);
            parts.unshift(`${tag}:nth-of-type(${index})`);
            current = parent;
          }
          return parts.join(' > ');
        };
        const roleFor = (element: Element) => {
          const explicit = element.getAttribute('role');
          if (explicit) return explicit.toLowerCase();
          const tag = element.tagName.toLowerCase();
          if (tag === 'a') return 'link';
          if (tag === 'button') return 'button';
          if (tag === 'select') return 'combobox';
          if (tag === 'textarea') return 'textbox';
          if (tag === 'input') {
            const type = (element.getAttribute('type') || 'text').toLowerCase();
            if (type === 'checkbox') return 'checkbox';
            if (type === 'radio') return 'radio';
            if (['button', 'submit', 'reset'].includes(type)) return 'button';
            return 'textbox';
          }
          if (/^h[1-6]$/.test(tag)) return 'heading';
          if (tag === 'p') return 'paragraph';
          if (tag === 'li') return 'listitem';
          if (tag === 'tr') return 'row';
          if (tag === 'th') return 'columnheader';
          if (tag === 'td') return 'cell';
          if (tag === 'img') return 'image';
          if (tag === 'nav') return 'navigation';
          if (tag === 'main') return 'main';
          if (tag === 'form') return 'form';
          return 'generic';
        };
        const normalize = (value: unknown) => String(value || '').replace(/\s+/g, ' ').trim();
        const referencedText = (element: Element, attribute: string) => normalize(
          (element.getAttribute(attribute) || '')
            .split(/\s+/)
            .filter(Boolean)
            .map((id) => document.getElementById(id)?.textContent || '')
            .join(' '),
        );
        const associatedLabel = (element: Element) => {
          const field = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
          const labels = 'labels' in field && field.labels ? Array.from(field.labels) : [];
          const closest = element.closest('label');
          if (closest && !labels.includes(closest as HTMLLabelElement)) labels.push(closest as HTMLLabelElement);
          return normalize(labels.map((label) => label.textContent || '').join(' '));
        };
        const classDescriptor = (tag: string, className: string) => {
          const tokens = normalize(className).split(/\s+/).filter(Boolean);
          return tokens.length ? `${tag.toLowerCase()}.${tokens.join('.')}` : '';
        };
        const embeddedSvgIcons = (element: Element) => {
          const icons = Array.from(element.querySelectorAll('svg[class]'))
            .map((icon) => classDescriptor('svg', icon.getAttribute('class') || ''))
            .filter(Boolean);
          return [...new Set(icons)].slice(0, 4).join(', ');
        };
        const accessibleName = (element: Element, role: string, directText: string) => {
          const tag = element.tagName.toLowerCase();
          const type = (element.getAttribute('type') || '').toLowerCase();
          const labelledBy = referencedText(element, 'aria-labelledby');
          if (labelledBy) return labelledBy;
          const ariaLabel = normalize(element.getAttribute('aria-label'));
          if (ariaLabel) return ariaLabel;
          const label = associatedLabel(element);
          if (label) return label;
          if (tag === 'img') {
            const alt = normalize(element.getAttribute('alt'));
            if (alt) return alt;
          }
          const text = normalize(element.textContent || directText);
          if (text && (role !== 'generic' || ['a', 'button', 'label', 'summary'].includes(tag))) return text;
          if (tag === 'input' && ['button', 'submit', 'reset'].includes(type)) {
            const buttonValue = normalize((element as HTMLInputElement).value);
            if (buttonValue) return buttonValue;
          }
          return normalize(
            element.getAttribute('placeholder')
            || element.getAttribute('title')
            || element.getAttribute('name')
            || directText,
          );
        };
        const readable = (value: unknown) => normalize(String(value || '').replace(/\p{Co}/gu, ' '));
        const unnamedActionContext = (element: Element, role: string) => {
          const row = element.closest('tr,[role="row"]');
          const rowText = readable(row?.textContent).slice(0, 180);
          const column = element.closest('th,[role="columnheader"]');
          const columnText = readable(column?.textContent).slice(0, 120);
          if (role === 'checkbox' && rowText) return `[上下文] 选择：${rowText}`;
          if (role === 'checkbox' && columnText) return `[上下文] ${columnText}列全选`;
          if (columnText) return `[无标签控件：${columnText}列]`;
          if (rowText) return `[无标签控件：${rowText}行]`;
          let current: Element | null = element.parentElement;
          for (let hops = 0; current && hops < 10; hops += 1) {
            if (['body', 'html'].includes(current.tagName.toLowerCase())) break;
            const text = readable(
              current.getAttribute('aria-label')
              || current.getAttribute('title')
              || current.textContent,
            ).slice(0, 120);
            if (text) return `[无标签控件：${text}]`;
            current = flatParent(current);
          }
          const title = readable(document.title).slice(0, 100);
          return title ? `[无标签页面控件：${title}]` : '[无标签页面控件]';
        };
        const stateProperties = (element: Element) => {
          const field = element as unknown as Record<string, unknown>;
          const properties: Record<string, string | number | boolean> = {};
          const booleanProperties = ['checked', 'disabled', 'multiple', 'readOnly', 'required', 'selected'] as const;
          for (const property of booleanProperties) {
            if (property in field && Boolean(field[property])) {
              properties[property === 'readOnly' ? 'readonly' : property] = true;
            }
          }
          for (const [attribute, property] of [
            ['aria-checked', 'checked'],
            ['aria-disabled', 'disabled'],
            ['aria-expanded', 'expanded'],
            ['aria-invalid', 'invalid'],
            ['aria-pressed', 'pressed'],
            ['aria-readonly', 'readonly'],
            ['aria-required', 'required'],
            ['aria-selected', 'selected'],
          ] as const) {
            const value = element.getAttribute(attribute);
            if (value !== null && value !== 'false') properties[property] = value === 'true' ? true : value;
          }
          return properties;
        };
        const results: FallbackCandidate[] = [];
        const stack = Array.from(document.children).reverse().map((element) => ({ element, depth: 0 }));
        while (stack.length) {
          const { element, depth } = stack.pop()!;
          const style = getComputedStyle(element);
          if (style.display === 'none') continue;
          const tag = element.tagName.toLowerCase();
          if (['head', 'script', 'style', 'noscript', 'template', 'meta', 'link'].includes(tag)) continue;
          const children = [
            ...Array.from(element.children),
            ...(element.shadowRoot ? Array.from(element.shadowRoot.children) : []),
          ];
          for (let childIndex = children.length - 1; childIndex >= 0; childIndex -= 1) {
            stack.push({ element: children[childIndex], depth: depth + 1 });
          }
          if (style.visibility === 'hidden' || style.visibility === 'collapse') continue;
          const rect = element.getBoundingClientRect();
          const eventTypes = win.__aiGetEventListenerTypes?.(element) || [];
          const actions = new Set<string>();
          const role = roleFor(element);
          const inputType = tag === 'input' ? (element.getAttribute('type') || 'text').toLowerCase() : '';
          const roleSupportsClick = new Set([
            'button', 'checkbox', 'gridcell', 'link', 'listbox', 'menuitem', 'menuitemcheckbox',
            'menuitemradio', 'option', 'radio', 'scrollbar', 'slider', 'switch', 'tab', 'treeitem',
          ]).has(role);
          if (
            tag === 'a'
            || tag === 'button'
            || (tag === 'input' && ['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit'].includes(inputType))
            || element.hasAttribute('onclick')
            || typeof (element as HTMLElement).onclick === 'function'
            || eventTypes.some((event) => ['click', 'mousedown', 'pointerdown'].includes(event))
            || element.hasAttribute('data-action')
            || element.hasAttribute('data-click')
            || roleSupportsClick
          ) actions.add('click');
          if (
            tag === 'textarea'
            || (tag === 'input' && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(inputType))
            || element.getAttribute('contenteditable') === 'true'
            || ['textbox', 'searchbox', 'spinbutton'].includes(role)
          ) {
            actions.add('focus');
            actions.add('type');
          }
          if (tag === 'select' || role === 'combobox') {
            actions.add('click');
            actions.add('focus');
          }
          if (element.hasAttribute('tabindex') && !['list', 'listitem', 'row', 'rowgroup', 'table'].includes(role)) {
            actions.add('focus');
          }
          const properties = stateProperties(element);
          const actionable = actions.size > 0
            && properties.disabled !== true
            && style.pointerEvents !== 'none'
            && rect.width > 0
            && rect.height > 0;
          const representedByAx = ['a', 'button', 'input', 'select', 'textarea', 'summary'].includes(tag)
            || [
              'button', 'checkbox', 'combobox', 'gridcell', 'link', 'listbox', 'menuitem', 'menuitemcheckbox',
              'menuitemradio', 'option', 'radio', 'scrollbar', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab',
              'textbox', 'treeitem',
            ].includes(role);
          if (!includeSemantic && representedByAx) continue;
          const directText = Array.from(element.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent || '')
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          const semantic = includeSemantic && (role !== 'generic' || directText.length > 0);
          if (!actionable && !semantic) continue;
          const name = accessibleName(element, role, directText).slice(0, 300);
          if (actionable && !readable(name)) {
            const className = normalize(element.getAttribute('class') || '').slice(0, 300);
            const icon = embeddedSvgIcons(element);
            if (className) properties.class = className;
            if (icon) properties.icon = icon;
          }
          const description = name ? '' : unnamedActionContext(element, role);
          const field = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
          const value = ['input', 'select', 'textarea'].includes(tag) ? normalize(field.value).slice(0, 300) : '';
          const url = tag === 'a' ? String((element as HTMLAnchorElement).href || '') : '';
          if (!name && !actionable) continue;
          results.push({
            selector: selectorFor(element),
            role,
            name,
            description,
            value,
            url,
            properties,
            actions: [...actions],
            depth: Math.min(64, depth),
            actionable,
          });
        }
        return results.slice(0, 2000);
      }, includeSemanticFallback).catch(() => [] as FallbackCandidate[]);

      for (const candidate of candidates) {
        const duplicateKey = `${frameInfo.frameId}:${candidate.role.toLowerCase()}:${duplicateName(candidate.name, candidate.properties)}`;
        const remainingDuplicates = remainingAxDuplicates.get(duplicateKey) || 0;
        if (remainingDuplicates > 0) {
          remainingAxDuplicates.set(duplicateKey, remainingDuplicates - 1);
          continue;
        }
        const identity = `${frameInfo.documentId}:${frameInfo.frameId}:dom:${candidate.selector}`;
        if (fallbackIdentities.has(identity)) continue;
        const node: SnapshotNodeWithUid = {
          identity,
          uid: this.snapshotUid(page, identity),
          source: 'dom',
          selector: candidate.selector,
          framePath,
          frameId: frameInfo.frameId,
          documentId: frameInfo.documentId,
          frameUrl: frameInfo.url,
          frameDepth: frameInfo.depth,
          axNodeId: `dom:${candidate.selector}`,
          childAxNodeIds: [],
          depth: candidate.depth,
          ignored: false,
          role: candidate.role,
          name: candidate.name,
          description: candidate.description,
          value: candidate.value,
          url: candidate.url,
          properties: candidate.properties,
          actionable: candidate.actionable,
          actions: candidate.actions,
        };
        fallbackNodes.push(node);
        fallbackIdentities.add(identity);
      }
    }
    return fallbackNodes;
  }

  private async buildSnapshotGeneration(retryAfterMutation = false): Promise<SnapshotGeneration> {
    const startedAt = Date.now();
    const page = this.activePage;
    const id = `snapshot-${++this.snapshotGenerationSequence}`;
    const visibleFrameTargets = await this.snapshotFrameTargets();
    const mutationEpochsBefore = await this.readSnapshotMutationEpochs(visibleFrameTargets);
    const visiblePlaywrightFrames = visibleFrameTargets.map((target) => target.frame);
    const allowedFrameIds = new Set(visiblePlaywrightFrames
      .map((frame) => (frame as unknown as { _id?: string })._id)
      .filter((frameId): frameId is string => Boolean(frameId)));
    const framePathById = new Map(visiblePlaywrightFrames.map((frame) => [
      (frame as unknown as { _id?: string })._id || '',
      frame === page.mainFrame() ? undefined : this.getFramePath(frame),
    ]));
    let frames: CapturedSnapshotFrame[];
    let primaryNodes: SnapshotNodeWithUid[];
    let skippedFrameCount = 0;
    let captureAxMs = 0;
    let captureDomMs = 0;
    let frameTreeMs = 0;
    let axTreeMs = 0;
    let axEnrichmentMs = 0;
    let captureSource: SnapshotGeneration['captureSource'] = 'dom-snapshot';
    try {
      const capturedDom = await captureDomSnapshot(page, {
        axCandidateLimit: boundedNonNegativeIntegerEnv('DOM_SNAPSHOT_AX_CANDIDATE_LIMIT', 200, 500),
      });
      frames = capturedDom.frames.filter((frame) => !allowedFrameIds.size || allowedFrameIds.has(frame.frameId));
      primaryNodes = capturedDom.nodes
        .filter((node) => !allowedFrameIds.size || allowedFrameIds.has(node.frameId))
        .map((node): SnapshotNodeWithUid => ({
          ...node,
          uid: this.snapshotUid(page, node.identity),
          framePath: framePathById.get(node.frameId),
        }));
      skippedFrameCount = capturedDom.skippedFrames.length;
      captureDomMs = capturedDom.timings.domSnapshotMs;
      frameTreeMs = capturedDom.timings.frameTreeMs;
      axEnrichmentMs = capturedDom.timings.axEnrichmentMs;
    } catch {
      captureSource = 'full-ax-fallback';
      const capturedAx = await captureAxSnapshot(page, allowedFrameIds.size ? allowedFrameIds : undefined);
      frames = capturedAx.frames;
      primaryNodes = capturedAx.nodes.map((node): SnapshotNodeWithUid => ({
        ...node,
        uid: this.snapshotUid(page, node.identity),
        source: 'ax',
        framePath: framePathById.get(node.frameId),
        actions: this.snapshotActionsForNode({ ...node, uid: '' }),
      }));
      skippedFrameCount = capturedAx.skippedFrames.length;
      captureAxMs = capturedAx.timings.totalMs;
      frameTreeMs = capturedAx.timings.frameTreeMs;
      axTreeMs = capturedAx.timings.axTreeMs;
    }
    const fallbackStartedAt = Date.now();
    const domFallback = await this.collectSnapshotDomFallback(page, frames, primaryNodes, visiblePlaywrightFrames);
    const domFallbackMs = Date.now() - fallbackStartedAt;
    const nodes = [...primaryNodes, ...domFallback];
    const views = buildSnapshotViews(frames, nodes);
    const references = new Map<string, SnapshotReference>();
    for (const node of nodes) {
      references.set(node.uid, {
        uid: node.uid,
        generationId: id,
        page,
        documentId: node.documentId,
        frameId: node.frameId,
        framePath: node.framePath,
        frameUrl: node.frameUrl,
        axNodeId: node.axNodeId,
        backendDOMNodeId: node.backendDOMNodeId,
        selector: node.selector,
        role: node.role,
        name: node.name || node.description || node.value,
        url: node.url || undefined,
        actionable: node.actionable,
        actions: node.actions || this.snapshotActionsForNode(node),
      });
    }
    const mutationEpochs = await this.readSnapshotMutationEpochs(visibleFrameTargets);
    const mutationChangedDuringCapture = Object.keys(mutationEpochsBefore).length !== Object.keys(mutationEpochs).length
      || Object.keys(mutationEpochs).some((key) => mutationEpochs[key] !== mutationEpochsBefore[key]);
    if (mutationChangedDuringCapture && !retryAfterMutation) {
      return this.buildSnapshotGeneration(true);
    }
    this.pruneSnapshotUidMappings();
    return {
      id,
      createdAt: new Date().toISOString(),
      page,
      url: page.url(),
      frames,
      references,
      views,
      nodeCount: nodes.length,
      actionableCount: nodes.filter((node) => node.actionable).length,
      skippedFrameCount,
      captureSource,
      mutationEpochs,
      timings: {
        totalMs: Date.now() - startedAt,
        captureAxMs,
        captureDomMs,
        frameTreeMs,
        axTreeMs,
        axEnrichmentMs,
        domFallbackMs,
      },
    };
  }

  private async ensureSnapshotGeneration(refresh = false) {
    const page = this.activePage;
    if (!refresh && this.snapshotGeneration?.page === page && this.snapshotGeneration.url === page.url()) {
      return this.snapshotGeneration;
    }
    if (!refresh && this.snapshotGenerationPromise) return this.snapshotGenerationPromise;
    if (refresh && this.snapshotGenerationPromise) await this.snapshotGenerationPromise.catch(() => undefined);
    const promise = this.buildSnapshotGeneration();
    this.snapshotGenerationPromise = promise;
    try {
      const generation = await promise;
      this.snapshotGeneration = generation;
      return generation;
    } finally {
      if (this.snapshotGenerationPromise === promise) this.snapshotGenerationPromise = undefined;
    }
  }

  private invalidateSnapshotGeneration() {
    this.snapshotGeneration = undefined;
    this.snapshotGenerationPromise = undefined;
  }

  private snapshotMutationKey(target: { frame: Frame; framePath?: string }) {
    return target.framePath || 'main';
  }

  private async readSnapshotMutationEpochs(
    targets?: Array<{ frame: Frame; framePath?: string; frameUrl?: string }>,
  ) {
    const frameTargets = targets || await this.snapshotFrameTargets();
    const entries = await Promise.all(frameTargets.map(async (target) => {
      await this.ensureBrowserPageRuntime(target.frame);
      const state = await target.frame.evaluate(() => (
        (window as WindowWithAiDomRuntime).__aiDomMutationState || { epoch: 0, lastMutationAt: 0 }
      )).catch(() => ({ epoch: -1, lastMutationAt: 0 }));
      return [this.snapshotMutationKey(target), state.epoch] as const;
    }));
    return Object.fromEntries(entries);
  }

  private async snapshotMutationChanged(generation: SnapshotGeneration) {
    if (generation.page !== this.activePage || generation.url !== this.activePage.url()) return true;
    const current = await this.readSnapshotMutationEpochs();
    const previousKeys = Object.keys(generation.mutationEpochs);
    const currentKeys = Object.keys(current);
    if (previousKeys.length !== currentKeys.length) return true;
    return currentKeys.some((key) => current[key] !== generation.mutationEpochs[key]);
  }

  private snapshotViewText(generation: SnapshotGeneration, mode: SnapshotView) {
    const content = generation.views[mode].map((record) => record.line).join('\n');
    if (content) return content;
    if (mode === 'actionable') return '[no actionable accessibility nodes in the current page snapshot]';
    if (mode === 'text') return '[no accessible page text in the current snapshot]';
    return '[empty semantic DOM snapshot]';
  }

  private snapshotObservationViews(generation: SnapshotGeneration): BrowserSnapshotViews {
    return {
      defaultType: 'actionable',
      actionable: this.snapshotViewText(generation, 'actionable'),
      full: this.snapshotViewText(generation, 'full'),
      text: this.snapshotViewText(generation, 'text'),
    };
  }

  currentSnapshotObservationViews() {
    const generation = this.snapshotGeneration;
    if (!generation || generation.page !== this.activePage || generation.url !== this.activePage.url()) return undefined;
    return this.snapshotObservationViews(generation);
  }

  currentSnapshotGenerationId() {
    const generation = this.snapshotGeneration;
    if (!generation || generation.page !== this.activePage || generation.url !== this.activePage.url()) return undefined;
    return generation.id;
  }

  private async readInteractionCounts(): Promise<BrowserInteractionCounts> {
    const frames = [...new Set(this.sessionPages().flatMap((page) => page.frames()))];
    const records = await Promise.all(frames.map((frame) => frame.evaluate(() => {
      const state = (window as Window & {
        __aiDomMutationState?: { interactionCounts?: Record<string, number> };
      }).__aiDomMutationState;
      return state?.interactionCounts || {};
    }).catch(() => ({} as BrowserInteractionCounts))));
    const totals: BrowserInteractionCounts = {};
    for (const record of records) {
      for (const [type, count] of Object.entries(record)) {
        totals[type] = (totals[type] || 0) + Number(count || 0);
      }
    }
    return totals;
  }

  private interactionDelta(before: BrowserInteractionCounts, after: BrowserInteractionCounts, ...types: string[]) {
    return types.reduce((total, type) => total + Math.max(0, (after[type] || 0) - (before[type] || 0)), 0);
  }

  private async completeVerifiedAction(
    actual: string,
    previousGeneration: SnapshotGeneration | undefined,
    verify: () => Promise<BrowserActionVerification>,
  ): Promise<BrowserActionResult> {
    await this.activePage.waitForTimeout(40).catch(() => undefined);
    let verification: BrowserActionVerification;
    try {
      verification = await verify();
    } catch (error) {
      verification = { ok: false, detail: `verification failed: ${unknownErrorMessage(error)}` };
    }
    const result = await this.completeActionWithSnapshot(
      `${actual} Post-action check: ${verification.detail}`,
      previousGeneration,
    );
    return verification.ok ? result : { ...result, ok: false };
  }

  private async readScrollPosition(
    locator: Locator | undefined,
    point?: { x: number; y: number },
  ): Promise<BrowserScrollPosition | undefined> {
    const read = (start: Element | null): BrowserScrollPosition | undefined => {
      const describe = (element: Element) => {
        const tag = element.tagName.toLowerCase();
        return `${tag}${element.id ? `#${element.id}` : ''}`;
      };
      let current = start;
      while (current) {
        const element = current as HTMLElement;
        if (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) {
          return { descriptor: describe(element), left: element.scrollLeft, top: element.scrollTop };
        }
        current = current.parentElement;
      }
      const scrolling = document.scrollingElement;
      if (!scrolling) return undefined;
      return {
        descriptor: describe(scrolling),
        left: scrolling.scrollLeft,
        top: scrolling.scrollTop,
      };
    };
    if (locator) return locator.evaluate(read).catch(() => undefined);
    return this.activePage.evaluate(({ x, y }): BrowserScrollPosition | undefined => {
      const describe = (element: Element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}`;
      let current = document.elementFromPoint(x, y);
      while (current) {
        const element = current as HTMLElement;
        if (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) {
          return { descriptor: describe(element), left: element.scrollLeft, top: element.scrollTop };
        }
        current = current.parentElement;
      }
      const scrolling = document.scrollingElement;
      return scrolling
        ? { descriptor: describe(scrolling), left: scrolling.scrollLeft, top: scrolling.scrollTop }
        : undefined;
    }, point || { x: 1, y: 1 }).catch(() => undefined);
  }

  private async editableValue(locator: Locator | undefined) {
    if (!locator) return undefined;
    return locator.evaluate((element) => {
      const field = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      return 'value' in field ? String(field.value) : String(element.textContent || '');
    }).catch(() => undefined);
  }

  private async viewportDragTarget(page: Page, x: number, y: number, source: boolean) {
    const handle = await page.evaluateHandle(({ pointX, pointY, dragSource }) => {
      const hit = document.elementFromPoint(pointX, pointY);
      return dragSource ? hit?.closest('[draggable="true"]') || hit : hit;
    }, { pointX: x, pointY: y, dragSource: source }).catch(() => undefined);
    const element = handle?.asElement() as ElementHandle<Element> | null | undefined;
    if (!element) await handle?.dispose().catch(() => undefined);
    return element || undefined;
  }

  private async dispatchHtml5Drag(
    page: Page,
    source: Locator | ElementHandle<Element>,
    destination: Locator | ElementHandle<Element>,
  ) {
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    try {
      await source.dispatchEvent('dragstart', { dataTransfer });
      await destination.dispatchEvent('dragenter', { dataTransfer });
      await destination.dispatchEvent('dragover', { dataTransfer });
      await destination.dispatchEvent('drop', { dataTransfer });
      await source.dispatchEvent('dragend', { dataTransfer });
    } finally {
      await dataTransfer.dispose();
    }
  }

  private async completeActionWithSnapshot(
    actual: string,
    previousGeneration: SnapshotGeneration | undefined,
  ): Promise<BrowserActionResult> {
    this.lastScreenshotMetrics = undefined;
    await this.activePage.waitForTimeout(60).catch(() => undefined);
    try {
      const baselineGeneration = this.snapshotGeneration || previousGeneration;
      const changed = baselineGeneration
        ? await this.snapshotMutationChanged(baselineGeneration).catch(() => true)
        : true;
      const shouldRefresh = !baselineGeneration || changed;
      const generation = shouldRefresh
        ? await this.ensureSnapshotGeneration(true)
        : baselineGeneration;
      if (!shouldRefresh) this.snapshotGeneration = baselineGeneration;
      return {
        ok: true,
        actual: `${actual} Semantic DOM snapshot ${generation.id} is current (${shouldRefresh ? 'refreshed' : 'reused; no page-state change detected'}).`,
        autoSnapshot: { generationId: generation.id, refreshed: shouldRefresh },
      };
    } catch (error) {
      this.invalidateSnapshotGeneration();
      return {
        ok: true,
        actual: `${actual} Automatic semantic DOM snapshot refresh was unavailable: ${unknownErrorMessage(error)}`,
      };
    }
  }

  async readSnapshotSlice(options: {
    cursorIndex?: number;
    maxChars?: number;
    refresh?: boolean;
    mode?: SnapshotView;
  } = {}) {
    const startedAt = Date.now();
    const mode = options.mode === 'full' || options.mode === 'text' ? options.mode : 'actionable';
    const maxChars = Math.max(20000, Math.floor(Number(options.maxChars) || 20000));
    const startIndex = Math.max(0, Math.floor(Number(options.cursorIndex) || 0));
    const generation = await this.ensureSnapshotGeneration(options.refresh === true);
    const records = generation.views[mode];
    const lines: string[] = [];
    let chars = 0;
    let nextIndex = Math.min(startIndex, records.length);
    for (let index = startIndex; index < records.length; index += 1) {
      const line = records[index].line.trim();
      const addition = line.length + (lines.length ? 1 : 0);
      if (lines.length && chars + addition > maxChars) break;
      lines.push(line);
      chars += addition;
      nextIndex = index + 1;
    }
    const empty = mode === 'actionable'
      ? '[no actionable accessibility nodes in the current page snapshot]'
      : mode === 'text'
        ? '[no accessible page text in the current snapshot]'
        : '[empty semantic DOM snapshot]';
    const content = lines.join('\n') || empty;
    return {
      content,
      contentCharLength: content.length,
      generationId: generation.id,
      hasMore: nextIndex < records.length,
      nextIndex,
      returnedEntries: Math.max(0, nextIndex - startIndex),
      startIndex,
      totalEntries: records.length,
      mode,
      nodeCount: generation.nodeCount,
      actionableCount: generation.actionableCount,
      frameCount: generation.frames.length,
      skippedFrameCount: generation.skippedFrameCount,
      captureSource: generation.captureSource,
      timings: { ...generation.timings, readSliceMs: Date.now() - startedAt },
    };
  }

  async searchSnapshot(input: { query: string; roles?: string[]; limit?: number }): Promise<BrowserActionResult> {
    const normalizeSearchText = (value: unknown) => String(value || '')
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const query = normalizeSearchText(input.query);
    if (!query) return { ok: false, actual: 'Snapshot search requires a non-empty query.' };
    let generation = await this.ensureSnapshotGeneration(false);
    if (await this.snapshotMutationChanged(generation).catch(() => false)) {
      generation = await this.ensureSnapshotGeneration(true);
    }
    const roles = new Set((input.roles || []).map(normalizeSearchText));
    const queryParts = query.split(/\s+/).filter(Boolean);
    const limit = Math.min(100, Math.max(1, Math.floor(Number(input.limit) || 20)));
    const mainFrameId = generation.frames[0]?.frameId;
    const matches = generation.views.full
      .map((record, index) => ({ record, index }))
      .filter(({ record }) => {
        if (roles.size && !roles.has(String(record.role || '').toLowerCase())) return false;
        const searchable = normalizeSearchText([record.name, record.url, record.line].filter(Boolean).join(' '));
        return searchable.includes(query) || queryParts.every((part) => searchable.includes(part));
      })
      .sort((left, right) => {
        const score = (record: SnapshotRecord) => {
          const name = normalizeSearchText(record.name);
          const url = normalizeSearchText(record.url);
          const line = normalizeSearchText(record.line);
          let value = 0;
          if (name === query) value += 140;
          else if (name.startsWith(query)) value += 110;
          else if (name.includes(query)) value += 85;
          else if (queryParts.length > 1 && queryParts.every((part) => name.includes(part))) value += 72;
          else if (url.includes(query)) value += 45;
          else if (line.includes(query)) value += 35;
          if (record.actionable) value += 30;
          if (record.frameId === mainFrameId) value += 6;
          if (/\b(?:focused|selected|modal)=true\b/.test(line)) value += 12;
          if (/\bdisabled=true\b/.test(line)) value -= 35;
          return value;
        };
        return score(right.record) - score(left.record) || left.index - right.index;
      })
      .slice(0, limit);
    return {
      ok: true,
      actual: [
        `Snapshot ${generation.id} search for "${input.query}" returned ${matches.length} result(s). Only UIDs from this current snapshot are actionable.`,
        matches.map(({ record }) => record.line).join('\n') || '[no snapshot matches]',
      ].join('\n'),
    };
  }

  private currentSnapshotReference(uid: string) {
    const generation = this.snapshotGeneration;
    if (!generation || generation.page !== this.activePage || generation.url !== this.activePage.url()) {
      return { error: 'No current snapshot generation is available. Call takeSnapshot before using a UID.' };
    }
    const reference = generation.references.get(String(uid));
    if (!reference) {
      return { error: `UID ${uid} is not present in the latest snapshot ${generation.id}. Take a new snapshot and choose a current UID.` };
    }
    return { reference };
  }

  private async snapshotReferenceLocator(reference: SnapshotReference) {
    const frame = reference.framePath ? this.frameFromPath(reference.framePath) : this.activePage.mainFrame();
    if (!frame) return undefined;
    if (reference.selector) {
      const locator = frame.locator(reference.selector);
      return await locator.count().catch(() => 0) === 1 ? locator : undefined;
    }
    if (!reference.name || !snapshotRoleIsActionable(reference.role)) return undefined;
    const locator = frame.getByRole(
      reference.role as Parameters<Frame['getByRole']>[0],
      { name: reference.name, exact: true },
    );
    return await locator.count().catch(() => 0) === 1 ? locator : undefined;
  }

  private async validateLocatorActionPoint(
    locator: Locator,
    reference: SnapshotReference,
    allowNonActionable: boolean,
  ) {
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    if (!await locator.isVisible().catch(() => false)) {
      return { error: `UID ${reference.uid} is no longer visible.` };
    }
    if (!allowNonActionable && !await locator.isEnabled().catch(() => false)) {
      return { error: `UID ${reference.uid} is disabled and cannot receive an action.` };
    }
    const ariaSnapshot = await locator.ariaSnapshot().catch(() => '');
    let validationError = '';
    const validation = await locator.evaluate((element) => {
      const target = element as HTMLElement;
      const style = window.getComputedStyle(target);
      const disabled = Boolean(
        (target as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled
        || target.getAttribute('aria-disabled') === 'true',
      );
      const rect = target.getBoundingClientRect();
      const ratios = [
        [0.5, 0.5], [0.2, 0.5], [0.8, 0.5], [0.5, 0.2], [0.5, 0.8],
        [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8],
      ];
      let point: number[] | undefined;
      for (const ratio of ratios) {
        const xRatio = ratio[0];
        const yRatio = ratio[1];
        const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width * xRatio));
        const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height * yRatio));
        let top: Element | undefined;
        for (const candidate of document.elementsFromPoint(x, y)) {
          if (candidate.closest('#__ai_candidate_overlay__, #__ai_last_click_marker__, #__ai_dom_export_control__')) continue;
          const candidateStyle = window.getComputedStyle(candidate);
          if (candidateStyle.display !== 'none' && candidateStyle.visibility !== 'hidden') {
            top = candidate;
            break;
          }
        }
        let current: Element | null | undefined = top;
        for (let guard = 0; current && guard < 64; guard += 1) {
          if (current === target) {
            point = ratio;
            break;
          }
          const root = current.getRootNode();
          current = current.parentElement || (root instanceof ShadowRoot ? root.host : null);
        }
        if (point) break;
      }
      return {
        connected: target.isConnected,
        disabled,
        visible: rect.width > 0
          && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.visibility !== 'collapse'
          && Number(style.opacity || '1') > 0.01,
        point,
      };
    }).catch((error) => {
      validationError = unknownErrorMessage(error);
      return undefined;
    });
    if (!validation) {
      return { error: `UID ${reference.uid} could not be validated before action: ${validationError || 'unknown Playwright locator error'}.` };
    }
    if (!validation?.connected || !validation.visible) {
      return { error: `UID ${reference.uid} is detached or no longer rendered.` };
    }
    if (!allowNonActionable && validation.disabled) {
      return { error: `UID ${reference.uid} is disabled and cannot receive an action.` };
    }
    if (!validation.point) {
      return { error: `UID ${reference.uid} is covered by another rendered element.` };
    }
    const box = await locator.boundingBox().catch(() => undefined);
    if (!box || box.width <= 0 || box.height <= 0) {
      return { error: `UID ${reference.uid} no longer has a rendered box.` };
    }
    const [xRatio, yRatio] = validation.point;
    return {
      point: {
        x: Math.round(box.x + box.width * xRatio),
        y: Math.round(box.y + box.height * yRatio),
        descriptor: `${reference.role} "${reference.name}"${ariaSnapshot ? ' (Playwright accessibility match)' : ''}`,
        source: 'playwright-accessibility',
      },
    };
  }

  private async resolveSnapshotReferencePoint(uid: string, allowNonActionable = false) {
    const previousGeneration = this.snapshotGeneration;
    if (previousGeneration && await this.snapshotMutationChanged(previousGeneration).catch(() => true)) {
      let refreshedGeneration: SnapshotGeneration;
      try {
        refreshedGeneration = await this.ensureSnapshotGeneration(true);
      } catch (error) {
        return { error: `UID ${uid} could not be refreshed after the page changed: ${unknownErrorMessage(error)}` };
      }
      const previousReference = previousGeneration.references.get(String(uid));
      const refreshedReference = refreshedGeneration.references.get(String(uid));
      if (!previousReference || !refreshedReference) {
        return { error: `UID ${uid} is stale because its DOM node no longer exists in the refreshed snapshot. Capture a fresh snapshot and choose the current target.` };
      }
      const previousRole = previousReference.role.trim().toLowerCase();
      const refreshedRole = refreshedReference.role.trim().toLowerCase();
      const previousName = previousReference.name.replace(/\s+/g, ' ').trim();
      const refreshedName = refreshedReference.name.replace(/\s+/g, ' ').trim();
      if (previousRole !== refreshedRole || previousName !== refreshedName) {
        return {
          error: `UID ${uid} is stale because the target semantics changed from ${previousReference.role} "${previousName}" to ${refreshedReference.role} "${refreshedName}". Capture a fresh snapshot and confirm the target.`,
        };
      }
    }
    const resolved = this.currentSnapshotReference(uid);
    if (!resolved.reference) return { error: resolved.error };
    const reference = resolved.reference;
    if (!allowNonActionable && !reference.actionable) {
      return { error: `UID ${uid} (${reference.role} "${reference.name}") is structural text, not an actionable control.` };
    }
    const locator = await this.snapshotReferenceLocator(reference);
    if (locator) {
      const validated = await this.validateLocatorActionPoint(locator, reference, allowNonActionable);
      if (!validated.point) return { error: validated.error };
      return { reference, point: validated.point };
    }
    if (!reference.backendDOMNodeId) {
      return { error: `UID ${uid} has no backing DOM node and cannot receive a mouse or keyboard action.` };
    }
    const client = await this.activePage.context().newCDPSession(this.activePage);
    let targetObjectId: string | undefined;
    try {
      const resolvedTarget = await client.send('DOM.resolveNode', {
        backendNodeId: reference.backendDOMNodeId,
      }) as { object?: { objectId?: string } };
      targetObjectId = resolvedTarget.object?.objectId;
      if (!targetObjectId) return { error: `UID ${uid} no longer resolves to a live DOM element.` };
      const stateResult = await client.send('Runtime.callFunctionOn', {
        objectId: targetObjectId,
        functionDeclaration: `function () {
          const element = this;
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return {
            connected: element.isConnected,
            disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
            visible: rect.width > 0 && rect.height > 0
              && style.display !== 'none'
              && style.visibility !== 'hidden'
              && style.visibility !== 'collapse'
              && Number(style.opacity || '1') > 0.01,
          };
        }`,
        returnByValue: true,
      }) as { result?: { value?: { connected?: boolean; disabled?: boolean; visible?: boolean } } };
      const state = stateResult.result?.value;
      if (!state?.connected || !state.visible) return { error: `UID ${uid} is detached or no longer rendered.` };
      if (!allowNonActionable && state.disabled) return { error: `UID ${uid} is disabled and cannot receive an action.` };
      await client.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: reference.backendDOMNodeId });
      const result = await client.send('DOM.getContentQuads', { backendNodeId: reference.backendDOMNodeId }) as { quads?: number[][] };
      const quads = (result.quads || []).filter((quad) => quad.length >= 8);
      const quad = quads.sort((left, right) => {
        const area = (value: number[]) => Math.abs(
          value[0] * value[3] + value[2] * value[5] + value[4] * value[7] + value[6] * value[1]
          - value[1] * value[2] - value[3] * value[4] - value[5] * value[6] - value[7] * value[0],
        ) / 2;
        return area(right) - area(left);
      })[0];
      if (!quad) return { error: `UID ${uid} no longer has a rendered content quad.` };
      const viewport = await this.getViewportMetrics();
      const center = {
        x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
        y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
      };
      const candidates = [center, ...[0, 2, 4, 6].map((index) => ({
        x: center.x * 0.7 + quad[index] * 0.3,
        y: center.y * 0.7 + quad[index + 1] * 0.3,
      }))];
      let actionablePoint: { x: number; y: number } | undefined;
      for (const candidate of candidates) {
        const x = Math.round(candidate.x);
        const y = Math.round(candidate.y);
        if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) continue;
        const hit = await client.send('DOM.getNodeForLocation', {
          x,
          y,
          includeUserAgentShadowDOM: true,
        }).catch(() => undefined) as { backendNodeId?: number } | undefined;
        if (!hit?.backendNodeId) continue;
        if (hit.backendNodeId === reference.backendDOMNodeId) {
          actionablePoint = { x, y };
          break;
        }
        const resolvedHit = await client.send('DOM.resolveNode', { backendNodeId: hit.backendNodeId })
          .catch(() => undefined) as { object?: { objectId?: string } } | undefined;
        const hitObjectId = resolvedHit?.object?.objectId;
        if (!hitObjectId) continue;
        const containsResult = await client.send('Runtime.callFunctionOn', {
          objectId: targetObjectId,
          functionDeclaration: `function (hit) {
            if (!hit) return false;
            let current = hit;
            for (let guard = 0; current && guard < 64; guard += 1) {
              if (current === this) return true;
              const root = current.getRootNode ? current.getRootNode() : null;
              current = current.parentElement || (root && root.host) || null;
            }
            return false;
          }`,
          arguments: [{ objectId: hitObjectId }],
          returnByValue: true,
        }).catch(() => undefined) as { result?: { value?: boolean } } | undefined;
        await client.send('Runtime.releaseObject', { objectId: hitObjectId }).catch(() => undefined);
        if (containsResult?.result?.value) {
          actionablePoint = { x, y };
          break;
        }
      }
      if (!actionablePoint) return { error: `UID ${uid} is covered by another rendered element.` };
      return {
        reference,
        point: {
          x: actionablePoint.x,
          y: actionablePoint.y,
          descriptor: `${reference.role} "${reference.name}"`,
          source: 'accessibility-tree',
        },
      };
    } catch (error) {
      return { error: `UID ${uid} could not be resolved from the latest semantic DOM snapshot: ${unknownErrorMessage(error)}` };
    } finally {
      if (targetObjectId) await client.send('Runtime.releaseObject', { objectId: targetObjectId }).catch(() => undefined);
      await client.detach().catch(() => undefined);
    }
  }

  private async resolveScreenshotPoint(xThousandth?: number, yThousandth?: number) {
    const xPart = Number(xThousandth);
    const yPart = Number(yThousandth);
    if (!Number.isInteger(xPart) || !Number.isInteger(yPart) || xPart < 1 || xPart > 999 || yPart < 1 || yPart > 999) {
      return { error: 'Screenshot coordinates must provide integer x_thousandth and y_thousandth values from 1 to 999.' };
    }
    const metrics = this.lastScreenshotMetrics;
    if (!metrics || metrics.capture !== 'viewport') {
      return { error: 'No current actionable viewport screenshot exists. Call takeScreenshot with capture="viewport" first.' };
    }
    if (metrics.page !== this.activePage || metrics.url !== this.activePage.url()) {
      return { error: 'The latest screenshot is stale because the active page or URL changed. Capture a new viewport screenshot.' };
    }
    const maxAgeMs = boundedPositiveIntegerEnv('SCREENSHOT_COORDINATE_MAX_AGE_MS', 30000, 1000, 300000);
    if (Date.now() - metrics.capturedAt > maxAgeMs) {
      return { error: `The latest screenshot is older than ${maxAgeMs}ms. Capture a new viewport screenshot before coordinate input.` };
    }
    const [viewport, scroll] = await Promise.all([
      this.getViewportMetrics(),
      this.activePage.evaluate(() => ({ x: window.scrollX, y: window.scrollY })).catch(() => ({ x: 0, y: 0 })),
    ]);
    if (
      viewport.width !== metrics.viewport.width
      || viewport.height !== metrics.viewport.height
      || Math.abs(scroll.x - metrics.scrollX) > 1
      || Math.abs(scroll.y - metrics.scrollY) > 1
    ) {
      return { error: 'The latest screenshot is stale because the viewport size or scroll position changed. Capture a new viewport screenshot.' };
    }
    const x = Math.min(viewport.width - 1, Math.max(1, Math.round(viewport.width * xPart / 1000)));
    const y = Math.min(viewport.height - 1, Math.max(1, Math.round(viewport.height * yPart / 1000)));
    const topmost = await this.describeTopmostAtViewportPoint(x, y);
    return {
      point: {
        x,
        y,
        descriptor: topmost || `latest screenshot coordinate (${xPart}, ${yPart})`,
        source: `viewport-screenshot-${metrics.generation}`,
      },
    };
  }

  private async unifiedActionPoint(
    input: { uid?: string; xThousandth?: number; yThousandth?: number },
    allowNonActionable = false,
  ): Promise<ResolvedBrowserActionPoint> {
    const hasUid = typeof input.uid === 'string' && input.uid.trim().length > 0;
    const hasAnyCoordinate = input.xThousandth !== undefined || input.yThousandth !== undefined;
    if (hasUid && hasAnyCoordinate) return { error: 'Use either uid or screenshot coordinates, never both.' };
    if (hasUid) return this.resolveSnapshotReferencePoint(input.uid!, allowNonActionable);
    if (hasAnyCoordinate) return this.resolveScreenshotPoint(input.xThousandth, input.yThousandth);
    return { error: 'A uid or the latest screenshot x_thousandth/y_thousandth coordinates are required.' };
  }

  async mouse(input: BrowserMouseAction): Promise<BrowserActionResult> {
    const page = this.activePage;
    const previousGeneration = this.snapshotGeneration;
    if (input.action === 'scroll') {
      let point: { x: number; y: number; descriptor: string; source: string } | undefined;
      let targetLocator: Locator | undefined;
      if (input.uid || input.xThousandth !== undefined || input.yThousandth !== undefined) {
        const resolved = await this.unifiedActionPoint(input, true);
        if (!resolved.point) return { ok: false, actual: resolved.error || 'Unable to resolve scroll target.' };
        point = resolved.point;
        targetLocator = resolved.reference ? await this.snapshotReferenceLocator(resolved.reference) : undefined;
        if (targetLocator) await targetLocator.hover();
        else await page.mouse.move(point.x, point.y);
      }
      const deltaX = Number.isFinite(input.deltaX) ? Number(input.deltaX) : 0;
      const deltaY = Number.isFinite(input.deltaY) ? Number(input.deltaY) : 0;
      if (!deltaX && !deltaY) return { ok: false, actual: 'Mouse scroll requires a non-zero deltaX or deltaY.' };
      const eventsBefore = await this.readInteractionCounts();
      const scrollBefore = await this.readScrollPosition(targetLocator, point);
      await page.mouse.wheel(deltaX, deltaY);
      return this.completeVerifiedAction(
        `Scrolled${point ? ` over ${point.descriptor}` : ' the page'} by (${deltaX}, ${deltaY}).`,
        previousGeneration,
        async () => {
          const eventsAfter = await this.readInteractionCounts();
          const scrollAfter = await this.readScrollPosition(targetLocator, point);
          const wheelEvents = this.interactionDelta(eventsBefore, eventsAfter, 'wheel');
          const moved = Boolean(scrollBefore && scrollAfter
            && (scrollBefore.left !== scrollAfter.left || scrollBefore.top !== scrollAfter.top));
          const movement = scrollBefore && scrollAfter
            ? `${scrollBefore.descriptor} (${scrollBefore.left},${scrollBefore.top})→(${scrollAfter.left},${scrollAfter.top})`
            : 'scroll position unavailable';
          return {
            ok: wheelEvents > 0 || moved,
            detail: `${wheelEvents} wheel event(s) observed; ${movement}${moved ? '' : ' (at boundary or handled without offset change)'}.`,
          };
        },
      );
    }

    if (input.action === 'scrollIntoView') {
      if (!input.uid) return { ok: false, actual: 'scrollIntoView requires a current snapshot uid.' };
      const resolved = await this.resolveSnapshotReferencePoint(input.uid, true);
      if (!resolved.point) return { ok: false, actual: resolved.error || `Unable to scroll UID ${input.uid} into view.` };
      const targetLocator = resolved.reference ? await this.snapshotReferenceLocator(resolved.reference) : undefined;
      return this.completeVerifiedAction(
        `Scrolled UID ${input.uid} (${resolved.point.descriptor}) into view.`,
        previousGeneration,
        async () => {
          if (!targetLocator) {
            return { ok: true, detail: `CDP returned an actionable viewport point at (${resolved.point!.x},${resolved.point!.y}).` };
          }
          const box = await targetLocator.boundingBox().catch(() => undefined);
          const viewport = await this.getViewportMetrics();
          const visible = Boolean(box
            && box.x < viewport.width
            && box.y < viewport.height
            && box.x + box.width > 0
            && box.y + box.height > 0);
          return { ok: visible, detail: visible ? 'target bounding box intersects the viewport.' : 'target did not enter the viewport.' };
        },
      );
    }

    const from = await this.unifiedActionPoint(input, input.action === 'move');
    if (!from.point) return { ok: false, actual: from.error || 'Unable to resolve mouse target.' };
    const fromLocator = from.reference ? await this.snapshotReferenceLocator(from.reference) : undefined;
    if (input.action === 'move') {
      const eventsBefore = await this.readInteractionCounts();
      if (fromLocator) await fromLocator.hover();
      else await page.mouse.move(from.point.x, from.point.y);
      return this.completeVerifiedAction(
        `Moved mouse to ${from.point.descriptor} at (${from.point.x}, ${from.point.y}) using ${fromLocator ? 'Playwright hover' : 'viewport coordinates'}.`,
        previousGeneration,
        async () => {
          const eventsAfter = await this.readInteractionCounts();
          const moveEvents = this.interactionDelta(eventsBefore, eventsAfter, 'mousemove');
          const hovered = fromLocator
            ? await fromLocator.evaluate((element) => element.matches(':hover')).catch(() => false)
            : await page.evaluate(({ x, y }) => {
              const hit = document.elementFromPoint(x, y);
              return Boolean(hit && hit.matches(':hover'));
            }, { x: from.point!.x, y: from.point!.y }).catch(() => false);
          return {
            ok: moveEvents > 0 || hovered,
            detail: `${moveEvents} mousemove event(s) observed; target hover=${hovered}.`,
          };
        },
      );
    }
    if (input.action === 'drag') {
      const to = await this.unifiedActionPoint({
        uid: input.toUid,
        xThousandth: input.toXThousandth,
        yThousandth: input.toYThousandth,
      }, true);
      if (!to.point) return { ok: false, actual: to.error || 'Unable to resolve drag destination.' };
      const toLocator = to.reference ? await this.snapshotReferenceLocator(to.reference) : undefined;
      const button = input.button || 'left';
      const eventsBefore = await this.readInteractionCounts();
      const sourceHandle = fromLocator ? undefined : await this.viewportDragTarget(page, from.point.x, from.point.y, true);
      const destinationHandle = toLocator ? undefined : await this.viewportDragTarget(page, to.point.x, to.point.y, false);
      const sourceTarget = fromLocator || sourceHandle;
      const destinationTarget = toLocator || destinationHandle;
      let usedHtml5Fallback = false;
      try {
        if (fromLocator) await fromLocator.hover();
        else await page.mouse.move(from.point.x, from.point.y);
        await page.mouse.down({ button });
        await page.mouse.move(from.point.x + 8, from.point.y + 4, { steps: 3 });
        await page.mouse.move(to.point.x, to.point.y, { steps: 12 });
        await page.mouse.up({ button });
        const nativeEvents = await this.readInteractionCounts();
        const nativeDropCompleted = this.interactionDelta(eventsBefore, nativeEvents, 'drop') > 0;
        if (button === 'left' && !nativeDropCompleted && sourceTarget && destinationTarget) {
          await this.dispatchHtml5Drag(page, sourceTarget, destinationTarget);
          usedHtml5Fallback = true;
        }
      } finally {
        await sourceHandle?.dispose().catch(() => undefined);
        await destinationHandle?.dispose().catch(() => undefined);
      }
      void this.showClickMarker(to.point.x, to.point.y, 'drag');
      return this.completeVerifiedAction(
        `Dragged ${from.point.descriptor} to ${to.point.descriptor} using ${fromLocator && toLocator ? 'Playwright locator-guided' : 'viewport-coordinate'} pointer input${usedHtml5Fallback ? ' plus HTML5 DataTransfer fallback' : ''}.`,
        previousGeneration,
        async () => {
          const eventsAfter = await this.readInteractionCounts();
          const drops = this.interactionDelta(eventsBefore, eventsAfter, 'drop');
          const moves = this.interactionDelta(eventsBefore, eventsAfter, 'mousemove');
          const ok = button === 'left' ? drops > 0 : moves > 0;
          return {
            ok,
            detail: `${moves} mousemove and ${drops} drop event(s) observed${usedHtml5Fallback ? '; DataTransfer fallback used' : ''}.`,
          };
        },
      );
    }

    const button = input.button || 'left';
    const clickCount = Math.min(3, Math.max(1, Math.floor(Number(input.clickCount) || 1)));
    const eventsBefore = await this.readInteractionCounts();
    const urlBefore = page.url();
    const popup = this.watchForPopup(page);
    if (fromLocator) await fromLocator.click({ button, clickCount, noWaitAfter: true });
    else await page.mouse.click(from.point.x, from.point.y, { button, clickCount });
    const claimedPopup = await this.settlePopupAfterAction(popup.popup, popup.waitMs);
    void this.showClickMarker(from.point.x, from.point.y, clickCount > 1 ? 'double' : button === 'right' ? 'right' : 'click');
    return this.completeVerifiedAction(
      `Clicked ${from.point.descriptor} at (${from.point.x}, ${from.point.y}) with button=${button}, count=${clickCount}, source=${from.point.source}.`,
      previousGeneration,
      async () => {
        const eventsAfter = await this.readInteractionCounts();
        const expectedEvent = button === 'right'
          ? 'contextmenu'
          : button === 'middle'
            ? 'auxclick'
            : clickCount > 1 ? 'dblclick' : 'click';
        const delivered = this.interactionDelta(eventsBefore, eventsAfter, expectedEvent);
        const navigated = Boolean(claimedPopup) || page.url() !== urlBefore;
        const focus = await this.getFocusedElement();
        return {
          ok: delivered > 0 || navigated,
          detail: `${delivered} ${expectedEvent} event(s) observed; navigation=${navigated}; ${focus.summary}`,
        };
      },
    );
  }

  async keyboard(input: BrowserKeyboardAction): Promise<BrowserActionResult> {
    const page = this.activePage;
    const previousGeneration = this.snapshotGeneration;
    let targetLocator: Locator | undefined;
    if (input.uid || input.xThousandth !== undefined || input.yThousandth !== undefined) {
      const target = await this.unifiedActionPoint(input);
      if (!target.point) return { ok: false, actual: target.error || 'Unable to resolve keyboard focus target.' };
      targetLocator = target.reference ? await this.snapshotReferenceLocator(target.reference) : undefined;
      if (targetLocator) {
        await targetLocator.click({ noWaitAfter: true });
        await targetLocator.focus();
        const focused = await targetLocator.evaluate((element) => (
          element === document.activeElement || element.contains(document.activeElement)
        )).catch(() => false);
        if (!focused) return { ok: false, actual: 'The keyboard target did not receive focus after Playwright click and focus.' };
      } else {
        await page.mouse.click(target.point.x, target.point.y);
        const focused = page.locator(':focus');
        if (await focused.count().catch(() => 0) === 1) targetLocator = focused;
      }
    }
    if (input.action === 'type') {
      if (typeof input.text !== 'string') return { ok: false, actual: 'Keyboard type requires text.' };
      const text = input.text;
      const editable = targetLocator
        ? await targetLocator.isEditable().catch(() => false)
        : await page.locator(':focus').isEditable().catch(() => false);
      if (!editable) return { ok: false, actual: 'Keyboard type requires an editable focused textbox or contenteditable target.' };
      const valueBefore = await this.editableValue(targetLocator);
      const eventsBefore = await this.readInteractionCounts();
      const selectAllKey = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';
      if (input.replace !== false) {
        if (targetLocator) {
          await targetLocator.press(selectAllKey);
          await targetLocator.press('Backspace');
        } else {
          await page.keyboard.press(selectAllKey);
          await page.keyboard.press('Backspace');
        }
      }
      const delay = boundedNonNegativeIntegerEnv('BROWSER_KEYBOARD_TYPE_DELAY_MS', 0, 200);
      if (targetLocator) await targetLocator.pressSequentially(text, { delay });
      else await page.keyboard.type(text, { delay });
      if (input.followByEnter) {
        if (targetLocator) await targetLocator.press('Enter');
        else await page.keyboard.press('Enter');
      }
      return this.completeVerifiedAction(
        `Typed ${text.length} characters${input.followByEnter ? ' and pressed Enter' : ''}.`,
        previousGeneration,
        async () => {
          const eventsAfter = await this.readInteractionCounts();
          const valueAfter = await this.editableValue(targetLocator);
          const keyEvents = this.interactionDelta(eventsBefore, eventsAfter, 'keydown');
          const inputEvents = this.interactionDelta(eventsBefore, eventsAfter, 'input');
          const valueChanged = valueBefore !== undefined && valueAfter !== undefined && valueBefore !== valueAfter;
          const delivered = text.length > 0
            ? inputEvents > 0 || valueChanged
            : input.replace !== false ? inputEvents > 0 || valueChanged || valueBefore === '' : true;
          return {
            ok: keyEvents > 0 && delivered,
            detail: `${keyEvents} keydown and ${inputEvents} input event(s) observed; valueLength ${valueBefore?.length ?? '?'}→${valueAfter?.length ?? '?'}.`,
          };
        },
      );
    }
    if (input.action === 'press') {
      if (!input.key) return { ok: false, actual: 'Keyboard press requires key.' };
      const eventsBefore = await this.readInteractionCounts();
      const urlBefore = page.url();
      await page.keyboard.press(input.key);
      return this.completeVerifiedAction(`Pressed ${input.key}.`, previousGeneration, async () => {
        const eventsAfter = await this.readInteractionCounts();
        const keyEvents = this.interactionDelta(eventsBefore, eventsAfter, 'keydown');
        const navigated = page.url() !== urlBefore;
        return { ok: keyEvents > 0 || navigated, detail: `${keyEvents} keydown event(s) observed; navigation=${navigated}.` };
      });
    }
    const keys = (input.keys || []).map((key) => key.trim()).filter(Boolean);
    if (!keys.length) return { ok: false, actual: 'Keyboard shortcut requires a non-empty keys array.' };
    const eventsBefore = await this.readInteractionCounts();
    await page.keyboard.press(keys.join('+'));
    return this.completeVerifiedAction(`Pressed shortcut ${keys.join('+')}.`, previousGeneration, async () => {
      const eventsAfter = await this.readInteractionCounts();
      const keyEvents = this.interactionDelta(eventsBefore, eventsAfter, 'keydown');
      return { ok: keyEvents > 0, detail: `${keyEvents} keydown event(s) observed for the shortcut.` };
    });
  }

  private emptySimplifiedDomObservation(message?: string): BrowserDomObservation {
    const elements = message || '[empty DOM elements]';
    return {
      actions: elements,
      actionsCharLength: elements.length,
      elements,
      elementsCharLength: elements.length,
      text: elements,
      textCharLength: elements.length,
      tree: elements,
      treeCharLength: elements.length,
      domNodeCount: 0,
      interactiveNodeCount: 0,
      usedWorkers: false,
      errors: [],
      timings: { totalMs: 0 },
    };
  }

  private domObservationDepth(pathValue?: string, framePath?: string) {
    const depthFromPath = (value?: string) => {
      const parts = String(value || '')
        .split('.')
        .map((item) => Number(String(item).trim()))
        .filter((item) => Number.isInteger(item) && item >= 0);
      return Math.max(0, parts.length - 1);
    };
    const frameDepth = framePath ? depthFromPath(framePath) + 1 : 0;
    return Math.min(frameDepth + depthFromPath(pathValue), 24);
  }

  private domObservationIndent(pathValue?: string, framePath?: string) {
    return '  '.repeat(this.domObservationDepth(pathValue, framePath));
  }

  private async readSimplifiedDomTree(options: { scope?: 'visible' | 'full'; timings?: Record<string, number> } = {}): Promise<BrowserSimplifiedDomTreeResult> {
    const startedAt = Date.now();
    const fullScope = options.scope === 'full';
    const maxElements = fullScope
      ? numericLimitFromEnv('DOM_CUA_FULL_MAX_ELEMENTS', numericLimitFromEnv('DOM_CUA_MAX_ELEMENTS', 600))
      : numericLimitFromEnv('DOM_CUA_MAX_ELEMENTS', 200);
    const maxChars = fullScope
      ? numericLimitFromEnv('DOM_CUA_FULL_MAX_CHARS', numericLimitFromEnv('DOM_CUA_MAX_CHARS', 60000))
      : numericLimitFromEnv('DOM_CUA_MAX_CHARS', 20000);
    const addTiming = (name: string, startedAt: number) => {
      if (options.timings) options.timings[name] = (options.timings[name] || 0) + Date.now() - startedAt;
    };
    this.lastDomNodeReferences = new Map();
    const frameLimit = numericLimitFromEnv('DOM_CUA_FRAME_LIMIT', Number.MAX_SAFE_INTEGER);
    const fullFrameSnapshotsPromise = fullScope
      ? timedBrowserStep(options.timings, 'readFullFrameDomSnapshotsMs', () => this.readFullFrameDomSnapshots(maxElements, maxChars, frameLimit, options.timings))
      : undefined;
    const mainSnapshot = fullScope
      ? await timedBrowserStep(options.timings, 'readMainFullDomSnapshotMs', () => this.readFullDomSnapshot(this.activePage.mainFrame(), maxElements, maxChars))
      : await timedBrowserStep(options.timings, 'readMainVisibleDomSnapshotMs', () => this.readVisibleDomSnapshot(this.activePage.mainFrame(), maxElements, maxChars));
    if (!mainSnapshot) {
      const tree = 'DOM runtime is not available on this page. Retry after the page settles.';
      const observation = this.emptySimplifiedDomObservation(tree);
      observation.timings.totalMs = Date.now() - startedAt;
      return { tree, observation };
    }
    this.resetDomVisibleIdState(mainSnapshot.stateKey);

    const treeLines: string[] = [];
    const actionLines: string[] = [];
    const textLines: string[] = [];
    const textSeen = new Set<string>();
    let chars = 0;
    let actionChars = 0;
    let textChars = 0;
    let domNodeCount = 0;
    let interactiveNodeCount = 0;
    const actionReferenceIds = new Set<string>();
    const references: DomNodeReference[] = [];
    const appendText = (value?: string) => {
      const text = String(value || '').replace(/\s+/g, ' ').trim();
      if (!text || textSeen.has(text)) return;
      const lineChars = text.length + (textLines.length === 0 ? 0 : 1);
      if (textChars + lineChars > maxChars) return;
      textSeen.add(text);
      textLines.push(text);
      textChars += lineChars;
    };
    const actionContext = (snapshot: BrowserUseVisibleDomSnapshot, item: BrowserUseVisibleDomSnapshot['items'][number], framePath?: string, frameUrl?: string) => {
      const byPath = new Map(snapshot.items.map((entry) => [entry.path, entry]));
      const labels: string[] = [];
      if (framePath) labels.push(`iframe ${framePath}${frameUrl ? ` ${frameUrl}` : ''}`);
      const parts = item.path.split('.');
      for (let length = 1; length < parts.length; length += 1) {
        const ancestor = byPath.get(parts.slice(0, length).join('.'));
        const label = ancestor?.label?.replace(/\s+/g, ' ').trim();
        if (label && label !== item.label && !labels.includes(label)) labels.push(label);
      }
      return labels.slice(-4).join(' > ').replace(/--/g, '-');
    };
    const appendSnapshot = (
      snapshot: BrowserUseVisibleDomSnapshot,
      framePath?: string,
      frameUrl?: string,
      viewportClip?: BrowserUseViewportClip,
      options: { includeTree?: boolean; includeActions?: boolean; includeText?: boolean } = { includeTree: true, includeActions: true, includeText: true },
    ) => {
      if (options.includeTree && framePath && snapshot.items.length) {
        const frameLine = `<!-- iframe ${framePath}${frameUrl ? ` url="${frameUrl}"` : ''} -->`;
        const frameLineChars = frameLine.length + (treeLines.length === 0 ? 0 : 1);
        if (chars + frameLineChars <= maxChars) {
          treeLines.push(frameLine);
          chars += frameLineChars;
        }
      }
      for (const item of snapshot.items) {
        const publicId = this.publicDomVisibleId(snapshot.stateKey, item.ref);
        const indent = this.domObservationIndent(item.path, framePath);
        const line = `${indent}${item.line.replace(`node_id=${item.ref}`, `node_id=${publicId}`)}`;
        if (options.includeTree) {
          const lineChars = line.length + (treeLines.length === 0 ? 0 : 1);
          if (treeLines.length < maxElements && chars + lineChars <= maxChars) {
            treeLines.push(line);
            chars += lineChars;
            domNodeCount += 1;
          }
        }
        if (options.includeText) appendText(item.label);
        if (options.includeActions && item.interactive) {
          const context = actionContext(snapshot, item, framePath, frameUrl);
          const actionLine = context ? `${line} <!-- context: ${context} -->` : line;
          const actionLineChars = actionLine.length + (actionLines.length === 0 ? 0 : 1);
          if (actionChars + actionLineChars <= maxChars && actionLines.length < maxElements) {
            actionLines.push(actionLine);
            actionChars += actionLineChars;
          }
          if (!actionReferenceIds.has(publicId)) {
            actionReferenceIds.add(publicId);
            interactiveNodeCount += 1;
          }
        }
        references.push({
          id: publicId,
          interactive: item.interactive,
          label: item.label,
          line,
          localRef: item.ref,
          path: item.path,
          framePath,
          frameUrl,
          descriptor: item.descriptor,
          state: item.state,
          tag: item.tag,
          viewportClip,
        });
      }
    };

    const appendMainStartedAt = Date.now();
    appendSnapshot(mainSnapshot, undefined, undefined, undefined, { includeTree: true, includeActions: !fullScope, includeText: true });
    addTiming('appendMainDomSnapshotMs', appendMainStartedAt);
    const frameSnapshots = fullScope
      ? await fullFrameSnapshotsPromise || []
      : await timedBrowserStep(options.timings, 'readVisibleFrameDomSnapshotsMs', () => this.readVisibleFrameDomSnapshots(mainSnapshot.viewport, maxElements, maxChars, frameLimit, options.timings));
    const appendFramesStartedAt = Date.now();
    for (const frameSnapshot of frameSnapshots) {
      appendSnapshot(frameSnapshot.snapshot, frameSnapshot.framePath, frameSnapshot.frameUrl, frameSnapshot.viewportClip, { includeTree: true, includeActions: !fullScope, includeText: true });
    }
    addTiming('appendFrameDomSnapshotsMs', appendFramesStartedAt);
    if (fullScope) {
      const appendActionsStartedAt = Date.now();
      const mainActionSnapshot = await timedBrowserStep(options.timings, 'readMainActionDomSnapshotMs', () => this.readVisibleDomSnapshot(this.activePage.mainFrame(), maxElements, maxChars, undefined, true));
      if (mainActionSnapshot) appendSnapshot(mainActionSnapshot, undefined, undefined, undefined, { includeTree: false, includeActions: true, includeText: true });
      const actionFrameSnapshots = mainActionSnapshot
        ? await timedBrowserStep(options.timings, 'readActionFrameDomSnapshotsMs', () => this.readVisibleFrameDomSnapshots(mainActionSnapshot.viewport, maxElements, maxChars, frameLimit, options.timings, true))
        : [];
      for (const frameSnapshot of actionFrameSnapshots) {
        appendSnapshot(frameSnapshot.snapshot, frameSnapshot.framePath, frameSnapshot.frameUrl, frameSnapshot.viewportClip, { includeTree: false, includeActions: true, includeText: true });
      }
      addTiming('appendActionDomSnapshotMs', appendActionsStartedAt);
    }

    const referenceMapStartedAt = Date.now();
    this.lastDomNodeReferences = new Map(references.map((reference) => [reference.id, reference]));
    addTiming('buildDomNodeReferenceMapMs', referenceMapStartedAt);
    const tree = treeLines.join('\n') || (fullScope ? '[empty full DOM snapshot]' : '[empty visible DOM snapshot]');
    const actions = actionLines.join('\n') || '[no visible actionable elements]';
    const text = textLines.join('\n') || '[no visible page text]';
    const elements = tree;
    return {
      tree,
      observation: {
        actions,
        actionsCharLength: actions.length,
        elements,
        elementsCharLength: elements.length,
        text,
        textCharLength: text.length,
        tree,
        treeCharLength: tree.length,
        domNodeCount,
        interactiveNodeCount,
        usedWorkers: false,
        errors: [],
        timings: { totalMs: Date.now() - startedAt },
      },
    };
  }

  private async snapshotFrameTargets() {
    const mainFrame = this.activePage.mainFrame();
    const iframeTargets = this.activePage.frames()
      .filter((frame) => frame !== mainFrame)
      .map((frame) => ({ frame, framePath: this.getFramePath(frame) }))
      .filter((target): target is { frame: Frame; framePath: string } => target.framePath !== undefined)
      .sort((left, right) => this.comparePathString(left.framePath, right.framePath));
    const displayNoneFramePaths = new Set<string>();
    const targets: Array<{ frame: Frame; framePath?: string; frameUrl?: string }> = [
      { frame: mainFrame, frameUrl: mainFrame.url() || undefined },
    ];

    for (const target of iframeTargets) {
      const separator = target.framePath.lastIndexOf('.');
      const parentFramePath = separator >= 0 ? target.framePath.slice(0, separator) : undefined;
      if (parentFramePath && displayNoneFramePaths.has(parentFramePath)) {
        displayNoneFramePaths.add(target.framePath);
        continue;
      }
      if (await this.frameElementIsInsideDisplayNoneSubtree(target.frame)) {
        displayNoneFramePaths.add(target.framePath);
        continue;
      }
      targets.push({
        frame: target.frame,
        framePath: target.framePath,
        frameUrl: target.frame.url() || undefined,
      });
    }
    return targets;
  }

  private async frameElementIsInsideDisplayNoneSubtree(frame: Frame) {
    const handle = await frame.frameElement().catch(() => undefined);
    if (!handle) return true;
    try {
      return await handle.evaluate((frameElement) => {
        let current: Element | null = frameElement as Element;
        while (current) {
          if (window.getComputedStyle(current).display === 'none') return true;
          const root = current.getRootNode();
          current = current.parentElement || (root instanceof ShadowRoot ? root.host : null);
        }
        return false;
      });
    } catch {
      return true;
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }

  private resetDomVisibleIdState(mainSnapshotKey: string, force = false) {
    if (!force && this.domVisibleSnapshotKey === mainSnapshotKey) return;
    this.domVisibleSnapshotKey = mainSnapshotKey;
    this.domVisiblePublicIdByFrameLocalRef.clear();
    this.domVisibleNextPublicId = 1;
  }

  private publicDomVisibleId(stateKey: string, localRef: string) {
    const key = `${stateKey}:${localRef}`;
    let id = this.domVisiblePublicIdByFrameLocalRef.get(key);
    if (!id) {
      id = String(this.domVisibleNextPublicId++);
      this.domVisiblePublicIdByFrameLocalRef.set(key, id);
    }
    return id;
  }

  private intersectViewportClip(left: BrowserUseViewportClip, right: BrowserUseViewportClip) {
    const clip = {
      bottom: Math.min(left.bottom, right.bottom),
      left: Math.max(left.left, right.left),
      right: Math.min(left.right, right.right),
      top: Math.max(left.top, right.top),
    };
    return clip.right > clip.left && clip.bottom > clip.top ? clip : undefined;
  }

  private async readRawDomTree() {
    const frameLimit = numericLimitFromEnv('DOM_RAW_FRAME_LIMIT', numericLimitFromEnv('DOM_CUA_FRAME_LIMIT', Number.MAX_SAFE_INTEGER));
    const mainFrame = this.activePage.mainFrame();
    const frames = [mainFrame, ...this.activePage.frames().filter((frame) => frame !== mainFrame).slice(0, frameLimit)];
    const parts: string[] = [];

    for (const frame of frames) {
      const framePath = frame === mainFrame ? undefined : this.getFramePath(frame);
      if (frame !== mainFrame && framePath === undefined) continue;
      const raw = await this.readFrameRawDom(frame).catch(() => undefined);
      if (!raw) continue;
      if (framePath) {
        parts.push(`<!-- iframe ${framePath}${frame.url() ? ` url="${frame.url().replace(/--/g, '-')}"` : ''} -->\n${raw}`);
      } else {
        parts.push(raw);
      }
    }

    return parts.join('\n\n') || '[empty raw DOM]';
  }

  private async readFrameRawDom(target: Page | Frame) {
    return target.evaluate(() => {
      const agentOverlaySelector = '#__ai_candidate_overlay__, #__ai_last_click_marker__, #__ai_dom_export_control__';
      const voidTags = new Set([
        'area',
        'base',
        'br',
        'col',
        'embed',
        'hr',
        'img',
        'input',
        'link',
        'meta',
        'param',
        'source',
        'track',
        'wbr',
      ]);
      const rawTextTags = new Set(['script', 'style']);
      const escapeText = (value: string) => value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
      const escapeAttribute = (value: string) => escapeText(value).replaceAll('"', '&quot;');

      const serializeNode = (node: Node, parentTag = ''): string => {
        if (node.nodeType === Node.DOCUMENT_TYPE_NODE) {
          const docType = node as DocumentType;
          const publicId = docType.publicId ? ` PUBLIC "${escapeAttribute(docType.publicId)}"` : '';
          const systemId = docType.systemId ? `${publicId ? '' : ' SYSTEM'} "${escapeAttribute(docType.systemId)}"` : '';
          return `<!DOCTYPE ${docType.name}${publicId}${systemId}>`;
        }
        if (node.nodeType === Node.TEXT_NODE) {
          const value = node.nodeValue || '';
          return rawTextTags.has(parentTag) ? value : escapeText(value);
        }
        if (node.nodeType === Node.COMMENT_NODE) {
          return `<!--${(node.nodeValue || '').replace(/--/g, '-')}-->`;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return '';

        const element = node as Element;
        if (element.closest(agentOverlaySelector)) return '';

        const tag = element.tagName.toLowerCase();
        const attributes = Array.from(element.attributes)
          .map((attribute) => `${attribute.name}="${escapeAttribute(attribute.value)}"`)
          .join(' ');
        const openTag = attributes ? `<${tag} ${attributes}>` : `<${tag}>`;
        if (voidTags.has(tag)) return openTag;

        const shadowRoot = element.shadowRoot;
        const shadowDom = shadowRoot
          ? `<template shadowrootmode="${shadowRoot.mode}">${Array.from(shadowRoot.childNodes).map((child) => serializeNode(child, tag)).join('')}</template>`
          : '';
        const children = Array.from(element.childNodes).map((child) => serializeNode(child, tag)).join('');
        return `${openTag}${shadowDom}${children}</${tag}>`;
      };

      return [
        document.doctype ? serializeNode(document.doctype) : '',
        document.documentElement ? serializeNode(document.documentElement) : '',
      ].filter(Boolean).join('\n');
    });
  }

  private async readVisibleDomSnapshot(
    target: Page | Frame,
    maxElements: number,
    maxChars: number,
    viewportClip?: BrowserUseViewportClip,
    preserveExistingRefs = false,
  ) {
    await this.ensureBrowserPageRuntime(target);
    return target.evaluate((input) => {
      const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime!;
      return runtime?.visibleDomSnapshot(input);
    }, { maxChars, maxElements, preserveExistingRefs, viewportClip }).catch(() => undefined);
  }

  private async readFullDomSnapshot(
    target: Page | Frame,
    maxElements: number,
    maxChars: number,
    preserveExistingRefs = false,
  ) {
    await this.ensureBrowserPageRuntime(target);
    return target.evaluate((input) => {
      const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime!;
      return runtime?.fullDomSnapshot(input);
    }, { maxChars, maxElements, preserveExistingRefs }).catch(() => undefined);
  }

  private async readFullFrameDomSnapshots(
    maxElements: number,
    maxChars: number,
    frameLimit: number,
    timings?: Record<string, number>,
    preserveExistingRefs = false,
  ): Promise<Array<{
    framePath: string;
    frameUrl?: string;
    snapshot: BrowserUseVisibleDomSnapshot;
    viewportClip?: BrowserUseViewportClip;
  }>> {
    const frames = this.activePage.frames().filter((frame) => frame !== this.activePage.mainFrame());
    type FullFrameSnapshot = {
      framePath: string;
      frameUrl?: string;
      snapshot: BrowserUseVisibleDomSnapshot;
      viewportClip?: BrowserUseViewportClip;
    };

    const snapshots = await Promise.all(frames.slice(0, frameLimit).map(async (frame): Promise<FullFrameSnapshot | undefined> => {
      const framePath = this.getFramePath(frame);
      if (framePath === undefined) return undefined;
      const snapshot = await timedBrowserStep(timings, 'readFrameFullDomSnapshotMs', () => this.readFullDomSnapshot(frame, maxElements, maxChars, preserveExistingRefs));
      if (!snapshot) return undefined;
      return {
        framePath,
        frameUrl: frame.url() || undefined,
        snapshot,
      };
    }));
    return snapshots.filter((snapshot): snapshot is FullFrameSnapshot => Boolean(snapshot));
  }

  private async readVisibleFrameDomSnapshots(
    topViewport: BrowserUseViewportClip,
    maxElements: number,
    maxChars: number,
    frameLimit: number,
    timings?: Record<string, number>,
    preserveExistingRefs = false,
  ): Promise<Array<{
    framePath: string;
    frameUrl?: string;
    snapshot: BrowserUseVisibleDomSnapshot;
    viewportClip: BrowserUseViewportClip;
  }>> {
    const frames = this.activePage.frames().filter((frame) => frame !== this.activePage.mainFrame());
    type VisibleFrameSnapshot = {
      framePath: string;
      frameUrl?: string;
      snapshot: BrowserUseVisibleDomSnapshot;
      viewportClip: BrowserUseViewportClip;
    };

    const snapshots = await Promise.all(frames.slice(0, frameLimit).map(async (frame): Promise<VisibleFrameSnapshot | undefined> => {
      const framePath = this.getFramePath(frame);
      if (framePath === undefined) return undefined;
      const box = await timedBrowserStep(timings, 'getVisibleFrameBoxMs', () => frame.frameElement().then((handle) => handle.boundingBox()).catch(() => undefined));
      if (!box || box.width <= 0 || box.height <= 0) return undefined;
      const frameRect = {
        bottom: box.y + box.height,
        left: box.x,
        right: box.x + box.width,
        top: box.y,
      };
      const visibleFrameRect = this.intersectViewportClip(topViewport, frameRect);
      if (!visibleFrameRect) return undefined;
      const viewportClip = {
        bottom: visibleFrameRect.bottom - box.y,
        left: visibleFrameRect.left - box.x,
        right: visibleFrameRect.right - box.x,
        top: visibleFrameRect.top - box.y,
      };
      const snapshot = await timedBrowserStep(timings, 'readFrameVisibleDomSnapshotMs', () => this.readVisibleDomSnapshot(frame, maxElements, maxChars, viewportClip, preserveExistingRefs));
      if (!snapshot) return undefined;
      return {
        framePath,
        frameUrl: frame.url() || undefined,
        snapshot,
        viewportClip,
      };
    }));
    return snapshots.filter((snapshot): snapshot is VisibleFrameSnapshot => Boolean(snapshot));
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

  private async drawCandidateOverlay(candidates: InteractiveCandidate[], markersOnly = false, scrollAreas: ScrollableArea[] = []) {
    const visible = candidates;
    const visibleScrollAreas = scrollAreas.slice(0, Math.max(1, Number(process.env.SCREENSHOT_SCROLL_AREA_LABEL_LIMIT || 12)));
    await this.activePage.evaluate(({ items, scrollAreas: areas, markersOnly: hidePageContent }) => {
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
      type LeaderBox = LabelBox & { segment: Leader };
      type LabelLayout = LabelBox & {
        external: boolean;
        compact: boolean;
        leader?: Leader;
      };
      const placedLabels: LabelBox[] = [];
      const placedLeaders: Leader[] = [];
      const fragment = document.createDocumentFragment();
      const spatialCellSize = Math.max(48, Math.min(128, Math.round(Math.max(window.innerWidth, window.innerHeight) / 14)));
      function cellsFor(box: LabelBox) {
        const keys: string[] = [];
        const left = Math.floor(box.left / spatialCellSize);
        const right = Math.floor(Math.max(box.left, box.right) / spatialCellSize);
        const top = Math.floor(box.top / spatialCellSize);
        const bottom = Math.floor(Math.max(box.top, box.bottom) / spatialCellSize);
        for (let y = top; y <= bottom; y += 1) {
          for (let x = left; x <= right; x += 1) {
            keys.push(`${x}:${y}`);
          }
        }
        return keys;
      }
      function createSpatialIndex<T extends LabelBox>() {
        const map = new Map<string, T[]>();
        return {
          add(item: T) {
            for (const key of cellsFor(item)) {
              const bucket = map.get(key);
              if (bucket) bucket.push(item);
              else map.set(key, [item]);
            }
          },
          nearby(box: LabelBox) {
            const seen = new Set<T>();
            const results: T[] = [];
            for (const key of cellsFor(box)) {
              for (const item of map.get(key) || []) {
                if (seen.has(item)) continue;
                seen.add(item);
                results.push(item);
              }
            }
            return results;
          },
        };
      }
      const placedLabelIndex = createSpatialIndex<LabelBox>();
      const placedLeaderIndex = createSpatialIndex<LeaderBox>();
      const targetBoxIndex = createSpatialIndex<TargetBox>();
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
      for (const target of targetBoxes) targetBoxIndex.add(target);
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
      function leaderBounds(leader: Leader, padding = 0): LeaderBox {
        return {
          left: Math.min(leader.start.x, leader.end.x) - padding,
          top: Math.min(leader.start.y, leader.end.y) - padding,
          right: Math.max(leader.start.x, leader.end.x) + padding,
          bottom: Math.max(leader.start.y, leader.end.y) + padding,
          segment: leader,
        };
      }
      function placeLabel(box: LabelBox) {
        placedLabels.push(box);
        placedLabelIndex.add(box);
      }
      function placeLeader(leader: Leader) {
        placedLeaders.push(leader);
        placedLeaderIndex.add(leaderBounds(leader, 2));
      }
      function clamp(value: number, min: number, max: number) {
        return Math.max(min, Math.min(max, value));
      }
      function pointInside(box: LabelBox, point: Point) {
        return point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
      }
      function drawScrollArea(area: {
        id: string;
        rect: { x: number; y: number; width: number; height: number };
        scroll: { canScrollUp: boolean; canScrollDown: boolean; canScrollLeft: boolean; canScrollRight: boolean };
      }) {
        if (!area.rect || area.rect.width <= 0 || area.rect.height <= 0) return;
        const color = '#059669';
        const boxLeft = clamp(area.rect.x, 1, Math.max(1, window.innerWidth - 2));
        const boxTop = clamp(area.rect.y, 1, Math.max(1, window.innerHeight - 2));
        const boxWidth = Math.max(1, Math.min(area.rect.width, window.innerWidth - boxLeft - 1));
        const boxHeight = Math.max(1, Math.min(area.rect.height, window.innerHeight - boxTop - 1));
        const box = document.createElement('div');
        Object.assign(box.style, {
          position: 'absolute',
          left: `${boxLeft}px`,
          top: `${boxTop}px`,
          width: `${boxWidth}px`,
          height: `${boxHeight}px`,
          border: `3px dashed ${color}`,
          borderRadius: '4px',
          boxSizing: 'border-box',
          background: 'transparent',
          pointerEvents: 'none',
        });
        const label = document.createElement('div');
        const directions = [
          area.scroll.canScrollUp ? '↑' : '',
          area.scroll.canScrollDown ? '↓' : '',
          area.scroll.canScrollLeft ? '←' : '',
          area.scroll.canScrollRight ? '→' : '',
        ].filter(Boolean).join('');
        label.textContent = `${area.id}${directions ? ` ${directions}` : ''}`;
        Object.assign(label.style, {
          position: 'absolute',
          left: `${clamp(boxLeft + 4, 1, Math.max(1, window.innerWidth - 90))}px`,
          top: `${clamp(boxTop + 4, 1, Math.max(1, window.innerHeight - 20))}px`,
          minWidth: '26px',
          height: '22px',
          padding: '0 6px',
          borderRadius: '4px',
          background: color,
          color: '#fff',
          border: '1px solid #fff',
          boxSizing: 'border-box',
          font: '900 13px/20px Arial, sans-serif',
          textAlign: 'center',
          boxShadow: '0 2px 6px rgba(0,0,0,0.28)',
          pointerEvents: 'none',
        });
        fragment.appendChild(box);
        fragment.appendChild(label);
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
        if (placedLabelIndex.nearby(padded).some((placed) => overlaps(padded, expanded(placed, 1)))) return false;
        if (placedLeaderIndex.nearby(padded).some((leader) => segmentIntersectsBox(leader.segment, padded))) return false;
        if (
          avoidTargets &&
          targetBoxIndex.nearby(padded).some(
            (target) => target.index !== currentTargetIndex && overlaps(padded, expanded(target, 1)),
          )
        ) return false;
        return true;
      }
      function canPlaceExternal(box: LabelBox, leader: Leader, currentTargetIndex: number) {
        if (!canPlaceLabel(box, true, currentTargetIndex)) return false;
        const leaderBox = leaderBounds(leader, 2);
        if (
          targetBoxIndex.nearby(leaderBox).some(
            (target) => target.index !== currentTargetIndex && segmentIntersectsBox(leader, target, 1),
          )
        ) return false;
        if (placedLabelIndex.nearby(leaderBox).some((placed) => segmentIntersectsBox(leader, placed, 1))) return false;
        if (placedLeaderIndex.nearby(leaderBox).some((placed) => segmentsIntersect(leader, placed.segment))) return false;
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
        for (const target of targetBoxIndex.nearby(expanded(current, 6))) {
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
              placeLabel(box);
              placeLeader(leader);
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
              placeLabel(box);
              placeLeader(leader);
              return { ...box, external: true, compact: false, leader };
            }
            if (!canPlaceLabel(box, false, currentTargetIndex)) continue;
            placeLabel(box);
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
            placeLabel(box);
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
        placeLabel(finalBox);
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
      fragment.appendChild(svg);

      for (const area of areas) {
        drawScrollArea(area);
      }

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
          border: `2px solid ${color}`,
          borderRadius: '3px',
          boxSizing: 'border-box',
          background: 'transparent',
          boxShadow: 'none',
        });

        const label = document.createElement('div');
        label.textContent = item.id;
        const denseSmall = isDenseSmallTarget(rect);
        // 标签只保留白字和黑色描边阴影，尽量减少对页面文字的遮挡。
        const normalLabelWidth = Math.max(16, item.id.length * 9 + 4);
        const normalLabelHeight = 16;
        const compactLabelWidth = Math.max(9, Math.min(normalLabelWidth, item.id.length * 5 + 3, Math.max(9, rect.width - 1)));
        const compactLabelHeight = Math.max(9, Math.min(11, Math.max(9, rect.height - 1)));
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
          drawLeader(labelBox.leader, color, 2);
        }
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
          border: '0',
          borderRadius: '0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          font: labelBox.compact
            ? `900 ${item.id.length >= 3 ? 8 : 9}px/${labelHeight}px Arial, sans-serif`
            : `900 14px/${labelHeight}px Arial, sans-serif`,
          letterSpacing: '0',
          textAlign: 'center',
          boxShadow: 'none',
          WebkitTextStroke: '2px rgba(0,0,0,0.9)',
          paintOrder: 'stroke fill',
          textShadow: [
            '0 1px 2px rgba(0,0,0,0.95)',
            '1px 0 2px rgba(0,0,0,0.95)',
            '-1px 0 2px rgba(0,0,0,0.95)',
            '0 -1px 2px rgba(0,0,0,0.95)',
          ].join(', '),
        });

        fragment.appendChild(box);
        fragment.appendChild(label);
      }

      overlay.appendChild(fragment);
      document.documentElement.appendChild(overlay);
    }, { items: visible, scrollAreas: visibleScrollAreas, markersOnly }).catch(() => undefined);
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

  // 在页面上留下上一次鼠标动作的位置。下一轮截图会看到这个鼠标指针，
  // 便于人工和模型理解刚才点在哪里；扫描候选元素时会主动忽略它。
  private async showClickMarker(x: number, y: number, kind: string) {
    await this.activePage.evaluate(({ x: markerX, y: markerY, kind: markerKind }) => {
      const previous = document.getElementById('__ai_last_click_marker__');
      previous?.remove();
      const marker = document.createElement('div');
      marker.id = '__ai_last_click_marker__';
      marker.setAttribute('aria-hidden', 'true');
      const badgeText = markerKind === 'double' ? '2x' : markerKind === 'right' ? 'R' : markerKind === 'drag' ? 'D' : '';
      const cursorSvg = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="29" viewBox="0 0 32 42">',
        '<path d="M4 3v28.5l7.3-6.9 4.7 12.2 5.6-2.2-4.8-11.8h10.6L4 3z" fill="white" stroke="#111827" stroke-width="2.2" stroke-linejoin="round"/>',
        '<path d="M11.2 24.6 16 36.8" stroke="rgba(255,255,255,.65)" stroke-width="1.1"/>',
        '</svg>',
      ].join('');
      const cursor = document.createElement('div');
      Object.assign(cursor.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        width: '22px',
        height: '29px',
        backgroundImage: `url("data:image/svg+xml,${encodeURIComponent(cursorSvg)}")`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: '22px 29px',
        filter: 'drop-shadow(0 3px 5px rgba(0, 0, 0, 0.38))',
      });
      marker.appendChild(cursor);
      if (badgeText) {
        const badge = document.createElement('div');
        badge.textContent = badgeText;
        Object.assign(badge.style, {
          position: 'absolute',
          left: '12px',
          top: '14px',
          minWidth: '13px',
          height: '13px',
          padding: '0 2px',
          borderRadius: '999px',
          background: '#2563eb',
          color: '#fff',
          border: '1px solid #fff',
          boxSizing: 'border-box',
          font: '900 8px/11px Arial, sans-serif',
          textAlign: 'center',
          boxShadow: '0 1px 4px rgba(0,0,0,0.28)',
        });
        marker.appendChild(badge);
      }
      Object.assign(marker.style, {
        position: 'fixed',
        left: `${markerX}px`,
        top: `${markerY}px`,
        width: '30px',
        height: '34px',
        marginLeft: '-1px',
        marginTop: '-1px',
        pointerEvents: 'none',
        zIndex: '2147483647',
      });
      document.documentElement.appendChild(marker);
    }, { x, y, kind }).catch(() => undefined);
  }
}
