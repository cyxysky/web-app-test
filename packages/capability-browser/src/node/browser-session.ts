import { acquireSharedBrowser, connectOrLaunchPersistentBrowserOverCdp, launchPersistentContextWithBrowserCodeConnection, connectExistingBrowserOverCdp, launchBrowserServerWithConnection, sleep, closeConnectedBrowserProcess, type BrowserOwnership } from './browser-shared-runtime.js';
import { BrowserDownloadManager, type BrowserDownloadReceiver, type BrowserDownloadResult } from './browser-downloads.js';
import { BrowserStateReader, type BrowserStateReadOptions } from './browser-state-reader.js';
import { BrowserSessionScheduler } from './browser-session-scheduler.js';
import { BrowserNetworkDiagnostics } from './browser-network-diagnostics.js';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { randomUUID } from 'node:crypto';

import type { Browser, BrowserContext, BrowserContextOptions, BrowserServer, ConsoleMessage, Dialog, Download as PlaywrightDownload, ElementHandle, FileChooser, Frame, LaunchOptions, Locator, Page, Worker as PlaywrightWorker } from 'playwright';
import { raceWithAbort, type CapabilityConfiguration } from '@webpilot/capability-sdk';
import { resolveBrowserOutputPixelRatio, resolveBrowserPreviewImageFormat } from '../output-settings.js';
import { browserSessionGroupLabel } from '../session-group.js';
import { browserPreviewFrameIntervalMs, browserPreviewFramesPerSecond } from './browser-preview-cadence.js';
import { BrowserPreviewFramePump, type BrowserPreviewFramePumpMetrics } from './browser-preview-frame-pump.js';
import { browserPreviewVideoMaximumDimensions } from './browser-preview-video-settings.js';
import { boundedNonNegativeIntegerEnv, boundedPositiveIntegerEnv, browserHeadlessEnabled, browserTabTitlePrefixEnabled, cdpEndpointForPort, electronEmbeddedBrowserCdpEndpoint, electronEmbeddedBrowserEnabled, clearManagedBrowserProfileCaches, normalizePageGroupId, numericLimitFromEnv, positiveIntegerEnv, sessionTabGrouperDebugPort, sessionTabGrouperEnabled, sessionTabGrouperProfileDir, sharedBrowserTabsEnabled, withSessionTabGrouperArgs, type BrowserRuntimeEnvironment } from './browser-session-runtime.js';
import type { BrowserPageObservation } from './browser-page-observation.js';
import { applyEditableTextSelection, readEditableText, resolveEditableTextSelection, type BrowserTextSelectionSpec } from './editable-text-selection.js';
import { buildSnapshotViews, captureAxSnapshot, snapshotRoleIsActionable, type CapturedSnapshotFrame, type SnapshotNodeWithUid, type SnapshotRecord, type SnapshotView } from './ax-snapshot.js';
import { captureDomSnapshot } from './dom-snapshot.js';
import { BROWSER_CODE_KERNEL_RUNTIME_REVISION, browserCodePolicyViolation, browserCodeReportedFailure, BrowserCodeKernel, type BrowserCodeAttachmentBinding, type BrowserCodeActivity, type BrowserCodeConnection, type BrowserCodeCredentialBinding, type BrowserCodeRuntimeStateOperation, type BrowserCodeUidReference } from './browser-code-runner.js';
import { resolveBrowserSessionSurface, type BrowserSessionSurface } from './browser-session-surface.js';
import { compactDiagnosticText, isAlreadyHandledJavaScriptDialogError, shouldIgnoreConsoleError, snapshotFrameUrl, stringifyDiagnosticValue, unknownErrorMessage } from './browser-session-diagnostics.js';
import { isBlankBrowserUrlLike, isBlankPage } from './browser-session-page-policy.js';
import { AI_DOM_RUNTIME_VERSION, applyPageGroupMarker, collectAiDomObservation, installAccessibilitySnapshotExportControl, installAiBrowserPageRuntime } from './browser-page-runtime.js';
import { domObservationPageCharLimit, domObservationPageStarts, parseDomObservationCursor, readDomObservationPage, type DomObservationPageRecord } from './browser-dom-observation-pagination.js';
import { resolveBrowserSessionTransportAdapter, type BrowserSessionTransportKind } from './browser-session-transport-adapter.js';
import { closeManagedBrowserSessions, registerBrowserSession, unregisterBrowserSession } from './browser-session-lifecycle.js';


const DEFAULT_SCREENSHOT_TIMEOUT_MS = 15000;
const MIN_SCREENSHOT_TIMEOUT_MS = 1000;
const MAX_SCREENSHOT_TIMEOUT_MS = 120000;
const SCREENSHOT_FAILURE_CONTEXT_TIMEOUT_MS = 2000;
const DEFAULT_BROWSER_POPUP_WAIT_MS = 0;
const DEFAULT_BROWSER_WAIT_FOR_PAGE_LOAD_STATE_TIMEOUT_MS = 1500;
const DEFAULT_BROWSER_WAIT_FOR_PAGE_STABLE_MS = 250;
const DEFAULT_BROWSER_NAVIGATION_DOM_QUIET_MS = 250;
const DEFAULT_BROWSER_NAVIGATION_DOM_STABILITY_TIMEOUT_MS = 1000;
const BROWSER_NAVIGATION_DOM_STABILITY_POLL_MS = 50;

function fixedBrowserViewportFromEnv(environment: BrowserRuntimeEnvironment) {
  if (environment.BROWSER_VIEWPORT_MODE?.trim().toLowerCase() !== 'fixed') return undefined;
  const width = positiveIntegerEnv('BROWSER_VIEWPORT_WIDTH', environment);
  const height = positiveIntegerEnv('BROWSER_VIEWPORT_HEIGHT', environment);
  return width && height ? { width, height } : undefined;
}

function browserOutputPixelRatioFromEnv(environment: BrowserRuntimeEnvironment) {
  return resolveBrowserOutputPixelRatio(environment.BROWSER_OUTPUT_PIXEL_RATIO);
}


export type BrowserSessionOptions = {
  browserSurface?: BrowserSessionSurface;
  isMarked?: boolean;
  runId?: string;
  /** Durable browserCode state scope shared by all kernels for one browser conversation. */
  browserCodeStateSessionId?: string;
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
  /** Host-owned artifact storage and optional durable browserCode state. */
  host?: BrowserSessionHost;
  /** Per-runtime settings loaded by the Capability host; values override process.env. */
  configuration?: CapabilityConfiguration;
};

export type BrowserSessionHost = {
  receiveDownload?: BrowserDownloadReceiver;
  artifactPath?: (runId: string) => string;
  runtimeState?: (
    sessionId: string,
    operation: BrowserCodeRuntimeStateOperation,
  ) => Promise<unknown> | unknown;
  /** Optional host-owned pause/resume implementation for human verification. */
  waitForManualVerification?: (request: BrowserManualVerificationRequest) => Promise<BrowserActionResult>;
};

export type BrowserManualVerificationRequest = {
  session: BrowserSession;
  maxMs: number;
  abortSignal?: AbortSignal;
};

export type BrowserChildSessionOptions = Pick<BrowserSessionOptions,
  'actionFrameLimit' | 'browserCodeStateSessionId' | 'isMarked' | 'popupWaitMs' | 'runId' | 'slowMoMs'
> & {
  /** Keeps the parent's visible page focused after the child page is created. */
  background?: boolean;
  /** Copies per-tab sessionStorage into the child's new page on matching origins. */
  inheritSessionStorage?: boolean;
};

export type BrowserSessionCookie = {
  name: string;
  url: string;
  value: string;
};

export type AccessibilitySnapshotExportControlResult = {
  ok: boolean;
  fileName?: string;
  path?: string;
  downloadUrl?: string;
  error?: string;
};

export type BrowserSnapshotView = 'actionable' | 'full' | 'text' | 'changes';

export type BrowserSnapshotViews = Partial<Record<BrowserSnapshotView, string>> & {
  defaultType?: BrowserSnapshotView;
};

export type { BrowserActiveSurface, BrowserPageObservation } from './browser-page-observation.js';

