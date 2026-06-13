import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Browser, BrowserContext, BrowserContextOptions, BrowserType, Frame, LaunchOptions, Page, Request, Worker as PlaywrightWorker } from 'playwright';
import { normalizeDomNodeIdString, normalizeDomPathString } from '@/lib/dom-path';
import { appDataRoot, artifactPath } from '@/server/storage/paths';

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

function shouldUseSeparateMarkerMap() {
  return process.env.VISUAL_MARKER_SEPARATE_MAP === 'true';
}

export type BrowserSessionMode = 'dom' | 'visual-markers';

export type BrowserSessionOptions = {
  isMarked?: boolean;
  runId?: string;
  tabGroupTitle?: string;
  preferExistingPage?: boolean;
};

/**
 * 浏览器请求鉴定模式
 * @returns 鉴定模式
 */
function browserSessionModeFromEnv(): BrowserSessionMode {
  const raw = process.env.AI_BROWSER_MODE;
  if (/^(dom|text|html)$/i.test(String(raw || ''))) return 'dom';
  if (/^(true|1|yes|visual|vision|click|visual-markers)$/i.test(String(raw || ''))) return 'visual-markers';
  return 'visual-markers';
}

export type BrowserActionResult = {
  ok: boolean;
  actual: string;
};

type BrowserBatchFillAction = {
  id: string;
  text?: string;
  clear?: boolean;
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
  capture: ScreenshotCaptureMode;
};

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

type TextLocatorCandidate = {
  locatorId: string;
  matchedText: string;
  score: number;
  candidate: InteractiveCandidate;
};

type DomNodeReference = {
  id: string;
  localRef?: string;
  path: string;
  framePath?: string;
  frameUrl?: string;
  descriptor: string;
  viewportClip?: BrowserUseViewportClip;
};

type PageInteractiveCandidate = Omit<InteractiveCandidate, 'framePath' | 'frameUrl'>;

type CandidateIdentityPayload = Pick<
  InteractiveCandidate,
  'tag' | 'role' | 'type' | 'href' | 'ariaLabel' | 'placeholder' | 'title' | 'text' | 'name'
>;

type CandidateIdentityValidation = {
  ok: boolean;
  reason: string;
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

type BrowserUseVisibleDomSnapshot = {
  frameElements: Array<{
    rect: BrowserUseViewportClip;
    ref: string;
    size?: { height: number; width: number };
    url?: string;
  }>;
  items: Array<{
    descriptor: string;
    line: string;
    path: string;
    ref: string;
  }>;
  stateKey: string;
  viewport: BrowserUseViewportClip;
};

type AiDomRuntime = {
  version: number;
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
    viewportClip?: BrowserUseViewportClip;
  }) => BrowserUseVisibleDomSnapshot;
  fullDomSnapshot: (options: {
    maxChars: number;
    maxElements: number;
  }) => BrowserUseVisibleDomSnapshot;
  pageText: (options: {
    maxChars: number;
  }) => { text: string; textLength: number };
  elementText: (pathValue: string, options?: { maxChars?: number }) => ({ descriptor: string; text: string; textLength: number } | undefined);
  visibleDomPoint: (
    ref: string,
    viewportClip?: BrowserUseViewportClip,
  ) => ({ x: number; y: number; descriptor: string } | undefined);
  visibleDomText: (ref: string, options?: { maxChars?: number }) => ({ descriptor: string; text: string; textLength: number } | undefined);
};

