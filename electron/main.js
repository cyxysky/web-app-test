const { app, BrowserWindow, WebContentsView, dialog, ipcMain, nativeTheme, shell } = require('electron');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const APP_NAME = 'WebPilot QA';
const DEFAULT_PORT = 17890;
const EMBEDDED_BROWSER_CDP_PORT = Number(process.env.WEBPILOT_ELECTRON_CDP_PORT || process.env.ELECTRON_EMBEDDED_BROWSER_CDP_PORT || 19333);

app.commandLine.appendSwitch('remote-debugging-port', String(EMBEDDED_BROWSER_CDP_PORT));

let serverProcess;
let mainWindow;
let embeddedBrowserView;
let embeddedBrowserAttached = false;
let embeddedBrowserVisible = false;
let embeddedBrowserLibraryView;
let embeddedBrowserLibraryPanel = '';
let embeddedBrowserActiveGroupId = '';
let embeddedBrowserActiveTabId = '';
let embeddedBrowserNextTabId = 1;
const embeddedBrowserGroups = new Map();
const embeddedBrowserTabs = new Map();
const embeddedBrowserBookmarks = new Map();
let embeddedBrowserHistory = [];
let embeddedBrowserNextBookmarkId = 1;
let embeddedBrowserNextHistoryId = 1;
let embeddedBrowserBounds = { x: 0, y: 0, width: 0, height: 0 };
let embeddedBrowserFitTimer;
let embeddedBrowserFitAllowZoomIn = false;
let embeddedBrowserPersistencePath = '';
let embeddedBrowserPersistenceTimer;
let embeddedBrowserPersistenceStopped = false;
let embeddedBrowserPersistenceRestoring = false;
let embeddedBrowserStateChangeTimer;
const EMBEDDED_BROWSER_ROUTE_LOADING_MS = 1200;
const EMBEDDED_BROWSER_PERSISTENCE_FILE = 'embedded-browser-state.json';
const EMBEDDED_BROWSER_PERSISTENCE_VERSION = 2;
const EMBEDDED_BROWSER_HISTORY_LIMIT = 300;
let startupLogPath;
let recentServerOutput = [];
let lastDownloadDirectory = '';
let nextDownloadId = 1;
const systemDownloads = new Map();

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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

function tinymceRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'tinymce');
  return path.join(process.cwd(), 'node_modules', 'tinymce');
}

function appIconPath() {
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
    }
  });
  view.webContents.on('did-finish-load', () => {
    notifyEmbeddedBrowserStateChange();
  });
  view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    appendLog(`Embedded browser library load failed: ${errorDescription} (${errorCode})`);
    if (embeddedBrowserLibraryView === view) {
      embeddedBrowserLibraryPanel = '';
      view.setVisible(false);
      notifyEmbeddedBrowserStateChange();
    }
  });
  view.webContents.once('destroyed', () => {
    if (embeddedBrowserLibraryView === view) {
      embeddedBrowserLibraryView = undefined;
      embeddedBrowserLibraryPanel = '';
      notifyEmbeddedBrowserStateChange();
    }
  });
  embeddedBrowserLibraryView = view;
  void view.webContents.loadURL(routeUrl).catch((error) => {
    appendLog(`Embedded browser library load failed: ${error instanceof Error ? error.message : String(error)}`);
    if (embeddedBrowserLibraryView === view) {
      embeddedBrowserLibraryPanel = '';
      view.setVisible(false);
      notifyEmbeddedBrowserStateChange();
    }
  });
  return view;
}

function attachEmbeddedBrowserLibraryView() {
  if (!embeddedBrowserLibraryPanel || !embeddedBrowserVisible || !mainWindow || mainWindow.isDestroyed()) {
    embeddedBrowserLibraryView?.setVisible(false);
    return;
  }
  const view = ensureEmbeddedBrowserLibraryView();
  mainWindow.contentView.addChildView(view);
  view.setBounds(embeddedBrowserLibraryViewBounds());
  view.setVisible(true);
  view.webContents.focus();
}

function setEmbeddedBrowserLibraryPanel(value) {
  const nextPanel = value === 'bookmarks' || value === 'history' ? value : '';
  embeddedBrowserLibraryPanel = nextPanel;
  if (nextPanel) attachEmbeddedBrowserLibraryView();
  else embeddedBrowserLibraryView?.setVisible(false);
  notifyEmbeddedBrowserStateChange();
  return embeddedBrowserState();
}

function destroyEmbeddedBrowserLibraryView() {
  const view = embeddedBrowserLibraryView;
  embeddedBrowserLibraryPanel = '';
  embeddedBrowserLibraryView = undefined;
  if (!view) return;
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(view);
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

function parseDownloadFileNameFromContentDisposition(value) {
  const header = String(value || '');
  const encoded = header.match(/filename\*\s*=\s*(?:UTF-8''|)([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim().replace(/^"|"$/g, ''));
    } catch {
      return encoded.trim().replace(/^"|"$/g, '');
    }
  }
  return header.match(/filename\s*=\s*"([^"]+)"/i)?.[1]
    || header.match(/filename\s*=\s*([^;]+)/i)?.[1]?.trim()
    || '';
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('webpilot:system:download-progress', payload);
  }
  return payload;
}

