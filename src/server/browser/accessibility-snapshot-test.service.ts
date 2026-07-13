import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { artifactApiUrlFromRelative } from '@/lib/artifacts';
import {
  BrowserSession,
  type AccessibilitySnapshotExportControlResult,
} from '@/server/browser/browser-session';
import { artifactPath, artifactsRoot } from '@/server/storage/paths';

const DOM_EXPORT_CHUNK_CHARS = 20000;
const DOM_EXPORT_MAX_CHUNKS = 10000;

type SnapshotExportView = 'actionable' | 'full' | 'text';

type DomExportChunk = {
  index: number;
  cursorIndex: number;
  nextCursorIndex: number;
  charLength: number;
  content: string;
};

type DomExportViewResult = {
  type: SnapshotExportView;
  generationId: string;
  chunkCount: number;
  totalChars: number;
  content: string;
  chunks: DomExportChunk[];
};

export type AccessibilitySnapshotTestExport = AccessibilitySnapshotExportControlResult & {
  url?: string;
  bytes?: number;
  createdAt?: string;
};

type AccessibilitySnapshotTestState = {
  session?: BrowserSession;
  startPromise?: Promise<AccessibilitySnapshotTestStatus>;
  capturePromise?: Promise<AccessibilitySnapshotTestExport>;
  appOrigin?: string;
  lastExport?: AccessibilitySnapshotTestExport;
};

export type AccessibilitySnapshotTestStatus = {
  ok: boolean;
  running: boolean;
  currentUrl?: string;
  lastExport?: AccessibilitySnapshotTestExport;
  error?: string;
};

const globalState = globalThis as typeof globalThis & {
  __webPilotAccessibilitySnapshotTestState?: AccessibilitySnapshotTestState;
};

const state = globalState.__webPilotAccessibilitySnapshotTestState ||= {};

async function collectView(session: BrowserSession, view: SnapshotExportView, refresh = false): Promise<DomExportViewResult> {
  const chunks: DomExportChunk[] = [];
  let cursorIndex = 0;
  let totalChars = 0;
  let generationId = '';

  for (let chunkIndex = 0; chunkIndex < DOM_EXPORT_MAX_CHUNKS; chunkIndex += 1) {
    const slice = await session.readSnapshotSlice({
      cursorIndex,
      maxChars: DOM_EXPORT_CHUNK_CHARS,
      refresh: refresh && chunkIndex === 0,
      mode: view,
    });
    generationId ||= slice.generationId;
    if (slice.generationId !== generationId) throw new Error('Snapshot generation changed during export.');
    const content = slice.content;
    if (content.length > DOM_EXPORT_CHUNK_CHARS) {
      throw new Error(`${view} snapshot chunk ${chunkIndex + 1} exceeded ${DOM_EXPORT_CHUNK_CHARS} characters: ${content.length}`);
    }
    totalChars += content.length;
    chunks.push({
      index: chunks.length + 1,
      cursorIndex,
      nextCursorIndex: slice.nextIndex,
      charLength: content.length,
      content,
    });
    if (!slice.hasMore) {
      return {
        type: view,
        generationId,
        chunkCount: chunks.length,
        totalChars,
        content: chunks.map((chunk) => chunk.content).join('\n'),
        chunks,
      };
    }
    if (slice.nextIndex <= cursorIndex) {
      throw new Error(`${view} snapshot cursor did not advance: ${cursorIndex} -> ${slice.nextIndex}`);
    }
    cursorIndex = slice.nextIndex;
  }

  throw new Error(`${view} snapshot export exceeded ${DOM_EXPORT_MAX_CHUNKS} chunks.`);
}

function exportFileName() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `accessibility-snapshot-${timestamp}-${randomUUID().slice(0, 8)}.json`;
}

export async function exportAccessibilitySnapshotJson(session: BrowserSession): Promise<AccessibilitySnapshotTestExport> {
  const createdAt = new Date().toISOString();
  const title = await session.currentTitle();
  const actionable = await collectView(session, 'actionable', true);
  const full = await collectView(session, 'full');
  const text = await collectView(session, 'text');
  const payload = {
    version: 4,
    format: 'chromium-dom-snapshot-with-partial-ax',
    createdAt,
    url: session.currentUrl(),
    title,
    generationId: actionable.generationId,
    chunkChars: DOM_EXPORT_CHUNK_CHARS,
    views: { actionable, full, text },
  };
  const content = `${JSON.stringify(payload)}\n`;
  const dir = artifactPath('accessibility-snapshot-test', 'exports');
  const fileName = exportFileName();
  const filePath = path.join(dir, fileName);
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, content, 'utf8');
  const relative = path.relative(artifactsRoot(), filePath).replace(/\\/g, '/');
  const url = artifactApiUrlFromRelative(relative);
  const downloadUrl = state.appOrigin
    ? new URL(`${url}?download=1`, state.appOrigin).toString()
    : `${url}?download=1`;
  return {
    ok: true,
    fileName,
    path: filePath,
    url,
    downloadUrl,
    bytes: Buffer.byteLength(content, 'utf8'),
    createdAt,
  };
}

async function exportFromControl(session: BrowserSession) {
  if (state.capturePromise) return state.capturePromise;
  state.capturePromise = exportAccessibilitySnapshotJson(session)
    .then((result) => {
      state.lastExport = result;
      return result;
    })
    .catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }))
    .finally(() => {
      state.capturePromise = undefined;
    });
  return state.capturePromise;
}

function normalizedOrigin(value?: string) {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

export function accessibilitySnapshotTestStatus(): AccessibilitySnapshotTestStatus {
  const running = Boolean(state.session?.isUsable());
  return {
    ok: true,
    running,
    currentUrl: running ? state.session?.currentUrl() : undefined,
    lastExport: state.lastExport,
  };
}

export async function openAccessibilitySnapshotTestBrowser(appOrigin?: string): Promise<AccessibilitySnapshotTestStatus> {
  state.appOrigin = normalizedOrigin(appOrigin) || state.appOrigin;
  if (state.session?.isUsable()) {
    await state.session.installAccessibilitySnapshotExportControl(() => exportFromControl(state.session!));
    await state.session.bringToFront();
    return accessibilitySnapshotTestStatus();
  }
  if (state.startPromise) return state.startPromise;

  state.startPromise = (async () => {
    await state.session?.close().catch(() => undefined);
    const session = new BrowserSession('dom', {
      headless: false,
      isolated: true,
      runId: 'dom-observation-test',
    });
    state.session = session;
    try {
      await session.start();
      await session.installAccessibilitySnapshotExportControl(() => exportFromControl(session));
      await session.bringToFront();
      return accessibilitySnapshotTestStatus();
    } catch (error) {
      await session.close().catch(() => undefined);
      if (state.session === session) state.session = undefined;
      return {
        ok: false,
        running: false,
        error: error instanceof Error ? error.message : String(error),
        lastExport: state.lastExport,
      };
    }
  })().finally(() => {
    state.startPromise = undefined;
  });
  return state.startPromise;
}
