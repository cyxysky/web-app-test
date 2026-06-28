import { Buffer } from 'node:buffer';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

export type DesktopProcessSnapshot = {
  pid: number;
  parentPid?: number;
  name: string;
  executablePath?: string;
  commandLine?: string;
  startedAt?: string;
  mainWindowTitle?: string;
  hasMainWindow: boolean;
};

export type DesktopForegroundWindowSnapshot = {
  pid?: number;
  processName?: string;
  title?: string;
};

export type DesktopSnapshot = {
  capturedAt: string;
  platform: NodeJS.Platform;
  supported: boolean;
  processes: DesktopProcessSnapshot[];
  foregroundWindow?: DesktopForegroundWindowSnapshot;
  errors?: string[];
};

export type DesktopSnapshotDiff = {
  beforeCapturedAt: string;
  afterCapturedAt: string;
  added: DesktopProcessSnapshot[];
  removed: DesktopProcessSnapshot[];
  changedWindows: DesktopProcessSnapshot[];
  foregroundChanged?: {
    before?: DesktopForegroundWindowSnapshot;
    after?: DesktopForegroundWindowSnapshot;
  };
};

export type DesktopSnapshotOptions = {
  includeCommandLine?: boolean;
  commandTimeoutMs?: number;
  maxBufferBytes?: number;
};

export type DesktopWaitForChangeOptions = DesktopSnapshotOptions & {
  timeoutMs?: number;
  intervalMs?: number;
};

type WindowsSnapshotPayload = {
  requestId?: unknown;
  foregroundWindow?: unknown;
  errors?: unknown;
};

type PendingWorkerRequest = {
  reject: (error: Error) => void;
  resolve: (payload: WindowsSnapshotPayload) => void;
  timeout: NodeJS.Timeout;
};

const DEFAULT_COMMAND_TIMEOUT_MS = 1_500;
const WORKER_EXIT_COMMAND = '__exit__';

