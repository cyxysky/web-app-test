import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { Browser, BrowserContext, BrowserContextOptions, BrowserServer, BrowserType, Dialog, ElementHandle, Frame, LaunchOptions, Locator, Page, Request, Worker as PlaywrightWorker } from 'playwright';
import {
  resolveBrowserOutputPixelRatio,
  resolveBrowserPreviewImageFormat,
} from '@/config/browser-output-settings';
import { artifactPath } from '@/server/storage/paths';
import { browserPreviewFrameIntervalMs, browserPreviewFramesPerSecond } from './browser-preview-cadence';
import { browserPreviewVideoCaptureGeometry } from './browser-preview-video-settings';
import {
  BrowserPreviewFramePump,
  type BrowserPreviewFramePumpMetrics,
} from './browser-preview-frame-pump';
import {
  boundedNonNegativeIntegerEnv,
  boundedPositiveIntegerEnv,
  browserTabTitlePrefixEnabled,
  cdpEndpointForPort,
  cdpPortFromEndpoint,
  electronEmbeddedBrowserCdpEndpoint,
  electronEmbeddedBrowserEnabled,
  clearManagedBrowserProfileCaches,
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
import {
  BROWSER_CODE_KERNEL_RUNTIME_REVISION,
  browserCodePolicyViolation,
  BrowserCodeKernel,
  type BrowserCodeActivity,
  type BrowserCodeConnection,
  type BrowserCodeCredentialBinding,
} from './browser-code-runner';
import { resolveBrowserSessionSurface, type BrowserSessionSurface } from './browser-session-surface';

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
const DEFAULT_BROWSER_NAVIGATION_DOM_QUIET_MS = 250;
const DEFAULT_BROWSER_NAVIGATION_DOM_STABILITY_TIMEOUT_MS = 1000;
const BROWSER_NAVIGATION_DOM_STABILITY_POLL_MS = 50;
const AI_DOM_RUNTIME_VERSION = 26;

function fixedBrowserViewportFromEnv() {
  if (process.env.BROWSER_VIEWPORT_MODE?.trim().toLowerCase() !== 'fixed') return undefined;
  const width = positiveIntegerEnv('BROWSER_VIEWPORT_WIDTH');
  const height = positiveIntegerEnv('BROWSER_VIEWPORT_HEIGHT');
  return width && height ? { width, height } : undefined;
}

function browserOutputPixelRatioFromEnv() {
  return resolveBrowserOutputPixelRatio(process.env.BROWSER_OUTPUT_PIXEL_RATIO);
}

function compactDiagnosticText(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function unknownErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isAlreadyHandledJavaScriptDialogError(error: unknown) {
  return /(?:no dialog is showing|dialog which is already handled)/i.test(unknownErrorMessage(error));
}

function stringifyDiagnosticValue(value: unknown) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export type BrowserSessionMode = 'code' | 'dom';

export type BrowserSessionOptions = {
  browserSurface?: BrowserSessionSurface;
  isMarked?: boolean;
  runId?: string;
  preferExistingPage?: boolean;
  browserProfileKey?: string;
  debugDevtools?: boolean;
  headless?: boolean;
  isolated?: boolean;
  /** Shares one browser/context with other sessions in the same application-user runtime. */
  sharedBrowserRuntimeKey?: string;
  storageState?: BrowserContextOptions['storageState'];
  /** Overrides Playwright's artificial action delay for latency-sensitive sessions. */
  slowMoMs?: number;
  /** Limits the optional post-click popup wait without changing global browser settings. */
  popupWaitMs?: number;
  /** Caps post-action frame bookkeeping; target resolution still uses the original frame. */
  actionFrameLimit?: number;
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
  return process.env.AI_BROWSER_MODE?.trim().toLowerCase() === 'dom' ? 'dom' : 'code';
}

export type BrowserSnapshotView = 'actionable' | 'full' | 'text' | 'changes';

export type BrowserSnapshotViews = Partial<Record<BrowserSnapshotView, string>> & {
  defaultType?: BrowserSnapshotView;
};

export type BrowserActiveSurface = {
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

export type BrowserPageObservation = {
  epoch: number;
  url: string;
  title: string;
  focusedElement?: {
    descriptor: string;
    label: string;
  };
  activeSurface?: BrowserActiveSurface;
  surfaces: BrowserActiveSurface[];
  surfaceStack: BrowserActiveSurface[];
  topSurfaceIds: string[];
  surfaceTransition: 'initial' | 'unchanged' | 'opened' | 'closed' | 'changed';
};

export type BrowserActionResult = {
  ok: boolean;
  actual: string;
  /** Snapshot/observation that owns any DOM refs returned with this result. */
  snapshotId?: string;
  /** Click-specific timing breakdown for diagnosing browser action latency. */
  clickTimings?: BrowserClickTiming;
  /** A user-provided or generated image that should be attached to the next model request. */
  referenceImagePath?: string;
  /** Images emitted by browserCode that should be attached to the next model request in order. */
  referenceImagePaths?: string[];
  /** A compact continuation cursor for paged snapshot readers. */
  nextCursor?: string;
  /** Low-level page facts returned by the DOM operation protocol. Code returns an AX tree instead. */
  observation?: BrowserPageObservation;
  /** Runtime-enforced post-action verification outcome. */
  verification?: {
    status: 'passed' | 'failed' | 'required';
    detail: string;
  };
  domChanges?: {
    snapshotId?: string;
    epoch: number;
    added: string[];
    updated: string[];
    removed: string[];
    /** Non-actionable semantic changes and diagnostics observed with this delta. */
    extra: {
      added: string[];
      updated: string[];
      errors: string[];
      validationErrors: string[];
    };
    overflow: boolean;
    observation?: BrowserPageObservation;
  };
};

export type BrowserClickTiming = {
  targetResolutionMs: number;
  preClickInteractionReadMs: number;
  waitForClickableMs: number;
  clickDispatchMs: number;
  popupListenerSetupMs: number;
  popupWaitMs: number;
  postActionSettleMs: number;
  verificationMs: number;
  navigationDomStabilityMs: number;
  domChangesMs: number;
  journalResetMs: number;
  resultAssemblyMs: number;
  totalMs: number;
};

type BrowserClickTimingStage = Exclude<keyof BrowserClickTiming, 'totalMs'>;

async function timeBrowserClickStage<T>(
  timings: BrowserClickTiming,
  stage: BrowserClickTimingStage,
  action: () => Promise<T>,
) {
  const startedAt = Date.now();
  try {
    return await action();
  } finally {
    timings[stage] = Date.now() - startedAt;
  }
}

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
  outputPixelRatio: number;
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
  observationId?: string;
  interactive: boolean;
  capabilities?: DomActionCapability[];
  confidence?: DomActionConfidence;
  contextText?: string;
  priority?: number;
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
  normalizedContext: string;
  normalizedLabel: string;
  normalizedLine: string;
  searchText: string;
  semanticRoles: string[];
  state: string;
  surfaceId?: string;
  tag: string;
  viewportClip?: BrowserUseViewportClip;
};

function normalizeDomSearchText(value: unknown) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function indexDomNodeReference<T extends Omit<DomNodeReference, 'normalizedContext' | 'normalizedLabel' | 'normalizedLine' | 'searchText' | 'semanticRoles'>>(reference: T): DomNodeReference {
  const normalizedLabel = normalizeDomSearchText(reference.label);
  const normalizedContext = normalizeDomSearchText(reference.contextText);
  const normalizedLine = normalizeDomSearchText(reference.line);
  const tag = normalizeDomSearchText(reference.tag);
  const semanticRoles = new Set<string>([tag]);
  for (const match of normalizedLine.matchAll(/\brole="([^"]+)"/g)) semanticRoles.add(normalizeDomSearchText(match[1]));
  if (tag === 'input' || tag === 'textarea' || tag === 'contenteditable') semanticRoles.add('textbox');
  if (tag === 'select') semanticRoles.add('combobox');
  if (tag === 'a') semanticRoles.add('link');
  if (tag === 'button') semanticRoles.add('button');
  if (tag === 'input' && /\btype="checkbox"/.test(normalizedLine)) semanticRoles.add('checkbox');
  if (tag === 'input' && /\btype="radio"/.test(normalizedLine)) semanticRoles.add('radio');
  return {
    ...reference,
    normalizedContext,
    normalizedLabel,
    normalizedLine,
    searchText: normalizeDomSearchText([
      reference.label,
      reference.contextText,
      reference.line,
      reference.tag,
      reference.descriptor,
      reference.state,
    ].filter(Boolean).join(' ')),
    semanticRoles: [...semanticRoles],
  };
}

type PageInteractiveCandidate = Omit<InteractiveCandidate, 'framePath' | 'frameUrl'>;

type PageDomObservationPayload = {
  structuredText: string;
  interactiveCandidates: PageInteractiveCandidate[];
  links: Array<{ url: string; title: string }>;
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

type DomActionCapability = 'click' | 'drag' | 'fill' | 'focus' | 'hover' | 'scroll' | 'select';
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
    priority: number;
    rect?: BrowserUseViewportClip;
    ref: string;
    signals: string[];
    state: string;
    surfaceId?: string;
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

type BrowserUseDomDelta = {
  epoch: number;
  stateKey: string;
  observation: BrowserPageObservation;
  added: BrowserUseVisibleDomSnapshot['items'];
  updated: BrowserUseVisibleDomSnapshot['items'];
  extra: {
    added: BrowserUseVisibleDomSnapshot['items'];
    updated: BrowserUseVisibleDomSnapshot['items'];
  };
  removedRefs: string[];
  overflow: boolean;
};

type BrowserUseDomJournalDelta = {
  epoch: number;
  stateKey: string;
  added: string[];
  updated: string[];
  removed: string[];
  overflow: boolean;
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

type DomObservationPagination = {
  id: string;
  lines: string[];
  mode: BrowserSnapshotView;
  navigationSequence: number;
  observation: BrowserPageObservation;
  pageMaxChars: number;
  pageStarts: number[];
  page: Page;
  url: string;
};

type AiDomRuntime = {
  version: number;
  mutationState: () => AiDomMutationStateSnapshot;
  pageObservation: () => BrowserPageObservation;
  activeSurfaceElement: () => Element | undefined;
  markSurfaceInteraction: (element: Element) => void;
  actionability: (
    element: Element,
    options?: { action?: string },
  ) => {
    ok: boolean;
    reason: string;
    descriptor: string;
    coveredBy?: string;
    failureKind?: 'occluded';
  };
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
  visibleDomDelta: () => BrowserUseDomDelta;
  journalDomDelta: () => BrowserUseDomJournalDelta;
  discardDomChanges: () => { epoch: number; overflow: boolean; discardedMutations: number };
  discardDomJournal: () => { epoch: number; overflow: boolean; discardedMutations: number };
  elementText: (pathValue: string, options?: { maxChars?: number }) => ({ descriptor: string; text: string; textLength: number } | undefined);
  visibleDomPoint: (
    ref: string,
    viewportClip?: BrowserUseViewportClip,
  ) => ({
    x: number;
    y: number;
    descriptor: string;
    coveredBy?: string;
  } | undefined);
  visibleDomElement: (ref: string) => Element | undefined;
  visibleDomText: (ref: string, options?: { maxChars?: number }) => ({ descriptor: string; text: string; textLength: number } | undefined);
  selectVisibleDomOption: (ref: string, input: { value?: string; label?: string }) => ({
    ok: boolean;
    actual: string;
    value?: string;
    label?: string;
  } | undefined);
  findVisibleDomVirtualOption: (ref: string, input: { value?: string; label?: string }) => Promise<{
    ok: boolean;
    actual: string;
    item?: BrowserUseVisibleDomSnapshot['items'][number];
    point?: { x: number; y: number };
    value?: string;
    label?: string;
  }>;
  scrollVisibleDomVirtualList: (ref: string, input?: { advance?: boolean; top?: number }) => ({
    after: number;
    atBottom: boolean;
    before: number;
    maxTop: number;
    moved: boolean;
  } | undefined);
};

type AiDomMutationStateSnapshot = {
  epoch: number;
  lastMutationAt: number;
  activeSurfaceSignature?: string;
};

type NavigationDomStabilitySample = {
  ready: boolean;
  signature: string;
};

type NavigationDomStabilityResult = {
  stable: boolean;
  waitedMs: number;
  quietMs: number;
  timeoutMs: number;
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
  if (state.document !== document) {
    try { state.observer?.disconnect(); } catch {}
    state.document = document;
    state.observer = undefined;
    state.epoch = 0;
    state.lastMutationAt = Date.now();
    state.activeSurfaceSignature = undefined;
    state.pendingMutations = [];
    state.pendingMutationKeys = new WeakMap();
    state.pendingOverflow = false;
    state.journalMutations = [];
    state.journalOverflow = false;
    state.interactionCounts = {};
    state.interactionSequence = 0;
    state.interactionListenersInstalled = false;
  }
  state.interactionCounts = state.interactionCounts || {};
  state.interactionSequence = Number(state.interactionSequence) || 0;
  win.__aiDomMutationState = state;
  if (!state.observer) {
    state.observer = new MutationObserver((mutations) => {
      let meaningful = false;
      for (const mutation of mutations) {
        const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        if (!target || !target.closest || !target.closest('#__ai_candidate_overlay__, #__ai_mouse_cursor__, #__ai_dom_export_control__')) {
          meaningful = true;
          break;
        }
      }
      if (!meaningful) return;
      state.pendingMutations = state.pendingMutations || [];
      state.journalMutations = state.journalMutations || [];
      for (const mutation of mutations) {
        if (state.journalMutations.length >= 10000) state.journalOverflow = true;
        else state.journalMutations.push(mutation);
        if (state.pendingMutations.length >= 500) {
          state.pendingOverflow = true;
          continue;
        }
        state.pendingMutations.push(mutation);
      }
      state.epoch += 1;
      state.lastMutationAt = Date.now();
    });
    state.observer.observe(document, { attributes: true, characterData: true, childList: true, subtree: true });
  }
  // document.open()/page.setContent() may clear listeners while retaining the
  // same Window and state object. Rebind on every runtime revision instead of
  // trusting a stale boolean left by the previous document lifecycle.
  const interactionTypes = ['click', 'auxclick', 'contextmenu', 'dblclick', 'input', 'change', 'focusin', 'focusout', 'keydown', 'keyup', 'mousemove', 'mouseover', 'wheel', 'scroll', 'dragstart', 'dragover', 'drop'];
  if (state.interactionListenerDocument && state.interactionListener) {
    for (const type of interactionTypes) {
      try { state.interactionListenerDocument.removeEventListener(type, state.interactionListener, { capture: true }); } catch {}
    }
  }
  const markInteraction = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target && target.closest('#__ai_candidate_overlay__, #__ai_mouse_cursor__, #__ai_dom_export_control__')) return;
    state.interactionSequence += 1;
    state.interactionCounts[event.type] = (state.interactionCounts[event.type] || 0) + 1;
    state.lastInteractionType = event.type;
    state.lastInteractionAt = Date.now();
  };
  for (const type of interactionTypes) {
    document.addEventListener(type, markInteraction, { capture: true, passive: true });
  }
  state.interactionListenerDocument = document;
  state.interactionListener = markInteraction;
  state.interactionListenersInstalled = true;
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
  navigationSequence: number;
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
  abortSignal?: AbortSignal;
  target?: BrowserElementTarget;
  /** Internal direct-call shorthand; model-facing tools use target. */
  uid?: string;
  xThousandth?: number;
  yThousandth?: number;
  toTarget?: BrowserElementTarget;
  /** Internal direct-call shorthand; model-facing tools use toTarget. */
  toUid?: string;
  toXThousandth?: number;
  toYThousandth?: number;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  force?: boolean;
  deltaX?: number;
  deltaY?: number;
};

export type BrowserKeyboardAction = {
  action: 'type' | 'press' | 'shortcut';
  target?: BrowserElementTarget;
  /** Internal direct-call shorthand; model-facing tools use target. */
  uid?: string;
  xThousandth?: number;
  yThousandth?: number;
  text?: string;
  key?: string;
  keys?: string[];
  replace?: boolean;
  followByEnter?: boolean;
  allowedOrigins?: string[];
};

export type BrowserLiveInput =
  | {
      kind: 'tab';
      tabId: string;
    }
  | {
      kind: 'move';
      xRatio: number;
      yRatio: number;
    }
  | {
      kind: 'click';
      xRatio: number;
      yRatio: number;
      button?: 'left' | 'right' | 'middle';
      clickCount?: number;
    }
  | {
      kind: 'drag';
      xRatio: number;
      yRatio: number;
      toXRatio: number;
      toYRatio: number;
      button?: 'left' | 'right' | 'middle';
    }
  | {
      kind: 'scroll';
      xRatio: number;
      yRatio: number;
      deltaX: number;
      deltaY: number;
    }
  | {
      kind: 'key';
      key: string;
    }
  | {
      kind: 'text';
      text: string;
    };

export type BrowserSelectOptionAction = {
  abortSignal?: AbortSignal;
  target?: BrowserElementTarget;
  /** Internal direct-call shorthand; model-facing tools use target. */
  uid?: string;
  value?: string;
  label?: string;
};

export type BrowserElementTarget = {
  kind: 'ref';
  ref: string;
};

type ResolvedBrowserActionPoint = {
  error?: string;
  reference?: SnapshotReference | DomNodeReference;
  point?: {
    x: number;
    y: number;
    descriptor: string;
    source: string;
    coveredBy?: string;
  };
};

function isSnapshotReference(reference: SnapshotReference | DomNodeReference): reference is SnapshotReference {
  return 'uid' in reference;
}

type WindowWithAiDomRuntime = Window & {
  __aiBrowserPageRuntimeInstalled?: boolean;
  __aiMoveMouseCursor?: (x: number, y: number, options?: { kind?: string }) => void;
  __aiGetEventListenerTypes?: (target: EventTarget) => string[];
  __aiDomRuntime?: AiDomRuntime;
  __aiDomMutationState?: AiDomMutationStateSnapshot & {
    observer?: MutationObserver;
    pendingMutations?: MutationRecord[];
    pendingMutationKeys?: WeakMap<Node, Set<string>>;
    pendingOverflow?: boolean;
    journalMutations?: MutationRecord[];
    journalOverflow?: boolean;
  };
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
  sequence: number;
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

type InterActionChangeJournal = {
  id: string;
  page: Page;
  startedAt: string;
  requestStartSequence: number;
  added: string[];
  updated: string[];
  removed: string[];
  errors: string[];
  overflow: boolean;
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
  id: string;
  index: number;
  url: string;
  active: boolean;
  groupId: string;
};

export type BrowserScreencastFrame = {
  data: string;
  contentType: 'image/jpeg' | 'image/png';
  capturedAt: string;
  url: string;
  viewport: { width: number; height: number };
  metadata?: unknown;
};

type BrowserLivePreviewStateListener = (tabs: BrowserTabSnapshot[]) => void;

export type BrowserScreencastHandle = {
  metrics: () => BrowserPreviewFramePumpMetrics;
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
  browserServer?: BrowserServer;
  browserCodeConnection: BrowserCodeConnection;
  context: BrowserContext;
  ownership: SharedBrowserOwnership;
  release: (force?: boolean) => Promise<void>;
};

const preparedContextInitScripts = new WeakSet<BrowserContext>();
const sharedPageOwners = new WeakMap<Page, string>();
const livePreviewVisibilityRuntime = ((globalThis as typeof globalThis & {
  __webPilotLivePreviewVisibilityRuntime?: {
    bindingPages: WeakSet<Page>;
    owners: WeakMap<Page, (visible: boolean) => void>;
  };
}).__webPilotLivePreviewVisibilityRuntime ??= {
  bindingPages: new WeakSet<Page>(),
  owners: new WeakMap<Page, (visible: boolean) => void>(),
});
const livePreviewVisibilityBindingPages = livePreviewVisibilityRuntime.bindingPages;
const livePreviewVisibilityOwners = livePreviewVisibilityRuntime.owners;

function installLivePreviewVisibilityReporter() {
  const win = window as Window & {
    __webPilotLivePreviewVisibilityInstalled?: boolean;
    __webPilotReportPageVisibility?: (visible: boolean) => Promise<unknown>;
  };
  if (win.__webPilotLivePreviewVisibilityInstalled) return;
  win.__webPilotLivePreviewVisibilityInstalled = true;
  const report = () => {
    void Promise.resolve(win.__webPilotReportPageVisibility?.(document.visibilityState === 'visible')).catch(() => undefined);
  };
  document.addEventListener('visibilitychange', report, { passive: true });
  report();
}
type SharedBrowserState = {
  key?: string;
  browser?: Browser;
  browserServer?: BrowserServer;
  browserCodeConnection?: BrowserCodeConnection;
  context?: BrowserContext;
  ownership?: SharedBrowserOwnership;
  refCount: number;
  initPromise?: Promise<{
    browser?: Browser;
    browserServer?: BrowserServer;
    browserCodeConnection: BrowserCodeConnection;
    context: BrowserContext;
    ownership: SharedBrowserOwnership;
  }>;
  idleTimer?: ReturnType<typeof setTimeout>;
  managedProfileDir?: string;
};
const sharedBrowserStates = new Map<string, SharedBrowserState>();

type BrowserSessionProcessState = {
  sessions: Set<BrowserSession>;
  shutdownHooksInstalled: boolean;
  shuttingDown?: Promise<void>;
};

const browserSessionProcessState = ((globalThis as typeof globalThis & {
  __webPilotBrowserSessionProcessState?: BrowserSessionProcessState;
}).__webPilotBrowserSessionProcessState ??= {
  sessions: new Set<BrowserSession>(),
  shutdownHooksInstalled: false,
});
browserSessionProcessState.sessions ??= new Set<BrowserSession>();

function sharedBrowserStateFor(runtimeKey: string) {
  let state = sharedBrowserStates.get(runtimeKey);
  if (!state) {
    state = { refCount: 0 };
    sharedBrowserStates.set(runtimeKey, state);
  }
  return state;
}














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

function installAiBrowserPageRuntime(runtimeVersion: number) {
  const win = window as WindowWithAiDomRuntime;
  const mouseCursorId = '__ai_mouse_cursor__';
  const mountMouseCursor = () => {
    const existing = document.getElementById(mouseCursorId);
    if (existing) return existing;
    if (!document.documentElement) return undefined;
    const cursor = document.createElement('div');
    cursor.id = mouseCursorId;
    cursor.setAttribute('aria-hidden', 'true');
    const startX = Math.max(0, Math.round(window.innerWidth / 2));
    const startY = Math.max(0, Math.round(window.innerHeight / 2));
    cursor.dataset.x = String(startX);
    cursor.dataset.y = String(startY);
    Object.assign(cursor.style, {
      contain: 'layout style paint',
      height: '34px',
      left: '0',
      opacity: '0',
      pointerEvents: 'none',
      position: 'fixed',
      top: '0',
      transform: `translate3d(${startX}px, ${startY}px, 0)`,
      transformOrigin: '0 0',
      width: '30px',
      willChange: 'transform, opacity',
      zIndex: '2147483647',
    });
    const pointer = document.createElement('div');
    const cursorSvg = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="23" height="30" viewBox="0 0 32 42">',
      '<path d="M4 3v28.5l7.3-6.9 4.7 12.2 5.6-2.2-4.8-11.8h10.6L4 3z" fill="white" stroke="#111827" stroke-width="2.2" stroke-linejoin="round"/>',
      '<circle cx="25" cy="8" r="5" fill="#2563eb" stroke="white" stroke-width="2"/>',
      '</svg>',
    ].join('');
    Object.assign(pointer.style, {
      backgroundImage: `url("data:image/svg+xml,${encodeURIComponent(cursorSvg)}")`,
      backgroundRepeat: 'no-repeat',
      backgroundSize: '23px 30px',
      filter: 'drop-shadow(0 3px 5px rgba(0, 0, 0, 0.42))',
      height: '30px',
      left: '0',
      position: 'absolute',
      top: '0',
      width: '23px',
    });
    const pulse = document.createElement('div');
    pulse.dataset.aiMousePulse = 'true';
    Object.assign(pulse.style, {
      border: '2px solid rgba(37, 99, 235, .9)',
      borderRadius: '999px',
      height: '18px',
      left: '-8px',
      opacity: '0',
      position: 'absolute',
      top: '-8px',
      width: '18px',
    });
    cursor.append(pointer, pulse);
    document.documentElement.appendChild(cursor);
    return cursor;
  };
  Object.defineProperty(win, '__aiMoveMouseCursor', {
    configurable: true,
    enumerable: false,
    value: (rawX: number, rawY: number, options: { kind?: string } = {}) => {
      const cursor = mountMouseCursor();
      if (!cursor) return;
      const x = Math.max(0, Math.min(Math.round(Number(rawX) || 0), Math.max(0, window.innerWidth - 1)));
      const y = Math.max(0, Math.min(Math.round(Number(rawY) || 0), Math.max(0, window.innerHeight - 1)));
      cursor.dataset.x = String(x);
      cursor.dataset.y = String(y);
      cursor.style.opacity = '1';
      cursor.style.transition = 'none';
      cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      if (options.kind === 'click' || options.kind === 'double' || options.kind === 'right') {
        const pulse = cursor.querySelector<HTMLElement>('[data-ai-mouse-pulse="true"]');
        pulse?.animate([
          { opacity: 0.9, transform: 'scale(.35)' },
          { opacity: 0, transform: 'scale(1.65)' },
        ], { duration: 320, easing: 'ease-out' });
      }
    },
    writable: false,
  });
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
        return !target?.closest?.('#__ai_candidate_overlay__, #__ai_mouse_cursor__, #__ai_dom_export_control__');
      });
      if (!meaningful) return;
      mutationState.pendingMutations = mutationState.pendingMutations || [];
      mutationState.pendingMutationKeys = mutationState.pendingMutationKeys || new WeakMap<Node, Set<string>>();
      mutationState.journalMutations = mutationState.journalMutations || [];
      for (const mutation of mutations) {
        if (mutationState.journalMutations.length >= 10000) mutationState.journalOverflow = true;
        else mutationState.journalMutations.push(mutation);
        if (mutationState.pendingMutations.length >= 500) {
          mutationState.pendingOverflow = true;
          continue;
        }
        if (mutation.type !== 'childList') {
          const key = mutation.type === 'attributes' ? `attributes:${mutation.attributeName || ''}` : mutation.type;
          let keys = mutationState.pendingMutationKeys.get(mutation.target);
          if (!keys) {
            keys = new Set<string>();
            mutationState.pendingMutationKeys.set(mutation.target, keys);
          }
          if (keys.has(key)) continue;
          keys.add(key);
        }
        mutationState.pendingMutations.push(mutation);
      }
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

  if (win.__aiDomRuntime?.version === runtimeVersion) return;

  const skippedTags = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'head', 'br', 'hr', 'wbr']);
  const nativeActionableTags = new Set(['button', 'details', 'input', 'option', 'select', 'summary', 'textarea']);
  const normalize = (value?: string | null) => String(value || '').replace(/\s+/g, ' ').trim();

  function isOverlay(element: Element) {
    return Boolean(element.closest('#__ai_candidate_overlay__, #__ai_mouse_cursor__, #__ai_dom_export_control__'));
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
      || (element as HTMLElement).inert
      || element.hasAttribute('inert')
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
      || style.contentVisibility === 'hidden'
      || Number(style.opacity || '1') <= 0.01;
  }

  function hasVisibleDomPointerEvents(element: Element) {
    return visibleDomStyle(element)?.pointerEvents !== 'none';
  }

  function isVisibleDomSubtreeHidden(element: Element) {
    let current: Element | undefined = element;
    for (let guard = 0; current && guard < 256; guard += 1) {
      if (
        !isTraversable(current)
        || isOverlay(current)
        || isVisibleDomHidden(current)
        || isVisibleDomStyleHidden(current)
      ) {
        return true;
      }
      current = flatParentElement(current);
    }
    return false;
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

  function visibleDomHoverElements() {
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
    const matches = new Set<Element>();
    for (const selector of Array.from(new Set(selectors)).slice(0, 600)) {
      try {
        for (const element of Array.from(document.querySelectorAll(selector))) matches.add(element);
      } catch {
        // Ignore selectors that cannot be queried outside their rule context.
      }
    }
    return matches;
  }

  function visibleDomInteractionSignals(element: Element, hoverElements: Set<Element> = new Set()) {
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
    const className = typeof element.className === 'string' ? element.className : '';
    if (shouldInspectCssHover && (hoverElements.has(element) || /(^|\s)hover[:_-]/.test(className))) signals.push('hover-css');
    const style = window.getComputedStyle(element);
    if (/^(auto|scroll)$/.test(style.overflowY)
      && element.children.length >= 3
      && (element as HTMLElement).clientHeight > 0
      && (element as HTMLElement).scrollHeight > (element as HTMLElement).clientHeight * 1.5) signals.push('virtual-list');
    return Array.from(new Set(signals));
  }

  function hasVisibleDomOwnClickBoundary(element: Element) {
    const role = normalizeVisibleDomText(element.getAttribute('role') || '').toLowerCase();
    return hasNativeActionSignal(element)
      || element.hasAttribute('onclick')
      || hasActionAttribute(element)
      || visibleDomActionRolePattern.test(role)
      || recordedEventTypes(element).some((type) => visibleDomClickEventPattern.test(type))
      || (element.hasAttribute('tabindex') && element.getAttribute('tabindex') !== '-1');
  }

  function visibleDomSvgActionScope(element: Element) {
    if (element.namespaceURI !== 'http://www.w3.org/2000/svg') return '';
    if (visibleDomElementName(element) !== 'svg') return hasVisibleDomOwnClickBoundary(element) ? 'own' : 'graphic';
    const stack = Array.from(element.children).reverse();
    let visited = 0;
    while (stack.length && visited < 256) {
      const current = stack.pop()!;
      visited += 1;
      if (hasVisibleDomOwnClickBoundary(current)) return 'container';
      for (const child of Array.from(current.children).reverse()) stack.push(child);
    }
    return 'own';
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
    if (signals.includes('virtual-list')) capabilities.add('scroll');
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
    if (signals.includes('virtual-list')) return 'medium';
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

  function visibleDomSelectOptions(element: HTMLSelectElement) {
    return Array.from(element.options).map((option) => {
      const label = normalizeVisibleDomText(option.label || option.text || option.textContent || '');
      const value = normalizeVisibleDomText(option.value || '');
      return `${option.selected ? '*' : ''}${value || '[empty]'}=${label || '[empty]'}`;
    }).join(' | ');
  }

  function visibleDomItem(element: Element, ref: string, signals: string[] = []) {
    const tag = visibleDomElementName(element);
    const attrs = [`node_id=${ref}`];
    const surfaceId = surfaceIdForElement(element);
    if (surfaceId) attrs.push(`surface="${escapeVisibleDomText(surfaceId)}"`);
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
    const svgActionScope = visibleDomSvgActionScope(element);
    if (svgActionScope) attrs.push(`action_scope="${svgActionScope}"`);
    if (tag === 'select') {
      const select = element as HTMLSelectElement;
      const selected = select.selectedOptions[0];
      const options = visibleDomSelectOptions(select);
      attrs.push(`option_count="${select.options.length}"`);
      if (selected) attrs.push(`selected_value="${escapeVisibleDomText(selected.value)}"`);
      if (options) attrs.push(`options="${escapeVisibleDomText(options)}"`);
    }
    if (signals.includes('virtual-list')) {
      const target = element as HTMLElement;
      const childHeights = Array.from(element.children).slice(0, 20)
        .map((child) => child.getBoundingClientRect().height)
        .filter((height) => height > 1)
        .sort((left, right) => left - right);
      const medianHeight = childHeights.length ? childHeights[Math.floor(childHeights.length / 2)] : 0;
      const estimatedItems = medianHeight > 0 ? Math.max(element.children.length, Math.round(target.scrollHeight / medianHeight)) : element.children.length;
      const firstVisibleIndex = medianHeight > 0 ? Math.max(0, Math.floor(target.scrollTop / medianHeight)) : 0;
      attrs.push('virtualized="possible"');
      attrs.push('actions="scroll,search"');
      attrs.push(`visible_children="${element.children.length}"`);
      attrs.push(`estimated_items="${estimatedItems}"`);
      attrs.push(`visible_range="${firstVisibleIndex + 1}-${Math.min(estimatedItems, firstVisibleIndex + element.children.length)}"`);
      attrs.push(`scroll_top="${Math.round(target.scrollTop)}"`);
      attrs.push(`scroll_height="${Math.round(target.scrollHeight)}"`);
    }
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
    const viewport = visualViewportRect();
    const inModal = Boolean(element.closest('dialog[open], [aria-modal="true"]'));
    const containsFocus = element === document.activeElement || Boolean(element.contains(document.activeElement));
    const inViewport = Boolean(rect && rect.right > viewport.left && rect.left < viewport.right && rect.bottom > viewport.top && rect.top < viewport.bottom);
    const priority = (inModal ? 60 : 0) + (containsFocus ? 35 : 0) + (inViewport ? 20 : 0) + (confidence === 'high' ? 10 : confidence === 'medium' ? 5 : 0);
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
      priority,
      rect,
      signals,
      state: interactive ? visibleDomInteractiveStateForElement(element, signals) : '',
      surfaceId,
      tag,
      text: textEntry,
    };
  }

  function isVisibleDomExtraElement(element: Element, signals: string[]) {
    if (isVisibleDomSubtreeHidden(element) || !hasVisibleDomPointerEvents(element)) return false;
    // `added` and `updated` remain the actionable channel. Extra deliberately
    // carries only semantic context that is not an action candidate.
    if (signals.length) return false;
    const tag = visibleDomElementName(element);
    if (new Set(['dd', 'details', 'dt', 'figcaption', 'label', 'legend', 'li', 'option', 'p', 'td', 'textarea', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']).has(tag)
      && visibleDomTextContent(element)) return true;
    if (new Set(['article', 'aside', 'div', 'fieldset', 'footer', 'form', 'header', 'main', 'nav', 'section', 'span']).has(tag)
      && visibleDomOwnTextContent(element)) return true;
    return visibleDomMeaningfulAttributes.some((name) => Boolean(visibleDomAttributeValue(element, name)));
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
    const hoverElements = visibleDomHoverElements();

    const stop = () => truncated || items.length >= maxElements || chars >= maxChars;
    const pushItem = (element: Element, path: string, signals: string[] = []) => {
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
        path,
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
    const visit = (node: Node, path = '0') => {
      if (stop()) return;
      if (node.nodeType === Node.DOCUMENT_NODE) {
        const root = document.documentElement;
        if (root) visit(root, '0');
        return;
      }
      if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        for (const [index, child] of Array.from((node as DocumentFragment).children).entries()) {
          if (stop()) break;
          visit(child, `${path}.${index}`);
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const element = node as Element;
      if (isDisplayNone(element)) return;
      const tag = visibleDomElementName(element);
      if (tag === 'frame' || tag === 'iframe') pushFrame(element);
      const signals = visibleDomInteractionSignals(element, hoverElements);
      if (
        signals.length
        && !isVisibleDomSubtreeHidden(element)
        && hasVisibleDomPointerEvents(element)
        && visibleDomClickablePoint(element, viewportClip)
      ) {
        pushItem(element, path, signals);
      }
      for (const [index, child] of children(element).entries()) {
        if (stop()) break;
        visit(child, `${path}.${index}`);
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
    const hoverElements = visibleDomHoverElements();

    const structuralTextTags = new Set([
      'a', 'button', 'dd', 'details', 'dt', 'figcaption', 'input', 'label', 'legend', 'li',
      'option', 'p', 'select', 'summary', 'td', 'textarea', 'th',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    ]);
    const directTextContainerTags = new Set(['article', 'aside', 'div', 'fieldset', 'footer', 'form', 'header', 'main', 'nav', 'section', 'span']);
    const signalCache = new WeakMap<Element, string[]>();
    const stop = () => truncated || items.length >= maxElements || chars >= maxChars;
    const hasMeaningfulAttributes = (element: Element) => visibleDomMeaningfulAttributes.some((name) => Boolean(visibleDomAttributeValue(element, name)));
    const actionableSignals = (element: Element) => {
      const cached = signalCache.get(element);
      if (cached) return cached;
      const signals = visibleDomInteractionSignals(element, hoverElements);
      const actionable = signals.length && renderedDomRect(element) ? signals : [];
      signalCache.set(element, actionable);
      return actionable;
    };
    const shouldIncludeElement = (element: Element) => {
      if (isVisibleDomSubtreeHidden(element) || !hasVisibleDomPointerEvents(element)) return false;
      const tag = visibleDomElementName(element);
      if (actionableSignals(element).length) return true;
      if (structuralTextTags.has(tag) && visibleDomTextContent(element)) return true;
      if (directTextContainerTags.has(tag) && visibleDomOwnTextContent(element)) return true;
      return hasMeaningfulAttributes(element);
    };
    const pushItem = (element: Element, path: string, signals: string[] = []) => {
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
        path,
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
    const visit = (node: Node, path = '0') => {
      if (stop()) return;
      if (node.nodeType === Node.DOCUMENT_NODE) {
        const root = document.documentElement;
        if (root) visit(root, '0');
        return;
      }
      if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        for (const [index, child] of Array.from((node as DocumentFragment).children).entries()) {
          if (stop()) break;
          visit(child, `${path}.${index}`);
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const element = node as Element;
      if (isDisplayNone(element)) return;
      const tag = visibleDomElementName(element);
      if (tag === 'frame' || tag === 'iframe') pushFrame(element);
      if (shouldIncludeElement(element)) pushItem(element, path, actionableSignals(element));
      for (const [index, child] of children(element).entries()) {
        if (stop()) break;
        visit(child, `${path}.${index}`);
      }
    };

    visit(document);
    return { frameElements, items, stateKey: state.instanceId, viewport };
  }

  function discardDomChanges() {
    const discardedMutations = mutationState.pendingMutations?.length || 0;
    const overflow = Boolean(mutationState.pendingOverflow);
    mutationState.pendingMutations = [];
    mutationState.pendingMutationKeys = new WeakMap<Node, Set<string>>();
    mutationState.pendingOverflow = false;
    return { epoch: mutationState.epoch, overflow, discardedMutations };
  }

  function discardDomJournal() {
    const discardedMutations = mutationState.journalMutations?.length || 0;
    const overflow = Boolean(mutationState.journalOverflow);
    mutationState.journalMutations = [];
    mutationState.journalOverflow = false;
    return { epoch: mutationState.epoch, overflow, discardedMutations };
  }

  function journalDomLine(element: Element) {
    const tag = visibleDomElementName(element) || 'element';
    const attrs = ['extra=true'];
    for (const name of visibleDomRenderedAttributes) {
      const value = visibleDomAttributeValue(element, name);
      if (value) attrs.push(`${name}="${escapeVisibleDomText(value)}"`);
    }
    for (const name of visibleDomBooleanAttributes) {
      if (element.hasAttribute(name)) attrs.push(`${name}="true"`);
    }
    const text = visibleDomTextContent(element, 400);
    return `<${tag} ${attrs.join(' ')}>${text ? ` ${escapeVisibleDomText(text)}` : ''}`;
  }

  function journalDomDelta(): BrowserUseDomJournalDelta {
    const pending = [...(mutationState.journalMutations || [])];
    const overflow = Boolean(mutationState.journalOverflow);
    mutationState.journalMutations = [];
    mutationState.journalOverflow = false;
    const added = new Set<string>();
    const updated = new Set<string>();
    const removed = new Set<string>();
    let remainingNodes = 10000;
    const asElement = (node: Node | null | undefined) => {
      if (!node) return undefined;
      if (node.nodeType === Node.ELEMENT_NODE) return node as Element;
      return flatParentElement(node);
    };
    const collect = (node: Node, destination: Set<string>) => {
      const root = asElement(node);
      if (!root) return;
      const stack = [root];
      while (stack.length && remainingNodes > 0) {
        const element = stack.pop()!;
        remainingNodes -= 1;
        if (isOverlay(element)) continue;
        destination.add(journalDomLine(element));
        const rootNode = shadowRootOf(element);
        if (rootNode) for (const child of Array.from(rootNode.children).reverse()) stack.push(child);
        for (const child of Array.from(element.children).reverse()) stack.push(child);
      }
    };
    for (const mutation of pending) {
      if (mutation.type === 'childList') {
        for (const node of Array.from(mutation.addedNodes)) collect(node, added);
        for (const node of Array.from(mutation.removedNodes)) collect(node, removed);
        const target = asElement(mutation.target);
        if (target && !isOverlay(target)) updated.add(journalDomLine(target));
      } else {
        const target = asElement(mutation.target);
        if (target && !isOverlay(target)) updated.add(journalDomLine(target));
      }
    }
    return {
      epoch: mutationState.epoch,
      stateKey: visibleDomState().instanceId,
      added: [...added],
      updated: [...updated],
      removed: [...removed],
      overflow: overflow || remainingNodes <= 0,
    };
  }

  function visibleDomDelta(): BrowserUseDomDelta {
    const state = visibleDomState();
    const pending = [...(mutationState.pendingMutations || [])];
    const overflow = Boolean(mutationState.pendingOverflow);
    mutationState.pendingMutations = [];
    mutationState.pendingMutationKeys = new WeakMap<Node, Set<string>>();
    mutationState.pendingOverflow = false;
    if (!pending.length) {
      return {
        epoch: mutationState.epoch,
        stateKey: state.instanceId,
        observation: pageObservation(),
        added: [],
        updated: [],
        extra: { added: [], updated: [] },
        removedRefs: [],
        overflow,
      };
    }
    const addedRoots = new Set<Element>();
    const updatedRoots = new Set<Element>();
    const removedRefs = new Set<string>();
    const maxNodes = 10000;
    let remainingNodes = maxNodes;
    let remainingRemovedNodes = maxNodes;
    const hoverElements = visibleDomHoverElements();

    const asElement = (node: Node | null | undefined) => {
      if (!node) return undefined;
      if (node.nodeType === Node.ELEMENT_NODE) return node as Element;
      return flatParentElement(node);
    };
    const semanticMutationRoot = (element: Element | undefined) => {
      let current = element;
      for (let guard = 0; current && guard < 128; guard += 1) {
        const ref = state.elementToRef.get(current);
        const broadDocumentContainer = current === document.body || current === document.documentElement;
        if ((ref && state.refToElement.has(ref)) || (!broadDocumentContainer && isActionable(current))) return current;
        current = flatParentElement(current);
      }
      return element;
    };
    const rememberRemoved = (node: Node) => {
      const stack: Node[] = [node];
      while (stack.length && remainingRemovedNodes > 0) {
        const current = stack.pop()!;
        remainingRemovedNodes -= 1;
        if (current.nodeType === Node.ELEMENT_NODE) {
          const element = current as Element;
          const ref = state.elementToRef.get(element);
          if (ref) removedRefs.add(ref);
          for (const child of Array.from(element.children)) stack.push(child);
          const root = shadowRootOf(element);
          if (root) for (const child of Array.from(root.children)) stack.push(child);
        }
      }
    };

    for (const mutation of pending) {
      const target = asElement(mutation.target);
      if (mutation.type === 'childList') {
        // The inserted subtree supplies new UIDs. Only update a small tracked
        // container itself; never rescan a broad parent such as <body>.
        const semanticTarget = semanticMutationRoot(target);
        if (semanticTarget && !isOverlay(semanticTarget) && semanticTarget.children.length <= 64) {
          updatedRoots.add(semanticTarget);
        }
        for (const node of Array.from(mutation.addedNodes)) {
          const element = asElement(node);
          if (element && !isOverlay(element)) addedRoots.add(element);
        }
        for (const node of Array.from(mutation.removedNodes)) rememberRemoved(node);
      } else if (target && !isOverlay(target)) {
        updatedRoots.add(semanticMutationRoot(target) || target);
      }
    }

    const addedByRef = new Map<string, BrowserUseVisibleDomSnapshot['items'][number]>();
    const updatedByRef = new Map<string, BrowserUseVisibleDomSnapshot['items'][number]>();
    const extraAddedByRef = new Map<string, BrowserUseVisibleDomSnapshot['items'][number]>();
    const extraUpdatedByRef = new Map<string, BrowserUseVisibleDomSnapshot['items'][number]>();
    const hasAncestorRoot = (element: Element, roots: Set<Element>) => {
      let parent = flatParentElement(element);
      for (let guard = 0; parent && guard < 128; guard += 1) {
        if (roots.has(parent)) return true;
        parent = flatParentElement(parent);
      }
      return false;
    };
    const inspect = (
      element: Element,
      destination: Map<string, BrowserUseVisibleDomSnapshot['items'][number]>,
      extraDestination: Map<string, BrowserUseVisibleDomSnapshot['items'][number]>,
    ) => {
      if (!element.isConnected || isOverlay(element) || isDisplayNone(element)) return;
      const signals = visibleDomInteractionSignals(element, hoverElements);
      if (signals.length && !isVisibleDomSubtreeHidden(element) && hasVisibleDomPointerEvents(element) && renderedDomRect(element)) {
        const ref = visibleDomRef(element);
        state.refToElement.set(ref, element);
        removedRefs.delete(ref);
        destination.set(ref, {
          ...visibleDomItem(element, ref, signals),
          descriptor: descriptor(element),
          path: pathOf(element) || '',
          ref,
        });
      } else if (isVisibleDomExtraElement(element, signals)) {
        const ref = visibleDomRef(element);
        extraDestination.set(ref, {
          ...visibleDomItem(element, ref, signals),
          descriptor: descriptor(element),
          path: pathOf(element) || '',
          ref,
        });
      } else {
        const ref = state.elementToRef.get(element);
        if (ref) removedRefs.add(ref);
      }
    };
    const collectSubtree = (
      root: Element,
      destination: Map<string, BrowserUseVisibleDomSnapshot['items'][number]>,
      extraDestination: Map<string, BrowserUseVisibleDomSnapshot['items'][number]>,
    ) => {
      const stack: Element[] = [root];
      while (stack.length && remainingNodes > 0) {
        const element = stack.pop()!;
        remainingNodes -= 1;
        inspect(element, destination, extraDestination);
        if (!element.isConnected || isOverlay(element) || isVisibleDomSubtreeHidden(element)) continue;
        const rootNode = shadowRootOf(element);
        if (rootNode) for (const child of Array.from(rootNode.children).reverse()) stack.push(child);
        for (const child of Array.from(element.children).reverse()) stack.push(child);
      }
    };

    for (const root of addedRoots) {
      if (!hasAncestorRoot(root, addedRoots)) collectSubtree(root, addedByRef, extraAddedByRef);
      if (remainingNodes <= 0) break;
    }
    for (const root of updatedRoots) {
      if (hasAncestorRoot(root, addedRoots) || hasAncestorRoot(root, updatedRoots)) continue;
      if (remainingNodes <= 0) break;
      remainingNodes -= 1;
      inspect(root, updatedByRef, extraUpdatedByRef);
    }
    for (const ref of addedByRef.keys()) removedRefs.delete(ref);
    for (const ref of removedRefs) state.refToElement.delete(ref);
    return {
      epoch: mutationState.epoch,
      stateKey: state.instanceId,
      observation: pageObservation(),
      added: [...addedByRef.values()],
      updated: [...updatedByRef.values()].filter((item) => !addedByRef.has(item.ref)),
      extra: {
        added: [...extraAddedByRef.values()],
        updated: [...extraUpdatedByRef.values()].filter((item) => !extraAddedByRef.has(item.ref)),
      },
      removedRefs: [...removedRefs],
      overflow,
    };
  }

  function visibleDomCoveredPoint(element: Element, viewportClip: BrowserUseViewportClip) {
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
    let firstCovered: { x: number; y: number; coveredBy: string } | undefined;
    for (const [rawX, rawY] of samples) {
      const x = Math.min(Math.max(rawX, 0), window.innerWidth - 1);
      const y = Math.min(Math.max(rawY, 0), window.innerHeight - 1);
      const cover = topmostRenderableAt(x, y, { requirePointerEvents: true });
      if (!cover || cover === element || composedContains(element, cover)) continue;
      const candidate = {
        x,
        y,
        coveredBy: descriptor(cover),
      };
      firstCovered ||= candidate;
    }
    return firstCovered;
  }

  function visibleDomPoint(ref: string, viewportClip?: BrowserUseViewportClip) {
    const element = visibleDomState().refToElement.get(ref);
    if (!element?.isConnected) return undefined;
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const clip = viewportClip || visualViewportRect();
    const clickablePoint = visibleDomClickablePoint(element, clip);
    if (clickablePoint) return { ...clickablePoint, descriptor: descriptor(element) };
    const coveredPoint = visibleDomCoveredPoint(element, clip);
    if (coveredPoint) return { ...coveredPoint, descriptor: descriptor(element) };
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

  function visibleDomElement(ref: string) {
    const element = visibleDomState().refToElement.get(ref);
    if (!element?.isConnected) return undefined;
    return actionableTargetFor(element);
  }

  function scrollVisibleDomVirtualList(ref: string, input: { advance?: boolean; top?: number } = {}) {
    const element = visibleDomState().refToElement.get(ref) as HTMLElement | undefined;
    if (!element?.isConnected || element.clientHeight <= 0 || element.scrollHeight <= element.clientHeight) return undefined;
    const before = element.scrollTop;
    const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const requested = input.advance === false
      ? before
      : Number.isFinite(input.top)
      ? Number(input.top)
      : before + Math.max(1, Math.round(element.clientHeight * 0.85));
    element.scrollTop = Math.max(0, Math.min(maxTop, requested));
    const after = element.scrollTop;
    return { after, atBottom: after >= maxTop - 1, before, maxTop, moved: Math.abs(after - before) >= 1 };
  }

  async function findVisibleDomVirtualOption(ref: string, input: { value?: string; label?: string }) {
    const state = visibleDomState();
    const container = state.refToElement.get(ref) as HTMLElement | undefined;
    if (!container?.isConnected) {
      return { ok: false, actual: 'The virtual-list container is no longer connected.' };
    }
    if (container.clientHeight <= 0 || container.scrollHeight <= container.clientHeight) {
      return { ok: false, actual: 'The target is not a scrollable virtual-list container.' };
    }
    const expectedValue = normalizeVisibleDomText(input.value || '');
    const expectedLabel = normalizeVisibleDomText(input.label || '');
    if (!expectedValue && !expectedLabel) {
      return { ok: false, actual: 'Virtual-list selection requires an exact value or full label.' };
    }

    const optionValues = (element: Element) => visibleDomUniqueText([
      element.getAttribute('value') || '',
      element.getAttribute('data-value') || '',
      element.getAttribute('data-key') || '',
      element.getAttribute('data-id') || '',
    ].map(normalizeVisibleDomText));
    const optionLabels = (element: Element) => visibleDomUniqueText([
      element.getAttribute('aria-label') || '',
      element.getAttribute('title') || '',
      visibleDomTextContent(element, 1000),
    ].map(normalizeVisibleDomText));
    const exactMatch = (element: Element) => expectedValue
      ? optionValues(element).includes(expectedValue)
      : optionLabels(element).includes(expectedLabel);
    let lastCandidateLabels: string[] = [];
    const currentMatches = () => {
      const matches: Array<{ element: Element; signals: string[] }> = [];
      const seen = new Set<Element>();
      const candidateLabels: string[] = [];
      const stack = children(container).reverse();
      while (stack.length) {
        const element = stack.pop()!;
        if (!element.isConnected || isVisibleDomSubtreeHidden(element)) continue;
        const actionTarget = actionableTargetFor(element);
        if (actionTarget !== container && !seen.has(actionTarget)) {
          const signals = visibleDomInteractionSignals(actionTarget);
          const capabilities = visibleDomActionCapabilities(actionTarget, signals);
          if (capabilities.includes('click') && renderedDomRect(actionTarget)) {
            candidateLabels.push(...optionLabels(actionTarget));
            if (exactMatch(actionTarget)) {
              seen.add(actionTarget);
              matches.push({ element: actionTarget, signals });
            }
          }
        }
        const root = shadowRootOf(element);
        if (root) stack.push(...Array.from(root.children).reverse());
        stack.push(...Array.from(element.children).reverse());
      }
      lastCandidateLabels = visibleDomUniqueText(candidateLabels).slice(0, 12);
      return matches;
    };
    const settle = () => new Promise<void>((resolve) => {
      window.setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 40);
    });
    const originalTop = container.scrollTop;
    const originalOverflowAnchor = container.style.overflowAnchor;
    const originalScrollBehavior = container.style.scrollBehavior;
    // Recycling rows changes spacer heights. Disable scroll anchoring while scanning so
    // Chromium does not compensate for those mutations and silently skip ranges.
    container.style.overflowAnchor = 'none';
    container.style.scrollBehavior = 'auto';
    const deadline = performance.now() + 6000;
    let scanSteps = 0;

    try {
      while (performance.now() < deadline && scanSteps < 500) {
        scanSteps += 1;
        const matches = currentMatches();
        if (matches.length > 1) {
          container.scrollTop = originalTop;
          container.dispatchEvent(new Event('scroll'));
          await settle();
          return {
            ok: false,
            actual: `Virtual-list option is ambiguous: ${matches.length} mounted elements match the exact ${expectedValue ? 'value' : 'label'}.`,
          };
        }
        if (matches.length === 1) {
          matches[0].element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          await settle();
          const settledMatches = currentMatches();
          if (settledMatches.length === 1) {
            const target = settledMatches[0].element;
            const point = visibleDomClickablePoint(target, visualViewportRect());
            if (!point) {
              return {
                ok: false,
                actual: 'The exact virtual-list option is mounted but has no uncovered viewport click point.',
              };
            }
            const targetRef = visibleDomRef(target);
            state.refToElement.set(targetRef, target);
            const value = optionValues(target)[0] || '';
            const label = optionLabels(target)[0] || '';
            return {
              ok: true,
              actual: `Found one exact virtual-list option for ${expectedValue ? `value "${expectedValue}"` : `label "${expectedLabel}"`}.`,
              value,
              label,
              point,
              item: {
                ...visibleDomItem(target, targetRef, settledMatches[0].signals),
                descriptor: descriptor(target),
                path: pathOf(target) || '',
                ref: targetRef,
              },
            };
          }
        }

        const before = Math.round(container.scrollTop);
        const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
        if (before >= maxTop - 1) break;
        const next = Math.min(maxTop, before + Math.max(1, Math.round(container.clientHeight * 0.5)));
        if (next <= before) break;
        container.scrollTop = next;
        container.dispatchEvent(new Event('scroll'));
        await settle();
      }

      const finalScanTop = Math.round(container.scrollTop);
      container.scrollTop = originalTop;
      container.dispatchEvent(new Event('scroll'));
      await settle();
      return {
        ok: false,
        actual: `No virtual-list option matched the exact ${expectedValue ? `value "${expectedValue}"` : `label "${expectedLabel}"`} within the bounded scan (${scanSteps} steps; final scrollTop=${finalScanTop}; last mounted labels=${lastCandidateLabels.join(' | ') || '[none]'}).`,
      };
    } finally {
      container.style.overflowAnchor = originalOverflowAnchor;
      container.style.scrollBehavior = originalScrollBehavior;
    }
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

  let cachedSurfaceEpoch = -1;
  let cachedSurfaceFocus: Element | null = null;
  let surfaceActivationSequence = 0;
  let previousVisibleSurfaceElements = new Set<Element>();
  let surfaceBaselineEstablished = false;
  const recognizedDynamicOverlayElements = new WeakSet<Element>();
  let pendingSurfaceParent: { element: Element; at: number } | undefined;
  const surfaceActivationOrder = new WeakMap<Element, number>();
  const inferredSurfaceParents = new WeakMap<Element, Element>();
  let cachedSurfaceState: {
    activeEntry?: { element: Element; order: number; score: number; surface: BrowserActiveSurface };
    entries: Array<{ element: Element; order: number; score: number; surface: BrowserActiveSurface }>;
    focused?: Element;
    scopeEntries: Array<{ element: Element; order: number; score: number; surface: BrowserActiveSurface }>;
    surfaceStack: BrowserActiveSurface[];
  } | undefined;

  function resolveSurfaceState() {
    const focused = document.activeElement instanceof Element && document.activeElement !== document.body
      ? document.activeElement
      : undefined;
    if (
      cachedSurfaceState
      && cachedSurfaceEpoch === mutationState.epoch
      && cachedSurfaceFocus === (focused || null)
    ) return cachedSurfaceState;
    const candidates = new Set<Element>();
    const controlledCandidates = new Set<Element>();
    const interactiveSurfaceCandidates = new Set<Element>();
    const surfaceControllers = new Map<Element, Element[]>();
    const explicitSurfaceSelector = [
      'dialog[open]',
      '[aria-modal="true"]',
      '[role="dialog"]',
      '[role="alertdialog"]',
      '[role="menu"]',
      '[role="listbox"]',
      '[role="tree"]',
      '[role="grid"]',
    ].join(',');
    for (const element of Array.from(document.querySelectorAll(explicitSurfaceSelector))) candidates.add(element);
    try {
      for (const element of Array.from(document.querySelectorAll(':popover-open'))) candidates.add(element);
    } catch {
      // Older Chromium builds may not support :popover-open.
    }
    for (const controller of Array.from(document.querySelectorAll('[aria-expanded="true"][aria-controls]'))) {
      for (const id of normalize(controller.getAttribute('aria-controls')).split(/\s+/).filter(Boolean)) {
        const controlled = document.getElementById(id);
        if (!controlled) continue;
        candidates.add(controlled);
        controlledCandidates.add(controlled);
        surfaceControllers.set(controlled, [...(surfaceControllers.get(controlled) || []), controller]);
      }
    }

    const interactiveSurfaceItemSelector = [
      '[role="menuitem"]',
      '[role="menuitemcheckbox"]',
      '[role="menuitemradio"]',
      '[role="option"]',
      '[role="treeitem"]',
      'button',
      'input',
      'select',
      'textarea',
      'a[href]',
      '[tabindex]',
      '[contenteditable="true"]',
    ].join(',');
    for (const item of Array.from(document.querySelectorAll(interactiveSurfaceItemSelector))) {
      let current: Element | undefined = item;
      for (let guard = 0; current && guard < 16; guard += 1) {
        const style = visibleDomStyle(current);
        const zIndex = Number.parseInt(style?.zIndex || '', 10);
        if (
          style
          && ['absolute', 'fixed'].includes(style.position)
          && Number.isFinite(zIndex)
          && zIndex >= 500
        ) {
          candidates.add(current);
          interactiveSurfaceCandidates.add(current);
          break;
        }
        current = flatParentElement(current);
      }
    }

    const allElements = Array.from(document.body?.querySelectorAll('*') || []);
    const all = allElements.length <= 6000
      ? allElements
      : [...allElements.slice(0, 3000), ...allElements.slice(-3000)];
    for (const element of all) {
      if (isOverlay(element) || isVisibleDomSubtreeHidden(element)) continue;
      const style = visibleDomStyle(element);
      if (!style || !['absolute', 'fixed', 'sticky'].includes(style.position)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 2 || rect.height <= 2) continue;
      const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
      const areaRatio = Math.min(1, Math.max(0, rect.width * rect.height / viewportArea));
      const zIndex = Number.parseInt(style.zIndex, 10);
      const focusedInside = Boolean(focused && composedContains(element, focused));
      const horizontalChrome = (
        (rect.top <= 2 || rect.bottom >= window.innerHeight - 2)
        && rect.width >= window.innerWidth * 0.72
        && rect.height <= window.innerHeight * 0.28
      );
      const verticalChrome = (
        (rect.left <= 2 || rect.right >= window.innerWidth - 2)
        && rect.height >= window.innerHeight * 0.72
        && rect.width <= window.innerWidth * 0.32
      );
      const peripheralChrome = (
        (rect.left <= window.innerWidth * 0.05 || rect.right >= window.innerWidth * 0.95)
        && rect.height >= window.innerHeight * 0.25
        && rect.width <= window.innerWidth * 0.32
      ) || (
        (rect.top <= window.innerHeight * 0.05 || rect.bottom >= window.innerHeight * 0.95)
        && rect.width >= window.innerWidth * 0.45
        && rect.height <= window.innerHeight * 0.28
      );
      const edgeChrome = horizontalChrome || verticalChrome || peripheralChrome;
      const backdropSized = areaRatio >= 0.35;
      if (
        (Number.isFinite(zIndex) && zIndex > 0 || focusedInside || areaRatio >= 0.03)
        && (!edgeChrome || backdropSized || focusedInside)
      ) {
        candidates.add(element);
      }
    }
    if (focused) {
      let current: Element | undefined = focused;
      for (let guard = 0; current && guard < 64; guard += 1) {
        const role = normalize(current.getAttribute('role')).toLowerCase();
        const style = visibleDomStyle(current);
        if (
          ['dialog', 'alertdialog', 'menu', 'listbox', 'tree', 'grid'].includes(role)
          || current instanceof HTMLDialogElement
          || style && ['absolute', 'fixed'].includes(style.position)
        ) {
          candidates.add(current);
        }
        current = flatParentElement(current);
      }
    }

    const scored = Array.from(candidates).flatMap((element, order) => {
      if (!element.isConnected || isOverlay(element) || isVisibleDomSubtreeHidden(element)) return [];
      const style = visibleDomStyle(element);
      if (!style || style.pointerEvents === 'none') return [];
      const rect = element.getBoundingClientRect();
      const role = normalize(element.getAttribute('role')).toLowerCase();
      const modal = element.getAttribute('aria-modal') === 'true'
        || element instanceof HTMLDialogElement && element.open;
      const popover = (() => {
        try {
          return element.matches(':popover-open');
        } catch {
          return false;
        }
      })();
      const semanticSurface = modal
        || popover
        || ['dialog', 'alertdialog', 'menu', 'listbox', 'tree'].includes(role);
      const clippedLeft = Math.max(0, rect.left);
      const clippedTop = Math.max(0, rect.top);
      const clippedRight = Math.min(window.innerWidth, rect.right);
      const clippedBottom = Math.min(window.innerHeight, rect.bottom);
      const clippedWidth = clippedRight - clippedLeft;
      const clippedHeight = clippedBottom - clippedTop;
      const useRawRect = semanticSurface && (clippedWidth <= 2 || clippedHeight <= 2);
      const left = useRawRect ? rect.left : clippedLeft;
      const top = useRawRect ? rect.top : clippedTop;
      const right = useRawRect ? rect.right : clippedRight;
      const bottom = useRawRect ? rect.bottom : clippedBottom;
      const width = right - left;
      const height = bottom - top;
      if (width <= 2 || height <= 2) return [];
      const controlled = controlledCandidates.has(element);
      const interactiveSurface = interactiveSurfaceCandidates.has(element);
      const focusedInside = Boolean(focused && composedContains(element, focused));
      const zIndex = Number.parseInt(style.zIndex, 10);
      const normalizedZIndex = Number.isFinite(zIndex) ? zIndex : 0;
      const zIndexOutlier = normalizedZIndex >= 500;
      const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
      const areaRatio = Math.min(1, width * height / viewportArea);
      const surfaceRole = ['dialog', 'alertdialog', 'menu', 'listbox', 'tree'].includes(role);
      const positioned = ['absolute', 'fixed', 'sticky'].includes(style.position);
      const persistentLandmark = element.matches(
        'header, nav, footer, aside, [role="banner"], [role="navigation"], [role="contentinfo"], [role="complementary"]',
      );
      if (
        persistentLandmark
        && !modal
        && !popover
        && !controlled
        && !surfaceRole
        && !focusedInside
      ) {
        return [];
      }
      if (
        positioned
        && !modal
        && !popover
        && !controlled
        && !surfaceRole
        && !focusedInside
        && !interactiveSurface
        && areaRatio < 0.015
      ) {
        return [];
      }
      const horizontalChrome = (
        (rect.top <= 2 || rect.bottom >= window.innerHeight - 2)
        && width >= window.innerWidth * 0.72
        && height <= window.innerHeight * 0.28
      );
      const verticalChrome = (
        (rect.left <= 2 || rect.right >= window.innerWidth - 2)
        && height >= window.innerHeight * 0.72
        && width <= window.innerWidth * 0.32
      );
      const peripheralChrome = (
        (rect.left <= window.innerWidth * 0.05 || rect.right >= window.innerWidth * 0.95)
        && height >= window.innerHeight * 0.25
        && width <= window.innerWidth * 0.32
      ) || (
        (rect.top <= window.innerHeight * 0.05 || rect.bottom >= window.innerHeight * 0.95)
        && width >= window.innerWidth * 0.45
        && height <= window.innerHeight * 0.28
      );
      const edgeChrome = horizontalChrome || verticalChrome || peripheralChrome;
      const backdropSized = areaRatio >= 0.35;
      if (!modal && !popover && !controlled && !surfaceRole && !positioned) return [];
      if (
        edgeChrome
        && !backdropSized
        && !modal
        && !popover
        && !controlled
        && !surfaceRole
        && !focusedInside
        && !interactiveSurface
      ) {
        return [];
      }
      if (
        role === 'grid'
        && !modal
        && !popover
        && !controlled
        && !focusedInside
        && !positioned
      ) {
        return [];
      }
      let score = 0;
      if (modal) score += 2000;
      if (popover) score += 1700;
      if (controlled) score += 1400;
      if (interactiveSurface) score += 900;
      if (role === 'dialog' || role === 'alertdialog') score += 1200;
      else if (['menu', 'listbox', 'tree'].includes(role)) score += 1000;
      else if (role === 'grid') score += 500;
      if (focusedInside) score += 450;
      if (style.position === 'fixed') score += 300;
      else if (style.position === 'absolute') score += 180;
      else if (style.position === 'sticky') score += 40;
      score += Math.min(300, Math.max(0, normalizedZIndex));
      score += Math.round(Math.min(0.5, areaRatio) * 200);
      const centerX = left + width / 2;
      const centerY = top + height / 2;
      const topAtCenter = topmostRenderableAt(centerX, centerY);
      const topAtCenterInside = Boolean(topAtCenter && (
        topAtCenter === element
        || composedContains(element, topAtCenter)
      ));
      if (topAtCenterInside) score += 120;
      const signals = [
        ...(modal ? ['modal'] : []),
        ...(popover ? ['popover'] : []),
        ...(controlled ? ['aria-controls'] : []),
        ...(interactiveSurface ? ['interactive-descendant'] : []),
        ...(focusedInside ? ['focus-inside'] : []),
        ...(positioned ? [`position:${style.position}`] : []),
        ...(normalizedZIndex ? [`z-index:${normalizedZIndex}`] : []),
        ...(zIndexOutlier ? ['z-index-outlier'] : []),
        ...(topAtCenterInside ? ['topmost'] : []),
      ];
      const label = normalize(
        element.getAttribute('aria-label')
        || element.getAttribute('title')
        || textOf(element, 160),
      );
      const kind: BrowserActiveSurface['kind'] = modal || role === 'dialog' || role === 'alertdialog'
        ? 'dialog'
        : popover
          ? 'popover'
          : role === 'menu'
            ? 'menu'
            : role === 'listbox'
              ? 'listbox'
              : controlled
                ? 'panel'
                : 'overlay';
      const likelyOverlay = modal
        || popover
        || (controlled && !edgeChrome)
        || (zIndexOutlier && topAtCenterInside && !edgeChrome);
      const id = `surface-${visibleDomState().instanceId}-${visibleDomRef(element)}`;
      const surface: BrowserActiveSurface = {
          id,
          descriptor: descriptor(element),
          kind,
          label,
          modal,
          likelyOverlay,
          focusedInside,
          zIndex: normalizedZIndex,
          rect: { bottom, height, left, right, top, width },
          signals,
          ...(element.id ? { selector: `#${CSS.escape(element.id)}` } : {}),
          depth: 0,
          activationOrder: 0,
        };
      return [{ element, score, order, surface }];
    }).sort((left, right) => right.score - left.score || right.order - left.order);
    const visibleSurfaceElements = new Set(scored.map((entry) => entry.element));
    const newlyVisibleEntries = surfaceBaselineEstablished
      ? scored.filter((entry) => !previousVisibleSurfaceElements.has(entry.element))
      : [];
    const newlyVisibleSurfaceElements = new Set(newlyVisibleEntries.map((entry) => entry.element));
    for (const entry of newlyVisibleEntries) {
      if (entry.surface.likelyOverlay) recognizedDynamicOverlayElements.add(entry.element);
    }
    for (const entry of scored) {
      let activationOrder = surfaceActivationOrder.get(entry.element);
      if (activationOrder === undefined) {
        activationOrder = ++surfaceActivationSequence;
        surfaceActivationOrder.set(entry.element, activationOrder);
      }
      entry.surface.activationOrder = activationOrder;
    }
    let consumedPendingParent = false;
    if (
      pendingSurfaceParent
      && performance.now() - pendingSurfaceParent.at <= 2500
      && visibleSurfaceElements.has(pendingSurfaceParent.element)
    ) {
      const pendingParentEntry = scored.find((entry) => entry.element === pendingSurfaceParent?.element);
      for (const entry of newlyVisibleEntries) {
        if (
          entry.element !== pendingSurfaceParent.element
          && entry.surface.likelyOverlay
          && entry.surface.kind !== 'overlay'
          && (
            entry.surface.modal && pendingParentEntry?.surface.modal
            || ['popover', 'menu', 'listbox'].includes(entry.surface.kind)
          )
        ) {
          inferredSurfaceParents.set(entry.element, pendingSurfaceParent.element);
          entry.surface.signals.push('source-surface');
          consumedPendingParent = true;
        }
      }
    }
    if (consumedPendingParent || pendingSurfaceParent && performance.now() - pendingSurfaceParent.at > 2500) {
      pendingSurfaceParent = undefined;
    }
    previousVisibleSurfaceElements = visibleSurfaceElements;
    surfaceBaselineEstablished = true;
    for (const entry of scored) {
      const controllers = surfaceControllers.get(entry.element) || [];
      const inferredParent = inferredSurfaceParents.get(entry.element);
      const parent = scored
        .filter((candidate) => candidate !== entry && composedContains(candidate.element, entry.element))
        .sort((left, right) => (
          left.surface.rect.width * left.surface.rect.height
          - right.surface.rect.width * right.surface.rect.height
        ))[0] || scored
        .filter((candidate) => candidate !== entry && controllers.some((controller) => composedContains(candidate.element, controller)))
        .sort((left, right) => right.score - left.score)[0]
        || scored.find((candidate) => candidate.element === inferredParent);
      if (parent) entry.surface.parentId = parent.surface.id;
    }
    const depthOf = (entry: typeof scored[number], seen = new Set<string>()): number => {
      if (!entry.surface.parentId || seen.has(entry.surface.id)) return 0;
      const parent = scored.find((candidate) => candidate.surface.id === entry.surface.parentId);
      if (!parent) return 0;
      seen.add(entry.surface.id);
      return 1 + depthOf(parent, seen);
    };
    for (const entry of scored) entry.surface.depth = depthOf(entry);
    const leafEntries = scored.filter((entry) => !scored.some((candidate) => candidate.surface.parentId === entry.surface.id));
    const likelyOverlayLeafEntries = leafEntries.filter((entry) => entry.surface.likelyOverlay);
    const strongOverlayLeafEntries = likelyOverlayLeafEntries.filter((entry) => (
      entry.surface.modal
      || entry.surface.kind !== 'overlay'
      || entry.surface.signals.includes('popover')
      || entry.surface.signals.includes('aria-controls')
      || entry.surface.signals.includes('focus-inside')
      || entry.surface.signals.includes('source-surface')
      || newlyVisibleSurfaceElements.has(entry.element)
      || recognizedDynamicOverlayElements.has(entry.element)
    ));
    const scopeEntries = strongOverlayLeafEntries;
    const activeCandidates = scopeEntries;
    const activeEntry = [...activeCandidates].sort((left, right) => (
      Number(right.surface.likelyOverlay) - Number(left.surface.likelyOverlay)
      || Number(right.surface.focusedInside) - Number(left.surface.focusedInside)
      || right.surface.activationOrder - left.surface.activationOrder
      || right.surface.depth - left.surface.depth
      || right.score - left.score
      || right.surface.zIndex - left.surface.zIndex
      || right.order - left.order
    ))[0];
    const surfaceStack: BrowserActiveSurface[] = [];
    let stackEntry: typeof scored[number] | undefined = activeEntry;
    const seenStackIds = new Set<string>();
    while (stackEntry && !seenStackIds.has(stackEntry.surface.id)) {
      seenStackIds.add(stackEntry.surface.id);
      surfaceStack.unshift(stackEntry.surface);
      stackEntry = stackEntry.surface.parentId
        ? scored.find((candidate) => candidate.surface.id === stackEntry!.surface.parentId)
        : undefined;
    }
    cachedSurfaceEpoch = mutationState.epoch;
    cachedSurfaceFocus = focused || null;
    cachedSurfaceState = { activeEntry, entries: scored, focused, scopeEntries, surfaceStack };
    return cachedSurfaceState;
  }

  function surfaceIdForElement(element: Element) {
    return resolveSurfaceState().entries
      .filter((entry) => composedContains(entry.element, element))
      .sort((left, right) => right.surface.depth - left.surface.depth || right.score - left.score)[0]
      ?.surface.id;
  }

  function pageObservation(): BrowserPageObservation {
    const { activeEntry, entries, focused, scopeEntries, surfaceStack } = resolveSurfaceState();
    const activeSurface = activeEntry?.surface;
    const topSurfaceIds = scopeEntries.map((entry) => entry.surface.id);
    const signature = !topSurfaceIds.length && !activeSurface
      ? ''
      : `${topSurfaceIds.join(',')}|${activeSurface
        ? `${activeSurface.id}:${Math.round(activeSurface.rect.left)}:${Math.round(activeSurface.rect.top)}:${Math.round(activeSurface.rect.width)}:${Math.round(activeSurface.rect.height)}`
        : ''}`;
    const previousSignature = mutationState.activeSurfaceSignature;
    const surfaceTransition: BrowserPageObservation['surfaceTransition'] = previousSignature === undefined
      ? 'initial'
      : previousSignature === signature
        ? 'unchanged'
        : !previousSignature && signature
          ? 'opened'
          : previousSignature && !signature
            ? 'closed'
            : 'changed';
    mutationState.activeSurfaceSignature = signature;
    const currentUrl = window.location.href;
    const observedUrl = currentUrl.length <= 2048
      ? currentUrl
      : `${currentUrl.slice(0, 2000)}...[truncated; length=${currentUrl.length}]`;
    return {
      epoch: mutationState.epoch,
      url: observedUrl,
      title: document.title,
      ...(focused ? {
        focusedElement: {
          descriptor: descriptor(focused),
          label: normalize(
            focused.getAttribute('aria-label')
            || focused.getAttribute('title')
            || focused.getAttribute('placeholder')
            || textOf(focused, 120),
          ),
        },
      } : {}),
      ...(activeSurface ? { activeSurface } : {}),
      surfaces: entries.map((entry) => entry.surface),
      surfaceStack,
      topSurfaceIds,
      surfaceTransition,
    };
  }

  function rememberSurfaceSource(element: Element) {
    const entry = resolveSurfaceState().entries
      .filter((candidate) => composedContains(candidate.element, element))
      .sort((left, right) => right.surface.depth - left.surface.depth || right.score - left.score)[0];
    if (!entry) return;
    surfaceActivationOrder.set(entry.element, ++surfaceActivationSequence);
    pendingSurfaceParent = { element: entry.element, at: performance.now() };
    cachedSurfaceEpoch = -1;
  }

  function actionability(element: Element, options: { action?: string } = {}) {
    const action = normalize(options.action).toLowerCase();
    const targetDescriptor = descriptor(element);
    if (!element?.isConnected) {
      return { ok: false, reason: 'target is detached from the current document', descriptor: targetDescriptor };
    }
    const fileInputAction = action === 'setinputfiles';
    const pointerAction = /^(click|dblclick|hover|tap|check|uncheck|setchecked|dragto|draganddrop)$/.test(action);
    if (action && !/^(screenshot|ariaSnapshot|innerText|textContent|getAttribute|inputValue|count)$/.test(action)) {
      rememberSurfaceSource(element);
    }
    const targetStyle = visibleDomStyle(element);
    if (pointerAction && targetStyle?.pointerEvents === 'none') {
      return { ok: false, reason: `${targetDescriptor} has computed pointer-events:none`, descriptor: targetDescriptor };
    }
    let current: Element | undefined = element;
    for (let guard = 0; current && guard < 256; guard += 1) {
      if (isOverlay(current)) {
        return { ok: false, reason: `${descriptor(current)} belongs to the automation overlay`, descriptor: targetDescriptor };
      }
      if (current.hasAttribute('hidden')) {
        return { ok: false, reason: `${descriptor(current)} has the hidden attribute`, descriptor: targetDescriptor };
      }
      if (current.getAttribute('aria-hidden') === 'true') {
        return { ok: false, reason: `${descriptor(current)} or an ancestor has aria-hidden=true`, descriptor: targetDescriptor };
      }
      if ((current as HTMLElement).inert || current.hasAttribute('inert')) {
        return { ok: false, reason: `${descriptor(current)} or an ancestor is inert`, descriptor: targetDescriptor };
      }
      const style = visibleDomStyle(current);
      if (!style) {
        return { ok: false, reason: `computed style is unavailable for ${descriptor(current)}`, descriptor: targetDescriptor };
      }
      if (!fileInputAction && style.display === 'none') {
        return { ok: false, reason: `${descriptor(current)} or an ancestor has display:none`, descriptor: targetDescriptor };
      }
      if (!fileInputAction && (style.visibility === 'hidden' || style.visibility === 'collapse')) {
        return { ok: false, reason: `${descriptor(current)} or an ancestor has visibility:${style.visibility}`, descriptor: targetDescriptor };
      }
      if (!fileInputAction && (style.contentVisibility === 'hidden' || Number(style.opacity || '1') <= 0.01)) {
        return { ok: false, reason: `${descriptor(current)} or an ancestor is not visibly rendered`, descriptor: targetDescriptor };
      }
      current = flatParentElement(current);
    }
    const disabled = (() => {
      try {
        return element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true';
      } catch {
        return element.getAttribute('aria-disabled') === 'true';
      }
    })();
    if (disabled) return { ok: false, reason: `${targetDescriptor} is disabled`, descriptor: targetDescriptor };
    if (!fileInputAction) {
      const renderedRect = Array.from(element.getClientRects()).find((rect) => rect.width > 0 && rect.height > 0);
      if (!renderedRect) {
        return { ok: false, reason: `${targetDescriptor} has no rendered client rectangle`, descriptor: targetDescriptor };
      }
      if (pointerAction) {
        const intersectsViewport = renderedRect.right > 0
          && renderedRect.bottom > 0
          && renderedRect.left < window.innerWidth
          && renderedRect.top < window.innerHeight;
        if (!intersectsViewport && targetStyle?.position === 'fixed') {
          return {
            ok: false,
            reason: `${targetDescriptor} is fixed outside the viewport`,
            descriptor: targetDescriptor,
          };
        }
        if (intersectsViewport && !visiblePointForElement(element, { requirePointerEvents: true })) {
          const centerX = Math.min(window.innerWidth - 1, Math.max(0, renderedRect.left + renderedRect.width / 2));
          const centerY = Math.min(window.innerHeight - 1, Math.max(0, renderedRect.top + renderedRect.height / 2));
          const coveredBy = topmostRenderableAt(centerX, centerY, { requirePointerEvents: true });
          return {
            ok: false,
            reason: `${targetDescriptor} has no unobstructed actionable point`,
            descriptor: targetDescriptor,
            failureKind: 'occluded' as const,
            ...(coveredBy ? { coveredBy: descriptor(coveredBy) } : {}),
          };
        }
      }
    }
    if (/^(fill|type|clear|presssequentially)$/.test(action)) {
      const field = element as HTMLInputElement | HTMLTextAreaElement;
      const contentEditable = (element as HTMLElement).isContentEditable;
      if (!contentEditable && !(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
        return { ok: false, reason: `${targetDescriptor} is not an editable input, textarea, or contenteditable element`, descriptor: targetDescriptor };
      }
      if (!contentEditable && (field.readOnly || field.disabled)) {
        return { ok: false, reason: `${targetDescriptor} is readonly or disabled`, descriptor: targetDescriptor };
      }
    }
    if (action === 'selectoption' && !(element instanceof HTMLSelectElement)) {
      return { ok: false, reason: `${targetDescriptor} is not a native select element`, descriptor: targetDescriptor };
    }
    return { ok: true, reason: 'exact live element is actionable', descriptor: targetDescriptor };
  }

  function selectVisibleDomOption(ref: string, input: { value?: string; label?: string }) {
    const element = visibleDomState().refToElement.get(ref);
    if (!(element instanceof HTMLSelectElement) || !element.isConnected) {
      return { ok: false, actual: 'UID is not a live native select element.' };
    }
    const value = normalizeVisibleDomText(input.value || '');
    const label = normalizeVisibleDomText(input.label || '');
    if (!value && !label) return { ok: false, actual: 'selectOption requires a non-empty value or label.' };
    const option = Array.from(element.options).find((candidate) => (
      (value && candidate.value === value)
      || (!value && label && normalizeVisibleDomText(candidate.label || candidate.text || candidate.textContent || '') === label)
    ));
    if (!option) return { ok: false, actual: `No option matched ${value ? `value=${value}` : `label=${label}`}.` };
    if (option.disabled || element.disabled) return { ok: false, actual: 'The requested select option is disabled.' };
    const previousValue = element.value;
    element.value = option.value;
    if (element.value !== option.value) return { ok: false, actual: 'The native select rejected the requested option value.' };
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      ok: true,
      actual: previousValue === option.value ? 'The requested option was already selected.' : 'Native select value changed and input/change events were dispatched.',
      value: option.value,
      label: normalizeVisibleDomText(option.label || option.text || option.textContent || option.value),
    };
  }

  const surfaceEntryForEvent = (event: Event) => {
    const target = event.composedPath().find((item): item is Element => item instanceof Element);
    if (!target) return undefined;
    const state = resolveSurfaceState();
    return state.entries
      .filter((entry) => composedContains(entry.element, target))
      .sort((left, right) => right.surface.depth - left.surface.depth || right.score - left.score)[0];
  };
  const rememberSurfaceInteraction = (event: Event) => {
    const entry = surfaceEntryForEvent(event);
    if (!entry) return;
    const target = event.composedPath().find((item): item is Element => item instanceof Element);
    if (target) rememberSurfaceSource(target);
  };
  const rememberSurfaceFocus = (event: Event) => {
    const entry = surfaceEntryForEvent(event);
    if (!entry) return;
    surfaceActivationOrder.set(entry.element, ++surfaceActivationSequence);
    cachedSurfaceEpoch = -1;
  };
  document.addEventListener('pointerdown', rememberSurfaceInteraction, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') rememberSurfaceInteraction(event);
  }, true);
  document.addEventListener('focusin', rememberSurfaceFocus, true);

  win.__aiDomRuntime = {
    version: runtimeVersion,
    mutationState: () => ({ epoch: mutationState.epoch, lastMutationAt: mutationState.lastMutationAt }),
    pageObservation,
    activeSurfaceElement: () => resolveSurfaceState().activeEntry?.element,
    markSurfaceInteraction: rememberSurfaceSource,
    actionability,
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
    visibleDomDelta,
    discardDomChanges,
    journalDomDelta,
    discardDomJournal,
    elementText,
    visibleDomElement,
    visibleDomPoint,
    visibleDomText,
    selectVisibleDomOption,
    findVisibleDomVirtualOption,
    scrollVisibleDomVirtualList,
  };
}

function collectAiDomObservation(input: { includeInteractiveCandidates?: boolean; requirePointerEvents?: boolean; structuredTextMaxChars?: number; debugPause?: boolean; candidateTextQuery?: string }): PageDomObservationPayload {
  if (input.debugPause) {
    debugger;
  }
  const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime!;
  if (!runtime) return { structuredText: '', interactiveCandidates: [], links: [] };

  const includeInteractiveCandidates = input.includeInteractiveCandidates !== false;
  const requirePointerEvents = input.requirePointerEvents === true;
  const maxStructuredTextChars = Math.max(0, Math.floor(Number(input.structuredTextMaxChars) || 0));
  const structuredLines: string[] = [];
  const pageLinks = new Map<string, { url: string; title: string }>();
  let structuredChars = 0;
  const normalizeText = (value?: string | null) => String(value || '').replace(/\s+/g, ' ').trim();
  const candidateTextQuery = normalizeText(input.candidateTextQuery).toLowerCase();
  const candidateTextQueryParts = candidateTextQuery.split(/\s+/).filter((item) => item.length >= 2);
  const overlaySelector = '#__ai_candidate_overlay__, #__ai_mouse_cursor__, #__ai_dom_export_control__';
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
    if (element instanceof HTMLAnchorElement && element.href && /^https?:\/\//i.test(element.href)) {
      const title = normalizeText(element.textContent)
        || normalizeText(element.getAttribute('title'))
        || normalizeText(element.getAttribute('aria-label'))
        || normalizeText(element.querySelector('img')?.getAttribute('alt'))
        || element.href;
      pageLinks.set(element.href.toLowerCase(), { url: element.href, title });
    }
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
    links: Array.from(pageLinks.values()).slice(0, 300),
  };
}

function applyPageGroupMarker(input: { id: string; title: string; prefix: string; applyPrefix: boolean }) {
  Object.defineProperty(window, '__aiWebTestSessionGroupId', {
    configurable: true,
    enumerable: false,
    value: input.id,
    writable: true,
  });
  if (document.documentElement?.getAttribute('data-ai-web-test-session-group-id') !== input.id) {
    document.documentElement?.setAttribute('data-ai-web-test-session-group-id', input.id);
  }
  if (document.documentElement?.getAttribute('data-ai-web-test-session-group-title') !== input.title) {
    document.documentElement?.setAttribute('data-ai-web-test-session-group-title', input.title);
  }
  const windowNameMarker = `AI_WEB_TEST_SESSION_GROUP:${input.id};`;
  const previousWindowName = String(window.name || '').replace(/^AI_WEB_TEST_SESSION_GROUP:[^;]*;/, '');
  const nextWindowName = `${windowNameMarker}${previousWindowName}`;
  if (window.name !== nextWindowName) window.name = nextWindowName;
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

async function availableLoopbackPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('Unable to allocate a browserCode CDP port.');
  return address.port;
}

async function launchPersistentContextWithBrowserCodeConnection(input: {
  chromium: BrowserType;
  userDataDir: string;
  launchOptions: LaunchOptions;
  contextOptions: BrowserContextOptions;
}) {
  const port = await availableLoopbackPort();
  const endpoint = cdpEndpointForPort(port);
  const context = await input.chromium.launchPersistentContext(input.userDataDir, {
    ...input.launchOptions,
    ...input.contextOptions,
    args: [
      ...(input.launchOptions.args || []).filter((arg) => !/^--remote-debugging-(?:pipe|port)(?:=|$)/.test(arg)),
      `--remote-debugging-port=${port}`,
    ],
  });
  return {
    browser: context.browser() || undefined,
    browserCodeConnection: { protocol: 'cdp', endpoint } satisfies BrowserCodeConnection,
    context,
    ownership: 'persistent' as const,
  };
}

async function launchBrowserServerWithConnection(input: {
  chromium: BrowserType;
  launchOptions: LaunchOptions;
  contextOptions: BrowserContextOptions;
}) {
  const port = await availableLoopbackPort();
  const cdpEndpoint = cdpEndpointForPort(port);
  const browserServer = await input.chromium.launchServer({
    ...input.launchOptions,
    args: [
      ...(input.launchOptions.args || []).filter((arg) => !/^--remote-debugging-(?:pipe|port)(?:=|$)/.test(arg)),
      `--remote-debugging-port=${port}`,
    ],
  });
  const endpoint = browserServer.wsEndpoint();
  try {
    const browser = await input.chromium.connect(endpoint);
    const context = await browser.newContext(input.contextOptions);
    return {
      browser,
      browserServer,
      browserCodeConnection: { protocol: 'cdp', endpoint: cdpEndpoint } satisfies BrowserCodeConnection,
      context,
      ownership: 'launched' as const,
    };
  } catch (error) {
    await browserServer.close().catch(() => undefined);
    throw error;
  }
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
  return {
    browser,
    browserCodeConnection: { protocol: 'cdp', endpoint: input.endpoint } satisfies BrowserCodeConnection,
    context,
    ownership: 'connected' as const,
  };
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

async function closeIdleSharedBrowser(runtimeKey: string, sharedBrowserState: SharedBrowserState, force = false) {
  if (sharedBrowserState.refCount > 0) {
    if (sharedBrowserState.idleTimer) clearTimeout(sharedBrowserState.idleTimer);
    sharedBrowserState.idleTimer = undefined;
    return;
  }
  const closeImmediately = force || process.env.BROWSER_CLOSE_SHARED_WHEN_IDLE === 'true';
  if (!closeImmediately) {
    if (!sharedBrowserState.idleTimer) {
      const configured = Number(process.env.BROWSER_USER_BROWSER_IDLE_TIMEOUT_MS || 10 * 60 * 1000);
      const timeoutMs = Number.isFinite(configured)
        ? Math.min(24 * 60 * 60 * 1000, Math.max(60_000, Math.floor(configured)))
        : 10 * 60 * 1000;
      sharedBrowserState.idleTimer = setTimeout(() => {
        sharedBrowserState.idleTimer = undefined;
        void closeIdleSharedBrowser(runtimeKey, sharedBrowserState, true);
      }, timeoutMs);
      sharedBrowserState.idleTimer.unref?.();
    }
    return;
  }

  if (sharedBrowserState.idleTimer) clearTimeout(sharedBrowserState.idleTimer);
  sharedBrowserState.idleTimer = undefined;

  const { browser, browserServer, context, ownership } = sharedBrowserState;
  const managedProfileDir = sharedBrowserState.managedProfileDir;
  let managedProfileBrowserClosed = false;
  if (ownership === 'persistent') {
    await context?.close().catch(() => undefined);
    managedProfileBrowserClosed = true;
  } else if (ownership === 'launched') {
    await browser?.close().catch(() => undefined);
    managedProfileBrowserClosed = true;
  } else if (ownership === 'connected' && (force || process.env.BROWSER_CLOSE_CONNECTED_ON_SHARED_RESET === 'true')) {
    if (force && browser) {
      const client = await browser.newBrowserCDPSession().catch(() => undefined);
      if (client) {
        managedProfileBrowserClosed = await Promise.race([
          client.send('Browser.close').then(() => true).catch(() => false),
          sleep(1000).then(() => false),
        ]);
        await Promise.race([
          client.detach().catch(() => undefined),
          sleep(500),
        ]);
      }
    }
    await browser?.close({ reason: 'Shared browser launch settings changed.' }).catch(() => undefined);
  }
  await browserServer?.close().catch(() => undefined);
  sharedBrowserState.browser = undefined;
  sharedBrowserState.browserServer = undefined;
  sharedBrowserState.browserCodeConnection = undefined;
  sharedBrowserState.context = undefined;
  sharedBrowserState.ownership = undefined;
  sharedBrowserState.initPromise = undefined;
  sharedBrowserState.key = undefined;
  sharedBrowserState.managedProfileDir = undefined;
  if (managedProfileDir && managedProfileBrowserClosed) await clearManagedBrowserProfileCaches(managedProfileDir);
}

async function acquireSharedBrowser(input: {
  runtimeKey?: string;
  chromium: BrowserType;
  cdpEndpoint: string;
  reconnectCdpEndpoint?: string;
  userDataDir: string;
  launchOptions: LaunchOptions;
  contextOptions: BrowserContextOptions;
  managedProfileDir?: string;
}): Promise<SharedBrowserLease> {
  const runtimeKey = input.runtimeKey?.trim() || 'global';
  const sharedBrowserState = sharedBrowserStateFor(runtimeKey);
  if (sharedBrowserState.idleTimer) clearTimeout(sharedBrowserState.idleTimer);
  sharedBrowserState.idleTimer = undefined;
  const key = input.runtimeKey ? `runtime:${runtimeKey}` : sharedBrowserKey(input);
  if (sharedBrowserState.key && sharedBrowserState.key !== key && sharedBrowserState.refCount > 0) {
    throw new Error('A shared browser is already running with different launch settings. Stop active runs or set BROWSER_SHARED_TABS=false.');
  }
  if (sharedBrowserState.key && sharedBrowserState.key !== key && sharedBrowserState.refCount === 0) {
    await closeIdleSharedBrowser(runtimeKey, sharedBrowserState, true);
  }

  const browserStillConnected = !sharedBrowserState.browser || sharedBrowserState.browser.isConnected();
  if (!sharedBrowserState.initPromise || sharedBrowserState.key !== key || !browserStillConnected || !sharedBrowserState.context) {
    sharedBrowserState.key = key;
    sharedBrowserState.managedProfileDir = input.managedProfileDir;
    sharedBrowserState.initPromise = (async () => {
      if (input.cdpEndpoint) {
        const browser = await input.chromium.connectOverCDP(input.cdpEndpoint);
        const context = browser.contexts()[0] || await browser.newContext(input.contextOptions);
        return {
          browser,
          browserCodeConnection: { protocol: 'cdp', endpoint: input.cdpEndpoint } satisfies BrowserCodeConnection,
          context,
          ownership: 'connected' as const,
        };
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
          return await launchPersistentContextWithBrowserCodeConnection({
            chromium: input.chromium,
            userDataDir: input.userDataDir,
            launchOptions: input.launchOptions,
            contextOptions: input.contextOptions,
          });
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

      return launchBrowserServerWithConnection({
        chromium: input.chromium,
        launchOptions: input.launchOptions,
        contextOptions: input.contextOptions,
      });
    })().then((lease) => {
      sharedBrowserState.browser = lease.browser;
      sharedBrowserState.browserServer = 'browserServer' in lease ? lease.browserServer : undefined;
      sharedBrowserState.browserCodeConnection = lease.browserCodeConnection;
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
    release: async (force = false) => {
      if (released) return;
      released = true;
      sharedBrowserState.refCount = Math.max(0, sharedBrowserState.refCount - 1);
      await closeIdleSharedBrowser(runtimeKey, sharedBrowserState, force);
    },
  };
}

export class BrowserSession {
  private browser?: Browser;
  private browserServer?: BrowserServer;
  private browserCodeConnection?: BrowserCodeConnection;
  private browserCodeKernel?: BrowserCodeKernel;
  private browserCodeKernelRevision?: number;
  private context?: BrowserContext;
  private page?: Page;
  private networkErrors: string[] = [];
  private domChangeErrors: string[] = [];
  private domChangeErrorFingerprintsByPage = new WeakMap<Page, Set<string>>();
  private attachedPages = new WeakSet<Page>();
  private httpRequestsByPage = new WeakMap<Page, HttpRequestRecord[]>();
  private httpRequestByRequest = new WeakMap<Request, HttpRequestRecord>();
  private httpRequestById = new Map<string, Request>();
  private httpRequestSequence = 0;
  private lastScreenshotMetrics?: ScreenshotMetrics;
  private screenshotGenerationSequence = 0;
  private lastInteractiveCandidates: InteractiveCandidate[] = [];
  private lastScreenshotCandidates: InteractiveCandidate[] = [];
  private lastDomNodeReferences = new Map<string, DomNodeReference>();
  private domVisiblePublicIdByFrameLocalRef = new Map<string, string>();
  private domVisibleSnapshotKey?: string;
  private domVisibleObservationId?: string;
  private domVisibleExposedReferenceIds = new Set<string>();
  private domVisibleEpoch = 0;
  private domVisibleNextPublicId = 1;
  private domObservationPagination?: DomObservationPagination;
  private domObservationPaginationSequence = 0;
  private interActionChangeJournal?: InterActionChangeJournal;
  private interActionChangeJournalSequence = 0;
  private lastScrollableAreas: ScrollableArea[] = [];
  private lastCandidateMarkerScreenshotPath?: string;
  private lastOriginalScreenshotPath?: string;
  private lastScreenshotTiming?: ScreenshotTiming;
  private ownedPages = new Set<Page>();
  private browserOwnership: BrowserOwnership = 'launched';
  private releaseSharedBrowser?: (force?: boolean) => Promise<void>;
  private managedProfileDir?: string;
  private livePreviewStateListeners = new Set<BrowserLivePreviewStateListener>();
  private livePreviewTabsNotifyScheduled = false;
  private pageDiscoveryListener?: (page: Page) => void;
  private pageGroupInitScriptPages = new WeakSet<Page>();
  private navigationSequenceByPage = new WeakMap<Page, number>();
  private browserRuntimeRevisionByFrame = new WeakMap<Frame, number>();
  private browserRuntimeInstalledRevisionByFrame = new WeakMap<Frame, string>();
  private livePreviewExplicitPageSelectionAt = 0;
  private livePreviewExplicitPageSelectionSequence = 0;
  private configuredViewportKeyByPage = new WeakMap<Page, string>();
  private livePreviewNativeTabRefreshAt = 0;
  private livePreviewTabIdSequence = 0;
  private livePreviewTabIds = new WeakMap<Page, string>();
  private nativeTabIdByPage = new WeakMap<Page, number>();
  private nativeTabGrouperEnabled = false;
  private usesSessionGroupPageSelection = false;
  private snapshotGeneration?: SnapshotGeneration;
  private snapshotGenerationPromise?: Promise<SnapshotGeneration>;
  private snapshotGenerationSequence = 0;
  private snapshotUidSequence = 0;
  private snapshotUidByIdentity = new Map<string, { uid: string; lastSeenGeneration: number }>();
  private snapshotPageSequence = 0;
  private snapshotPageIds = new WeakMap<Page, string>();
  private accessibilitySnapshotExportControlInstalled = false;
  private accessibilitySnapshotExporter?: () => Promise<AccessibilitySnapshotExportControlResult>;
  private visitedOrigins = new Set<string>();
  private observedPageLinks = new Map<string, { url: string; title: string }>();
  private readonly pageGroupId: string;
  private browserSurface: BrowserSessionSurface = 'external';

  constructor(
    private readonly mode: BrowserSessionMode = browserSessionModeFromEnv(),
    private readonly options: BrowserSessionOptions = {},
  ) {
    this.pageGroupId = normalizePageGroupId(options.runId);
    browserSessionProcessState.sessions.add(this);
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

  async exportStorageState() {
    return this.context?.storageState({ indexedDB: true });
  }

  // 启动 Playwright 浏览器并注入事件监听记录脚本，用于后续识别可交互元素。
  async start() {
    const { chromium } = await import('playwright');
    const headless = this.options.debugDevtools ? false : this.options.headless ?? process.env.HEADLESS_BROWSER === 'true';
    const isolated = this.options.isolated === true;
    this.browserSurface = resolveBrowserSessionSurface(this.options, electronEmbeddedBrowserEnabled());
    const fullscreen = process.env.BROWSER_FULLSCREEN !== 'false';
    const fixedViewport = fixedBrowserViewportFromEnv();
    const headlessFallbackViewport = { width: fullscreen ? 1920 : 1280, height: fullscreen ? 1080 : 800 };
    const useNativeViewport = !headless && !fixedViewport;
    const contextViewport = useNativeViewport ? null : fixedViewport || headlessFallbackViewport;
    const windowSizeArg = fixedViewport
      ? `--window-size=${fixedViewport.width},${fixedViewport.height + 120}`
      : headless
        ? `--window-size=${headlessFallbackViewport.width},${headlessFallbackViewport.height + 120}`
        : '';
    const ignoreHTTPSErrors = process.env.BROWSER_IGNORE_HTTPS_ERRORS !== 'false';
    const useElectronEmbeddedBrowser = this.browserSurface === 'electron-embedded';
    const forceBundledBrowser = isolated || (process.env.AI_WEB_TEST_FORCE_PLAYWRIGHT_BROWSER === 'true' && !useElectronEmbeddedBrowser);
    const channel = forceBundledBrowser ? undefined : process.env.BROWSER_CHANNEL?.trim() || undefined;
    const executablePath = process.env.AI_WEB_TEST_CHROMIUM_EXECUTABLE_PATH?.trim() || undefined;
    const browserProfileKey = this.options.browserProfileKey ? normalizePageGroupId(this.options.browserProfileKey) : '';
    const sharedBrowserRuntimeKey = this.options.sharedBrowserRuntimeKey?.trim() || '';
    const rawCdpEndpoint = forceBundledBrowser
      ? ''
      : useElectronEmbeddedBrowser
        ? electronEmbeddedBrowserCdpEndpoint()
        : process.env.BROWSER_CDP_ENDPOINT?.trim()
          || process.env.BROWSER_CONNECT_CDP_ENDPOINT?.trim()
          || process.env.CHROME_REMOTE_DEBUGGING_URL?.trim()
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
    const useSharedBrowserTabs = !isolated && (
      Boolean(sharedBrowserRuntimeKey)
      || (sharedBrowserTabsEnabled() && !useElectronEmbeddedBrowser && !browserProfileKey)
    );
    const useSessionGroupPageSelection = tabGrouperEnabled || Boolean(browserProfileKey);
    this.nativeTabGrouperEnabled = tabGrouperEnabled;
    this.usesSessionGroupPageSelection = useSessionGroupPageSelection;
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
    this.managedProfileDir = autoTabGroupProfileDir || undefined;
    if (userDataDir) await mkdir(userDataDir, { recursive: true });
    const launchOptions: LaunchOptions = {
      headless,
      slowMo: this.browserSlowMoMs(),
      ...(channel ? { channel } : {}),
      ...(executablePath && !channel ? { executablePath } : {}),
      ...(tabGrouperEnabled ? { ignoreDefaultArgs: ['--disable-extensions'] } : {}),
      args: withSessionTabGrouperArgs([
        windowSizeArg,
        fullscreen ? '--start-maximized' : '',
        ignoreHTTPSErrors ? '--ignore-certificate-errors' : '',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
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
      ...(this.options.storageState ? { storageState: this.options.storageState } : {}),
    };

    if (useSharedBrowserTabs) {
      const lease = await acquireSharedBrowser({
        runtimeKey: sharedBrowserRuntimeKey || undefined,
        chromium,
        cdpEndpoint,
        reconnectCdpEndpoint: autoTabGroupCdpEndpoint,
        userDataDir,
        launchOptions,
        contextOptions,
        managedProfileDir: this.managedProfileDir,
      });
      this.browserOwnership = 'shared';
      this.browser = lease.browser;
      this.browserServer = lease.browserServer;
      this.browserCodeConnection = lease.browserCodeConnection;
      this.context = lease.context;
      this.releaseSharedBrowser = lease.release;
      await this.selectInitialSessionGroupPage(lease.context);
      return;
    }

    if (cdpEndpoint) {
      this.browserOwnership = 'connected';
      this.browser = await chromium.connectOverCDP(cdpEndpoint);
      this.browserCodeConnection = { protocol: 'cdp', endpoint: cdpEndpoint };
      if (useElectronEmbeddedBrowser) {
        // The renderer creates the exact session tab only after it receives the
        // backend browser:start event. Allow the realtime activation handshake
        // enough time instead of requiring a tab during conversation selection.
        for (let attempt = 0; attempt < 50; attempt += 1) {
          for (const context of this.browser.contexts()) {
            await this.prepareContext(context, { claimPages: false });
            const embeddedPages = await this.findElectronEmbeddedBrowserSessionPages(context);
            const embeddedPage = this.chooseInitialPage(embeddedPages);
            if (!embeddedPage) continue;
            this.context = context;
            this.installElectronEmbeddedBrowserPageDiscovery(context);
            this.page = embeddedPage;
            await embeddedPage.bringToFront().catch(() => undefined);
            return;
          }
          if (attempt < 49) await sleep(200);
        }
        throw new Error('Electron embedded browser tab for this session is not ready.');
      }
      const existingContext = this.browser.contexts()[0];
      const context = existingContext || await this.browser.newContext(contextOptions);
      this.context = context;
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
        this.browserCodeConnection = connected.browserCodeConnection;
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
      let launched: Awaited<ReturnType<typeof launchPersistentContextWithBrowserCodeConnection>>;
      try {
        launched = await launchPersistentContextWithBrowserCodeConnection({
          chromium,
          userDataDir,
          launchOptions,
          contextOptions,
        });
      } catch (error) {
        const connected = await connectExistingBrowserOverCdp({ chromium, endpoint: autoTabGroupCdpEndpoint, contextOptions });
        if (!connected) throw error;
        this.browserOwnership = 'connected';
        this.browser = connected.browser;
        this.browserCodeConnection = connected.browserCodeConnection;
        this.context = connected.context;
        if (useSessionGroupPageSelection) {
          await this.selectInitialSessionGroupPage(connected.context);
        } else {
          await this.prepareContext(connected.context);
          await this.selectInitialPage(connected.context);
        }
        return;
      }
      const context = launched.context;
      this.context = context;
      this.browser = launched.browser;
      this.browserCodeConnection = launched.browserCodeConnection;
      if (useSessionGroupPageSelection) {
        await this.selectInitialSessionGroupPage(context);
      } else {
        await this.prepareContext(context);
        await this.selectInitialPage(context);
      }
      return;
    }

    this.browserOwnership = 'launched';
    const launched = await launchBrowserServerWithConnection({ chromium, launchOptions, contextOptions });
    this.browser = launched.browser;
    this.browserServer = launched.browserServer;
    this.browserCodeConnection = launched.browserCodeConnection;
    const context = launched.context;
    this.context = context;
    await this.prepareContext(context);
    await this.selectInitialPage(context);
  }

  private async selectInitialSessionGroupPage(context: BrowserContext) {
    await this.prepareContext(context, { claimPages: false });
    this.installOwnedPageDiscovery(context);
    const page = await this.findInitialSharedPage(context);
    await this.ensurePageGroup(page);
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

    const page = await context.newPage();
    this.claimPage(page);
    return page;
  }

  private chooseInitialPage(pages: Page[]) {
    return pages.find((page) => !isBlankPage(page)) || pages.at(-1);
  }

  private async isElectronEmbeddedBrowserPage(page: Page) {
    if (this.browserSurface !== 'electron-embedded' || page.isClosed()) return false;
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

  private async findInitialElectronEmbeddedBrowserPages(context: BrowserContext) {
    if (this.browserSurface !== 'electron-embedded') return [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const pages = await this.findElectronEmbeddedBrowserSessionPages(context);
      if (pages.length) return pages.reverse();
      if (attempt < 11) await sleep(160);
    }
    return [];
  }

  private async findElectronEmbeddedBrowserSessionPages(context: BrowserContext) {
    const pages: Page[] = [];
    for (const page of [...context.pages()].reverse()) {
      if (page.isClosed()) continue;
      if (await this.isElectronEmbeddedBrowserSessionPage(page) && this.claimPage(page, { allowSteal: true, makeActive: false })) {
        pages.push(page);
      }
    }
    return pages;
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

  private async activateNativeTabGroupTab(context: BrowserContext, tabs: NativeTabGroupPage[], targetTabId?: number) {
    const tab = targetTabId
      ? tabs.find((candidate) => candidate.tabId === targetTabId)
      : this.chooseNativeTabGroupTab(tabs);
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
    this.ensureLivePreviewState();
    const remainingByUrl = new Map<string, NativeTabGroupPage[]>();
    for (const tab of tabs) {
      if (!tab.url || isBlankBrowserUrlLike(tab.url)) continue;
      const matches = remainingByUrl.get(tab.url) || [];
      matches.push(tab);
      remainingByUrl.set(tab.url, matches);
    }
    if (!remainingByUrl.size) return [];

    const claimedPages: Page[] = [];
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      const url = page.url();
      const matches = remainingByUrl.get(url);
      const nativeTab = matches?.shift();
      if (!nativeTab) continue;
      this.nativeTabIdByPage.set(page, nativeTab.tabId);
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
      await context.addInitScript(installAiBrowserPageRuntime, AI_DOM_RUNTIME_VERSION).catch((error) => {
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
    const selectionSequence = this.livePreviewExplicitPageSelectionSequence;
    const opener = await page.opener().catch(() => null);
    if (!opener || !this.ownedPages.has(opener)) return;
    if (this.claimPage(page, { makeActive: false })) {
      if (selectionSequence !== this.livePreviewExplicitPageSelectionSequence) return;
      await page.bringToFront().catch(() => undefined);
      if (
        selectionSequence === this.livePreviewExplicitPageSelectionSequence
        && !page.isClosed()
        && this.ownedPages.has(page)
      ) {
        this.page = page;
        this.notifyLivePreviewTabsChanged();
      }
    }
  }

  private notifyLivePreviewTabsChanged() {
    if (!this.livePreviewStateListeners.size || this.livePreviewTabsNotifyScheduled) return;
    this.livePreviewTabsNotifyScheduled = true;
    queueMicrotask(() => {
      this.livePreviewTabsNotifyScheduled = false;
      if (!this.livePreviewStateListeners.size) return;
      const tabs = this.getTabsSnapshot();
      for (const listener of this.livePreviewStateListeners) listener(tabs);
    });
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
    livePreviewVisibilityOwners.set(page, (visible) => this.handleLivePreviewVisibility(page, visible));
    if (!livePreviewVisibilityBindingPages.has(page)) {
      livePreviewVisibilityBindingPages.add(page);
      void page.exposeBinding('__webPilotReportPageVisibility', (source, visible) => {
        if (source.page) livePreviewVisibilityOwners.get(source.page)?.(Boolean(visible));
      }).then(async () => {
        await page.addInitScript(installLivePreviewVisibilityReporter);
        await page.evaluate(installLivePreviewVisibilityReporter).catch(() => undefined);
      }).catch(() => undefined);
    }
    this.attachPageListeners(page);
    if (!alreadyOwned) {
      void this.markPageGroup(page);
      this.notifyLivePreviewTabsChanged();
      page.once('close', () => {
        this.ownedPages.delete(page);
        livePreviewVisibilityOwners.delete(page);
        if (sharedPageOwners.get(page) === this.pageGroupId) sharedPageOwners.delete(page);
        if (this.page === page) {
          this.page = this.sessionPages()[0];
        }
        this.notifyLivePreviewTabsChanged();
      });
    }
    if (options.makeActive !== false) this.page = page;
    return true;
  }

  private handleLivePreviewVisibility(page: Page, visible: boolean) {
    if (!visible || page.isClosed() || !this.ownedPages.has(page)) return;
    if (Date.now() - this.livePreviewExplicitPageSelectionAt < 1_000) return;
    if (this.page !== page) {
      this.page = page;
      this.notifyLivePreviewTabsChanged();
    }
  }

  private sessionPages() {
    return Array.from(this.ownedPages).filter((page) => !page.isClosed());
  }

  private browserSlowMoMs() {
    const configured = this.options.slowMoMs ?? Number(process.env.BROWSER_SLOW_MO_MS || 0);
    if (!Number.isFinite(configured) || configured < 0) return 0;
    return Math.min(Math.floor(configured), 2000);
  }

  private actionFrames() {
    const configured = this.options.actionFrameLimit;
    const frameLimit = typeof configured === 'number' && Number.isFinite(configured) && configured > 0
      ? Math.min(200, Math.floor(configured))
      : numericLimitFromEnv('BROWSER_ACTION_FRAME_LIMIT', 24);
    const page = this.activePage;
    return [page.mainFrame(), ...page.frames().filter((frame) => frame !== page.mainFrame()).slice(0, frameLimit)];
  }

  private async selectInitialPage(context: BrowserContext) {
    const pages = this.sessionPages();
    const preferred = this.options.preferExistingPage
      ? pages.filter((page) => !isBlankPage(page)).at(-1)
      : undefined;
    const page = preferred || pages[0] || await context.newPage();
    this.claimPage(page);
    await this.ensurePageGroup(page);
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

  private async ensurePageGroup(page: Page) {
    if (page.isClosed()) return;
    await this.markPageGroup(page);
    if (!this.nativeTabGrouperEnabled || page.isClosed()) return;
    await page.waitForFunction((groupId) => (
      document.documentElement?.getAttribute('data-ai-web-test-session-grouped-id') === groupId
    ), this.pageGroupId, { timeout: 1000 }).catch(() => undefined);
  }

  private async ensureBrowserPageRuntime(target: Page | Frame = this.activePage) {
    if ('mainFrame' in target) await this.applyConfiguredViewport(target).catch(() => undefined);
    const frame = 'mainFrame' in target ? target.mainFrame() : target;
    const navigationRevision = this.browserRuntimeRevisionByFrame.get(frame) || 0;
    const installedRevision = `${AI_DOM_RUNTIME_VERSION}:${navigationRevision}`;
    if (this.browserRuntimeInstalledRevisionByFrame.get(frame) === installedRevision) return;
    try {
      await target.evaluate(aiDomMutationObserverScript);
      await target.evaluate(installAiBrowserPageRuntime, AI_DOM_RUNTIME_VERSION);
      this.browserRuntimeInstalledRevisionByFrame.set(frame, installedRevision);
    } catch {
      // Frames can disappear between discovery and script injection. The next
      // operation will retry when the frame is still available.
    }
  }

  private async readPageObservation(): Promise<BrowserPageObservation> {
    const page = this.activePage;
    const mainFrame = page.mainFrame();
    const observations = await Promise.all(this.actionFrames().map(async (frame) => {
      await this.ensureBrowserPageRuntime(frame);
      const observation = await frame.evaluate(() => (
        (window as WindowWithAiDomRuntime).__aiDomRuntime?.pageObservation()
      )).catch(() => undefined);
      if (!observation) return undefined;
      const framePath = frame === mainFrame ? undefined : this.getFramePath(frame);
      return {
        ...observation,
        surfaces: observation.surfaces.map((surface) => ({
          ...surface,
          ...(framePath ? { framePath } : {}),
        })),
        surfaceStack: observation.surfaceStack.map((surface) => ({
          ...surface,
          ...(framePath ? { framePath } : {}),
        })),
        ...(observation.activeSurface ? {
          activeSurface: {
            ...observation.activeSurface,
            ...(framePath ? { framePath } : {}),
          },
        } : {}),
      };
    }));
    const available = observations.filter((item): item is BrowserPageObservation => Boolean(item));
    const main = available[0];
    const selectedSurface = available
      .flatMap((item) => item.activeSurface ? [{ observation: item, surface: item.activeSurface }] : [])
      .sort((left, right) => (
        Number(right.surface.likelyOverlay) - Number(left.surface.likelyOverlay)
        || Number(right.surface.modal) - Number(left.surface.modal)
        || right.surface.activationOrder - left.surface.activationOrder
        || right.surface.zIndex - left.surface.zIndex
      ))[0];
    return {
      epoch: available.reduce((max, item) => Math.max(max, item.epoch), 0),
      url: main?.url || page.url(),
      title: main?.title || await page.title().catch(() => ''),
      ...(main?.focusedElement ? { focusedElement: main.focusedElement } : {}),
      ...(selectedSurface ? { activeSurface: selectedSurface.surface } : {}),
      surfaces: available.flatMap((item) => item.surfaces),
      surfaceStack: selectedSurface?.observation.surfaceStack || main?.surfaceStack || [],
      topSurfaceIds: available.flatMap((item) => item.topSurfaceIds),
      surfaceTransition: selectedSurface?.observation.surfaceTransition || main?.surfaceTransition || 'initial',
    };
  }

  private pageObservationLine(observation: BrowserPageObservation) {
    return `[page-state] ${JSON.stringify(observation)}`;
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

  private ensureLivePreviewState() {
    this.configuredViewportKeyByPage ||= new WeakMap<Page, string>();
    this.livePreviewTabIds ||= new WeakMap<Page, string>();
    this.nativeTabIdByPage ||= new WeakMap<Page, number>();
    if (!Number.isFinite(this.livePreviewExplicitPageSelectionAt)) this.livePreviewExplicitPageSelectionAt = 0;
    if (!Number.isFinite(this.livePreviewExplicitPageSelectionSequence)) this.livePreviewExplicitPageSelectionSequence = 0;
    if (!Number.isFinite(this.livePreviewNativeTabRefreshAt)) this.livePreviewNativeTabRefreshAt = 0;
    if (!Number.isFinite(this.livePreviewTabIdSequence)) this.livePreviewTabIdSequence = 0;
    if (typeof this.nativeTabGrouperEnabled !== 'boolean') {
      const headless = this.options.debugDevtools ? false : this.options.headless ?? process.env.HEADLESS_BROWSER === 'true';
      this.nativeTabGrouperEnabled = this.options.isolated !== true && sessionTabGrouperEnabled(headless);
    }
    if (typeof this.usesSessionGroupPageSelection !== 'boolean') {
      this.usesSessionGroupPageSelection = this.nativeTabGrouperEnabled || Boolean(this.options.browserProfileKey);
    }
  }

  private livePreviewTabId(page: Page) {
    this.ensureLivePreviewState();
    const existing = this.livePreviewTabIds.get(page);
    if (existing) return existing;
    const id = `${this.pageGroupId}:tab:${++this.livePreviewTabIdSequence}`;
    this.livePreviewTabIds.set(page, id);
    return id;
  }

  getTabsSnapshot(): BrowserTabSnapshot[] {
    this.ensureLivePreviewState();
    const pages = this.sessionPages();
    const active = this.page && !this.page.isClosed() ? this.page : pages[0];
    return pages.map((page, index) => ({
      id: this.livePreviewTabId(page),
      index,
      url: page.url(),
      active: page === active,
      groupId: this.pageGroupId,
    }));
  }

  private async refreshSessionGroupPages(options: { forceNativeRefresh?: boolean } = {}) {
    this.ensureLivePreviewState();
    const context = this.context;
    if (!context) return this.sessionPages();

    if (this.browserSurface === 'electron-embedded') {
      await this.findElectronEmbeddedBrowserSessionPages(context);
    }
    if (this.usesSessionGroupPageSelection) {
      await this.reclaimSessionPagesByMarker(context);
    }
    const now = Date.now();
    if (
      this.nativeTabGrouperEnabled
      && (options.forceNativeRefresh || now - this.livePreviewNativeTabRefreshAt >= 1000)
    ) {
      this.livePreviewNativeTabRefreshAt = now;
      const nativeGroup = await this.findNativeTabGroupTabs(context);
      if (nativeGroup?.found) {
        await this.claimPagesByNativeTabUrls(context, nativeGroup.tabs);
        await this.reclaimSessionPagesByMarker(context);
      }
    }

    const pages = this.sessionPages();
    const visibility = await Promise.all(pages.map(async (page) => ({
      page,
      visible: await page.evaluate(() => document.visibilityState === 'visible').catch(() => false),
    })));
    const currentPageVisible = visibility.some((item) => item.page === this.page && item.visible);
    const visiblePage = visibility.find((item) => item.visible)?.page;
    // The explicitly selected page is authoritative. Some CDP targets report
    // multiple pages as visible, so always taking the first visible page can
    // undo a live-preview tab switch and reattach the old screencast forever.
    const explicitSelectionSettling = now - this.livePreviewExplicitPageSelectionAt < 1_000;
    if (!explicitSelectionSettling && !currentPageVisible && visiblePage && visiblePage !== this.page) {
      this.page = visiblePage;
      this.notifyLivePreviewTabsChanged();
    }
    return pages;
  }

  async refreshTabsSnapshot() {
    await this.refreshSessionGroupPages({ forceNativeRefresh: true });
    return this.getTabsSnapshot();
  }

  private async activateSessionPage(page: Page) {
    this.ensureLivePreviewState();
    const context = this.context;
    if (context && this.nativeTabGrouperEnabled) {
      const nativeGroup = await this.findNativeTabGroupTabs(context);
      const nativeTabId = this.nativeTabIdByPage.get(page);
      if (nativeGroup?.found && nativeTabId) {
        await this.activateNativeTabGroupTab(context, nativeGroup.tabs, nativeTabId);
      }
    }
    await page.bringToFront();
    this.page = page;
    this.livePreviewExplicitPageSelectionAt = Date.now();
    this.livePreviewExplicitPageSelectionSequence += 1;
    this.notifyLivePreviewTabsChanged();
  }

  private async applyConfiguredViewport(page: Page) {
    this.ensureLivePreviewState();
    if (page.isClosed()) return;
    const headless = this.options.debugDevtools ? false : this.options.headless ?? process.env.HEADLESS_BROWSER === 'true';
    const fullscreen = process.env.BROWSER_FULLSCREEN !== 'false';
    const viewportMode = process.env.BROWSER_VIEWPORT_MODE?.trim().toLowerCase() === 'fixed' ? 'fixed' : 'auto';
    const fixedViewport = fixedBrowserViewportFromEnv();
    const viewport = fixedViewport || (headless
      ? { width: fullscreen ? 1920 : 1280, height: fullscreen ? 1080 : 800 }
      : undefined);
    const settingKey = [
      viewportMode,
      process.env.BROWSER_VIEWPORT_WIDTH || '',
      process.env.BROWSER_VIEWPORT_HEIGHT || '',
      headless ? 'headless' : 'headful',
      fullscreen ? 'fullscreen' : 'windowed',
      this.browserSurface,
    ].join(':');
    if (this.configuredViewportKeyByPage.get(page) === settingKey) return;

    if (viewport) {
      const current = page.viewportSize();
      if (!current || current.width !== viewport.width || current.height !== viewport.height) {
        await page.setViewportSize(viewport);
      }
    } else {
      const viewportClient = await page.context().newCDPSession(page);
      try {
        await viewportClient.send('Emulation.clearDeviceMetricsOverride');
      } finally {
        await viewportClient.detach().catch(() => undefined);
      }
    }
    this.configuredViewportKeyByPage.set(page, settingKey);
  }

  async switchLivePreviewTab(tabId: string): Promise<BrowserActionResult> {
    let page = this.sessionPages().find((candidate) => this.livePreviewTabId(candidate) === tabId);
    if (!page) {
      const refreshedPages = await this.refreshSessionGroupPages({ forceNativeRefresh: true });
      page = refreshedPages.find((candidate) => this.livePreviewTabId(candidate) === tabId);
    }
    if (!page) return { ok: false, actual: 'The selected live-preview tab no longer exists.' };
    await this.activateSessionPage(page);
    return { ok: true, actual: `Switched live preview to ${page.url()}` };
  }

  async startScreencast(options: {
    onActivePageChanged?: () => void;
    onError?: (error: unknown) => void;
    onFrame: (frame: BrowserScreencastFrame) => void | Promise<void>;
    onTabsChanged?: (tabs: BrowserTabSnapshot[]) => void;
    video?: boolean;
  }): Promise<BrowserScreencastHandle> {
    this.ensureLivePreviewState();
    await this.refreshSessionGroupPages({ forceNativeRefresh: true });
    const format = options.video
      ? resolveBrowserPreviewImageFormat(process.env.BROWSER_PREVIEW_VIDEO_SOURCE_FORMAT || 'png')
      : resolveBrowserPreviewImageFormat(process.env.BROWSER_SCREENCAST_FORMAT);
    const contentType: BrowserScreencastFrame['contentType'] = format === 'png' ? 'image/png' : 'image/jpeg';
    const rawQuality = Number(process.env.BROWSER_SCREENCAST_QUALITY ?? 90);
    const quality = Math.min(100, Math.max(40, Math.floor(Number.isFinite(rawQuality) ? rawQuality : 90)));
    const currentFrameIntervalMs = () => browserPreviewFrameIntervalMs(process.env.BROWSER_PREVIEW_FPS);
    let stopped = false;
    let stopPromise: Promise<void> | undefined;
    let page: Page | undefined;
    let client: import('playwright').CDPSession | undefined;
    let pageBindingPromise: Promise<{ client: import('playwright').CDPSession; page: Page }> | undefined;
    let viewport = { width: 1280, height: 720 };
    let viewportOrigin = { x: 0, y: 0 };
    const capturePromises = new Set<Promise<void>>();
    let captureTimer: ReturnType<typeof setTimeout> | undefined;
    let captureSequence = 0;
    let pushedCaptureSequence = 0;
    let nextCaptureAt = Date.now();
    let nextPageRefreshAt = 0;
    let pageRefreshPromise: Promise<void> | undefined;
    let nextViewportRefreshAt = 0;
    let captureDurationMs = 0;
    let captureDurationTotalMs = 0;
    let captureSamples = 0;
    const maxConcurrentCaptures = () => {
      const averageCaptureDurationMs = captureSamples ? captureDurationTotalMs / captureSamples : 0;
      // A fixed-rate poller must allow more than one request in flight when a
      // screenshot takes longer than the frame interval. Keep it tightly
      // bounded so a slow page cannot build an unbounded CDP command queue.
      return Math.min(3, Math.max(1, Math.ceil(averageCaptureDurationMs / currentFrameIntervalMs())));
    };
    const framePump = new BrowserPreviewFramePump<BrowserScreencastFrame>({
      // Frame production is already paced below. Keep this pump focused on
      // serialization/coalescing so it does not add a second FPS interval.
      intervalMs: () => 1,
      onError: options.onError,
      onFrame: options.onFrame,
    });
    const tabsListener = options.onTabsChanged;
    if (tabsListener) {
      this.livePreviewStateListeners.add(tabsListener);
      tabsListener(this.getTabsSnapshot());
    }

    const pushOutputFrame = (
      capturedPage: Page,
      data: string,
      outputViewport: { width: number; height: number },
      metadata?: { deviceHeight?: number; deviceWidth?: number },
    ) => {
      if (stopped || capturedPage.isClosed() || this.activePage !== capturedPage) return;
      viewport = outputViewport;
      framePump.push({
        capturedAt: new Date().toISOString(),
        contentType,
        data,
        metadata: metadata ? {
          ...metadata,
          deviceHeight: outputViewport.height,
          deviceWidth: outputViewport.width,
        } : undefined,
        url: capturedPage.url(),
        viewport: outputViewport,
      });
    };
    const refreshActivePageInBackground = () => {
      const currentTime = Date.now();
      if (pageRefreshPromise || currentTime < nextPageRefreshAt) return;
      // Page visibility changes are delivered by the page binding installed
      // in claimPage(). Keep only a low-frequency reconciliation fallback for
      // browser/extension implementations that suppress visibility events.
      nextPageRefreshAt = currentTime + 2_000;
      pageRefreshPromise = this.refreshSessionGroupPages()
        .then(() => undefined)
        .catch((error) => {
          if (!stopped) options.onError?.(error);
        })
        .finally(() => {
          pageRefreshPromise = undefined;
        });
    };
    const bindActivePage = async () => {
      refreshActivePageInBackground();
      const activePage = this.activePage;
      if (page === activePage && client && !activePage.isClosed()) return { client, page: activePage };
      if (pageBindingPromise) return pageBindingPromise;

      pageBindingPromise = (async () => {
        const nextActivePage = this.activePage;
        if (page === nextActivePage && client && !nextActivePage.isClosed()) {
          return { client, page: nextActivePage };
        }
        await client?.detach().catch(() => undefined);
        await nextActivePage.bringToFront().catch(() => undefined);
        const nextClient = await nextActivePage.context().newCDPSession(nextActivePage);
        page = nextActivePage;
        client = nextClient;
        await Promise.all([
          nextClient.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => undefined),
          nextClient.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined),
        ]);
        const cssViewport = await this.getViewportMetrics().catch(() => ({
          ...(nextActivePage.viewportSize() || { width: 1280, height: 720 }),
          devicePixelRatio: 1,
        }));
        viewport = {
          width: Math.max(1, Math.round(cssViewport.width)),
          height: Math.max(1, Math.round(cssViewport.height)),
        };
        nextViewportRefreshAt = 0;
        return { client: nextClient, page: nextActivePage };
      })();
      try {
        return await pageBindingPromise;
      } finally {
        pageBindingPromise = undefined;
      }
    };
    const capturePreviewFrame = async (sequence: number) => {
      if (stopped) return;
      const captureStartedAt = performance.now();
      const binding = await bindActivePage();
      if (stopped) return;
      const capturedPage = binding.page;
      const captureClient = binding.client;
      const currentTime = Date.now();
      if (currentTime >= nextViewportRefreshAt) {
        nextViewportRefreshAt = currentTime + 1_000;
        const layoutMetrics = await captureClient.send('Page.getLayoutMetrics');
        const visualViewport = layoutMetrics.cssVisualViewport;
        viewport = {
          width: Math.max(1, Math.round(visualViewport.clientWidth)),
          height: Math.max(1, Math.round(visualViewport.clientHeight)),
        };
        viewportOrigin = {
          x: visualViewport.pageX,
          y: visualViewport.pageY,
        };
      }
      const captureGeometry = options.video
        ? browserPreviewVideoCaptureGeometry(viewport)
        : { ...viewport, scale: 1 };
      const outputViewport = {
        width: captureGeometry.width,
        height: captureGeometry.height,
      };
      const result = await captureClient.send('Page.captureScreenshot', {
        captureBeyondViewport: false,
        ...(options.video ? {
          clip: {
            x: viewportOrigin.x,
            y: viewportOrigin.y,
            width: viewport.width,
            height: viewport.height,
            scale: captureGeometry.scale,
          },
        } : {}),
        format,
        fromSurface: true,
        optimizeForSpeed: true,
        ...(format === 'jpeg' ? { quality } : {}),
      });
      captureDurationMs = performance.now() - captureStartedAt;
      captureDurationTotalMs += captureDurationMs;
      captureSamples += 1;
      if (sequence <= pushedCaptureSequence) return;
      pushedCaptureSequence = sequence;
      pushOutputFrame(capturedPage, result.data, outputViewport);
    };
    const launchCapture = () => {
      const sequence = ++captureSequence;
      const capturePromise = capturePreviewFrame(sequence).catch((error) => {
        if (!stopped) options.onError?.(error);
      }).finally(() => {
        capturePromises.delete(capturePromise);
      });
      capturePromises.add(capturePromise);
    };
    const scheduleCapture = () => {
      if (stopped || captureTimer) return;
      const delay = Math.max(0, nextCaptureAt - Date.now());
      captureTimer = setTimeout(() => {
        captureTimer = undefined;
        if (stopped) return;
        const scheduledAt = nextCaptureAt;
        const intervalMs = currentFrameIntervalMs();
        nextCaptureAt = Math.max(scheduledAt + intervalMs, Date.now());
        if (capturePromises.size < maxConcurrentCaptures()) launchCapture();
        scheduleCapture();
      }, delay);
      captureTimer.unref?.();
    };
    const stopScreencast = async (notifyPageChanged: boolean) => {
      if (stopPromise) return stopPromise;
      stopped = true;
      if (captureTimer) clearTimeout(captureTimer);
      captureTimer = undefined;
      stopPromise = (async () => {
        if (tabsListener) this.livePreviewStateListeners.delete(tabsListener);
        await Promise.allSettled([...capturePromises]);
        await pageRefreshPromise?.catch(() => undefined);
        await framePump.stop();
        await client?.detach().catch(() => undefined);
        client = undefined;
        page = undefined;
        if (notifyPageChanged) await options.onActivePageChanged?.();
      })();
      return stopPromise;
    };
    try {
      await capturePreviewFrame(++captureSequence);
      if (!stopped) await framePump.flushLatest();
      nextCaptureAt = Date.now() + currentFrameIntervalMs();
      scheduleCapture();
    } catch (error) {
      if (tabsListener) this.livePreviewStateListeners.delete(tabsListener);
      await stopScreencast(false);
      throw error;
    }
    return {
      metrics: () => ({
        ...framePump.metrics(),
        activeCaptures: capturePromises.size,
        captureDurationMs,
        captureDurationMsAverage: captureSamples ? captureDurationTotalMs / captureSamples : 0,
        imageFormat: format,
        ...(format === 'jpeg' ? { imageQuality: quality } : {}),
        maxConcurrentCaptures: maxConcurrentCaptures(),
        targetFps: browserPreviewFramesPerSecond(process.env.BROWSER_PREVIEW_FPS),
      }),
      stop: async () => {
        await stopScreencast(false);
      },
    };
  }

  async dispatchLiveInput(input: BrowserLiveInput): Promise<BrowserActionResult> {
    if (input.kind === 'tab') return this.switchLivePreviewTab(input.tabId);
    const page = this.activePage;
    await this.ensureBrowserPageRuntime(page);
    const clampRatio = (value: number) => Math.min(1, Math.max(0, Number(value)));
    const invalidateObservation = () => {
      this.lastScreenshotMetrics = undefined;
      this.domObservationPagination = undefined;
      this.lastDomNodeReferences.clear();
      this.domVisiblePublicIdByFrameLocalRef.clear();
      this.domVisibleSnapshotKey = undefined;
      this.domVisibleObservationId = undefined;
      this.domVisibleExposedReferenceIds.clear();
      this.lastInteractiveCandidates = [];
      this.lastScreenshotCandidates = [];
    };

    if (input.kind === 'move' || input.kind === 'click' || input.kind === 'drag' || input.kind === 'scroll') {
      if (!Number.isFinite(input.xRatio) || !Number.isFinite(input.yRatio)) {
        return { ok: false, actual: 'Live browser input requires finite relative coordinates.' };
      }
      const viewport = await this.getViewportMetrics();
      const x = Math.min(viewport.width - 1, Math.max(0, Math.round(clampRatio(input.xRatio) * viewport.width)));
      const y = Math.min(viewport.height - 1, Math.max(0, Math.round(clampRatio(input.yRatio) * viewport.height)));
      if (input.kind === 'move') {
        await page.mouse.move(x, y);
        return { ok: true, actual: `Live browser pointer moved to (${x}, ${y}).` };
      }

      if (input.kind === 'click') {
        const button = input.button === 'right' || input.button === 'middle' ? input.button : 'left';
        const clickCount = Math.min(2, Math.max(1, Math.floor(Number(input.clickCount) || 1)));
        const popupPromise = button === 'left'
          ? page.waitForEvent('popup', { timeout: 1500 }).catch(() => undefined)
          : Promise.resolve(undefined);
        const popupSelectionSequence = this.livePreviewExplicitPageSelectionSequence;
        await page.mouse.click(x, y, { button, clickCount });
        void popupPromise.then(async (popup) => {
          if (!popup) return;
          await this.claimPopupPage(popup, undefined, popupSelectionSequence);
          await this.refreshSessionGroupPages({ forceNativeRefresh: true });
        }).catch(() => undefined);
        invalidateObservation();
        return { ok: true, actual: `Live browser clicked (${x}, ${y}).` };
      }

      if (input.kind === 'drag') {
        if (!Number.isFinite(input.toXRatio) || !Number.isFinite(input.toYRatio)) {
          return { ok: false, actual: 'Live browser drag requires finite destination coordinates.' };
        }
        const toX = Math.min(viewport.width - 1, Math.max(0, Math.round(clampRatio(input.toXRatio) * viewport.width)));
        const toY = Math.min(viewport.height - 1, Math.max(0, Math.round(clampRatio(input.toYRatio) * viewport.height)));
        const button = input.button === 'right' || input.button === 'middle' ? input.button : 'left';
        const steps = Math.min(24, Math.max(2, Math.round(Math.hypot(toX - x, toY - y) / 40)));
        await page.mouse.move(x, y);
        await page.mouse.down({ button });
        try {
          await page.mouse.move(toX, toY, { steps });
        } finally {
          await page.mouse.up({ button }).catch(() => undefined);
        }
        invalidateObservation();
        return { ok: true, actual: `Live browser dragged from (${x}, ${y}) to (${toX}, ${toY}).` };
      }

      await page.mouse.move(x, y);
      const deltaX = Math.min(2400, Math.max(-2400, Number(input.deltaX) || 0));
      const deltaY = Math.min(2400, Math.max(-2400, Number(input.deltaY) || 0));
      if (!deltaX && !deltaY) return { ok: true, actual: 'Live browser scroll had no movement.' };
      await page.mouse.wheel(deltaX, deltaY);
      invalidateObservation();
      return { ok: true, actual: `Live browser scrolled by (${deltaX}, ${deltaY}).` };
    }

    if (input.kind === 'key') {
      const key = String(input.key || '').trim();
      if (!key || key.length > 80) return { ok: false, actual: 'Live browser key is invalid.' };
      await page.keyboard.press(key);
      invalidateObservation();
      return { ok: true, actual: `Live browser pressed ${key}.` };
    }

    if (input.kind === 'text') {
      const text = String(input.text || '');
      if (!text || text.length > 10_000) return { ok: false, actual: 'Live browser text is empty or too long.' };
      await page.keyboard.insertText(text);
      invalidateObservation();
      return { ok: true, actual: `Live browser inserted ${text.length} character(s).` };
    }

    return { ok: false, actual: 'Live browser input kind is unsupported.' };
  }

  private async closeOwnedPages() {
    const pages = this.sessionPages();
    await Promise.all(pages.map((page) => page.close().catch(() => undefined)));
    this.ownedPages.clear();
    this.page = undefined;
  }

  private async clearElectronEmbeddedSessionData() {
    const pages = this.sessionPages();
    const origins = new Set(this.visitedOrigins);
    for (const value of pages.flatMap((page) => page.frames().map((frame) => frame.url()))) {
      try {
        const url = new URL(value);
        if (/^https?:$/.test(url.protocol)) origins.add(url.origin);
      } catch {
        // Ignore blank, data, and transient frame URLs.
      }
    }
    for (const worker of this.context?.serviceWorkers() || []) {
      try {
        const url = new URL(worker.url());
        if (/^https?:$/.test(url.protocol)) origins.add(url.origin);
      } catch {
        // Ignore workers without a web origin.
      }
    }
    const storageState = await this.context?.storageState().catch(() => undefined);
    for (const item of storageState?.origins || []) {
      try {
        const url = new URL(item.origin);
        if (/^https?:$/.test(url.protocol)) origins.add(url.origin);
      } catch {
        // Ignore malformed persisted origins.
      }
    }
    await this.context?.clearCookies().catch(() => undefined);
    await this.context?.clearPermissions().catch(() => undefined);
    await Promise.all(pages.map(async (page) => {
      const client = await page.context().newCDPSession(page).catch(() => undefined);
      if (!client) return;
      try {
        for (const origin of origins) {
          await client.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' }).catch(() => undefined);
        }
        await client.send('Network.clearBrowserCache').catch(() => undefined);
      } finally {
        await client.detach().catch(() => undefined);
      }
    }));
  }

  // 绑定 console 和网络失败监听，只记录会影响测试判断的关键异常。
  // Keep a no-op target for console listeners installed by an older dev-server
  // module before page-console collection was removed. Those listeners can
  // outlive a hot reload while the controlled browser session stays open.
  private recordPageConsoleEntry(...legacyArguments: unknown[]) {
    void legacyArguments;
  }

  private attachPageListeners(page: Page) {
    if (this.attachedPages.has(page)) return;
    this.attachedPages.add(page);
    this.navigationSequenceByPage.set(page, this.navigationSequenceByPage.get(page) || 0);
    for (const frame of page.frames()) this.rememberVisitedOrigin(frame.url());
    page.setDefaultTimeout(8000);
    page.on('framenavigated', (frame) => {
      this.browserRuntimeRevisionByFrame.set(frame, (this.browserRuntimeRevisionByFrame.get(frame) || 0) + 1);
      this.rememberVisitedOrigin(frame.url());
      if (frame !== page.mainFrame()) return;
      this.domChangeErrorFingerprintsByPage.set(page, new Set());
      this.navigationSequenceByPage.set(page, (this.navigationSequenceByPage.get(page) || 0) + 1);
      this.notifyLivePreviewTabsChanged();
    });
    page.on('domcontentloaded', () => {
      const frame = page.mainFrame();
      this.browserRuntimeRevisionByFrame.set(frame, (this.browserRuntimeRevisionByFrame.get(frame) || 0) + 1);
    });
    page.on('console', (message) => {
      const text = message.text();
      if (message.type() === 'error' && !shouldIgnoreConsoleError(text)) {
        this.recordDomChangeError(page, 'console', text);
      }
    });
    page.on('pageerror', (error) => {
      const text = unknownErrorMessage(error);
      this.recordDomChangeError(page, 'page', text);
    });
    page.on('dialog', (dialog: Dialog) => {
      // Playwright's automatic close path leaves a rejected promise behind when
      // another CDP client has already handled this browser dialog. Handling it
      // explicitly keeps that normal CDP race out of Next's unhandledRejection.
      void dialog.dismiss().catch((error) => {
        if (isAlreadyHandledJavaScriptDialogError(error)) return;
        const message = `Could not dismiss JavaScript dialog: ${unknownErrorMessage(error)}`;
        this.recordDomChangeError(page, 'dialog', message);
      });
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
      const message = `${request.method()} ${request.url()} ${errorText}`;
      this.networkErrors.push(message);
      this.recordDomChangeError(page, 'network', message);
    });
  }

  private rememberVisitedOrigin(value: string) {
    try {
      const url = new URL(value);
      if (/^https?:$/.test(url.protocol)) this.visitedOrigins.add(url.origin);
    } catch {
      // Blank and transient URLs do not own persistent web storage.
    }
  }

  private recordDomChangeError(page: Page, source: 'console' | 'page' | 'dialog' | 'network', message: string) {
    const normalized = String(message || '').trim();
    if (!normalized) return;
    const entry = `[${source}] ${normalized}`;
    const fingerprints = this.domChangeErrorFingerprintsByPage.get(page) || new Set<string>();
    if (fingerprints.has(entry)) return;
    if (fingerprints.size >= 500) fingerprints.clear();
    fingerprints.add(entry);
    this.domChangeErrorFingerprintsByPage.set(page, fingerprints);
    this.domChangeErrors.push(entry);
    if (this.domChangeErrors.length > 100) this.domChangeErrors.splice(0, this.domChangeErrors.length - 100);
  }

  private recordHttpRequest(page: Page, request: Request) {
    const existing = this.httpRequestByRequest.get(request);
    if (existing) return existing;
    const records = this.httpRequestsByPage.get(page) || [];
    const record: HttpRequestRecord = {
      id: `${Date.now().toString(36)}-${records.length + 1}`,
      sequence: ++this.httpRequestSequence,
      startedAt: new Date().toISOString(),
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
    };
    records.push(record);
    const rawMaxRecords = Number(process.env.BROWSER_HTTP_REQUEST_HISTORY_LIMIT || 400);
    const maxRecords = Math.max(50, Math.floor(Number.isFinite(rawMaxRecords) ? rawMaxRecords : 400));
    if (records.length > maxRecords) {
      const removed = records.splice(0, records.length - maxRecords);
      for (const item of removed) this.httpRequestById.delete(item.id);
    }
    this.httpRequestsByPage.set(page, records);
    this.httpRequestByRequest.set(request, record);
    this.httpRequestById.set(record.id, request);
    return record;
  }

  // 获取当前可用页面；如果活动页关闭，会从浏览器上下文中寻找替代页面。
  private get activePage() {
    if (!this.page) throw new Error('Browser session has not started');
    if (this.page.isClosed()) {
      const replacement = this.sessionPages()[0];
      if (!replacement) throw new Error('Active browser page has been closed and no replacement page is available.');
      this.page = replacement;
      this.notifyLivePreviewTabsChanged();
      this.attachPageListeners(replacement);
    }
    return this.page;
  }

  // 打开目标页面先等待导航提交，再在有限的 DOM 静默窗口后生成新快照。
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
    await this.ensurePageGroup(this.activePage);
    return this.completeActionWithDomChanges(
      `Opened page: ${url}${navigationNote}`,
      previousGeneration,
      { postNavigation: true },
    );
  }

  async openInNewTab(url: string): Promise<BrowserActionResult> {
    if (!this.context) return { ok: false, actual: 'Browser context is unavailable.' };
    const page = await this.context.newPage();
    this.claimPage(page);
    await page.bringToFront().catch(() => undefined);
    return this.open(url);
  }

  async readStructuredPageText() {
    return (await this.readDomObservation({ includeInteractiveCandidates: false })).structuredText;
  }

  /** Read-only link inventory across the current page and its frames. */
  async readPageLinks() {
    const links: Array<{ url: string; title: string }> = Array.from(this.observedPageLinks.values());
    const seen = new Set(links.map((link) => link.url.toLowerCase()));
    for (const frame of this.activePage.frames()) {
      const frameLinks = await frame.evaluate(() => Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
        .map((anchor) => {
          const rawUrl = anchor.href || anchor.getAttribute('href') || '';
          let url = '';
          try {
            url = new URL(rawUrl, document.baseURI).href;
          } catch {
            return undefined;
          }
          if (!/^https?:\/\//i.test(url)) return undefined;
          const title = [
            anchor.textContent,
            anchor.getAttribute('title'),
            anchor.getAttribute('aria-label'),
            anchor.querySelector('img')?.getAttribute('alt'),
          ].map((value) => value?.replace(/\s+/g, ' ').trim()).find(Boolean) || url;
          return { url, title };
        })
        .filter((item): item is { url: string; title: string } => Boolean(item)))
        .catch(() => [] as Array<{ url: string; title: string }>);
      for (const link of frameLinks) {
        const key = link.url.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ url: link.url.slice(0, 4_000), title: link.title.slice(0, 500) });
        if (links.length >= 300) return links;
      }
    }
    return links;
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
          }).catch(() => ({ structuredText: '', interactiveCandidates: [] as PageInteractiveCandidate[], links: [] as Array<{ url: string; title: string }> }));
        },
      );
      for (const link of observation.links) {
        this.observedPageLinks.set(link.url.toLowerCase(), link);
      }
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

  private async capturePngScreenshot(input: {
    capture: ScreenshotCaptureMode;
    filePath: string;
    timeoutMs: number;
  }) {
    const outputPixelRatio = browserOutputPixelRatioFromEnv();
    if (outputPixelRatio === 1) {
      await this.activePage.screenshot({
        animations: 'disabled',
        caret: 'hide',
        path: input.filePath,
        fullPage: input.capture === 'fullPage',
        scale: 'css',
        timeout: input.timeoutMs,
      });
      return;
    }

    const client = await this.activePage.context().newCDPSession(this.activePage);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          const metrics = await client.send('Page.getLayoutMetrics');
          const source = input.capture === 'fullPage'
            ? metrics.cssContentSize
            : metrics.cssVisualViewport;
          const x = 'pageX' in source ? source.pageX : source.x;
          const y = 'pageY' in source ? source.pageY : source.y;
          const width = 'clientWidth' in source ? source.clientWidth : source.width;
          const height = 'clientHeight' in source ? source.clientHeight : source.height;
          const result = await client.send('Page.captureScreenshot', {
            captureBeyondViewport: input.capture === 'fullPage',
            clip: {
              x,
              y,
              width: Math.max(1, width),
              height: Math.max(1, height),
              scale: outputPixelRatio,
            },
            format: 'png',
            fromSurface: true,
            optimizeForSpeed: false,
          });
          await writeFile(input.filePath, Buffer.from(result.data, 'base64'));
        })(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`Browser screenshot timed out after ${input.timeoutMs}ms.`));
          }, input.timeoutMs);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      await client.detach().catch(() => undefined);
    }
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
    const screenshotTimeoutMs = boundedPositiveIntegerEnv(
      'SCREENSHOT_TIMEOUT_MS',
      DEFAULT_SCREENSHOT_TIMEOUT_MS,
      MIN_SCREENSHOT_TIMEOUT_MS,
      MAX_SCREENSHOT_TIMEOUT_MS,
    );
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
      await timed('capturePrimaryScreenshot', () => this.capturePngScreenshot({
        capture,
        filePath,
        timeoutMs: screenshotTimeoutMs,
      }), () => ({ path: filePath }));
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
        await timed('captureMarkerScreenshot', () => this.capturePngScreenshot({
          capture,
          filePath: markerFilePath,
          timeoutMs: screenshotTimeoutMs,
        }), () => ({ path: markerFilePath }));
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
      outputPixelRatio: browserOutputPixelRatioFromEnv(),
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
    await this.capturePngScreenshot({
      capture,
      filePath,
      timeoutMs: screenshotTimeoutMs,
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
      outputPixelRatio: browserOutputPixelRatioFromEnv(),
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
  private async resetInterActionChangeJournal() {
    const page = this.activePage;
    this.interActionChangeJournal = {
      id: `changes-${++this.interActionChangeJournalSequence}`,
      page,
      startedAt: new Date().toISOString(),
      requestStartSequence: this.httpRequestSequence,
      added: [],
      updated: [],
      removed: [],
      errors: [],
      overflow: false,
    };
    this.domChangeErrors = [];
    await Promise.all(this.actionFrames().map(async (frame) => {
      await this.ensureBrowserPageRuntime(frame);
      await frame.evaluate(() => {
        const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime;
        return runtime?.discardDomJournal();
      }).catch(() => undefined);
    }));
  }

  private async readInterActionChangeJournal() {
    if (!this.interActionChangeJournal || this.interActionChangeJournal.page !== this.activePage) {
      await this.resetInterActionChangeJournal();
    }
    const journal = this.interActionChangeJournal!;
    const mainFrame = this.activePage.mainFrame();
    const frameLimit = numericLimitFromEnv('DOM_CUA_FRAME_LIMIT', Number.MAX_SAFE_INTEGER);
    const frames = [mainFrame, ...this.activePage.frames().filter((frame) => frame !== mainFrame).slice(0, frameLimit)];
    const deltas = await Promise.all(frames.map(async (frame) => {
      const framePath = frame === mainFrame ? undefined : this.getFramePath(frame);
      if (frame !== mainFrame && framePath === undefined) return undefined;
      await this.ensureBrowserPageRuntime(frame);
      const delta = await frame.evaluate(() => {
        const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime;
        return runtime?.journalDomDelta();
      }).catch(() => undefined);
      return delta ? { delta, framePath } : undefined;
    }));
    for (const entry of deltas) {
      if (!entry) continue;
      const prefix = entry.framePath ? `[iframe ${entry.framePath}] ` : '';
      journal.added.push(...entry.delta.added.map((line) => `${prefix}${line}`));
      journal.updated.push(...entry.delta.updated.map((line) => `${prefix}${line}`));
      journal.removed.push(...entry.delta.removed.map((line) => `${prefix}${line}`));
      journal.overflow ||= entry.delta.overflow;
    }
    journal.errors.push(...this.domChangeErrors.splice(0));
    const requests = (this.httpRequestsByPage.get(this.activePage) || [])
      .filter((record) => record.sequence > journal.requestStartSequence);
    const requestLines = requests.map((record) => {
      const outcome = record.failed
        ? `failed=${record.errorText || 'unknown'}`
        : record.status === undefined
          ? 'pending'
          : `status=${record.status}${record.ok === false ? ' failed' : ''}`;
      return `request id=${record.id} method=${record.method} type=${record.resourceType} ${outcome} url=${record.url}`;
    });
    const lines = [
      `Inter-action changes ${journal.id}: since ${journal.startedAt}.`,
      `DOM added (${journal.added.length}):`,
      ...journal.added.map((line) => `added ${line}`),
      `DOM updated (${journal.updated.length}):`,
      ...journal.updated.map((line) => `updated ${line}`),
      `DOM removed (${journal.removed.length}):`,
      ...journal.removed.map((line) => `removed ${line}`),
      `Requests started in this window (${requests.length}); use native Playwright request listeners inside browserCode when more detail is needed:`,
      ...requestLines,
      ...(journal.errors.length ? [`Diagnostics (${journal.errors.length}):`, ...journal.errors] : []),
      ...(journal.overflow ? ['Change journal overflowed; entries may be incomplete.'] : []),
    ];
    return { journal, lines };
  }

  async getCurrentTabHttpRequests(options: { ids?: string[] } = {}): Promise<BrowserActionResult> {
    const rawLimit = Number(process.env.AI_HTTP_REQUEST_TOOL_LIMIT || 80);
    const limit = Math.max(1, Math.floor(Number.isFinite(rawLimit) ? rawLimit : 80));
    const requestedIds = new Set((options.ids || []).filter((id) => typeof id === 'string' && id));
    const detailed = requestedIds.size > 0;
    const records = detailed
      ? (this.httpRequestsByPage.get(this.activePage) || []).filter((record) => requestedIds.has(record.id))
      : (this.httpRequestsByPage.get(this.activePage) || []).slice(-limit);
    if (!records.length) {
      return { ok: true, actual: detailed ? 'None of the requested HTTP request IDs are available in the current tab history.' : 'Current tab has no captured HTTP requests yet.' };
    }
    const detailLimit = Math.max(1000, Math.floor(Number(process.env.AI_HTTP_REQUEST_DETAIL_MAX_CHARS || 12000)));
    const output = await Promise.all(records.map(async (record) => {
      const summary = {
        id: record.id,
        time: record.startedAt,
        method: record.method,
        url: record.url,
        resourceType: record.resourceType,
        status: record.status ?? null,
        statusText: record.statusText ?? null,
        ok: record.ok ?? null,
        failed: record.failed || false,
        errorText: record.errorText || null,
      } as Record<string, unknown>;
      if (!detailed) return summary;
      const request = this.httpRequestById.get(record.id);
      if (!request) return { ...summary, detailUnavailable: true };
      const requestBody = request.postData();
      if (requestBody) summary.requestBody = compactDiagnosticText(requestBody, detailLimit);
      if (record.status !== undefined) {
        const response = await request.response().catch(() => null);
        const contentType = response?.headers()['content-type'] || '';
        if (response && /(?:json|text|xml|javascript|graphql|urlencoded)/i.test(contentType)) {
          const responseBody = await response.text().catch(() => '');
          if (responseBody) summary.responseBody = compactDiagnosticText(responseBody, detailLimit);
        }
      }
      return summary;
    }));
    return {
      ok: true,
      actual: JSON.stringify(output, null, 2),
    };
  }

  // 切换到指定标签页，并把它设为后续操作的活动页。
  async switchTab(index: number): Promise<BrowserActionResult> {
    const previousGeneration = this.snapshotGeneration;
    const pages = await this.refreshSessionGroupPages({ forceNativeRefresh: true });
    const page = pages[index];
    if (!page) return { ok: false, actual: `Tab ${index} not found.` };
    await this.activateSessionPage(page);
    return this.completeActionWithDomChanges(`Switched to tab ${index}: ${page.url()}`, previousGeneration);
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
    let loadStateTimedOut = false;
    await this.activePage.waitForLoadState('domcontentloaded', { timeout: loadStateTimeoutMs }).catch((error) => {
      if (this.isTargetClosedError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/\btimeout\s+\d+ms\s+exceeded\b/i.test(message)) {
        loadStateTimedOut = true;
        return;
      }
      throw error;
    });
    const stableMs = boundedNonNegativeIntegerEnv(
      'BROWSER_WAIT_FOR_PAGE_STABLE_MS',
      DEFAULT_BROWSER_WAIT_FOR_PAGE_STABLE_MS,
      5000,
    );
    if (stableMs > 0) await this.waitForStableViewport(stableMs);
    const note = await this.manualVerificationNote();
    const status = loadStateTimedOut
      ? `Page is still loading after ${loadStateTimeoutMs}ms; continuing with the current rendered state.`
      : 'Page wait completed.';
    return this.completeActionWithDomChanges(`${status}${note}`, previousGeneration, { invalidateSnapshotCursor: false });
  }

  // 等待固定时间，给短动画、下拉面板或异步更新留出渲染时间。
  async wait(ms = 800): Promise<BrowserActionResult> {
    const previousGeneration = this.snapshotGeneration;
    const waitMs = Number.isFinite(ms) ? Math.max(0, Math.ceil(ms)) : 800;
    await this.waitForStableViewport(waitMs);
    return this.completeActionWithDomChanges(`Waited ${waitMs}ms.`, previousGeneration, { invalidateSnapshotCursor: false });
  }

  // 等待用户手动完成验证码/安全校验，超时后返回阻塞信息。
  async executeBrowserCode(input: {
    code: string;
    runId: string;
    stepIndex: number;
    maxOutputChars?: number;
    credentials?: BrowserCodeCredentialBinding[];
    abortSignal?: AbortSignal;
  }): Promise<BrowserActionResult> {
    const code = String(input.code || '');
    if (!code.trim()) return { ok: false, actual: 'browserCode requires non-empty JavaScript.' };
    if (code.length > 40_000) return { ok: false, actual: 'browserCode JavaScript exceeds the 40000 character limit.' };
    const policyViolation = browserCodePolicyViolation(code);
    if (policyViolation) return { ok: false, actual: policyViolation };
    if (!this.browserCodeConnection) {
      return { ok: false, actual: 'browserCode has no direct Playwright connection for this browser session.' };
    }

    const page = this.activePage;
    await this.ensurePageGroup(page);
    await this.ensureBrowserPageRuntime(page);
    await this.resetInterActionChangeJournal().catch(() => undefined);
    await this.discardDomChanges().catch(() => undefined);
    const initialUrl = page.url();
    const executionId = randomUUID();
    await page.evaluate((id) => {
      Object.defineProperty(window, '__aiBrowserCodeExecutionId', {
        configurable: true,
        enumerable: false,
        value: id,
        writable: false,
      });
    }, executionId);

    if (
      this.browserCodeKernel
      && this.browserCodeKernelRevision !== BROWSER_CODE_KERNEL_RUNTIME_REVISION
    ) {
      await this.browserCodeKernel.close();
      this.browserCodeKernel = undefined;
    }
    const kernel = this.browserCodeKernel ||= new BrowserCodeKernel(this.browserCodeConnection, {
      sessionGroupId: this.pageGroupId,
    });
    this.browserCodeKernelRevision = BROWSER_CODE_KERNEL_RUNTIME_REVISION;
    const executionContext = this.context;
    const pagesBeforeExecution = new Set(executionContext?.pages() || []);
    const pagesCreatedDuringExecution = new Set<Page>();
    const claimCodeCreatedPage = (candidate: Page) => {
      if (candidate.isClosed() || pagesBeforeExecution.has(candidate)) return;
      pagesCreatedDuringExecution.add(candidate);
      this.claimPage(candidate, { makeActive: false });
    };
    executionContext?.on('page', claimCodeCreatedPage);
    let execution: Awaited<ReturnType<BrowserCodeKernel['execute']>>;
    try {
      execution = await kernel.execute({
        code,
        credentials: input.credentials,
        executionId,
        maxOutputChars: input.maxOutputChars,
        abortSignal: input.abortSignal,
      });
    } finally {
      executionContext?.off('page', claimCodeCreatedPage);
      for (const candidate of executionContext?.pages() || []) claimCodeCreatedPage(candidate);
      await Promise.all([
        ...Array.from(pagesCreatedDuringExecution, (candidate) => this.ensurePageGroup(candidate)),
        ...(!page.isClosed() ? [this.ensurePageGroup(page)] : []),
      ]);
      await Promise.all(this.sessionPages().map((candidate) => candidate.evaluate((id) => {
        const win = window as Window & { __aiBrowserCodeExecutionId?: string };
        if (win.__aiBrowserCodeExecutionId === id) delete win.__aiBrowserCodeExecutionId;
      }, executionId).catch(() => undefined)));
    }

    let selectedPage: Page | undefined;
    if (execution.selectedExecutionId) {
      for (const candidate of executionContext?.pages() || this.sessionPages()) {
        const selected = await candidate.evaluate((id) => {
          const win = window as Window & { __aiBrowserCodeSelectedExecutionId?: string };
          if (win.__aiBrowserCodeSelectedExecutionId !== id) return false;
          delete win.__aiBrowserCodeSelectedExecutionId;
          return true;
        }, execution.selectedExecutionId).catch(() => false);
        if (selected && this.claimPage(candidate, { makeActive: false })) {
          await this.ensurePageGroup(candidate);
          selectedPage = candidate;
        }
      }
    }
    const finalPage = selectedPage || (!page.isClosed() ? page : this.sessionPages().find((candidate) => !candidate.isClosed())) || page;
    if (!finalPage.isClosed() && this.page !== finalPage) {
      this.page = finalPage;
      this.notifyLivePreviewTabsChanged();
    }
    const finalUrl = finalPage.isClosed() ? '' : finalPage.url();
    const finalTitle = finalPage.isClosed() ? '' : await finalPage.title().catch(() => '');
    const inferredActivity: BrowserCodeActivity = {
      actions: execution.activity?.actions || [],
      navigationChanged: execution.activity?.navigationChanged === true || finalUrl !== initialUrl,
      tabChanged: execution.activity?.tabChanged === true || finalPage !== page || pagesCreatedDuringExecution.size > 0,
      ...(execution.activity?.verification ? { verification: execution.activity.verification } : {}),
    };
    const shouldReadDomChanges = inferredActivity.actions.length > 0
      || inferredActivity.navigationChanged
      || inferredActivity.tabChanged;
    let domChanges: BrowserActionResult['domChanges'];
    if (shouldReadDomChanges && !finalPage.isClosed()) {
      try {
        domChanges = (await this.readDomChanges()).domChanges;
      } catch {
        domChanges = undefined;
      } finally {
        await this.resetInterActionChangeJournal().catch(() => undefined);
      }
    }
    const emittedImagePaths: string[] = [];
    const emittedImageErrors: string[] = [];
    if (execution.images?.length) {
      const dir = artifactPath(input.runId || 'browser-code');
      try {
        await mkdir(dir, { recursive: true });
        for (const [index, image] of execution.images.entries()) {
          const extension = image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType === 'image/webp' ? 'webp' : 'png';
          const filePath = path.join(dir, `step-${input.stepIndex}-browser-code-${index + 1}-${randomUUID().slice(0, 8)}.${extension}`);
          await writeFile(filePath, Buffer.from(image.data, 'base64'));
          emittedImagePaths.push(filePath);
        }
      } catch (error) {
        emittedImageErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    const actualDomChanges = domChanges
      ? { ...domChanges, observation: undefined }
      : undefined;
    const result: BrowserActionResult = {
      ok: execution.ok,
      actual: JSON.stringify({
        ok: execution.ok,
        result: execution.value ?? null,
        error: execution.error ?? null,
        aborted: execution.aborted === true,
        elapsedMs: execution.elapsedMs,
        finalPage: { url: finalUrl, title: finalTitle },
        ...(inferredActivity.verification ? { verification: inferredActivity.verification } : {}),
        ...(actualDomChanges ? { domChanges: actualDomChanges } : {}),
        images: emittedImagePaths.map((filePath) => ({ fileName: path.basename(filePath) })),
        imageErrors: emittedImageErrors,
      }, null, 2),
      referenceImagePath: emittedImagePaths[0],
      referenceImagePaths: emittedImagePaths,
      verification: inferredActivity.verification,
    };
    return result;
  }

  async waitForManualVerification(maxMs = Number(process.env.MANUAL_VERIFICATION_TIMEOUT_MS || 180000)): Promise<BrowserActionResult> {
    void maxMs;
    const note = await this.manualVerificationNote();
    return {
      ok: true,
      actual: note
        ? '已暂停自动操作：页面需要人工完成验证。请在浏览器中完成验证码、登录/安全验证或其他需要本人确认的步骤；完成后点击对话中的“校验完成，继续执行”。'
        : '已暂停自动操作，等待您检查浏览器并完成可能需要的人工验证；完成后点击对话中的“校验完成，继续执行”。',
    };
  }

  // 返回本次会话采集到的关键网络失败。
  getNetworkErrors() {
    return this.networkErrors;
  }

  // 关闭浏览器；调试场景可选择保留窗口。
  async close(options: { closePages?: boolean; force?: boolean; keepOpen?: boolean; preservePages?: boolean } = {}) {
    const shouldKeepOpen = !options.force && (
      options.keepOpen === true
    );
    let disposeLocalState = false;
    await this.browserCodeKernel?.close();
    this.browserCodeKernel = undefined;
    this.browserCodeKernelRevision = undefined;
    try {
      if (this.context && this.pageDiscoveryListener) {
        this.context.off('page', this.pageDiscoveryListener);
        this.pageDiscoveryListener = undefined;
      }
      if (this.browserOwnership === 'shared') {
        if (this.browserSurface !== 'electron-embedded' && !shouldKeepOpen && !options.preservePages) {
          await this.closeOwnedPages();
        }
        await this.releaseSharedBrowser?.(options.force);
        this.releaseSharedBrowser = undefined;
        disposeLocalState = true;
        return;
      }
      if (shouldKeepOpen) return;
      if (this.browserOwnership === 'connected') {
        if (this.browserSurface === 'electron-embedded') {
          await this.clearElectronEmbeddedSessionData();
          await this.closeOwnedPages();
          return;
        }
        if (options.closePages) await this.closeOwnedPages();
        let managedProfileBrowserClosed = false;
        if (options.force && this.browser) {
          const client = await this.browser.newBrowserCDPSession().catch(() => undefined);
          if (client) {
            managedProfileBrowserClosed = await Promise.race([
              client.send('Browser.close').then(() => true).catch(() => false),
              sleep(1000).then(() => false),
            ]);
            await Promise.race([
              client.detach().catch(() => undefined),
              sleep(500),
            ]);
          }
        }
        await this.browser?.close({ reason: 'AI test run finished; disconnecting from existing browser.' }).catch(() => undefined);
        if (managedProfileBrowserClosed && this.managedProfileDir) await clearManagedBrowserProfileCaches(this.managedProfileDir);
        return;
      }
      if (this.browserOwnership === 'persistent') {
        await this.context?.close().catch(() => undefined);
        if (this.managedProfileDir) await clearManagedBrowserProfileCaches(this.managedProfileDir);
        return;
      }
      await this.browser?.close().catch(() => undefined);
      await this.browserServer?.close().catch(() => undefined);
    } finally {
      if (!shouldKeepOpen || disposeLocalState) {
        browserSessionProcessState.sessions.delete(this);
        this.page = undefined;
        this.context = undefined;
        this.browser = undefined;
        this.browserServer = undefined;
        this.browserCodeConnection = undefined;
        this.browserCodeKernel = undefined;
        this.browserCodeKernelRevision = undefined;
        this.managedProfileDir = undefined;
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
    await this.ensurePageGroup(this.activePage);
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

  private async insertFocusedTextFast(text: string, timings?: Record<string, number>): Promise<boolean> {
    if (!text) return true;
    // Do the value update inside the document first.  Unlike
    // locator.pressSequentially(), this has no per-character actionability
    // wait, so a focused search box cannot spend the full default timeout
    // while an application rerenders around it.  Returning false is reserved
    // for controls that are not native text inputs/contenteditables; callers
    // can then use Playwright's keyboard path as the compatibility fallback.
    return Boolean(await timedBrowserStep(timings, 'domTextMs', () => this.insertTextIntoFocusedElement(text)));
  }

  private async insertTextIntoFocusedElement(text: string) {
    return Boolean(await this.activePage.evaluate((value) => {
      const active = document.activeElement;
      if (!active) return false;
      const input = active as HTMLInputElement;
      const isTextControl = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
      if (isTextControl) {
        // Preserve the observable keyboard lifecycle expected by pages that
        // listen for it, but dispatch it inside one page evaluation rather
        // than waiting for Playwright to type every character.
        for (const key of Array.from(value)) {
          active.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key }));
          active.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, cancelable: true, key }));
        }
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
        for (const key of Array.from(value)) {
          active.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key }));
        }
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
    const waitMs = Math.max(0, Math.ceil(ms));
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const remainingMs = Math.max(0, deadline - Date.now());
      try {
        await this.activePage.waitForTimeout(remainingMs);
        return;
      } catch (error) {
        if (!this.isTargetClosedError(error)) throw error;
        const replacement = this.sessionPages()[0];
        if (!replacement) throw error;
        this.page = replacement;
        this.notifyLivePreviewTabsChanged();
        this.attachPageListeners(replacement);
      }
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
    const configuredWaitMs = this.options.popupWaitMs;
    const waitMs = typeof configuredWaitMs === 'number' && Number.isFinite(configuredWaitMs) && configuredWaitMs >= 0
      ? Math.min(3000, Math.floor(configuredWaitMs))
      : boundedNonNegativeIntegerEnv('BROWSER_POPUP_WAIT_MS', DEFAULT_BROWSER_POPUP_WAIT_MS, 3000);
    return {
      waitMs,
      popup: waitMs > 0
        ? page.waitForEvent('popup', { timeout: waitMs }).catch(() => undefined)
        : Promise.resolve(undefined),
    };
  }

  private async claimPopupPage(
    newPage: Page | undefined,
    timings?: Record<string, number>,
    selectionSequence = this.livePreviewExplicitPageSelectionSequence,
  ) {
    if (!newPage) return undefined;
    this.claimPage(newPage, { makeActive: false });
    await this.ensurePageGroup(newPage);
    if (selectionSequence !== this.livePreviewExplicitPageSelectionSequence) return newPage;
    await timedBrowserStep(timings, 'bringPopupToFrontMs', () => newPage.bringToFront().catch(() => undefined));
    if (
      selectionSequence === this.livePreviewExplicitPageSelectionSequence
      && !newPage.isClosed()
      && this.ownedPages.has(newPage)
    ) {
      this.page = newPage;
      this.notifyLivePreviewTabsChanged();
    }
    return newPage;
  }

  private async settlePopupAfterAction(popup: Promise<Page | undefined>, waitMs: number, timings?: Record<string, number>) {
    if (waitMs <= 0) return undefined;
    const selectionSequence = this.livePreviewExplicitPageSelectionSequence;
    const fastWaitMs = Math.min(waitMs, boundedNonNegativeIntegerEnv('BROWSER_POPUP_FAST_WAIT_MS', 250, 1000));
    const newPage = await timedBrowserStep(timings, 'popupFastWaitMs', () => Promise.race([
      popup,
      sleep(fastWaitMs).then(() => undefined),
    ]));
    if (newPage) return this.claimPopupPage(newPage, timings, selectionSequence);
    void popup.then((latePage) => this.claimPopupPage(latePage, undefined, selectionSequence).catch(() => undefined));
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
              if (item.closest && item.closest('#__ai_candidate_overlay__, #__ai_mouse_cursor__, #__ai_dom_export_control__')) continue;
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

  private async elementHandleForDomReference(reference: DomNodeReference) {
    if (!reference.localRef) return undefined;
    const frame = reference.framePath ? this.frameFromPath(reference.framePath) : this.activePage.mainFrame();
    if (!frame) return undefined;
    await this.ensureBrowserPageRuntime(frame);
    const handle = await frame.evaluateHandle((ref) => {
      const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime;
      return runtime?.visibleDomElement(ref) || null;
    }, reference.localRef).catch(() => undefined);
    const element = handle?.asElement();
    if (!element) {
      await handle?.dispose().catch(() => undefined);
      return undefined;
    }
    return element as ElementHandle<Element>;
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
        .filter((element) => !element.closest?.('#__ai_candidate_overlay__, #__ai_mouse_cursor__, #__ai_dom_export_control__'))
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
          const rawValue = ['input', 'select', 'textarea'].includes(tag) ? normalize(field.value).slice(0, 300) : '';
          const sensitiveInput = ['input', 'textarea'].includes(tag) && (
            inputType === 'password'
            || /(?:^|\s)(?:current-password|new-password|one-time-code)(?:\s|$)/i.test(element.getAttribute('autocomplete') || '')
            || element.getAttribute('data-webpilot-sensitive-input') === 'true'
          );
          const value = sensitiveInput && rawValue ? '[redacted]' : rawValue;
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
    const navigationSequenceBefore = this.navigationSequenceByPage.get(page) || 0;
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
      const capturedDom = await captureDomSnapshot(page);
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
    const navigationSequence = this.navigationSequenceByPage.get(page) || 0;
    const mutationChangedDuringCapture = Object.keys(mutationEpochsBefore).length !== Object.keys(mutationEpochs).length
      || Object.keys(mutationEpochs).some((key) => mutationEpochs[key] !== mutationEpochsBefore[key]);
    if ((mutationChangedDuringCapture || navigationSequence !== navigationSequenceBefore) && !retryAfterMutation) {
      return this.buildSnapshotGeneration(true);
    }
    this.pruneSnapshotUidMappings();
    return {
      id,
      createdAt: new Date().toISOString(),
      page,
      url: page.url(),
      navigationSequence,
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
      const changed = await this.snapshotMutationChanged(this.snapshotGeneration).catch(() => true);
      if (!changed) return this.snapshotGeneration;
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
    if (generation.navigationSequence !== (this.navigationSequenceByPage.get(this.activePage) || 0)) return true;
    const current = await this.readSnapshotMutationEpochs();
    const previousKeys = Object.keys(generation.mutationEpochs);
    const currentKeys = Object.keys(current);
    if (previousKeys.length !== currentKeys.length) return true;
    return currentKeys.some((key) => current[key] !== generation.mutationEpochs[key]);
  }

  private async readNavigationDomStabilitySample(): Promise<NavigationDomStabilitySample> {
    const frameTargets = await this.snapshotFrameTargets();
    const entries = await Promise.all(frameTargets.map(async (target) => {
      await this.ensureBrowserPageRuntime(target.frame);
      const state = await target.frame.evaluate(() => {
        const mutation = (window as WindowWithAiDomRuntime).__aiDomMutationState;
        return {
          url: window.location.href,
          readyState: document.readyState,
          epoch: Number(mutation?.epoch || 0),
          lastMutationAt: Number(mutation?.lastMutationAt || 0),
        };
      }).catch(() => undefined);
      if (!state) return undefined;
      return {
        key: this.snapshotMutationKey(target),
        url: snapshotFrameUrl(state.url),
        readyState: state.readyState,
        epoch: state.epoch,
        lastMutationAt: state.lastMutationAt,
      };
    }));
    if (entries.some((entry) => !entry)) return { ready: false, signature: '' };
    const resolved = entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    return {
      ready: resolved.length > 0 && resolved.every((entry) => entry.readyState !== 'loading'),
      signature: JSON.stringify(resolved),
    };
  }

  private async waitForNavigationDomStability(): Promise<NavigationDomStabilityResult | undefined> {
    const quietMs = boundedNonNegativeIntegerEnv(
      'BROWSER_NAVIGATION_DOM_QUIET_MS',
      DEFAULT_BROWSER_NAVIGATION_DOM_QUIET_MS,
      2000,
    );
    const timeoutMs = boundedNonNegativeIntegerEnv(
      'BROWSER_NAVIGATION_DOM_STABILITY_TIMEOUT_MS',
      DEFAULT_BROWSER_NAVIGATION_DOM_STABILITY_TIMEOUT_MS,
      5000,
    );
    if (quietMs === 0 || timeoutMs === 0) return undefined;

    const startedAt = Date.now();
    let stableSince: number | undefined;
    let previousSignature: string | undefined;
    while (Date.now() - startedAt < timeoutMs) {
      const remainingBeforeSampleMs = timeoutMs - (Date.now() - startedAt);
      if (remainingBeforeSampleMs <= 0) break;
      let sampleDeadline: ReturnType<typeof setTimeout> | undefined;
      const sample = await Promise.race([
        this.readNavigationDomStabilitySample().catch(() => ({ ready: false, signature: '' })),
        new Promise<undefined>((resolve) => {
          sampleDeadline = setTimeout(() => resolve(undefined), remainingBeforeSampleMs);
        }),
      ]);
      if (sampleDeadline) clearTimeout(sampleDeadline);
      if (!sample) break;
      const sampledAt = Date.now();
      if (!sample.ready) {
        previousSignature = undefined;
        stableSince = undefined;
      } else if (sample.signature !== previousSignature) {
        previousSignature = sample.signature;
        stableSince = sampledAt;
      } else if (stableSince !== undefined && sampledAt - stableSince >= quietMs) {
        return { stable: true, waitedMs: sampledAt - startedAt, quietMs, timeoutMs };
      }

      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) break;
      await sleep(Math.min(BROWSER_NAVIGATION_DOM_STABILITY_POLL_MS, remainingMs));
    }
    return { stable: false, waitedMs: Date.now() - startedAt, quietMs, timeoutMs };
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
    const frames = this.actionFrames();
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
    clickTimings?: BrowserClickTiming,
  ): Promise<BrowserActionResult> {
    if (clickTimings) {
      await timeBrowserClickStage(clickTimings, 'postActionSettleMs', () => this.activePage.waitForTimeout(40).catch(() => undefined));
    } else {
      await this.activePage.waitForTimeout(40).catch(() => undefined);
    }
    let verification: BrowserActionVerification;
    try {
      verification = clickTimings
        ? await timeBrowserClickStage(clickTimings, 'verificationMs', verify)
        : await verify();
    } catch (error) {
      verification = { ok: false, detail: `verification failed: ${unknownErrorMessage(error)}` };
    }
    const result = await this.completeActionWithDomChanges(
      `${actual} Post-action check: ${verification.detail}`,
      previousGeneration,
      { clickTimings },
    );
    const domChanges = result.domChanges;
    const observableStateChanged = Boolean(
      domChanges
      && (
        domChanges.added.length
        || domChanges.updated.length
        || domChanges.removed.length
        || domChanges.observation
          && ['opened', 'closed', 'changed'].includes(domChanges.observation.surfaceTransition)
      ),
    ) || /Navigation changed the document\./.test(result.actual);
    const passed = result.ok && (verification.ok || observableStateChanged);
    const verificationDetail = observableStateChanged && !verification.ok
      ? `${verification.detail} A concrete DOM, active-surface, or navigation state change was observed.`
      : verification.detail;
    result.verification = {
      status: passed ? 'passed' : 'failed',
      detail: verificationDetail,
    };
    if (!passed) {
      result.ok = false;
      result.actual = `${result.actual} Runtime verification is a hard condition; the action must not be treated as complete. Re-observe the current page and choose the next single operation from fresh evidence.`;
    }
    return result;
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

  private async editableValue(locator?: Locator, handle?: ElementHandle<Element>) {
    const read = (element: Element) => {
      const field = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      return 'value' in field ? String(field.value) : String(element.textContent || '');
    };
    if (handle) return handle.evaluate(read).catch(() => undefined);
    if (locator) return locator.evaluate(read).catch(() => undefined);
    return undefined;
  }

  private async hasFocusedNativeSelect() {
    for (const frame of this.activePage.frames()) {
      const focused = await frame.evaluate(() => document.activeElement instanceof HTMLSelectElement).catch(() => false);
      if (focused) return true;
    }
    return false;
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

  private async completeActionWithDomChanges(
    actual: string,
    previousGeneration: SnapshotGeneration | undefined,
    options: { postNavigation?: boolean; invalidateSnapshotCursor?: boolean; clickTimings?: BrowserClickTiming } = {},
  ): Promise<BrowserActionResult> {
    this.lastScreenshotMetrics = undefined;
    // A cursor represents one immutable pre-action DOM baseline. Even an
    // action with no observed mutation can change focus, overlays, or state.
    if (options.invalidateSnapshotCursor !== false) this.domObservationPagination = undefined;
    try {
      const currentPage = this.activePage;
      const postNavigation = options.postNavigation === true || Boolean(previousGeneration && (
        previousGeneration.page !== currentPage
        || snapshotFrameUrl(previousGeneration.url) !== snapshotFrameUrl(currentPage.url())
        || previousGeneration.navigationSequence !== (this.navigationSequenceByPage.get(currentPage) || 0)
      ));
      const stability = postNavigation
        ? options.clickTimings
          ? await timeBrowserClickStage(options.clickTimings, 'navigationDomStabilityMs', () => this.waitForNavigationDomStability())
          : await this.waitForNavigationDomStability()
        : undefined;
      const stabilityNote = !stability
        ? ''
        : stability.stable
          ? ` Navigation DOM stabilized for ${stability.quietMs}ms after ${stability.waitedMs}ms.`
          : ` Navigation DOM stability wait reached the ${stability.timeoutMs}ms cap; continuing with the current DOM.`;
      if (postNavigation) {
        this.invalidateSnapshotGeneration();
        this.lastDomNodeReferences.clear();
        this.domVisiblePublicIdByFrameLocalRef.clear();
        this.domVisibleSnapshotKey = undefined;
        this.domVisibleObservationId = undefined;
        this.domVisibleExposedReferenceIds.clear();
        const observation = await this.readPageObservation().catch(() => undefined);
        const result = {
          ok: true,
          actual: `${actual}${stabilityNote} Navigation changed the document. DOM UID registry was cleared; call takeSnapshot when you need targets in the new document.`,
          ...(observation ? { observation } : {}),
        };
        if (options.clickTimings) {
          options.clickTimings.domChangesMs = 0;
          await timeBrowserClickStage(options.clickTimings, 'journalResetMs', () => this.resetInterActionChangeJournal());
        } else {
          await this.resetInterActionChangeJournal();
        }
        return result;
      }
      const changes = options.clickTimings
        ? await timeBrowserClickStage(options.clickTimings, 'domChangesMs', () => this.readDomChanges())
        : await this.readDomChanges();
      const validationErrors = changes.domChanges?.extra.validationErrors || [];
      const validationNote = validationErrors.length
        ? ` Post-action form validation failed: ${validationErrors.slice(0, 3).join(' | ')}. Treat this operation as failed; fix the stated fields before continuing.`
        : '';
      const result = {
        ok: validationErrors.length === 0,
        actual: `${actual}${stabilityNote}${validationNote}`,
        snapshotId: changes.snapshotId,
        observation: changes.observation,
        domChanges: changes.domChanges,
      };
      if (options.clickTimings) {
        await timeBrowserClickStage(options.clickTimings, 'journalResetMs', () => this.resetInterActionChangeJournal());
      } else {
        await this.resetInterActionChangeJournal();
      }
      return result;
    } catch (error) {
      const result = {
        ok: true,
        actual: `${actual} DOM incremental change read was unavailable: ${unknownErrorMessage(error)}. Call takeSnapshot if fresh page state is required.`,
      };
      await this.resetInterActionChangeJournal().catch(() => undefined);
      return result;
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

  async searchSnapshot(input: { query?: string; tag?: string; roles?: string[]; limit?: number }): Promise<BrowserActionResult> {
    const query = normalizeDomSearchText(input.query);
    const tag = normalizeDomSearchText(input.tag);
    if (!query && !tag) return { ok: false, actual: 'Snapshot search requires a non-empty query or tag.' };
    const roles = new Set((input.roles || []).map(normalizeDomSearchText));
    const queryParts = query.split(/\s+/).filter(Boolean);
    const limit = Math.min(100, Math.max(1, Math.floor(Number(input.limit) || 20)));

    // Search is a pure read of the frozen baseline. It must not consume the
    // MutationObserver queue, refresh the UID registry, scroll, or invalidate
    // an in-progress snapshot cursor.
    if (this.domVisibleSnapshotKey && this.lastDomNodeReferences.size > 0) {
      const collectMatches = () => [...this.lastDomNodeReferences.values()]
        .filter((reference) => {
          if (tag && reference.tag !== tag) return false;
          if (roles.size && ![...roles].some((role) => reference.semanticRoles.includes(role))) return false;
          return !query || reference.searchText.includes(query) || queryParts.every((part) => reference.searchText.includes(part));
        })
        .sort((left, right) => {
          if (tag && !query) {
            return left.path.localeCompare(right.path, undefined, { numeric: true })
              || left.id.localeCompare(right.id, undefined, { numeric: true });
          }
          const score = (reference: DomNodeReference) => {
            const label = reference.normalizedLabel;
            const context = reference.normalizedContext;
            const line = reference.normalizedLine;
            let value = reference.priority || 0;
            if (label === query) value += 140;
            else if (label.startsWith(query)) value += 110;
            else if (label.includes(query)) value += 85;
            else if (queryParts.length > 1 && queryParts.every((part) => label.includes(part))) value += 72;
            else if (line.includes(query)) value += 35;
            if (context === query) value += 55;
            else if (context.includes(query)) value += 28;
            if (reference.interactive) value += 30;
            if (reference.confidence === 'high') value += 15;
            else if (reference.confidence === 'medium') value += 7;
            if (reference.locatorCandidates?.some((candidate) => /data-test|data-qa|data-cy|#[\w-]+/.test(candidate))) value += 12;
            if (roles.has('combobox') && reference.capabilities?.includes('select')) value += 24;
            if (roles.has('textbox') && reference.capabilities?.includes('fill')) value += 24;
            if (/\b(?:focused|selected|modal)=true\b/.test(line)) value += 12;
            if (/\bdisabled=true\b/.test(line)) value -= 35;
            return value;
          };
          return score(right) - score(left)
            || left.path.localeCompare(right.path, undefined, { numeric: true })
            || left.id.localeCompare(right.id, undefined, { numeric: true });
        });
      const allMatches = collectMatches();
      const matches = tag ? allMatches : allMatches.slice(0, limit);
      for (const reference of matches) this.domVisibleExposedReferenceIds.add(reference.id);
      return {
        ok: true,
        snapshotId: this.domVisibleObservationId,
        actual: [
          `Frozen DOM baseline ${this.domVisibleObservationId || 'unknown'} ${tag ? `tag read for <${tag}>` : `search for "${input.query}"`} returned ${matches.length} result(s). The search did not scroll, consume DOM changes, or alter snapshot pagination.`,
          matches.map((reference) => reference.line).join('\n') || '[no DOM baseline matches]',
        ].join('\n'),
      };
    }
    return {
      ok: false,
      actual: 'searchSnapshot requires an active DOM baseline. Call takeSnapshot first; searchSnapshot never creates or searches a separate CDP UID namespace.',
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
          if (candidate.closest('#__ai_candidate_overlay__, #__ai_mouse_cursor__, #__ai_dom_export_control__')) continue;
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

  private async resolveStructuredActionTarget(
    target: BrowserElementTarget,
    allowNonActionable: boolean,
  ): Promise<ResolvedBrowserActionPoint> {
    const currentObservationId = this.domVisibleObservationId;
    if (!currentObservationId) {
      return { error: 'STALE_TARGET: no DOM snapshot is currently bound on the backend. Capture a fresh inspect result before acting.' };
    }

    const ref = String(target.ref).trim();
    if (!ref) return { error: 'TARGET_NOT_FOUND: ref target is empty.' };
    if (ref.startsWith('dom-')) {
      const reference = this.lastDomNodeReferences.get(ref);
      if (!reference) return { error: `STALE_TARGET: ref ${ref} is absent from the current DOM registry. Capture a fresh inspect result.` };
      if (reference.observationId !== currentObservationId) {
        return { error: `STALE_TARGET: ref ${ref} does not belong to the latest backend-bound snapshot. Capture a fresh inspect result and use a ref exposed by it.` };
      }
      if (!this.domVisibleExposedReferenceIds.has(ref)) {
        return { error: `STALE_TARGET: ref ${ref} was not exposed in the read pages of the latest backend-bound snapshot. Read that page or search the current snapshot first.` };
      }
      return this.resolveDomObservationReferencePoint(ref, allowNonActionable);
    }

    const reference = this.currentSnapshotReference(ref);
    if (!reference.reference) return { error: reference.error };
    return this.resolveSnapshotReferencePoint(ref, allowNonActionable);
  }

  private async resolveDomObservationReferencePoint(uid: string, allowNonActionable = false) {
    const reference = this.lastDomNodeReferences.get(uid);
    if (!reference) {
      const registryCount = this.lastDomNodeReferences.size;
      const baselineState = this.domVisibleSnapshotKey ? 'an active DOM baseline' : 'no active DOM baseline';
      return {
        error: `UID ${uid} is absent from the current DOM UID registry (${registryCount} registered UIDs; ${baselineState}). It was not necessarily removed: it may belong to a different snapshot/UID namespace, or it may appear in domChanges.removed. Use a UID exactly as returned by the latest takeSnapshot or searchSnapshot; do not add or change the dom- prefix.`,
      };
    }
    if (!allowNonActionable && !reference.interactive) {
      return { error: `UID ${uid} (${reference.tag} "${reference.label}") is structural text, not an actionable control.` };
    }
    if (!reference.localRef || !reference.contextId) {
      return { error: `UID ${uid} has no live DOM reference. Call takeSnapshot and choose a current UID.` };
    }
    const frame = reference.framePath ? this.frameFromPath(reference.framePath) : this.activePage.mainFrame();
    if (!frame) return { error: `UID ${uid} belongs to an iframe that no longer exists.` };
    await this.ensureBrowserPageRuntime(frame);
    const localPoint = await frame.evaluate((input) => {
      const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime;
      return runtime?.visibleDomPoint(input.ref, input.viewportClip);
    }, { ref: reference.localRef, viewportClip: reference.viewportClip }).catch(() => undefined);
    if (!localPoint) {
      this.lastDomNodeReferences.delete(uid);
      return { error: `UID ${uid} is detached, hidden, or covered and was removed from the DOM UID registry.` };
    }
    let offsetX = 0;
    let offsetY = 0;
    if (frame !== this.activePage.mainFrame()) {
      const frameBox = await frame.frameElement().then((element) => element.boundingBox()).catch(() => undefined);
      if (!frameBox) return { error: `UID ${uid} belongs to an iframe that is no longer visible.` };
      offsetX = frameBox.x;
      offsetY = frameBox.y;
    }
    return {
      reference,
      point: {
        x: Math.round(localPoint.x + offsetX),
        y: Math.round(localPoint.y + offsetY),
        descriptor: localPoint.descriptor || reference.descriptor,
        source: 'dom-observation',
        coveredBy: localPoint.coveredBy,
      },
    };
  }

  private async editableIframeLocator(reference: DomNodeReference, point: { x: number; y: number }) {
    if (reference.tag !== 'iframe' && reference.tag !== 'frame') return undefined;
    const parentFrame = reference.framePath ? this.frameFromPath(reference.framePath) : this.activePage.mainFrame();
    if (!parentFrame) return undefined;
    const childFrames = this.activePage.frames().filter((frame) => frame.parentFrame() === parentFrame);
    const matchedFrames: Frame[] = [];
    for (const frame of childFrames) {
      const box = await frame.frameElement().then((element) => element.boundingBox()).catch(() => undefined);
      if (box && point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height) {
        matchedFrames.push(frame);
      }
    }
    const frame = matchedFrames[0] || (childFrames.length === 1 ? childFrames[0] : undefined);
    if (!frame) return undefined;
    const candidates = frame.locator('[contenteditable=""], [contenteditable="true"], textarea, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])');
    const count = Math.min(20, await candidates.count().catch(() => 0));
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isEditable().catch(() => false)) return candidate;
    }
    return undefined;
  }

  private async resolveScreenshotPoint(xThousandth?: number, yThousandth?: number) {
    const xPart = Number(xThousandth);
    const yPart = Number(yThousandth);
    if (!Number.isInteger(xPart) || !Number.isInteger(yPart) || xPart < 1 || xPart > 999 || yPart < 1 || yPart > 999) {
      return { error: 'Screenshot coordinates must provide integer x_thousandth and y_thousandth values from 1 to 999.' };
    }
    const metrics = this.lastScreenshotMetrics;
    if (!metrics || metrics.capture !== 'viewport') {
      return { error: 'No current actionable viewport screenshot exists. Emit a fresh viewport image from browserCode before using coordinates.' };
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
    input: {
      target?: BrowserElementTarget;
      uid?: string;
      xThousandth?: number;
      yThousandth?: number;
      force?: boolean;
    },
    allowNonActionable = false,
  ): Promise<ResolvedBrowserActionPoint> {
    const legacyUid = typeof input.uid === 'string' ? input.uid.trim() : '';
    const target = input.target || (legacyUid ? { kind: 'ref' as const, ref: legacyUid } : undefined);
    const hasTarget = Boolean(target);
    const hasAnyCoordinate = input.xThousandth !== undefined || input.yThousandth !== undefined;
    if (hasTarget && hasAnyCoordinate) return { error: 'Use either a snapshot-bound target or screenshot coordinates, never both.' };
    if (target) {
      if (input.target) {
        return this.resolveStructuredActionTarget(target, allowNonActionable);
      }
      return legacyUid.startsWith('dom-')
        ? this.resolveDomObservationReferencePoint(legacyUid, allowNonActionable)
        : this.resolveSnapshotReferencePoint(legacyUid, allowNonActionable);
    }
    if (hasAnyCoordinate) return this.resolveScreenshotPoint(input.xThousandth, input.yThousandth);
    return { error: 'A snapshot-bound target or the latest screenshot x_thousandth/y_thousandth coordinates are required.' };
  }

  async mouse(input: BrowserMouseAction): Promise<BrowserActionResult> {
    const throwIfAborted = () => {
      if (!input.abortSignal?.aborted) return;
      throw input.abortSignal.reason instanceof Error
        ? input.abortSignal.reason
        : new Error('Browser mouse action was cancelled.');
    };
    throwIfAborted();
    const page = this.activePage;
    const previousGeneration = this.snapshotGeneration;
    if (input.action === 'scroll') {
      let point: { x: number; y: number; descriptor: string; source: string } | undefined;
      let targetLocator: Locator | undefined;
      if (input.target || input.uid || input.xThousandth !== undefined || input.yThousandth !== undefined) {
        const resolved = await this.unifiedActionPoint(input, true);
        throwIfAborted();
        if (!resolved.point) return { ok: false, actual: resolved.error || 'Unable to resolve scroll target.' };
        point = resolved.point;
        targetLocator = resolved.reference && isSnapshotReference(resolved.reference) ? await this.snapshotReferenceLocator(resolved.reference) : undefined;
        if (targetLocator) await targetLocator.hover();
        else await page.mouse.move(point.x, point.y);
        await this.showAiMouseCursor(page, point.x, point.y, 'move');
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
      if (!input.target && !input.uid) return { ok: false, actual: 'scrollIntoView requires a current snapshot-bound target.' };
      const resolved = await this.unifiedActionPoint({ target: input.target, uid: input.uid }, true);
      if (!resolved.point) return { ok: false, actual: resolved.error || 'Unable to scroll the target into view.' };
      const targetLocator = resolved.reference && isSnapshotReference(resolved.reference) ? await this.snapshotReferenceLocator(resolved.reference) : undefined;
      return this.completeVerifiedAction(
        `Scrolled target ${resolved.point.descriptor} into view.`,
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

    const targetResolutionStartedAt = Date.now();
    const forceClick = input.action === 'click' && input.force === true;
    const from = await this.unifiedActionPoint(input, input.action === 'move' || forceClick);
    throwIfAborted();
    if (!from.point) return { ok: false, actual: from.error || 'Unable to resolve mouse target.' };
    const fromPoint = from.point;
    const fromLocator = !forceClick && from.reference && isSnapshotReference(from.reference) ? await this.snapshotReferenceLocator(from.reference) : undefined;
    const targetResolutionMs = Date.now() - targetResolutionStartedAt;
    throwIfAborted();
    if (fromPoint.coveredBy && input.action !== 'click') {
      return {
        ok: false,
        actual: `Target ${input.uid || fromPoint.descriptor} is currently covered by ${fromPoint.coveredBy}; ${input.action} was not sent. Dismiss the top layer or inspect the current dialog first.`,
      };
    }
    if (input.action === 'move') {
      const eventsBefore = await this.readInteractionCounts();
      if (fromLocator) await fromLocator.hover();
      else await page.mouse.move(from.point.x, from.point.y);
      await this.showAiMouseCursor(page, from.point.x, from.point.y, 'move');
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
        target: input.toTarget,
        uid: input.toUid,
        xThousandth: input.toXThousandth,
        yThousandth: input.toYThousandth,
      }, true);
      throwIfAborted();
      if (!to.point) return { ok: false, actual: to.error || 'Unable to resolve drag destination.' };
      const toLocator = to.reference && isSnapshotReference(to.reference) ? await this.snapshotReferenceLocator(to.reference) : undefined;
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
        await this.showAiMouseCursor(page, from.point.x, from.point.y, 'move');
        await page.mouse.down({ button });
        await page.mouse.move(from.point.x + 8, from.point.y + 4, { steps: 3 });
        await page.mouse.move(to.point.x, to.point.y, { steps: 12 });
        await page.mouse.up({ button });
        await this.showAiMouseCursor(page, to.point.x, to.point.y, 'drag');
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
    const clickTimings: BrowserClickTiming = {
      targetResolutionMs,
      preClickInteractionReadMs: 0,
      waitForClickableMs: 0,
      clickDispatchMs: 0,
      popupListenerSetupMs: 0,
      popupWaitMs: 0,
      postActionSettleMs: 0,
      verificationMs: 0,
      navigationDomStabilityMs: 0,
      domChangesMs: 0,
      journalResetMs: 0,
      resultAssemblyMs: 0,
      totalMs: 0,
    };
    if (fromPoint.coveredBy && !forceClick) {
      clickTimings.totalMs = Date.now() - targetResolutionStartedAt;
      return {
        ok: false,
        actual: `Target ${input.uid || fromPoint.descriptor} is currently covered by ${fromPoint.coveredBy}, so no click was sent. Inspect the active layer first. Use force=true only when the fresh page state confirms this exact click is intended to close that layer.`,
        clickTimings,
      };
    }
    const fromDomHandle = !forceClick && from.reference && !isSnapshotReference(from.reference)
      ? await this.elementHandleForDomReference(from.reference)
      : undefined;
    if (!forceClick && from.reference && !isSnapshotReference(from.reference) && !fromDomHandle) {
      return { ok: false, actual: 'The selected target no longer resolves to the exact live DOM element. Capture a fresh DOM snapshot before retrying.' };
    }
    const playwrightClickTarget = forceClick ? undefined : fromLocator || fromDomHandle;
    if (playwrightClickTarget) {
      try {
        await timeBrowserClickStage(clickTimings, 'waitForClickableMs', () => playwrightClickTarget.click({
          button,
          clickCount,
          noWaitAfter: true,
          trial: true,
        }));
      } catch (error) {
        await fromDomHandle?.dispose().catch(() => undefined);
        clickTimings.totalMs = Date.now() - targetResolutionStartedAt;
        return {
          ok: false,
          actual: `Target ${input.uid || from.point.descriptor} failed Playwright actionability validation and was not clicked: ${unknownErrorMessage(error)}`,
          clickTimings,
        };
      }
    }
    const eventsBefore = await timeBrowserClickStage(clickTimings, 'preClickInteractionReadMs', () => this.readInteractionCounts());
    const urlBefore = page.url();
    const popupSetupStartedAt = Date.now();
    const popup = this.watchForPopup(page);
    clickTimings.popupListenerSetupMs = Date.now() - popupSetupStartedAt;
    try {
      throwIfAborted();
      if (fromLocator) {
        await fromLocator.evaluate((element) => {
          (window as WindowWithAiDomRuntime).__aiDomRuntime?.markSurfaceInteraction(element);
        }).catch(() => undefined);
      } else if (fromDomHandle) {
        await fromDomHandle.evaluate((element) => {
          (window as WindowWithAiDomRuntime).__aiDomRuntime?.markSurfaceInteraction(element);
        }).catch(() => undefined);
      } else {
        await page.evaluate(({ x, y }) => {
          const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime;
          const target = runtime?.topmostRenderableAt(x, y, { requirePointerEvents: true });
          if (target) runtime?.markSurfaceInteraction(target);
        }, { x: fromPoint.x, y: fromPoint.y }).catch(() => undefined);
      }
      await this.showAiMouseCursor(page, fromPoint.x, fromPoint.y, clickCount > 1 ? 'double' : button === 'right' ? 'right' : 'click');
      await timeBrowserClickStage(clickTimings, 'clickDispatchMs', () => (
        playwrightClickTarget
          ? playwrightClickTarget.click({ button, clickCount, noWaitAfter: true })
          : page.mouse.click(fromPoint.x, fromPoint.y, { button, clickCount })
      ));
    } catch (error) {
      if (input.abortSignal?.aborted) throw error;
      clickTimings.totalMs = Date.now() - targetResolutionStartedAt;
      return {
        ok: false,
        actual: `Target ${input.uid || from.point.descriptor} became non-actionable before Playwright could click it: ${unknownErrorMessage(error)}`,
        clickTimings,
      };
    } finally {
      await fromDomHandle?.dispose().catch(() => undefined);
    }
    throwIfAborted();
    const claimedPopup = await timeBrowserClickStage(clickTimings, 'popupWaitMs', () => this.settlePopupAfterAction(popup.popup, popup.waitMs));
    const result = await this.completeVerifiedAction(
      `Clicked ${from.point.descriptor} at (${from.point.x}, ${from.point.y}) with button=${button}, count=${clickCount}, source=${forceClick ? 'explicit-forced-real-pointer' : fromDomHandle ? 'dom-observation+playwright-actionability' : from.point.source}.`,
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
      clickTimings,
    );
    // A native <select> opens a browser/OS-owned popup. Its options do not
    // enter the page DOM and therefore cannot be reported by MutationObserver.
    // Re-emit the select's current semantic line so the post-click delta still
    // exposes its options and the caller can continue with selectOption.
    const nativeSelectReference = from.reference
      && !isSnapshotReference(from.reference)
      && from.reference.tag === 'select'
      ? from.reference
      : undefined;
    const clickedNativeSelect = (
      button === 'left'
      && clickCount === 1
      && nativeSelectReference
    );
    const resultAssemblyStartedAt = Date.now();
    if (clickedNativeSelect) {
      if (
        result.domChanges
        && !result.domChanges.added.includes(nativeSelectReference.line)
        && !result.domChanges.updated.includes(nativeSelectReference.line)
      ) {
        result.domChanges.updated.push(nativeSelectReference.line);
      }
      result.actual += ' Native select options are exposed in the updated element above. Use selectOption with the same backend-bound target and an exact option value or full label; do not choose it with keyboard letters.';
    }
    clickTimings.resultAssemblyMs = Date.now() - resultAssemblyStartedAt;
    clickTimings.totalMs = Date.now() - targetResolutionStartedAt;
    return { ...result, clickTimings };
  }

  async selectOption(input: BrowserSelectOptionAction): Promise<BrowserActionResult> {
    const throwIfAborted = () => {
      if (!input.abortSignal?.aborted) return;
      throw input.abortSignal.reason instanceof Error
        ? input.abortSignal.reason
        : new Error('Browser option selection was cancelled.');
    };
    throwIfAborted();
    if (!input.target && !input.uid) return { ok: false, actual: 'selectOption requires a fresh snapshot-bound select target.' };
    if (!String(input.value || '').trim() && !String(input.label || '').trim()) {
      return { ok: false, actual: 'selectOption requires an exact value or full label.' };
    }
    const previousGeneration = this.snapshotGeneration;
    const actionPoint = await this.unifiedActionPoint({
      target: input.target,
      uid: input.uid,
    });
    throwIfAborted();
    if (!actionPoint.point || !actionPoint.reference) {
      return { ok: false, actual: actionPoint.error || 'Unable to resolve the current select target.' };
    }
    if (isSnapshotReference(actionPoint.reference)) {
      return { ok: false, actual: 'selectOption requires a DOM observation target for a native select or virtual list.' };
    }
    const reference = actionPoint.reference;
    const uid = reference.id;
    if (actionPoint.point.coveredBy) {
      return { ok: false, actual: `Option target UID ${uid} is currently covered by ${actionPoint.point.coveredBy}. Dismiss the active layer before selecting an option.` };
    }
    if (!reference.localRef) return { ok: false, actual: `UID ${uid} has no live option-container reference. Capture a fresh inspect snapshot.` };
    const frame = reference.framePath ? this.frameFromPath(reference.framePath) : this.activePage.mainFrame();
    if (!frame) return { ok: false, actual: `UID ${uid} belongs to an iframe that no longer exists.` };
    await this.ensureBrowserPageRuntime(frame);
    if (reference.tag === 'select') {
      const selected = await frame.evaluate((selection) => {
        const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime;
        return runtime?.selectVisibleDomOption(selection.ref, { value: selection.value, label: selection.label });
      }, { ref: reference.localRef, value: input.value, label: input.label }).catch(() => undefined);
      throwIfAborted();
      if (!selected?.ok) return { ok: false, actual: selected?.actual || `Unable to select an option for UID ${uid}.` };
      const selectedLabel = selected.label ? ` (${selected.label})` : '';
      return this.completeVerifiedAction(
        `Selected native option ${selected.value || input.value || input.label}${selectedLabel}.`,
        previousGeneration,
        async () => ({ ok: true, detail: selected.actual }),
      );
    }

    if (!reference.signals?.includes('virtual-list')) {
      return {
        ok: false,
        actual: `UID ${uid} (${reference.tag} "${reference.label}") is neither a native select nor a virtualized="possible" scroll container.`,
      };
    }
    const found = await frame.evaluate((selection) => {
      const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime;
      return runtime?.findVisibleDomVirtualOption(selection.ref, {
        value: selection.value,
        label: selection.label,
      });
    }, { ref: reference.localRef, value: input.value, label: input.label }).catch((error) => ({
      ok: false,
      actual: `Virtual-list scan failed: ${error instanceof Error ? error.message : String(error)}`,
      item: undefined,
      point: undefined,
      value: undefined,
      label: undefined,
    }));
    throwIfAborted();
    if (!found?.ok || !found.item || !found.point) {
      return { ok: false, actual: found?.actual || `Unable to find a virtual-list option for UID ${uid}.` };
    }
    const page = this.activePage;
    let clickX = found.point.x;
    let clickY = found.point.y;
    if (frame !== page.mainFrame()) {
      const frameBox = await frame.frameElement().then((element) => element.boundingBox()).catch(() => undefined);
      if (!frameBox) {
        return { ok: false, actual: 'The virtual-list iframe is no longer visible.' };
      }
      clickX += frameBox.x;
      clickY += frameBox.y;
    }
    clickX = Math.round(clickX);
    clickY = Math.round(clickY);
    await this.showAiMouseCursor(page, clickX, clickY, 'click');
    throwIfAborted();
    const eventsBefore = await this.readInteractionCounts();
    const urlBefore = page.url();
    const popup = this.watchForPopup(page);
    try {
      await page.mouse.click(clickX, clickY);
    } catch (error) {
      return {
        ok: false,
        actual: `The exact virtual-list option could not receive the verified pointer click: ${unknownErrorMessage(error)}`,
      };
    }
    throwIfAborted();
    const claimedPopup = await this.settlePopupAfterAction(popup.popup, popup.waitMs);
    const selectedName = found.value || input.value || found.label || input.label;
    return this.completeVerifiedAction(
      `Selected virtual-list option ${selectedName}.`,
      previousGeneration,
      async () => {
        const eventsAfter = await this.readInteractionCounts();
        const delivered = this.interactionDelta(eventsBefore, eventsAfter, 'click');
        const navigated = Boolean(claimedPopup) || page.url() !== urlBefore;
        return {
          ok: delivered > 0 || navigated,
          detail: `${delivered} click event(s) observed; navigation=${navigated}.`,
        };
      },
    );
  }

  async keyboard(input: BrowserKeyboardAction): Promise<BrowserActionResult> {
    const page = this.activePage;
    const previousGeneration = this.snapshotGeneration;
    let targetLocator: Locator | undefined;
    let targetHandle: ElementHandle<Element> | undefined;
    const hasExplicitTarget = Boolean(input.target || input.uid || input.xThousandth !== undefined || input.yThousandth !== undefined);
    if (hasExplicitTarget) {
      const target = await this.unifiedActionPoint(input, true);
      if (!target.point) return { ok: false, actual: target.error || 'Unable to resolve keyboard focus target.' };
      if (target.point.coveredBy) {
        return { ok: false, actual: `Keyboard target ${input.uid || target.point.descriptor} is currently covered by ${target.point.coveredBy}. Dismiss the active layer before typing or pressing keys.` };
      }
      targetLocator = target.reference && isSnapshotReference(target.reference) ? await this.snapshotReferenceLocator(target.reference) : undefined;
      if (!targetLocator && target.reference && !isSnapshotReference(target.reference) && target.reference.interactive) {
        const frame = target.reference.framePath ? this.frameFromPath(target.reference.framePath) : page.mainFrame();
        if (!frame) return { ok: false, actual: 'The selected keyboard target belongs to an iframe that no longer exists.' };
        targetHandle = await this.elementHandleForDomPath(
          frame,
          target.reference.path,
          target.reference.locatorCandidates || [],
        ) as ElementHandle<Element> | undefined;
        if (!targetHandle) {
          return { ok: false, actual: 'The selected keyboard target no longer resolves to a live editable element. Capture a fresh inspect snapshot.' };
        }
      }
      const targetsNativeSelect = Boolean(target.reference && (
        isSnapshotReference(target.reference)
          ? await targetLocator?.evaluate((element) => element instanceof HTMLSelectElement).catch(() => false)
          : target.reference.tag === 'select'
      ));
      if (targetsNativeSelect) {
        return { ok: false, actual: 'Keyboard operation rejected for a native <select>. Use selectOption with this select UID and an exact option value or full label; do not use letters, ArrowUp/ArrowDown, or Enter.' };
      }
      if (!targetLocator && !targetHandle && target.reference && !isSnapshotReference(target.reference) && !target.reference.interactive) {
        targetLocator = await this.editableIframeLocator(target.reference, target.point);
        if (!targetLocator) {
          return { ok: false, actual: `Target ${target.reference.tag} "${target.reference.label}" is structural text, not an editable target.` };
        }
      }
      if (input.allowedOrigins?.length) {
        if (!targetLocator && !targetHandle) {
          return { ok: false, actual: 'Credential entry requires a resolvable element target in the confirmed login page.' };
        }
        if (targetLocator) {
          const boundHandle = await targetLocator.elementHandle().catch(() => null);
          if (!boundHandle) return { ok: false, actual: 'Credential entry target is no longer attached. Call takeSnapshot again.' };
          targetHandle = boundHandle as ElementHandle<Element>;
          targetLocator = undefined;
        }
        const allowedOrigins = new Set(input.allowedOrigins.flatMap((value) => {
          try {
            const origin = new URL(value).origin;
            return origin === 'null' ? [] : [origin];
          } catch {
            return [];
          }
        }));
        const targetOrigin = await targetHandle!.evaluate(() => window.location.origin).catch(() => '');
        if (!targetOrigin || !allowedOrigins.has(targetOrigin)) {
          return { ok: false, actual: 'Credential entry was blocked because the target field belongs to a different frame origin.' };
        }
        const markedSensitive = await targetHandle!.evaluate((element) => {
          if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) return false;
          element.setAttribute('data-webpilot-sensitive-input', 'true');
          return true;
        }).catch(() => false);
        if (!markedSensitive) {
          return { ok: false, actual: 'Credential entry is limited to a concrete input or textarea field.' };
        }
      }
      if (targetLocator || targetHandle) {
        await this.showAiMouseCursor(page, target.point.x, target.point.y, 'click');
        if (targetHandle) await targetHandle.click({ noWaitAfter: true });
        else await targetLocator!.click({ noWaitAfter: true });
        if (targetHandle) await targetHandle.focus();
        else await targetLocator!.focus();
        const focused = await (targetHandle
          ? targetHandle.evaluate((element) => element === document.activeElement || element.contains(document.activeElement))
          : targetLocator!.evaluate((element) => (
          element === document.activeElement || element.contains(document.activeElement)
          ))).catch(() => false);
        if (!focused) return { ok: false, actual: 'The keyboard target did not receive focus after Playwright click and focus.' };
      } else {
        await this.showAiMouseCursor(page, target.point.x, target.point.y, 'click');
        await page.mouse.click(target.point.x, target.point.y);
        const focused = page.locator(':focus');
        if (await focused.count().catch(() => 0) === 1) targetLocator = focused;
      }
    }
    if (await this.hasFocusedNativeSelect()) {
      return { ok: false, actual: 'Keyboard operation rejected because a native <select> is focused. Use selectOption with the select UID from takeSnapshot and an exact option value or full label; do not use letters, ArrowUp/ArrowDown, or Enter.' };
    }
    if (input.action === 'type') {
      if (typeof input.text !== 'string') return { ok: false, actual: 'Keyboard type requires text.' };
      if (input.allowedOrigins?.length) {
        const allowedOrigins = new Set(input.allowedOrigins.flatMap((value) => {
          try {
            const origin = new URL(value).origin;
            return origin === 'null' ? [] : [origin];
          } catch {
            return [];
          }
        }));
        const currentTarget = targetHandle
          ? await targetHandle.evaluate((element) => ({
              focused: element === document.activeElement || element.contains(document.activeElement),
              origin: window.location.origin,
            })).catch(() => undefined)
          : targetLocator
            ? await targetLocator.evaluate((element) => ({
                focused: element === document.activeElement || element.contains(document.activeElement),
                origin: window.location.origin,
              })).catch(() => undefined)
            : undefined;
        if (!currentTarget?.focused || !allowedOrigins.has(currentTarget.origin)) {
          return { ok: false, actual: 'Credential entry was blocked because the target navigated, detached, lost focus, or changed frame origin.' };
        }
      }
      const text = input.text;
      const editable = targetHandle
        ? await targetHandle.isEditable().catch(() => false)
        : targetLocator
          ? await targetLocator.isEditable().catch(() => false)
        : await page.locator(':focus').isEditable().catch(() => false);
      if (!editable) return { ok: false, actual: 'Keyboard type requires an editable focused textbox or contenteditable target.' };
      const valueBefore = await this.editableValue(targetLocator, targetHandle);
      const eventsBefore = await this.readInteractionCounts();
      const urlBefore = page.url();
      const navigationSequenceBefore = this.navigationSequenceByPage.get(page) || 0;
      const selectAllKey = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';
      if (input.replace !== false) {
        if (targetHandle || targetLocator) {
          if (targetHandle) await targetHandle.press(selectAllKey);
          else await targetLocator!.press(selectAllKey);
          if (targetHandle) await targetHandle.press('Backspace');
          else await targetLocator!.press('Backspace');
        } else {
          await page.keyboard.press(selectAllKey);
          await page.keyboard.press('Backspace');
        }
      }
      const delay = boundedNonNegativeIntegerEnv('BROWSER_KEYBOARD_TYPE_DELAY_MS', 0, 200);
      const fastInserted = input.allowedOrigins?.length ? false : await this.insertFocusedTextFast(text);
      if (!fastInserted) {
        if (targetHandle) await targetHandle.type(text, { delay });
        else if (targetLocator) await targetLocator.pressSequentially(text, { delay });
        else await page.keyboard.type(text, { delay });
      }
      if (input.followByEnter) {
        if (targetHandle) await targetHandle.press('Enter');
        else if (targetLocator) await targetLocator.press('Enter');
        else await page.keyboard.press('Enter');
      }
      return this.completeVerifiedAction(
        `Typed ${text.length} characters${input.followByEnter ? ' and pressed Enter' : ''}.`,
        previousGeneration,
        async () => {
          const eventsAfter = await this.readInteractionCounts();
          const keyEvents = this.interactionDelta(eventsBefore, eventsAfter, 'keydown');
          const inputEvents = this.interactionDelta(eventsBefore, eventsAfter, 'input');
          const navigated = page.url() !== urlBefore
            || (this.navigationSequenceByPage.get(page) || 0) !== navigationSequenceBefore;
          const valueAfter = navigated ? undefined : await this.editableValue(targetLocator, targetHandle);
          const valueChanged = valueBefore !== undefined && valueAfter !== undefined && valueBefore !== valueAfter;
          const delivered = text.length > 0
            ? inputEvents > 0 || valueChanged
            : input.replace !== false ? inputEvents > 0 || valueChanged || valueBefore === '' : true;
          return {
            // Fast DOM insertion intentionally emits input/change rather than
            // synthetic keydown events. The observable value/input result is
            // the delivery contract for text entry.
            ok: navigated || delivered,
            detail: `${keyEvents} keydown and ${inputEvents} input event(s) observed; valueLength ${valueBefore?.length ?? '?'}→${valueAfter?.length ?? '?'}; navigation=${navigated}.`,
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

  private async readSimplifiedDomTree(options: {
    scope?: 'visible' | 'full';
    timings?: Record<string, number>;
    maxChars?: number;
    maxElements?: number;
    resetDomVisibleIds?: boolean;
  } = {}): Promise<BrowserSimplifiedDomTreeResult> {
    const startedAt = Date.now();
    const fullScope = options.scope === 'full';
    const defaultMaxElements = fullScope
      ? numericLimitFromEnv('DOM_CUA_FULL_MAX_ELEMENTS', numericLimitFromEnv('DOM_CUA_MAX_ELEMENTS', 600))
      : numericLimitFromEnv('DOM_CUA_MAX_ELEMENTS', 200);
    const defaultMaxChars = fullScope
      ? numericLimitFromEnv('DOM_CUA_FULL_MAX_CHARS', numericLimitFromEnv('DOM_CUA_MAX_CHARS', 60000))
      : numericLimitFromEnv('DOM_CUA_MAX_CHARS', 20000);
    const maxElements = Math.max(1, Math.floor(Number(options.maxElements) || defaultMaxElements));
    const maxChars = Math.max(1, Math.floor(Number(options.maxChars) || defaultMaxChars));
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
    this.resetDomVisibleIdState(mainSnapshot.stateKey, options.resetDomVisibleIds === true);

    const treeLines: string[] = [];
    const actionLines: string[] = [];
    const actionContextLines: string[] = [];
    const actionContextIds = new Map<string, string>();
    let actionSnapshotChars = 'Contexts:\n\nInteractive elements:\n'.length;
    const textLines: string[] = [];
    const textSeen = new Set<string>();
    let chars = 0;
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
    const formatActionSnapshot = (contexts: string[], actions: string[]) => {
      if (!actions.length) return '';
      if (!contexts.length) return actions.join('\n');
      return [
        'Contexts:',
        ...contexts.map((context) => `- ${context}`),
        '',
        'Interactive elements:',
        ...actions,
      ].join('\n');
    };
    const compactActionContextLabel = (value?: string) => {
      const normalized = String(value || '').replace(/\s+/g, ' ').trim();
      return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
    };
    const actionContext = (byPath: Map<string, BrowserUseVisibleDomSnapshot['items'][number]>, item: BrowserUseVisibleDomSnapshot['items'][number], framePath?: string, frameUrl?: string) => {
      const labels: string[] = [];
      if (framePath) labels.push(compactActionContextLabel(`iframe ${framePath}${frameUrl ? ` ${frameUrl}` : ''}`));
      const parts = item.path.split('.');
      for (let length = 1; length < parts.length; length += 1) {
        const ancestor = byPath.get(parts.slice(0, length).join('.'));
        const label = compactActionContextLabel(ancestor?.label);
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
      const itemByPath = new Map(snapshot.items.map((entry) => [entry.path, entry]));
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
        const line = `${indent}${item.line.replace(`node_id=${item.ref}`, `uid=${publicId}`)}`;
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
          if (!actionReferenceIds.has(publicId)) {
            actionReferenceIds.add(publicId);
            interactiveNodeCount += 1;
          }
        }
        references.push(indexDomNodeReference({
          id: publicId,
          interactive: item.interactive,
          capabilities: item.capabilities,
          confidence: item.confidence,
          contextText: item.contextText,
          priority: item.priority,
          contextId: snapshot.stateKey,
          label: item.label,
          line,
          localRef: item.ref,
          path: item.path,
          locatorCandidates: item.locatorCandidates,
          signals: item.signals,
          framePath,
          frameUrl,
          descriptor: item.descriptor,
          state: item.state,
          tag: item.tag,
          viewportClip,
        }));
      }
      if (options.includeActions) {
        const actionTier = (item: BrowserUseVisibleDomSnapshot['items'][number]) => {
          if ((item.priority || 0) >= 60) return 0;
          if ((item.priority || 0) >= 35) return 1;
          if (item.confidence === 'high') return 2;
          if (item.confidence === 'medium') return 3;
          return 4;
        };
        const prioritizedActions = snapshot.items
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => item.interactive)
          .sort((left, right) => actionTier(left.item) - actionTier(right.item) || left.index - right.index);
        for (const { item } of prioritizedActions) {
          const publicId = this.publicDomVisibleId(snapshot.stateKey, item.ref);
          const indent = this.domObservationIndent(item.path, framePath);
          const line = `${indent}${item.line.replace(`node_id=${item.ref}`, `uid=${publicId}`)}`;
          const context = actionContext(itemByPath, item, framePath, frameUrl);
          const existingContextId = context ? actionContextIds.get(context) : undefined;
          const contextId = existingContextId || (context ? `c${actionContextIds.size + 1}` : undefined);
          const actionLine = contextId ? `${line} ctx=${contextId}` : line;
          const contextLine = context && contextId && !existingContextId ? `${contextId}: ${context}` : '';
          const addedChars = actionLine.length + 1 + (contextLine ? contextLine.length + 1 : 0);
          if (actionSnapshotChars + addedChars > maxChars || actionLines.length >= maxElements) continue;
          if (contextLine) {
            actionContextIds.set(context, contextId!);
            actionContextLines.push(contextLine);
          }
          actionLines.push(actionLine);
          actionSnapshotChars += addedChars;
        }
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
    const actions = formatActionSnapshot(actionContextLines, actionLines) || '[no visible actionable elements]';
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
    this.domVisibleEpoch += 1;
    this.domVisibleSnapshotKey = mainSnapshotKey;
    this.domVisibleObservationId = undefined;
    this.domVisibleExposedReferenceIds.clear();
    this.domVisiblePublicIdByFrameLocalRef.clear();
    this.domVisibleNextPublicId = 1;
  }

  private publicDomVisibleId(stateKey: string, localRef: string) {
    const key = `${stateKey}:${localRef}`;
    let id = this.domVisiblePublicIdByFrameLocalRef.get(key);
    if (!id) {
      // Keep DOM-observation UIDs in a separate namespace from CDP snapshot UIDs.
      // The same registry is then updated by incremental MutationObserver deltas.
      id = `dom-${this.domVisibleEpoch}-${this.domVisibleNextPublicId++}`;
      this.domVisiblePublicIdByFrameLocalRef.set(key, id);
    }
    return id;
  }

  private exposeDomReferencesFromText(content: string) {
    for (const match of content.matchAll(/\buid=(dom-\d+-\d+)\b/g)) {
      if (this.lastDomNodeReferences.has(match[1])) this.domVisibleExposedReferenceIds.add(match[1]);
    }
  }

  private bindDomReferencesToObservation(observationId: string) {
    this.domVisibleObservationId = observationId;
    this.domVisibleExposedReferenceIds.clear();
    for (const [id, reference] of this.lastDomNodeReferences) {
      this.lastDomNodeReferences.set(id, { ...reference, observationId });
    }
  }

  private removeDomVisibleReference(stateKey: string, localRef: string) {
    const key = `${stateKey}:${localRef}`;
    const uid = this.domVisiblePublicIdByFrameLocalRef.get(key);
    if (!uid) return undefined;
    this.domVisiblePublicIdByFrameLocalRef.delete(key);
    this.lastDomNodeReferences.delete(uid);
    return uid;
  }

  private domObservationReference(
    stateKey: string,
    item: BrowserUseVisibleDomSnapshot['items'][number],
    framePath?: string,
    frameUrl?: string,
    viewportClip?: BrowserUseViewportClip,
  ): DomNodeReference {
    const id = this.publicDomVisibleId(stateKey, item.ref);
    return indexDomNodeReference({
      id,
      observationId: this.domVisibleObservationId,
      interactive: item.interactive,
      capabilities: item.capabilities,
      confidence: item.confidence,
      contextText: item.contextText,
      priority: item.priority,
      contextId: stateKey,
      label: item.label,
      line: item.line.replace(`node_id=${item.ref}`, `uid=${id}`),
      locatorCandidates: item.locatorCandidates,
      localRef: item.ref,
      path: item.path,
      signals: item.signals,
      framePath,
      frameUrl,
      descriptor: item.descriptor,
      state: item.state,
      surfaceId: item.surfaceId,
      tag: item.tag,
      viewportClip,
    });
  }

  private domObservationExtraLine(item: BrowserUseVisibleDomSnapshot['items'][number]) {
    // Extra nodes are context only. Do not expose their page-local node id as a
    // uid, because callers must not attempt an action through this channel.
    return item.line.replace(`node_id=${item.ref}`, 'extra=true');
  }

  private domObservationValidationError(line: string) {
    if (!/(?:\bclass="[^"]*\b(?:error|errors|field-error|validation-error|aui-message-error)\b|\brole="alert"|\baria-invalid="true")/i.test(line)) return undefined;
    const text = line.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return text || line;
  }

  private domObservationCursor(record: DomObservationPagination, index: number) {
    return Buffer.from(JSON.stringify({ id: record.id, index, mode: record.mode }), 'utf8').toString('base64url');
  }

  private parseDomObservationCursor(cursor: string) {
    try {
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<{ id: string; index: number; mode: string }>;
      if (typeof value.id !== 'string' || !value.id || !Number.isFinite(value.index) || !['actionable', 'full', 'text', 'changes'].includes(value.mode || '')) return undefined;
      return {
        id: value.id,
        index: Math.max(0, Math.floor(value.index!)),
        mode: value.mode as DomObservationPagination['mode'],
      };
    } catch {
      return undefined;
    }
  }

  private domObservationPageCharLimit(mode: DomObservationPagination['mode']) {
    return mode === 'full' ? 40000 : 20000;
  }

  private domObservationPageStarts(lines: string[], maxChars: number) {
    const starts = [0];
    let chars = 0;
    let entries = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const addition = lines[index].length + (entries ? 1 : 0);
      if (entries && chars + addition > maxChars) {
        starts.push(index);
        chars = 0;
        entries = 0;
      }
      chars += lines[index].length + (entries ? 1 : 0);
      entries += 1;
    }
    return starts;
  }

  private domObservationPage(record: DomObservationPagination, startIndex: number) {
    const maxChars = record.pageMaxChars;
    const lines: string[] = [];
    let chars = 0;
    let nextIndex = Math.min(startIndex, record.lines.length);
    for (let index = nextIndex; index < record.lines.length; index += 1) {
      const line = record.lines[index];
      const addition = line.length + (lines.length ? 1 : 0);
      if (lines.length && chars + addition > maxChars) break;
      lines.push(line);
      chars += addition;
      nextIndex = index + 1;
    }
    const content = lines.join('\n');
    return {
      content,
      contentCharLength: content.length,
      hasMore: nextIndex < record.lines.length,
      nextCursor: nextIndex < record.lines.length ? this.domObservationCursor(record, nextIndex) : undefined,
      pageNumber: Math.max(1, record.pageStarts.indexOf(startIndex) + 1),
      returnedEntries: Math.max(0, nextIndex - startIndex),
      startIndex,
      totalPages: record.pageStarts.length,
      totalEntries: record.lines.length,
    };
  }

  /**
   * Read the lightweight DOM-observation snapshot used as the baseline for
   * incremental MutationObserver updates. It intentionally avoids CDP
   * DOMSnapshot/AX collection, which is reserved for explicit legacy search
   * tools and is never run after every action.
   */
  async readDomObservationSnapshot(options: { cursor?: string; mode?: BrowserSnapshotView } = {}) {
    const startedAt = Date.now();
    const cursor = options.cursor ? this.parseDomObservationCursor(options.cursor) : undefined;
    if (options.cursor && !cursor) throw new Error('Invalid DOM-observation snapshot cursor. Capture a fresh takeSnapshot instead.');

    if (cursor) {
      if (!options.mode) throw new Error('Snapshot continuation requires the same explicit mode together with cursor.');
      const record = this.domObservationPagination;
      if (!record || record.id !== cursor.id || record.mode !== cursor.mode) {
        throw new Error('The DOM-observation snapshot cursor is no longer available. Capture a fresh takeSnapshot instead.');
      }
      if (options.mode && options.mode !== cursor.mode) {
        throw new Error(`Snapshot cursor mode is ${cursor.mode}; do not change mode while paging.`);
      }
      const page = this.domObservationPage(record, cursor.index);
      this.exposeDomReferencesFromText(page.content);
      return {
        ...page,
        snapshotId: this.domVisibleObservationId,
        mode: record.mode,
        pageSummary: record.mode === 'changes'
          ? `Inter-action changes: page ${page.pageNumber}/${page.totalPages}, entries ${page.startIndex + 1}-${page.startIndex + page.returnedEntries}/${page.totalEntries}.`
          : `DOM snapshot ${record.mode}: page ${page.pageNumber}/${page.totalPages}, entries ${page.startIndex + 1}-${page.startIndex + page.returnedEntries}/${page.totalEntries}.`,
        nodeCount: this.lastDomNodeReferences.size,
        actionableCount: [...this.lastDomNodeReferences.values()].filter((reference) => reference.interactive).length,
        observation: record.observation,
        timings: { readDomObservationMs: Date.now() - startedAt },
      };
    }

    const mode = options.mode || 'actionable';
    if (mode === 'changes') {
      const changes = await this.readInterActionChangeJournal();
      const observation = await this.readPageObservation();
      const changeLines = [this.pageObservationLine(observation), ...changes.lines];
      const record: DomObservationPagination = {
        id: `dom-observation-${++this.domObservationPaginationSequence}`,
        lines: changeLines,
        mode,
        navigationSequence: this.navigationSequenceByPage.get(this.activePage) || 0,
        observation,
        pageMaxChars: this.domObservationPageCharLimit(mode),
        pageStarts: this.domObservationPageStarts(changeLines, this.domObservationPageCharLimit(mode)),
        page: this.activePage,
        url: this.activePage.url(),
      };
      this.domObservationPagination = record;
      const page = this.domObservationPage(record, 0);
      this.exposeDomReferencesFromText(page.content);
      return {
        ...page,
        snapshotId: this.domVisibleObservationId,
        mode,
        pageSummary: `Inter-action changes ${changes.journal.id}: page ${page.pageNumber}/${page.totalPages}, entries ${page.startIndex + 1}-${page.startIndex + page.returnedEntries}/${page.totalEntries}.`,
        nodeCount: 0,
        actionableCount: 0,
        observation,
        timings: { readDomObservationMs: Date.now() - startedAt },
      };
    }

    const maxElements = numericLimitFromEnv('DOM_CUA_PAGED_MAX_ELEMENTS', 10000);
    const maxChars = numericLimitFromEnv('DOM_CUA_PAGED_MAX_CHARS', 1000000);
    const result = await this.readSimplifiedDomTree({
      scope: mode === 'full' || mode === 'text' ? 'full' : 'visible',
      maxChars,
      maxElements,
      resetDomVisibleIds: true,
    });
    const source = mode === 'text'
      ? result.observation.text
      : mode === 'full'
        ? result.observation.tree
        : result.observation.actions;
    const observation = await this.readPageObservation();
    const lines = [
      this.pageObservationLine(observation),
      ...source.replaceAll(/\bnode_id=/g, 'uid=').split('\n'),
    ];
    const record: DomObservationPagination = {
      id: `dom-observation-${++this.domObservationPaginationSequence}`,
      lines,
      mode,
      navigationSequence: this.navigationSequenceByPage.get(this.activePage) || 0,
      observation,
      pageMaxChars: this.domObservationPageCharLimit(mode),
      pageStarts: this.domObservationPageStarts(lines, this.domObservationPageCharLimit(mode)),
      page: this.activePage,
      url: this.activePage.url(),
    };
    this.domObservationPagination = record;
    this.bindDomReferencesToObservation(record.id);
    // Establish the returned snapshot as the delta baseline without walking
    // historical page-load mutations. A queue discard is intentionally O(1).
    await this.discardDomChanges();
    const page = this.domObservationPage(record, 0);
    this.exposeDomReferencesFromText(page.content);
    return {
      ...page,
      snapshotId: record.id,
      mode,
      pageSummary: `DOM snapshot ${mode}: page ${page.pageNumber}/${page.totalPages}, entries ${page.startIndex + 1}-${page.startIndex + page.returnedEntries}/${page.totalEntries}.`,
      nodeCount: result.observation.domNodeCount,
      actionableCount: result.observation.interactiveNodeCount,
      observation,
      timings: { ...result.observation.timings, readDomObservationMs: Date.now() - startedAt },
    };
  }

  /**
   * Consume only the mutations observed since the previous call. Removed nodes
   * are deleted from the authoritative UID registry before the result is
   * returned, so a later UID action cannot silently target a stale element.
   */
  async readDomChanges(): Promise<BrowserActionResult> {
    const mainFrame = this.activePage.mainFrame();
    const frames = this.actionFrames();
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    const extraAdded: string[] = [];
    const extraUpdated: string[] = [];
    const validationErrors = new Set<string>();
    const observations: BrowserPageObservation[] = [];
    let epoch = 0;
    let overflow = false;

    const frameDeltas = await Promise.all(frames.map(async (frame) => {
      const framePath = frame === mainFrame ? undefined : this.getFramePath(frame);
      if (frame !== mainFrame && framePath === undefined) return undefined;
      await this.ensureBrowserPageRuntime(frame);
      const delta = await frame.evaluate(() => {
        const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime;
        return runtime?.visibleDomDelta();
      }).catch(() => undefined);
      return delta ? { delta, frame, framePath } : undefined;
    }));

    for (const entry of frameDeltas) {
      if (!entry) continue;
      const { delta, frame, framePath } = entry;
      epoch = Math.max(epoch, delta.epoch);
      overflow ||= delta.overflow;
      const activeSurfaceIds = new Set([
        ...delta.observation.topSurfaceIds,
        ...delta.observation.surfaceStack.map((surface) => surface.id),
      ]);
      const prioritizedItems = (items: BrowserUseVisibleDomSnapshot['items'], maxItems = 60) => {
        const ordered = [...items].sort((left, right) => (
          Number(Boolean(right.surfaceId && activeSurfaceIds.has(right.surfaceId)))
          - Number(Boolean(left.surfaceId && activeSurfaceIds.has(left.surfaceId)))
          || right.priority - left.priority
        ));
        if (ordered.length > maxItems) overflow = true;
        return ordered.slice(0, maxItems);
      };
      const deltaAdded = prioritizedItems(delta.added);
      const deltaUpdated = prioritizedItems(delta.updated);
      const deltaExtraAdded = prioritizedItems(delta.extra.added, 40);
      const deltaExtraUpdated = prioritizedItems(delta.extra.updated, 40);
      observations.push({
        ...delta.observation,
        surfaces: delta.observation.surfaces.map((surface) => ({
          ...surface,
          ...(framePath ? { framePath } : {}),
        })),
        surfaceStack: delta.observation.surfaceStack.map((surface) => ({
          ...surface,
          ...(framePath ? { framePath } : {}),
        })),
        ...(delta.observation.activeSurface ? {
          activeSurface: {
            ...delta.observation.activeSurface,
            ...(framePath ? { framePath } : {}),
          },
        } : {}),
      });
      const frameUrl = frame.url() || undefined;
      for (const localRef of delta.removedRefs) {
        const uid = this.removeDomVisibleReference(delta.stateKey, localRef);
        if (uid) removed.push(uid);
      }
      for (const item of deltaAdded) {
        const reference = this.domObservationReference(delta.stateKey, item, framePath, frameUrl);
        this.lastDomNodeReferences.set(reference.id, reference);
        this.domVisibleExposedReferenceIds.add(reference.id);
        added.push(reference.line);
        const validationError = this.domObservationValidationError(reference.line);
        if (validationError) validationErrors.add(validationError);
      }
      for (const item of deltaUpdated) {
        const reference = this.domObservationReference(delta.stateKey, item, framePath, frameUrl);
        this.lastDomNodeReferences.set(reference.id, reference);
        this.domVisibleExposedReferenceIds.add(reference.id);
        updated.push(reference.line);
        const validationError = this.domObservationValidationError(reference.line);
        if (validationError) validationErrors.add(validationError);
      }
      for (const item of deltaExtraAdded) {
        const line = this.domObservationExtraLine(item);
        extraAdded.push(line);
        const validationError = this.domObservationValidationError(line);
        if (validationError) validationErrors.add(validationError);
      }
      for (const item of deltaExtraUpdated) {
        const line = this.domObservationExtraLine(item);
        extraUpdated.push(line);
        const validationError = this.domObservationValidationError(line);
        if (validationError) validationErrors.add(validationError);
      }
    }
    const extraErrors = this.domChangeErrors.splice(0);
    const mainObservation = observations[0];
    const selectedSurface = observations
      .flatMap((item) => item.activeSurface ? [{ observation: item, surface: item.activeSurface }] : [])
      .sort((left, right) => (
        Number(right.surface.likelyOverlay) - Number(left.surface.likelyOverlay)
        || Number(right.surface.modal) - Number(left.surface.modal)
        || right.surface.activationOrder - left.surface.activationOrder
        || right.surface.zIndex - left.surface.zIndex
      ))[0];
    const observation: BrowserPageObservation = {
      epoch: observations.reduce((max, item) => Math.max(max, item.epoch), epoch),
      url: mainObservation?.url || this.activePage.url(),
      title: mainObservation?.title || await this.activePage.title().catch(() => ''),
      ...(mainObservation?.focusedElement ? { focusedElement: mainObservation.focusedElement } : {}),
      ...(selectedSurface ? { activeSurface: selectedSurface.surface } : {}),
      surfaces: observations.flatMap((item) => item.surfaces),
      surfaceStack: selectedSurface?.observation.surfaceStack || mainObservation?.surfaceStack || [],
      topSurfaceIds: observations.flatMap((item) => item.topSurfaceIds),
      surfaceTransition: selectedSurface?.observation.surfaceTransition || mainObservation?.surfaceTransition || 'initial',
    };

    return {
      ok: true,
      actual: 'DOM incremental changes captured.',
      snapshotId: this.domVisibleObservationId,
      observation,
      domChanges: {
        snapshotId: this.domVisibleObservationId,
        epoch,
        added,
        updated,
        removed,
        extra: { added: extraAdded, updated: extraUpdated, errors: extraErrors, validationErrors: [...validationErrors] },
        overflow,
        observation,
      },
    };
  }

  private async discardDomChanges() {
    const frames = this.activePage.frames();
    await Promise.all(frames.map((frame) => frame.evaluate(() => {
      const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime;
      return runtime?.discardDomChanges();
    }).catch(() => undefined)));
    this.domChangeErrors = [];
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
      const agentOverlaySelector = '#__ai_candidate_overlay__, #__ai_mouse_cursor__, #__ai_dom_export_control__';
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

  private async showAiMouseCursor(page: Page, x: number, y: number, kind: string) {
    await this.ensureBrowserPageRuntime(page);
    await page.evaluate(({ cursorX, cursorY, cursorKind }) => {
      const browserWindow = window as WindowWithAiDomRuntime;
      browserWindow.__aiMoveMouseCursor?.(cursorX, cursorY, { kind: cursorKind });
    }, { cursorX: x, cursorY: y, cursorKind: kind }).catch(() => undefined);
  }

}

export async function closeAllBrowserSessions() {
  if (browserSessionProcessState.shuttingDown) return browserSessionProcessState.shuttingDown;
  browserSessionProcessState.shuttingDown = (async () => {
    const sessions = [...browserSessionProcessState.sessions];
    await Promise.allSettled(sessions.map(async (session) => {
      if (Object.getPrototypeOf(session) !== BrowserSession.prototype) {
        Object.setPrototypeOf(session, BrowserSession.prototype);
      }
      await session.close({ force: true });
    }));
    browserSessionProcessState.sessions.clear();
  })().finally(() => {
    browserSessionProcessState.shuttingDown = undefined;
  });
  return browserSessionProcessState.shuttingDown;
}

function installBrowserSessionProcessShutdownHooks() {
  if (browserSessionProcessState.shutdownHooksInstalled) return;
  browserSessionProcessState.shutdownHooksInstalled = true;
  const shutdown = () => {
    const forceExitTimer = setTimeout(() => process.exit(1), 8_000);
    forceExitTimer.unref?.();
    void closeAllBrowserSessions().finally(() => {
      clearTimeout(forceExitTimer);
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  if (process.platform !== 'win32') process.once('SIGHUP', shutdown);
}

installBrowserSessionProcessShutdownHooks();
