import type { BrowserActionResult } from '@/server/browser/browser-session';
import type {
  DesktopActionEvidence,
  DesktopEvidenceProcess,
  DesktopEvidenceWindow,
} from '@/server/ai/schemas/test-case.schema';
import {
  desktopObserver,
  type DesktopForegroundWindowSnapshot,
  type DesktopProcessSnapshot,
  type DesktopSnapshot,
} from '@/server/desktop/desktop-observer';

const OBSERVED_TOOL_NAMES = new Set([
  'openPage',
  'clickCandidate',
  'clickDomNode',
  'clickLocator',
  'doubleClickCandidate',
  'doubleClickDomNode',
  'rightClickCandidate',
  'dragCandidate',
  'dragDomNode',
  'hoverDomNode',
  'pressKey',
  'typeText',
  'fillCandidates',
  'fillDomNodes',
]);

const MAX_EVIDENCE_ITEMS = 5;
const DEFAULT_WAIT_MS = 1_200;
const DEFAULT_INTERVAL_MS = 300;
const DEFAULT_COMMAND_TIMEOUT_MS = 6_000;
const NOISE_PROCESS_NAMES = new Set([
  'powershell.exe',
  'pwsh.exe',
  'conhost.exe',
  'wmiprvse.exe',
  'wsmprovhost.exe',
  'chrome.exe',
  'chromium.exe',
  'msedge.exe',
  'node.exe',
  'electron.exe',
]);

