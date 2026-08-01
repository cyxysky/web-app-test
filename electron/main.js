const { app, BrowserWindow, Menu, WebContentsView, dialog, ipcMain, nativeTheme, session: electronSession, shell } = require('electron');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const APP_NAME = 'WebPilot';
const APP_TITLE = APP_NAME;
const DEFAULT_PORT = 17890;
const EMBEDDED_BROWSER_CDP_PORT = Number(process.env.WEBPILOT_ELECTRON_CDP_PORT || process.env.ELECTRON_EMBEDDED_BROWSER_CDP_PORT || 19333);

app.setName(APP_NAME);
app.commandLine.appendSwitch('remote-debugging-port', String(EMBEDDED_BROWSER_CDP_PORT));

let serverProcess;
let localServerUrl = '';
const serverShutdownToken = randomUUID();
let applicationShutdownStarted = false;
let applicationShutdownReady = false;
let electronResourcesDestroyed = false;
let mainWindow;
let embeddedBrowserView;
let embeddedBrowserAttached = false;
let embeddedBrowserVisible = false;
let embeddedBrowserLibraryView;
let embeddedBrowserLibraryPanel = '';
let embeddedBrowserLibraryAttached = false;
let embeddedBrowserLibraryVisible = false;
let embeddedBrowserActiveGroupId = '';
let embeddedBrowserActiveTabId = '';
let embeddedBrowserNextTabId = 1;
const embeddedBrowserGroups = new Map();
const embeddedBrowserTabs = new Map();
const embeddedBrowserBookmarks = new Map();
let embeddedBrowserHistory = [];
let embeddedBrowserNextBookmarkId = 1;
let embeddedBrowserNextHistoryId = 1;
const embeddedBrowserRecentlyClosedTabs = [];
let embeddedBrowserBounds = { x: 0, y: 0, width: 0, height: 0 };
let runtimeDatabasePath = '';
let electronStateDatabase;
let embeddedBrowserPersistenceTimer;
let embeddedBrowserPersistenceStopped = false;
let embeddedBrowserPersistenceRestoring = false;
let embeddedBrowserStateChangeTimer;
const htmlFullscreenWebContentsIds = new Set();
let htmlFullscreenWindowState;
const EMBEDDED_BROWSER_ROUTE_LOADING_MS = 1200;
const EMBEDDED_BROWSER_PERSISTENCE_VERSION = 2;
const EMBEDDED_BROWSER_STATE_KEY = 'embedded-browser';
const DOWNLOAD_SETTINGS_STATE_KEY = 'download-settings';
const RUNTIME_DATABASE_FILE = 'webpilot.db';
const EMBEDDED_BROWSER_HISTORY_LIMIT = 300;
let startupLogPath;
let startupScreenReady = Promise.resolve();
let recentServerOutput = [];
let lastDownloadDirectory = '';
let nextDownloadId = 1;
const systemDownloads = new Map();
const nativeDownloadItems = new Map();
const nativeDownloadSessions = new WeakSet();

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getElectronStateDatabase() {
  if (electronStateDatabase) return electronStateDatabase;
  if (!runtimeDatabasePath) throw new Error('Runtime database path is not ready.');
  ensureDir(path.dirname(runtimeDatabasePath));
  electronStateDatabase = new DatabaseSync(runtimeDatabasePath, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
  });
  electronStateDatabase.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS electron_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return electronStateDatabase;
}

