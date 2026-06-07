const fs = require('node:fs');
const path = require('node:path');

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
  const sourceRoot = path.dirname(sourceChromiumDir);
  const revision = path.basename(sourceChromiumDir).match(/-(\d+)$/)?.[1];
  const browserDirs = [
    path.basename(sourceChromiumDir),
    revision ? `chromium_headless_shell-${revision}` : '',
  ].filter(Boolean);
  const targetRoot = path.join(context.appOutDir, 'resources', 'ms-playwright');

  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.mkdirSync(targetRoot, { recursive: true });
  for (const dirName of browserDirs) {
    const sourceDir = path.join(sourceRoot, dirName);
    if (!fs.existsSync(sourceDir)) continue;
    fs.cpSync(sourceDir, path.join(targetRoot, dirName), { recursive: true });
  }

  const packagedExecutable = path.join(targetRoot, path.basename(sourceChromiumDir), path.relative(sourceChromiumDir, executablePath));
  if (!fs.existsSync(packagedExecutable)) {
    throw new Error(`Packaged Playwright Chromium executable is missing: ${packagedExecutable}`);
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

  for (const dependency of ['next', 'playwright']) {
    const dependencyPath = path.join(target, dependency);
    if (!fs.existsSync(dependencyPath)) {
      throw new Error(`Packaged server dependency is missing: ${dependencyPath}`);
    }
  }

  copyPlaywrightChromium(context);
};