function encodePowerShellCommand(script: string) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function powershellPath() {
  return process.env.DESKTOP_OBSERVER_POWERSHELL_PATH?.trim() || 'powershell.exe';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function asString(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeForegroundWindow(value: unknown): DesktopForegroundWindowSnapshot | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const foregroundWindow = {
    pid: asNumber(record.pid),
    processName: asString(record.processName),
    title: asString(record.title),
  };
  if (
    foregroundWindow.pid === undefined
    && !foregroundWindow.processName
    && !foregroundWindow.title
  ) {
    return undefined;
  }
  return foregroundWindow;
}

function normalizeErrors(value: unknown): string[] | undefined {
  const errors = asArray(value)
    .map((item) => asString(item))
    .filter((item): item is string => Boolean(item));
  return errors.length ? errors : undefined;
}

function sameForegroundWindow(
  before?: DesktopForegroundWindowSnapshot,
  after?: DesktopForegroundWindowSnapshot,
) {
  return before?.pid === after?.pid
    && before?.processName === after?.processName
    && before?.title === after?.title;
}

function hasDiff(diff: DesktopSnapshotDiff) {
  return diff.added.length > 0
    || diff.removed.length > 0
    || diff.changedWindows.length > 0
    || Boolean(diff.foregroundChanged);
}

function buildForegroundWindowWorkerScript() {
  return `
$ErrorActionPreference = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"
$InformationPreference = "SilentlyContinue"
$script:desktopObserverInitErrors = @()

try {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class DesktopObserverNativeWindow {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
} catch {
  $script:desktopObserverInitErrors += $_.Exception.Message
}

function Write-DesktopObserverResponse($response) {
  try {
    $json = $response | ConvertTo-Json -Depth 5 -Compress
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
  } catch {
    [Console]::Out.WriteLine('{"errors":["desktop observer response serialization failed"]}')
    [Console]::Out.Flush()
  }
}

while ($true) {
  $requestId = [Console]::In.ReadLine()
  if ($null -eq $requestId) { break }
  if ($requestId -eq "${WORKER_EXIT_COMMAND}") { break }

  $observerErrors = @($script:desktopObserverInitErrors)
  $foregroundWindow = $null

  try {
    $handle = [DesktopObserverNativeWindow]::GetForegroundWindow()
    if ($handle -ne [IntPtr]::Zero) {
      $titleBuilder = New-Object System.Text.StringBuilder 512
      [void][DesktopObserverNativeWindow]::GetWindowText($handle, $titleBuilder, $titleBuilder.Capacity)
      [uint32]$foregroundPid = 0
      [void][DesktopObserverNativeWindow]::GetWindowThreadProcessId($handle, [ref]$foregroundPid)
      $foregroundProcess = if ($foregroundPid -gt 0) { Get-Process -Id $foregroundPid -ErrorAction SilentlyContinue } else { $null }
      $foregroundWindow = [pscustomobject]@{
        pid = if ($foregroundPid -gt 0) { [int]$foregroundPid } else { $null }
        processName = if ($foregroundProcess) { [string]$foregroundProcess.ProcessName } else { $null }
        title = [string]$titleBuilder.ToString()
      }
    }
  } catch {
    $observerErrors += $_.Exception.Message
  }

  Write-DesktopObserverResponse([pscustomobject]@{
    requestId = $requestId
    foregroundWindow = $foregroundWindow
    errors = @($observerErrors)
  })
}
`;
}

class ForegroundWindowPowerShellWorker {
  private nextRequestId = 1;
  private pending = new Map<string, PendingWorkerRequest>();
  private process?: ChildProcessWithoutNullStreams;
  private stdoutLines?: Interface;
  private stderrTail = '';

  async snapshot(timeoutMs: number): Promise<WindowsSnapshotPayload> {
    const child = this.ensureStarted();
    const requestId = String(this.nextRequestId++);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        this.restart();
        reject(new Error(`Desktop foreground window observer timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });
      child.stdin.write(`${requestId}\n`, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  private ensureStarted() {
    if (this.process && !this.process.killed && this.process.exitCode === null) return this.process;

    this.stderrTail = '';
    const child = spawn(
      powershellPath(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodePowerShellCommand(buildForegroundWindowWorkerScript()),
      ],
      {
        windowsHide: true,
        stdio: 'pipe',
      },
    );
    this.process = child;
    this.stdoutLines = createInterface({ input: child.stdout });
    this.stdoutLines.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-4000);
    });
    child.once('error', (error) => this.failAll(error instanceof Error ? error : new Error(String(error))));
    child.once('exit', (code, signal) => {
      const suffix = this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : '';
      this.failAll(new Error(`Desktop foreground window observer exited (${signal || (code ?? 'unknown')})${suffix}`));
      this.process = undefined;
      this.stdoutLines?.close();
      this.stdoutLines = undefined;
    });
    return child;
  }

  private handleLine(line: string) {
    let payload: WindowsSnapshotPayload;
    try {
      payload = JSON.parse(line) as WindowsSnapshotPayload;
    } catch {
      return;
    }
    const requestId = asString(payload.requestId);
    if (!requestId) return;
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve(payload);
  }

  private failAll(error: Error) {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }

  private restart() {
    const child = this.process;
    this.process = undefined;
    this.stdoutLines?.close();
    this.stdoutLines = undefined;
    try {
      child?.stdin.write(`${WORKER_EXIT_COMMAND}\n`);
      child?.kill();
    } catch {
      // Ignore worker cleanup failures; the next request will start a fresh worker.
    }
  }
}

const foregroundWindowWorker = new ForegroundWindowPowerShellWorker();

export class DesktopObserver {
  async snapshot(options: DesktopSnapshotOptions = {}): Promise<DesktopSnapshot> {
    if (process.platform !== 'win32') {
      return {
        capturedAt: new Date().toISOString(),
        platform: process.platform,
        supported: false,
        processes: [],
        errors: [`DesktopObserver only supports Windows right now. Current platform: ${process.platform}.`],
      };
    }

    const payload = await foregroundWindowWorker.snapshot(options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
    const errors = normalizeErrors(payload.errors);
    return {
      capturedAt: new Date().toISOString(),
      platform: process.platform,
      supported: true,
      processes: [],
      foregroundWindow: normalizeForegroundWindow(payload.foregroundWindow),
      errors: errors?.length ? errors : undefined,
    };
  }

  diffSnapshots(before: DesktopSnapshot, after: DesktopSnapshot): DesktopSnapshotDiff {
    return {
      beforeCapturedAt: before.capturedAt,
      afterCapturedAt: after.capturedAt,
      added: [],
      removed: [],
      changedWindows: [],
      foregroundChanged: sameForegroundWindow(before.foregroundWindow, after.foregroundWindow)
        ? undefined
        : {
            before: before.foregroundWindow,
            after: after.foregroundWindow,
          },
    };
  }

  async waitForChange(
    before: DesktopSnapshot,
    options: DesktopWaitForChangeOptions = {},
  ): Promise<{ snapshot: DesktopSnapshot; diff: DesktopSnapshotDiff; changed: boolean }> {
    const timeoutMs = Math.max(0, options.timeoutMs ?? 5_000);
    const intervalMs = Math.max(100, options.intervalMs ?? 400);
    if (timeoutMs <= 0) {
      const snapshot = await this.snapshot(options);
      const diff = this.diffSnapshots(before, snapshot);
      return { snapshot, diff, changed: hasDiff(diff) };
    }

    const startedAt = Date.now();

    while (Date.now() - startedAt <= timeoutMs) {
      const snapshot = await this.snapshot(options);
      const diff = this.diffSnapshots(before, snapshot);
      if (hasDiff(diff)) return { snapshot, diff, changed: true };
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    const snapshot = await this.snapshot(options);
    const diff = this.diffSnapshots(before, snapshot);
    return { snapshot, diff, changed: hasDiff(diff) };
  }
}

export const desktopObserver = new DesktopObserver();