export type BrowserActionResult = {
  ok: boolean;
  actual: string;
  /** Structured result payload. Callers should prefer this over parsing actual. */
  data?: unknown;
  /** Compact transport-facing description that does not duplicate a large actual payload. */
  summary?: string;
  /** Results from prerequisite tools executed inside this same model tool call, in execution order. */
  prerequisiteResults?: Array<{
    toolName: string;
    result: BrowserActionResult;
  }>;
  /** Stable runtime failure category used for category-specific recovery guidance. */
  failureCategory?: string;
  /** Signals a host-owned human-verification pause when no waiter is installed. */
  manualVerification?: { requested: true; maxMs: number };
  /** Runtime Skill required by an Agent-owned execution gate. */
  requiredSkillId?: string;
  /** Browser-owned control mirrored into the remote live-preview surface. */
  liveControl?: BrowserLiveNativeControl;
  /** Native select menu mirrored into the remote live-preview surface. */
  liveSelect?: BrowserLiveSelectMenu;
  /** Undelivered page dependency failures observed since the previous browserCode result. */
  dependencyFailures?: BrowserDependencyFailure[];
  /** Snapshot/observation that owns any DOM refs returned with this result. */
  snapshotId?: string;
  /** Click-specific timing breakdown for diagnosing browser action latency. */
  clickTimings?: BrowserClickTiming;
  /** A user-provided or generated image that should be attached to the next model request. */
  referenceImagePath?: string;
  /** Images emitted by browserCode that should be attached to the next model request in order. */
  referenceImagePaths?: string[];
  /** Safe basenames for emitted screenshots that may be cited by reportDefect. */
  screenshotFileNames?: string[];
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

export type BrowserStateSnapshot = {
  tabs: BrowserTabSnapshot[];
  activePage: { url: string; title: string };
  pageState: string;
  truncated?: boolean;
};

export type BrowserDependencyFailure = {
  category: 'external_service' | 'network_error';
  key: string;
  method: string;
  status?: number;
  errorText?: string;
  url: string;
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

export type ScreenshotCaptureMode = 'viewport' | 'fullPage';

type ScreenshotCaptureOptions = {
  capture?: ScreenshotCaptureMode;
  outputPixelRatio?: number;
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

export type PageInteractiveCandidate = Omit<InteractiveCandidate, 'framePath' | 'frameUrl'>;

export type PageDomObservationPayload = {
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

export type BrowserUseViewportClip = {
  bottom: number;
  left: number;
  right: number;
  top: number;
};

export type DomActionCapability = 'click' | 'drag' | 'fill' | 'focus' | 'hover' | 'scroll' | 'select';
export type DomActionConfidence = 'high' | 'medium' | 'low';

export type BrowserUseVisibleDomSnapshot = {
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

export type BrowserUseDomDelta = {
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

export type BrowserUseDomJournalDelta = {
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

type DomObservationPagination = DomObservationPageRecord & {
  id: string;
  lines: string[];
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
    coveredBySurfaceId?: string;
    activeSurfaceId?: string;
    failureKind?: 'occluded';
    preserveScroll?: boolean;
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
  hasPointerCursor: (element: Element) => boolean;
  isContentEditableOwner: (element: Element) => boolean;
  labelControlFor: (element: Element) => Element | undefined;
  visibleDomHoverElements: () => Set<Element>;
  isActionable: (element: Element) => boolean;
  actionableTargetFor: (element: Element) => Element;
  visibleRect: (element: Element, options?: { requirePointerEvents?: boolean }) => AiDomVisibleRect | undefined;
  elementBox: (element: Element) => AiDomElementBox | undefined;
  topmostRenderableAt: (x: number, y: number, options?: { requirePointerEvents?: boolean }) => Element | undefined;
  pointBelongsToElement: (element: Element, x: number, y: number, options?: { requirePointerEvents?: boolean }) => boolean;
  visiblePointForElement: (element: Element, options?: { requirePointerEvents?: boolean }) => ({ x: number; y: number } | undefined);
  scrollState: (element: Element) => ScrollableArea['scroll'];
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
  document?: Document;
  interactionCounts?: Record<string, number>;
  interactionListener?: EventListener;
  interactionListenerDocument?: Document;
  interactionSequence?: number;
  lastInteractionAt?: number;
  lastInteractionType?: string;
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
  xThousandth?: number;
  yThousandth?: number;
  toTarget?: BrowserElementTarget;
  toXThousandth?: number;
  toYThousandth?: number;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  force?: boolean;
  deltaX?: number;
  deltaY?: number;
};

export type BrowserKeyboardAction = {
  action: 'type' | 'press' | 'shortcut' | 'editText';
  target?: BrowserElementTarget;
  xThousandth?: number;
  yThousandth?: number;
  text?: string;
  selection?: BrowserTextSelectionSpec;
  operation?: 'setSelection' | 'insert' | 'delete' | 'replace';
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
    }
  | {
      kind: 'select';
      xRatio: number;
      yRatio: number;
      value: string;
    }
  | {
      controlKind: 'datalist' | 'picker';
      kind: 'controlValue';
      value: string;
      xRatio: number;
      yRatio: number;
    }
  | {
      controlId: string;
      files: Array<{
        mimeType: string;
        name: string;
        path: string;
      }>;
      kind: 'files';
    }
  | {
      accept: boolean;
      dialogId: string;
      kind: 'dialog';
      promptText?: string;
    };

type BrowserLiveNativeControlPosition = {
  label: string;
  openUpwards: boolean;
  targetXRatio: number;
  targetYRatio: number;
  topRatio: number;
  widthRatio: number;
  xRatio: number;
  yRatio: number;
};

export type BrowserLiveSelectMenu = BrowserLiveNativeControlPosition & {
  kind: 'select';
  options: Array<{
    disabled: boolean;
    group?: string;
    label: string;
    selected: boolean;
    value: string;
  }>;
  selectedValue: string;
};

export type BrowserLiveNativeControl = BrowserLiveSelectMenu
  | (BrowserLiveNativeControlPosition & {
      kind: 'datalist';
      options: Array<{ label: string; value: string }>;
      value: string;
    })
  | (BrowserLiveNativeControlPosition & {
      inputType: 'color' | 'date' | 'datetime-local' | 'month' | 'time' | 'week';
      kind: 'picker';
      max?: string;
      min?: string;
      step?: string;
      value: string;
    })
  | (BrowserLiveNativeControlPosition & {
      accept: string;
      capture?: string;
      controlId: string;
      kind: 'file';
      multiple: boolean;
    });

export type BrowserLiveDialog = {
  defaultValue: string;
  dialogType: 'alert' | 'beforeunload' | 'confirm' | 'prompt';
  id: string;
  message: string;
};

export type BrowserLiveDownload = {
  artifactId?: string;
  bytes?: number;
  error?: string;
  fileName: string;
  id: string;
  url?: string;
};

export type BrowserLiveNativeEvent =
  | { dialog: BrowserLiveDialog; kind: 'dialogOpened' }
  | { dialogId: string; kind: 'dialogClosed' }
  | { control: BrowserLiveNativeControl; kind: 'controlOpened' }
  | { download: BrowserLiveDownload; kind: 'downloadStarted' | 'downloadReady' | 'downloadFailed' };

export type BrowserSelectOptionAction = {
  abortSignal?: AbortSignal;
  target?: BrowserElementTarget;
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

export type WindowWithAiDomRuntime = Window & {
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

export type BrowserTabSnapshot = {
  id: string;
  index: number;
  url: string;
  active: boolean;
  groupId: string;
};

export type BrowserTabRestoreResult = {
  attempted: number;
  created: number;
  restored: number;
  failedUrls: string[];
  tabs: BrowserTabSnapshot[];
};

export type BrowserScreencastFrame = {
  data: string;
  contentType: 'image/jpeg' | 'image/png';
  capturedAt: string;
  url: string;
  viewport: { width: number; height: number };
  metadata?: { deviceHeight?: number; deviceWidth?: number };
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

export type BrowserSessionLifecycleState = 'idle' | 'starting' | 'ready' | 'closing' | 'closed' | 'failed';

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

async function mapWithConcurrency<T, TResult>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<TResult>,
) {
  if (!items.length) return [] as TResult[];
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(items.length, Math.max(1, Math.floor(concurrency))) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizedOriginSet(values: readonly string[]) {
  return new Set(values.flatMap((value) => {
    try {
      const origin = new URL(value).origin;
      return origin === 'null' ? [] : [origin];
    } catch {
      return [];
    }
  }));
}

export class BrowserSession {
  private downloadManager?: BrowserDownloadManager;
  private browserDownloads() {
    const receiver = this.options.host?.receiveDownload;
    if (!receiver) return undefined;
    return this.downloadManager ||= new BrowserDownloadManager(receiver, this.options.runId || this.pageGroupId, (result) => {
      this.notifyLivePreviewNative(result.ok ? {
        kind: 'downloadReady', download: { id: result.artifact.artifactId, artifactId: result.artifact.artifactId,
          fileName: result.artifact.fileName, url: result.artifact.downloadUrl || result.artifact.url },
      } : { kind: 'downloadFailed', download: { id: randomUUID(), fileName: result.fileName, error: result.error } });
    });
  }
  private stateReader?: BrowserStateReader;
  private sessionScheduler?: BrowserSessionScheduler;
  private withSessionOperation<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closePromise) return Promise.reject(new Error('Browser session is closing.'));
    return (this.sessionScheduler ||= new BrowserSessionScheduler()).run(operation, signal);
  }

  private browser?: Browser;
  private browserServer?: BrowserServer;
  private browserCodeConnection?: BrowserCodeConnection;
  private browserCodeKernel?: BrowserCodeKernel;
  private browserCodeKernelRevision?: number;
  private lifecycle: BrowserSessionLifecycleState = 'idle';
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private context?: BrowserContext;
  private page?: Page;

  private readonly networkDiagnostics = new BrowserNetworkDiagnostics(
    (key) => this.configuredValue(key), (page, source, message) => this.recordDomChangeError(page, source, message),
  );
  private domChangeErrors: string[] = [];
  private domChangeErrorFingerprintsByPage = new WeakMap<Page, Set<string>>();
  private attachedPages = new WeakSet<Page>();






  private lastScreenshotMetrics?: ScreenshotMetrics;
  private screenshotGenerationSequence = 0;
  private lastInteractiveCandidates: InteractiveCandidate[] = [];
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
  private lastScreenshotTiming?: ScreenshotTiming;
  private ownedPages = new Set<Page>();
  private browserOwnership: BrowserOwnership = 'launched';
  private releaseSharedBrowser?: (force?: boolean) => Promise<void>;
  private parentBrowserSession?: BrowserSession;
  private childBrowserSessions = new Set<BrowserSession>();
  private managedProfileDir?: string;
  private livePreviewStateListeners = new Set<BrowserLivePreviewStateListener>();
  private livePreviewNativeListeners = new Set<(event: BrowserLiveNativeEvent) => void>();
  private activeScreencasts = new Set<BrowserScreencastHandle>();
  private liveDialogOpenedWaiters = new Set<(page: Page) => void>();
  private pendingLiveDialogs = new Map<string, { descriptor: BrowserLiveDialog; dialog: Dialog; page: Page }>();
  private pendingLiveFileInputs = new Map<string, { element: ElementHandle<HTMLInputElement>; page: Page }>();
  private livePreviewTabsNotifyScheduled = false;
  private contextPageListener?: (page: Page) => void;
  private pageDiscoveryListener?: (page: Page) => void;
  private pageGroupInitScriptPages = new WeakSet<Page>();
  private pageGroupMarkPromises = new WeakMap<Page, Promise<void>>();
  private navigationSequenceByPage = new WeakMap<Page, number>();
  private browserRuntimeRevisionByFrame = new WeakMap<Frame, number>();
  private browserRuntimeInstalledRevisionByFrame = new WeakMap<Frame, string>();
  private livePreviewExplicitPageSelectionAt = 0;
  private livePreviewExplicitPageSelectionSequence = 0;
  private livePreviewBackgroundPageUntil = new WeakMap<Page, number>();
  private livePreviewBackgroundPopupOpeners = new WeakSet<Page>();
  private livePreviewDownloadGestureUntil = new WeakMap<Page, number>();
  private livePreviewDownloadListeners = new Map<Page, (download: PlaywrightDownload) => void>();
  private pageListenerDisposers = new Map<Page, () => void>();
  private pageOwnershipCloseListeners = new Map<Page, () => void>();
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
  private readonly pageGroupId: string;
  private capabilityConfiguration: CapabilityConfiguration;
  private browserSurface: BrowserSessionSurface = 'external';
  private transportKind?: BrowserSessionTransportKind;

  constructor(private readonly options: BrowserSessionOptions = {}) {
    this.capabilityConfiguration = Object.freeze({ ...options.configuration });
    this.pageGroupId = normalizePageGroupId(options.runId);
  }

  /** Applies host-loaded settings before a lazily created session is started. */
  configure(configuration: CapabilityConfiguration | undefined) {
    if (!configuration) return this;
    this.capabilityConfiguration = Object.freeze({
      ...this.capabilityConfiguration,
      ...configuration,
    });
    return this;
  }

  private runtimeEnvironment(): BrowserRuntimeEnvironment {
    return { ...process.env, ...this.capabilityConfiguration };
  }

  private configuredValue(key: string) {
    return this.capabilityConfiguration[key] ?? process.env[key];
  }

  private snapshotFrameConcurrency() {
    return boundedPositiveIntegerEnv(
      'BROWSER_SNAPSHOT_FRAME_CONCURRENCY',
      4,
      1,
      16,
      this.runtimeEnvironment(),
    );
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

  private async sessionStorageByOrigin() {
    const snapshots = await Promise.all(this.sessionPages().map(async (page) => {
      if (page.isClosed()) return undefined;
      return page.evaluate(() => {
        if (!/^https?:$/.test(location.protocol)) return undefined;
        return {
          origin: location.origin,
          values: Object.fromEntries(Array.from({ length: sessionStorage.length }, (_, index) => {
            const key = sessionStorage.key(index);
            return key === null ? undefined : [key, sessionStorage.getItem(key) || ''];
          }).filter((item): item is [string, string] => Boolean(item))),
        };
      }).catch(() => undefined);
    }));
    return Object.fromEntries(snapshots
      .filter((item): item is { origin: string; values: Record<string, string> } => Boolean(item?.origin))
      .map((item) => [item.origin, item.values]));
  }

  async forkChildSession(options: BrowserChildSessionOptions): Promise<BrowserSession> {
    if (!this.context || !this.isUsable()) throw new Error('Parent browser session has not started');
    const context = this.context;
    const restorePage = options.background === false ? undefined : this.page;
    const inheritedSessionStorage = options.inheritSessionStorage === false
      ? {}
      : await this.sessionStorageByOrigin();
    const child = new BrowserSession({
      actionFrameLimit: options.actionFrameLimit,
      browserSurface: this.browserSurface,
      browserCodeStateSessionId: options.browserCodeStateSessionId || this.options.browserCodeStateSessionId,
      isMarked: options.isMarked,
      popupWaitMs: options.popupWaitMs,
      preferExistingPage: false,
      runId: options.runId,
      slowMoMs: options.slowMoMs,
      host: this.options.host,
      configuration: this.capabilityConfiguration,
    });
    child.browserSurface = this.browserSurface;
    child.transportKind = this.transportKind;
    child.browserOwnership = 'shared';
    child.browser = this.browser;
    child.browserCodeConnection = this.browserCodeConnection;
    child.context = context;
    child.parentBrowserSession = this;
    child.nativeTabGrouperEnabled = this.nativeTabGrouperEnabled;
    child.usesSessionGroupPageSelection = true;
    this.childBrowserSessions.add(child);
    try {
      await child.prepareContext(context, { claimPages: false });
      child.installOwnedPageDiscovery(context);
      const page = await context.newPage();
      await this.pageGroupMarkPromises.get(page)?.catch(() => undefined);
      this.releaseOwnedPage(page);
      child.claimPage(page);
      if (Object.keys(inheritedSessionStorage).length) {
        await page.addInitScript((storageByOrigin) => {
          const values = storageByOrigin[location.origin];
          if (!values) return;
          for (const [key, value] of Object.entries(values)) sessionStorage.setItem(key, value);
        }, inheritedSessionStorage);
      }
      await child.ensurePageGroup(page);
      if (restorePage && !restorePage.isClosed()) await restorePage.bringToFront().catch(() => undefined);
      child.lifecycle = 'ready';
      registerBrowserSession(child);
      return child;
    } catch (error) {
      await child.close({ force: true }).catch(() => undefined);
      throw error;
    }
  }

  async injectCookies(cookies: BrowserSessionCookie[]) {
    return this.withSessionOperation(async () => {

    if (!this.context) throw new Error('Browser session has not started');
    if (!cookies.length) return 0;
    await this.context.addCookies(cookies);
    return cookies.length;

    });
  }

  // 启动 Playwright 浏览器并注入事件监听记录脚本，用于后续识别可交互元素。
  async start() {
    if (this.closePromise) await this.closePromise;
    if (this.lifecycle === 'ready' && this.isUsable()) return;
    if (this.startPromise) return this.startPromise;
    if (this.lifecycle === 'ready') await this.closeNow({ force: true });

    this.lifecycle = 'starting';
    const attempt = this.startNow();
    this.startPromise = attempt;
    try {
      await attempt;
      this.lifecycle = 'ready';
    } catch (error) {
      this.lifecycle = 'failed';
      await this.closeNow({ force: true }).catch(() => undefined);
      throw error;
    } finally {
      if (this.startPromise === attempt) this.startPromise = undefined;
    }
  }

  async ensureStarted() {
    await this.start();
  }

  private async startNow() {
    // A stale browser can restart this instance in place, so turn-scoped tools
    // keep their BrowserSession identity while it reconnects to the tab group.
    registerBrowserSession(this);
    const { chromium } = await import('playwright');
    const environment = this.runtimeEnvironment();
    const headless = browserHeadlessEnabled(this.options, { env: environment });
    const isolated = this.options.isolated === true;
    this.browserSurface = resolveBrowserSessionSurface(this.options, electronEmbeddedBrowserEnabled(environment));
    const fullscreen = environment.BROWSER_FULLSCREEN !== 'false';
    const fixedViewport = fixedBrowserViewportFromEnv(environment);
    const headlessFallbackViewport = { width: fullscreen ? 1920 : 1280, height: fullscreen ? 1080 : 800 };
    const useNativeViewport = !headless && !fixedViewport;
    const contextViewport = useNativeViewport ? null : fixedViewport || headlessFallbackViewport;
    const windowSizeArg = fixedViewport
      ? `--window-size=${fixedViewport.width},${fixedViewport.height + 120}`
      : headless
        ? `--window-size=${headlessFallbackViewport.width},${headlessFallbackViewport.height + 120}`
        : '';
    const ignoreHTTPSErrors = environment.BROWSER_IGNORE_HTTPS_ERRORS === 'true';
    const useElectronEmbeddedBrowser = this.browserSurface === 'electron-embedded';
    const forceBundledBrowser = isolated || (environment.AI_WEB_TEST_FORCE_PLAYWRIGHT_BROWSER === 'true' && !useElectronEmbeddedBrowser);
    const channel = forceBundledBrowser ? undefined : environment.BROWSER_CHANNEL?.trim() || undefined;
    const executablePath = environment.AI_WEB_TEST_CHROMIUM_EXECUTABLE_PATH?.trim() || undefined;
    const browserProfileKey = this.options.browserProfileKey ? normalizePageGroupId(this.options.browserProfileKey) : '';
    const sharedBrowserRuntimeKey = this.options.sharedBrowserRuntimeKey?.trim() || '';
    const rawCdpEndpoint = forceBundledBrowser
      ? ''
      : useElectronEmbeddedBrowser
        ? electronEmbeddedBrowserCdpEndpoint(environment)
        : environment.BROWSER_CDP_ENDPOINT?.trim()
          || environment.BROWSER_CONNECT_CDP_ENDPOINT?.trim()
          || environment.CHROME_REMOTE_DEBUGGING_URL?.trim()
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
      : environment.BROWSER_USER_DATA_DIR?.trim()
        || environment.AI_WEB_TEST_BROWSER_PROFILE_DIR?.trim()
        || '';
    const requestedUserDataDir = configuredUserDataDir && browserProfileKey
      ? path.join(configuredUserDataDir, browserProfileKey)
      : configuredUserDataDir;
    const tabGrouperEnabled = !isolated && sessionTabGrouperEnabled(headless, environment);
    const useSharedBrowserTabs = !isolated && (
      Boolean(sharedBrowserRuntimeKey)
      || (sharedBrowserTabsEnabled(environment) && !useElectronEmbeddedBrowser && !browserProfileKey)
    );
    const useSessionGroupPageSelection = tabGrouperEnabled || Boolean(browserProfileKey);
    this.nativeTabGrouperEnabled = tabGrouperEnabled;
    this.usesSessionGroupPageSelection = useSessionGroupPageSelection;
    const restoreLastSession = tabGrouperEnabled && environment.BROWSER_RESTORE_LAST_SESSION !== 'false';
    const autoTabGroupProfileKey = browserProfileKey || (useSharedBrowserTabs ? 'shared' : this.pageGroupId);
    // A user-scoped profile must remain persistent in headless runtimes too.
    // Native tab groups still require a visible browser, but cookies, local
    // storage, IndexedDB, and the application-level tab snapshot do not.
    const autoManagedProfileDir = !isolated
      && !cdpEndpoint
      && !requestedUserDataDir
      && (Boolean(browserProfileKey) || tabGrouperEnabled)
      ? sessionTabGrouperProfileDir(autoTabGroupProfileKey, environment)
      : '';
    const autoTabGroupProfileDir = tabGrouperEnabled ? autoManagedProfileDir : '';
    const autoTabGroupDebugPort = (autoTabGroupProfileDir || (tabGrouperEnabled && browserProfileKey && !cdpEndpoint))
      ? sessionTabGrouperDebugPort(autoTabGroupProfileKey, environment)
      : undefined;
    const autoTabGroupCdpEndpoint = cdpEndpointForPort(autoTabGroupDebugPort);
    const userDataDir = requestedUserDataDir || autoManagedProfileDir;
    this.managedProfileDir = autoManagedProfileDir || undefined;
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
      ].filter(Boolean), headless, { exclusive: Boolean(autoTabGroupProfileDir), environment }),
    };
    const contextOptions: BrowserContextOptions = {
      viewport: contextViewport,
      ignoreHTTPSErrors,
      ...(this.options.storageState ? { storageState: this.options.storageState } : {}),
    };
    const transportAdapter = resolveBrowserSessionTransportAdapter({
      autoTabGroupCdpEndpoint,
      cdpEndpoint,
      electronEmbedded: useElectronEmbeddedBrowser,
      shared: useSharedBrowserTabs,
      userDataDir,
    });
    this.transportKind = transportAdapter.kind;

    if (transportAdapter.kind === 'shared') {
      const lease = await acquireSharedBrowser({
        runtimeKey: sharedBrowserRuntimeKey || undefined,
        chromium,
        cdpEndpoint,
        reconnectCdpEndpoint: autoTabGroupCdpEndpoint,
        userDataDir,
        launchOptions,
        contextOptions,
        managedProfileDir: this.managedProfileDir,
        environment,
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

    if (transportAdapter.kind === 'electron-cdp' || transportAdapter.kind === 'cdp') {
      this.browserOwnership = 'connected';
      this.browser = await chromium.connectOverCDP(cdpEndpoint);
      this.browserCodeConnection = { protocol: 'cdp', endpoint: cdpEndpoint };
      if (transportAdapter.kind === 'electron-cdp') {
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

    if (transportAdapter.kind === 'persistent-cdp' || transportAdapter.kind === 'persistent') {
      if (transportAdapter.kind === 'persistent-cdp') {
        const connected = await connectOrLaunchPersistentBrowserOverCdp({
          chromium,
          endpoint: autoTabGroupCdpEndpoint,
          userDataDir,
          launchOptions,
          contextOptions,
          environment,
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

    this.browserOwnership = transportAdapter.ownership;
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
        const nativeTabId = await this.readPageNativeTabId(page);
        if (nativeTabId) this.nativeTabIdByPage.set(page, nativeTabId);
        reclaimedPages.push(page);
      }
    }
    return reclaimedPages;
  }

  private async reclaimPagesFromNativeTabGroup(context: BrowserContext): Promise<{ found: boolean; pages: Page[] }> {
    const lookup = await this.findNativeTabGroupTabs(context);
    if (!lookup?.found) return { found: false, pages: [] };

    const existingPages = await this.waitForNativeGroupPages(context, 4);
    if (existingPages.length) return { found: true, pages: existingPages };

    await this.activateNativeTabGroupTab(context, lookup.tabs);
    const activatedPages = await this.waitForNativeGroupPages(context, 8);
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

  private async waitForNativeGroupPages(context: BrowserContext, attempts: number) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const markedPages = await this.reclaimSessionPagesByMarker(context);
      if (markedPages.length) return markedPages;

      if (attempt < attempts - 1) await sleep(150);
    }
    return [] as Page[];
  }

  private async prepareContext(context: BrowserContext, options: { claimPages?: boolean } = {}) {
    if (!preparedContextInitScripts.has(context)) {
      preparedContextInitScripts.add(context);
      await context.addInitScript(installAiBrowserPageRuntime, AI_DOM_RUNTIME_VERSION).catch((error) => {
        preparedContextInitScripts.delete(context);
        throw error;
      });
    }
    if (options.claimPages === false) return;
    if (!this.contextPageListener) {
      this.contextPageListener = (page) => { this.claimPage(page, { makeActive: false }); };
      context.on('page', this.contextPageListener);
    }
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
    const openerDownloadGestureUntil = this.livePreviewDownloadGestureUntil.get(opener) || 0;
    if (openerDownloadGestureUntil > Date.now()) {
      this.livePreviewDownloadGestureUntil.set(page, openerDownloadGestureUntil);
    }
    const keepInBackground = this.livePreviewBackgroundPopupOpeners.has(opener);
    if (keepInBackground) this.livePreviewBackgroundPageUntil.set(page, Date.now() + 2_000);
    if (this.claimPage(page, { makeActive: false })) {
      if (selectionSequence !== this.livePreviewExplicitPageSelectionSequence) return;
      await (keepInBackground ? opener : page).bringToFront().catch(() => undefined);
      if (
        selectionSequence === this.livePreviewExplicitPageSelectionSequence
        && !page.isClosed()
        && this.ownedPages.has(page)
      ) {
        this.page = keepInBackground ? opener : page;
        if (keepInBackground) this.livePreviewExplicitPageSelectionAt = Date.now();
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
      const markPromise = this.markPageGroup(page).finally(() => {
        if (this.pageGroupMarkPromises.get(page) === markPromise) this.pageGroupMarkPromises.delete(page);
      });
      this.pageGroupMarkPromises.set(page, markPromise);
      void markPromise;
      this.notifyLivePreviewTabsChanged();
      const onOwnedPageClose = () => {
        this.detachPageListeners(page);
        this.ownedPages.delete(page);
        livePreviewVisibilityOwners.delete(page);
        if (sharedPageOwners.get(page) === this.pageGroupId) sharedPageOwners.delete(page);
        if (this.page === page) {
          this.page = this.sessionPages()[0];
        }
        this.notifyLivePreviewTabsChanged();
      };
      this.pageOwnershipCloseListeners.set(page, onOwnedPageClose);
      page.once('close', onOwnedPageClose);
    }
    if (options.makeActive !== false) this.page = page;
    return true;
  }

  private releaseOwnedPage(page: Page) {
    if (!this.ownedPages.delete(page)) return;
    this.detachPageListeners(page);
    livePreviewVisibilityOwners.delete(page);
    if (sharedPageOwners.get(page) === this.pageGroupId) sharedPageOwners.delete(page);
    if (this.page === page) this.page = this.sessionPages()[0];
    this.notifyLivePreviewTabsChanged();
  }

  private handleLivePreviewVisibility(page: Page, visible: boolean) {
    if (!visible || page.isClosed() || !this.ownedPages.has(page)) return;
    if ((this.livePreviewBackgroundPageUntil.get(page) || 0) > Date.now()) return;
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
    const configured = this.options.slowMoMs ?? Number(this.configuredValue('BROWSER_SLOW_MO_MS') || 0);
    if (!Number.isFinite(configured) || configured < 0) return 0;
    return Math.min(Math.floor(configured), 2000);
  }

  private actionFrames() {
    const configured = this.options.actionFrameLimit;
    const frameLimit = typeof configured === 'number' && Number.isFinite(configured) && configured > 0
      ? Math.min(200, Math.floor(configured))
      : numericLimitFromEnv(
          'BROWSER_CHAT_ACTION_FRAME_LIMIT',
          numericLimitFromEnv('BROWSER_ACTION_FRAME_LIMIT', 24, this.runtimeEnvironment()),
          this.runtimeEnvironment(),
        );
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

  private tabGroupLabel() {
    return browserSessionGroupLabel(this.pageGroupId);
  }

  private artifactDirectory(runId: string) {
    const hostPath = this.options.host?.artifactPath?.(runId);
    if (hostPath) return path.resolve(hostPath);
    const root = path.resolve(
      this.configuredValue('CAPABILITY_BROWSER_ARTIFACTS_DIR')
        || this.configuredValue('ARTIFACTS_DIR')
        || path.join(process.cwd(), 'runtime', 'artifacts'),
    );
    const safeRunId = String(runId || 'browser')
      .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_')
      .replace(/^\.+/, '')
      .trim()
      .slice(0, 160) || 'browser';
    return path.join(root, safeRunId);
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
      applyPrefix: browserTabTitlePrefixEnabled(this.runtimeEnvironment()),
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

  private async readPageNativeTabId(page: Page) {
    if (page.isClosed()) return undefined;
    return page.evaluate(() => {
      const value = Number(document.documentElement?.getAttribute('data-ai-web-test-native-tab-id'));
      return Number.isSafeInteger(value) && value > 0 ? value : undefined;
    }).catch(() => undefined);
  }

  private ensureLivePreviewState() {
    this.configuredViewportKeyByPage ||= new WeakMap<Page, string>();
    this.livePreviewBackgroundPageUntil ||= new WeakMap<Page, number>();
    this.livePreviewBackgroundPopupOpeners ||= new WeakSet<Page>();
    this.livePreviewDownloadGestureUntil ||= new WeakMap<Page, number>();
    this.livePreviewDownloadListeners ||= new Map<Page, (download: PlaywrightDownload) => void>();
    this.pageListenerDisposers ||= new Map<Page, () => void>();
    this.pageOwnershipCloseListeners ||= new Map<Page, () => void>();
    this.activeScreencasts ||= new Set<BrowserScreencastHandle>();
    this.livePreviewTabIds ||= new WeakMap<Page, string>();
    this.nativeTabIdByPage ||= new WeakMap<Page, number>();
    if (!Number.isFinite(this.livePreviewExplicitPageSelectionAt)) this.livePreviewExplicitPageSelectionAt = 0;
    if (!Number.isFinite(this.livePreviewExplicitPageSelectionSequence)) this.livePreviewExplicitPageSelectionSequence = 0;
    if (!Number.isFinite(this.livePreviewNativeTabRefreshAt)) this.livePreviewNativeTabRefreshAt = 0;
    if (!Number.isFinite(this.livePreviewTabIdSequence)) this.livePreviewTabIdSequence = 0;
    if (typeof this.nativeTabGrouperEnabled !== 'boolean') {
      const environment = this.runtimeEnvironment();
      const headless = this.options.debugDevtools ? false : this.options.headless ?? environment.HEADLESS_BROWSER === 'true';
      this.nativeTabGrouperEnabled = this.options.isolated !== true && sessionTabGrouperEnabled(headless, environment);
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

  async restoreTabsFromSnapshot(savedTabs: BrowserTabSnapshot[]): Promise<BrowserTabRestoreResult> {
    return this.withSessionOperation(async () => {

    this.ensureLivePreviewState();
    const context = this.context;
    if (!context) {
      return { attempted: 0, created: 0, restored: 0, failedUrls: [], tabs: [] };
    }
    const requested = savedTabs
      .filter((tab) => !tab.groupId || normalizePageGroupId(tab.groupId) === this.pageGroupId)
      .map((tab, position) => ({
        ...tab,
        position,
        url: String(tab.url || '').trim(),
      }))
      .filter((tab) => tab.url && !isBlankBrowserUrlLike(tab.url) && !/^(?:blob|javascript):/i.test(tab.url))
      .sort((left, right) => left.index - right.index || left.position - right.position);
    if (!requested.length) {
      return { attempted: 0, created: 0, restored: 0, failedUrls: [], tabs: this.getTabsSnapshot() };
    }

    await this.refreshSessionGroupPages({ forceNativeRefresh: true });
    const availablePages = this.sessionPages();
    const unusedPages = new Set(availablePages);
    const restoredPages: Array<Page | undefined> = [];
    const failedUrls: string[] = [];
    let created = 0;
    const navigationTimeoutMs = boundedPositiveIntegerEnv('BROWSER_TAB_RESTORE_TIMEOUT_MS', 15_000, 1_000, 60_000, this.runtimeEnvironment());

    for (const tab of requested) {
      const matching = [...unusedPages].find((page) => page.url() === tab.url);
      if (matching) {
        unusedPages.delete(matching);
        restoredPages.push(matching);
        continue;
      }

      const blank = [...unusedPages].find((page) => isBlankPage(page));
      const page = blank || await context.newPage();
      if (blank) unusedPages.delete(blank);
      else created += 1;
      this.claimPage(page, { makeActive: false });
      await this.ensurePageGroup(page);
      let navigationFailed = false;
      try {
        await page.goto(tab.url, { waitUntil: 'commit', timeout: navigationTimeoutMs });
      } catch {
        navigationFailed = true;
        if (isBlankPage(page)) {
          failedUrls.push(tab.url);
          restoredPages.push(undefined);
          continue;
        }
      }
      if (navigationFailed) failedUrls.push(tab.url);
      await this.ensurePageGroup(page);
      restoredPages.push(page);
    }

    await Promise.all(
      [...unusedPages]
        .filter((page) => isBlankPage(page))
        .map((page) => page.close().catch(() => undefined)),
    );

    const activeIndex = requested.findIndex((tab) => tab.active);
    const activePage = restoredPages[activeIndex >= 0 ? activeIndex : 0]
      || restoredPages.find((page): page is Page => Boolean(page));
    if (activePage) await this.activateSessionPage(activePage).catch(() => undefined);
    return {
      attempted: requested.length,
      created,
      restored: restoredPages.filter((page): page is Page => Boolean(page)).length,
      failedUrls,
      tabs: this.getTabsSnapshot(),
    };

    });
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
        await this.reclaimSessionPagesByMarker(context);
      }
    }

    const pages = this.sessionPages();
    const visibility = await Promise.all(pages.map(async (page) => ({
      page,
      visible: await page.evaluate(() => document.visibilityState === 'visible').catch(() => false),
    })));
    const currentPageVisible = visibility.some((item) => item.page === this.page && item.visible);
    const visiblePage = visibility.find((item) => (
      item.visible && (this.livePreviewBackgroundPageUntil.get(item.page) || 0) <= now
    ))?.page;
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
    this.livePreviewBackgroundPageUntil.delete(page);
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
    const environment = this.runtimeEnvironment();
    const headless = this.options.debugDevtools ? false : this.options.headless ?? environment.HEADLESS_BROWSER === 'true';
    const fullscreen = environment.BROWSER_FULLSCREEN !== 'false';
    const viewportMode = environment.BROWSER_VIEWPORT_MODE?.trim().toLowerCase() === 'fixed' ? 'fixed' : 'auto';
    const fixedViewport = fixedBrowserViewportFromEnv(environment);
    const connectedExternalBrowser = this.browserSurface === 'external'
      && (this.transportKind === 'cdp' || this.transportKind === 'persistent-cdp' || this.transportKind === 'shared');
    // A connected browser owns its native window and CSS viewport. Applying a
    // Playwright viewport override here makes the real test browser appear
    // shrunken after an otherwise read-only screenshot/inspection operation.
    const viewport = connectedExternalBrowser
      ? undefined
      : fixedViewport || (headless
        ? { width: fullscreen ? 1920 : 1280, height: fullscreen ? 1080 : 800 }
        : undefined);
    const settingKey = [
      viewportMode,
      environment.BROWSER_VIEWPORT_WIDTH || '',
      environment.BROWSER_VIEWPORT_HEIGHT || '',
      headless ? 'headless' : 'headful',
      fullscreen ? 'fullscreen' : 'windowed',
      this.browserSurface,
      this.transportKind || 'not-started',
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
    return this.withSessionOperation(async () => {

    let page = this.sessionPages().find((candidate) => this.livePreviewTabId(candidate) === tabId);
    if (!page) {
      const refreshedPages = await this.refreshSessionGroupPages({ forceNativeRefresh: true });
      page = refreshedPages.find((candidate) => this.livePreviewTabId(candidate) === tabId);
    }
    if (!page) return { ok: false, actual: 'The selected live-preview tab no longer exists.' };
    await this.activateSessionPage(page);
    return { ok: true, actual: `Switched live preview to ${page.url()}` };

    });
  }

  async startScreencast(options: {
    onActivePageChanged?: () => void;
    onError?: (error: unknown) => void;
    onFrame: (frame: BrowserScreencastFrame) => void | Promise<void>;
    onNativeEvent?: (event: BrowserLiveNativeEvent) => void;
    onTabsChanged?: (tabs: BrowserTabSnapshot[]) => void;
    video?: boolean;
  }): Promise<BrowserScreencastHandle> {
    this.ensureLivePreviewState();
    await this.refreshSessionGroupPages({ forceNativeRefresh: true });
    const environment = this.runtimeEnvironment();
    const format = options.video
      ? resolveBrowserPreviewImageFormat(environment.BROWSER_PREVIEW_VIDEO_SOURCE_FORMAT || 'jpeg')
      : resolveBrowserPreviewImageFormat(environment.BROWSER_SCREENCAST_FORMAT);
    const contentType: BrowserScreencastFrame['contentType'] = format === 'png' ? 'image/png' : 'image/jpeg';
    const rawQuality = Number(environment.BROWSER_SCREENCAST_QUALITY ?? 90);
    const quality = Math.min(100, Math.max(40, Math.floor(Number.isFinite(rawQuality) ? rawQuality : 90)));
    const currentFrameIntervalMs = () => browserPreviewFrameIntervalMs(environment.BROWSER_PREVIEW_FPS);
    const targetFps = browserPreviewFramesPerSecond(environment.BROWSER_PREVIEW_FPS);
    const nativeFrameStride = Math.max(1, Math.round(60 / targetFps));
    const maximumDimensions = browserPreviewVideoMaximumDimensions(environment);
    let stopped = false;
    let stopPromise: Promise<void> | undefined;
    let page: Page | undefined;
    let client: import('playwright').CDPSession | undefined;
    let fileChooserListener: ((chooser: FileChooser) => void) | undefined;
    let nativeFrameListener: ((event: {
      data: string;
      metadata?: { deviceHeight?: number; deviceWidth?: number };
      sessionId: number;
    }) => void) | undefined;
    let pageBindingPromise: Promise<{ client: import('playwright').CDPSession; page: Page }> | undefined;
    let viewport = { width: 1280, height: 720 };
    let latestNativeFrame: {
      capturedPage: Page;
      cssViewport: { width: number; height: number };
      data: string;
      metadata?: { deviceHeight?: number; deviceWidth?: number };
      outputViewport: { width: number; height: number };
      sequence: number;
    } | undefined;
    let outputTimer: ReturnType<typeof setTimeout> | undefined;
    let nextOutputAt = Date.now();
    let nextPageRefreshAt = 0;
    let pageRefreshPromise: Promise<void> | undefined;
    let nativeFrames = 0;
    let nativeFrameSequence = 0;
    let emittedNativeFrameSequence = 0;
    let resolveInitialFrame: (() => void) | undefined;
    const initialFrameReady = new Promise<void>((resolve) => { resolveInitialFrame = resolve; });
    const framePump = new BrowserPreviewFramePump<BrowserScreencastFrame>({
      intervalMs: () => 1,
      onError: options.onError,
      onFrame: options.onFrame,
    });
    const tabsListener = options.onTabsChanged;
    if (tabsListener) {
      this.livePreviewStateListeners.add(tabsListener);
      tabsListener(this.getTabsSnapshot());
    }
    const nativeListener = options.onNativeEvent;
    if (nativeListener) {
      this.livePreviewNativeListeners.add(nativeListener);
      for (const pending of this.pendingLiveDialogs.values()) {
        nativeListener({ dialog: pending.descriptor, kind: 'dialogOpened' });
      }
    }

    const pushOutputFrame = (
      capturedPage: Page,
      data: string,
      cssViewport: { width: number; height: number },
      outputViewport: { width: number; height: number },
      metadata?: { deviceHeight?: number; deviceWidth?: number },
    ) => {
      if (stopped || capturedPage.isClosed() || this.activePage !== capturedPage) return;
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
        // Keep interaction/layout coordinates tied to the real CSS viewport.
        // The encoded pixel size belongs in metadata and must never feed the
        // next Page.captureScreenshot clip, otherwise frames alternate between
        // the full page and a cropped/zoomed top-left region.
        viewport: cssViewport,
      });
    };
    const acceptNativeFrame = (
      capturedPage: Page,
      data: string,
      metadata?: { deviceHeight?: number; deviceWidth?: number },
    ) => {
      if (stopped || capturedPage.isClosed() || this.activePage !== capturedPage || !data) return;
      nativeFrames += 1;
      latestNativeFrame = {
        capturedPage,
        cssViewport: { ...viewport },
        data,
        metadata,
        outputViewport: {
          height: Math.max(1, Math.floor(Number(metadata?.deviceHeight) || viewport.height)),
          width: Math.max(1, Math.floor(Number(metadata?.deviceWidth) || viewport.width)),
        },
        sequence: ++nativeFrameSequence,
      };
      resolveInitialFrame?.();
      resolveInitialFrame = undefined;
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
    const detachCurrentPage = async () => {
      const currentClient = client;
      const currentListener = nativeFrameListener;
      const currentPage = page;
      client = undefined;
      nativeFrameListener = undefined;
      if (currentPage && fileChooserListener) currentPage.off('filechooser', fileChooserListener);
      fileChooserListener = undefined;
      if (!currentClient) return;
      if (currentListener) currentClient.off('Page.screencastFrame', currentListener);
      await currentClient.send('Page.stopScreencast').catch(() => undefined);
      await currentClient.detach().catch(() => undefined);
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
        await detachCurrentPage();
        await nextActivePage.bringToFront().catch(() => undefined);
        const nextClient = await nextActivePage.context().newCDPSession(nextActivePage);
        page = nextActivePage;
        client = nextClient;
        if (nativeListener) {
          fileChooserListener = (chooser) => {
            void this.liveFileControlForElement(nextActivePage, chooser.element() as ElementHandle<HTMLInputElement>)
              .then((control) => {
                if (!stopped && control) nativeListener({ control, kind: 'controlOpened' });
              })
              .catch((error) => {
                if (!stopped) options.onError?.(error);
              });
          };
          nextActivePage.on('filechooser', fileChooserListener);
        }
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
        latestNativeFrame = undefined;
        const listener = (event: {
          data: string;
          metadata?: { deviceHeight?: number; deviceWidth?: number };
          sessionId: number;
        }) => {
          void nextClient.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined);
          if (client !== nextClient || page !== nextActivePage) return;
          acceptNativeFrame(nextActivePage, event.data, event.metadata);
        };
        nativeFrameListener = listener;
        nextClient.on('Page.screencastFrame', listener);
        await nextClient.send('Page.startScreencast', {
          everyNthFrame: nativeFrameStride,
          format,
          maxHeight: maximumDimensions.height,
          maxWidth: maximumDimensions.width,
          ...(format === 'jpeg' ? { quality } : {}),
        });
        return { client: nextClient, page: nextActivePage };
      })();
      try {
        return await pageBindingPromise;
      } finally {
        pageBindingPromise = undefined;
      }
    };
    const emitLatestFrame = () => {
      const latest = latestNativeFrame;
      if (!latest || latest.capturedPage.isClosed() || this.activePage !== latest.capturedPage) return;
      if (latest.sequence <= emittedNativeFrameSequence) return;
      emittedNativeFrameSequence = latest.sequence;
      pushOutputFrame(
        latest.capturedPage,
        latest.data,
        latest.cssViewport,
        latest.outputViewport,
        latest.metadata,
      );
    };
    const scheduleOutput = () => {
      if (stopped || outputTimer) return;
      const delay = Math.max(0, nextOutputAt - Date.now());
      outputTimer = setTimeout(() => {
        outputTimer = undefined;
        if (stopped) return;
        const scheduledAt = nextOutputAt;
        const intervalMs = currentFrameIntervalMs();
        nextOutputAt = Math.max(scheduledAt + intervalMs, Date.now());
        void bindActivePage()
          .then(() => emitLatestFrame())
          .catch((error) => {
            if (!stopped) options.onError?.(error);
          })
          .finally(() => scheduleOutput());
      }, delay);
      outputTimer.unref?.();
    };
    const stopScreencast = async (notifyPageChanged: boolean) => {
      if (stopPromise) return stopPromise;
      stopped = true;
      resolveInitialFrame?.();
      resolveInitialFrame = undefined;
      if (outputTimer) clearTimeout(outputTimer);
      outputTimer = undefined;
      stopPromise = (async () => {
        if (tabsListener) this.livePreviewStateListeners.delete(tabsListener);
        if (nativeListener) this.livePreviewNativeListeners.delete(nativeListener);
        if (this.livePreviewNativeListeners.size === 0) {
          await Promise.all([this.dismissPendingLiveDialogs(), this.clearPendingLiveFileInputs()]);
        }
        await pageRefreshPromise?.catch(() => undefined);
        await framePump.stop();
        await detachCurrentPage();
        page = undefined;
        latestNativeFrame = undefined;
        if (notifyPageChanged) await options.onActivePageChanged?.();
      })();
      return stopPromise;
    };
    try {
      const binding = await bindActivePage();
      let initialWaitTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        initialFrameReady,
        new Promise<void>((resolve) => {
          initialWaitTimer = setTimeout(resolve, 1_000);
          initialWaitTimer.unref?.();
        }),
      ]);
      if (initialWaitTimer) clearTimeout(initialWaitTimer);
      if (!latestNativeFrame && !stopped && !binding.page.isClosed()) {
        const result = await binding.client.send('Page.captureScreenshot', {
          captureBeyondViewport: false,
          format,
          fromSurface: true,
          optimizeForSpeed: true,
          ...(format === 'jpeg' ? { quality } : {}),
        });
        acceptNativeFrame(binding.page, result.data);
      }
      emitLatestFrame();
      if (!stopped) await framePump.flushLatest();
      nextOutputAt = Date.now() + currentFrameIntervalMs();
      scheduleOutput();
    } catch (error) {
      if (tabsListener) this.livePreviewStateListeners.delete(tabsListener);
      if (nativeListener) this.livePreviewNativeListeners.delete(nativeListener);
      await stopScreencast(false);
      throw error;
    }
    const handle: BrowserScreencastHandle = {
      metrics: () => {
        const metrics = framePump.metrics();
        return {
          ...metrics,
          activeCaptures: 0,
          imageFormat: format,
          ...(format === 'jpeg' ? { imageQuality: quality } : {}),
          maxConcurrentCaptures: 1,
          nativeFrames,
          nativeFps: nativeFrames / Math.max(0.001, metrics.elapsedSeconds),
          targetFps,
        };
      },
      stop: async () => {
        try {
          await stopScreencast(false);
        } finally {
          this.activeScreencasts.delete(handle);
        }
      },
    };
    this.activeScreencasts.add(handle);
    return handle;
  }

  private async liveFileControlForElement(
    page: Page,
    element: ElementHandle<HTMLInputElement>,
  ): Promise<Extract<BrowserLiveNativeControl, { kind: 'file' }> | undefined> {
    const descriptor = await element.evaluate((input) => {
      if (input.type !== 'file' || input.disabled) return undefined;
      const ownRect = input.getBoundingClientRect();
      const labelRect = Array.from(input.labels || [])
        .map((label) => label.getBoundingClientRect())
        .find((rect) => rect.width > 0 && rect.height > 0);
      const rect = ownRect.width > 0 && ownRect.height > 0 ? ownRect : labelRect;
      const left = rect?.left ?? Math.max(16, window.innerWidth * 0.32);
      const top = rect?.top ?? Math.max(16, window.innerHeight * 0.32);
      const width = rect?.width ?? Math.min(360, window.innerWidth * 0.36);
      const height = rect?.height ?? 40;
      const labelClone = input.labels?.[0]?.cloneNode(true);
      if (labelClone instanceof HTMLElement) {
        labelClone.querySelectorAll('select, input, textarea, button').forEach((control) => control.remove());
      }
      return {
        accept: input.accept,
        capture: input.getAttribute('capture') || undefined,
        label: input.getAttribute('aria-label') || labelClone?.textContent?.trim() || input.name || 'File upload',
        multiple: input.multiple,
        openUpwards: false,
        targetXRatio: (left + width / 2) / Math.max(1, window.innerWidth),
        targetYRatio: (top + height / 2) / Math.max(1, window.innerHeight),
        topRatio: top / Math.max(1, window.innerHeight),
        widthRatio: width / Math.max(1, window.innerWidth),
        xRatio: left / Math.max(1, window.innerWidth),
        yRatio: (top + height) / Math.max(1, window.innerHeight),
      };
    }).catch(() => undefined);
    if (!descriptor) return undefined;
    while (this.pendingLiveFileInputs.size >= 20) {
      const oldest = this.pendingLiveFileInputs.entries().next().value as [string, { element: ElementHandle<HTMLInputElement> }] | undefined;
      if (!oldest) break;
      this.pendingLiveFileInputs.delete(oldest[0]);
      void oldest[1].element.dispose().catch(() => undefined);
    }
    const controlId = randomUUID();
    this.pendingLiveFileInputs.set(controlId, { element, page });
    return { ...descriptor, controlId, kind: 'file' };
  }

  private async liveFileControlAt(page: Page, x: number, y: number) {
    const handle = await page.evaluateHandle(({ x: pageX, y: pageY }) => {
      const target = document.elementFromPoint(pageX, pageY);
      if (!(target instanceof Element)) return undefined;
      const direct = target instanceof HTMLInputElement && target.type === 'file'
        ? target
        : target.closest('input[type="file"]');
      if (direct instanceof HTMLInputElement) return direct;
      const label = target.closest('label');
      if (!(label instanceof HTMLLabelElement)) return undefined;
      const labelled = label.control || label.querySelector('input[type="file"]');
      return labelled instanceof HTMLInputElement && labelled.type === 'file' ? labelled : undefined;
    }, { x, y });
    const element = handle.asElement() as ElementHandle<HTMLInputElement> | null;
    if (!element) {
      await handle.dispose().catch(() => undefined);
      return undefined;
    }
    const control = await this.liveFileControlForElement(page, element);
    if (!control) await element.dispose().catch(() => undefined);
    return control;
  }

  private async liveNativeControlAt(page: Page, x: number, y: number): Promise<BrowserLiveNativeControl | undefined> {
    const fileControl = await this.liveFileControlAt(page, x, y);
    if (fileControl) return fileControl;
    return page.evaluate(({ x: pageX, y: pageY }) => {
      const target = document.elementFromPoint(pageX, pageY);
      if (!(target instanceof Element)) return undefined;
      const control = target.matches('select, input') ? target : target.closest('select, input');
      if (!(control instanceof HTMLSelectElement || control instanceof HTMLInputElement)) return undefined;
      const rect = control.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || control.disabled) return undefined;
      const labelClone = control.labels?.[0]?.cloneNode(true);
      if (labelClone instanceof HTMLElement) {
        labelClone.querySelectorAll('select, input, textarea, button').forEach((child) => child.remove());
      }
      const label = control.getAttribute('aria-label') || labelClone?.textContent?.trim() || control.getAttribute('name') || 'Control';
      const position = (estimatedMenuHeight: number) => ({
        label,
        openUpwards: rect.bottom + estimatedMenuHeight > window.innerHeight && rect.top > estimatedMenuHeight,
        targetXRatio: (rect.left + rect.width / 2) / Math.max(1, window.innerWidth),
        targetYRatio: (rect.top + rect.height / 2) / Math.max(1, window.innerHeight),
        topRatio: rect.top / Math.max(1, window.innerHeight),
        widthRatio: rect.width / Math.max(1, window.innerWidth),
        xRatio: rect.left / Math.max(1, window.innerWidth),
        yRatio: rect.bottom / Math.max(1, window.innerHeight),
      });
      if (control instanceof HTMLSelectElement) {
        if (control.multiple || control.size > 1) return undefined;
        const options = Array.from(control.options).slice(0, 500).map((option) => {
          const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement : undefined;
          return {
            disabled: option.disabled || Boolean(group?.disabled),
            ...(group?.label ? { group: group.label } : {}),
            label: option.label || option.textContent || option.value,
            selected: option.selected,
            value: option.value,
          };
        });
        if (!options.length) return undefined;
        control.focus({ preventScroll: true });
        return {
          ...position(Math.min(320, Math.max(48, options.length * 36 + 8))),
          kind: 'select' as const,
          options,
          selectedValue: control.value,
        };
      }
      if (control.readOnly || control.type === 'file') return undefined;
      const inputType = control.type;
      if (inputType === 'color' || inputType === 'date' || inputType === 'datetime-local' || inputType === 'month' || inputType === 'time' || inputType === 'week') {
        control.focus({ preventScroll: true });
        return {
          ...position(190),
          inputType,
          kind: 'picker' as const,
          max: control.max || undefined,
          min: control.min || undefined,
          step: control.step || undefined,
          value: control.value,
        };
      }
      const list = control.list;
      if (list instanceof HTMLDataListElement) {
        const options = Array.from(list.options).slice(0, 500).map((option) => ({
          label: option.label || option.value,
          value: option.value,
        })).filter((option) => option.value);
        if (!options.length) return undefined;
        control.focus({ preventScroll: true });
        return {
          ...position(Math.min(320, Math.max(48, options.length * 36 + 8))),
          kind: 'datalist' as const,
          options,
          value: control.value,
        };
      }
      return undefined;
    }, { x, y });
  }

  private async liveDownloadLinkAt(page: Page, x: number, y: number) {
    return page.evaluate(({ x: clientX, y: clientY }) => {
      const target = document.elementFromPoint(clientX, clientY);
      const anchor = target instanceof Element ? target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement)) return undefined;
      const url = anchor.href.trim();
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return undefined;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
      const label = [anchor.innerText, anchor.getAttribute('aria-label'), anchor.title]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      const downloadAttribute = anchor.getAttribute('download')?.trim() || '';
      const looksLikeDownload = anchor.hasAttribute('download')
        || /(下载|download|导出|export)/i.test(label)
        || /(?:^|[/?&=._-])(download|export)(?:[/?&=._-]|$)/i.test(`${parsed.pathname}${parsed.search}`)
        || /\.(?:7z|csv|docx?|gz|json|od[st]|pdf|pptx?|rar|tar|txt|xlsx?|xml|zip)(?:$|[?#])/i.test(url);
      if (!looksLikeDownload) return undefined;
      let pathName = '';
      try {
        pathName = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
      } catch {
        pathName = parsed.pathname.split('/').filter(Boolean).pop() || '';
      }
      return {
        fileName: downloadAttribute || label.replace(/^(下载|download)\s*/i, '').trim() || pathName || 'download',
        url,
      };
    }, { x, y }).catch(() => undefined);
  }

  private relayLivePreviewDownload(download: { fileName: string; url: string }) {
    const id = randomUUID();
    const fileName = path.basename(download.fileName.replace(/[\\/]+/g, '_'))
      .replace(/[\u0000-\u001f<>:"|?*]+/g, '_')
      .replace(/^\.+/, '')
      .trim()
      .slice(0, 180) || 'download';
    const descriptor: BrowserLiveDownload = { fileName, id, url: download.url };
    this.notifyLivePreviewNative({ download: descriptor, kind: 'downloadStarted' });
    this.notifyLivePreviewNative({ download: descriptor, kind: 'downloadReady' });
  }

  private async applyLiveSelectValue(page: Page, x: number, y: number, value: string) {
    return page.evaluate(({ x: pageX, y: pageY, value: nextValue }) => {
      const target = document.elementFromPoint(pageX, pageY);
      const select = target instanceof HTMLSelectElement
        ? target
        : target?.closest('select');
      if (!(select instanceof HTMLSelectElement) || select.disabled || select.multiple || select.size > 1) {
        return { ok: false, actual: 'The native select is no longer available.' };
      }
      const option = Array.from(select.options).find((candidate) => candidate.value === nextValue);
      const group = option?.parentElement instanceof HTMLOptGroupElement
        ? option.parentElement
        : undefined;
      if (!option || option.disabled || group?.disabled) {
        return { ok: false, actual: 'The selected native option is unavailable.' };
      }
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      if (valueSetter) valueSetter.call(select, option.value);
      else select.value = option.value;
      select.focus({ preventScroll: true });
      select.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        ok: true,
        actual: `Selected ${option.label || option.textContent || option.value}.`,
      };
    }, { x, y, value });
  }

  private async applyLiveControlValue(
    page: Page,
    x: number,
    y: number,
    controlKind: 'datalist' | 'picker',
    value: string,
  ) {
    return page.evaluate(({ controlKind: expectedKind, value: nextValue, x: pageX, y: pageY }) => {
      const target = document.elementFromPoint(pageX, pageY);
      const input = target instanceof HTMLInputElement ? target : target?.closest('input');
      if (!(input instanceof HTMLInputElement) || input.disabled || input.readOnly) {
        return { ok: false, actual: 'The native input is no longer available.' };
      }
      const pickerTypes = new Set(['color', 'date', 'datetime-local', 'month', 'time', 'week']);
      if (expectedKind === 'picker' ? !pickerTypes.has(input.type) : !(input.list instanceof HTMLDataListElement)) {
        return { ok: false, actual: 'The native input type has changed.' };
      }
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (valueSetter) valueSetter.call(input, nextValue);
      else input.value = nextValue;
      input.focus({ preventScroll: true });
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, actual: `Updated native ${expectedKind} value.` };
    }, { controlKind, value, x, y });
  }

  private async applyLiveFiles(input: Extract<BrowserLiveInput, { kind: 'files' }>) {
    const pending = this.pendingLiveFileInputs.get(input.controlId);
    if (!pending) return { ok: false, actual: 'The file input is no longer available.' };
    this.pendingLiveFileInputs.delete(input.controlId);
    try {
      if (pending.page.isClosed()) return { ok: false, actual: 'The file input page is closed.' };
      const files = await Promise.all(input.files.map(async (file) => ({
        buffer: await readFile(file.path),
        mimeType: file.mimeType || 'application/octet-stream',
        name: path.basename(file.name || file.path),
      })));
      await pending.element.setInputFiles(files);
      return { ok: true, actual: `Uploaded ${files.length} file${files.length === 1 ? '' : 's'} to the native file input.` };
    } catch (error) {
      return { ok: false, actual: `Could not set native files: ${unknownErrorMessage(error)}` };
    } finally {
      await pending.element.dispose().catch(() => undefined);
    }
  }

  private notifyLivePreviewNative(event: BrowserLiveNativeEvent) {
    for (const listener of this.livePreviewNativeListeners) {
      try {
        listener(event);
      } catch {
        // A disconnected preview must not interfere with the controlled page.
      }
    }
  }

  private async dismissPendingLiveDialogs() {
    const pending = [...this.pendingLiveDialogs.entries()];
    this.pendingLiveDialogs.clear();
    await Promise.all(pending.map(async ([dialogId, item]) => {
      await item.dialog.dismiss().catch((error) => {
        if (!isAlreadyHandledJavaScriptDialogError(error)) {
          this.recordDomChangeError(item.page, 'dialog', `Could not dismiss JavaScript dialog: ${unknownErrorMessage(error)}`);
        }
      });
      this.notifyLivePreviewNative({ dialogId, kind: 'dialogClosed' });
    }));
  }

  private async clearPendingLiveFileInputs() {
    const pending = [...this.pendingLiveFileInputs.values()];
    this.pendingLiveFileInputs.clear();
    await Promise.all(pending.map((item) => item.element.dispose().catch(() => undefined)));
  }

  private async resolveLiveDialog(input: Extract<BrowserLiveInput, { kind: 'dialog' }>) {
    const pending = this.pendingLiveDialogs.get(input.dialogId);
    if (!pending) return { ok: false, actual: 'The browser dialog is no longer available.' };
    this.pendingLiveDialogs.delete(input.dialogId);
    try {
      if (input.accept) await pending.dialog.accept(input.promptText);
      else await pending.dialog.dismiss();
      return { ok: true, actual: `${input.accept ? 'Accepted' : 'Dismissed'} browser dialog.` };
    } catch (error) {
      if (isAlreadyHandledJavaScriptDialogError(error)) {
        return { ok: false, actual: 'The browser dialog was already handled.' };
      }
      return { ok: false, actual: `Could not handle browser dialog: ${unknownErrorMessage(error)}` };
    } finally {
      this.notifyLivePreviewNative({ dialogId: input.dialogId, kind: 'dialogClosed' });
    }
  }

  async dispatchLiveInput(input: BrowserLiveInput): Promise<BrowserActionResult> {
    return this.withSessionOperation(async () => {

    if (input.kind === 'tab') return this.switchLivePreviewTab(input.tabId);
    if (input.kind === 'files') return this.applyLiveFiles(input);
    if (input.kind === 'dialog') return this.resolveLiveDialog(input);
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
        const liveControl = button === 'left' && clickCount === 1
          ? await this.liveNativeControlAt(page, x, y)
          : undefined;
        if (liveControl) {
          invalidateObservation();
          return {
            ok: true,
            actual: `Opened native ${liveControl.kind} control at (${x}, ${y}).`,
            liveControl,
            ...(liveControl.kind === 'select' ? { liveSelect: liveControl } : {}),
          };
        }
        const downloadLink = button === 'left' && clickCount === 1
          ? await this.liveDownloadLinkAt(page, x, y)
          : undefined;
        if (downloadLink) {
          this.relayLivePreviewDownload(downloadLink);
          invalidateObservation();
          return { ok: true, actual: `Relayed download link to the user browser: ${downloadLink.url}` };
        }
        if (button === 'left') this.livePreviewDownloadGestureUntil.set(page, Date.now() + 5_000);
        const popupPromise = button === 'left'
          ? page.waitForEvent('popup', { timeout: 1500 }).catch(() => undefined)
          : Promise.resolve(undefined);
        if (button === 'left') this.livePreviewBackgroundPopupOpeners.add(page);
        const popupSelectionSequence = this.livePreviewExplicitPageSelectionSequence;
        let resolveDialogOpened: (() => void) | undefined;
        const dialogOpened = new Promise<void>((resolve) => { resolveDialogOpened = resolve; });
        const dialogWaiter = (dialogPage: Page) => {
          if (dialogPage === page) resolveDialogOpened?.();
        };
        if (button === 'left') this.liveDialogOpenedWaiters.add(dialogWaiter);
        const clickPromise = page.mouse.click(x, y, { button, clickCount });
        try {
          const outcome = button === 'left'
            ? await Promise.race([
                clickPromise.then(() => 'clicked' as const),
                dialogOpened.then(() => 'dialog' as const),
              ])
            : await clickPromise.then(() => 'clicked' as const);
          if (outcome === 'dialog') void clickPromise.catch(() => undefined);
        } finally {
          this.liveDialogOpenedWaiters.delete(dialogWaiter);
        }
        void popupPromise.then(async (popup) => {
          if (!popup) return;
          this.livePreviewBackgroundPageUntil.set(popup, Date.now() + 2_000);
          const downloadGestureUntil = this.livePreviewDownloadGestureUntil.get(page) || 0;
          if (downloadGestureUntil > Date.now()) {
            this.livePreviewDownloadGestureUntil.set(popup, downloadGestureUntil);
          }
          this.claimPage(popup, { makeActive: false });
          await this.ensurePageGroup(popup);
          if (
            popupSelectionSequence === this.livePreviewExplicitPageSelectionSequence
            && !page.isClosed()
            && this.ownedPages.has(page)
          ) {
            await page.bringToFront().catch(() => undefined);
            this.page = page;
            this.livePreviewExplicitPageSelectionAt = Date.now();
            this.notifyLivePreviewTabsChanged();
          }
          await this.refreshSessionGroupPages({ forceNativeRefresh: true });
        }).catch(() => undefined).finally(() => {
          this.livePreviewBackgroundPopupOpeners.delete(page);
        });
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

    if (input.kind === 'select') {
      if (!Number.isFinite(input.xRatio) || !Number.isFinite(input.yRatio)) {
        return { ok: false, actual: 'Live browser select requires finite relative coordinates.' };
      }
      const value = String(input.value || '');
      if (value.length > 10_000) return { ok: false, actual: 'Live browser select value is too long.' };
      const viewport = await this.getViewportMetrics();
      const x = Math.min(viewport.width - 1, Math.max(0, Math.round(clampRatio(input.xRatio) * viewport.width)));
      const y = Math.min(viewport.height - 1, Math.max(0, Math.round(clampRatio(input.yRatio) * viewport.height)));
      const result = await this.applyLiveSelectValue(page, x, y, value);
      if (result.ok) invalidateObservation();
      return result;
    }

    if (input.kind === 'controlValue') {
      if (!Number.isFinite(input.xRatio) || !Number.isFinite(input.yRatio)) {
        return { ok: false, actual: 'Live browser control requires finite relative coordinates.' };
      }
      const value = String(input.value || '');
      if (value.length > 10_000) return { ok: false, actual: 'Live browser control value is too long.' };
      const viewport = await this.getViewportMetrics();
      const x = Math.min(viewport.width - 1, Math.max(0, Math.round(clampRatio(input.xRatio) * viewport.width)));
      const y = Math.min(viewport.height - 1, Math.max(0, Math.round(clampRatio(input.yRatio) * viewport.height)));
      const result = await this.applyLiveControlValue(page, x, y, input.controlKind, value);
      if (result.ok) invalidateObservation();
      return result;
    }

    if (input.kind === 'key') {
      const key = String(input.key || '').trim();
      if (!key || key.length > 80) return { ok: false, actual: 'Live browser key is invalid.' };
      if (/^(Enter|Space)$/i.test(key)) this.livePreviewDownloadGestureUntil.set(page, Date.now() + 5_000);
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

    });
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
  private attachLivePreviewDownloadListener(page: Page) {
    this.livePreviewDownloadListeners ||= new Map<Page, (download: PlaywrightDownload) => void>();
    if (this.livePreviewDownloadListeners.has(page)) return;
    const listener = (download: PlaywrightDownload) => {
      void this.captureLivePreviewDownload(page, download);
    };
    this.livePreviewDownloadListeners.set(page, listener);
    page.on('download', listener);
  }

  private attachPageListeners(page: Page) {
    // This listener is versioned separately from the long-lived page listener set
    // so an existing controlled page also gains download relay after a dev reload.
    this.attachLivePreviewDownloadListener(page);
    this.pageListenerDisposers ||= new Map<Page, () => void>();
    if (this.attachedPages.has(page)) return;
    this.attachedPages.add(page);
    this.navigationSequenceByPage.set(page, this.navigationSequenceByPage.get(page) || 0);
    for (const frame of page.frames()) this.rememberVisitedOrigin(frame.url());
    page.setDefaultTimeout(8000);
    const onFrameNavigated = (frame: Frame) => {
      this.browserRuntimeRevisionByFrame.set(frame, (this.browserRuntimeRevisionByFrame.get(frame) || 0) + 1);
      this.rememberVisitedOrigin(frame.url());
      if (frame !== page.mainFrame()) return;
      this.domChangeErrorFingerprintsByPage.set(page, new Set());
      this.navigationSequenceByPage.set(page, (this.navigationSequenceByPage.get(page) || 0) + 1);
      this.notifyLivePreviewTabsChanged();
    };
    const onDomContentLoaded = () => {
      const frame = page.mainFrame();
      this.browserRuntimeRevisionByFrame.set(frame, (this.browserRuntimeRevisionByFrame.get(frame) || 0) + 1);
    };
    const onConsole = (message: ConsoleMessage) => {
      const text = message.text();
      if (message.type() === 'error' && !shouldIgnoreConsoleError(text)) {
        this.recordDomChangeError(page, 'console', text);
      }
    };
    const onPageError = (error: Error) => {
      const text = unknownErrorMessage(error);
      this.recordDomChangeError(page, 'page', text);
    };
    const onDialog = (dialog: Dialog) => {
      if (this.livePreviewNativeListeners.size > 0) {
        const dialogId = randomUUID();
        const rawDialogType = dialog.type();
        const dialogType: BrowserLiveDialog['dialogType'] = rawDialogType === 'beforeunload'
          || rawDialogType === 'confirm'
          || rawDialogType === 'prompt'
          ? rawDialogType
          : 'alert';
        const descriptor: BrowserLiveDialog = {
          defaultValue: dialog.defaultValue(),
          dialogType,
          id: dialogId,
          message: dialog.message(),
        };
        this.pendingLiveDialogs.set(dialogId, { descriptor, dialog, page });
        this.notifyLivePreviewNative({ dialog: descriptor, kind: 'dialogOpened' });
        for (const waiter of this.liveDialogOpenedWaiters) waiter(page);
        return;
      }
      // Playwright's automatic close path leaves a rejected promise behind when
      // another CDP client has already handled this browser dialog. Handling it
      // explicitly keeps that normal CDP race out of Next's unhandledRejection.
      void dialog.dismiss().catch((error) => {
        if (isAlreadyHandledJavaScriptDialogError(error)) return;
        const message = `Could not dismiss JavaScript dialog: ${unknownErrorMessage(error)}`;
        this.recordDomChangeError(page, 'dialog', message);
      });
    };
    this.networkDiagnostics.attach(page);
    page.on('framenavigated', onFrameNavigated);
    page.on('domcontentloaded', onDomContentLoaded);
    page.on('console', onConsole);
    page.on('pageerror', onPageError);
    page.on('dialog', onDialog);
    this.pageListenerDisposers.set(page, () => {
      page.off('framenavigated', onFrameNavigated);
      page.off('domcontentloaded', onDomContentLoaded);
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      page.off('dialog', onDialog);
      this.attachedPages.delete(page);
    });
  }

  private detachPageListeners(page: Page) {
    this.networkDiagnostics.detach(page);
    this.pageListenerDisposers ||= new Map<Page, () => void>();
    this.livePreviewDownloadListeners ||= new Map<Page, (download: PlaywrightDownload) => void>();
    this.pageListenerDisposers.get(page)?.();
    this.pageListenerDisposers.delete(page);
    const downloadListener = this.livePreviewDownloadListeners.get(page);
    if (downloadListener) page.off('download', downloadListener);
    this.livePreviewDownloadListeners.delete(page);
    const closeListener = this.pageOwnershipCloseListeners.get(page);
    if (closeListener) page.off('close', closeListener);
    this.pageOwnershipCloseListeners.delete(page);
  }

  private async captureLivePreviewDownload(page: Page, download: PlaywrightDownload) {
    const receiver = this.browserDownloads();
    if (receiver) { receiver.capture(download); return; }
    if (!this.livePreviewNativeListeners.size) return;
    let gesturePage = page;
    let gestureUntil = this.livePreviewDownloadGestureUntil.get(page) || 0;
    if (gestureUntil <= Date.now()) {
      const opener = await page.opener().catch(() => null);
      if (opener) {
        gesturePage = opener;
        gestureUntil = this.livePreviewDownloadGestureUntil.get(opener) || 0;
      }
    }
    if (gestureUntil <= Date.now()) return;
    this.livePreviewDownloadGestureUntil.delete(gesturePage);

    const id = randomUUID();
    const rawFileName = download.suggestedFilename() || `download-${Date.now()}.bin`;
    const fileName = path.basename(rawFileName.replace(/[\\/]+/g, '_'))
      .replace(/[\u0000-\u001f<>:"|?*]+/g, '_')
      .replace(/^\.+/, '')
      .trim()
      .slice(0, 180) || `download-${Date.now()}.bin`;
    const descriptor: BrowserLiveDownload = { fileName, id };
    this.notifyLivePreviewNative({ download: descriptor, kind: 'downloadStarted' });
    const url = download.url().trim();
    const protocol = (() => {
      try {
        return new URL(url).protocol;
      } catch {
        return '';
      }
    })();

    // The controlled browser runs on the WebPilot host. Letting it complete a
    // download strands the file there and can also block the live page. Cancel
    // that transfer immediately and let the user's browser request the same URL.
    void download.cancel().catch(() => undefined);
    if (protocol !== 'http:' && protocol !== 'https:') {
      this.notifyLivePreviewNative({
        download: { ...descriptor, error: 'This temporary download URL cannot be transferred to your browser.' },
        kind: 'downloadFailed',
      });
      return;
    }
    this.notifyLivePreviewNative({
      download: { ...descriptor, url },
      kind: 'downloadReady',
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







  private drainBrowserCodeDependencyFailures() { return this.networkDiagnostics.drainDependencyFailures(); }

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
  async open(url: string, options: { abortSignal?: AbortSignal; timeoutMs?: number } = {}): Promise<BrowserActionResult> {
    return this.withSessionOperation(async (signal) => {
      this.stateReader?.clear();
      options = { ...options, abortSignal: signal };

    const previousGeneration = this.snapshotGeneration;
    const page = this.activePage;
    const beforeUrl = page.url();
    const timeoutMs = options.timeoutMs ?? boundedPositiveIntegerEnv(
      'BROWSER_NAVIGATION_TIMEOUT_MS',
      30_000,
      1_000,
      5 * 60_000,
      this.runtimeEnvironment(),
    );
    options.abortSignal?.throwIfAborted();
    let navigationNote = '';
    try {
      await raceWithAbort(page.goto(url, { waitUntil: 'commit', timeout: timeoutMs }), options.abortSignal);
    } catch (error) {
      options.abortSignal?.throwIfAborted();
      const currentUrl = page.url();
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

    }, options.abortSignal);
  }

  async readBrowserState(options: BrowserStateReadOptions = {}): Promise<BrowserActionResult> {
    return this.withSessionOperation(async (signal) => {
      const reader = this.stateReader ||= new BrowserStateReader({
        page: () => this.activePage,
        revision: (page) => this.navigationSequenceByPage.get(page) || 0,
        framePath: (frame) => this.getFramePath(frame) || 'main',
        observation: () => this.readPageObservation(),
        tabs: () => this.getTabsSnapshot(),
      });
      return reader.read({ ...options, abortSignal: signal });
    }, options.abortSignal);
  }


  async readStructuredPageText() {
    return (await this.readDomObservation({ includeInteractiveCandidates: false })).structuredText;
  }

  /** Read-only link inventory across the current page and its frames. */

  private async readDomObservation(options: {
    includeInteractiveCandidates: boolean;
    maxChars?: number;
    timings?: Record<string, number>;
  }) {
    const fallbackMaxChars = numericLimitFromEnv('DOM_STRUCTURED_TEXT_MAX_CHARS', numericLimitFromEnv('DOM_PAGE_TEXT_READ_MAX_CHARS', 200000, this.runtimeEnvironment()), this.runtimeEnvironment());
    const maxChars = options.maxChars ?? fallbackMaxChars;
    const frameLimit = numericLimitFromEnv('DOM_STRUCTURED_TEXT_FRAME_LIMIT', numericLimitFromEnv('DOM_CUA_FRAME_LIMIT', Number.MAX_SAFE_INTEGER, this.runtimeEnvironment()), this.runtimeEnvironment());
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
          maxChars: numericLimitFromEnv('DOM_STRUCTURED_TEXT_MAX_CHARS', numericLimitFromEnv('DOM_PAGE_TEXT_READ_MAX_CHARS', 200000, this.runtimeEnvironment()), this.runtimeEnvironment()),
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
      `transport=${this.transportKind || 'not-started'}`,
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
    outputPixelRatio?: number;
    timeoutMs: number;
  }) {
    const outputPixelRatio = input.outputPixelRatio ?? browserOutputPixelRatioFromEnv(this.runtimeEnvironment());
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

  private async updateLastScreenshotMetrics(
    filePath: string,
    capture: ScreenshotCaptureMode,
    outputPixelRatio?: number,
  ) {
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
      outputPixelRatio: outputPixelRatio ?? browserOutputPixelRatioFromEnv(this.runtimeEnvironment()),
      capture,
      generation: ++this.screenshotGenerationSequence,
      page: this.activePage,
      url: this.activePage.url(),
      scrollX: scrollPosition.x,
      scrollY: scrollPosition.y,
      capturedAt: Date.now(),
    };
  }

  // Capture the current viewport. Candidate marker overlays are no longer captured automatically.
  async takeScreenshot(runId: string, stepIndex: number, phase: 'before' | 'after' | 'manual' | `visual-${number}` | `tool-${number}` = 'after', options: ScreenshotCaptureOptions = {}) {
    return this.withSessionOperation(async () => {

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
    const dir = this.artifactDirectory(runId);
    await timed('prepareArtifactDir', () => mkdir(dir, { recursive: true }));
    const fileName = phase === 'manual' ? `step-${stepIndex}.png` : `step-${stepIndex}-${phase}.png`;
    const filePath = path.join(dir, fileName);
    skipped('refreshInteractiveCandidates');
    skipped('refreshScrollableAreas');
    await timed('removeCandidateOverlayBefore', () => this.removeCandidateOverlay());
    const screenshotTimeoutMs = boundedPositiveIntegerEnv(
      'SCREENSHOT_TIMEOUT_MS',
      DEFAULT_SCREENSHOT_TIMEOUT_MS,
      MIN_SCREENSHOT_TIMEOUT_MS,
      MAX_SCREENSHOT_TIMEOUT_MS,
      this.runtimeEnvironment(),
    );
    // Original clean screenshots are disabled globally; keep only the primary screenshot
    // and, when configured, the separate marker map.
    skipped('captureOriginalScreenshot');
    skipped('drawInlineOverlay');
    try {
      await timed('capturePrimaryScreenshot', () => this.capturePngScreenshot({
        capture,
        filePath,
        outputPixelRatio: options.outputPixelRatio,
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
      skipped('removeInlineOverlay');
    }
    skipped('drawMarkerOverlay');
    skipped('captureMarkerScreenshot');
    skipped('removeMarkerOverlay');
    await timed('readScreenshotMetadata', () => this.updateLastScreenshotMetrics(filePath, capture, options.outputPixelRatio));
    this.lastScreenshotTiming = {
      phase: String(phase),
      capture,
      totalMs: Date.now() - totalStartedAt,
      path: filePath,
      candidateCount: 0,
      scrollAreaCount: 0,
      candidateLabelsEnabled: false,
      scrollAreaLabelsEnabled: false,
      separateMarkerMap: false,
      steps: timingSteps,
    };
    return filePath;

    });
  }

  // Minimal takeScreenshot path: save the browser screenshot without DOM, overlay, metadata, or visual-context work.
  async takeCurrentScreenshotOnly(runId: string, stepIndex: number, phase: `visual-${number}`, options: ScreenshotCaptureOptions = {}) {
    return this.withSessionOperation(async () => {

    const capture: ScreenshotCaptureMode = options.capture === 'fullPage' ? 'fullPage' : 'viewport';
    const dir = this.artifactDirectory(runId);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `step-${stepIndex}-${phase}.png`);
    const screenshotTimeoutMs = boundedPositiveIntegerEnv(
      'SCREENSHOT_TIMEOUT_MS',
      DEFAULT_SCREENSHOT_TIMEOUT_MS,
      MIN_SCREENSHOT_TIMEOUT_MS,
      MAX_SCREENSHOT_TIMEOUT_MS,
      this.runtimeEnvironment(),
    );
    await this.capturePngScreenshot({
      capture,
      filePath,
      outputPixelRatio: options.outputPixelRatio,
      timeoutMs: screenshotTimeoutMs,
    });
    await this.updateLastScreenshotMetrics(filePath, capture, options.outputPixelRatio);
    return filePath;

    });
  }


  getLastScreenshotTiming() {
    return this.lastScreenshotTiming;
  }


  // 返回最近一次操作前截图对应的纯标识图路径；仅双截图兼容模式会使用。
  // 返回当前可见交互候选元素，供语义快照与调试工具定位控件。

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


  // 返回当前活动标签页最近的 HTTP 请求，供 AI 定位接口错误、状态码异常和静态资源问题。
  private async resetInterActionChangeJournal() {
    const page = this.activePage;
    this.interActionChangeJournal = {
      id: `changes-${++this.interActionChangeJournalSequence}`,
      page,
      startedAt: new Date().toISOString(),
      requestStartSequence: this.networkDiagnostics.sequence,
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
    const frameLimit = numericLimitFromEnv('DOM_CUA_FRAME_LIMIT', Number.MAX_SAFE_INTEGER, this.runtimeEnvironment());
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
    const requests = this.networkDiagnostics.records(this.activePage)
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

  async getCurrentTabHttpRequests(options: { ids?: string[] } = {}): Promise<BrowserActionResult> { return this.networkDiagnostics.read(this.activePage, options); }

  // 切换到指定标签页，并把它设为后续操作的活动页。

  // 向当前焦点元素输入文本。
  async waitForPage(): Promise<BrowserActionResult> {
    const previousGeneration = this.snapshotGeneration;
    const loadStateTimeoutMs = boundedPositiveIntegerEnv(
      'BROWSER_WAIT_FOR_PAGE_LOAD_STATE_TIMEOUT_MS',
      DEFAULT_BROWSER_WAIT_FOR_PAGE_LOAD_STATE_TIMEOUT_MS,
      100,
      30000,
      this.runtimeEnvironment(),
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
      this.runtimeEnvironment(),
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
  private browserCodeUidReferences(): BrowserCodeUidReference[] {
    const observationId = this.domVisibleObservationId;
    if (!observationId) return [];
    return [...this.domVisibleExposedReferenceIds]
      .flatMap((uid) => {
        const reference = this.lastDomNodeReferences.get(uid);
        if (
          !reference
          || reference.observationId !== observationId
          || !reference.interactive
          || !reference.localRef
        ) return [];
        return [{
          uid,
          observationId,
          localRef: reference.localRef,
          framePath: reference.framePath,
          label: reference.label.slice(0, 300),
          descriptor: reference.descriptor.slice(0, 300),
          line: reference.line.slice(0, 1_200),
          surfaceId: reference.surfaceId,
          capabilities: reference.capabilities,
        } satisfies BrowserCodeUidReference];
      })
      .slice(0, 1_000);
  }

  async executeBrowserCode(input: {
    code: string;
    runId: string;
    stepIndex: number;
    maxOutputChars?: number;
    attachments?: BrowserCodeAttachmentBinding[];
    credentials?: BrowserCodeCredentialBinding[];
    abortSignal?: AbortSignal;
  }): Promise<BrowserActionResult> {
    return this.withSessionOperation(async (signal) => {
      this.stateReader?.clear();
      input = { ...input, abortSignal: signal };

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

    if (this.browserCodeKernel && this.browserCodeKernelRevision !== BROWSER_CODE_KERNEL_RUNTIME_REVISION) {
      await this.browserCodeKernel.close();
      this.browserCodeKernel = undefined;
    }
    const browserCodeStateSessionId = this.options.browserCodeStateSessionId
      || this.options.runId
      || this.pageGroupId;
    const runtimeState = this.options.host?.runtimeState;
    const kernel = this.browserCodeKernel ||= new BrowserCodeKernel(this.browserCodeConnection, {
      environment: this.runtimeEnvironment(),
      sessionGroupId: this.pageGroupId,
      runtimeState: runtimeState
        ? (operation) => runtimeState(browserCodeStateSessionId, operation)
        : undefined,
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
    const downloads = this.browserDownloads();
    const downloadStart = downloads?.begin(input.runId, input.abortSignal) ?? 0;
    let downloaded: BrowserDownloadResult[] = [];
    let execution: Awaited<ReturnType<BrowserCodeKernel['execute']>>;
    try {
      execution = await kernel.execute({
        code,
        attachments: input.attachments,
        credentials: input.credentials,
        executionId,
        maxOutputChars: input.maxOutputChars,
        uidReferences: this.browserCodeUidReferences(),
        abortSignal: input.abortSignal,
      });
    } finally {
      try { downloaded = await downloads?.collect(downloadStart) || []; } finally { downloads?.end(); }
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
      const dir = this.artifactDirectory(input.runId || 'browser-code');
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
    const dependencyFailures = this.drainBrowserCodeDependencyFailures();
    const reportedFailure = execution.ok
      ? browserCodeReportedFailure(execution.value)
      : undefined;
    const effectiveOk = execution.ok && !reportedFailure;
    const effectiveError = execution.error || reportedFailure;
    const payload = {
      ok: effectiveOk,
      result: execution.value ?? null,
      error: effectiveError ?? null,
      aborted: execution.aborted === true,
      elapsedMs: execution.elapsedMs,
      executionState: execution.executionState,
      downloads: downloaded,
      ...(execution.kernelReset ? {
        kernelReset: {
          ...execution.kernelReset,
          note: 'The persistent browserCode kernel was recycled to release memory. Top-level JavaScript bindings from earlier cells are no longer available.',
        },
      } : {}),
      finalPage: { url: finalUrl, title: finalTitle },
      ...(inferredActivity.verification ? { verification: inferredActivity.verification } : {}),
      ...(actualDomChanges ? { domChanges: actualDomChanges } : {}),
      images: emittedImagePaths.map((filePath) => ({ fileName: path.basename(filePath) })),
      imageErrors: emittedImageErrors,
    };
    const result: BrowserActionResult = {
      ok: effectiveOk,
      ...(!effectiveOk ? { failureCategory: reportedFailure ? 'browser-result-failed' : `browser-${execution.executionState?.status || 'code-failed'}` } : {}),
      actual: JSON.stringify(payload, null, 2),
      data: payload,
      summary: effectiveOk
        ? `browserCode completed in ${execution.elapsedMs}ms at ${finalUrl || 'the active page'}.`
        : effectiveError || 'browserCode execution failed.',
      referenceImagePath: emittedImagePaths[0],
      referenceImagePaths: emittedImagePaths,
      verification: inferredActivity.verification,
      ...(dependencyFailures.length ? { dependencyFailures } : {}),
    };
    return result;

    }, input.abortSignal);
  }

  async waitForManualVerification(maxMs?: number, abortSignal?: AbortSignal): Promise<BrowserActionResult> {
    const configuredDefault = Number(this.configuredValue('MANUAL_VERIFICATION_TIMEOUT_MS') || 180_000);
    const defaultMaxMs = Number.isFinite(configuredDefault)
      ? Math.max(1_000, Math.min(30 * 60_000, Math.floor(configuredDefault)))
      : 180_000;
    const requestedMaxMs = typeof maxMs === 'number' && Number.isFinite(maxMs)
      ? Math.max(1_000, Math.min(30 * 60_000, Math.floor(maxMs)))
      : defaultMaxMs;
    abortSignal?.throwIfAborted();
    if (this.options.host?.waitForManualVerification) {
      return raceWithAbort(this.options.host.waitForManualVerification({
        session: this,
        maxMs: requestedMaxMs,
        abortSignal,
      }), abortSignal);
    }
    const note = await this.manualVerificationNote();
    return {
      ok: true,
      actual: note
        ? '已暂停自动操作：页面需要人工完成验证。请在浏览器中完成验证码、登录/安全验证或其他需要本人确认的步骤；完成后点击对话中的“校验完成，继续执行”。'
        : '已暂停自动操作，等待您检查浏览器并完成可能需要的人工验证；完成后点击对话中的“校验完成，继续执行”。',
      manualVerification: { requested: true, maxMs: requestedMaxMs },
    };
  }

  getLifecycleState(): BrowserSessionLifecycleState {
    return this.lifecycle ||= this.isUsable() ? 'ready' : 'idle';
  }

  // 返回本次会话采集到的关键网络失败。
  getNetworkErrors() {
    return this.networkDiagnostics.errors();
  }

  // 关闭浏览器；调试场景可选择保留窗口。
  async close(options: { closePages?: boolean; force?: boolean; keepOpen?: boolean; preservePages?: boolean } = {}) {
    if (this.closePromise) return this.closePromise;
    const pendingStart = this.startPromise;
    const closeAttempt = (async () => {
      await this.sessionScheduler?.cancelAndDrain();
      await pendingStart?.catch(() => undefined);
      this.lifecycle = 'closing';
      await this.closeNow(options);
      this.lifecycle = this.isUsable() ? 'ready' : 'closed';
    })();
    this.closePromise = closeAttempt;
    try {
      await closeAttempt;
    } catch (error) {
      this.lifecycle = 'failed';
      throw error;
    } finally {
      if (this.closePromise === closeAttempt) this.closePromise = undefined;
    }
  }

  private async closeNow(options: { closePages?: boolean; force?: boolean; keepOpen?: boolean; preservePages?: boolean } = {}) {
    const shouldKeepOpen = !options.force && (
      options.keepOpen === true && this.isUsable()
    );
    let disposeLocalState = false;
    const activeScreencasts = [...(this.activeScreencasts || [])];
    this.activeScreencasts ||= new Set<BrowserScreencastHandle>();
    this.activeScreencasts.clear();
    await Promise.all(activeScreencasts.map((handle) => handle.stop().catch(() => undefined)));
    await this.downloadManager?.dispose();
    this.downloadManager = undefined;
    this.stateReader?.clear();
    await this.browserCodeKernel?.close();
    this.browserCodeKernel = undefined;
    this.browserCodeKernelRevision = undefined;
    try {
      if (this.childBrowserSessions.size) {
        const children = [...this.childBrowserSessions];
        this.childBrowserSessions.clear();
        await Promise.all(children.map((child) => child.close({ closePages: true, force: options.force }).catch(() => undefined)));
      }
      if (shouldKeepOpen && this.browserOwnership !== 'shared') return;
      if (this.context && this.contextPageListener) {
        this.context.off('page', this.contextPageListener);
        this.contextPageListener = undefined;
      }
      if (this.context && this.pageDiscoveryListener) {
        this.context.off('page', this.pageDiscoveryListener);
        this.pageDiscoveryListener = undefined;
      }
      for (const page of [...(this.pageListenerDisposers?.keys() || [])]) this.detachPageListeners(page);
      this.networkDiagnostics.dispose();
      if (this.browserOwnership === 'shared') {
        if ((this.parentBrowserSession || this.browserSurface !== 'electron-embedded') && !shouldKeepOpen && !options.preservePages) {
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
        const managedProfileBrowserClosed = options.force
          ? await closeConnectedBrowserProcess(this.browser)
          : false;
        await this.browser?.close({ reason: 'AI test run finished; disconnecting from existing browser.' }).catch(() => undefined);
        if (managedProfileBrowserClosed && this.managedProfileDir) await clearManagedBrowserProfileCaches(this.managedProfileDir, this.runtimeEnvironment());
        return;
      }
      if (this.browserOwnership === 'persistent') {
        await this.context?.close().catch(() => undefined);
        if (this.managedProfileDir) await clearManagedBrowserProfileCaches(this.managedProfileDir, this.runtimeEnvironment());
        return;
      }
      await this.browser?.close().catch(() => undefined);
      await this.browserServer?.close().catch(() => undefined);
    } finally {
      this.parentBrowserSession?.childBrowserSessions.delete(this);
      this.parentBrowserSession = undefined;
      if (!shouldKeepOpen || disposeLocalState) {
        unregisterBrowserSession(this);
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

  private async insertFocusedTextFast(text: string, timings?: Record<string, number>): Promise<boolean> {
    if (!text) return true;
    // Do the value update inside the document first.  Unlike
    // locator.pressSequentially(), this has no per-character actionability
    // wait, so a focused search box cannot spend the full default timeout
    // while an application rerenders around it.  Returning false is reserved
    // for controls that are not native text inputs/contenteditables; callers
    // can then use Playwright's keyboard path as the general fallback.
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
    await this.ensureBrowserPageRuntime();
    return this.activePage.evaluate(() => {
      const root = document.scrollingElement || document.documentElement;
      return (window as WindowWithAiDomRuntime).__aiDomRuntime!.scrollState(root);
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
        output.push({
          path,
          tag,
          role,
          name: element === root ? 'page viewport' : nameOf(element),
          text: element === root ? undefined : textOf(element),
          rect,
          center: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) },
          scroll: runtime.scrollState(element),
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


  private watchForPopup(page: Page) {
    const configuredWaitMs = this.options.popupWaitMs;
    const waitMs = typeof configuredWaitMs === 'number' && Number.isFinite(configuredWaitMs) && configuredWaitMs >= 0
      ? Math.min(3000, Math.floor(configuredWaitMs))
      : boundedNonNegativeIntegerEnv('BROWSER_POPUP_WAIT_MS', DEFAULT_BROWSER_POPUP_WAIT_MS, 3000, this.runtimeEnvironment());
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
    const fastWaitMs = Math.min(waitMs, boundedNonNegativeIntegerEnv('BROWSER_POPUP_FAST_WAIT_MS', 250, 1000, this.runtimeEnvironment()));
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
    const retentionGenerations = boundedPositiveIntegerEnv('SNAPSHOT_UID_RETENTION_GENERATIONS', 12, 2, 200, this.runtimeEnvironment());
    const maxEntries = boundedPositiveIntegerEnv('SNAPSHOT_UID_MAX_ENTRIES', 20000, 1000, 200000, this.runtimeEnvironment());
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
    const entries = await mapWithConcurrency(frameTargets, this.snapshotFrameConcurrency(), async (target) => {
      await this.ensureBrowserPageRuntime(target.frame);
      const state = await target.frame.evaluate(() => (
        (window as WindowWithAiDomRuntime).__aiDomMutationState || { epoch: 0, lastMutationAt: 0 }
      )).catch(() => ({ epoch: -1, lastMutationAt: 0 }));
      return [this.snapshotMutationKey(target), state.epoch] as const;
    });
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
    const entries = await mapWithConcurrency(frameTargets, this.snapshotFrameConcurrency(), async (target) => {
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
    });
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
      this.runtimeEnvironment(),
    );
    const timeoutMs = boundedNonNegativeIntegerEnv(
      'BROWSER_NAVIGATION_DOM_STABILITY_TIMEOUT_MS',
      DEFAULT_BROWSER_NAVIGATION_DOM_STABILITY_TIMEOUT_MS,
      5000,
      this.runtimeEnvironment(),
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
    const verificationPassed = verification.ok || observableStateChanged;
    const verificationDetail = observableStateChanged && !verification.ok
      ? `${verification.detail} A concrete DOM, active-surface, or navigation state change was observed.`
      : verification.detail;
    result.verification = {
      status: verificationPassed ? 'passed' : 'failed',
      detail: verificationDetail,
    };
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

  private async setEditableTextSelection(
    locator: Locator | undefined,
    handle: ElementHandle<Element> | undefined,
    spec: BrowserTextSelectionSpec,
  ) {
    const before = handle
      ? await handle.evaluate(readEditableText)
      : locator
        ? await locator.evaluate(readEditableText)
        : undefined;
    if (before === undefined) throw new Error('The editable target no longer resolves to a live element.');
    const selection = resolveEditableTextSelection(before, spec);
    const range = { direction: selection.direction, end: selection.end, start: selection.start };
    if (handle) await handle.evaluate(applyEditableTextSelection, range);
    else if (locator) await locator.evaluate(applyEditableTextSelection, range);
    return selection;
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
    return this.withSessionOperation(async () => {

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

    });
  }

  async searchSnapshot(input: { query?: string; tag?: string; roles?: string[]; limit?: number }): Promise<BrowserActionResult> {
    return this.withSessionOperation(async () => {

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

    });
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
    const maxAgeMs = boundedPositiveIntegerEnv('SCREENSHOT_COORDINATE_MAX_AGE_MS', 30000, 1000, 300000, this.runtimeEnvironment());
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
      xThousandth?: number;
      yThousandth?: number;
      force?: boolean;
    },
    allowNonActionable = false,
  ): Promise<ResolvedBrowserActionPoint> {
    const target = input.target;
    const hasTarget = Boolean(target);
    const hasAnyCoordinate = input.xThousandth !== undefined || input.yThousandth !== undefined;
    if (hasTarget && hasAnyCoordinate) return { error: 'Use either a snapshot-bound target or screenshot coordinates, never both.' };
    if (target) {
      return this.resolveStructuredActionTarget(target, allowNonActionable);
    }
    if (hasAnyCoordinate) return this.resolveScreenshotPoint(input.xThousandth, input.yThousandth);
    return { error: 'A snapshot-bound target or the latest screenshot x_thousandth/y_thousandth coordinates are required.' };
  }

  async mouse(input: BrowserMouseAction): Promise<BrowserActionResult> {
    return this.withSessionOperation(async () => {

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
      if (input.target || input.xThousandth !== undefined || input.yThousandth !== undefined) {
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
      if (!input.target) return { ok: false, actual: 'scrollIntoView requires a current snapshot-bound target.' };
      const resolved = await this.unifiedActionPoint({ target: input.target }, true);
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
        actual: `Target ${fromPoint.descriptor} is currently covered by ${fromPoint.coveredBy}; ${input.action} was not sent. Dismiss the top layer or inspect the current dialog first.`,
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
        actual: `Target ${fromPoint.descriptor} is currently covered by ${fromPoint.coveredBy}, so no click was sent. Inspect the active layer first. Use force=true only when the fresh page state confirms this exact click is intended to close that layer.`,
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
          actual: `Target ${from.point.descriptor} failed Playwright actionability validation and was not clicked: ${unknownErrorMessage(error)}`,
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
        actual: `Target ${from.point.descriptor} became non-actionable before Playwright could click it: ${unknownErrorMessage(error)}`,
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

    });
  }

  async selectOption(input: BrowserSelectOptionAction): Promise<BrowserActionResult> {
    return this.withSessionOperation(async () => {

    const throwIfAborted = () => {
      if (!input.abortSignal?.aborted) return;
      throw input.abortSignal.reason instanceof Error
        ? input.abortSignal.reason
        : new Error('Browser option selection was cancelled.');
    };
    throwIfAborted();
    if (!input.target) return { ok: false, actual: 'selectOption requires a fresh snapshot-bound select target.' };
    if (!String(input.value || '').trim() && !String(input.label || '').trim()) {
      return { ok: false, actual: 'selectOption requires an exact value or full label.' };
    }
    const previousGeneration = this.snapshotGeneration;
    const actionPoint = await this.unifiedActionPoint({
      target: input.target,
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

    });
  }

  async keyboard(input: BrowserKeyboardAction): Promise<BrowserActionResult> {
    return this.withSessionOperation(async () => {

    const page = this.activePage;
    const previousGeneration = this.snapshotGeneration;
    if (input.action === 'editText' && !input.target) {
      return { ok: false, actual: 'editText requires a fresh snapshot-bound editable target.' };
    }
    let targetLocator: Locator | undefined;
    let targetHandle: ElementHandle<Element> | undefined;
    const hasExplicitTarget = Boolean(input.target || input.xThousandth !== undefined || input.yThousandth !== undefined);
    if (hasExplicitTarget) {
      const target = await this.unifiedActionPoint(input, true);
      if (!target.point) return { ok: false, actual: target.error || 'Unable to resolve keyboard focus target.' };
      if (target.point.coveredBy) {
        return { ok: false, actual: `Keyboard target ${target.point.descriptor} is currently covered by ${target.point.coveredBy}. Dismiss the active layer before typing or pressing keys.` };
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
        const allowedOrigins = normalizedOriginSet(input.allowedOrigins);
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
    if (input.action === 'editText') {
      if (!input.selection) return { ok: false, actual: 'editText requires a caret or text selection.' };
      if (!input.operation) return { ok: false, actual: 'editText requires an operation.' };
      const selection = await this.setEditableTextSelection(targetLocator, targetHandle, input.selection).catch((error) => ({
        error: error instanceof Error ? error.message : String(error),
      }));
      if ('error' in selection) return { ok: false, actual: `editText could not establish the selection: ${selection.error}` };
      if (input.operation === 'setSelection') {
        return {
          ok: true,
          actual: selection.collapsed
            ? `Established an editable caret at offset ${selection.start}.`
            : `Selected editable text range ${selection.start}-${selection.end}: ${JSON.stringify(selection.selectedText)}.`,
          verification: {
            status: 'passed',
            detail: `selection=${selection.start}-${selection.end}; collapsed=${selection.collapsed}.`,
          },
        };
      }
      if (input.operation === 'insert' && !selection.collapsed) {
        return { ok: false, actual: 'editText insert requires a collapsed caret.' };
      }
      if ((input.operation === 'delete' || input.operation === 'replace') && selection.collapsed) {
        return { ok: false, actual: `editText ${input.operation} requires a non-collapsed text range.` };
      }
      if ((input.operation === 'insert' || input.operation === 'replace') && !input.text) {
        return { ok: false, actual: `editText ${input.operation} requires non-empty text.` };
      }
      const eventsBefore = await this.readInteractionCounts();
      const urlBefore = page.url();
      const navigationSequenceBefore = this.navigationSequenceByPage.get(page) || 0;
      const replacement = input.operation === 'delete' ? '' : input.text || '';
      if (input.operation === 'delete') await page.keyboard.press('Backspace');
      else await page.keyboard.insertText(replacement);
      return this.completeVerifiedAction(
        input.operation === 'insert'
          ? `Inserted ${replacement.length} characters at editable offset ${selection.start}.`
          : input.operation === 'delete'
            ? `Deleted editable text range ${selection.start}-${selection.end}.`
            : `Replaced editable text range ${selection.start}-${selection.end} with ${replacement.length} characters.`,
        previousGeneration,
        async () => {
          const eventsAfter = await this.readInteractionCounts();
          const inputEvents = this.interactionDelta(eventsBefore, eventsAfter, 'input');
          const navigated = page.url() !== urlBefore
            || (this.navigationSequenceByPage.get(page) || 0) !== navigationSequenceBefore;
          const valueAfter = navigated ? undefined : await this.editableValue(targetLocator, targetHandle);
          const expected = `${selection.before.slice(0, selection.start)}${replacement}${selection.before.slice(selection.end)}`;
          const normalizeEditableWhitespace = (value: string) => value.replace(/\u00a0/g, ' ');
          const verified = valueAfter !== undefined
            && normalizeEditableWhitespace(valueAfter) === normalizeEditableWhitespace(expected);
          return {
            ok: navigated || verified,
            detail: `${inputEvents} input event(s) observed; selection=${selection.start}-${selection.end}; operation=${input.operation}; verified=${verified}; navigation=${navigated}.`,
          };
        },
      );
    }
    if (input.action === 'type') {
      if (typeof input.text !== 'string') return { ok: false, actual: 'Keyboard type requires text.' };
      if (input.allowedOrigins?.length) {
        const allowedOrigins = normalizedOriginSet(input.allowedOrigins);
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
      const delay = boundedNonNegativeIntegerEnv('BROWSER_KEYBOARD_TYPE_DELAY_MS', 0, 200, this.runtimeEnvironment());
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
      ? numericLimitFromEnv('DOM_CUA_FULL_MAX_ELEMENTS', numericLimitFromEnv('DOM_CUA_MAX_ELEMENTS', 600, this.runtimeEnvironment()), this.runtimeEnvironment())
      : numericLimitFromEnv('DOM_CUA_MAX_ELEMENTS', 200, this.runtimeEnvironment());
    const defaultMaxChars = fullScope
      ? numericLimitFromEnv('DOM_CUA_FULL_MAX_CHARS', numericLimitFromEnv('DOM_CUA_MAX_CHARS', 60000, this.runtimeEnvironment()), this.runtimeEnvironment())
      : numericLimitFromEnv('DOM_CUA_MAX_CHARS', 20000, this.runtimeEnvironment());
    const maxElements = Math.max(1, Math.floor(Number(options.maxElements) || defaultMaxElements));
    const maxChars = Math.max(1, Math.floor(Number(options.maxChars) || defaultMaxChars));
    const addTiming = (name: string, startedAt: number) => {
      if (options.timings) options.timings[name] = (options.timings[name] || 0) + Date.now() - startedAt;
    };
    this.lastDomNodeReferences = new Map();
    const frameLimit = numericLimitFromEnv('DOM_CUA_FRAME_LIMIT', Number.MAX_SAFE_INTEGER, this.runtimeEnvironment());
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

  /**
   * Read the lightweight DOM-observation snapshot used as the baseline for
   * incremental MutationObserver updates. It intentionally avoids CDP
   * DOMSnapshot/AX collection, which is reserved for explicit semantic search
   * tools and is never run after every action.
   */
  async readDomObservationSnapshot(options: { cursor?: string; mode?: BrowserSnapshotView } = {}) {
    return this.withSessionOperation(async () => {

    const startedAt = Date.now();
    const cursor = options.cursor ? parseDomObservationCursor(options.cursor) : undefined;
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
      const page = readDomObservationPage(record, cursor.index);
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
        pageMaxChars: domObservationPageCharLimit(mode),
        pageStarts: domObservationPageStarts(changeLines, domObservationPageCharLimit(mode)),
        page: this.activePage,
        url: this.activePage.url(),
      };
      this.domObservationPagination = record;
      const page = readDomObservationPage(record, 0);
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

    const maxElements = numericLimitFromEnv('DOM_CUA_PAGED_MAX_ELEMENTS', 10000, this.runtimeEnvironment());
    const maxChars = numericLimitFromEnv('DOM_CUA_PAGED_MAX_CHARS', 1000000, this.runtimeEnvironment());
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
      pageMaxChars: domObservationPageCharLimit(mode),
      pageStarts: domObservationPageStarts(lines, domObservationPageCharLimit(mode)),
      page: this.activePage,
      url: this.activePage.url(),
    };
    this.domObservationPagination = record;
    this.bindDomReferencesToObservation(record.id);
    // Establish the returned snapshot as the delta baseline without walking
    // historical page-load mutations. A queue discard is intentionally O(1).
    await this.discardDomChanges();
    const page = readDomObservationPage(record, 0);
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

    });
  }

  /**
   * Consume only the mutations observed since the previous call. Removed nodes
   * are deleted from the authoritative UID registry before the result is
   * returned, so a later UID action cannot silently target a stale element.
   */
  async readDomChanges(): Promise<BrowserActionResult> {
    return this.withSessionOperation(async () => {

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

    const frameDeltas = await mapWithConcurrency(frames, this.snapshotFrameConcurrency(), async (frame) => {
      const framePath = frame === mainFrame ? undefined : this.getFramePath(frame);
      if (frame !== mainFrame && framePath === undefined) return undefined;
      await this.ensureBrowserPageRuntime(frame);
      const delta = await frame.evaluate(() => {
        const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime;
        return runtime?.visibleDomDelta();
      }).catch(() => undefined);
      return delta ? { delta, frame, framePath } : undefined;
    });

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

    });
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


  private async readVisibleDomSnapshot(
    target: Page | Frame,
    maxElements: number,
    maxChars: number,
    viewportClip?: BrowserUseViewportClip,
    preserveExistingRefs = false,
  ) {
    return this.readDomSnapshot(target, 'visible', {
      maxChars,
      maxElements,
      preserveExistingRefs,
      viewportClip,
    });
  }

  private async readFullDomSnapshot(
    target: Page | Frame,
    maxElements: number,
    maxChars: number,
    preserveExistingRefs = false,
  ) {
    return this.readDomSnapshot(target, 'full', { maxChars, maxElements, preserveExistingRefs });
  }

  private async readDomSnapshot(
    target: Page | Frame,
    mode: 'full' | 'visible',
    input: {
      maxChars: number;
      maxElements: number;
      preserveExistingRefs?: boolean;
      viewportClip?: BrowserUseViewportClip;
    },
  ) {
    await this.ensureBrowserPageRuntime(target);
    return target.evaluate(({ mode: snapshotMode, options }) => {
      const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime!;
      return snapshotMode === 'full'
        ? runtime?.fullDomSnapshot(options)
        : runtime?.visibleDomSnapshot(options);
    }, { mode, options: input }).catch(() => undefined);
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

    const snapshots = await mapWithConcurrency(frames.slice(0, frameLimit), this.snapshotFrameConcurrency(), async (frame): Promise<FullFrameSnapshot | undefined> => {
      const framePath = this.getFramePath(frame);
      if (framePath === undefined) return undefined;
      const snapshot = await timedBrowserStep(timings, 'readFrameFullDomSnapshotMs', () => this.readFullDomSnapshot(frame, maxElements, maxChars, preserveExistingRefs));
      if (!snapshot) return undefined;
      return {
        framePath,
        frameUrl: frame.url() || undefined,
        snapshot,
      };
    });
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

    const snapshots = await mapWithConcurrency(frames.slice(0, frameLimit), this.snapshotFrameConcurrency(), async (frame): Promise<VisibleFrameSnapshot | undefined> => {
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
    });
    return snapshots.filter((snapshot): snapshot is VisibleFrameSnapshot => Boolean(snapshot));
  }

  private async readPngSize(filePath: string) {
    const handle = await open(filePath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(24);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return this.readPngSizeFromBuffer(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
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
  return closeManagedBrowserSessions();
}