function updateSystemDownload(download, patch = {}) {
  Object.assign(download, patch, { updatedAt: Date.now() });
  systemDownloads.set(download.id, download);
  return emitDownloadProgress(download);
}

function systemDownloadState() {
  return {
    downloads: Array.from(systemDownloads.values())
      .sort((left, right) => Number(right.startedAt || 0) - Number(left.startedAt || 0))
      .map(downloadProgressPayload),
    ok: true,
  };
}

async function chooseDownloadDirectory(input = {}) {
  const defaultPath = typeof input.defaultPath === 'string' && input.defaultPath.trim()
    ? input.defaultPath.trim()
    : (lastDownloadDirectory || undefined);
  const result = await dialog.showOpenDialog(mainWindow, {
    defaultPath,
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select download directory',
  });
  if (result.canceled || !result.filePaths?.[0]) return { ok: true, canceled: true };
  lastDownloadDirectory = result.filePaths[0];
  return { ok: true, path: result.filePaths[0] };
}

async function downloadCookieHeader(webContents, url) {
  try {
    const cookies = await webContents?.session?.cookies?.get?.({ url });
    if (!Array.isArray(cookies) || !cookies.length) return '';
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  } catch {
    return '';
  }
}

async function startElectronDownload(webContents, url, context, options = {}) {
  const normalizedUrl = normalizeEmbeddedBrowserOpenUrl(url, mainWindow?.webContents?.getURL?.() || '');
  if (!normalizedUrl) return { ok: false, error: 'Download URL is invalid.' };
  const download = {
    error: '',
    fileName: sanitizeDownloadFileName(options.fileName || downloadFileNameFromUrl(normalizedUrl)),
    id: `download:${Date.now()}:${nextDownloadId++}`,
    path: '',
    receivedBytes: 0,
    startedAt: Date.now(),
    status: 'selecting',
    totalBytes: 0,
    updatedAt: Date.now(),
    url: normalizedUrl,
  };
  systemDownloads.set(download.id, download);
  emitDownloadProgress(download);
  let directory = String(options.directory || '').trim();
  if (options.promptForDirectory || !directory) {
    const selected = await chooseDownloadDirectory({ defaultPath: options.defaultPath });
    if (!selected.ok || selected.canceled) {
      updateSystemDownload(download, { completedAt: Date.now(), status: selected.canceled ? 'cancelled' : 'failed', error: selected.error || '' });
      return selected;
    }
    directory = selected.path;
  }
  await fs.promises.mkdir(directory, { recursive: true });
  updateSystemDownload(download, { status: 'pending' });
  let savePath = '';
  let fileStream;
  try {
    const headers = {};
    const cookieHeader = await downloadCookieHeader(webContents, normalizedUrl);
    if (cookieHeader) headers.Cookie = cookieHeader;
    const userAgent = typeof webContents?.getUserAgent === 'function' ? webContents.getUserAgent() : '';
    if (userAgent) headers['User-Agent'] = userAgent;
    headers.Accept = '*/*';
    const response = await fetch(normalizedUrl, {
      headers,
      redirect: 'follow',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const responseUrl = response.url || normalizedUrl;
    const fileName = sanitizeDownloadFileName(
      options.fileName
      || parseDownloadFileNameFromContentDisposition(response.headers.get('content-disposition'))
      || downloadFileNameFromUrl(responseUrl)
      || download.fileName,
    );
    const totalBytes = Number(response.headers.get('content-length') || 0);
    savePath = uniqueDownloadPath(directory, fileName);
    fileStream = fs.createWriteStream(savePath);
    const fileStreamError = new Promise((_, reject) => {
      fileStream.once('error', reject);
    });
    updateSystemDownload(download, {
      fileName,
      path: savePath,
      status: 'downloading',
      totalBytes: Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0,
    });

    let receivedBytes = 0;
    let lastEmitAt = 0;
    const emitChunkProgress = () => {
      const now = Date.now();
      if (now - lastEmitAt < 160 && receivedBytes !== totalBytes) return;
      lastEmitAt = now;
      updateSystemDownload(download, { receivedBytes });
    };

    if (response.body?.getReader) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buffer = Buffer.from(value);
        receivedBytes += buffer.byteLength;
        if (!fileStream.write(buffer)) await Promise.race([once(fileStream, 'drain'), fileStreamError]);
        emitChunkProgress();
      }
    } else {
      const buffer = Buffer.from(await response.arrayBuffer());
      receivedBytes = buffer.byteLength;
      if (!fileStream.write(buffer)) await Promise.race([once(fileStream, 'drain'), fileStreamError]);
      emitChunkProgress();
    }

    await Promise.race([
      new Promise((resolve) => fileStream.end(resolve)),
      fileStreamError,
    ]);
    updateSystemDownload(download, {
      completedAt: Date.now(),
      receivedBytes,
      status: 'completed',
      totalBytes: download.totalBytes || receivedBytes,
    });
    return { ok: true, path: savePath };
  } catch (error) {
    try {
      if (fileStream) fileStream.destroy();
      if (savePath && fs.existsSync(savePath)) fs.unlinkSync(savePath);
    } catch {
      // Best-effort cleanup of incomplete downloads.
    }
    appendLog(`${context} failed: ${error instanceof Error ? error.message : String(error)}`);
    const message = error instanceof Error ? error.message : String(error);
    updateSystemDownload(download, { completedAt: Date.now(), error: message, status: 'failed' });
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
  return embeddedBrowserSessionIdFromGroupId(groupId) || normalizeEmbeddedBrowserSessionId(input.sessionId);
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

function setEmbeddedBrowserTabMuted(input = {}) {
  const id = String(input.id || embeddedBrowserActiveTabId || '').trim();
  const tab = embeddedBrowserTabs.get(id) || activeEmbeddedBrowserTab();
  if (!tab || tab.view.webContents.isDestroyed()) throw new Error('Embedded browser tab not found.');
  const currentMuted = Boolean(tab.audioMuted || tab.view.webContents.isAudioMuted?.());
  const muted = typeof input.muted === 'boolean' ? input.muted : !currentMuted;
  tab.audioMuted = muted;
  tab.view.webContents.setAudioMuted(muted);
  writeEmbeddedBrowserPersistence();
  scheduleEmbeddedBrowserPersistence();
  notifyEmbeddedBrowserStateChange();
  return embeddedBrowserState();
}

function embeddedBrowserPersistenceSnapshot() {
  const tabs = [];
  const groupIdsWithTabs = new Set();
  for (const tab of embeddedBrowserTabs.values()) {
    if (!tab || tab.view.webContents.isDestroyed()) continue;
    const url = embeddedBrowserPersistableUrl(tab.lastKnownUrl || tab.view.webContents.getURL() || '');
    tabs.push({
      audioMuted: Boolean(tab.audioMuted || tab.view.webContents.isAudioMuted?.()),
      createdAt: Number(tab.createdAt) || Date.now(),
      groupId: tab.groupId,
      id: tab.id,
      sessionId: tab.sessionId || undefined,
      url,
    });
    groupIdsWithTabs.add(tab.groupId);
  }

  const groups = Array.from(embeddedBrowserGroups.values())
    .filter((group) => groupIdsWithTabs.has(group.id) || group.id === embeddedBrowserActiveGroupId)
    .map((group) => ({
      activeTabId: group.activeTabId || undefined,
      createdAt: Number(group.createdAt) || Date.now(),
      id: group.id,
      sessionId: embeddedBrowserSessionIdFromGroupId(group.id) || group.sessionId || undefined,
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
  if (!embeddedBrowserPersistencePath || embeddedBrowserPersistenceRestoring || embeddedBrowserPersistenceStopped) return;
  try {
    ensureDir(path.dirname(embeddedBrowserPersistencePath));
    const temporaryPath = `${embeddedBrowserPersistencePath}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(embeddedBrowserPersistenceSnapshot(), null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, embeddedBrowserPersistencePath);
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
  if (!embeddedBrowserPersistencePath || embeddedBrowserPersistenceStopped) return;
  clearEmbeddedBrowserPersistenceTimer();
  embeddedBrowserPersistenceTimer = setTimeout(() => {
    embeddedBrowserPersistenceTimer = undefined;
    writeEmbeddedBrowserPersistence();
  }, 180);
}

function restoreEmbeddedBrowserPersistence() {
  if (!embeddedBrowserPersistencePath || embeddedBrowserTabs.size || embeddedBrowserGroups.size) return false;

  let saved;
  try {
    if (!fs.existsSync(embeddedBrowserPersistencePath)) return false;
    saved = JSON.parse(fs.readFileSync(embeddedBrowserPersistencePath, 'utf8'));
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
        createdAt: Number.isFinite(Number(item?.createdAt)) ? Number(item.createdAt) : Date.now(),
        id,
        sessionId,
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
          createdAt: Date.now(),
          id: groupId,
          sessionId: embeddedBrowserSessionIdFromGroupId(groupId) || normalizeEmbeddedBrowserSessionId(item?.sessionId),
        });
      }
      try {
        const tab = createEmbeddedBrowserTab({
          audioMuted: Boolean(item?.audioMuted),
          groupId,
          id,
          sessionId: embeddedBrowserSessionIdFromGroupId(groupId) || normalizeEmbeddedBrowserSessionId(item?.sessionId),
          restore: true,
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
    return restoredTabIds.size > 0;
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
        if (${sessionId}) window.name = 'AI_WEB_TEST_SESSION_GROUP:' + ${sessionId} + ';' + String(window.name || '').replace(/^AI_WEB_TEST_SESSION_GROUP:[^;]+;/, '');
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
  let group = embeddedBrowserGroups.get(groupId);
  if (!group) {
    group = {
      activeTabId: '',
      createdAt: Date.now(),
      id: groupId,
      sessionId,
    };
    embeddedBrowserGroups.set(group.id, group);
    scheduleEmbeddedBrowserPersistence();
    notifyEmbeddedBrowserStateChange();
  } else if (sessionId && group.sessionId !== sessionId) {
    group.sessionId = sessionId;
    scheduleEmbeddedBrowserPersistence();
    notifyEmbeddedBrowserStateChange();
  }
  return group;
}

function scheduleEmbeddedBrowserFitForTab(tab, delayMs = 180, options = {}) {
  if (activeEmbeddedBrowserTab()?.id !== tab?.id) return;
  scheduleEmbeddedBrowserFitToWidth(delayMs, options);
}

function installEmbeddedBrowserTabHandlers(tab) {
  const { view } = tab;
  view.webContents.setWindowOpenHandler((details) => {
    const url = String(details.url || '').trim();
    const normalizedUrl = normalizeEmbeddedBrowserOpenUrl(url, view.webContents.getURL() || '');
    if (!normalizedUrl || isBlankPageUrl(normalizedUrl)) return { action: 'deny' };
    if (isDownloadLikeUrl(normalizedUrl, details)) {
      startElectronDownload(view.webContents, normalizedUrl, 'Embedded browser popup download', { promptForDirectory: true })
        .then((result) => {
          if (result?.ok === false) appendLog(`Embedded browser popup download failed: ${result.error || 'unknown error'}`);
        })
        .catch((error) => appendLog(`Embedded browser popup download failed: ${error instanceof Error ? error.message : String(error)}`));
      return { action: 'deny' };
    }
    let popupTab;
    try {
      popupTab = createEmbeddedBrowserTab({ groupId: tab.groupId, sessionId: tab.sessionId, url: normalizedUrl });
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
      .then(() => {
        scheduleEmbeddedBrowserFitForTab(popupTab, 180, { allowZoomIn: true });
      })
      .catch((error) => appendLog(`Embedded browser popup navigation failed: ${error.message}`));
    return { action: 'deny' };
  });
  view.webContents.on('dom-ready', () => {
    void markEmbeddedBrowserSession(tab);
    scheduleEmbeddedBrowserFitForTab(tab, 140, { allowZoomIn: true });
  });
  view.webContents.on('did-start-loading', () => {
    tab.routeLoadingUntil = Date.now() + EMBEDDED_BROWSER_ROUTE_LOADING_MS;
    scheduleEmbeddedBrowserPersistence();
    notifyEmbeddedBrowserStateChange();
  });
  view.webContents.on('did-finish-load', () => {
    tab.lastKnownUrl = view.webContents.getURL() || tab.lastKnownUrl || '';
    void markEmbeddedBrowserSession(tab);
    scheduleEmbeddedBrowserFitForTab(tab, 180, { allowZoomIn: true });
    scheduleEmbeddedBrowserPersistence();
    notifyEmbeddedBrowserStateChange();
    recordEmbeddedBrowserHistory(tab);
    tab.restorePending = false;
  });
  view.webContents.on('did-stop-loading', () => {
    tab.lastKnownUrl = view.webContents.getURL() || tab.lastKnownUrl || '';
    void markEmbeddedBrowserSession(tab);
    scheduleEmbeddedBrowserFitForTab(tab, 240, { allowZoomIn: true });
    scheduleEmbeddedBrowserPersistence();
    notifyEmbeddedBrowserStateChange();
  });
  view.webContents.on('did-navigate', () => {
    tab.lastKnownUrl = view.webContents.getURL() || tab.lastKnownUrl || '';
    void markEmbeddedBrowserSession(tab);
    scheduleEmbeddedBrowserFitForTab(tab, 180, { allowZoomIn: true });
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
    scheduleEmbeddedBrowserFitForTab(tab, 220, { allowZoomIn: true });
    scheduleEmbeddedBrowserPersistence();
    notifyEmbeddedBrowserStateChange();
    recordEmbeddedBrowserHistory(tab);
  });
  view.webContents.on('page-title-updated', () => {
    notifyEmbeddedBrowserStateChange();
    recordEmbeddedBrowserHistory(tab);
  });
  view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    appendLog(`Embedded browser failed to load ${validatedURL}: ${errorCode} ${errorDescription}`);
  });
  view.webContents.once('destroyed', () => {
    embeddedBrowserTabs.delete(tab.id);
    const group = embeddedBrowserGroups.get(tab.groupId);
    if (group?.activeTabId === tab.id) group.activeTabId = embeddedBrowserTabsForGroup(tab.groupId)[0]?.id || '';
    if (embeddedBrowserActiveTabId === tab.id) {
      embeddedBrowserActiveTabId = '';
      embeddedBrowserView = undefined;
      embeddedBrowserAttached = false;
    }
    scheduleEmbeddedBrowserPersistence();
    notifyEmbeddedBrowserStateChange();
  });
}

function createEmbeddedBrowserTab(input = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Main window is not ready.');
  if (!WebContentsView) throw new Error('Electron WebContentsView is not available.');
  const group = ensureEmbeddedBrowserGroup(input);
  const sessionId = embeddedBrowserSessionIdFromGroupId(group.id) || group.sessionId || normalizeEmbeddedBrowserSessionId(input.sessionId);
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
      preload: embeddedBrowserPreloadPath(),
      sandbox: false,
    },
  });
  const tab = {
    audioMuted: Boolean(input.audioMuted),
    attached: false,
    createdAt: Date.now(),
    groupId: group.id,
    id: tabId,
    lastKnownUrl: initialUrl,
    readyPromise: undefined,
    restorePending: Boolean(input.restore),
    sessionId,
    view,
  };
  view.webContents.setZoomFactor(1);
  view.webContents.setAudioMuted(tab.audioMuted);
  view.webContents.setUserAgent(embeddedBrowserUserAgent());
  embeddedBrowserTabs.set(tab.id, tab);
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
  let tab = tabId ? embeddedBrowserTabs.get(tabId) : embeddedBrowserTabs.get(group.activeTabId);
  if (tab?.view.webContents.isDestroyed()) {
    embeddedBrowserTabs.delete(tab.id);
    tab = undefined;
  }
  if (tab?.groupId !== group.id) tab = undefined;

  if (!tab) {
    tab = embeddedBrowserTabsForGroup(group.id)[0];
  }

  if (!tab && input.createIfMissing !== false) {
    const sessionId = embeddedBrowserSessionIdFromGroupId(group.id) || group.sessionId || normalizeEmbeddedBrowserSessionId(input.sessionId);
    tab = createEmbeddedBrowserTab({ groupId: group.id, sessionId });
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

function attachEmbeddedBrowserView(input = {}) {
  const restoredTab = embeddedBrowserVisible ? undefined : activeEmbeddedBrowserTab();
  embeddedBrowserVisible = true;
  const groupId = embeddedBrowserGroupId(input);
  const shouldCreateTab = input.createIfMissing === true;
  const existingGroup = embeddedBrowserGroups.get(groupId);
  let tab;
  if (shouldCreateTab || existingGroup) {
    tab = ensureEmbeddedBrowserTab({ ...input, createIfMissing: shouldCreateTab });
  }
  if (!tab && !shouldCreateTab && restoredTab && !restoredTab.view.webContents.isDestroyed()) {
    tab = restoredTab;
  }
  if (!tab) {
    setActiveEmbeddedBrowserGroup(groupId);
    for (const item of embeddedBrowserTabs.values()) detachEmbeddedBrowserTab(item);
    return undefined;
  }
  for (const item of embeddedBrowserTabs.values()) {
    if (item.id !== tab.id) detachEmbeddedBrowserTab(item);
  }
  if (!tab.attached) {
    mainWindow.contentView.addChildView(tab.view);
    tab.attached = true;
  }
  setActiveEmbeddedBrowserTab(tab);
  tab.view.setBounds(embeddedBrowserBounds);
  attachEmbeddedBrowserLibraryView();
  void markEmbeddedBrowserSession(tab);
  scheduleEmbeddedBrowserFitForTab(tab, 180, { allowZoomIn: true });
  return tab.view;
}

function detachEmbeddedBrowserView() {
  for (const tab of embeddedBrowserTabs.values()) detachEmbeddedBrowserTab(tab);
  embeddedBrowserVisible = false;
  embeddedBrowserAttached = false;
  embeddedBrowserLibraryPanel = '';
  embeddedBrowserLibraryView?.setVisible(false);
  notifyEmbeddedBrowserStateChange();
}

function setEmbeddedBrowserBounds(bounds) {
  const previousBounds = embeddedBrowserBounds;
  embeddedBrowserBounds = sanitizeEmbeddedBounds(bounds);
  const boundsChanged = previousBounds.x !== embeddedBrowserBounds.x
    || previousBounds.y !== embeddedBrowserBounds.y
    || previousBounds.width !== embeddedBrowserBounds.width
    || previousBounds.height !== embeddedBrowserBounds.height;
  const tab = activeEmbeddedBrowserTab();
  if (tab?.attached) {
    tab.view.setBounds(embeddedBrowserBounds);
    if (boundsChanged) scheduleEmbeddedBrowserFitForTab(tab, 180, { allowZoomIn: true });
  }
  if (embeddedBrowserLibraryPanel) attachEmbeddedBrowserLibraryView();
  return embeddedBrowserBounds;
}

function embeddedBrowserMinZoomFactor() {
  const configured = Number(process.env.ELECTRON_EMBEDDED_BROWSER_MIN_ZOOM || '');
  return Number.isFinite(configured) && configured > 0 && configured <= 1 ? configured : 0.2;
}

function embeddedBrowserAutoZoomEnabled() {
  return process.env.ELECTRON_EMBEDDED_BROWSER_AUTO_ZOOM === 'true';
}

function clearEmbeddedBrowserFitTimer() {
  if (!embeddedBrowserFitTimer) return;
  clearTimeout(embeddedBrowserFitTimer);
  embeddedBrowserFitTimer = undefined;
}

function scheduleEmbeddedBrowserFitToWidth(delayMs = 180, options = {}) {
  if (!embeddedBrowserAutoZoomEnabled()) return;
  embeddedBrowserFitAllowZoomIn = embeddedBrowserFitAllowZoomIn || Boolean(options.allowZoomIn);
  clearEmbeddedBrowserFitTimer();
  embeddedBrowserFitTimer = setTimeout(() => {
    embeddedBrowserFitTimer = undefined;
    const allowZoomIn = embeddedBrowserFitAllowZoomIn;
    embeddedBrowserFitAllowZoomIn = false;
    void fitEmbeddedBrowserToWidth(allowZoomIn);
  }, delayMs);
}

function clampEmbeddedBrowserZoom(value) {
  const minZoom = embeddedBrowserMinZoomFactor();
  return Math.max(minZoom, Math.min(1, Number(value) || 1));
}

async function fitEmbeddedBrowserToWidth(allowZoomIn = false) {
  const tab = activeEmbeddedBrowserTab();
  if (!tab || tab.view.webContents.isDestroyed()) return;
  const webContents = tab.view.webContents;
  const width = Math.max(1, Number(embeddedBrowserBounds.width) || 1);
  if (width < 80 || webContents.isLoading()) return;

  try {
    const metrics = await webContents.executeJavaScript(`
      (() => {
        const doc = document.documentElement;
        const body = document.body;
        const scrollWidth = Math.max(
          doc ? doc.scrollWidth : 0,
          body ? body.scrollWidth : 0,
          window.innerWidth || 0
        );
        const clientWidth = Math.max(
          doc ? doc.clientWidth : 0,
          body ? body.clientWidth : 0,
          window.innerWidth || 0,
          1
        );
        return { clientWidth, scrollWidth };
      })()
    `, true);
    const scrollWidth = Math.max(1, Number(metrics?.scrollWidth) || width);
    const clientWidth = Math.max(1, Number(metrics?.clientWidth) || width);
    const currentZoom = webContents.getZoomFactor();
    const overflowRatio = scrollWidth / clientWidth;
    let targetZoom = currentZoom;

    if (overflowRatio > 1.012) {
      targetZoom = currentZoom / overflowRatio;
    } else if (allowZoomIn && currentZoom < 0.995) {
      const spareRatio = clientWidth / Math.max(1, scrollWidth);
      if (spareRatio > 1.08) {
        targetZoom = currentZoom * Math.min(spareRatio, 1.35);
      }
    }

    targetZoom = Math.round(clampEmbeddedBrowserZoom(targetZoom) * 1000) / 1000;
    if (Math.abs(currentZoom - targetZoom) > 0.025) {
      webContents.setZoomFactor(targetZoom);
    }
  } catch (error) {
    appendLog(`Embedded browser width fit failed: ${error instanceof Error ? error.message : String(error)}`);
  }
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
  scheduleEmbeddedBrowserFitForTab(tab, 180, { allowZoomIn: true });
  return embeddedBrowserState();
}

function reloadEmbeddedBrowserTab() {
  const tab = activeEmbeddedBrowserTab();
  if (!tab || tab.view.webContents.isDestroyed()) return embeddedBrowserState();
  tab.view.webContents.reload();
  scheduleEmbeddedBrowserFitForTab(tab, 180, { allowZoomIn: true });
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
      createdAt: tab.createdAt || Date.now(),
      id: tab.groupId,
      sessionId: tab.sessionId || '',
    });
  }

  const groupIdsWithTabs = new Set();
  for (const tab of embeddedBrowserTabs.values()) {
    if (!tab.view.webContents.isDestroyed()) groupIdsWithTabs.add(tab.groupId);
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
      if (canonicalSessionId && group.sessionId !== canonicalSessionId) group.sessionId = canonicalSessionId;
      const webContents = tab.view.webContents;
      const url = webContents.getURL() || '';
      const title = embeddedBrowserTabTitle(webContents);
      const item = {
        audioMuted: Boolean(tab.audioMuted || webContents.isAudioMuted?.()),
        bookmarked: embeddedBrowserIsBookmarked(tab.lastKnownUrl || url),
        groupId: tab.groupId,
        id: tab.id,
        loading: webContents.isLoading() || Date.now() < (tab.routeLoadingUntil || 0),
        sessionId: tab.sessionId || undefined,
        title,
        url,
      };
      if (tab.id === embeddedBrowserActiveTabId) activeIndex = index;
      tabs.push(item);
      groupTabs.push(item);
      index += 1;
    }
    if (groupTabs.length || group.id === embeddedBrowserActiveGroupId || groupIdsWithTabs.has(group.id)) {
      groups.push({
        active: group.id === embeddedBrowserActiveGroupId,
        activeTabId: group.activeTabId || undefined,
        id: group.id,
        sessionId: group.sessionId || undefined,
        tabs: groupTabs,
      });
    }
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
    zoomFactor: active?.view.webContents.isDestroyed() ? undefined : active?.view.webContents.getZoomFactor(),
    tabs,
  };
}

function closeEmbeddedBrowserTab(tabId) {
  const tab = embeddedBrowserTabs.get(tabId) || activeEmbeddedBrowserTab();
  if (!tab) return embeddedBrowserState();
  const currentTabs = embeddedBrowserTabsForGroup(tab.groupId);
  const tabIndex = Math.max(0, currentTabs.findIndex((item) => item.id === tab.id));
  const wasActive = embeddedBrowserActiveTabId === tab.id;
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

function closeEmbeddedBrowserGroup(groupIdInput) {
  const groupId = String(groupIdInput || embeddedBrowserActiveGroupId || '').trim();
  if (!groupId) return embeddedBrowserState();

  const group = embeddedBrowserGroups.get(groupId);
  const groupTabs = embeddedBrowserTabsForGroup(groupId);
  if (!group && !groupTabs.length) return embeddedBrowserState();

  const wasActiveGroup = embeddedBrowserActiveGroupId === groupId
    || groupTabs.some((tab) => tab.id === embeddedBrowserActiveTabId);

  for (const tab of groupTabs) destroyEmbeddedBrowserTab(tab);
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
  const position = input.position === 'after' ? 'after' : 'before';
  if (!tabId || !targetId || tabId === targetId) return embeddedBrowserState();

  const tab = embeddedBrowserTabs.get(tabId);
  const target = embeddedBrowserTabs.get(targetId);
  if (!tab || !target || tab.view.webContents.isDestroyed() || target.view.webContents.isDestroyed()) {
    return embeddedBrowserState();
  }
  if (tab.groupId !== target.groupId) {
    throw new Error('Tabs can only be moved within the same tab group.');
  }

  const orderedTabs = Array.from(embeddedBrowserTabs.values()).filter((item) => item.id !== tab.id);
  const targetIndex = orderedTabs.findIndex((item) => item.id === target.id);
  if (targetIndex < 0) return embeddedBrowserState();
  orderedTabs.splice(targetIndex + (position === 'after' ? 1 : 0), 0, tab);

  embeddedBrowserTabs.clear();
  for (const item of orderedTabs) embeddedBrowserTabs.set(item.id, item);
  writeEmbeddedBrowserPersistence();
  scheduleEmbeddedBrowserPersistence();
  return embeddedBrowserState();
}

async function createManualEmbeddedBrowserTab(input = {}) {
  const group = ensureEmbeddedBrowserGroup(input);
  const sessionId = embeddedBrowserSessionIdFromGroupId(group.id) || group.sessionId || normalizeEmbeddedBrowserSessionId(input.sessionId);
  const rawUrl = String(input.url || '').trim();
  const url = rawUrl ? normalizeEmbeddedBrowserOpenUrl(rawUrl, mainWindow?.webContents?.getURL?.() || '') : '';
  if (rawUrl && !url) throw new Error(`Invalid embedded browser URL: ${rawUrl}`);
  const tab = createEmbeddedBrowserTab({ groupId: group.id, sessionId, url });
  if (embeddedBrowserVisible) attachEmbeddedBrowserView({ id: tab.id });
  else setActiveEmbeddedBrowserTab(tab);
  ensureEmbeddedBrowserTabReady(tab)
    .then(() => scheduleEmbeddedBrowserFitForTab(tab, 180, { allowZoomIn: true }))
    .catch((error) => appendLog(`Embedded browser tab ready failed: ${error instanceof Error ? error.message : String(error)}`));
  scheduleEmbeddedBrowserFitForTab(tab, 180, { allowZoomIn: true });
  return embeddedBrowserState();
}

function registerEmbeddedBrowserIpc() {
  ipcMain.on('webpilot:embedded-browser:content-resized', (event) => {
    const tab = activeEmbeddedBrowserTab();
    if (!tab || event.sender !== tab.view.webContents) return;
    scheduleEmbeddedBrowserFitForTab(tab, 420);
  });

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
    scheduleEmbeddedBrowserFitForTab(tab, 180, { allowZoomIn: true });
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

  ipcMain.handle('webpilot:embedded-browser:set-library-panel', async (_event, input = {}) => {
    try {
      return setEmbeddedBrowserLibraryPanel(input.panel);
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
        });
        const tab = activeEmbeddedBrowserTab();
        if (typeof input.url === 'string' && input.url.trim()) {
          if (!tab) throw new Error('Embedded browser tab is not ready.');
          await loadEmbeddedBrowserTabUrl(tab, input.url.trim());
          scheduleEmbeddedBrowserFitToWidth(180, { allowZoomIn: true });
        } else if (tab) {
          await ensureEmbeddedBrowserTabReady(tab);
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
      attachEmbeddedBrowserView({ createIfMissing: true, groupId: input.groupId, sessionId: input.sessionId });
      const tab = activeEmbeddedBrowserTab();
      if (!tab) throw new Error('Embedded browser tab is not ready.');
      await loadEmbeddedBrowserTabUrl(tab, url);
      scheduleEmbeddedBrowserFitToWidth(180, { allowZoomIn: true });
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
      scheduleEmbeddedBrowserFitToWidth(180, { allowZoomIn: true });
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
      return await startElectronDownload(webContents, url, 'Selected directory download', {
        defaultPath: typeof input.defaultPath === 'string' ? input.defaultPath : undefined,
        fileName: typeof input.fileName === 'string' ? input.fileName : undefined,
        promptForDirectory: true,
      });
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
    TINYMCE_ROOT: tinymceRoot(),
    WEBPILOT_ELECTRON_CDP_PORT: String(EMBEDDED_BROWSER_CDP_PORT),
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
  await waitForHttp(`${url}/dashboard`, 60_000, 3);
  await waitForHttp(`${url}/api/test-cases`, 30_000, 2);
  return url;
}

function createWindow() {
  nativeTheme.themeSource = 'dark';
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    title: APP_NAME,
    icon: appIconPath(),
    backgroundColor: '#0f131b',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath(),
    },
  });
  mainWindow.setMenuBarVisibility(false);
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
      startElectronDownload(preferredDownloadWebContents(), normalizedUrl, 'App shell download', { promptForDirectory: true })
        .then((result) => {
          if (result?.ok === false) appendLog(`App shell download failed: ${result.error || 'unknown error'}`);
        })
        .catch((error) => appendLog(`App shell download failed: ${error instanceof Error ? error.message : String(error)}`));
      return { action: 'deny' };
    }
    openAppShellUrlInEmbeddedBrowser(normalizedUrl)
      .catch((error) => appendLog(`App shell link open failed: ${error instanceof Error ? error.message : String(error)}`));
    return { action: 'deny' };
  });
  const loadingHtml = `
    <style>
      * { box-sizing: border-box; }
      body {
        background: #0f131b;
        color: #d7dee8;
        display: grid;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        height: 100vh;
        margin: 0;
        place-items: center;
      }
      h2 { font-size: 22px; margin: 0 0 8px; }
      p { color: #9ca3af; font-size: 14px; margin: 0; }
    </style>
    <body><div><h2>${APP_NAME}</h2><p>Starting local service...</p></div></body>`;
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml)}`);
  return mainWindow;
}

async function boot() {
  const appDataDir = ensureDir(path.join(app.getPath('userData'), 'runtime'));
  embeddedBrowserPersistencePath = path.join(appDataDir, EMBEDDED_BROWSER_PERSISTENCE_FILE);
  startupLogPath = path.join(appDataDir, 'startup.log');
  fs.writeFileSync(startupLogPath, '');
  appendLog(`App starting. packaged=${app.isPackaged}`);
  appendLog(`resourcesPath=${process.resourcesPath}`);
  appendLog(`WEBPILOT_ELECTRON_CDP_PORT=${EMBEDDED_BROWSER_CDP_PORT}`);
  createWindow();
  if (restoreEmbeddedBrowserPersistence()) appendLog('Embedded browser tabs restored from local cache.');

  try {
    const externalServerUrl = String(process.env.WEBPILOT_ELECTRON_SERVER_URL || '').trim().replace(/\/+$/, '');
    const url = externalServerUrl || await startServer(appDataDir);
    if (externalServerUrl) {
      await waitForHttp(`${url}/dashboard`, 60_000, 2);
    }
    await mainWindow.loadURL(url);
  } catch (error) {
    const output = recentServerOutput.length
      ? `\n\nRecent server output:\n${recentServerOutput.slice(-10).join('\n')}`
      : '';
    const logHint = startupLogPath ? `\n\nStartup log: ${startupLogPath}` : '';
    dialog.showErrorBox(APP_NAME, `${error instanceof Error ? error.message : String(error)}${output}${logHint}`);
    app.quit();
  }
}

registerEmbeddedBrowserIpc();
registerSystemIpc();

app.whenReady().then(boot);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
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
});
