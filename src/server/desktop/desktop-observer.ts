import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
  processes?: unknown;
  foregroundWindow?: unknown;
  errors?: unknown;
};

const DEFAULT_COMMAND_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

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

function asBoolean(value: unknown) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return /^(true|1|yes)$/i.test(value.trim());
  return false;
}

function normalizeProcess(value: unknown): DesktopProcessSnapshot | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const pid = asNumber(record.pid);
  const name = asString(record.name);
  if (pid === undefined || !name) return undefined;

  return {
    pid,
    parentPid: asNumber(record.parentPid),
    name,
    executablePath: asString(record.executablePath),
    commandLine: asString(record.commandLine),
    startedAt: asString(record.startedAt),
    mainWindowTitle: asString(record.mainWindowTitle),
    hasMainWindow: asBoolean(record.hasMainWindow),
  };
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

function buildWindowsSnapshotScript(includeCommandLine: boolean) {
  return `
$ErrorActionPreference = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"
$InformationPreference = "SilentlyContinue"
$observerErrors = @()
$includeCommandLine = ${includeCommandLine ? '$true' : '$false'}

$processById = @{}
Get-Process | ForEach-Object {
  $processById[[int]$_.Id] = $_
}

$processes = Get-CimInstance Win32_Process | ForEach-Object {
  $pidValue = [int]$_.ProcessId
  $process = $processById[$pidValue]
  $parentPid = $null
  if ($_.ParentProcessId -ne $null) {
    $parentPid = [int]$_.ParentProcessId
  }
  $executablePath = ""
  try { $executablePath = [string]$_.ExecutablePath } catch { $executablePath = "" }
  $commandLine = $null
  if ($includeCommandLine) {
    try { $commandLine = [string]$_.CommandLine } catch { $commandLine = $null }
  }
  $startedAt = $null
  if ($_.CreationDate) {
    try { $startedAt = ([datetime]$_.CreationDate).ToUniversalTime().ToString("o") } catch { $startedAt = $null }
  }
  $mainWindowTitle = ""
  $hasMainWindow = $false
  if ($process) {
    $mainWindowTitle = [string]$process.MainWindowTitle
    $hasMainWindow = [bool]($process.MainWindowHandle -ne 0)
  }

  [pscustomobject]@{
    pid = $pidValue
    parentPid = $parentPid
    name = [string]$_.Name
    executablePath = $executablePath
    commandLine = $commandLine
    startedAt = $startedAt
    mainWindowTitle = $mainWindowTitle
    hasMainWindow = $hasMainWindow
  }
}

$foregroundWindow = $null
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

[pscustomobject]@{
  processes = @($processes)
  foregroundWindow = $foregroundWindow
  errors = @($observerErrors)
} | ConvertTo-Json -Depth 5 -Compress
`;
}

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

    const script = buildWindowsSnapshotScript(Boolean(options.includeCommandLine));
    const { stdout, stderr } = await execFileAsync(
      powershellPath(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodePowerShellCommand(script),
      ],
      {
        timeout: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        maxBuffer: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
        windowsHide: true,
      },
    );

    const payload = JSON.parse(stdout) as WindowsSnapshotPayload;
    const processes = asArray(payload.processes)
      .map((item) => normalizeProcess(item))
      .filter((item): item is DesktopProcessSnapshot => Boolean(item));
    const errors = [
      ...(normalizeErrors(payload.errors) || []),
      ...(stderr.trim() ? [stderr.trim()] : []),
    ];

    return {
      capturedAt: new Date().toISOString(),
      platform: process.platform,
      supported: true,
      processes,
      foregroundWindow: normalizeForegroundWindow(payload.foregroundWindow),
      errors: errors.length ? errors : undefined,
    };
  }

  diffSnapshots(before: DesktopSnapshot, after: DesktopSnapshot): DesktopSnapshotDiff {
    const beforeByPid = new Map(before.processes.map((item) => [item.pid, item]));
    const afterByPid = new Map(after.processes.map((item) => [item.pid, item]));

    const added = after.processes.filter((item) => !beforeByPid.has(item.pid));
    const removed = before.processes.filter((item) => !afterByPid.has(item.pid));
    const changedWindows = after.processes.filter((item) => {
      const previous = beforeByPid.get(item.pid);
      return previous
        && (
          previous.hasMainWindow !== item.hasMainWindow
          || previous.mainWindowTitle !== item.mainWindowTitle
        );
    });

    return {
      beforeCapturedAt: before.capturedAt,
      afterCapturedAt: after.capturedAt,
      added,
      removed,
      changedWindows,
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
