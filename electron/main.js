const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const APP_NAME = 'AI Web Test';
const DEFAULT_PORT = 17890;

let serverProcess;
let mainWindow;
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

function waitForHttp(url, timeoutMs = 45_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });
      request.on('error', () => {
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
    APP_DATA_DIR: appDataDir,
    ARTIFACTS_DIR: ensureDir(path.join(appDataDir, 'artifacts')),
    BROWSER_SHARED_TABS: process.env.BROWSER_SHARED_TABS || 'true',
    BROWSER_USER_DATA_DIR: process.env.BROWSER_USER_DATA_DIR || browserProfileDir,
    HOSTNAME: '127.0.0.1',
    NODE_PATH: app.isPackaged ? path.join(serverDir, 'node_modules') : process.env.NODE_PATH,
    NODE_ENV: 'production',
    PORT: String(port),
    TINYMCE_ROOT: tinymceRoot(),
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
  await waitForHttp(`${url}/dashboard`);
  return url;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    title: APP_NAME,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  const loadingHtml = '<body style="font-family:system-ui;margin:0;display:grid;place-items:center;height:100vh;color:#242f3a"><div><h2>AI Web Test</h2><p>Starting local service...</p></div></body>';
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml)}`);
  return mainWindow;
}

async function boot() {
  const appDataDir = ensureDir(path.join(app.getPath('userData'), 'runtime'));
  startupLogPath = path.join(appDataDir, 'startup.log');
  fs.writeFileSync(startupLogPath, '');
  appendLog(`App starting. packaged=${app.isPackaged}`);
  appendLog(`resourcesPath=${process.resourcesPath}`);
  createWindow();

  try {
    const url = await startServer(appDataDir);
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

app.whenReady().then(boot);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});
