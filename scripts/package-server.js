/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');
const { copyProductionRuntime, copyServerRuntime } = require('./server-package-layout');
const { assertGlinerRuntime, copyGlinerRuntime } = require('./gliner-runtime-layout');

const root = path.resolve(__dirname, '..');
const packageName = 'WebPilot-Server';
const outputRoot = path.join(root, 'dist-server');
const distributionRoot = path.join(outputRoot, packageName);
const serverRoot = path.join(distributionRoot, 'server');

function copyDir(source, target) {
  if (!fs.existsSync(source)) {
    throw new Error(`Required source directory is missing: ${source}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

function copyInto(source, target) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

function findLibreOfficeRoot() {
  const configuredExecutable = String(process.env.LIBREOFFICE_PATH || '').trim();
  const candidates = [
    process.env.LIBREOFFICE_BUNDLE_DIR,
    configuredExecutable ? path.resolve(path.dirname(configuredExecutable), '..') : '',
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'LibreOffice'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'LibreOffice'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const libreOfficeRoot = path.resolve(candidate);
    if (fs.existsSync(path.join(libreOfficeRoot, 'program', 'soffice.exe'))) return libreOfficeRoot;
  }

  throw new Error(
    'LibreOffice was not found. Install LibreOffice or set LIBREOFFICE_BUNDLE_DIR before packaging the server.',
  );
}

function copyLibreOffice() {
  const sourceRoot = findLibreOfficeRoot();
  const targetRoot = path.join(distributionRoot, 'libreoffice');
  copyDir(sourceRoot, targetRoot);

  const packagedExecutable = path.join(targetRoot, 'program', 'soffice.exe');
  if (!fs.existsSync(packagedExecutable)) {
    throw new Error(`Packaged LibreOffice executable is missing: ${packagedExecutable}`);
  }
}

function findBrowserRevisionDir(executablePath) {
  let dir = path.dirname(executablePath);
  while (dir && dir !== path.dirname(dir)) {
    if (/^chromium(?:_headless_shell)?-\d+$/.test(path.basename(dir))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`Unable to locate the Playwright Chromium revision directory from: ${executablePath}`);
}

function copyPlaywrightChromium() {
  const { chromium } = require('playwright');
  const executablePath = chromium.executablePath();
  if (!fs.existsSync(executablePath)) {
    throw new Error('Playwright Chromium was not found. Run "npx playwright install chromium" before packaging.');
  }

  const sourceChromiumDir = findBrowserRevisionDir(executablePath);
  const targetRoot = path.join(distributionRoot, 'ms-playwright');
  copyDir(sourceChromiumDir, path.join(targetRoot, path.basename(sourceChromiumDir)));
}

function writeStartScript() {
  const startScript = `@echo off\r\nsetlocal\r\n\r\nset "WEBPILOT_SERVER_ROOT=%~dp0"\r\nif not defined APP_DATA_DIR set "APP_DATA_DIR=%WEBPILOT_SERVER_ROOT%runtime"\r\nif not defined ARTIFACTS_DIR set "ARTIFACTS_DIR=%APP_DATA_DIR%\\artifacts"\r\nif not defined PLAYWRIGHT_BROWSERS_PATH set "PLAYWRIGHT_BROWSERS_PATH=%WEBPILOT_SERVER_ROOT%ms-playwright"\r\nif not defined HOSTNAME set "HOSTNAME=0.0.0.0"\r\nif not defined PORT set "PORT=17890"\r\nif not defined NODE_ENV set "NODE_ENV=production"\r\nif not defined HEADLESS_BROWSER set "HEADLESS_BROWSER=true"\r\n\r\nif not exist "%APP_DATA_DIR%" mkdir "%APP_DATA_DIR%"\r\nif not exist "%ARTIFACTS_DIR%" mkdir "%ARTIFACTS_DIR%"\r\n\r\npushd "%WEBPILOT_SERVER_ROOT%server"\r\nnode webpilot-server.js\r\nset "WEBPILOT_SERVER_EXIT_CODE=%ERRORLEVEL%"\r\npopd\r\nexit /b %WEBPILOT_SERVER_EXIT_CODE%\r\n`;
  const packagedStartScript = startScript
    .replace(
      'if not defined HOSTNAME',
      'if not defined LIBREOFFICE_PATH set "LIBREOFFICE_PATH=%WEBPILOT_SERVER_ROOT%libreoffice\\program\\soffice.exe"\r\nif not defined LIBREOFFICE_PYTHON_PATH set "LIBREOFFICE_PYTHON_PATH=%WEBPILOT_SERVER_ROOT%libreoffice\\program\\python.exe"\r\nif not defined AI_SENSITIVE_DATA_FILTER_ENABLED set "AI_SENSITIVE_DATA_FILTER_ENABLED=true"\r\nif not defined AI_SENSITIVE_DATA_FILTER_FAILURE_MODE set "AI_SENSITIVE_DATA_FILTER_FAILURE_MODE=closed"\r\nif not defined GLINER_BATCH_SIZE set "GLINER_BATCH_SIZE=8"\r\nif not defined GLINER_DEVICE set "GLINER_DEVICE=cpu"\r\nif not defined GLINER_RUNTIME_MODE set "GLINER_RUNTIME_MODE=local"\r\nif not defined GLINER_SERVICE_URL set "GLINER_SERVICE_URL=http://127.0.0.1:18001"\r\nif not defined GLINER_PYTHON_PATH set "GLINER_PYTHON_PATH=%WEBPILOT_SERVER_ROOT%server\\gliner-runtime\\python\\python.exe"\r\nif not defined GLINER_SERVICE_DIR set "GLINER_SERVICE_DIR=%WEBPILOT_SERVER_ROOT%server\\gliner-runtime\\service"\r\nif not defined GLINER_MODEL_BUNDLE_DIR set "GLINER_MODEL_BUNDLE_DIR=%WEBPILOT_SERVER_ROOT%server\\gliner-runtime\\models\\gliner2"\r\nif not defined GLINER_CHINESE_NER_MODEL_BUNDLE_DIR set "GLINER_CHINESE_NER_MODEL_BUNDLE_DIR=%WEBPILOT_SERVER_ROOT%server\\gliner-runtime\\models\\chinese-roberta"\r\nif not defined GLINER_PII_MODEL_BUNDLE_DIR set "GLINER_PII_MODEL_BUNDLE_DIR=%WEBPILOT_SERVER_ROOT%server\\gliner-runtime\\models\\liquid-pii"\r\nif not defined HOSTNAME',
    )
    .replace('PORT=17890', 'PORT=3000');
  fs.writeFileSync(path.join(distributionRoot, 'start.cmd'), packagedStartScript, 'utf8');
}

function writeReadme() {
  const readme = `# WebPilot HTTP Server\n\nRequirements: Node.js 22.16 or later. No npm install is required.\n\n1. Extract this directory.\n2. Run start.cmd.\n3. Open http://127.0.0.1:17890.\n\nLocal direct access uses WEBPILOT_DEFAULT_USER_ID (default: 1). For an online mounted deployment, set WEBPILOT_REQUIRE_MOUNT_USER_ID=true and pass userId to WebPilotQA.mount().\n\nThe service listens on all network interfaces by default. To change the port, run \`set PORT=3000 && start.cmd\` from Command Prompt, or set \`$env:PORT = '3000'; .\\start.cmd\` in PowerShell. HTTP and WebSocket traffic share this one public port.\n\nRuntime data, artifacts, and browser profiles are written under the runtime directory unless APP_DATA_DIR or ARTIFACTS_DIR is set. Playwright Chromium is included in this package.\n`;
  const packagedReadme = readme
    .replace('Playwright Chromium is included in this package.', 'Playwright Chromium, LibreOffice, Python, GLiNER, and the multilingual redaction models are included in this package. No separate runtime installation is required.')
    .replace('http://127.0.0.1:17890', 'http://127.0.0.1:3000')
    .replace('set PORT=3000 && start.cmd', 'set PORT=17890 && start.cmd')
    .replace("$env:PORT = '3000'", "$env:PORT = '17890'");
  fs.writeFileSync(path.join(distributionRoot, 'README.md'), packagedReadme, 'utf8');
}

function copyBrowserSessionExtension() {
  copyDir(
    path.join(root, 'src', 'server', 'browser', 'session-tab-grouper-extension'),
    path.join(serverRoot, 'src', 'server', 'browser', 'session-tab-grouper-extension'),
  );
}

function removePackageEntry(entryPath) {
  try {
    fs.rmSync(entryPath, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 200,
    });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
    if (code === 'EBUSY' || code === 'EPERM') {
      throw new Error(`Unable to replace the existing server package because a file is in use: ${entryPath}. Stop the packaged server and try again.`, { cause: error });
    }
    throw error;
  }
}

function prepareOutputDirectory() {
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.mkdirSync(distributionRoot, { recursive: true });
  for (const entry of fs.readdirSync(distributionRoot, { withFileTypes: true })) {
    removePackageEntry(path.join(distributionRoot, entry.name));
  }
}

prepareOutputDirectory();
const productionPackagePaths = copyProductionRuntime(root, serverRoot);
copyInto(path.join(root, 'public'), path.join(serverRoot, 'public'));
const serverRuntimeFiles = copyServerRuntime(root, serverRoot);
copyGlinerRuntime(path.join(serverRoot, 'gliner-runtime'));
copyInto(
  path.join(root, 'src', 'server', 'files', 'libreoffice-program-worker.py'),
  path.join(serverRoot, 'src', 'server', 'files', 'libreoffice-program-worker.py'),
);
copyInto(
  path.join(root, 'src', 'server', 'files', 'office-js-program-worker.mjs'),
  path.join(serverRoot, 'src', 'server', 'files', 'office-js-program-worker.mjs'),
);
copyBrowserSessionExtension();
copyLibreOffice();
copyPlaywrightChromium();

if (
  !fs.existsSync(path.join(serverRoot, '.next', 'BUILD_ID'))
  || !fs.existsSync(path.join(serverRoot, '.next', 'required-server-files.json'))
  || !fs.existsSync(path.join(serverRoot, 'webpilot-server.js'))
  || !fs.existsSync(path.join(serverRoot, 'webpilot-identity.js'))
  || !fs.existsSync(path.join(serverRoot, 'realtime-refresh-hub.js'))
  || !fs.existsSync(path.join(serverRoot, 'node_modules', 'next', 'package.json'))
  || !fs.existsSync(path.join(distributionRoot, 'libreoffice', 'program', 'soffice.exe'))
) {
  throw new Error('The complete production runtime required by the WebPilot custom server was not found. Run "npm run build" before packaging.');
}
assertGlinerRuntime(path.join(serverRoot, 'gliner-runtime'));

writeStartScript();
writeReadme();

console.log(`Production server package created with ${productionPackagePaths.length} package directories and ${serverRuntimeFiles.length} custom server files:\n  ${distributionRoot}`);
