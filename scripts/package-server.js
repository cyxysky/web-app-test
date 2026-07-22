const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packageName = 'WebPilot-Server';
const outputRoot = path.join(root, 'dist-server');
const distributionRoot = path.join(outputRoot, packageName);
const serverRoot = path.join(distributionRoot, 'server');
const packageVersion = require(path.join(root, 'package.json')).version;
const archivePath = path.join(outputRoot, `${packageName}-${packageVersion}.zip`);

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
  const startScript = `@echo off\r\nsetlocal\r\n\r\nset "WEBPILOT_SERVER_ROOT=%~dp0"\r\nif not defined APP_DATA_DIR set "APP_DATA_DIR=%WEBPILOT_SERVER_ROOT%runtime"\r\nif not defined ARTIFACTS_DIR set "ARTIFACTS_DIR=%APP_DATA_DIR%\\artifacts"\r\nif not defined PLAYWRIGHT_BROWSERS_PATH set "PLAYWRIGHT_BROWSERS_PATH=%WEBPILOT_SERVER_ROOT%ms-playwright"\r\nif not defined TINYMCE_ROOT set "TINYMCE_ROOT=%WEBPILOT_SERVER_ROOT%tinymce"\r\nif not defined HOSTNAME set "HOSTNAME=0.0.0.0"\r\nif not defined PORT set "PORT=17890"\r\nif not defined NODE_ENV set "NODE_ENV=production"\r\nif not defined HEADLESS_BROWSER set "HEADLESS_BROWSER=true"\r\n\r\nif not exist "%APP_DATA_DIR%" mkdir "%APP_DATA_DIR%"\r\nif not exist "%ARTIFACTS_DIR%" mkdir "%ARTIFACTS_DIR%"\r\n\r\npushd "%WEBPILOT_SERVER_ROOT%server"\r\nnode server.js\r\nset "WEBPILOT_SERVER_EXIT_CODE=%ERRORLEVEL%"\r\npopd\r\nexit /b %WEBPILOT_SERVER_EXIT_CODE%\r\n`;
  fs.writeFileSync(path.join(distributionRoot, 'start.cmd'), startScript.replace('PORT=17890', 'PORT=3000'), 'utf8');
}

function writeReadme() {
  const readme = `# WebPilot HTTP Server\n\nRequirements: Node.js 22.13 or later. No npm install is required.\n\n1. Extract this directory.\n2. Run start.cmd.\n3. Open http://127.0.0.1:17890.\n\nThe service listens on all network interfaces by default. To change the port, run \`set PORT=3000 && start.cmd\` from Command Prompt, or set \`$env:PORT = '3000'; .\\start.cmd\` in PowerShell.\n\nRuntime data, artifacts, and browser profiles are written under the runtime directory unless APP_DATA_DIR or ARTIFACTS_DIR is set. Playwright Chromium is included in this package.\n`;
  const packagedReadme = readme
    .replace('http://127.0.0.1:17890', 'http://127.0.0.1:3000')
    .replace('set PORT=3000 && start.cmd', 'set PORT=17890 && start.cmd')
    .replace("$env:PORT = '3000'", "$env:PORT = '17890'");
  fs.writeFileSync(path.join(distributionRoot, 'README.md'), packagedReadme, 'utf8');
}

function createArchive() {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      '$items = Get-ChildItem -LiteralPath $env:WEBPILOT_SERVER_PACKAGE_ROOT -Force; Compress-Archive -LiteralPath $items.FullName -DestinationPath $env:WEBPILOT_SERVER_PACKAGE_ARCHIVE -Force',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        WEBPILOT_SERVER_PACKAGE_ROOT: distributionRoot,
        WEBPILOT_SERVER_PACKAGE_ARCHIVE: archivePath,
      },
    },
  );

  if (result.status !== 0) {
    throw new Error(`Failed to create ZIP archive: ${result.stderr || result.stdout || 'unknown error'}`);
  }
}

fs.rmSync(outputRoot, { recursive: true, force: true });
copyDir(path.join(root, '.next', 'standalone'), serverRoot);
copyInto(path.join(root, '.next', 'static'), path.join(serverRoot, '.next', 'static'));
copyInto(path.join(root, 'public'), path.join(serverRoot, 'public'));
copyDir(path.join(root, 'node_modules', 'tinymce'), path.join(distributionRoot, 'tinymce'));
copyPlaywrightChromium();

if (!fs.existsSync(path.join(serverRoot, 'server.js'))) {
  throw new Error('Next standalone server was not found. Run "npm run build" before packaging.');
}

writeStartScript();
writeReadme();
createArchive();

console.log(`Standalone server package created:\n  ${distributionRoot}\n  ${archivePath}`);