type WindowWithAiDomRuntime = Window & {
  __aiBrowserPageRuntimeInstalled?: boolean;
  __aiGetEventListenerTypes?: (target: EventTarget) => string[];
  __aiDomRuntime?: AiDomRuntime;
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

function numericLimitFromEnv(name: string, fallback: number) {
  const raw = String(process.env[name] || '').trim();
  if (/^(0|false|none|off|unlimited)$/i.test(raw)) return Number.MAX_SAFE_INTEGER;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

type BrowserOwnership = 'launched' | 'connected' | 'persistent' | 'shared';
type SharedBrowserOwnership = Exclude<BrowserOwnership, 'shared'>;

export type BrowserTabSnapshot = {
  index: number;
  url: string;
  active: boolean;
  groupId: string;
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

function sharedBrowserTabsEnabled() {
  return process.env.BROWSER_SHARED_TABS !== 'false';
}

function nativeBrowserTabGroupsEnabled(headless: boolean) {
  return !headless && process.env.BROWSER_NATIVE_TAB_GROUPS !== 'false';
}

function browserTabTitlePrefixEnabled() {
  return process.env.BROWSER_TAB_TITLE_PREFIX === 'true';
}

function sessionTabGrouperExtensionPath() {
  return path.join(process.cwd(), 'src', 'server', 'browser', 'session-tab-grouper-extension');
}

function sessionTabGrouperEnabled(headless: boolean) {
  const extensionPath = sessionTabGrouperExtensionPath();
  return nativeBrowserTabGroupsEnabled(headless) && existsSync(path.join(extensionPath, 'manifest.json'));
}

function withSessionTabGrouperArgs(args: string[], headless: boolean, options: { exclusive?: boolean } = {}) {
  if (!sessionTabGrouperEnabled(headless)) return args;
  const extensionPath = sessionTabGrouperExtensionPath();
  return [
    ...args,
    ...(options.exclusive ? [`--disable-extensions-except=${extensionPath}`] : []),
    `--load-extension=${extensionPath}`,
  ];
}

function normalizePageGroupId(value?: string) {
  const normalized = (value || 'browser-session')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96);
  return normalized || 'browser-session';
}

function sessionTabGrouperProfileDir(profileKey: string) {
  return path.join(appDataRoot(), '.data', 'browser-profiles', 'tab-groups', normalizePageGroupId(profileKey));
}

function sessionTabGrouperDebugPort(profileKey: string) {
  const configured = Number(process.env.BROWSER_TAB_GROUP_CDP_PORT || '');
  if (Number.isInteger(configured) && configured > 0 && configured < 65536) return configured;
  const key = normalizePageGroupId(profileKey);
  let hash = 0;
  for (const char of key) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
  return 24000 + (hash % 10000);
}

function cdpEndpointForPort(port?: number) {
  return port ? `http://127.0.0.1:${port}` : '';
}

function cdpPortFromEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBlankPage(page: Page) {
  const url = page.url();
  return isBlankBrowserUrlLike(url);
}

function isBlankBrowserUrlLike(url: string) {
  return !url || url === 'about:blank' || /^(about:newtab|chrome:\/\/new-tab-page|edge:\/\/newtab)/i.test(url);
}

function normalizeTabGroupTitle(value?: string) {
  const normalized = (value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 42);
  return normalized || '浏览器会话';
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

  if (win.__aiDomRuntime?.version === 4) return;

  const skippedTags = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'head', 'br', 'hr', 'wbr']);
  const actionableTags = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'option', 'label', 'details']);
  const actionableRoles = new Set(['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'checkbox', 'radio', 'switch', 'option']);

  const normalize = (value?: string | null) => String(value || '').replace(/\s+/g, ' ').trim();

  function isOverlay(element: Element) {
    return Boolean(element.closest('#__ai_candidate_overlay__, #__ai_last_click_marker__'));
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

  function children(element: Element) {
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

  function isContentEditableOwner(element: Element) {
    const value = element.getAttribute('contenteditable');
    return value !== null && value.toLowerCase() !== 'false';
  }

  function isActionable(element: Element) {
    const tag = element.tagName.toLowerCase();
    if (actionableTags.has(tag)) return true;
    const role = element.getAttribute('role');
    if (role && actionableRoles.has(role)) return true;
    if (element.hasAttribute('aria-haspopup')) return true;
    if (element.hasAttribute('onclick') || hasActionAttribute(element)) return true;
    if (recordedEventTypes(element).some((type) => /^(click|dblclick|mousedown|mouseup|pointerdown|pointerup|touchstart|keydown|mouseenter|mouseover|pointerenter|pointerover)$/.test(type))) return true;
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
      const top = stack.find((item) => item && isRenderable(item, options));
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

  const visibleDomInteractiveTags = new Set(['a', 'button', 'details', 'input', 'option', 'select', 'summary', 'textarea']);
  const visibleDomInteractiveRoles = new Set(['button', 'checkbox', 'combobox', 'link', 'menuitem', 'option', 'radio', 'slider', 'spinbutton', 'switch', 'tab', 'textbox']);
  const visibleDomRenderedAttributes = ['aria-disabled', 'aria-label', 'contenteditable', 'href', 'name', 'placeholder', 'role', 'title', 'type', 'value'];
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

  function isVisibleDomInteractive(element: Element) {
    if (isVisibleDomSubtreeHidden(element) || !hasVisibleDomPointerEvents(element)) return false;
    const tag = visibleDomElementName(element);
    const contentEditable = element.getAttribute('contenteditable');
    const role = element.getAttribute('role');
    return visibleDomInteractiveTags.has(tag)
      || (contentEditable !== null && contentEditable.toLowerCase() !== 'false')
      || element.hasAttribute('href')
      || element.hasAttribute('onclick')
      || (role !== null && visibleDomInteractiveRoles.has(role.trim().toLowerCase()))
      || Number(element.getAttribute('tabindex') ?? -1) >= 0;
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

  function visibleDomTextContent(element: Element) {
    const parts: string[] = [];
    let chars = 0;
    const visit = (node: Node) => {
      if (chars >= 160) return;
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
        if (chars >= 160) break;
        visit(child);
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        if (isVisibleDomSubtreeHidden(element)) return;
        const root = shadowRootOf(element);
        if (!root) return;
        for (const child of Array.from(root.childNodes)) {
          if (chars >= 160) break;
          visit(child);
        }
      }
    };
    visit(element);
    return normalizeVisibleDomText(parts.join(' ')).slice(0, 160);
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

  function visibleDomLine(element: Element, ref: string) {
    const attrs = [`node_id=${ref}`];
    for (const name of visibleDomRenderedAttributes) {
      const value = element.getAttribute(name);
      if (value !== null && value !== '') attrs.push(`${name}="${escapeVisibleDomText(value)}"`);
    }
    for (const name of visibleDomBooleanAttributes) {
      if (element.hasAttribute(name)) attrs.push(`${name}="true"`);
    }
    const tag = visibleDomElementName(element);
    const text = visibleDomTextContent(element);
    return text.length === 0
      ? `<${tag} ${attrs.join(' ')} />`
      : `<${tag} ${attrs.join(' ')}>${escapeVisibleDomText(text)}</${tag}>`;
  }

  function visibleDomSnapshot(options: { maxChars: number; maxElements: number; viewportClip?: BrowserUseViewportClip }) {
    const state = visibleDomState();
    state.refToElement.clear();

    const rawViewport = visualViewportRect();
    const viewportClip = options.viewportClip ? intersectClip(rawViewport, options.viewportClip) || rawViewport : rawViewport;
    const maxElements = Math.max(1, Math.floor(Number(options.maxElements) || 200));
    const maxChars = Math.max(1, Math.floor(Number(options.maxChars) || 20000));
    const frameElements: BrowserUseVisibleDomSnapshot['frameElements'] = [];
    const items: BrowserUseVisibleDomSnapshot['items'] = [];
    let chars = 0;
    let truncated = false;

    const stop = () => truncated || items.length >= maxElements || chars >= maxChars;
    const pushItem = (element: Element) => {
      if (stop()) return;
      const ref = visibleDomRef(element);
      const line = visibleDomLine(element, ref);
      const lineChars = line.length + (items.length === 0 ? 0 : 1);
      if (chars + lineChars > maxChars) {
        truncated = true;
        return;
      }
      state.refToElement.set(ref, element);
      items.push({
        descriptor: descriptor(element),
        line,
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
      if (isVisibleDomSubtreeHidden(element)) return;
      const tag = visibleDomElementName(element);
      if (tag === 'frame' || tag === 'iframe') pushFrame(element);
      if (isVisibleDomInteractive(element) && visibleDomRect(element, viewportClip)) pushItem(element);
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

  function fullDomSnapshot(options: { maxChars: number; maxElements: number }) {
    const state = visibleDomState();
    state.refToElement.clear();

    const viewport = visualViewportRect();
    const maxElements = Math.max(1, Math.floor(Number(options.maxElements) || 500));
    const maxChars = Math.max(1, Math.floor(Number(options.maxChars) || 60000));
    const frameElements: BrowserUseVisibleDomSnapshot['frameElements'] = [];
    const items: BrowserUseVisibleDomSnapshot['items'] = [];
    let chars = 0;
    let truncated = false;

    const structuralTextTags = new Set([
      'a', 'button', 'dd', 'details', 'dt', 'figcaption', 'input', 'label', 'legend', 'li',
      'option', 'p', 'select', 'summary', 'td', 'textarea', 'th',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    ]);
    const directTextContainerTags = new Set(['article', 'aside', 'div', 'fieldset', 'footer', 'form', 'header', 'main', 'nav', 'section', 'span']);
    const stop = () => truncated || items.length >= maxElements || chars >= maxChars;
    const hasMeaningfulAttributes = (element: Element) => visibleDomRenderedAttributes.some((name) => {
      const value = element.getAttribute(name);
      return value !== null && value !== '';
    });
    const shouldIncludeElement = (element: Element) => {
      if (isVisibleDomSubtreeHidden(element) || !hasVisibleDomPointerEvents(element)) return false;
      const tag = visibleDomElementName(element);
      if (isVisibleDomInteractive(element)) return true;
      if (structuralTextTags.has(tag) && visibleDomTextContent(element)) return true;
      if (directTextContainerTags.has(tag) && visibleDomOwnTextContent(element)) return true;
      return hasMeaningfulAttributes(element);
    };
    const pushItem = (element: Element) => {
      if (stop()) return;
      const ref = visibleDomRef(element);
      const line = visibleDomLine(element, ref);
      const lineChars = line.length + (items.length === 0 ? 0 : 1);
      if (chars + lineChars > maxChars) {
        truncated = true;
        return;
      }
      state.refToElement.set(ref, element);
      items.push({
        descriptor: descriptor(element),
        line,
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
      if (isVisibleDomSubtreeHidden(element)) return;
      const tag = visibleDomElementName(element);
      if (tag === 'frame' || tag === 'iframe') pushFrame(element);
      if (shouldIncludeElement(element)) pushItem(element);
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

  function pageText(options: { maxChars: number }) {
    return renderedTextFromNode(document, options.maxChars);
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
    version: 4,
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
    pageText,
    elementText,
    visibleDomPoint,
    visibleDomText,
  };
}

function collectAiInteractiveCandidates(input: { limit: number; requirePointerEvents?: boolean }): PageInteractiveCandidate[] {
  const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime!;
  if (!runtime) return [];

  const candidateLimit = Math.max(1, Number(input.limit || 160));
  const requirePointerEvents = input.requirePointerEvents === true;
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

  const normalizeText = (value?: string | null) => String(value || '').replace(/\s+/g, ' ').trim();

  function flatParentElement(node: Node) {
    return runtime.flatParentElement(node);
  }

  function composedContains(ancestor: Element, node: Element) {
    return runtime.composedContains(ancestor, node);
  }

  function isInsideShadow(element: Element) {
    const root = element.getRootNode();
    return Boolean(root && (root as ShadowRoot).host);
  }

  function isRenderable(element: Element) {
    return runtime.isRenderable(element, { requirePointerEvents });
  }

  function visibleRectOf(element: Element) {
    return runtime.visibleRect(element, { requirePointerEvents });
  }

  function isVisibleInViewport(element: Element) {
    return Boolean(visibleRectOf(element));
  }

  function isTraversable(element: Element) {
    return runtime.isTraversable(element);
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
    return isContentEditableOwner(element);
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
          if (normalizeText(node.textContent)) found = true;
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
    if (tag === 'label') return undefined;
    const role = element.getAttribute('role') || undefined;
    const inputElement = element as HTMLInputElement;
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

    const href = tag === 'a' ? ((element as HTMLAnchorElement).href || element.getAttribute('href') || undefined) : undefined;
    let host: string | undefined;
    try {
      host = href ? new URL(href).hostname : undefined;
    } catch {
      host = undefined;
    }

    const text = ownText(element);
    const name = nameOf(element);
    const placeholder = inputElement.placeholder || undefined;
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
      center: {
        x: Math.round(visiblePoint.x),
        y: Math.round(visiblePoint.y),
      },
      clickable,
      input: isInput,
      disabled: Boolean(inputElement.disabled || element.getAttribute('aria-disabled') === 'true'),
      hasIndependentClickArea,
      shadow: isInsideShadow(element),
    };
  }

  function isDomPathAncestor(ancestorPath: string, descendantPath: string) {
    return descendantPath.startsWith(`${ancestorPath}.`);
  }

  function dropParentWhenChildExists(items: PageInteractiveCandidate[], sourceElements: Map<string, Element>) {
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

  function domPathOf(element: Element) {
    return runtime.pathOf(element)?.split('.').map((item) => Number(item));
  }

  const raw: PageInteractiveCandidate[] = [];
  const sourceElements = new Map<string, Element>();
  const seenPaths = new Set<string>();

  function pushCandidate(element: Element, path: number[]) {
    const pathKey = path.join('.');
    if (seenPaths.has(pathKey)) return;
    const candidate = candidateFrom(element, path);
    if (!candidate) return;
    raw.push(candidate);
    sourceElements.set(candidate.path, element);
    seenPaths.add(pathKey);
  }

  function walk(element: Element, path: number[], depth: number) {
    if (depth > 24) return;
    pushCandidate(element, path);
    const childNodes = children(element);
    for (let index = 0; index < childNodes.length; index += 1) {
      walk(childNodes[index], [...path, index], depth + 1);
    }
  }

  walk(document.documentElement, [0], 0);

  for (const element of Array.from(document.querySelectorAll('*'))) {
    if (!isTraversable(element) || !isVisibleInViewport(element)) continue;
    const pathParts = domPathOf(element);
    if (pathParts) pushCandidate(element, pathParts);
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

  return dropParentWhenChildExists(raw, sourceElements)
    .sort((a, b) => comparePath(a.path, b.path) || a.rect.y - b.rect.y || a.rect.x - b.rect.x)
    .slice(0, candidateLimit)
    .map((candidate, index) => ({ ...candidate, id: `${index + 1}` }));
}

function validateAiCandidateIdentity(input: { path: string; expected: CandidateIdentityPayload }): CandidateIdentityValidation {
  const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime;
  if (!runtime) return { ok: false, reason: 'DOM runtime is not available' };

  const { path: pathValue, expected } = input;
  const element = runtime.elementFromPath(pathValue);
  if (!element) return { ok: false, reason: `DOM path ${pathValue} no longer exists` };

  const normalized = (value?: string | null) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const actualTag = element.tagName.toLowerCase();
  if (actualTag !== expected.tag) return { ok: false, reason: `tag changed from ${expected.tag} to ${actualTag}` };

  function ownText(target: Element) {
    let text = '';
    for (const node of Array.from(target.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent || '';
    }
    const inner = normalized((target as HTMLElement).innerText || target.textContent || '');
    return normalized(text || inner).slice(0, 140);
  }

  function currentName(target: Element) {
    const inputElement = target as HTMLInputElement;
    const labelText = inputElement.labels?.length ? Array.from(inputElement.labels).map((label) => label.textContent || '').join(' ') : '';
    const imageAlt = Array.from(target.querySelectorAll('img[alt]')).map((img) => img.getAttribute('alt') || '').join(' ');
    return normalized([
      target.getAttribute('aria-label'),
      target.getAttribute('title'),
      target.getAttribute('alt'),
      imageAlt,
      inputElement.placeholder,
      labelText,
      ownText(target),
      inputElement.value,
    ].filter(Boolean).join(' '));
  }

  function compare(label: string, expectedValue?: string, actualValue?: string | null) {
    const left = normalized(expectedValue);
    const right = normalized(actualValue);
    if (!left) return undefined;
    return left === right ? undefined : `${label} changed from "${left}" to "${right || '[empty]'}"`;
  }

  const inputElement = element as HTMLInputElement;
  const mismatches = [
    compare('role', expected.role, element.getAttribute('role')),
    compare('type', expected.type, element.getAttribute('type')),
    compare('href', expected.href, actualTag === 'a' ? (element as HTMLAnchorElement).href || element.getAttribute('href') : undefined),
    compare('aria-label', expected.ariaLabel, element.getAttribute('aria-label')),
    compare('placeholder', expected.placeholder, inputElement.placeholder),
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
  private lastInteractiveCandidates: InteractiveCandidate[] = [];
  private lastScreenshotCandidates: InteractiveCandidate[] = [];
  private lastTextLocatorCandidates: TextLocatorCandidate[] = [];
  private lastDomNodeReferences = new Map<string, DomNodeReference>();
  private domVisiblePublicIdByFrameLocalRef = new Map<string, string>();
  private domVisibleSnapshotKey?: string;
  private domVisibleNextPublicId = 1;
  private lastScrollableAreas: ScrollableArea[] = [];
  private lastCandidateMarkerScreenshotPath?: string;
  private lastOriginalScreenshotPath?: string;
  private ownedPages = new Set<Page>();
  private browserOwnership: BrowserOwnership = 'launched';
  private releaseSharedBrowser?: () => Promise<void>;
  private pageDiscoveryListener?: (page: Page) => void;
  private pageGroupInitScriptPages = new WeakSet<Page>();
  private readonly pageGroupId: string;
  private readonly tabGroupTitle: string;

  constructor(
    private readonly mode: BrowserSessionMode = browserSessionModeFromEnv(),
    private readonly options: BrowserSessionOptions = {},
  ) {
    this.pageGroupId = normalizePageGroupId(options.runId);
    this.tabGroupTitle = normalizeTabGroupTitle(options.tabGroupTitle || options.runId);
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
    const headless = process.env.HEADLESS_BROWSER === 'true';
    const fullscreen = process.env.BROWSER_FULLSCREEN !== 'false';
    const hasExplicitViewport = Boolean(process.env.BROWSER_VIEWPORT_WIDTH || process.env.BROWSER_VIEWPORT_HEIGHT);
    const viewportWidth = Number(process.env.BROWSER_VIEWPORT_WIDTH || (fullscreen ? 1920 : 1280));
    const viewportHeight = Number(process.env.BROWSER_VIEWPORT_HEIGHT || (fullscreen ? 1080 : 800));
    const ignoreHTTPSErrors = process.env.BROWSER_IGNORE_HTTPS_ERRORS !== 'false';
    const forceBundledBrowser = process.env.AI_WEB_TEST_FORCE_PLAYWRIGHT_BROWSER === 'true';
    const channel = forceBundledBrowser ? undefined : process.env.BROWSER_CHANNEL?.trim() || undefined;
    const executablePath = process.env.AI_WEB_TEST_CHROMIUM_EXECUTABLE_PATH?.trim() || undefined;
    const cdpEndpoint = forceBundledBrowser
      ? ''
      : process.env.BROWSER_CDP_ENDPOINT?.trim()
        || process.env.BROWSER_CONNECT_CDP_ENDPOINT?.trim()
        || process.env.CHROME_REMOTE_DEBUGGING_URL?.trim()
        || '';
    const requestedUserDataDir = process.env.BROWSER_USER_DATA_DIR?.trim()
      || process.env.AI_WEB_TEST_BROWSER_PROFILE_DIR?.trim()
      || '';
    const autoTabGroupProfileKey = sharedBrowserTabsEnabled() ? 'shared' : this.pageGroupId;
    const autoTabGroupProfileDir = sessionTabGrouperEnabled(headless) && !cdpEndpoint && !requestedUserDataDir
      ? sessionTabGrouperProfileDir(autoTabGroupProfileKey)
      : '';
    const autoTabGroupDebugPort = autoTabGroupProfileDir ? sessionTabGrouperDebugPort(autoTabGroupProfileKey) : undefined;
    const autoTabGroupCdpEndpoint = cdpEndpointForPort(autoTabGroupDebugPort);
    const userDataDir = requestedUserDataDir || autoTabGroupProfileDir;
    if (autoTabGroupProfileDir) await mkdir(autoTabGroupProfileDir, { recursive: true });
    const tabGrouperEnabled = sessionTabGrouperEnabled(headless);
    const launchOptions: LaunchOptions = {
      headless,
      slowMo: Number(process.env.BROWSER_SLOW_MO_MS || 250),
      ...(channel ? { channel } : {}),
      ...(executablePath && !channel ? { executablePath } : {}),
      ...(tabGrouperEnabled ? { ignoreDefaultArgs: ['--disable-extensions'] } : {}),
      args: withSessionTabGrouperArgs([
        `--window-size=${viewportWidth},${viewportHeight + 120}`,
        fullscreen ? '--start-maximized' : '',
        ignoreHTTPSErrors ? '--ignore-certificate-errors' : '',
        '--force-device-scale-factor=1',
        '--high-dpi-support=1',
        '--no-first-run',
        '--no-default-browser-check',
        autoTabGroupDebugPort ? `--remote-debugging-port=${autoTabGroupDebugPort}` : '',
      ].filter(Boolean), headless, { exclusive: Boolean(autoTabGroupProfileDir) }),
    };
    const useNativeFullscreenViewport = fullscreen && !headless && !hasExplicitViewport;
    const contextOptions: BrowserContextOptions = {
      viewport: useNativeFullscreenViewport ? null : { width: viewportWidth, height: viewportHeight },
      ignoreHTTPSErrors,
      ...(useNativeFullscreenViewport ? {} : { deviceScaleFactor: 1 }),
    };

    if (sharedBrowserTabsEnabled()) {
      const lease = await acquireSharedBrowser({ chromium, cdpEndpoint, reconnectCdpEndpoint: autoTabGroupCdpEndpoint, userDataDir, launchOptions, contextOptions });
      this.browserOwnership = 'shared';
      this.browser = lease.browser;
      this.context = lease.context;
      this.releaseSharedBrowser = lease.release;
      await this.prepareContext(lease.context, { claimPages: false });
      this.installOwnedPageDiscovery(lease.context);
      const page = await this.findInitialSharedPage(lease.context);
      await page.bringToFront().catch(() => undefined);
      return;
    }

    if (cdpEndpoint) {
      this.browserOwnership = 'connected';
      this.browser = await chromium.connectOverCDP(cdpEndpoint);
      const existingContext = this.browser.contexts()[0];
      const context = existingContext || await this.browser.newContext(contextOptions);
      this.context = context;
      await this.prepareContext(context);
      await this.selectInitialPage(context);
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
        await this.prepareContext(connected.context);
        await this.selectInitialPage(connected.context);
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
        await this.prepareContext(connected.context);
        await this.selectInitialPage(connected.context);
        return;
      }
      this.context = context;
      this.browser = context.browser() || undefined;
      await this.prepareContext(context);
      await this.selectInitialPage(context);
      return;
    }

    this.browserOwnership = 'launched';
    this.browser = await chromium.launch(launchOptions);
    const context = await this.browser.newContext(contextOptions);
    this.context = context;
    await this.prepareContext(context);
    this.claimPage(await context.newPage());
  }

  private async findInitialSharedPage(context: BrowserContext) {
    const reclaimedPages = await this.reclaimSessionPagesByMarker(context);
    const reclaimed = this.chooseInitialPage(reclaimedPages);
    if (reclaimed) {
      this.page = reclaimed;
      return reclaimed;
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

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const markedPages = await this.reclaimSessionPagesByMarker(context);
      if (markedPages.length) return { found: true, pages: markedPages };
      if (attempt < 3) await sleep(150);
    }

    const urlClaimedPages = await this.claimPagesByNativeTabUrls(context, lookup.tabs);
    return { found: true, pages: urlClaimedPages };
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

  private claimPage(page: Page, options: { makeActive?: boolean } = {}) {
    if (page.isClosed()) return false;
    if (this.browserOwnership === 'shared') {
      const owner = sharedPageOwners.get(page);
      if (owner && owner !== this.pageGroupId) return false;
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
    await target.evaluate(installAiBrowserPageRuntime).catch(() => undefined);
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

  // 打开目标页面并等待基础加载完成。
  async open(url: string): Promise<BrowserActionResult> {
    await this.activePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const note = await this.waitAfterAction();
    return { ok: true, actual: `Opened page: ${url}${note}` };
  }

  // 读取当前页面正文文本，主要用于验证码/人工介入等文本判断。
  async readPageText() {
    const maxChars = numericLimitFromEnv('DOM_PAGE_TEXT_READ_MAX_CHARS', 200000);
    const frameLimit = numericLimitFromEnv('DOM_PAGE_TEXT_FRAME_LIMIT', numericLimitFromEnv('DOM_CUA_FRAME_LIMIT', Number.MAX_SAFE_INTEGER));
    const mainFrame = this.activePage.mainFrame();
    const frames = [mainFrame, ...this.activePage.frames().filter((frame) => frame !== mainFrame).slice(0, frameLimit)];
    const parts: string[] = [];
    let chars = 0;
    const append = (label: string, text: string) => {
      const normalized = text.replace(/\s+/g, ' ').trim();
      if (!normalized || chars >= maxChars) return;
      const block = label ? `${label}\n${normalized}` : normalized;
      const remaining = maxChars - chars;
      const chunk = block.length > remaining ? block.slice(0, remaining) : block;
      if (!chunk) return;
      parts.push(chunk);
      chars += chunk.length + 2;
    };

    for (const frame of frames) {
      if (chars >= maxChars) break;
      const framePath = frame === mainFrame ? undefined : this.getFramePath(frame);
      if (frame !== mainFrame && framePath === undefined) continue;
      const frameText = await this.readFramePageText(frame, maxChars - chars).catch(() => undefined);
      const text = frameText?.text || await frame.locator('body').innerText({ timeout: 1000 }).catch(() => '');
      const label = framePath ? `[iframe ${framePath}${frame.url() ? ` ${frame.url()}` : ''}]` : '';
      append(label, text);
    }

    return parts.join('\n\n');
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
    const [title, text, viewportMetrics, focusedElement, domTree, interactiveCandidates, scrollableAreas, pageScrollState] = await Promise.all([
      this.activePage.title().catch(() => '').then((value) => this.stripTabTitlePrefix(value)),
      includeText ? this.readPageText() : Promise.resolve(''),
      this.getViewportMetrics(),
      this.getFocusedElement(),
      options.includeDomTree ? this.readSimplifiedDomTree({ scope: options.domScope }).catch((error) => `Unable to read DOM tree: ${error instanceof Error ? error.message : String(error)}`) : Promise.resolve(undefined),
      !includeInteractiveCandidates
        ? Promise.resolve([] as InteractiveCandidate[])
        : useCachedInteractiveCandidates && this.lastScreenshotCandidates.length
          ? Promise.resolve(this.lastScreenshotCandidates)
          : useCachedInteractiveCandidates && this.lastInteractiveCandidates.length
          ? Promise.resolve(this.lastInteractiveCandidates)
          : this.refreshInteractiveCandidates().catch(() => this.lastInteractiveCandidates),
      this.refreshScrollableAreas().catch(() => this.lastScrollableAreas),
      this.getPageScrollState().catch(() => undefined),
    ]);

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
      viewport: { width: viewportMetrics.width, height: viewportMetrics.height },
      viewportMetrics,
      tabs: this.getTabsSnapshot(),
      focusedElement,
      domTree,
      interactiveCandidates,
      scrollableAreas,
      pageScrollState,
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

  // 截取当前 viewport。默认保留干净原图，并把视觉标识保存为单独 marker map。
  async takeScreenshot(runId: string, stepIndex: number, phase: 'before' | 'after' | 'manual' | `visual-${number}` | `tool-${number}` = 'after', options: ScreenshotCaptureOptions = {}) {
    const stabilizeMs = Number(process.env.SCREENSHOT_STABILIZE_MS || 1000);
    if (Number.isFinite(stabilizeMs) && stabilizeMs > 0) {
      await this.waitForStableViewport(Math.min(Math.max(stabilizeMs, 0), 5000));
    }
    const capture: ScreenshotCaptureMode = options.capture === 'fullPage' ? 'fullPage' : 'viewport';
    const dir = artifactPath(runId);
    await mkdir(dir, { recursive: true });
    const fileName = phase === 'manual' ? `step-${stepIndex}.png` : `step-${stepIndex}-${phase}.png`;
    const filePath = path.join(dir, fileName);
    const shouldCaptureCandidates = phase === 'before' || String(phase).startsWith('visual-');
    const candidateLabelsEnabled = shouldCaptureCandidates
      && this.mode === 'visual-markers'
      && this.options.isMarked !== false
      && process.env.SCREENSHOT_ELEMENT_LABELS !== 'false';
    const scrollAreaLabelsEnabled = shouldCaptureCandidates
      && this.mode === 'visual-markers'
      && process.env.SCREENSHOT_SCROLL_AREA_LABELS !== 'false';
    const candidates = shouldCaptureCandidates
      ? await this.refreshInteractiveCandidates().catch(() => [] as InteractiveCandidate[])
      : [];
    const scrollAreas = shouldCaptureCandidates
      ? await this.refreshScrollableAreas().catch(() => this.lastScrollableAreas)
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
    this.lastOriginalScreenshotPath = undefined;
    // 默认保留干净页面截图；候选编号写入单独 marker 图，点击光标保留在操作后截图里。
    const separateMarkerMap = candidateLabelsEnabled && shouldUseSeparateMarkerMap();
    await this.removeCandidateOverlay();
    if (phase === 'before' || String(phase).startsWith('visual-')) await this.removeClickMarker();
    const screenshotOptions = {
      path: filePath,
      fullPage: capture === 'fullPage',
      scale: 'css' as const,
      timeout: 15000,
    };
    if ((candidateLabelsEnabled || scrollAreaLabelsEnabled) && !separateMarkerMap) {
      const originalFilePath = path.join(dir, `step-${stepIndex}-${phase}-original.png`);
      await this.activePage.screenshot({ ...screenshotOptions, path: originalFilePath }).catch(() => undefined);
      this.lastOriginalScreenshotPath = originalFilePath;
    }
    if ((candidateLabelsEnabled || scrollAreaLabelsEnabled) && !separateMarkerMap) {
      await this.drawCandidateOverlay(
        candidateLabelsEnabled ? candidates : [],
        false,
        scrollAreaLabelsEnabled ? scrollAreas : [],
      );
    }
    try {
      await this.activePage.screenshot(screenshotOptions);
    } finally {
      if ((candidateLabelsEnabled || scrollAreaLabelsEnabled) && !separateMarkerMap) {
        await this.removeCandidateOverlay();
      }
    }
    if (separateMarkerMap) {
      const markerFilePath = path.join(dir, `step-${stepIndex}-${phase}-markers.png`);
      await this.drawCandidateOverlay(candidates, true, scrollAreaLabelsEnabled ? scrollAreas : []);
      try {
        await this.activePage.screenshot({ ...screenshotOptions, path: markerFilePath });
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
      capture,
    };
    return filePath;
  }

  // 返回最近一次截图的尺寸和 viewport 信息，供 AI 请求上下文引用。
  getLastScreenshotMetrics() {
    return this.lastScreenshotMetrics;
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
    return { ok: true, actual: JSON.stringify(candidates, null, 2) };
  }

  // 返回简化后的 DOM 树文本，作为候选列表不足时的兜底定位信息。
  async getSimplifiedDomTree(): Promise<BrowserActionResult> {
    return { ok: true, actual: await this.readSimplifiedDomTree({ scope: 'full' }) };
  }

  private resolveDomNodeReference(nodeId: string) {
    const normalizedId = normalizeDomNodeIdString(nodeId);
    const reference = normalizedId ? this.lastDomNodeReferences.get(normalizedId) : undefined;
    if (reference) return { reference };
    const available = [...this.lastDomNodeReferences.values()]
      .slice(0, 40)
      .map((item) => `${item.id}: ${item.descriptor}${item.framePath ? ` frame=${item.framePath}` : ''}`)
      .join('\n');
    return {
      error: `DOM node id "${nodeId}" was not found in the current DOM snapshot. Call getDomTree again and use one of the returned numeric ids.${available ? ` Available ids:\n${available}` : ''}`,
    };
  }

  private async readDomNodeText(reference: DomNodeReference) {
    const frame = reference.framePath ? this.frameFromPath(reference.framePath) : this.activePage.mainFrame();
    if (!frame) return undefined;
    await this.ensureBrowserPageRuntime(frame);
    return frame.evaluate(({ localRef, pathValue, maxChars }) => {
      const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime!;
      if (localRef) return runtime?.visibleDomText(localRef, { maxChars });
      const element = pathValue ? runtime?.elementFromPath(pathValue) : undefined;
      if (!element) return undefined;
      return runtime?.elementText(pathValue, { maxChars });
    }, {
      localRef: reference.localRef,
      maxChars: numericLimitFromEnv('DOM_NODE_TEXT_MAX_CHARS', 200000),
      pathValue: reference.path,
    }).catch(() => undefined);
  }

  async getDomNodeText(nodeId: string): Promise<BrowserActionResult> {
    const resolved = this.resolveDomNodeReference(nodeId);
    if (!resolved.reference) return { ok: false, actual: resolved.error };
    const result = await this.readDomNodeText(resolved.reference);

    if (!result) {
      return {
        ok: false,
        actual: `DOM node id ${nodeId} was not found. Call getDomTree again to get fresh ids; the DOM may have changed.`,
      };
    }
    return {
      ok: true,
      actual: `DOM node ${resolved.reference.id} (${result.descriptor}) full text, ${result.textLength} characters:\n${result.text || '[empty text]'}`,
    };
  }

  // 点击指定编号的候选元素中心点。
  async clickCandidate(candidateId: string, text?: string): Promise<BrowserActionResult> {
    const resolved = await this.resolveCandidateTarget(candidateId);
    if (!resolved.target) return { ok: false, actual: resolved.error };

    const { candidate, target } = resolved;
    const page = this.activePage;
    const beforeUrl = page.url();
    const popupWaitMs = Math.min(Math.max(Number(process.env.BROWSER_POPUP_WAIT_MS || 600), 0), 3000);
    const popup = popupWaitMs > 0
      ? page.waitForEvent('popup', { timeout: popupWaitMs }).catch(() => undefined)
      : Promise.resolve(undefined);
    await page.mouse.click(target.x, target.y);
    if (text !== undefined) {
      await page.keyboard.type(text);
    }
    const newPage = await popup;
    if (newPage) {
      this.claimPage(newPage);
      await newPage.bringToFront();
    }
    let note = await this.waitAfterAction();
    let fallbackNote = '';
    if (text === undefined && candidate.href && this.activePage.url() === beforeUrl && !newPage) {
      const fallback = candidate.framePath
        ? await this.dispatchFrameDomPathClick(candidate.framePath, candidate.path)
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

  async fillCandidates(actions: BrowserBatchFillAction[]): Promise<BrowserActionResult> {
    const fields = actions
      .filter((action) => action.id && action.id.trim())
      .slice(0, 80);
    if (!fields.length) return { ok: false, actual: 'fillCandidates requires at least one candidate id.' };

    const results: string[] = [];
    let ok = true;
    for (const [index, field] of fields.entries()) {
      const resolved = await this.resolveCandidateTarget(field.id);
      if (!resolved.target) {
        ok = false;
        results.push(`${index + 1}. Candidate ${field.id}: ${resolved.error}`);
        continue;
      }
      const { candidate, target } = resolved;
      await this.activePage.mouse.click(target.x, target.y);
      if (field.text !== undefined) {
        await this.replaceFocusedText(field.text, field.clear !== false);
      }
      await this.showClickMarker(target.x, target.y, 'fill');
      results.push(`${index + 1}. Candidate ${candidate.id} (${this.describeCandidate(candidate)}) clicked${field.text !== undefined ? ` and filled ${field.text.length} characters` : ''}.`);
    }
    const note = await this.waitAfterAction();
    return {
      ok,
      actual: `Batch candidate fill completed: ${results.length}/${fields.length} attempted.\n${results.join('\n')}${note}`,
    };
  }

  // 双击指定编号的候选元素，用于打开链接、表格行等双击场景。
  async doubleClickCandidate(candidateId: string): Promise<BrowserActionResult> {
    const resolved = await this.resolveCandidateTarget(candidateId);
    if (!resolved.target) return { ok: false, actual: resolved.error };

    const { candidate, target } = resolved;
    await this.activePage.mouse.dblclick(target.x, target.y);
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

  // 通过当前 DOM snapshot 的短 ID 解析元素并点击。
  async clickDomNode(nodeId: string, text?: string): Promise<BrowserActionResult> {
    const resolved = this.resolveDomNodeReference(nodeId);
    if (!resolved.reference) return { ok: false, actual: resolved.error };
    const reference = resolved.reference;
    const target = await this.resolveDomReferenceToClickablePoint(reference);
    if (!target) {
      return {
        ok: false,
        actual: `DOM node id ${nodeId} is stale, missing, or not visible in the current viewport. Call getDomTree again and use a fresh node_id.`,
      };
    }
    const page = this.activePage;
    const popupWaitMs = Math.min(Math.max(Number(process.env.BROWSER_POPUP_WAIT_MS || 600), 0), 3000);
    const popup = popupWaitMs > 0
      ? page.waitForEvent('popup', { timeout: popupWaitMs }).catch(() => undefined)
      : Promise.resolve(undefined);
    await page.mouse.click(target.x, target.y);
    if (text !== undefined) {
      await page.keyboard.type(text);
    }
    const newPage = await popup;
    if (newPage) {
      this.claimPage(newPage);
      await newPage.bringToFront();
    }
    const note = await this.waitAfterAction();
    await this.showClickMarker(target.x, target.y, 'click');
    return { ok: true, actual: `Clicked DOM node ${reference.id} (${target.descriptor}) at browser point (${target.x}, ${target.y}).${text !== undefined ? ` Typed ${text.length} characters after clicking.` : ''}${note}` };
  }

  async fillDomNodes(actions: BrowserBatchFillAction[]): Promise<BrowserActionResult> {
    const fields = actions
      .filter((action) => action.id && action.id.trim())
      .slice(0, 80);
    if (!fields.length) return { ok: false, actual: 'fillDomNodes requires at least one DOM node id.' };

    const results: string[] = [];
    let ok = true;
    for (const [index, field] of fields.entries()) {
      const resolved = this.resolveDomNodeReference(field.id);
      if (!resolved.reference) {
        ok = false;
        results.push(`${index + 1}. DOM node ${field.id}: ${resolved.error}`);
        continue;
      }
      const target = await this.resolveDomReferenceToClickablePoint(resolved.reference);
      if (!target) {
        ok = false;
        results.push(`${index + 1}. DOM node ${field.id}: stale, missing, or not visible. Call getDomTree again for fresh ids.`);
        continue;
      }
      await this.activePage.mouse.click(target.x, target.y);
      if (field.text !== undefined) {
        await this.replaceFocusedText(field.text, field.clear !== false);
      }
      await this.showClickMarker(target.x, target.y, 'fill');
      results.push(`${index + 1}. DOM node ${resolved.reference.id} (${target.descriptor}) clicked${field.text !== undefined ? ` and filled ${field.text.length} characters` : ''}.`);
    }
    const note = await this.waitAfterAction();
    return {
      ok,
      actual: `Batch DOM fill completed: ${results.length}/${fields.length} attempted.\n${results.join('\n')}${note}`,
    };
  }

  async findByText(targetText: string, scopeId?: string): Promise<BrowserActionResult> {
    const scope = scopeId ? this.resolveDomNodeReference(scopeId) : undefined;
    if (scope && !scope.reference) return { ok: false, actual: scope.error };
    const matches = await this.findInteractiveCandidatesByText(targetText, scope?.reference);
    this.lastTextLocatorCandidates = matches.map((match, index) => ({
      ...match,
      locatorId: `T${index + 1}`,
    }));
    if (!this.lastTextLocatorCandidates.length) {
      return {
        ok: false,
        actual: `No visible interactive locator matched text "${targetText}". Use getDomTree/getDomNodeText for a DOM node id, or retry findByText with a shorter exact label and optional scopeId.`,
      };
    }

    const payload = this.lastTextLocatorCandidates.map(({ locatorId, matchedText, score, candidate }) => ({
      locatorId,
      matchedText,
      score: Number(score.toFixed(3)),
      tag: candidate.tag,
      role: candidate.role,
      name: candidate.name,
      text: candidate.text,
      href: candidate.href,
      placeholder: candidate.placeholder,
      ariaLabel: candidate.ariaLabel,
      title: candidate.title,
      rect: candidate.rect,
      disabled: candidate.disabled,
      shadow: candidate.shadow,
    }));
    return {
      ok: true,
      actual: `Text locator candidates for "${targetText}" (use clickLocator(locatorId) only after choosing one):\n${JSON.stringify(payload, null, 2)}`,
    };
  }

  async clickLocator(locatorId: string, text?: string): Promise<BrowserActionResult> {
    const normalized = locatorId.trim().toUpperCase();
    const match = this.lastTextLocatorCandidates.find((item) => item.locatorId.toUpperCase() === normalized);
    if (!match) {
      const available = this.lastTextLocatorCandidates
        .map((item) => `${item.locatorId}: ${item.matchedText} (${this.describeCandidate(item.candidate)})`)
        .join('\n');
      return {
        ok: false,
        actual: `Text locator ${locatorId} was not found. Call findByText again and choose one of the returned locatorIds.${available ? ` Available locators:\n${available}` : ''}`,
      };
    }
    const { candidate } = match;
    if (candidate.disabled) {
      return { ok: false, actual: `Text locator ${match.locatorId} is disabled: ${this.describeCandidate(candidate)}` };
    }

    const resolved = await this.resolveLiveLocatorPoint(candidate);
    if (!resolved.target) {
      return { ok: false, actual: `Text locator ${match.locatorId} is no longer actionable: ${resolved.error}. Call findByText again for a fresh locator.` };
    }

    const page = this.activePage;
    const beforeUrl = page.url();
    const popupWaitMs = Math.min(Math.max(Number(process.env.BROWSER_POPUP_WAIT_MS || 600), 0), 3000);
    const popup = popupWaitMs > 0
      ? page.waitForEvent('popup', { timeout: popupWaitMs }).catch(() => undefined)
      : Promise.resolve(undefined);
    const target = resolved.target;
    await page.mouse.click(target.x, target.y);
    if (text !== undefined) {
      await page.keyboard.type(text);
    }
    const newPage = await popup;
    if (newPage) {
      this.claimPage(newPage);
      await newPage.bringToFront();
    }
    let note = await this.waitAfterAction();
    let fallbackNote = '';
    if (text === undefined && candidate.href && this.activePage.url() === beforeUrl && !newPage) {
      const fallback = candidate.framePath
        ? await this.dispatchFrameDomPathClick(candidate.framePath, candidate.path)
        : candidate.shadow
          ? undefined
          : await this.dispatchDomPathClick(candidate.path);
      if (fallback) {
        fallbackNote = ` Primary mouse click did not change the URL; retried ${fallback} with DOM click.`;
        note += await this.waitAfterAction();
      }
    }
    await this.showClickMarker(target.x, target.y, 'click');
    return {
      ok: true,
      actual: `Clicked text locator ${match.locatorId} matching "${match.matchedText}" (${target.descriptor}) at browser point (${target.x}, ${target.y}).${text !== undefined ? ` Typed ${text.length} characters after clicking.` : ''}${target.offscreen ? ' It was scrolled/clamped before clicking.' : ''}${fallbackNote}${note}`,
    };
  }

  // 通过当前 DOM snapshot 的短 ID 聚焦元素，作为文本输入前的兜底聚焦方式。
  async focusDomNode(nodeId: string): Promise<BrowserActionResult> {
    const resolved = this.resolveDomNodeReference(nodeId);
    if (!resolved.reference) return { ok: false, actual: resolved.error };
    const reference = resolved.reference;
    const target = await this.resolveDomReferenceToClickablePoint(reference);
    if (!target) {
      return {
        ok: false,
        actual: `DOM node id ${nodeId} is stale, missing, or not visible in the current viewport. Call getDomTree again and use a fresh node_id.`,
      };
    }
    await this.activePage.mouse.click(target.x, target.y);
    const note = await this.waitAfterAction();
    return { ok: true, actual: `Focused DOM node ${reference.id} (${target.descriptor}) at browser point (${target.x}, ${target.y}).${note}` };
  }

  // 滚动页面或指定滚动容器，支持虚拟表格/列表的局部滚动。
  async scroll(deltaY: number, deltaX = 0, target: { domPath?: string } = {}): Promise<BrowserActionResult> {
    const scrollTarget = await this.resolveScrollTarget({ domPath: target.domPath ? normalizeDomPathString(target.domPath) : undefined });
    await this.activePage.mouse.move(scrollTarget.x, scrollTarget.y);
    await this.activePage.mouse.wheel(deltaX, deltaY);
    const note = await this.waitAfterAction();
    return { ok: true, actual: `Scrolled ${scrollTarget.descriptor} at browser point (${scrollTarget.x}, ${scrollTarget.y}) by x=${deltaX}, y=${deltaY}.${scrollTarget.note}${note}` };
  }

  // 按可滚动区域编号滚动任意滚动容器。编号来自 getPageContext().scrollableAreas。
  async scrollArea(areaId: string, deltaY: number, deltaX = 0): Promise<BrowserActionResult> {
    const area = this.lastScrollableAreas.find((item) => item.id === areaId)
      || (await this.refreshScrollableAreas()).find((item) => item.id === areaId);
    if (!area) {
      return {
        ok: false,
        actual: `Scrollable area ${areaId} was not found. Use the latest scrollableAreas list and choose an id such as S1.`,
      };
    }
    const scrollStateText = (scroll: ScrollableArea['scroll']) => {
      const yBoundary = scroll.atBottom
        ? 'atBottom'
        : scroll.atTop
          ? 'atTop'
          : `remainingDown=${scroll.remainingDown}, remainingUp=${scroll.remainingUp}`;
      const xBoundary = scroll.atRight
        ? 'atRight'
        : scroll.atLeft
          ? 'atLeft'
          : `remainingRight=${scroll.remainingRight}, remainingLeft=${scroll.remainingLeft}`;
      return `top=${scroll.top}/${scroll.maxTop}, left=${scroll.left}/${scroll.maxLeft}, ${yBoundary}, ${xBoundary}`;
    };
    if (deltaY === 0 && deltaX === 0) {
      return {
        ok: false,
        actual: `Scrollable area ${area.id} was not scrolled because both deltaY and deltaX are 0. Current state: ${scrollStateText(area.scroll)}.`,
      };
    }
    const canMoveY = (deltaY > 0 && area.scroll.canScrollDown) || (deltaY < 0 && area.scroll.canScrollUp) || deltaY === 0;
    const canMoveX = (deltaX > 0 && area.scroll.canScrollRight) || (deltaX < 0 && area.scroll.canScrollLeft) || deltaX === 0;
    if (!canMoveY || !canMoveX) {
      return {
        ok: false,
        actual: `Scrollable area ${area.id} cannot scroll in the requested direction. Current state: ${scrollStateText(area.scroll)}. Choose a different action or a different scroll direction/area instead of repeating this scroll.`,
      };
    }
    await this.activePage.mouse.move(area.center.x, area.center.y);
    await this.activePage.mouse.wheel(deltaX, deltaY);
    const note = await this.waitAfterAction();
    const updated = (await this.refreshScrollableAreas().catch(() => [])).find((item) => item.id === areaId);
    const state = updated
      ? ` Before: ${scrollStateText(area.scroll)}. After: ${scrollStateText(updated.scroll)}. Moved: y=${updated.scroll.top - area.scroll.top}, x=${updated.scroll.left - area.scroll.left}.`
      : '';
    return {
      ok: true,
      actual: `Scrolled area ${area.id} (${area.tag}${area.name ? ` "${area.name}"` : ''}) at (${area.center.x}, ${area.center.y}) by x=${deltaX}, y=${deltaY}.${state}${note}`,
    };
  }

  // 列出当前浏览器上下文中的所有标签页，供 AI 判断是否需要切换。
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
    const page = this.sessionPages()[index];
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
      ok: true,
      actual: note
        ? `Manual verification is visible. The run is paused for user intervention instead of waiting ${maxMs}ms inside the AI request.`
        : 'AI requested a manual verification pause. Ask the user to inspect the browser and continue after completing any required verification.',
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
        if (!options.keepOpen && process.env.KEEP_BROWSER_OPEN_AFTER_RUN !== 'true') {
          await this.closeOwnedPages();
        }
        await this.releaseSharedBrowser?.();
        this.releaseSharedBrowser = undefined;
        return;
      }
      if (options.keepOpen || process.env.KEEP_BROWSER_OPEN_AFTER_RUN === 'true') return;
      if (this.browserOwnership === 'connected') {
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
    await this.activePage.waitForLoadState('domcontentloaded').catch(() => undefined);
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
      this.activePage.title().catch(() => '').then((value) => this.stripTabTitlePrefix(value)),
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

  private async refreshInteractiveCandidates() {
    const limit = Math.max(10, Number(process.env.INTERACTIVE_CANDIDATE_LIMIT || 160));
    const scanLimit = Math.max(limit * 2, limit + 50);
    await this.ensureBrowserPageRuntime();
    const mainCandidates = await this.activePage
      .evaluate(collectAiInteractiveCandidates, { limit: scanLimit, requirePointerEvents: false })
      .catch(() => [] as PageInteractiveCandidate[]);

    const frameCandidates = await this.refreshFrameInteractiveCandidates(scanLimit);
    const combinedCandidates: InteractiveCandidate[] = [...mainCandidates, ...frameCandidates];
    const candidates = combinedCandidates
      .filter((candidate) => {
        if (candidate.framePath) return true;
        return !frameCandidates.some((frameCandidate) => this.rectContains(candidate.rect, frameCandidate.rect));
      })
      .sort((a, b) => this.compareCandidateOrder(a, b))
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

      await this.ensureBrowserPageRuntime(frame);
      const localCandidates = await frame
        .evaluate(collectAiInteractiveCandidates, { limit, requirePointerEvents: true })
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
      candidate.href ? `href=${candidate.href.slice(0, 140)}` : '',
      candidate.framePath ? `frame=${candidate.framePath}` : '',
      `box=${candidate.rect.x},${candidate.rect.y},${candidate.rect.width}x${candidate.rect.height}`,
    ].filter(Boolean);
    return parts.join(' ');
  }

  private async findInteractiveCandidatesByText(targetText: string, scope?: DomNodeReference) {
    const query = targetText.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!query) return [] as TextLocatorCandidate[];

    const candidates = await this.refreshInteractiveCandidates();
    const queryParts = query.split(/\s+/).filter((item) => item.length >= 2);
    const scoreLabel = (value: string) => {
      const label = value.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!label) return undefined;
      if (label === query) return 0;
      if (label.startsWith(query)) return 1;
      if (label.includes(query)) return 2;
      if (queryParts.length >= 2 && queryParts.every((part) => label.includes(part))) return 3;
      return undefined;
    };

    const matches: TextLocatorCandidate[] = [];
    for (const candidate of candidates) {
      if (scope && (candidate.framePath || '') !== (scope.framePath || '')) {
        continue;
      }
      if (scope && candidate.path !== scope.path && !candidate.path.startsWith(`${scope.path}.`)) {
        continue;
      }
      const labels = [
        candidate.name,
        candidate.text,
        candidate.ariaLabel,
        candidate.title,
        candidate.placeholder,
        candidate.href,
        candidate.nearbyText,
      ].filter((item): item is string => Boolean(item));
      for (const label of labels) {
        const score = scoreLabel(label);
        if (score === undefined) continue;
        const areaPenalty = Math.min(8, (candidate.rect.width * candidate.rect.height) / Math.max(1, 1280 * 720) * 8);
        const tagBonus = candidate.tag === 'a' || candidate.tag === 'button' ? -0.4 : candidate.input ? -0.2 : 0;
        const finalScore = score + areaPenalty + tagBonus;
        matches.push({ locatorId: '', candidate, matchedText: label.slice(0, 180), score: finalScore });
      }
    }
    const seen = new Set<string>();
    return matches
      .sort((a, b) => a.score - b.score || this.compareCandidateOrder(a.candidate, b.candidate))
      .filter((match) => {
        const key = `${match.candidate.framePath || 'main'}:${match.candidate.path}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, Math.max(1, Number(process.env.TEXT_LOCATOR_MATCH_LIMIT || 8)));
  }

  private candidateIdentityPayload(candidate: InteractiveCandidate): CandidateIdentityPayload {
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
    await this.ensureBrowserPageRuntime();
    return this.activePage.evaluate(validateAiCandidateIdentity, {
      path: candidate.path,
      expected: this.candidateIdentityPayload(candidate),
    }).catch((error) => ({
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }));
  }

  private async validateFrameCandidateIdentity(candidate: InteractiveCandidate) {
    const frame = this.frameFromPath(candidate.framePath);
    if (!frame) return { ok: false, reason: `iframe ${candidate.framePath} no longer exists` };
    await this.ensureBrowserPageRuntime(frame);
    return frame.evaluate(validateAiCandidateIdentity, {
      path: candidate.path,
      expected: this.candidateIdentityPayload(candidate),
    }).catch((error) => ({
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

    if (this.mode === 'visual-markers') {
      const point = this.resolveCapturedCandidatePoint(candidate, candidate.framePath ? `iframe ${candidate.framePath} screenshot` : 'screenshot');
      if (!point) {
        return {
          candidate,
          error: `Candidate ${candidate.id} has no valid point in the current visual marker screenshot snapshot.`,
        };
      }
      return { candidate, target: point };
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

  private async resolveLiveLocatorPoint(candidate: InteractiveCandidate) {
    if (candidate.framePath) {
      const identity = await this.validateFrameCandidateIdentity(candidate);
      if (!identity.ok) return { error: identity.reason };
      const target = await this.resolveFrameDomPathToClickablePoint(candidate.framePath, candidate.path);
      return target ? { target } : { error: `iframe DOM path ${candidate.path} is not visible` };
    }

    if (candidate.shadow) {
      const target = await this.resolveShadowCandidatePoint(candidate);
      return target ? { target } : { error: 'shadow DOM target is no longer at its matched viewport point' };
    }

    const identity = await this.validateMainCandidateIdentity(candidate);
    if (!identity.ok) return { error: identity.reason };
    const target = await this.resolveDomPathToClickablePoint(candidate.path);
    return target ? { target } : { error: `DOM path ${candidate.path} is not visible` };
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

  private async readSimplifiedDomTree(options: { scope?: 'visible' | 'full' } = {}) {
    const fullScope = options.scope === 'full';
    const maxElements = fullScope
      ? numericLimitFromEnv('DOM_CUA_FULL_MAX_ELEMENTS', numericLimitFromEnv('DOM_CUA_MAX_ELEMENTS', 600))
      : numericLimitFromEnv('DOM_CUA_MAX_ELEMENTS', 200);
    const maxChars = fullScope
      ? numericLimitFromEnv('DOM_CUA_FULL_MAX_CHARS', numericLimitFromEnv('DOM_CUA_MAX_CHARS', 60000))
      : numericLimitFromEnv('DOM_CUA_MAX_CHARS', 20000);
    this.lastDomNodeReferences = new Map();
    const mainSnapshot = fullScope
      ? await this.readFullDomSnapshot(this.activePage.mainFrame(), maxElements, maxChars)
      : await this.readVisibleDomSnapshot(this.activePage.mainFrame(), maxElements, maxChars);
    if (!mainSnapshot) return 'DOM runtime is not available on this page. Retry getDomTree after the page settles.';
    this.resetDomVisibleIdState(mainSnapshot.stateKey);

    const lines: string[] = [];
    let chars = 0;
    const references: DomNodeReference[] = [];
    const appendSnapshot = (snapshot: BrowserUseVisibleDomSnapshot, framePath?: string, frameUrl?: string, viewportClip?: BrowserUseViewportClip) => {
      if (framePath && snapshot.items.length) {
        const frameLine = `<!-- iframe ${framePath}${frameUrl ? ` url="${frameUrl}"` : ''} -->`;
        const frameLineChars = frameLine.length + (lines.length === 0 ? 0 : 1);
        if (chars + frameLineChars <= maxChars) {
          lines.push(frameLine);
          chars += frameLineChars;
        }
      }
      for (const item of snapshot.items) {
        if (lines.length >= maxElements || chars >= maxChars) return;
        const publicId = this.publicDomVisibleId(snapshot.stateKey, item.ref);
        const line = item.line.replace(`node_id=${item.ref}`, `node_id=${publicId}`);
        const lineChars = line.length + (lines.length === 0 ? 0 : 1);
        if (chars + lineChars > maxChars) return;
        lines.push(line);
        chars += lineChars;
        references.push({
          id: publicId,
          localRef: item.ref,
          path: item.path,
          framePath,
          frameUrl,
          descriptor: item.descriptor,
          viewportClip,
        });
      }
    };

    appendSnapshot(mainSnapshot);
    const frameLimit = numericLimitFromEnv('DOM_CUA_FRAME_LIMIT', Number.MAX_SAFE_INTEGER);
    const frameSnapshots = fullScope
      ? await this.readFullFrameDomSnapshots(maxElements, maxChars, frameLimit)
      : await this.readVisibleFrameDomSnapshots(mainSnapshot.viewport, maxElements, maxChars, frameLimit);
    for (const frameSnapshot of frameSnapshots) {
      appendSnapshot(frameSnapshot.snapshot, frameSnapshot.framePath, frameSnapshot.frameUrl, frameSnapshot.viewportClip);
    }

    this.lastDomNodeReferences = new Map(references.map((reference) => [reference.id, reference]));
    return lines.join('\n') || (fullScope ? '[empty full DOM snapshot]' : '[empty visible DOM snapshot]');
  }

  private resetDomVisibleIdState(mainSnapshotKey: string) {
    if (this.domVisibleSnapshotKey === mainSnapshotKey) return;
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

  private async readVisibleDomSnapshot(
    target: Page | Frame,
    maxElements: number,
    maxChars: number,
    viewportClip?: BrowserUseViewportClip,
  ) {
    await this.ensureBrowserPageRuntime(target);
    return target.evaluate((input) => {
      const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime!;
      return runtime?.visibleDomSnapshot(input);
    }, { maxChars, maxElements, viewportClip }).catch(() => undefined);
  }

  private async readFullDomSnapshot(
    target: Page | Frame,
    maxElements: number,
    maxChars: number,
  ) {
    await this.ensureBrowserPageRuntime(target);
    return target.evaluate((input) => {
      const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime!;
      return runtime?.fullDomSnapshot(input);
    }, { maxChars, maxElements }).catch(() => undefined);
  }

  private async readFramePageText(
    target: Page | Frame,
    maxChars: number,
  ) {
    await this.ensureBrowserPageRuntime(target);
    return target.evaluate((input) => {
      const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime!;
      return runtime?.pageText(input);
    }, { maxChars }).catch(() => undefined);
  }

  private async readFullFrameDomSnapshots(
    maxElements: number,
    maxChars: number,
    frameLimit: number,
  ): Promise<Array<{
    framePath: string;
    frameUrl?: string;
    snapshot: BrowserUseVisibleDomSnapshot;
    viewportClip?: BrowserUseViewportClip;
  }>> {
    const frames = this.activePage.frames().filter((frame) => frame !== this.activePage.mainFrame());
    const output: Array<{
      framePath: string;
      frameUrl?: string;
      snapshot: BrowserUseVisibleDomSnapshot;
      viewportClip?: BrowserUseViewportClip;
    }> = [];

    for (const frame of frames.slice(0, frameLimit)) {
      const framePath = this.getFramePath(frame);
      if (framePath === undefined) continue;
      const snapshot = await this.readFullDomSnapshot(frame, maxElements, maxChars);
      if (!snapshot) continue;
      output.push({
        framePath,
        frameUrl: frame.url() || undefined,
        snapshot,
      });
    }
    return output;
  }

  private async readVisibleFrameDomSnapshots(
    topViewport: BrowserUseViewportClip,
    maxElements: number,
    maxChars: number,
    frameLimit: number,
  ): Promise<Array<{
    framePath: string;
    frameUrl?: string;
    snapshot: BrowserUseVisibleDomSnapshot;
    viewportClip: BrowserUseViewportClip;
  }>> {
    const frames = this.activePage.frames().filter((frame) => frame !== this.activePage.mainFrame());
    const output: Array<{
      framePath: string;
      frameUrl?: string;
      snapshot: BrowserUseVisibleDomSnapshot;
      viewportClip: BrowserUseViewportClip;
    }> = [];

    for (const frame of frames.slice(0, frameLimit)) {
      const framePath = this.getFramePath(frame);
      if (framePath === undefined) continue;
      const box = await frame.frameElement().then((handle) => handle.boundingBox()).catch(() => undefined);
      if (!box || box.width <= 0 || box.height <= 0) continue;
      const frameRect = {
        bottom: box.y + box.height,
        left: box.x,
        right: box.x + box.width,
        top: box.y,
      };
      const visibleFrameRect = this.intersectViewportClip(topViewport, frameRect);
      if (!visibleFrameRect) continue;
      const viewportClip = {
        bottom: visibleFrameRect.bottom - box.y,
        left: visibleFrameRect.left - box.x,
        right: visibleFrameRect.right - box.x,
        top: visibleFrameRect.top - box.y,
      };
      const snapshot = await this.readVisibleDomSnapshot(frame, maxElements, maxChars, viewportClip);
      if (!snapshot) continue;
      output.push({
        framePath,
        frameUrl: frame.url() || undefined,
        snapshot,
        viewportClip,
      });
    }
    return output;
  }

  private async resolveDomReferenceToClickablePoint(reference: DomNodeReference) {
    if (!reference.localRef) {
      return reference.framePath
        ? this.resolveFrameDomPathToClickablePoint(reference.framePath, reference.path)
        : this.resolveDomPathToClickablePoint(reference.path);
    }
    const frame = reference.framePath ? this.frameFromPath(reference.framePath) : this.activePage.mainFrame();
    if (!frame) return undefined;
    await this.ensureBrowserPageRuntime(frame);
    const local = await frame.evaluate(({ localRef, viewportClip }) => {
      const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime!;
      return runtime?.visibleDomPoint(localRef, viewportClip);
    }, { localRef: reference.localRef, viewportClip: reference.viewportClip }).catch(() => undefined);
    if (!local) return undefined;

    if (!reference.framePath) {
      return {
        x: Math.round(local.x),
        y: Math.round(local.y),
        descriptor: local.descriptor,
        offscreen: false,
      };
    }

    const frameBox = await frame.frameElement().then((handle) => handle.boundingBox()).catch(() => undefined);
    if (!frameBox) return undefined;
    return {
      x: Math.round(frameBox.x + local.x),
      y: Math.round(frameBox.y + local.y),
      descriptor: `iframe ${reference.framePath} ${local.descriptor}`,
      offscreen: false,
    };
  }

  private async resolveDomPathToClickablePoint(pathValue: string) {
    await this.ensureBrowserPageRuntime();
    return this.activePage.evaluate((path) => {
      const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime!;
      let element = runtime?.elementFromPath(path);
      if (!element) return undefined;
      element = runtime.actionableTargetFor(element);

      let rect = element.getBoundingClientRect();
      let point = runtime.visiblePointForElement(element, { requirePointerEvents: true });
      if (!point) {
        element.scrollIntoView({ block: 'center', inline: 'center' });
        rect = element.getBoundingClientRect();
        point = runtime.visiblePointForElement(element, { requirePointerEvents: true });
      }
      // Some wrappers have zero size but contain a visible interactive child. Descend to the first
      // rendered descendant that actually has a box so the click lands on something visible.
      if (!point || rect.width <= 0 || rect.height <= 0) {
        const queue = runtime.children(element);
        while (queue.length) {
          const candidate = queue.shift() as Element;
          const candidateRect = candidate.getBoundingClientRect();
          const candidatePoint = runtime.visiblePointForElement(candidate, { requirePointerEvents: true });
          if (candidateRect.width > 0 && candidateRect.height > 0 && candidatePoint) {
            element = candidate;
            rect = candidateRect;
            point = candidatePoint;
            break;
          }
          queue.push(...runtime.children(candidate));
        }
      }
      if (!point || rect.width <= 0 || rect.height <= 0) return undefined;

      const centerX = point.x;
      const centerY = point.y;
      const offscreen = rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth;
      return {
        x: Math.min(Math.max(centerX, 0), window.innerWidth - 1),
        y: Math.min(Math.max(centerY, 0), window.innerHeight - 1),
        descriptor: runtime.descriptor(element),
        offscreen,
      };
    }, pathValue).catch(() => undefined);
  }

  private async resolveFrameDomPathToClickablePoint(framePath: string, pathValue: string) {
    const frame = this.frameFromPath(framePath);
    if (!frame) return undefined;
    const frameBox = await frame.frameElement().then((handle) => handle.boundingBox()).catch(() => undefined);
    if (!frameBox) return undefined;
    await this.ensureBrowserPageRuntime(frame);
    const local = await frame.evaluate((path) => {
      const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime!;
      let element = runtime?.elementFromPath(path);
      if (!element) return undefined;
      element = runtime.actionableTargetFor(element);

      let rect = element.getBoundingClientRect();
      let point = runtime.visiblePointForElement(element, { requirePointerEvents: true });
      if (!point) {
        element.scrollIntoView({ block: 'center', inline: 'center' });
        rect = element.getBoundingClientRect();
        point = runtime.visiblePointForElement(element, { requirePointerEvents: true });
      }
      if (!point || rect.width <= 0 || rect.height <= 0) return undefined;
      const x = Math.min(Math.max(point.x, 0), window.innerWidth - 1);
      const y = Math.min(Math.max(point.y, 0), window.innerHeight - 1);
      return {
        x,
        y,
        descriptor: runtime.descriptor(element),
        offscreen: rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth,
      };
    }, pathValue).catch(() => undefined);
    if (!local) return undefined;
    return {
      x: Math.round(frameBox.x + local.x),
      y: Math.round(frameBox.y + local.y),
      descriptor: `iframe ${framePath} ${local.descriptor}`,
      offscreen: local.offscreen,
    };
  }

  private async dispatchDomPathClick(pathValue: string) {
    await this.ensureBrowserPageRuntime();
    return this.activePage.evaluate((path) => {
      const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime!;
      if (!runtime) return undefined;
      let element = runtime.elementFromPath(path);
      if (!element) return undefined;
      element = runtime.actionableTargetFor(element);
      const descriptor = runtime.descriptor(element);
      (element as HTMLElement).click();
      return descriptor;
    }, pathValue).catch(() => undefined);
  }

  private async dispatchFrameDomPathClick(framePath: string, pathValue: string) {
    const frame = this.frameFromPath(framePath);
    if (!frame) return undefined;
    await this.ensureBrowserPageRuntime(frame);
    return frame.evaluate((path) => {
      const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime!;
      if (!runtime) return undefined;
      let element = runtime.elementFromPath(path);
      if (!element) return undefined;
      element = runtime.actionableTargetFor(element);
      const descriptor = runtime.descriptor(element);
      (element as HTMLElement).click();
      return `iframe DOM click ${descriptor}`;
    }, pathValue).catch(() => undefined);
  }

  private async resolveScrollTarget(target: { domPath?: string }) {
    await this.ensureBrowserPageRuntime();
    return this.activePage.evaluate(({ domPath }) => {
      const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime!;
      if (!runtime) {
        return {
          x: 1,
          y: 1,
          descriptor: 'document',
          note: ' DOM runtime was not available; fell back to document.',
        };
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
          current = runtime.flatParentElement(current);
        }
        return document.scrollingElement || document.documentElement;
      }

      const sourceElement =
        runtime.elementFromPath(domPath) ||
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
        descriptor: runtime.descriptor(scrollElement),
        note: ` Source element: ${runtime.descriptor(sourceElement)}.`,
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

  private async drawCandidateOverlay(candidates: InteractiveCandidate[], markersOnly = false, scrollAreas: ScrollableArea[] = []) {
    const labelLimit = Math.max(10, Number(process.env.SCREENSHOT_ELEMENT_LABEL_LIMIT || process.env.INTERACTIVE_CANDIDATE_LIMIT || 160));
    const visible = candidates.slice(0, labelLimit);
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
        overlay.appendChild(box);
        overlay.appendChild(label);
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

        overlay.appendChild(box);
        overlay.appendChild(label);
      }

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
