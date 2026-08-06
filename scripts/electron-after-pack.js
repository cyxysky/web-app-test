const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function findBrowserRevisionDir(executablePath) {
  let dir = path.dirname(executablePath);
  while (dir && dir !== path.dirname(dir)) {
    const name = path.basename(dir);
    if (/^chromium(?:_headless_shell)?-\d+$/.test(name)) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`Unable to locate Playwright Chromium revision directory from: ${executablePath}`);
}

function copyPlaywrightChromium(context) {
  const { chromium } = require('playwright');
  const executablePath = chromium.executablePath();
  if (!fs.existsSync(executablePath)) {
    throw new Error(`Playwright Chromium executable was not found: ${executablePath}. Run "npx playwright install chromium" before packaging.`);
  }

  const sourceChromiumDir = findBrowserRevisionDir(executablePath);
  const targetRoot = path.join(context.appOutDir, 'resources', 'ms-playwright');
  const targetChromiumDir = path.join(targetRoot, path.basename(sourceChromiumDir));

  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.cpSync(sourceChromiumDir, targetChromiumDir, { recursive: true });

  const packagedExecutable = path.join(targetChromiumDir, path.relative(sourceChromiumDir, executablePath));
  if (!fs.existsSync(packagedExecutable)) {
    throw new Error(`Packaged Playwright Chromium executable is missing: ${packagedExecutable}`);
  }
}

function assertPackagedServerRuntime(serverRoot) {
  const runtimeRequire = createRequire(path.join(serverRoot, 'webpilot-server.js'));
  const packageRoot = path.join(serverRoot, 'node_modules') + path.sep;
  for (const dependency of ['next', 'playwright']) {
    try {
      const resolved = runtimeRequire.resolve(dependency);
      if (!resolved.startsWith(packageRoot)) {
        throw new Error(`resolved outside the packaged server: ${resolved}`);
      }
    } catch (error) {
      throw new Error(`The packaged server cannot resolve "${dependency}" from ${serverRoot}.`, { cause: error });
    }
  }
}

exports.default = async function afterPack(context) {
  const projectRoot = context.packager.projectDir;
  const source = path.join(projectRoot, 'dist-desktop', 'server', 'node_modules');
  const target = path.join(context.appOutDir, 'resources', 'server', 'node_modules');

  if (!fs.existsSync(source)) {
    throw new Error(`Desktop server dependencies were not found: ${source}`);
  }

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });

  assertPackagedServerRuntime(path.join(context.appOutDir, 'resources', 'server'));

  copyPlaywrightChromium(context);
};