function appendLog(message) {
  if (!startupLogPath) return;
  try {
    fs.appendFileSync(startupLogPath, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // Logging must not block app startup.
  }
}

function rememberServerOutput(prefix, chunk) {
  const text = String(chunk || '').trim();
  if (!text) return;
  for (const line of text.split(/\r?\n/)) {
    const entry = `${prefix}: ${line}`;
    recentServerOutput.push(entry);
    if (recentServerOutput.length > 30) recentServerOutput = recentServerOutput.slice(-30);
    appendLog(entry);
  }
}

function findAvailablePort(startPort) {
  return new Promise((resolve) => {
    function tryPort(port) {
      const server = net.createServer();
      server.once('error', () => tryPort(port + 1));
      server.once('listening', () => {
        server.close(() => resolve(port));
      });
      server.listen(port, '127.0.0.1');
    }
    tryPort(startPort);
  });
}

function waitForHttp(url, timeoutMs = 60_000, stableChecks = 2) {
  const startedAt = Date.now();
  let okCount = 0;
  return new Promise((resolve, reject) => {
    function check() {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 400) {
          okCount += 1;
          if (okCount >= stableChecks) {
            resolve();
            return;
          }
        } else {
          okCount = 0;
        }
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}; last status=${response.statusCode || 'unknown'}`));
          return;
        }
        setTimeout(check, 350);
      });
      request.on('error', () => {
        okCount = 0;
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(check, 350);
      });
      request.setTimeout(1500, () => request.destroy());
    }
    check();
  });
}

function serverDirectory() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'server');
  return process.cwd();
}

function appIconPath() {
  const fileName = process.platform === 'win32' ? 'app-icon.ico' : 'app-icon.png';
  if (app.isPackaged) return path.join(process.resourcesPath, fileName);
  return path.join(process.cwd(), 'assets', fileName);
}

function appPngIconPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'app-icon.png');
  return path.join(process.cwd(), 'assets', 'app-icon.png');
}

function preloadPath() {
  return path.join(__dirname, 'preload.js');
}

function embeddedBrowserPreloadPath() {
  return path.join(__dirname, 'embedded-browser-preload.js');
}

function embeddedBrowserLibraryPreloadPath() {
  return path.join(__dirname, 'embedded-browser-library-preload.js');
}

function embeddedBrowserUserAgent() {
  const configured = String(process.env.ELECTRON_EMBEDDED_BROWSER_USER_AGENT || '').trim();
  if (configured) return configured;
  const chromeVersion = process.versions.chrome || '148.0.0.0';
  if (process.platform === 'darwin') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  }
  if (process.platform === 'linux') {
    return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  }
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

function packagedChromiumExecutable() {
  if (!app.isPackaged) return '';
  const browserRoot = path.join(process.resourcesPath, 'ms-playwright');
  try {
    const chromiumDir = fs.readdirSync(browserRoot)
      .find((name) => /^chromium-\d+$/.test(name));
    if (!chromiumDir) return '';
    for (const executablePath of [
      path.join(browserRoot, chromiumDir, 'chrome-win64', 'chrome.exe'),
      path.join(browserRoot, chromiumDir, 'chrome-win', 'chrome.exe'),
    ]) {
      if (fs.existsSync(executablePath)) return executablePath;
    }
    return '';
  } catch {
    return '';
  }
}

function embeddedBrowserPlaceholderUrl() {
  const html = [
    '<!doctype html>',
    '<html data-webpilot-embedded-browser="true">',
    '<head><meta charset="utf-8"><title>新建标签页</title></head>',
    '<body style="margin:0;font:14px system-ui;background:#f8fafc;color:#334155;display:grid;place-items:center;height:100vh">',
    '<div>新建标签页</div>',
    '</body>',
    '</html>',
  ].join('');
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function embeddedBrowserLibraryRouteUrl() {
  if (!mainWindow || mainWindow.isDestroyed()) return '';
  try {
    const current = new URL(mainWindow.webContents.getURL());
    if (!['http:', 'https:'].includes(current.protocol)) return '';
    return new URL('/embedded-browser-library', current.origin).toString();
  } catch {
    return '';
  }
}

function embeddedBrowserLibraryViewBounds() {
  return sanitizeEmbeddedBounds(embeddedBrowserBounds);
}

function ensureEmbeddedBrowserLibraryView() {
  if (embeddedBrowserLibraryView && !embeddedBrowserLibraryView.webContents.isDestroyed()) {
    return embeddedBrowserLibraryView;
  }
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Main window is not ready.');
  if (!WebContentsView) throw new Error('Electron WebContentsView is not available.');
  const routeUrl = embeddedBrowserLibraryRouteUrl();
  if (!routeUrl) throw new Error('Embedded browser library route is not ready.');

  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: embeddedBrowserLibraryPreloadPath(),
      sandbox: false,
    },
  });
  view.setBackgroundColor('#00000000');
  installHtmlFullscreenRecovery(view.webContents);
  view.setBorderRadius(0);
  view.setVisible(false);
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  view.webContents.on('will-navigate', (event, url) => {
    try {
      const requested = new URL(url);
      const expected = new URL(routeUrl);
      if (requested.origin !== expected.origin || requested.pathname !== expected.pathname) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  view.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault();
      setEmbeddedBrowserLibraryPanel('');
      return;
    }
    handleEmbeddedBrowserShortcut(event, input);
  });
  view.webContents.on('did-finish-load', () => {
    notifyEmbeddedBrowserLibraryStateChange();
    notifyEmbeddedBrowserStateChange();
  });
  view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    appendLog(`Embedded browser library load failed: ${errorDescription} (${errorCode})`);
    if (embeddedBrowserLibraryView === view) {
      embeddedBrowserLibraryPanel = '';
      embeddedBrowserLibraryVisible = false;
      view.setVisible(false);
      notifyEmbeddedBrowserStateChange();
    }
  });
  view.webContents.once('destroyed', () => {
    if (embeddedBrowserLibraryView === view) {
      embeddedBrowserLibraryView = undefined;
      embeddedBrowserLibraryPanel = '';
      embeddedBrowserLibraryAttached = false;
      embeddedBrowserLibraryVisible = false;
      notifyEmbeddedBrowserStateChange();
    }
  });
  embeddedBrowserLibraryView = view;
  embeddedBrowserLibraryAttached = false;
  embeddedBrowserLibraryVisible = false;
  void view.webContents.loadURL(routeUrl).catch((error) => {
    appendLog(`Embedded browser library load failed: ${error instanceof Error ? error.message : String(error)}`);
    if (embeddedBrowserLibraryView === view) {
      embeddedBrowserLibraryPanel = '';
      embeddedBrowserLibraryVisible = false;
      view.setVisible(false);
      notifyEmbeddedBrowserStateChange();
    }
  });
  return view;
}

function attachEmbeddedBrowserLibraryView() {
  if (!embeddedBrowserLibraryPanel || !mainWindow || mainWindow.isDestroyed()) {
    if (embeddedBrowserLibraryVisible) embeddedBrowserLibraryView?.setVisible(false);
    embeddedBrowserLibraryVisible = false;
    return;
  }
  const view = ensureEmbeddedBrowserLibraryView();
  // Re-adding an existing child moves it to the top of the native View stack.
  // Active browser tabs are also WebContentsViews and may otherwise cover this panel.
  mainWindow.contentView.addChildView(view);
  embeddedBrowserLibraryAttached = true;
  view.setBounds(embeddedBrowserLibraryViewBounds());
  if (!embeddedBrowserLibraryVisible) {
    view.setVisible(true);
    embeddedBrowserLibraryVisible = true;
    view.webContents.focus();
  }
}

function setEmbeddedBrowserLibraryPanel(value) {
  const nextPanel = value === 'library' ? value : '';
  if (!nextPanel) {
    embeddedBrowserLibraryPanel = '';
    if (embeddedBrowserLibraryVisible) embeddedBrowserLibraryView?.setVisible(false);
    embeddedBrowserLibraryVisible = false;
    notifyEmbeddedBrowserStateChange();
    return embeddedBrowserState();
  }

  // Reuse the preloaded combined view so opening is immediate.
  embeddedBrowserLibraryPanel = nextPanel;
  attachEmbeddedBrowserLibraryView();
  notifyEmbeddedBrowserLibraryStateChange();
  notifyEmbeddedBrowserStateChange();
  return embeddedBrowserState();
}

function destroyEmbeddedBrowserLibraryView() {
  const view = embeddedBrowserLibraryView;
  embeddedBrowserLibraryPanel = '';
  embeddedBrowserLibraryView = undefined;
  embeddedBrowserLibraryVisible = false;
  const wasAttached = embeddedBrowserLibraryAttached;
  embeddedBrowserLibraryAttached = false;
  if (!view) return;
  try {
    if (wasAttached && mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(view);
  } catch (error) {
    appendLog(`Embedded browser library detach failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    if (!view.webContents.isDestroyed()) view.webContents.close();
  } catch (error) {
    appendLog(`Embedded browser library close failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function clearEmbeddedBrowserStateChangeTimer() {
  if (!embeddedBrowserStateChangeTimer) return;
  clearTimeout(embeddedBrowserStateChangeTimer);
  embeddedBrowserStateChangeTimer = undefined;
}

function notifyEmbeddedBrowserLibraryStateChange() {
  if (!embeddedBrowserLibraryView || embeddedBrowserLibraryView.webContents.isDestroyed()) return;
  try {
    embeddedBrowserLibraryView.webContents.send('webpilot:embedded-browser:state-changed', embeddedBrowserState());
  } catch (error) {
    appendLog(`Embedded browser library state event failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function notifyEmbeddedBrowserStateChange() {
  if (embeddedBrowserStateChangeTimer) return;
  embeddedBrowserStateChangeTimer = setTimeout(() => {
    embeddedBrowserStateChangeTimer = undefined;
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    try {
      const state = embeddedBrowserState();
      mainWindow.webContents.send('webpilot:embedded-browser:state-changed', state);
      if (embeddedBrowserLibraryView && !embeddedBrowserLibraryView.webContents.isDestroyed()) {
        embeddedBrowserLibraryView.webContents.send('webpilot:embedded-browser:state-changed', state);
      }
    } catch (error) {
      appendLog(`Embedded browser state event failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, 0);
}

const DOWNLOAD_URL_EXTENSIONS = new Set([
  '.7z',
  '.apk',
  '.bin',
  '.bz2',
  '.csv',
  '.deb',
  '.dmg',
  '.doc',
  '.docx',
  '.exe',
  '.gz',
  '.ipa',
  '.msi',
  '.pkg',
  '.ppt',
  '.pptx',
  '.rar',
  '.rpm',
  '.tar',
  '.tgz',
  '.xls',
  '.xlsx',
  '.xz',
  '.zip',
]);

function normalizeEmbeddedBrowserOpenUrl(value, baseUrl = '') {
  const rawUrl = String(value || '').trim();
  if (!rawUrl) return '';
  try {
    return new URL(rawUrl).toString();
  } catch {
    const base = String(baseUrl || '').trim();
    if (!base) return '';
    try {
      return new URL(rawUrl, base).toString();
    } catch {
      return '';
    }
  }
}

function isBlankPageUrl(url) {
  return /^about:blank(?:[#?].*)?$/i.test(String(url || '').trim());
}

function isEmbeddedBrowserWebLikeUrl(url) {
  const normalizedUrl = normalizeEmbeddedBrowserOpenUrl(url);
  if (!normalizedUrl) return false;
  try {
    const protocol = new URL(normalizedUrl).protocol;
    return protocol === 'http:' || protocol === 'https:' || protocol === 'about:' || protocol === 'data:' || protocol === 'file:' || protocol === 'blob:';
  } catch {
    return false;
  }
}

function isDownloadLikeUrl(url, details = {}) {
  if (String(details.disposition || '').toLowerCase() === 'save-to-disk') return true;
  const normalizedUrl = normalizeEmbeddedBrowserOpenUrl(url);
  if (!normalizedUrl) return false;
  try {
    const parsed = new URL(normalizedUrl);
    const downloadValue = parsed.searchParams.get('download');
    if (downloadValue !== null && !/^(0|false|no)$/i.test(downloadValue)) return true;
    const attachmentValue = [
      parsed.searchParams.get('content-disposition'),
      parsed.searchParams.get('response-content-disposition'),
    ].filter(Boolean).join(' ').toLowerCase();
    if (attachmentValue.includes('attachment')) return true;
    const pathname = decodeURIComponent(parsed.pathname || '').toLowerCase();
    const extension = pathname.match(/\.([a-z0-9]{1,8})$/)?.[0] || '';
    return DOWNLOAD_URL_EXTENSIONS.has(extension);
  } catch {
    return false;
  }
}

function downloadFileNameFromUrl(url) {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname || '');
    return path.basename(pathname);
  } catch {
    return '';
  }
}

function sanitizeDownloadFileName(value) {
  const basename = path.basename(String(value || '').trim()).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  if (!basename || basename === '.' || basename === '..') return 'download';
  return basename;
}

function uniqueDownloadPath(directory, fileName) {
  const safeName = sanitizeDownloadFileName(fileName);
  const extension = path.extname(safeName);
  const stem = extension ? safeName.slice(0, -extension.length) : safeName;
  let candidate = path.join(directory, safeName);
  for (let index = 1; fs.existsSync(candidate); index += 1) {
    candidate = path.join(directory, `${stem || 'download'} (${index})${extension}`);
  }
  return candidate;
}

function downloadProgressPayload(download) {
  const totalBytes = Number(download.totalBytes || 0);
  const receivedBytes = Number(download.receivedBytes || 0);
  return {
    completedAt: download.completedAt,
    error: download.error,
    fileName: download.fileName,
    id: download.id,
    path: download.path,
    progress: totalBytes > 0 ? Math.max(0, Math.min(1, receivedBytes / totalBytes)) : undefined,
    receivedBytes,
    startedAt: download.startedAt,
    status: download.status,
    totalBytes: totalBytes || undefined,
    updatedAt: download.updatedAt,
    url: download.url,
  };
}

function emitDownloadProgress(download) {
  const payload = downloadProgressPayload(download);
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('webpilot:system:download-progress', payload);
  }
  return payload;
}

function emitDownloadRemoved(id) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('webpilot:system:download-removed', { id });
  }
}

function updateSystemDownload(download, patch = {}) {
  Object.assign(download, patch, { updatedAt: Date.now() });
  systemDownloads.set(download.id, download);
  return emitDownloadProgress(download);
}

function systemDownloadState() {
  return {
    directory: downloadDirectory(),
    downloads: Array.from(systemDownloads.values())
      .sort((left, right) => Number(right.startedAt || 0) - Number(left.startedAt || 0))
      .map(downloadProgressPayload),
    ok: true,
  };
}

function downloadDirectory() {
  return lastDownloadDirectory || app.getPath('downloads');
}

function writeDownloadSettings() {
  if (!runtimeDatabasePath || !lastDownloadDirectory) return;
  try {
    getElectronStateDatabase().prepare(`
      INSERT INTO electron_state (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(
      DOWNLOAD_SETTINGS_STATE_KEY,
      JSON.stringify({ directory: lastDownloadDirectory }),
      new Date().toISOString(),
    );
  } catch (error) {
    appendLog(`Download settings save failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function restoreDownloadSettings() {
  if (!runtimeDatabasePath) return false;
  try {
    const row = getElectronStateDatabase().prepare(`
      SELECT value_json FROM electron_state WHERE key = ?
    `).get(DOWNLOAD_SETTINGS_STATE_KEY);
    if (!row?.value_json) return false;
    const saved = JSON.parse(row.value_json);
    const directory = typeof saved?.directory === 'string' ? saved.directory.trim() : '';
    if (!directory || !path.isAbsolute(directory)) return false;
    lastDownloadDirectory = directory;
    return true;
  } catch (error) {
    appendLog(`Download settings restore failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function chooseDownloadDirectory(input = {}) {
  const defaultPath = typeof input.defaultPath === 'string' && input.defaultPath.trim()
    ? input.defaultPath.trim()
    : downloadDirectory();
  const result = await dialog.showOpenDialog(mainWindow, {
    defaultPath,
    properties: ['openDirectory', 'createDirectory'],
    title: '选择下载位置',
  });
  if (result.canceled || !result.filePaths?.[0]) return { ok: true, canceled: true };
  lastDownloadDirectory = result.filePaths[0];
  writeDownloadSettings();
  return { ok: true, path: result.filePaths[0] };
}

function installNativeDownloadHandler(electronSession) {
  if (!electronSession || nativeDownloadSessions.has(electronSession)) return;
  nativeDownloadSessions.add(electronSession);
  electronSession.on('will-download', (event, item) => {
    const startedAt = Date.now();
    const url = item.getURL() || '';
    const fileName = sanitizeDownloadFileName(item.getFilename() || downloadFileNameFromUrl(url));
    const download = {
      error: '',
      fileName,
      id: `download:${startedAt}:${nextDownloadId++}`,
      path: '',
      receivedBytes: Number(item.getReceivedBytes() || 0),
      startedAt,
      status: 'pending',
      totalBytes: Number(item.getTotalBytes() || 0),
      updatedAt: startedAt,
      url,
    };
    systemDownloads.set(download.id, download);
    emitDownloadProgress(download);

    try {
      const directory = ensureDir(downloadDirectory());
      const savePath = uniqueDownloadPath(directory, fileName);
      item.setSavePath(savePath);
      nativeDownloadItems.set(download.id, item);
      updateSystemDownload(download, { path: savePath, status: 'downloading' });
    } catch (error) {
      event.preventDefault();
      const message = error instanceof Error ? error.message : String(error);
      updateSystemDownload(download, { completedAt: Date.now(), error: message, status: 'failed' });
      appendLog(`Native download setup failed: ${message}`);
      return;
    }

    let lastProgressAt = 0;
    item.on('updated', (_updatedEvent, state) => {
      const now = Date.now();
      const receivedBytes = Number(item.getReceivedBytes() || 0);
      const totalBytes = Number(item.getTotalBytes() || 0);
      if (state === 'progressing' && now - lastProgressAt < 160 && receivedBytes !== totalBytes) return;
      lastProgressAt = now;
      updateSystemDownload(download, {
        error: state === 'interrupted' ? '下载已中断，正在等待恢复' : '',
        receivedBytes,
        status: state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'downloading',
        totalBytes,
      });
    });

    item.once('done', (_doneEvent, state) => {
      nativeDownloadItems.delete(download.id);
      const completed = state === 'completed';
      updateSystemDownload(download, {
        completedAt: Date.now(),
        error: completed || state === 'cancelled' ? '' : '下载已中断',
        receivedBytes: Number(item.getReceivedBytes() || 0),
        status: completed ? 'completed' : state === 'cancelled' ? 'cancelled' : 'failed',
        totalBytes: Number(item.getTotalBytes() || 0),
      });
    });
  });
}

function startNativeDownload(webContents, url) {
  const normalizedUrl = normalizeEmbeddedBrowserOpenUrl(url, mainWindow?.webContents?.getURL?.() || '');
  if (!normalizedUrl) return { ok: false, error: 'Download URL is invalid.' };
  try {
    if (!webContents || webContents.isDestroyed()) throw new Error('Download page is not available.');
    installNativeDownloadHandler(webContents.session);
    webContents.downloadURL(normalizedUrl);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(`Native download start failed: ${message}`);
    return { ok: false, error: message };
  }
}

function preferredDownloadWebContents() {
  const embeddedTab = activeEmbeddedBrowserTab();
  if (embeddedBrowserVisible && embeddedTab && !embeddedTab.view.webContents.isDestroyed()) {
    return embeddedTab.view.webContents;
  }
  return mainWindow?.webContents;
}

async function openAppShellUrlInEmbeddedBrowser(url) {
  const normalizedUrl = normalizeEmbeddedBrowserOpenUrl(url, mainWindow?.webContents?.getURL?.() || '');
  if (!normalizedUrl || isBlankPageUrl(normalizedUrl)) return;
  if (!isEmbeddedBrowserWebLikeUrl(normalizedUrl)) {
    await shell.openExternal(normalizedUrl);
    return;
  }
  const result = await createManualEmbeddedBrowserTab({ url: normalizedUrl });
  if (result && result.ok === false) appendLog(`App shell link open failed: ${result.error || 'unknown error'}`);
}

function embeddedBrowserTabTitle(webContents) {
  const url = webContents.getURL() || '';
  const title = webContents.getTitle() || '';
  if (!url || /^data:text\/html/i.test(url) || /^WebPilot Embedded Browser$/i.test(title)) return '新建标签页';
  return title || url || '新建标签页';
}

function sanitizeEmbeddedBounds(bounds) {
  const contentBounds = mainWindow?.getContentBounds?.() || { width: 0, height: 0 };
  const widthLimit = Math.max(1, contentBounds.width || 1);
  const heightLimit = Math.max(1, contentBounds.height || 1);
  const x = Math.max(0, Math.min(Math.round(Number(bounds?.x) || 0), widthLimit));
  const y = Math.max(0, Math.min(Math.round(Number(bounds?.y) || 0), heightLimit));
  const width = Math.max(1, Math.min(Math.round(Number(bounds?.width) || 1), widthLimit - x || 1));
  const height = Math.max(1, Math.min(Math.round(Number(bounds?.height) || 1), heightLimit - y || 1));
  return { x, y, width, height };
}

function normalizeEmbeddedBrowserSessionId(value) {
  return String(value || '').trim();
}

function normalizeEmbeddedBrowserUserId(value) {
  return String(value ?? '').trim();
}

function embeddedBrowserPartition(sessionId) {
  const sessionKey = normalizeEmbeddedBrowserSessionId(sessionId) || 'default';
  const normalized = sessionKey
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const digest = createHash('sha256').update(sessionKey, 'utf8').digest('hex').slice(0, 24);
  return `persist:webpilot-${normalized || 'session'}-${digest}`;
}

async function clearEmbeddedBrowserPartition(sessionId, userId) {
  const normalized = normalizeEmbeddedBrowserSessionId(sessionId);
  const normalizedUserId = normalizeEmbeddedBrowserUserId(userId);
  if (!normalized && !normalizedUserId) return;
  const partitionSession = electronSession.fromPartition(embeddedBrowserPartition(
    normalizedUserId ? `user:${normalizedUserId}` : `session:${normalized}`,
  ));
  await partitionSession.clearStorageData();
  await partitionSession.clearCache();
  if (typeof partitionSession.clearAuthCache === 'function') await partitionSession.clearAuthCache();
}

function embeddedBrowserGroupIdForSession(sessionId) {
  const normalized = normalizeEmbeddedBrowserSessionId(sessionId);
  return normalized ? `session:${normalized}` : 'default';
}

function embeddedBrowserSessionIdFromGroupId(groupId) {
  const normalized = String(groupId || '').trim();
  return normalized.startsWith('session:') ? normalized.slice('session:'.length) : '';
}

function embeddedBrowserSessionIdForGroup(input = {}, groupIdInput) {
  const groupId = String(groupIdInput || embeddedBrowserGroupId(input) || '').trim();
  return normalizeEmbeddedBrowserSessionId(input.sessionId) || embeddedBrowserSessionIdFromGroupId(groupId);
}

function embeddedBrowserGroupId(input = {}) {
  const explicitGroupId = String(input.groupId || '').trim();
  if (explicitGroupId) return explicitGroupId;
  const tabId = String(input.id || '').trim();
  const tab = tabId ? embeddedBrowserTabs.get(tabId) : undefined;
  if (tab?.groupId) return tab.groupId;
  const sessionId = normalizeEmbeddedBrowserSessionId(input.sessionId);
  if (sessionId) return embeddedBrowserGroupIdForSession(sessionId);
  return embeddedBrowserActiveGroupId || 'default';
}

function persistedEmbeddedBrowserId(value) {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9:_-]{1,160}$/.test(id) ? id : '';
}

function embeddedBrowserPersistableUrl(value) {
  const normalizedUrl = normalizeEmbeddedBrowserOpenUrl(value);
  if (!normalizedUrl) return '';
  try {
    const protocol = new URL(normalizedUrl).protocol;
    return protocol === 'http:' || protocol === 'https:' || protocol === 'file:' ? normalizedUrl : '';
  } catch {
    return '';
  }
}

function embeddedBrowserRecordTitle(value, fallback = '') {
  return String(value || fallback || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function embeddedBrowserFaviconUrl(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (/^data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,/i.test(normalized)) {
    return normalized.length <= 256 * 1024 ? normalized : '';
  }
  if (normalized.length > 8192) return '';
  try {
    const protocol = new URL(normalized).protocol;
    return protocol === 'http:' || protocol === 'https:' || protocol === 'file:' ? normalized : '';
  } catch {
    return '';
  }
}

function embeddedBrowserBookmarkList() {
  return Array.from(embeddedBrowserBookmarks.values())
    .sort((left, right) => Number(right.createdAt) - Number(left.createdAt));
}

function embeddedBrowserIsBookmarked(value) {
  const url = embeddedBrowserPersistableUrl(value);
  return Boolean(url && embeddedBrowserBookmarks.has(url));
}

function recordEmbeddedBrowserHistory(tab) {
  if (!tab || tab.restorePending || tab.view.webContents.isDestroyed()) return;
  const url = embeddedBrowserPersistableUrl(tab.lastKnownUrl || tab.view.webContents.getURL() || '');
  if (!url) return;
  const now = Date.now();
  const title = embeddedBrowserRecordTitle(embeddedBrowserTabTitle(tab.view.webContents), url);
  const existingIndex = embeddedBrowserHistory.findIndex((item) => item.url === url);
  const existing = existingIndex >= 0 ? embeddedBrowserHistory[existingIndex] : undefined;
  const record = {
    faviconUrl: embeddedBrowserFaviconUrl(tab.faviconUrl) || existing?.faviconUrl || undefined,
    id: existing?.id || `history:${embeddedBrowserNextHistoryId++}`,
    lastVisitedAt: now,
    title: title || existing?.title || url,
    url,
    visitCount: existing
      ? Math.max(1, Number(existing.visitCount) || 0) + (now - Number(existing.lastVisitedAt || 0) < 2000 ? 0 : 1)
      : 1,
  };
  if (existingIndex >= 0) embeddedBrowserHistory.splice(existingIndex, 1);
  embeddedBrowserHistory.unshift(record);
  if (embeddedBrowserHistory.length > EMBEDDED_BROWSER_HISTORY_LIMIT) {
    embeddedBrowserHistory = embeddedBrowserHistory.slice(0, EMBEDDED_BROWSER_HISTORY_LIMIT);
  }
  writeEmbeddedBrowserPersistence();
  scheduleEmbeddedBrowserPersistence();
  notifyEmbeddedBrowserStateChange();
}

function toggleEmbeddedBrowserBookmark() {
  const tab = activeEmbeddedBrowserTab();
  if (!tab || tab.view.webContents.isDestroyed()) throw new Error('No active embedded browser tab is available.');
  const url = embeddedBrowserPersistableUrl(tab.lastKnownUrl || tab.view.webContents.getURL() || '');
  if (!url) throw new Error('Only http, https, or file pages can be bookmarked.');
  if (embeddedBrowserBookmarks.has(url)) {
    embeddedBrowserBookmarks.delete(url);
  } else {
    embeddedBrowserBookmarks.set(url, {
      createdAt: Date.now(),
      faviconUrl: embeddedBrowserFaviconUrl(tab.faviconUrl) || undefined,
      id: `bookmark:${embeddedBrowserNextBookmarkId++}`,
      title: embeddedBrowserRecordTitle(embeddedBrowserTabTitle(tab.view.webContents), url),
      url,
    });
  }
  writeEmbeddedBrowserPersistence();
  scheduleEmbeddedBrowserPersistence();
  notifyEmbeddedBrowserStateChange();
  return embeddedBrowserState();
}

function removeEmbeddedBrowserBookmark(value) {
  const url = embeddedBrowserPersistableUrl(value);
  if (url) embeddedBrowserBookmarks.delete(url);
  writeEmbeddedBrowserPersistence();
  scheduleEmbeddedBrowserPersistence();
  notifyEmbeddedBrowserStateChange();
  return embeddedBrowserState();
}

function clearEmbeddedBrowserHistory() {
  embeddedBrowserHistory = [];
  writeEmbeddedBrowserPersistence();
  scheduleEmbeddedBrowserPersistence();
  notifyEmbeddedBrowserStateChange();
  return embeddedBrowserState();
}

function applyEmbeddedBrowserTabAudioPolicy(tab) {
  if (!tab || tab.view.webContents.isDestroyed()) return;
  const muted = Boolean(tab.audioMuted || !embeddedBrowserVisible);
  if (tab.view.webContents.isAudioMuted?.() !== muted) tab.view.webContents.setAudioMuted(muted);
}

function applyEmbeddedBrowserAudioPolicy() {
  for (const tab of embeddedBrowserTabs.values()) applyEmbeddedBrowserTabAudioPolicy(tab);
}

function setEmbeddedBrowserTabMuted(input = {}) {
  const id = String(input.id || embeddedBrowserActiveTabId || '').trim();
  const tab = embeddedBrowserTabs.get(id) || activeEmbeddedBrowserTab();
  if (!tab || tab.view.webContents.isDestroyed()) throw new Error('Embedded browser tab not found.');
  const currentMuted = Boolean(tab.audioMuted);
  const muted = typeof input.muted === 'boolean' ? input.muted : !currentMuted;
  tab.audioMuted = muted;
  applyEmbeddedBrowserTabAudioPolicy(tab);
  writeEmbeddedBrowserPersistence();
  scheduleEmbeddedBrowserPersistence();
  notifyEmbeddedBrowserStateChange();
  return embeddedBrowserState();
}

function embeddedBrowserPersistenceSnapshot() {
  const tabs = [];
  for (const tab of embeddedBrowserTabs.values()) {
    if (!tab || tab.view.webContents.isDestroyed()) continue;
    const url = embeddedBrowserPersistableUrl(tab.lastKnownUrl || tab.view.webContents.getURL() || '');
    tabs.push({
      audioMuted: Boolean(tab.audioMuted),
      createdAt: Number(tab.createdAt) || Date.now(),
      faviconUrl: embeddedBrowserFaviconUrl(tab.faviconUrl) || undefined,
      groupId: tab.groupId,
      id: tab.id,
      pinned: Boolean(tab.pinned),
      sessionId: tab.sessionId || undefined,
      userId: tab.userId || undefined,
      title: embeddedBrowserRecordTitle(tab.lastKnownTitle),
      url,
    });
  }

  const groups = Array.from(embeddedBrowserGroups.values())
    .map((group) => ({
      activeTabId: group.activeTabId || undefined,
      collapsed: Boolean(group.collapsed),
      createdAt: Number(group.createdAt) || Date.now(),
      id: group.id,
      label: embeddedBrowserRecordTitle(group.label),
      sessionId: embeddedBrowserSessionIdFromGroupId(group.id) || group.sessionId || undefined,
      userId: group.userId || undefined,
    }));

  return {
    activeGroupId: embeddedBrowserActiveGroupId || undefined,
    activeTabId: embeddedBrowserActiveTabId || undefined,
    bookmarks: embeddedBrowserBookmarkList(),
    groups,
    history: embeddedBrowserHistory,
    nextBookmarkId: embeddedBrowserNextBookmarkId,
    nextHistoryId: embeddedBrowserNextHistoryId,
    nextTabId: embeddedBrowserNextTabId,
    tabs,
    updatedAt: new Date().toISOString(),
    version: EMBEDDED_BROWSER_PERSISTENCE_VERSION,
  };
}

function writeEmbeddedBrowserPersistence() {
  if (!runtimeDatabasePath || embeddedBrowserPersistenceRestoring || embeddedBrowserPersistenceStopped) return;
  try {
    getElectronStateDatabase().prepare(`
      INSERT INTO electron_state (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(
      EMBEDDED_BROWSER_STATE_KEY,
      JSON.stringify(embeddedBrowserPersistenceSnapshot()),
      new Date().toISOString(),
    );
  } catch (error) {
    appendLog(`Embedded browser state save failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function clearEmbeddedBrowserPersistenceTimer() {
  if (!embeddedBrowserPersistenceTimer) return;
  clearTimeout(embeddedBrowserPersistenceTimer);
  embeddedBrowserPersistenceTimer = undefined;
}

function scheduleEmbeddedBrowserPersistence() {
  if (!runtimeDatabasePath || embeddedBrowserPersistenceStopped) return;
  clearEmbeddedBrowserPersistenceTimer();
  embeddedBrowserPersistenceTimer = setTimeout(() => {
    embeddedBrowserPersistenceTimer = undefined;
    writeEmbeddedBrowserPersistence();
  }, 180);
}

function restoreEmbeddedBrowserPersistence() {
  if (!runtimeDatabasePath || embeddedBrowserTabs.size || embeddedBrowserGroups.size) return false;

  let saved;
  try {
    const row = getElectronStateDatabase().prepare(`
      SELECT value_json FROM electron_state WHERE key = ?
    `).get(EMBEDDED_BROWSER_STATE_KEY);
    if (!row?.value_json) return false;
    saved = JSON.parse(row.value_json);
  } catch (error) {
    appendLog(`Embedded browser state restore failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  const savedVersion = Number(saved?.version);
  if (!saved || typeof saved !== 'object' || ![1, EMBEDDED_BROWSER_PERSISTENCE_VERSION].includes(savedVersion)) return false;

  embeddedBrowserPersistenceRestoring = true;
  try {
    const savedBookmarks = Array.isArray(saved.bookmarks) ? saved.bookmarks : [];
    for (const item of savedBookmarks) {
      const url = embeddedBrowserPersistableUrl(item?.url);
      if (!url || embeddedBrowserBookmarks.has(url)) continue;
      const id = persistedEmbeddedBrowserId(item?.id) || `bookmark:${embeddedBrowserNextBookmarkId++}`;
      embeddedBrowserBookmarks.set(url, {
        createdAt: Number.isFinite(Number(item?.createdAt)) ? Number(item.createdAt) : Date.now(),
        faviconUrl: embeddedBrowserFaviconUrl(item?.faviconUrl) || undefined,
        id,
        title: embeddedBrowserRecordTitle(item?.title, url),
        url,
      });
      const matched = /^bookmark:(\d+)$/.exec(id);
      if (matched) embeddedBrowserNextBookmarkId = Math.max(embeddedBrowserNextBookmarkId, Number(matched[1]) + 1);
    }
    embeddedBrowserNextBookmarkId = Math.max(embeddedBrowserNextBookmarkId, Number(saved.nextBookmarkId) || 1);

    const seenHistoryUrls = new Set();
    const savedHistory = Array.isArray(saved.history) ? saved.history : [];
    embeddedBrowserHistory = savedHistory.flatMap((item) => {
      const url = embeddedBrowserPersistableUrl(item?.url);
      if (!url || seenHistoryUrls.has(url)) return [];
      seenHistoryUrls.add(url);
      const id = persistedEmbeddedBrowserId(item?.id) || `history:${embeddedBrowserNextHistoryId++}`;
      const matched = /^history:(\d+)$/.exec(id);
      if (matched) embeddedBrowserNextHistoryId = Math.max(embeddedBrowserNextHistoryId, Number(matched[1]) + 1);
      return [{
        faviconUrl: embeddedBrowserFaviconUrl(item?.faviconUrl) || undefined,
        id,
        lastVisitedAt: Number.isFinite(Number(item?.lastVisitedAt)) ? Number(item.lastVisitedAt) : Date.now(),
        title: embeddedBrowserRecordTitle(item?.title, url),
        url,
        visitCount: Math.max(1, Number(item?.visitCount) || 1),
      }];
    }).slice(0, EMBEDDED_BROWSER_HISTORY_LIMIT);
    embeddedBrowserNextHistoryId = Math.max(embeddedBrowserNextHistoryId, Number(saved.nextHistoryId) || 1);

    const savedGroups = Array.isArray(saved.groups) ? saved.groups : [];
    const savedTabs = Array.isArray(saved.tabs) ? saved.tabs : [];
    const savedGroupActiveTabIds = new Map();
    for (const item of savedGroups) {
      const id = persistedEmbeddedBrowserId(item?.id);
      if (!id || embeddedBrowserGroups.has(id)) continue;
      const sessionId = embeddedBrowserSessionIdFromGroupId(id) || normalizeEmbeddedBrowserSessionId(item?.sessionId);
      embeddedBrowserGroups.set(id, {
        activeTabId: persistedEmbeddedBrowserId(item?.activeTabId),
        collapsed: Boolean(item?.collapsed),
        createdAt: Number.isFinite(Number(item?.createdAt)) ? Number(item.createdAt) : Date.now(),
        id,
        label: embeddedBrowserRecordTitle(item?.label),
        sessionId,
        userId: normalizeEmbeddedBrowserUserId(item?.userId),
      });
      savedGroupActiveTabIds.set(id, persistedEmbeddedBrowserId(item?.activeTabId));
    }

    const restoredTabIds = new Set();
    let restoredNextTabId = Math.max(1, Number(saved.nextTabId) || 1);
    for (const item of savedTabs) {
      const id = persistedEmbeddedBrowserId(item?.id);
      const groupId = persistedEmbeddedBrowserId(item?.groupId);
      if (!id || !groupId || restoredTabIds.has(id)) continue;
      if (!embeddedBrowserGroups.has(groupId)) {
        embeddedBrowserGroups.set(groupId, {
          activeTabId: '',
          collapsed: false,
          createdAt: Date.now(),
          id: groupId,
          sessionId: embeddedBrowserSessionIdFromGroupId(groupId) || normalizeEmbeddedBrowserSessionId(item?.sessionId),
          userId: normalizeEmbeddedBrowserUserId(item?.userId),
        });
      }
      try {
        const tab = createEmbeddedBrowserTab({
          audioMuted: Boolean(item?.audioMuted),
          faviconUrl: embeddedBrowserFaviconUrl(item?.faviconUrl),
          groupId,
          id,
          pinned: Boolean(item?.pinned),
          sessionId: embeddedBrowserSessionIdFromGroupId(groupId) || normalizeEmbeddedBrowserSessionId(item?.sessionId),
          userId: normalizeEmbeddedBrowserUserId(item?.userId),
          restore: true,
          title: embeddedBrowserRecordTitle(item?.title),
          url: embeddedBrowserPersistableUrl(item?.url),
        });
        tab.createdAt = Number.isFinite(Number(item?.createdAt)) ? Number(item.createdAt) : tab.createdAt;
        restoredTabIds.add(id);
        const matched = /^tab:(\d+)$/.exec(id);
        if (matched) restoredNextTabId = Math.max(restoredNextTabId, Number(matched[1]) + 1);
      } catch (error) {
        appendLog(`Embedded browser tab restore failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    embeddedBrowserNextTabId = restoredNextTabId;

    for (const group of embeddedBrowserGroups.values()) {
      const tabs = embeddedBrowserTabsForGroup(group.id);
      const savedActiveTabId = savedGroupActiveTabIds.get(group.id);
      group.activeTabId = tabs.some((tab) => tab.id === savedActiveTabId)
        ? savedActiveTabId
        : tabs[0]?.id || '';
    }

    const savedActiveGroupId = persistedEmbeddedBrowserId(saved.activeGroupId);
    const savedActiveTabId = persistedEmbeddedBrowserId(saved.activeTabId);
    const savedActiveTab = embeddedBrowserTabs.get(savedActiveTabId);
    if (savedActiveTab && !savedActiveTab.view.webContents.isDestroyed()) {
      setActiveEmbeddedBrowserTab(savedActiveTab);
    } else if (savedActiveGroupId && embeddedBrowserGroups.has(savedActiveGroupId)) {
      const group = embeddedBrowserGroups.get(savedActiveGroupId);
      const tab = embeddedBrowserTabs.get(group?.activeTabId);
      if (tab && !tab.view.webContents.isDestroyed()) setActiveEmbeddedBrowserTab(tab);
      else setActiveEmbeddedBrowserGroup(savedActiveGroupId);
    } else {
      const firstTab = embeddedBrowserTabs.values().next().value;
      if (firstTab && !firstTab.view.webContents.isDestroyed()) setActiveEmbeddedBrowserTab(firstTab);
    }
    return restoredTabIds.size > 0 || embeddedBrowserGroups.size > 0;
  } finally {
    embeddedBrowserPersistenceRestoring = false;
    scheduleEmbeddedBrowserPersistence();
  }
}

function embeddedBrowserSessionScript(tab) {
  const sessionId = JSON.stringify(tab.sessionId || '');
  const tabId = JSON.stringify(tab.id);
  return `
    (() => {
      try {
        Object.defineProperty(window, '__webPilotEmbeddedBrowserSessionId', {
          configurable: true,
          enumerable: false,
          value: ${sessionId},
        });
        Object.defineProperty(window, '__webPilotEmbeddedBrowserTabId', {
          configurable: true,
          enumerable: false,
          value: ${tabId},
        });
        document.documentElement?.setAttribute('data-webpilot-embedded-browser-session-id', ${sessionId});
        document.documentElement?.setAttribute('data-webpilot-embedded-browser-tab-id', ${tabId});
        const cleanWindowName = String(window.name || '').replace(/^AI_WEB_TEST_SESSION_GROUP:[^;]+;/, '');
        window.name = ${sessionId} ? 'AI_WEB_TEST_SESSION_GROUP:' + ${sessionId} + ';' + cleanWindowName : cleanWindowName;
      } catch {}
    })()
  `;
}

function markEmbeddedBrowserSession(tab) {
  if (!tab || tab.view.webContents.isDestroyed()) return Promise.resolve();
  return tab.view.webContents.executeJavaScript(embeddedBrowserSessionScript(tab), true).catch(() => undefined);
}

function loadEmbeddedBrowserTabUrl(tab, url, options = {}) {
  if (!tab || tab.view.webContents.isDestroyed()) return Promise.resolve();
  if (!options.restore) tab.restorePending = false;
  tab.lastKnownUrl = String(url || '').trim();
  tab.clientNavigation = undefined;
  tab.routeLoadingUntil = Date.now() + EMBEDDED_BROWSER_ROUTE_LOADING_MS;
  writeEmbeddedBrowserPersistence();
  scheduleEmbeddedBrowserPersistence();
  notifyEmbeddedBrowserStateChange();
  tab.readyPromise = tab.view.webContents.loadURL(url)
    .then(() => markEmbeddedBrowserSession(tab));
  return tab.readyPromise;
}

async function ensureEmbeddedBrowserTabReady(tab) {
  if (!tab || tab.view.webContents.isDestroyed()) return;
  await tab.readyPromise?.catch(() => undefined);
  await markEmbeddedBrowserSession(tab);
}

function activeEmbeddedBrowserTab() {
  const activeGroup = embeddedBrowserGroups.get(embeddedBrowserActiveGroupId);
  if (activeGroup) {
    let tab = embeddedBrowserTabs.get(activeGroup.activeTabId);
    if (tab && !tab.view.webContents.isDestroyed() && tab.groupId === activeGroup.id) {
      if (embeddedBrowserActiveTabId !== tab.id) setActiveEmbeddedBrowserTab(tab);
      return tab;
    }
    tab = embeddedBrowserTabs.get(embeddedBrowserActiveTabId);
    if (tab && !tab.view.webContents.isDestroyed() && tab.groupId === activeGroup.id) {
      if (activeGroup.activeTabId !== tab.id) activeGroup.activeTabId = tab.id;
      return tab;
    }
    for (const item of embeddedBrowserTabs.values()) {
      if (item.groupId === activeGroup.id && !item.view.webContents.isDestroyed()) {
        setActiveEmbeddedBrowserTab(item);
        return item;
      }
    }
    embeddedBrowserActiveTabId = '';
    embeddedBrowserView = undefined;
    embeddedBrowserAttached = false;
    activeGroup.activeTabId = '';
    return undefined;
  }

  let tab = embeddedBrowserTabs.get(embeddedBrowserActiveTabId);
  if (tab && !tab.view.webContents.isDestroyed()) return tab;
  for (const item of embeddedBrowserTabs.values()) {
    if (!item.view.webContents.isDestroyed()) {
      setActiveEmbeddedBrowserTab(item);
      return item;
    }
  }
  embeddedBrowserActiveTabId = '';
  embeddedBrowserView = undefined;
  embeddedBrowserAttached = false;
  return undefined;
}

function setActiveEmbeddedBrowserTab(tab) {
  if (tab?.groupId) {
    embeddedBrowserActiveGroupId = tab.groupId;
    const group = embeddedBrowserGroups.get(tab.groupId);
    if (group) group.activeTabId = tab.id;
  }
  embeddedBrowserActiveTabId = tab?.id || '';
  embeddedBrowserView = tab?.view;
  embeddedBrowserAttached = Boolean(tab?.attached);
  scheduleEmbeddedBrowserPersistence();
  notifyEmbeddedBrowserStateChange();
}

function embeddedBrowserTabForWebContents(webContents) {
  if (!webContents) return undefined;
  for (const tab of embeddedBrowserTabs.values()) {
    if (!tab.view.webContents.isDestroyed() && tab.view.webContents === webContents) return tab;
  }
  return undefined;
}

function setActiveEmbeddedBrowserGroup(groupId) {
  embeddedBrowserActiveGroupId = String(groupId || '').trim();
  embeddedBrowserActiveTabId = '';
  embeddedBrowserView = undefined;
  embeddedBrowserAttached = false;
  scheduleEmbeddedBrowserPersistence();
  notifyEmbeddedBrowserStateChange();
}

function embeddedBrowserTabsForGroup(groupId) {
  return Array.from(embeddedBrowserTabs.values())
    .filter((tab) => tab.groupId === groupId && !tab.view.webContents.isDestroyed());
}

function ensureEmbeddedBrowserGroup(input = {}) {
  const groupId = embeddedBrowserGroupId(input);
  const sessionId = embeddedBrowserSessionIdForGroup(input, groupId);
  const userId = normalizeEmbeddedBrowserUserId(input.userId);
  let group = embeddedBrowserGroups.get(groupId);
  if (!group) {
    group = {
      activeTabId: '',
      collapsed: Boolean(input.collapsed),
      createdAt: Date.now(),
      id: groupId,
      label: embeddedBrowserRecordTitle(input.label),
      sessionId,
      userId,
    };
    embeddedBrowserGroups.set(group.id, group);
    scheduleEmbeddedBrowserPersistence();
    notifyEmbeddedBrowserStateChange();
  } else if (
    (sessionId && group.id.startsWith('session:') && group.sessionId !== sessionId)
    || (userId && group.userId !== userId)
  ) {
    if (sessionId) group.sessionId = sessionId;
    if (userId) group.userId = userId;
    scheduleEmbeddedBrowserPersistence();
    notifyEmbeddedBrowserStateChange();
  }
  return group;
}

function createManualEmbeddedBrowserGroup(input = {}) {
  const label = embeddedBrowserRecordTitle(input.label) || '新建标签组';
  const id = `group:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  ensureEmbeddedBrowserGroup({ groupId: id, label });
  setActiveEmbeddedBrowserGroup(id);
  writeEmbeddedBrowserPersistence();
  return embeddedBrowserState();
}

function setEmbeddedBrowserGroupCollapsed(input = {}) {
  const groupId = String(input.id || '').trim();
  const group = embeddedBrowserGroups.get(groupId);
  if (!group) return embeddedBrowserState();
  group.collapsed = Boolean(input.collapsed);
  writeEmbeddedBrowserPersistence();
  scheduleEmbeddedBrowserPersistence();
  notifyEmbeddedBrowserStateChange();
  return embeddedBrowserState();
}

function focusEmbeddedBrowserAddressBar() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (embeddedBrowserLibraryPanel) setEmbeddedBrowserLibraryPanel('');
  mainWindow.focus();
  mainWindow.webContents.focus();
  mainWindow.webContents.send('webpilot:embedded-browser:focus-address');
}

function handleEmbeddedBrowserShortcut(event, input, sourceTab) {
  if (!embeddedBrowserVisible || input?.type !== 'keyDown' || input.isAutoRepeat || input.isComposing) return false;
  if (!(input.control || input.meta) || input.alt) return false;
  const key = String(input.key || '').toLowerCase();
  if (!['l', 't', 'w'].includes(key)) return false;
  if (key === 'w' && input.shift) return false;
  event.preventDefault();
  if (key === 'l') {
    focusEmbeddedBrowserAddressBar();
    return true;
  }
  if (key === 't' && input.shift) {
    reopenClosedEmbeddedBrowserTab();
    return true;
  }
  if (key === 't') {
    const active = sourceTab && !sourceTab.view.webContents.isDestroyed() ? sourceTab : activeEmbeddedBrowserTab();
    void createManualEmbeddedBrowserTab({
      groupId: active?.groupId || embeddedBrowserActiveGroupId || 'default',
      sessionId: active?.sessionId,
    }).catch((error) => appendLog(`Embedded browser shortcut new tab failed: ${error instanceof Error ? error.message : String(error)}`));
    return true;
  }
  const active = sourceTab && !sourceTab.view.webContents.isDestroyed() ? sourceTab : activeEmbeddedBrowserTab();
  if (active) closeEmbeddedBrowserTab(active.id);
  return true;
}

function installEmbeddedBrowserTabHandlers(tab) {
  const { view } = tab;
  installHtmlFullscreenRecovery(view.webContents);
  view.webContents.on('before-input-event', (event, input) => {
    handleEmbeddedBrowserShortcut(event, input, tab);
  });
  view.webContents.setWindowOpenHandler((details) => {
    const url = String(details.url || '').trim();
    const normalizedUrl = normalizeEmbeddedBrowserOpenUrl(url, view.webContents.getURL() || '');
    if (!normalizedUrl || isBlankPageUrl(normalizedUrl)) return { action: 'deny' };
    if (isDownloadLikeUrl(normalizedUrl, details)) {
      const result = startNativeDownload(view.webContents, normalizedUrl);
      if (result.ok === false) appendLog(`Embedded browser popup download failed: ${result.error || 'unknown error'}`);
      return { action: 'deny' };
    }
    let popupTab;
    try {
      popupTab = createEmbeddedBrowserTab({ groupId: tab.groupId, sessionId: tab.sessionId, userId: tab.userId, url: normalizedUrl });
    } catch (error) {
      appendLog(`Embedded browser popup tab create failed: ${error instanceof Error ? error.message : String(error)}`);
      return { action: 'deny' };
    }
    if (embeddedBrowserVisible) {
      attachEmbeddedBrowserView({ id: popupTab.id });
    } else {
      setActiveEmbeddedBrowserTab(popupTab);
    }
    ensureEmbeddedBrowserTabReady(popupTab)
      .catch((error) => appendLog(`Embedded browser popup navigation failed: ${error.message}`));
    return { action: 'deny' };
  });
  view.webContents.on('dom-ready', () => {
    void markEmbeddedBrowserSession(tab);
  });
  view.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return;
    const nextUrl = String(url || '').trim();
    if (!nextUrl || nextUrl === tab.lastKnownUrl) return;
    tab.faviconUrl = '';
    tab.lastKnownTitle = '';
    tab.lastKnownUrl = nextUrl;
    notifyEmbeddedBrowserStateChange();
  });
  view.webContents.on('did-start-loading', () => {
    tab.routeLoadingUntil = Date.now() + EMBEDDED_BROWSER_ROUTE_LOADING_MS;
    scheduleEmbeddedBrowserPersistence();
    notifyEmbeddedBrowserStateChange();
  });
  view.webContents.on('did-finish-load', () => {
    tab.lastKnownUrl = view.webContents.getURL() || tab.lastKnownUrl || '';
    tab.lastKnownTitle = embeddedBrowserRecordTitle(embeddedBrowserTabTitle(view.webContents), tab.lastKnownTitle);
    void markEmbeddedBrowserSession(tab);
    scheduleEmbeddedBrowserPersistence();
    notifyEmbeddedBrowserStateChange();
    recordEmbeddedBrowserHistory(tab);
    tab.restorePending = false;
  });
  view.webContents.on('did-stop-loading', () => {
    tab.routeLoadingUntil = 0;
    tab.lastKnownUrl = view.webContents.getURL() || tab.lastKnownUrl || '';
    tab.lastKnownTitle = embeddedBrowserRecordTitle(embeddedBrowserTabTitle(view.webContents), tab.lastKnownTitle);
    void markEmbeddedBrowserSession(tab);
    scheduleEmbeddedBrowserPersistence();
    notifyEmbeddedBrowserStateChange();
  });
  view.webContents.on('did-navigate', () => {
    tab.lastKnownUrl = view.webContents.getURL() || tab.lastKnownUrl || '';
    void markEmbeddedBrowserSession(tab);
    scheduleEmbeddedBrowserPersistence();
    notifyEmbeddedBrowserStateChange();
    recordEmbeddedBrowserHistory(tab);
  });
  view.webContents.on('did-navigate-in-page', () => {
    tab.clientNavigation = {
      ...(tab.clientNavigation || {}),
      canGoBack: true,
      url: view.webContents.getURL() || tab.clientNavigation?.url || '',
    };
    tab.lastKnownUrl = view.webContents.getURL() || tab.lastKnownUrl || '';
    tab.routeLoadingUntil = Date.now() + EMBEDDED_BROWSER_ROUTE_LOADING_MS;
    void markEmbeddedBrowserSession(tab);
    scheduleEmbeddedBrowserPersistence();
    notifyEmbeddedBrowserStateChange();
    recordEmbeddedBrowserHistory(tab);
  });
  view.webContents.on('page-title-updated', (_event, title) => {
    tab.lastKnownTitle = embeddedBrowserRecordTitle(title, embeddedBrowserTabTitle(view.webContents));
    scheduleEmbeddedBrowserPersistence();
    notifyEmbeddedBrowserStateChange();
    recordEmbeddedBrowserHistory(tab);
  });
  view.webContents.on('page-favicon-updated', (_event, faviconUrls) => {
    const nextFaviconUrl = (Array.isArray(faviconUrls) ? faviconUrls : [])
      .map((value) => embeddedBrowserFaviconUrl(value))
      .find(Boolean) || '';
    if (nextFaviconUrl === tab.faviconUrl) return;
    tab.faviconUrl = nextFaviconUrl;
    const recordUrl = embeddedBrowserPersistableUrl(tab.lastKnownUrl || view.webContents.getURL() || '');
    const historyRecord = embeddedBrowserHistory.find((item) => item.url === recordUrl);
    if (historyRecord) historyRecord.faviconUrl = nextFaviconUrl || undefined;
    const bookmarkRecord = embeddedBrowserBookmarks.get(recordUrl);
    if (bookmarkRecord) bookmarkRecord.faviconUrl = nextFaviconUrl || undefined;
    writeEmbeddedBrowserPersistence();
    scheduleEmbeddedBrowserPersistence();
    notifyEmbeddedBrowserStateChange();
  });
  view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) {
      tab.routeLoadingUntil = 0;
      notifyEmbeddedBrowserStateChange();
    }
    if (errorCode === -3) return;
    appendLog(`Embedded browser failed to load ${validatedURL}: ${errorCode} ${errorDescription}`);
  });
  view.webContents.once('destroyed', () => {
    embeddedBrowserTabs.delete(tab.id);
    const group = embeddedBrowserGroups.get(tab.groupId);
    if (group?.activeTabId === tab.id) group.activeTabId = embeddedBrowserTabsForGroup(tab.groupId)[0]?.id || '';
    if (group && String(group.sessionId || '').startsWith('actor_') && !embeddedBrowserTabsForGroup(tab.groupId).length) {
      const actorSessionId = group.sessionId;
      closeEmbeddedBrowserGroup(tab.groupId, { rememberClosed: false });
      void clearEmbeddedBrowserPartition(actorSessionId).catch((error) => {
        appendLog(`Actor browser partition cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }
    if (embeddedBrowserActiveTabId === tab.id) {
      embeddedBrowserActiveTabId = '';
      embeddedBrowserView = undefined;
      embeddedBrowserAttached = false;
    }
    scheduleEmbeddedBrowserPersistence();
    notifyEmbeddedBrowserStateChange();
  });
}

function installHtmlFullscreenRecovery(webContents) {
  if (!webContents || webContents.__webPilotHtmlFullscreenRecoveryInstalled) return;
  webContents.__webPilotHtmlFullscreenRecoveryInstalled = true;
  webContents.on('enter-html-full-screen', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    htmlFullscreenWebContentsIds.add(webContents.id);
    htmlFullscreenWindowState ??= { maximized: mainWindow.isMaximized() };
  });
  webContents.on('leave-html-full-screen', () => {
    htmlFullscreenWebContentsIds.delete(webContents.id);
    if (htmlFullscreenWebContentsIds.size || !mainWindow || mainWindow.isDestroyed()) return;
    const windowState = htmlFullscreenWindowState;
    htmlFullscreenWindowState = undefined;
    // Chromium occasionally leaves a Windows BrowserWindow in native fullscreen
    // after an HTML5 video has already exited. Explicitly restoring the native
    // window brings both the application chrome and the Windows taskbar back.
    if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
    if (windowState?.maximized && !mainWindow.isMaximized()) mainWindow.maximize();
    mainWindow.setMenuBarVisibility(false);
    mainWindow.show();
    mainWindow.focus();
    const tab = activeEmbeddedBrowserTab();
    if (embeddedBrowserVisible && tab && ensureEmbeddedBrowserTabAttached(tab)) {
      tab.view.setBounds(embeddedBrowserBounds);
    }
    if (embeddedBrowserLibraryPanel) attachEmbeddedBrowserLibraryView();
    notifyEmbeddedBrowserStateChange();
  });
  webContents.once('destroyed', () => {
    htmlFullscreenWebContentsIds.delete(webContents.id);
    if (!htmlFullscreenWebContentsIds.size) htmlFullscreenWindowState = undefined;
  });
}

function createEmbeddedBrowserTab(input = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Main window is not ready.');
  if (!WebContentsView) throw new Error('Electron WebContentsView is not available.');
  const group = ensureEmbeddedBrowserGroup(input);
  const sessionId = normalizeEmbeddedBrowserSessionId(input.sessionId) || embeddedBrowserSessionIdFromGroupId(group.id) || group.sessionId;
  const userId = normalizeEmbeddedBrowserUserId(input.userId) || normalizeEmbeddedBrowserUserId(group.userId);
  const tabId = input.id || `tab:${embeddedBrowserNextTabId++}`;
  const rawInitialUrl = String(input.url || '').trim();
  const initialUrl = rawInitialUrl
    ? normalizeEmbeddedBrowserOpenUrl(rawInitialUrl, mainWindow?.webContents?.getURL?.() || '')
    : embeddedBrowserPlaceholderUrl();
  if (rawInitialUrl && !initialUrl) throw new Error(`Invalid embedded browser URL: ${rawInitialUrl}`);
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: embeddedBrowserPartition(userId ? `user:${userId}` : `session:${sessionId}`),
      preload: embeddedBrowserPreloadPath(),
      sandbox: false,
    },
  });
  installNativeDownloadHandler(view.webContents.session);
  const tab = {
    audioMuted: Boolean(input.audioMuted),
    attached: false,
    createdAt: Date.now(),
    faviconUrl: embeddedBrowserFaviconUrl(input.faviconUrl),
    groupId: group.id,
    id: tabId,
    lastKnownTitle: embeddedBrowserRecordTitle(input.title),
    lastKnownUrl: initialUrl,
    pinned: Boolean(input.pinned),
    readyPromise: undefined,
    restorePending: Boolean(input.restore),
    sessionId,
    userId,
    view,
  };
  applyEmbeddedBrowserTabAudioPolicy(tab);
  view.webContents.setUserAgent(embeddedBrowserUserAgent());
  embeddedBrowserTabs.set(tab.id, tab);
  if (!input.restore) group.collapsed = false;
  group.activeTabId = tab.id;
  writeEmbeddedBrowserPersistence();
  scheduleEmbeddedBrowserPersistence();
  notifyEmbeddedBrowserStateChange();
  installEmbeddedBrowserTabHandlers(tab);
  tab.readyPromise = loadEmbeddedBrowserTabUrl(tab, initialUrl, { restore: tab.restorePending }).catch((error) => {
    appendLog(`Embedded browser initial load failed: ${error.message}`);
  });
  return tab;
}

function ensureEmbeddedBrowserTab(input = {}) {
  const group = ensureEmbeddedBrowserGroup(input);
  const tabId = String(input.id || '').trim();
  const requestedSessionId = normalizeEmbeddedBrowserSessionId(input.sessionId);
  let tab = tabId ? embeddedBrowserTabs.get(tabId) : requestedSessionId && !group.id.startsWith('session:')
    ? embeddedBrowserTabsForGroup(group.id).find((item) => item.sessionId === requestedSessionId)
    : embeddedBrowserTabs.get(group.activeTabId);
  if (tab?.view.webContents.isDestroyed()) {
    embeddedBrowserTabs.delete(tab.id);
    tab = undefined;
  }
  if (tab?.groupId !== group.id) tab = undefined;

  if (!tab && !(requestedSessionId && !group.id.startsWith('session:'))) {
    tab = embeddedBrowserTabsForGroup(group.id)[0];
  }

  if (!tab && input.createIfMissing !== false) {
    const sessionId = normalizeEmbeddedBrowserSessionId(input.sessionId) || embeddedBrowserSessionIdFromGroupId(group.id) || group.sessionId;
    tab = createEmbeddedBrowserTab({ groupId: group.id, sessionId, userId: input.userId || group.userId });
  }
  return tab;
}

function detachEmbeddedBrowserTab(tab) {
  if (!mainWindow || !tab?.attached) return;
  try {
    mainWindow.contentView.removeChildView(tab.view);
  } catch (error) {
    appendLog(`Embedded browser detach failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  tab.attached = false;
  if (embeddedBrowserActiveTabId === tab.id) embeddedBrowserAttached = false;
}

function destroyEmbeddedBrowserTab(tab) {
  if (!tab) return;
  detachEmbeddedBrowserTab(tab);
  embeddedBrowserTabs.delete(tab.id);
  const group = embeddedBrowserGroups.get(tab.groupId);
  if (group?.activeTabId === tab.id) group.activeTabId = embeddedBrowserTabsForGroup(tab.groupId)[0]?.id || '';
  try {
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  } catch (error) {
    appendLog(`Embedded browser tab close failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (embeddedBrowserActiveTabId === tab.id) {
    embeddedBrowserActiveTabId = '';
    embeddedBrowserView = undefined;
    embeddedBrowserAttached = false;
  }
  writeEmbeddedBrowserPersistence();
  scheduleEmbeddedBrowserPersistence();
  notifyEmbeddedBrowserStateChange();
}

// A renderer reload can leave a WebContentsView marked as attached even though
// Electron has removed it from the window's content view. Re-adding it is
// idempotent and moves the native view back to the front when needed.
function ensureEmbeddedBrowserTabAttached(tab) {
  if (!mainWindow || mainWindow.isDestroyed() || !tab || tab.view.webContents.isDestroyed()) return false;
  try {
    mainWindow.contentView.addChildView(tab.view);
    tab.attached = true;
    embeddedBrowserAttached = true;
    tab.view.setVisible(true);
    return true;
  } catch (error) {
    tab.attached = false;
    appendLog(`Embedded browser attach failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function attachEmbeddedBrowserView(input = {}) {
  const restoredTab = embeddedBrowserVisible ? undefined : activeEmbeddedBrowserTab();
  embeddedBrowserVisible = true;
  applyEmbeddedBrowserAudioPolicy();
  const groupId = embeddedBrowserGroupId(input);
  const shouldCreateTab = input.createIfMissing === true;
  const existingGroup = embeddedBrowserGroups.get(groupId);
  let tab;
  if (shouldCreateTab || existingGroup) {
    tab = ensureEmbeddedBrowserTab({ ...input, createIfMissing: shouldCreateTab });
  }
  if (!tab && !shouldCreateTab && restoredTab?.groupId === groupId && !restoredTab.view.webContents.isDestroyed()) {
    tab = restoredTab;
  }
  if (!tab) {
    embeddedBrowserVisible = false;
    applyEmbeddedBrowserAudioPolicy();
    setActiveEmbeddedBrowserGroup(groupId);
    for (const item of embeddedBrowserTabs.values()) detachEmbeddedBrowserTab(item);
    return undefined;
  }
  for (const item of embeddedBrowserTabs.values()) {
    if (item.id !== tab.id) detachEmbeddedBrowserTab(item);
  }
  ensureEmbeddedBrowserTabAttached(tab);
  setActiveEmbeddedBrowserTab(tab);
  tab.view.setBounds(embeddedBrowserBounds);
  try {
    ensureEmbeddedBrowserLibraryView();
  } catch (error) {
    appendLog(`Embedded browser library preload failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  attachEmbeddedBrowserLibraryView();
  void markEmbeddedBrowserSession(tab);
  return tab.view;
}

function detachEmbeddedBrowserView() {
  embeddedBrowserVisible = false;
  applyEmbeddedBrowserAudioPolicy();
  for (const tab of embeddedBrowserTabs.values()) detachEmbeddedBrowserTab(tab);
  embeddedBrowserAttached = false;
  destroyEmbeddedBrowserLibraryView();
  notifyEmbeddedBrowserStateChange();
}

function setEmbeddedBrowserBounds(bounds) {
  embeddedBrowserBounds = sanitizeEmbeddedBounds(bounds);
  const tab = activeEmbeddedBrowserTab();
  if (embeddedBrowserVisible && tab && ensureEmbeddedBrowserTabAttached(tab)) {
    tab.view.setBounds(embeddedBrowserBounds);
  }
  if (embeddedBrowserLibraryPanel) attachEmbeddedBrowserLibraryView();
  return embeddedBrowserBounds;
}

function embeddedBrowserNavigationState(tab) {
  if (!tab || tab.view.webContents.isDestroyed()) return { canGoBack: false, canGoForward: false };
  const webContents = tab.view.webContents;
  const history = webContents.navigationHistory;
  const nativeCanGoBack = (typeof history?.canGoBack === 'function' && history.canGoBack())
    || (typeof webContents.canGoBack === 'function' && webContents.canGoBack());
  const nativeCanGoForward = (typeof history?.canGoForward === 'function' && history.canGoForward())
    || (typeof webContents.canGoForward === 'function' && webContents.canGoForward());
  const clientNavigation = tab.clientNavigation || {};
  return {
    canGoBack: Boolean(nativeCanGoBack || clientNavigation.canGoBack),
    canGoForward: Boolean(nativeCanGoForward || clientNavigation.canGoForward),
  };
}

async function navigateEmbeddedBrowserHistory(direction) {
  const tab = activeEmbeddedBrowserTab();
  if (!tab || tab.view.webContents.isDestroyed()) return embeddedBrowserState();
  const webContents = tab.view.webContents;
  const history = webContents.navigationHistory;
  if (direction === 'back') {
    const historyCanGoBack = typeof history?.canGoBack === 'function' && history.canGoBack();
    const webContentsCanGoBack = typeof webContents.canGoBack === 'function' && webContents.canGoBack();
    const canGoBack = Boolean(historyCanGoBack || webContentsCanGoBack || tab.clientNavigation?.canGoBack);
    if (!canGoBack) return embeddedBrowserState();
    const clientNavigated = await webContents.executeJavaScript('window.history.back(); true', true).catch((error) => {
      appendLog(`Embedded browser client back failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    });
    if (!clientNavigated) {
      if (historyCanGoBack && typeof history?.goBack === 'function') history.goBack();
      else if (webContentsCanGoBack && typeof webContents.goBack === 'function') webContents.goBack();
    }
  } else {
    const historyCanGoForward = typeof history?.canGoForward === 'function' && history.canGoForward();
    const webContentsCanGoForward = typeof webContents.canGoForward === 'function' && webContents.canGoForward();
    const canGoForward = Boolean(historyCanGoForward || webContentsCanGoForward || tab.clientNavigation?.canGoForward);
    if (!canGoForward) return embeddedBrowserState();
    const clientNavigated = await webContents.executeJavaScript('window.history.forward(); true', true).catch((error) => {
      appendLog(`Embedded browser client forward failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    });
    if (!clientNavigated) {
      if (historyCanGoForward && typeof history?.goForward === 'function') history.goForward();
      else if (webContentsCanGoForward && typeof webContents.goForward === 'function') webContents.goForward();
    }
  }
  tab.routeLoadingUntil = Date.now() + EMBEDDED_BROWSER_ROUTE_LOADING_MS;
  return embeddedBrowserState();
}

function reloadEmbeddedBrowserTab() {
  const tab = activeEmbeddedBrowserTab();
  if (!tab || tab.view.webContents.isDestroyed()) return embeddedBrowserState();
  tab.routeLoadingUntil = Date.now() + EMBEDDED_BROWSER_ROUTE_LOADING_MS;
  tab.view.webContents.reload();
  notifyEmbeddedBrowserStateChange();
  return embeddedBrowserState();
}

function stopEmbeddedBrowserTabLoading() {
  const tab = activeEmbeddedBrowserTab();
  if (!tab || tab.view.webContents.isDestroyed()) return embeddedBrowserState();
  tab.routeLoadingUntil = 0;
  tab.view.webContents.stop();
  notifyEmbeddedBrowserStateChange();
  return embeddedBrowserState();
}

function embeddedBrowserState() {
  const active = activeEmbeddedBrowserTab();
  const navigation = embeddedBrowserNavigationState(active);
  const tabs = [];
  const groups = [];
  let activeIndex = -1;
  let index = 0;
  for (const tab of embeddedBrowserTabs.values()) {
    if (tab.view.webContents.isDestroyed() || embeddedBrowserGroups.has(tab.groupId)) continue;
    embeddedBrowserGroups.set(tab.groupId, {
      activeTabId: tab.id,
      collapsed: false,
      createdAt: tab.createdAt || Date.now(),
      id: tab.groupId,
      sessionId: tab.sessionId || '',
      userId: tab.userId || '',
    });
  }

  for (const group of embeddedBrowserGroups.values()) {
    const groupTabs = [];
    for (const tab of embeddedBrowserTabs.values()) {
      if (tab.groupId !== group.id || tab.view.webContents.isDestroyed()) continue;
      const canonicalSessionId = embeddedBrowserSessionIdFromGroupId(tab.groupId) || tab.sessionId || group.sessionId || '';
      if (canonicalSessionId && tab.sessionId !== canonicalSessionId) {
        tab.sessionId = canonicalSessionId;
        void markEmbeddedBrowserSession(tab);
      }
      if (group.id.startsWith('session:') && canonicalSessionId && group.sessionId !== canonicalSessionId) {
        group.sessionId = canonicalSessionId;
      }
      const webContents = tab.view.webContents;
      const url = webContents.getURL() || '';
      const liveTitle = embeddedBrowserTabTitle(webContents);
      if (!tab.lastKnownTitle && liveTitle) tab.lastKnownTitle = embeddedBrowserRecordTitle(liveTitle);
      const title = tab.lastKnownTitle || liveTitle;
      const item = {
        audioMuted: Boolean(tab.audioMuted),
        bookmarked: embeddedBrowserIsBookmarked(tab.lastKnownUrl || url),
        faviconUrl: embeddedBrowserFaviconUrl(tab.faviconUrl) || undefined,
        groupId: tab.groupId,
        id: tab.id,
        loading: webContents.isLoading(),
        pinned: Boolean(tab.pinned),
        sessionId: tab.sessionId || undefined,
        userId: tab.userId || undefined,
        title,
        url,
      };
      if (tab.id === embeddedBrowserActiveTabId) activeIndex = index;
      tabs.push(item);
      groupTabs.push(item);
      index += 1;
    }
    groups.push({
      active: group.id === embeddedBrowserActiveGroupId,
      activeTabId: group.activeTabId || undefined,
      collapsed: Boolean(group.collapsed),
      id: group.id,
      label: group.label || undefined,
      sessionId: group.sessionId || undefined,
      userId: group.userId || undefined,
      tabs: groupTabs,
    });
  }
  return {
    ok: true,
    activeGroupId: embeddedBrowserActiveGroupId || undefined,
    activeIndex,
    activeTabId: embeddedBrowserActiveTabId || undefined,
    bookmarks: embeddedBrowserBookmarkList(),
    canGoBack: navigation.canGoBack,
    canGoForward: navigation.canGoForward,
    groups,
    history: embeddedBrowserHistory,
    libraryPanel: embeddedBrowserLibraryPanel || undefined,
    tabs,
  };
}

function rememberClosedEmbeddedBrowserTab(tab) {
  if (!tab || tab.view.webContents.isDestroyed()) return;
  embeddedBrowserRecentlyClosedTabs.push({
    audioMuted: Boolean(tab.audioMuted),
    faviconUrl: embeddedBrowserFaviconUrl(tab.faviconUrl),
    groupId: tab.groupId,
    pinned: Boolean(tab.pinned),
    sessionId: tab.sessionId || undefined,
    userId: tab.userId || undefined,
    title: embeddedBrowserRecordTitle(tab.lastKnownTitle),
    url: embeddedBrowserPersistableUrl(tab.lastKnownUrl || tab.view.webContents.getURL() || ''),
  });
  if (embeddedBrowserRecentlyClosedTabs.length > 20) embeddedBrowserRecentlyClosedTabs.splice(0, embeddedBrowserRecentlyClosedTabs.length - 20);
}

function openEmbeddedBrowserTabFromRecord(record = {}, options = {}) {
  const group = ensureEmbeddedBrowserGroup({
    groupId: record.groupId || embeddedBrowserActiveGroupId || 'default',
    sessionId: record.sessionId,
    userId: record.userId,
  });
  const tab = createEmbeddedBrowserTab({
    audioMuted: Boolean(record.audioMuted),
    faviconUrl: embeddedBrowserFaviconUrl(record.faviconUrl),
    groupId: group.id,
    pinned: Boolean(options.pinned ?? record.pinned),
    sessionId: embeddedBrowserSessionIdFromGroupId(group.id) || group.sessionId || normalizeEmbeddedBrowserSessionId(record.sessionId),
    userId: normalizeEmbeddedBrowserUserId(record.userId) || group.userId,
    title: embeddedBrowserRecordTitle(record.title),
    url: embeddedBrowserPersistableUrl(record.url),
  });
  if (tab.pinned) setEmbeddedBrowserTabPinned({ id: tab.id, pinned: true });
  if (embeddedBrowserVisible) attachEmbeddedBrowserView({ id: tab.id });
  else setActiveEmbeddedBrowserTab(tab);
  return tab;
}

function reopenClosedEmbeddedBrowserTab() {
  const record = embeddedBrowserRecentlyClosedTabs.pop();
  if (!record) return embeddedBrowserState();
  openEmbeddedBrowserTabFromRecord(record);
  return embeddedBrowserState();
}

function duplicateEmbeddedBrowserTab(tabIdInput) {
  const tabId = String(tabIdInput || '').trim();
  const source = tabId ? embeddedBrowserTabs.get(tabId) : activeEmbeddedBrowserTab();
  if (!source || source.view.webContents.isDestroyed()) return embeddedBrowserState();
  const duplicate = openEmbeddedBrowserTabFromRecord({
    audioMuted: source.audioMuted,
    faviconUrl: source.faviconUrl,
    groupId: source.groupId,
    sessionId: source.sessionId,
    title: source.lastKnownTitle,
    url: source.lastKnownUrl || source.view.webContents.getURL() || '',
  }, { pinned: false });
  moveEmbeddedBrowserTab({ id: duplicate.id, position: 'after', targetId: source.id });
  if (embeddedBrowserVisible) attachEmbeddedBrowserView({ id: duplicate.id });
  else setActiveEmbeddedBrowserTab(duplicate);
  return embeddedBrowserState();
}

function setEmbeddedBrowserTabPinned(input = {}) {
  const tabId = String(input.id || '').trim();
  const tab = tabId ? embeddedBrowserTabs.get(tabId) : activeEmbeddedBrowserTab();
  if (!tab || tab.view.webContents.isDestroyed()) return embeddedBrowserState();
  tab.pinned = typeof input.pinned === 'boolean' ? input.pinned : !tab.pinned;
  const siblings = embeddedBrowserTabsForGroup(tab.groupId).filter((item) => item.id !== tab.id);
  let target;
  let position = 'end';
  if (tab.pinned) {
    target = [...siblings].reverse().find((item) => item.pinned) || siblings[0];
    position = siblings.some((item) => item.pinned) ? 'after' : 'before';
  } else {
    target = siblings.at(-1);
    position = target ? 'after' : 'end';
  }
  if (target) return moveEmbeddedBrowserTab({ id: tab.id, position, targetId: target.id });
  writeEmbeddedBrowserPersistence();
  scheduleEmbeddedBrowserPersistence();
  notifyEmbeddedBrowserStateChange();
  return embeddedBrowserState();
}

function closeOtherEmbeddedBrowserTabs(tabIdInput) {
  const tabId = String(tabIdInput || '').trim();
  const selected = tabId ? embeddedBrowserTabs.get(tabId) : activeEmbeddedBrowserTab();
  if (!selected || selected.view.webContents.isDestroyed()) return embeddedBrowserState();
  const closingTabs = embeddedBrowserTabsForGroup(selected.groupId)
    .filter((tab) => tab.id !== selected.id && !tab.pinned);
  const activeWasClosed = closingTabs.some((tab) => tab.id === embeddedBrowserActiveTabId);
  for (const tab of closingTabs) {
    rememberClosedEmbeddedBrowserTab(tab);
    destroyEmbeddedBrowserTab(tab);
  }
  if (activeWasClosed) {
    if (embeddedBrowserVisible) attachEmbeddedBrowserView({ id: selected.id });
    else setActiveEmbeddedBrowserTab(selected);
  }
  writeEmbeddedBrowserPersistence();
  scheduleEmbeddedBrowserPersistence();
  notifyEmbeddedBrowserStateChange();
  return embeddedBrowserState();
}

function closeEmbeddedBrowserTab(tabId) {
  const tab = embeddedBrowserTabs.get(tabId) || activeEmbeddedBrowserTab();
  if (!tab) return embeddedBrowserState();
  const currentTabs = embeddedBrowserTabsForGroup(tab.groupId);
  const tabIndex = Math.max(0, currentTabs.findIndex((item) => item.id === tab.id));
  const wasActive = embeddedBrowserActiveTabId === tab.id;
  rememberClosedEmbeddedBrowserTab(tab);
  destroyEmbeddedBrowserTab(tab);

  let nextTab;
  const remainingTabs = embeddedBrowserTabsForGroup(tab.groupId);
  if (wasActive && remainingTabs.length) {
    nextTab = remainingTabs[Math.max(0, Math.min(tabIndex - 1, remainingTabs.length - 1))] || remainingTabs[0];
  } else if (!wasActive) {
    nextTab = activeEmbeddedBrowserTab() || remainingTabs[0];
  }

  if (nextTab) {
    if (embeddedBrowserVisible) attachEmbeddedBrowserView({ id: nextTab.id });
    else setActiveEmbeddedBrowserTab(nextTab);
  } else if (wasActive) {
    setActiveEmbeddedBrowserGroup(tab.groupId);
  }
  return embeddedBrowserState();
}

function closeEmbeddedBrowserGroup(groupIdInput, options = {}) {
  const groupId = String(groupIdInput || embeddedBrowserActiveGroupId || '').trim();
  if (!groupId) return embeddedBrowserState();

  const group = embeddedBrowserGroups.get(groupId);
  const groupTabs = embeddedBrowserTabsForGroup(groupId);
  if (!group && !groupTabs.length) return embeddedBrowserState();

  const wasActiveGroup = embeddedBrowserActiveGroupId === groupId
    || groupTabs.some((tab) => tab.id === embeddedBrowserActiveTabId);

  for (const tab of groupTabs) {
    if (options.rememberClosed !== false) rememberClosedEmbeddedBrowserTab(tab);
    destroyEmbeddedBrowserTab(tab);
  }
  embeddedBrowserGroups.delete(groupId);
  writeEmbeddedBrowserPersistence();
  scheduleEmbeddedBrowserPersistence();
  notifyEmbeddedBrowserStateChange();

  if (wasActiveGroup) {
    const nextTab = Array.from(embeddedBrowserTabs.values()).find((tab) => !tab.view.webContents.isDestroyed());
    if (nextTab) {
      if (embeddedBrowserVisible) attachEmbeddedBrowserView({ id: nextTab.id });
      else setActiveEmbeddedBrowserTab(nextTab);
    } else {
      embeddedBrowserActiveGroupId = '';
      embeddedBrowserActiveTabId = '';
      embeddedBrowserView = undefined;
      embeddedBrowserAttached = false;
    }
  }

  return embeddedBrowserState();
}

function moveEmbeddedBrowserTab(input = {}) {
  const tabId = String(input.id || '').trim();
  const targetId = String(input.targetId || '').trim();
  const requestedGroupId = String(input.targetGroupId || '').trim();
  const position = input.position === 'before' ? 'before' : input.position === 'after' ? 'after' : 'end';
  if (!tabId) return embeddedBrowserState();

  const tab = embeddedBrowserTabs.get(tabId);
  const target = targetId ? embeddedBrowserTabs.get(targetId) : undefined;
  if (!tab || tab.view.webContents.isDestroyed() || (target && target.view.webContents.isDestroyed())) {
    return embeddedBrowserState();
  }
  if (target?.id === tab.id && !requestedGroupId) return embeddedBrowserState();

  const sourceGroup = embeddedBrowserGroups.get(tab.groupId);
  const destinationGroupId = target?.groupId || requestedGroupId || tab.groupId;
  const destinationGroup = embeddedBrowserGroups.get(destinationGroupId);
  if (!destinationGroup) throw new Error('Target tab group was not found.');
  const movedActiveTab = embeddedBrowserActiveTabId === tab.id;
  const previousGroupId = tab.groupId;

  const orderedTabs = Array.from(embeddedBrowserTabs.values()).filter((item) => item.id !== tab.id);
  tab.groupId = destinationGroup.id;
  tab.sessionId = embeddedBrowserSessionIdFromGroupId(destinationGroup.id)
    || normalizeEmbeddedBrowserSessionId(input.targetSessionId)
    || tab.sessionId
    || destinationGroup.sessionId;
  if (destinationGroup.id.startsWith('session:')) {
    destinationGroup.sessionId = tab.sessionId || destinationGroup.sessionId || '';
  }
  destinationGroup.collapsed = false;

  let insertionIndex = orderedTabs.length;
  if (target && target.id !== tab.id) {
    const targetIndex = orderedTabs.findIndex((item) => item.id === target.id);
    if (targetIndex >= 0) insertionIndex = targetIndex + (position === 'after' ? 1 : 0);
  } else {
    for (let index = orderedTabs.length - 1; index >= 0; index -= 1) {
      if (orderedTabs[index].groupId === destinationGroup.id) {
        insertionIndex = index + 1;
        break;
      }
    }
  }
  orderedTabs.splice(insertionIndex, 0, tab);

  const destinationIndexes = [];
  const destinationTabs = [];
  for (let index = 0; index < orderedTabs.length; index += 1) {
    if (orderedTabs[index].groupId !== destinationGroup.id) continue;
    destinationIndexes.push(index);
    destinationTabs.push(orderedTabs[index]);
  }
  const partitionedDestinationTabs = [
    ...destinationTabs.filter((item) => item.pinned),
    ...destinationTabs.filter((item) => !item.pinned),
  ];
  for (let index = 0; index < destinationIndexes.length; index += 1) {
    orderedTabs[destinationIndexes[index]] = partitionedDestinationTabs[index];
  }

  if (sourceGroup && sourceGroup.id !== destinationGroup.id && sourceGroup.activeTabId === tab.id) {
    sourceGroup.activeTabId = orderedTabs.find((item) => item.groupId === sourceGroup.id)?.id || '';
  }
  if (!destinationGroup.activeTabId || movedActiveTab) destinationGroup.activeTabId = tab.id;
  if (movedActiveTab) embeddedBrowserActiveGroupId = destinationGroup.id;

  embeddedBrowserTabs.clear();
  for (const item of orderedTabs) embeddedBrowserTabs.set(item.id, item);
  if (previousGroupId !== destinationGroup.id) void markEmbeddedBrowserSession(tab);
  writeEmbeddedBrowserPersistence();
  scheduleEmbeddedBrowserPersistence();
  notifyEmbeddedBrowserStateChange();
  return embeddedBrowserState();
}

async function createManualEmbeddedBrowserTab(input = {}) {
  const group = ensureEmbeddedBrowserGroup(input);
  const sessionId = embeddedBrowserSessionIdFromGroupId(group.id) || group.sessionId || normalizeEmbeddedBrowserSessionId(input.sessionId);
  const rawUrl = String(input.url || '').trim();
  const url = rawUrl ? normalizeEmbeddedBrowserOpenUrl(rawUrl, mainWindow?.webContents?.getURL?.() || '') : '';
  if (rawUrl && !url) throw new Error(`Invalid embedded browser URL: ${rawUrl}`);
  const tab = createEmbeddedBrowserTab({ groupId: group.id, sessionId, userId: input.userId || group.userId, url });
  if (embeddedBrowserVisible) attachEmbeddedBrowserView({ id: tab.id });
  else setActiveEmbeddedBrowserTab(tab);
  ensureEmbeddedBrowserTabReady(tab)
    .catch((error) => appendLog(`Embedded browser tab ready failed: ${error instanceof Error ? error.message : String(error)}`));
  return embeddedBrowserState();
}

function showEmbeddedBrowserTabContextMenu(input = {}) {
  const tab = embeddedBrowserTabs.get(String(input.id || '').trim());
  if (!tab || tab.view.webContents.isDestroyed() || !mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, error: 'Embedded browser tab not found.' };
  }
  const labels = new Map((Array.isArray(input.groups) ? input.groups : []).flatMap((item) => {
    const id = String(item?.id || '').trim();
    return id ? [[id, embeddedBrowserRecordTitle(item?.label, id)]] : [];
  }));
  const moveTargets = Array.from(embeddedBrowserGroups.values()).filter((group) => group.id !== tab.groupId);
  const closeableOtherTabs = embeddedBrowserTabsForGroup(tab.groupId)
    .filter((item) => item.id !== tab.id && !item.pinned);
  const menu = Menu.buildFromTemplate([
    {
      label: '复制标签页',
      click: () => duplicateEmbeddedBrowserTab(tab.id),
    },
    {
      label: tab.pinned ? '取消固定标签页' : '固定标签页',
      click: () => setEmbeddedBrowserTabPinned({ id: tab.id, pinned: !tab.pinned }),
    },
    {
      enabled: closeableOtherTabs.length > 0,
      label: '关闭其他标签页',
      click: () => closeOtherEmbeddedBrowserTabs(tab.id),
    },
    { type: 'separator' },
    {
      enabled: moveTargets.length > 0,
      label: '移动到分组',
      submenu: moveTargets.map((group) => ({
        label: labels.get(group.id) || `标签组 ${String(group.sessionId || group.id).slice(-6)}`,
        click: () => moveEmbeddedBrowserTab({
          id: tab.id,
          position: 'end',
          targetGroupId: group.id,
          targetSessionId: group.sessionId,
        }),
      })),
    },
  ]);
  menu.popup({ window: mainWindow });
  return { ok: true };
}

function registerEmbeddedBrowserIpc() {
  ipcMain.on('webpilot:embedded-browser:client-navigation', (event, payload = {}) => {
    const tab = embeddedBrowserTabForWebContents(event.sender);
    if (!tab) return;
    tab.clientNavigation = {
      canGoBack: Boolean(payload.canGoBack),
      canGoForward: Boolean(payload.canGoForward),
      index: Number.isFinite(Number(payload.index)) ? Number(payload.index) : 0,
      length: Number.isFinite(Number(payload.length)) ? Number(payload.length) : 1,
      url: typeof payload.url === 'string' ? payload.url : '',
    };
    if (tab.clientNavigation.url) tab.lastKnownUrl = tab.clientNavigation.url;
    tab.restorePending = false;
    tab.routeLoadingUntil = Date.now() + EMBEDDED_BROWSER_ROUTE_LOADING_MS;
    recordEmbeddedBrowserHistory(tab);
    notifyEmbeddedBrowserStateChange();
  });

  ipcMain.handle('webpilot:embedded-browser:get-state', async () => {
    try {
      return embeddedBrowserState();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:embedded-browser:create-tab', async (_event, input = {}) => {
    try {
      return await createManualEmbeddedBrowserTab(input);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:embedded-browser:create-group', async (_event, input = {}) => {
    try {
      return createManualEmbeddedBrowserGroup(input);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:embedded-browser:set-library-panel', async (_event, input = {}) => {
    try {
      const requestedPanel = input.panel === 'library' ? input.panel : '';
      const nextPanel = input.toggle && embeddedBrowserLibraryPanel === requestedPanel ? '' : requestedPanel;
      return setEmbeddedBrowserLibraryPanel(nextPanel);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:embedded-browser:clear-history', async () => {
    try {
      return clearEmbeddedBrowserHistory();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:embedded-browser:remove-bookmark', async (_event, input = {}) => {
    try {
      return removeEmbeddedBrowserBookmark(typeof input.url === 'string' ? input.url : '');
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:embedded-browser:set-tab-muted', async (_event, input = {}) => {
    try {
      return setEmbeddedBrowserTabMuted({ id: input.id, muted: input.muted });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:embedded-browser:go-back', async () => {
    try {
      return await navigateEmbeddedBrowserHistory('back');
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:embedded-browser:go-forward', async () => {
    try {
      return await navigateEmbeddedBrowserHistory('forward');
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:embedded-browser:reload', async () => {
    try {
      return reloadEmbeddedBrowserTab();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:embedded-browser:stop', async () => {
    try {
      return stopEmbeddedBrowserTabLoading();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:embedded-browser:toggle-bookmark', async () => {
    try {
      return toggleEmbeddedBrowserBookmark();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:embedded-browser:set-visible', async (_event, input = {}) => {
    try {
      if (input.bounds) setEmbeddedBrowserBounds(input.bounds);
      if (input.visible) {
        attachEmbeddedBrowserView({
          createIfMissing: input.createIfMissing === true,
          groupId: input.groupId,
          id: input.id,
          sessionId: input.sessionId,
          userId: input.userId,
        });
        const tab = activeEmbeddedBrowserTab();
        if (typeof input.url === 'string' && input.url.trim()) {
          if (!tab) throw new Error('Embedded browser tab is not ready.');
          await loadEmbeddedBrowserTabUrl(tab, input.url.trim());
        } else if (tab) {
          void ensureEmbeddedBrowserTabReady(tab);
        }
      } else {
        detachEmbeddedBrowserView();
      }
      return embeddedBrowserState();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:embedded-browser:set-bounds', async (_event, bounds = {}) => {
    try {
      return { ok: true, bounds: setEmbeddedBrowserBounds(bounds) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:embedded-browser:navigate', async (_event, input = {}) => {
    try {
      const url = typeof input.url === 'string' ? input.url.trim() : '';
      if (!url) throw new Error('URL is empty.');
      attachEmbeddedBrowserView({
        createIfMissing: true,
        groupId: input.groupId,
        id: input.id,
        sessionId: input.sessionId,
      });
      const tab = activeEmbeddedBrowserTab();
      if (!tab) throw new Error('Embedded browser tab is not ready.');
      await loadEmbeddedBrowserTabUrl(tab, url);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:embedded-browser:move-tab', async (_event, input = {}) => {
    try {
      return moveEmbeddedBrowserTab(input);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:embedded-browser:show-tab-context-menu', async (_event, input = {}) => {
    try {
      return showEmbeddedBrowserTabContextMenu(input);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:embedded-browser:set-group-collapsed', async (_event, input = {}) => {
    try {
      return setEmbeddedBrowserGroupCollapsed(input);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:embedded-browser:close-active-tab', async () => {
    try {
      return closeEmbeddedBrowserTab(embeddedBrowserActiveTabId);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:embedded-browser:close-tab', async (_event, input = {}) => {
    try {
      return closeEmbeddedBrowserTab(typeof input.id === 'string' ? input.id : embeddedBrowserActiveTabId);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:embedded-browser:close-group', async (_event, input = {}) => {
    try {
      return closeEmbeddedBrowserGroup(typeof input.id === 'string' ? input.id : embeddedBrowserActiveGroupId);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:embedded-browser:discard-group', async (_event, input = {}) => {
    try {
      const groupId = typeof input.id === 'string' ? input.id : '';
      const sessionId = embeddedBrowserSessionIdFromGroupId(groupId)
        || normalizeEmbeddedBrowserSessionId(embeddedBrowserGroups.get(groupId)?.sessionId);
      const userId = normalizeEmbeddedBrowserUserId(embeddedBrowserGroups.get(groupId)?.userId);
      const state = closeEmbeddedBrowserGroup(groupId, { rememberClosed: false });
      const userPartitionStillInUse = Boolean(userId) && Array.from(embeddedBrowserGroups.values())
        .some((group) => normalizeEmbeddedBrowserUserId(group.userId) === userId);
      if (input.clearStorage === true && (sessionId || userId) && !userPartitionStillInUse) {
        await clearEmbeddedBrowserPartition(sessionId, userId);
      }
      return state;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:embedded-browser:activate-tab', async (_event, input = {}) => {
    try {
      const id = typeof input.id === 'string' ? input.id : '';
      const tab = id ? embeddedBrowserTabs.get(id) : undefined;
      if (!tab || tab.view.webContents.isDestroyed()) throw new Error('Embedded browser tab not found.');
      if (embeddedBrowserVisible) attachEmbeddedBrowserView({ id });
      else setActiveEmbeddedBrowserTab(tab);
      return embeddedBrowserState();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:embedded-browser:reset', async () => {
    try {
      attachEmbeddedBrowserView({
        createIfMissing: true,
        groupId: embeddedBrowserActiveGroupId || undefined,
        id: embeddedBrowserActiveTabId || undefined,
      });
      const tab = activeEmbeddedBrowserTab();
      if (!tab) throw new Error('Embedded browser tab is not ready.');
      await loadEmbeddedBrowserTabUrl(tab, embeddedBrowserPlaceholderUrl());
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

function registerSystemIpc() {
  ipcMain.handle('webpilot:system:select-directory', async (_event, input = {}) => {
    try {
      const defaultPath = typeof input.defaultPath === 'string' && input.defaultPath.trim()
        ? input.defaultPath.trim()
        : undefined;
      const result = await dialog.showOpenDialog(mainWindow, {
        defaultPath,
        properties: ['openDirectory', 'createDirectory'],
        title: 'Select file output directory',
      });
      if (result.canceled || !result.filePaths?.[0]) return { ok: true, canceled: true };
      return { ok: true, path: result.filePaths[0] };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:system:download-url', async (_event, input = {}) => {
    try {
      const url = String(input.url || '').trim();
      if (!url) throw new Error('Download URL is required.');
      const webContents = preferredDownloadWebContents();
      return startNativeDownload(webContents, url);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:system:get-downloads', async () => {
    try {
      return systemDownloadState();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:system:remove-download', async (_event, input = {}) => {
    try {
      const id = String(input.id || '');
      const download = systemDownloads.get(id);
      if (!id || !download) throw new Error('下载记录不存在。');
      if (nativeDownloadItems.has(id)) throw new Error('下载进行中，暂时不能删除记录。');
      if (download.path && fs.existsSync(download.path)) {
        const filePath = path.resolve(download.path);
        if (!fs.statSync(filePath).isFile()) throw new Error('下载路径不是文件，无法删除。');
        await shell.trashItem(filePath);
        if (fs.existsSync(filePath)) throw new Error('文件未能移入回收站。');
      }
      systemDownloads.delete(id);
      emitDownloadRemoved(id);
      return { ok: true };
    } catch (error) {
      appendLog(`Download remove failed: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:system:choose-download-directory', async (_event, input = {}) => {
    try {
      return await chooseDownloadDirectory(input);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:system:open-download', async (_event, input = {}) => {
    try {
      const download = systemDownloads.get(String(input.id || ''));
      if (!download?.path || !fs.existsSync(download.path)) throw new Error('下载文件不存在或已被移动。');
      const error = await shell.openPath(download.path);
      return error ? { ok: false, error } : { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:system:show-download-in-folder', async (_event, input = {}) => {
    try {
      const download = systemDownloads.get(String(input.id || ''));
      if (!download?.path || !fs.existsSync(download.path)) throw new Error('下载文件不存在或已被移动。');
      shell.showItemInFolder(download.path);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:system:cancel-download', async (_event, input = {}) => {
    try {
      const id = String(input.id || '');
      const item = nativeDownloadItems.get(id);
      if (!item) throw new Error('该下载已结束。');
      item.cancel();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

async function startServer(appDataDir) {
  const port = await findAvailablePort(Number(process.env.AI_WEB_TEST_PORT || DEFAULT_PORT));
  const serverDir = serverDirectory();
  const serverScript = app.isPackaged
    ? path.join(serverDir, 'server.js')
    : path.join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next');
  const browserProfileDir = ensureDir(path.join(appDataDir, 'browser-profile'));
  const env = {
    ...process.env,
    AI_WEB_TEST_BROWSER_PROFILE_DIR: process.env.AI_WEB_TEST_BROWSER_PROFILE_DIR || browserProfileDir,
    AI_WEB_TEST_FORCE_PLAYWRIGHT_BROWSER: app.isPackaged ? 'true' : process.env.AI_WEB_TEST_FORCE_PLAYWRIGHT_BROWSER,
    AI_WEB_TEST_CHROMIUM_EXECUTABLE_PATH: packagedChromiumExecutable(),
    APP_DATA_DIR: appDataDir,
    ARTIFACTS_DIR: ensureDir(path.join(appDataDir, 'artifacts')),
    BROWSER_SHARED_TABS: process.env.BROWSER_SHARED_TABS || 'true',
    BROWSER_USER_DATA_DIR: process.env.BROWSER_USER_DATA_DIR || browserProfileDir,
    ELECTRON_EMBEDDED_BROWSER_CDP_PORT: String(EMBEDDED_BROWSER_CDP_PORT),
    HOSTNAME: '127.0.0.1',
    NODE_PATH: app.isPackaged ? path.join(serverDir, 'node_modules') : process.env.NODE_PATH,
    NODE_ENV: 'production',
    PORT: String(port),
    WEBPILOT_ELECTRON_CDP_PORT: String(EMBEDDED_BROWSER_CDP_PORT),
    WEBPILOT_INTERNAL_SHUTDOWN_TOKEN: serverShutdownToken,
  };

  const args = app.isPackaged ? [serverScript] : [serverScript, 'start', '-p', String(port), '-H', '127.0.0.1'];
  if (app.isPackaged) {
    env.ELECTRON_RUN_AS_NODE = '1';
    env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'ms-playwright');
  }

  appendLog(`Starting server: ${process.execPath} ${args.join(' ')}`);
  appendLog(`cwd=${serverDir}`);
  appendLog(`BROWSER_SHARED_TABS=${env.BROWSER_SHARED_TABS}`);
  appendLog(`BROWSER_USER_DATA_DIR=${env.BROWSER_USER_DATA_DIR}`);
  appendLog(`AI_WEB_TEST_BROWSER_PROFILE_DIR=${env.AI_WEB_TEST_BROWSER_PROFILE_DIR}`);
  appendLog(`PLAYWRIGHT_BROWSERS_PATH=${env.PLAYWRIGHT_BROWSERS_PATH || ''}`);
  appendLog(`AI_WEB_TEST_CHROMIUM_EXECUTABLE_PATH=${env.AI_WEB_TEST_CHROMIUM_EXECUTABLE_PATH || ''}`);
  appendLog(`WEBPILOT_ELECTRON_CDP_PORT=${env.WEBPILOT_ELECTRON_CDP_PORT || ''}`);
  appendLog(`NODE_PATH=${env.NODE_PATH || ''}`);

  serverProcess = spawn(process.execPath, args, {
    cwd: serverDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverProcess.stdout?.on('data', (chunk) => rememberServerOutput('server stdout', chunk));
  serverProcess.stderr?.on('data', (chunk) => rememberServerOutput('server stderr', chunk));
  serverProcess.on('error', (error) => rememberServerOutput('server error', error.message));
  serverProcess.on('exit', (code, signal) => {
    appendLog(`Server process exited: code=${code} signal=${signal || ''}`);
    serverProcess = undefined;
  });

  const url = `http://127.0.0.1:${port}`;
  localServerUrl = url;
  await waitForHttp(`${url}/dashboard`, 60_000, 3);
  await waitForHttp(`${url}/api/browser-chat?userId=0`, 30_000, 2);
  return url;
}

function createWindow() {
  nativeTheme.themeSource = 'system';
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    title: APP_TITLE,
    icon: appIconPath(),
    backgroundColor: '#0f131b',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath(),
    },
  });
  installNativeDownloadHandler(mainWindow.webContents.session);
  installHtmlFullscreenRecovery(mainWindow.webContents);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.on('before-input-event', (event, input) => {
    handleEmbeddedBrowserShortcut(event, input);
  });
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (!String(targetUrl).startsWith('webpilot-startup://')) return;
    event.preventDefault();
    const action = String(targetUrl).slice('webpilot-startup://'.length).replace(/\/$/, '');
    if (action === 'retry') {
      app.relaunch();
      app.exit(0);
    } else if (action === 'logs' && startupLogPath) {
      shell.showItemInFolder(startupLogPath);
    } else if (action === 'quit') {
      app.quit();
    }
  });
  mainWindow.on('close', () => {
    clearEmbeddedBrowserStateChangeTimer();
    clearEmbeddedBrowserPersistenceTimer();
    writeEmbeddedBrowserPersistence();
    embeddedBrowserPersistenceStopped = true;
  });
  mainWindow.webContents.setWindowOpenHandler((details) => {
    const url = String(details.url || '').trim();
    if (!url) return { action: 'deny' };
    const normalizedUrl = normalizeEmbeddedBrowserOpenUrl(url, mainWindow.webContents.getURL() || '');
    if (!normalizedUrl || isBlankPageUrl(normalizedUrl)) return { action: 'deny' };
    if (isDownloadLikeUrl(normalizedUrl, details)) {
      const result = startNativeDownload(preferredDownloadWebContents(), normalizedUrl);
      if (result.ok === false) appendLog(`App shell download failed: ${result.error || 'unknown error'}`);
      return { action: 'deny' };
    }
    openAppShellUrlInEmbeddedBrowser(normalizedUrl)
      .catch((error) => appendLog(`App shell link open failed: ${error instanceof Error ? error.message : String(error)}`));
    return { action: 'deny' };
  });
  let loadingIconDataUrl = '';
  try {
    loadingIconDataUrl = `data:image/png;base64,${fs.readFileSync(appPngIconPath()).toString('base64')}`;
  } catch {
    // The text fallback keeps the startup screen usable if the icon is unavailable.
  }
  const loadingMark = loadingIconDataUrl
    ? `<img src="${loadingIconDataUrl}" alt="" />`
    : '<span>W</span>';
  const loadingHtml = `
    <style>
      * { box-sizing: border-box; }
      :root { color-scheme: light; }
      body {
        background:
          radial-gradient(circle at 20% 12%, rgba(70, 205, 181, 0.11), transparent 28%),
          radial-gradient(circle at 78% 88%, rgba(74, 132, 204, 0.09), transparent 32%),
          linear-gradient(145deg, #f8fafb 0%, #f3f6f8 100%);
        color: #12202c;
        display: grid;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        height: 100vh;
        margin: 0;
        overflow: hidden;
        place-items: center;
        position: relative;
        -webkit-font-smoothing: antialiased;
      }
      body::before,
      body::after {
        border-radius: 50%;
        content: "";
        filter: blur(10px);
        pointer-events: none;
        position: absolute;
        will-change: transform, opacity;
      }
      body::before {
        animation: ambient-drift-a 12s ease-in-out infinite alternate;
        background: radial-gradient(circle, rgba(61, 203, 178, 0.13), rgba(61, 203, 178, 0) 69%);
        height: min(58vw, 720px);
        left: -10vw;
        top: -18vh;
        width: min(58vw, 720px);
      }
      body::after {
        animation: ambient-drift-b 15s ease-in-out infinite alternate;
        background: radial-gradient(circle, rgba(69, 127, 205, 0.11), rgba(69, 127, 205, 0) 70%);
        bottom: -24vh;
        height: min(54vw, 680px);
        right: -8vw;
        width: min(54vw, 680px);
      }
      .shell {
        align-items: center;
        animation: shell-in 0.42s cubic-bezier(.2,.8,.2,1) both;
        backdrop-filter: none;
        background: transparent;
        border: 0;
        border-radius: 0;
        box-shadow: none;
        display: grid;
        gap: 19px;
        grid-template-columns: minmax(0, 1fr);
        max-width: none;
        padding: 0;
        position: relative;
        width: 100%;
        z-index: 1;
      }
      .shell::before { display: none; }
      .mark {
        align-items: center;
        display: flex;
        height: 58px;
        justify-content: center;
        position: relative;
        width: 58px;
      }
      .mark img {
        border-radius: 14px;
        box-shadow: 0 9px 22px rgba(15, 44, 57, 0.17);
        display: block;
        height: 58px;
        width: 58px;
      }
      .mark span { color: #1aaE98; font-size: 25px; font-weight: 800; }
      .eyebrow { color: #668090; font-size: 10px; font-weight: 760; letter-spacing: 0.15em; margin: 0 0 6px; text-transform: uppercase; }
      h2 { font-size: 19px; font-weight: 720; letter-spacing: -0.025em; line-height: 1.25; margin: 0 0 8px; }
      p { align-items: center; color: #70808d; display: flex; font-size: 12.5px; line-height: 1.55; margin: 0; }
      .status-dot { animation: status-pulse 1.7s ease-in-out infinite; background: #37c7ad; border-radius: 50%; box-shadow: 0 0 0 4px rgba(55, 199, 173, 0.11); flex: 0 0 auto; height: 6px; margin-right: 9px; width: 6px; }
      .startup-liquid { display: grid; grid-column: 1 / -1; grid-row: 1; height: 154px; margin: -1px 0 -6px; place-items: center; position: relative; width: 154px; justify-self: center; }
      .startup-liquid + div { align-items: center; display: flex; grid-column: 1 / -1; grid-row: 2; justify-content: center; margin: -2px 0 0; text-align: center; }
      .startup-liquid + div .eyebrow, .startup-liquid + div h2, .startup-liquid + div .status-dot { display: none; }
      .startup-liquid + div p { justify-content: center; text-align: center; }
      .startup-liquid-orb { background: rgba(255,255,255,.74); border: 1px solid rgba(51,44,37,.10); border-radius: 50%; box-shadow: 0 20px 38px rgba(62,51,39,.08), inset 0 1px 0 #fff, inset 0 -10px 28px rgba(122,155,139,.05); height: 132px; overflow: hidden; position: relative; width: 132px; }
      .startup-liquid-orb::after { border-radius: inherit; box-shadow: inset 8px 9px 20px rgba(255,255,255,.56), inset -9px -12px 22px rgba(55,43,32,.04); content: ""; inset: 0; pointer-events: none; position: absolute; }
      .startup-liquid-water { animation: startup-liquid-water-breathe 3s cubic-bezier(.22,.8,.28,1) infinite; background: linear-gradient(180deg,rgba(122,155,139,.50),rgba(122,155,139,.88)); bottom: -5%; height: var(--startup-liquid-progress, 12%); left: -18%; position: absolute; right: -18%; transition: height .42s cubic-bezier(.22,.8,.28,1); }
      .startup-liquid-water::before, .startup-liquid-water::after { animation: startup-liquid-wave 3.4s ease-in-out infinite; background: rgba(255,255,255,.88); border-radius: 45% 55% 48% 52%; content: ""; height: 38px; left: -12%; position: absolute; top: -20px; width: 124%; }
      .startup-liquid-water::after { animation-direction: reverse; animation-duration: 2.8s; background: rgba(122,155,139,.22); border-radius: 54% 46% 58% 42%; top: -15px; }
      .startup-liquid-bubble { animation: startup-liquid-bubble-up 2.5s ease-in infinite; animation-delay: var(--delay); background: rgba(255,255,255,.22); border: 1px solid rgba(255,255,255,.75); border-radius: 50%; bottom: 22px; height: 7px; left: var(--x); position: absolute; width: 7px; z-index: 2; }
      .startup-liquid-bubble.small { height: 5px; width: 5px; }
      .startup-liquid-bubble.large { height: 9px; width: 9px; }
      .slow-note { color: #81909b; display: none; font-size: 11px; grid-column: 1 / -1; justify-self: center; margin-top: -8px; text-align: center; }
      .slow-note.visible { display: block; }
      .startup-error { display: none; grid-column: 1 / -1; }
      .startup-error.visible { display: block; }
      .startup-error strong { color: #b44747; display: block; font-size: 12px; margin-bottom: 10px; }
      .startup-actions { display: flex; gap: 8px; }
      .startup-actions button { background: rgba(255,255,255,.72); border: 1px solid rgba(47,71,85,.13); border-radius: 9px; color: #526673; cursor: pointer; font: inherit; font-size: 11px; padding: 7px 11px; }
      .startup-actions button:first-child { background: #168e7d; border-color: #168e7d; color: white; }
      .shell.complete { opacity: 0; transform: translateY(-4px) scale(.99); transition: opacity .22s ease, transform .22s ease; }
      @keyframes status-pulse { 0%, 100% { opacity: .55; transform: scale(.85); } 50% { opacity: 1; transform: scale(1); } }
      @keyframes startup-liquid-water-breathe { 0%,100% { transform: translateY(4px); } 50% { transform: translateY(-3px); } }
      @keyframes startup-liquid-wave { 0%,100% { transform: translateX(-3%) rotate(-2deg); } 50% { transform: translateX(5%) rotate(2deg); } }
      @keyframes startup-liquid-bubble-up { 0% { opacity: 0; transform: translateY(12px) scale(.5); } 20% { opacity: .72; } 100% { opacity: 0; transform: translateY(-72px) translateX(7px) scale(1); } }
      @keyframes shell-in { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: translateY(0) scale(1); } }
      @keyframes ambient-drift-a {
        0% { opacity: .72; transform: translate3d(-3%, -2%, 0) scale(.96); }
        50% { opacity: 1; transform: translate3d(10%, 7%, 0) scale(1.06); }
        100% { opacity: .8; transform: translate3d(18%, 1%, 0) scale(1); }
      }
      @keyframes ambient-drift-b {
        0% { opacity: .65; transform: translate3d(3%, 4%, 0) scale(1); }
        50% { opacity: .92; transform: translate3d(-10%, -8%, 0) scale(1.08); }
        100% { opacity: .72; transform: translate3d(-17%, 2%, 0) scale(.98); }
      }
      @media (prefers-reduced-motion: reduce) {
        body::before, body::after, .shell, .status-dot, .startup-liquid-water, .startup-liquid-water::before, .startup-liquid-water::after, .startup-liquid-bubble { animation: none; }
      }
      @media (prefers-color-scheme: dark) {
        :root { color-scheme: dark; }
        body { background: radial-gradient(circle at 20% 12%, rgba(48,167,146,.12), transparent 28%), radial-gradient(circle at 78% 88%, rgba(67,111,173,.13), transparent 32%), #10151b; color: #eef5f6; }
        .shell { background: transparent; border: 0; box-shadow: none; }
        .shell::before { background: linear-gradient(90deg, transparent, rgba(255,255,255,.16), transparent); }
        .eyebrow { color: #8aa1ae; }
        p, .slow-note { color: #93a3ad; }
        .startup-actions button { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.1); color: #bdc8ce; }
      }
    </style>
    <body>
      <main class="shell">
        <div class="startup-liquid" aria-hidden="true">
          <div class="startup-liquid-orb">
            <div class="startup-liquid-water" id="startup-liquid-water"></div>
            <i class="startup-liquid-bubble" style="--x:34%;--delay:-.2s"></i>
            <i class="startup-liquid-bubble small" style="--x:57%;--delay:-1.4s"></i>
            <i class="startup-liquid-bubble large" style="--x:69%;--delay:-2.1s"></i>
          </div>
        </div>
        <div>
          <div class="eyebrow">${APP_NAME}</div>
          <h2>智能浏览器测试工作区</h2>
          <p><span class="status-dot"></span><span id="startup-status">正在初始化工作区…</span></p>
        </div>
        <div class="slow-note" id="startup-slow">首次启动可能需要更长时间，请稍候。</div>
        <div class="startup-error" id="startup-error">
          <strong id="startup-error-message">启动失败</strong>
          <div class="startup-actions">
            <button onclick="location.href='webpilot-startup://retry'">重新启动</button>
            <button onclick="location.href='webpilot-startup://logs'">查看日志</button>
            <button onclick="location.href='webpilot-startup://quit'">退出</button>
          </div>
        </div>
      </main>
      <script>
        window.__webPilotStartup = {
          update(input) {
            if (input.message) document.getElementById('startup-status').textContent = input.message;
            if (Number.isFinite(input.progress)) {
              const liquid = document.getElementById('startup-liquid-water');
              if (liquid) liquid.style.setProperty('--startup-liquid-progress', Math.max(8, Math.min(100, input.progress)) + '%');
            }
            document.getElementById('startup-slow').classList.toggle('visible', Boolean(input.slow));
          },
          fail(message) {
            document.querySelector('.status-dot').style.background = '#d65c5c';
            document.getElementById('startup-status').textContent = '未能完成启动';
            document.getElementById('startup-error-message').textContent = message || '启动失败，请重试或查看日志。';
            document.getElementById('startup-error').classList.add('visible');
            document.getElementById('startup-slow').classList.remove('visible');
          },
          complete() { document.querySelector('.shell').classList.add('complete'); }
        };
      </script>
    </body>`;
  startupScreenReady = mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml)}`);
  return mainWindow;
}

async function updateStartupScreen(input) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    await startupScreenReady;
    await mainWindow.webContents.executeJavaScript(`window.__webPilotStartup?.update(${JSON.stringify(input)})`);
  } catch {
    // Startup progress is cosmetic and must never prevent the app from opening.
  }
}

async function failStartupScreen(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    await startupScreenReady;
    await mainWindow.webContents.executeJavaScript(`window.__webPilotStartup?.fail(${JSON.stringify(message)})`);
  } catch {
    dialog.showErrorBox(APP_TITLE, message);
  }
}

function runtimeAppDataDirectory() {
  const configured = String(process.env.APP_DATA_DIR || '').trim();
  if (configured) return path.resolve(configured);
  if (!app.isPackaged) return process.cwd();
  return path.join(app.getPath('userData'), 'runtime');
}

async function boot() {
  const appDataDir = ensureDir(runtimeAppDataDirectory());
  runtimeDatabasePath = path.join(appDataDir, '.data', RUNTIME_DATABASE_FILE);
  startupLogPath = path.join(appDataDir, 'startup.log');
  fs.writeFileSync(startupLogPath, '');
  appendLog(`App starting. packaged=${app.isPackaged}`);
  appendLog(`APP_DATA_DIR=${appDataDir}`);
  appendLog(`resourcesPath=${process.resourcesPath}`);
  appendLog(`WEBPILOT_ELECTRON_CDP_PORT=${EMBEDDED_BROWSER_CDP_PORT}`);
  if (restoreDownloadSettings()) appendLog(`Download directory restored: ${lastDownloadDirectory}`);
  createWindow();
  await updateStartupScreen({ message: '正在恢复浏览器工作区…', progress: 18 });
  const slowStartupTimer = setTimeout(() => {
    void updateStartupScreen({ message: '服务仍在启动，请稍候…', progress: 58, slow: true });
  }, 8_000);

  try {
    const externalServerUrl = String(process.env.WEBPILOT_ELECTRON_SERVER_URL || '').trim().replace(/\/+$/, '');
    await updateStartupScreen({ message: externalServerUrl ? '正在连接本地服务…' : '正在启动本地服务…', progress: 36 });
    const url = externalServerUrl || await startServer(appDataDir);
    await updateStartupScreen({ message: '服务已就绪，正在加载界面…', progress: 82 });
    if (externalServerUrl) {
      await waitForHttp(`${url}/dashboard`, 60_000, 2);
    }
    clearTimeout(slowStartupTimer);
    await updateStartupScreen({ message: '工作区已准备完成', progress: 100 });
    await mainWindow.webContents.executeJavaScript('window.__webPilotStartup?.complete()').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 180));
    await mainWindow.loadURL(url);
    // Restoring WebContentsViews before this navigation makes Electron destroy
    // them when the startup document is replaced by the application shell.
    if (restoreEmbeddedBrowserPersistence()) appendLog('Embedded browser tabs restored from local cache.');
  } catch (error) {
    clearTimeout(slowStartupTimer);
    const output = recentServerOutput.length
      ? `\n\nRecent server output:\n${recentServerOutput.slice(-10).join('\n')}`
      : '';
    const logHint = startupLogPath ? `\n\nStartup log: ${startupLogPath}` : '';
    const message = `${error instanceof Error ? error.message : String(error)}${output}${logHint}`;
    appendLog(`Startup failed: ${message}`);
    await failStartupScreen(error instanceof Error ? error.message : String(error));
  }
}

registerEmbeddedBrowserIpc();
registerSystemIpc();

app.whenReady().then(boot);

app.on('window-all-closed', () => {
  app.quit();
});

function requestLocalServerShutdown() {
  if (!localServerUrl || !serverProcess || serverProcess.killed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const shutdownUrl = new URL(`${localServerUrl}/api/system/shutdown`);
    const request = http.request({
      hostname: shutdownUrl.hostname,
      port: shutdownUrl.port,
      path: shutdownUrl.pathname,
      method: 'POST',
      headers: {
        'x-webpilot-shutdown-token': serverShutdownToken,
      },
    }, (response) => {
      response.resume();
      response.once('end', () => {
        if ((response.statusCode || 500) < 400) resolve();
        else reject(new Error(`Server shutdown returned HTTP ${response.statusCode || 500}.`));
      });
    });
    request.setTimeout(8_000, () => request.destroy(new Error('Server shutdown timed out.')));
    request.once('error', reject);
    request.end();
  });
}

function destroyElectronResources() {
  if (electronResourcesDestroyed) return;
  electronResourcesDestroyed = true;
  clearEmbeddedBrowserFitTimer();
  clearEmbeddedBrowserStateChangeTimer();
  clearEmbeddedBrowserPersistenceTimer();
  if (!embeddedBrowserPersistenceStopped) {
    writeEmbeddedBrowserPersistence();
    embeddedBrowserPersistenceStopped = true;
  }
  destroyEmbeddedBrowserLibraryView();
  detachEmbeddedBrowserView();
  for (const tab of Array.from(embeddedBrowserTabs.values())) destroyEmbeddedBrowserTab(tab);
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
  electronStateDatabase?.close();
  electronStateDatabase = undefined;
}

app.on('before-quit', (event) => {
  if (applicationShutdownReady) {
    destroyElectronResources();
    return;
  }
  event.preventDefault();
  if (applicationShutdownStarted) return;
  applicationShutdownStarted = true;
  void requestLocalServerShutdown()
    .catch((error) => appendLog(`Server browser cleanup failed before quit: ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => {
      destroyElectronResources();
      applicationShutdownReady = true;
      app.quit();
    });
});