function numericEnv(name: string, fallback: number) {
  const parsed = Number(process.env[name] || '');
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function desktopEvidenceEnabled() {
  const raw = process.env.DESKTOP_OBSERVER_ENABLED || process.env.AI_DESKTOP_OBSERVER_ENABLED;
  return raw !== 'false' && raw !== '0' && process.platform === 'win32';
}

export function shouldObserveDesktopForTool(name: string) {
  return desktopEvidenceEnabled() && OBSERVED_TOOL_NAMES.has(name);
}

export async function captureDesktopBeforeTool(name: string) {
  if (!shouldObserveDesktopForTool(name)) return undefined;
  try {
    return await desktopObserver.snapshot({
      includeCommandLine: false,
      commandTimeoutMs: numericEnv('DESKTOP_OBSERVER_COMMAND_TIMEOUT_MS', DEFAULT_COMMAND_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
}

function compactProcess(process: DesktopProcessSnapshot): DesktopEvidenceProcess {
  return {
    pid: process.pid,
    parentPid: process.parentPid,
    name: process.name,
    executablePath: process.executablePath,
    startedAt: process.startedAt,
    mainWindowTitle: process.mainWindowTitle,
    hasMainWindow: process.hasMainWindow,
  };
}

function isNoiseProcess(process: DesktopProcessSnapshot | DesktopEvidenceProcess) {
  return NOISE_PROCESS_NAMES.has(process.name.toLowerCase());
}

function isNoiseWindow(window?: DesktopForegroundWindowSnapshot) {
  if (!window?.processName) return false;
  const name = window.processName.toLowerCase();
  return NOISE_PROCESS_NAMES.has(name.endsWith('.exe') ? name : `${name}.exe`);
}

function compactWindow(window?: DesktopForegroundWindowSnapshot): DesktopEvidenceWindow | undefined {
  if (!window) return undefined;
  return {
    pid: window.pid,
    processName: window.processName,
    title: window.title,
  };
}

function processLabel(process: DesktopEvidenceProcess) {
  const title = process.mainWindowTitle ? ` title="${process.mainWindowTitle}"` : '';
  return `${process.name} pid=${process.pid}${title}`;
}

function windowLabel(window?: DesktopEvidenceWindow) {
  if (!window) return 'none';
  return [
    window.processName || (window.pid !== undefined ? `pid=${window.pid}` : 'unknown process'),
    window.title ? `title="${window.title}"` : '',
  ].filter(Boolean).join(' ');
}

function evidenceSummary(evidence: Omit<DesktopActionEvidence, 'summary'>) {
  const parts: string[] = [];
  const added = evidence.addedProcesses || [];
  const changedWindows = evidence.changedWindows || [];

  if (added.length) {
    parts.push(`new process: ${added.slice(0, 3).map(processLabel).join('; ')}`);
  }
  if (changedWindows.length) {
    parts.push(`window changed: ${changedWindows.slice(0, 3).map(processLabel).join('; ')}`);
  }
  if (evidence.foregroundChanged) {
    parts.push(`foreground changed from ${windowLabel(evidence.foregroundChanged.before)} to ${windowLabel(evidence.foregroundChanged.after)}`);
  }
  if (!parts.length && evidence.errors?.length) {
    parts.push(`desktop observation warning: ${evidence.errors[0]}`);
  }
  return parts.join('. ') || 'desktop state changed';
}

export async function collectDesktopEvidenceAfterTool(
  name: string,
  before: DesktopSnapshot | undefined,
): Promise<DesktopActionEvidence | undefined> {
  if (!before || !shouldObserveDesktopForTool(name)) return undefined;

  try {
    const { snapshot, diff } = await desktopObserver.waitForChange(before, {
      includeCommandLine: false,
      timeoutMs: numericEnv('DESKTOP_OBSERVER_WAIT_MS', DEFAULT_WAIT_MS),
      intervalMs: numericEnv('DESKTOP_OBSERVER_INTERVAL_MS', DEFAULT_INTERVAL_MS),
      commandTimeoutMs: numericEnv('DESKTOP_OBSERVER_COMMAND_TIMEOUT_MS', DEFAULT_COMMAND_TIMEOUT_MS),
    });
    const added = diff.added.filter((process) => !isNoiseProcess(process));
    const removed = diff.removed.filter((process) => !isNoiseProcess(process));
    const changedWindows = diff.changedWindows.filter((process) => !isNoiseProcess(process));
    const foregroundChanged = diff.foregroundChanged
      && !isNoiseWindow(diff.foregroundChanged.after)
      ? diff.foregroundChanged
      : undefined;
    const changed = added.length > 0 || changedWindows.length > 0 || Boolean(foregroundChanged);
    const errors = [
      ...(before.errors || []),
      ...(snapshot.errors || []),
    ].slice(0, MAX_EVIDENCE_ITEMS);
    const evidenceWithoutSummary: Omit<DesktopActionEvidence, 'summary'> = {
      observed: true,
      changed,
      capturedAt: {
        before: before.capturedAt,
        after: snapshot.capturedAt,
      },
      addedProcesses: added.slice(0, MAX_EVIDENCE_ITEMS).map(compactProcess),
      removedProcesses: removed.slice(0, MAX_EVIDENCE_ITEMS).map(compactProcess),
      changedWindows: changedWindows.slice(0, MAX_EVIDENCE_ITEMS).map(compactProcess),
      foregroundChanged: foregroundChanged
        ? {
            before: compactWindow(foregroundChanged.before),
            after: compactWindow(foregroundChanged.after),
          }
        : undefined,
      errors: errors.length ? errors : undefined,
    };
    const evidence: DesktopActionEvidence = {
      ...evidenceWithoutSummary,
      summary: evidenceSummary(evidenceWithoutSummary),
    };
    if (!evidence.changed && !evidence.errors?.length) return undefined;
    return evidence;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      observed: true,
      changed: false,
      summary: `desktop observation failed: ${message}`,
      capturedAt: {
        before: before.capturedAt,
        after: new Date().toISOString(),
      },
      errors: [message],
    };
  }
}

export function appendDesktopEvidenceToResult(
  result: BrowserActionResult,
  evidence?: DesktopActionEvidence,
): BrowserActionResult {
  if (!evidence?.changed) return result;
  return {
    ...result,
    actual: `${result.actual}\nDesktop evidence: ${evidence.summary}`,
  };
}
