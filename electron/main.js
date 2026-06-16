const { app, BrowserWindow, WebContentsView, dialog, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
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
let embeddedBrowserActiveTabId = '';
let embeddedBrowserNextTabId = 1;
const embeddedBrowserTabs = new Map();
let embeddedBrowserBounds = { x: 0, y: 0, width: 0, height: 0 };
let embeddedBrowserFitTimer;
let embeddedBrowserFitAllowZoomIn = false;
let startupLogPath;
let recentServerOutput = [];

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
    '<head><meta charset="utf-8"><title>WebPilot Embedded Browser</title></head>',
    '<body style="margin:0;font:14px system-ui;background:#f8fafc;color:#334155;display:grid;place-items:center;height:100vh">',
    '<div>WebPilot embedded browser</div>',
    '</body>',
    '</html>',
  ].join('');
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
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

function embeddedBrowserTabIdForSession(sessionId) {
  const normalized = normalizeEmbeddedBrowserSessionId(sessionId);
  return normalized ? `session:${normalized}` : 'default';
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

function loadEmbeddedBrowserTabUrl(tab, url) {
  if (!tab || tab.view.webContents.isDestroyed()) return Promise.resolve();
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
  let tab = embeddedBrowserTabs.get(embeddedBrowserActiveTabId);
  if (tab && !tab.view.webContents.isDestroyed()) return tab;
  for (const item of embeddedBrowserTabs.values()) {
    if (!item.view.webContents.isDestroyed()) {
      embeddedBrowserActiveTabId = item.id;
      embeddedBrowserView = item.view;
      embeddedBrowserAttached = item.attached;
      return item;
    }
  }
  embeddedBrowserActiveTabId = '';
  embeddedBrowserView = undefined;
  embeddedBrowserAttached = false;
  return undefined;
}

function setActiveEmbeddedBrowserTab(tab) {
  embeddedBrowserActiveTabId = tab?.id || '';
  embeddedBrowserView = tab?.view;
  embeddedBrowserAttached = Boolean(tab?.attached);
}

function scheduleEmbeddedBrowserFitForTab(tab, delayMs = 180, options = {}) {
  if (activeEmbeddedBrowserTab()?.id !== tab?.id) return;
  scheduleEmbeddedBrowserFitToWidth(delayMs, options);
}

function installEmbeddedBrowserTabHandlers(tab) {
  const { view } = tab;
  view.webContents.setWindowOpenHandler(({ url }) => {
    loadEmbeddedBrowserTabUrl(tab, url)
      .then(() => {
        scheduleEmbeddedBrowserFitForTab(tab, 180, { allowZoomIn: true });
      })
      .catch((error) => appendLog(`Embedded browser popup navigation failed: ${error.message}`));
    return { action: 'deny' };
  });
  view.webContents.on('dom-ready', () => {
    void markEmbeddedBrowserSession(tab);
    scheduleEmbeddedBrowserFitForTab(tab, 140, { allowZoomIn: true });
  });
  view.webContents.on('did-finish-load', () => {
    void markEmbeddedBrowserSession(tab);
    scheduleEmbeddedBrowserFitForTab(tab, 180, { allowZoomIn: true });
  });
  view.webContents.on('did-stop-loading', () => {
    void markEmbeddedBrowserSession(tab);
    scheduleEmbeddedBrowserFitForTab(tab, 240, { allowZoomIn: true });
  });
  view.webContents.on('did-navigate', () => {
    void markEmbeddedBrowserSession(tab);
    scheduleEmbeddedBrowserFitForTab(tab, 180, { allowZoomIn: true });
  });
  view.webContents.on('did-navigate-in-page', () => {
    void markEmbeddedBrowserSession(tab);
    scheduleEmbeddedBrowserFitForTab(tab, 220, { allowZoomIn: true });
  });
  view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    appendLog(`Embedded browser failed to load ${validatedURL}: ${errorCode} ${errorDescription}`);
  });
  view.webContents.once('destroyed', () => {
    embeddedBrowserTabs.delete(tab.id);
    if (embeddedBrowserActiveTabId === tab.id) {
      embeddedBrowserActiveTabId = '';
      embeddedBrowserView = undefined;
      embeddedBrowserAttached = false;
    }
  });
}

function createEmbeddedBrowserTab(input = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Main window is not ready.');
  if (!WebContentsView) throw new Error('Electron WebContentsView is not available.');
  const sessionId = normalizeEmbeddedBrowserSessionId(input.sessionId);
  const tabId = input.id || (sessionId ? embeddedBrowserTabIdForSession(sessionId) : `tab:${embeddedBrowserNextTabId++}`);
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: embeddedBrowserPreloadPath(),
      sandbox: false,
    },
  });
  const tab = {
    attached: false,
    createdAt: Date.now(),
    id: tabId,
    readyPromise: undefined,
    sessionId,
    view,
  };
  view.webContents.setZoomFactor(1);
  embeddedBrowserTabs.set(tab.id, tab);
  installEmbeddedBrowserTabHandlers(tab);
  tab.readyPromise = loadEmbeddedBrowserTabUrl(tab, embeddedBrowserPlaceholderUrl()).catch((error) => {
    appendLog(`Embedded browser placeholder load failed: ${error.message}`);
  });
  return tab;
}

function ensureEmbeddedBrowserTab(input = {}) {
  const sessionId = normalizeEmbeddedBrowserSessionId(input.sessionId);
  const tabId = sessionId ? embeddedBrowserTabIdForSession(sessionId) : (input.id || 'default');
  let tab = embeddedBrowserTabs.get(tabId);
  if (tab?.view.webContents.isDestroyed()) {
    embeddedBrowserTabs.delete(tabId);
    tab = undefined;
  }

  if (!tab) {
    if (sessionId) {
      const defaultTab = embeddedBrowserTabs.get('default');
      if (defaultTab && embeddedBrowserTabs.size === 1) destroyEmbeddedBrowserTab(defaultTab);
    }
    tab = createEmbeddedBrowserTab({ id: tabId, sessionId });
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
}

function attachEmbeddedBrowserView(input = {}) {
  const tab = ensureEmbeddedBrowserTab(input);
  embeddedBrowserVisible = true;
  for (const item of embeddedBrowserTabs.values()) {
    if (item.id !== tab.id) detachEmbeddedBrowserTab(item);
  }
  if (!tab.attached) {
    mainWindow.contentView.addChildView(tab.view);
    tab.attached = true;
  }
  setActiveEmbeddedBrowserTab(tab);
  tab.view.setBounds(embeddedBrowserBounds);
  void markEmbeddedBrowserSession(tab);
  scheduleEmbeddedBrowserFitForTab(tab, 180, { allowZoomIn: true });
  return tab.view;
}

function detachEmbeddedBrowserView() {
  for (const tab of embeddedBrowserTabs.values()) detachEmbeddedBrowserTab(tab);
  embeddedBrowserVisible = false;
  embeddedBrowserAttached = false;
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

function embeddedBrowserState() {
  const active = activeEmbeddedBrowserTab();
  const tabs = [];
  let activeIndex = -1;
  let index = 0;
  for (const tab of embeddedBrowserTabs.values()) {
    if (tab.view.webContents.isDestroyed()) continue;
    const webContents = tab.view.webContents;
    const url = webContents.getURL() || '';
    const title = webContents.getTitle() || url || 'New tab';
    if (tab.id === embeddedBrowserActiveTabId) activeIndex = index;
    tabs.push({
      id: tab.id,
      loading: webContents.isLoading(),
      sessionId: tab.sessionId || undefined,
      title,
      url,
    });
    index += 1;
  }
  return {
    ok: true,
    activeIndex,
    zoomFactor: active?.view.webContents.isDestroyed() ? undefined : active?.view.webContents.getZoomFactor(),
    tabs,
  };
}

function closeEmbeddedBrowserTab(tabId) {
  const currentTabs = Array.from(embeddedBrowserTabs.values()).filter((tab) => !tab.view.webContents.isDestroyed());
  const tab = embeddedBrowserTabs.get(tabId) || activeEmbeddedBrowserTab();
  if (!tab) return embeddedBrowserState();
  const tabIndex = Math.max(0, currentTabs.findIndex((item) => item.id === tab.id));
  const wasActive = embeddedBrowserActiveTabId === tab.id;
  destroyEmbeddedBrowserTab(tab);

  let nextTab;
  const remainingTabs = Array.from(embeddedBrowserTabs.values()).filter((item) => !item.view.webContents.isDestroyed());
  if (!remainingTabs.length) {
    nextTab = createEmbeddedBrowserTab({ id: 'default' });
  } else if (wasActive) {
    nextTab = remainingTabs[Math.max(0, Math.min(tabIndex - 1, remainingTabs.length - 1))] || remainingTabs[0];
  } else {
    nextTab = activeEmbeddedBrowserTab() || remainingTabs[0];
  }

  if (nextTab) {
    if (embeddedBrowserVisible) attachEmbeddedBrowserView({ id: nextTab.id });
    else setActiveEmbeddedBrowserTab(nextTab);
  }
  return embeddedBrowserState();
}

function registerEmbeddedBrowserIpc() {
  ipcMain.on('webpilot:embedded-browser:content-resized', (event) => {
    const tab = activeEmbeddedBrowserTab();
    if (!tab || event.sender !== tab.view.webContents) return;
    scheduleEmbeddedBrowserFitForTab(tab, 420);
  });

  ipcMain.handle('webpilot:embedded-browser:get-state', async () => {
    try {
      return embeddedBrowserState();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('webpilot:embedded-browser:set-visible', async (_event, input = {}) => {
    try {
      if (input.bounds) setEmbeddedBrowserBounds(input.bounds);
      if (input.visible) {
        const view = attachEmbeddedBrowserView({ sessionId: input.sessionId });
        const tab = activeEmbeddedBrowserTab();
        if (typeof input.url === 'string' && input.url.trim()) {
          await loadEmbeddedBrowserTabUrl(tab, input.url.trim());
          scheduleEmbeddedBrowserFitToWidth(180, { allowZoomIn: true });
        } else {
          await ensureEmbeddedBrowserTabReady(tab);
        }
      } else {
        detachEmbeddedBrowserView();
      }
      return { ok: true };
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
      attachEmbeddedBrowserView({ sessionId: input.sessionId });
      const tab = activeEmbeddedBrowserTab();
      await loadEmbeddedBrowserTabUrl(tab, url);
      scheduleEmbeddedBrowserFitToWidth(180, { allowZoomIn: true });
      return { ok: true };
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
      attachEmbeddedBrowserView({ id: embeddedBrowserActiveTabId || undefined });
      const tab = activeEmbeddedBrowserTab();
      await loadEmbeddedBrowserTabUrl(tab, embeddedBrowserPlaceholderUrl());
      scheduleEmbeddedBrowserFitToWidth(180, { allowZoomIn: true });
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
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    title: APP_NAME,
    icon: appIconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath(),
    },
  });
  mainWindow.setMenuBarVisibility(false);
  const loadingHtml = `<body style="font-family:system-ui;margin:0;display:grid;place-items:center;height:100vh;color:#242f3a"><div><h2>${APP_NAME}</h2><p>Starting local service...</p></div></body>`;
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml)}`);
  return mainWindow;
}

async function boot() {
  const appDataDir = ensureDir(path.join(app.getPath('userData'), 'runtime'));
  startupLogPath = path.join(appDataDir, 'startup.log');
  fs.writeFileSync(startupLogPath, '');
  appendLog(`App starting. packaged=${app.isPackaged}`);
  appendLog(`resourcesPath=${process.resourcesPath}`);
  appendLog(`WEBPILOT_ELECTRON_CDP_PORT=${EMBEDDED_BROWSER_CDP_PORT}`);
  createWindow();

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

app.whenReady().then(boot);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  clearEmbeddedBrowserFitTimer();
  detachEmbeddedBrowserView();
  for (const tab of Array.from(embeddedBrowserTabs.values())) destroyEmbeddedBrowserTab(tab);
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});
