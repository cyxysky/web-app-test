/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');

const requiredProductionRuntimeEntries = [
  path.join('.next', 'BUILD_ID'),
  path.join('.next', 'required-server-files.json'),
  'node_modules',
  'package.json',
  'package-lock.json',
];

function assertProductionRuntimeSource(projectRoot) {
  const missing = requiredProductionRuntimeEntries.filter((entry) => !fs.existsSync(path.join(projectRoot, entry)));
  if (missing.length) {
    throw new Error(`The production runtime source is incomplete. Missing: ${missing.join(', ')}. Run npm install and npm run build before packaging.`);
  }
}

function packagePathFromLockEntry(relativePath) {
  return path.join(...relativePath.split('/'));
}

function productionPackagePaths(projectRoot) {
  assertProductionRuntimeSource(projectRoot);
  const lockPath = path.join(projectRoot, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (!lock || typeof lock !== 'object' || !lock.packages || typeof lock.packages !== 'object') {
    throw new Error(`The package lock is invalid or does not contain package entries: ${lockPath}`);
  }

  const missingRequiredPackages = [];
  const packagePaths = [];
  for (const [relativePath, metadata] of Object.entries(lock.packages)) {
    if (!relativePath.startsWith('node_modules/') || !metadata || typeof metadata !== 'object' || metadata.dev === true) continue;
    const packagePath = packagePathFromLockEntry(relativePath);
    if (fs.existsSync(path.join(projectRoot, packagePath))) {
      packagePaths.push(packagePath);
    } else if (metadata.optional !== true) {
      missingRequiredPackages.push(relativePath);
    }
  }

  if (missingRequiredPackages.length) {
    throw new Error(`Installed production dependencies are incomplete. Missing: ${missingRequiredPackages.join(', ')}. Run npm install before packaging.`);
  }
  return packagePaths;
}

function copyBuildOutput(projectRoot, target) {
  const source = path.join(projectRoot, '.next');
  const nextTarget = path.join(target, '.next');
  fs.cpSync(source, nextTarget, {
    recursive: true,
    // Turbopack places external server packages under .next/node_modules as
    // Windows junctions. A deployment package must contain their files, not
    // recreate those links: creating a symlink requires elevated privileges or
    // Developer Mode and the source project path is unavailable after deploy.
    dereference: true,
    filter: (entry) => {
      const relativePath = path.relative(source, entry);
      return relativePath !== 'cache'
        && !relativePath.startsWith(`cache${path.sep}`)
        && relativePath !== 'standalone'
        && !relativePath.startsWith(`standalone${path.sep}`);
    },
  });
}

function serverRuntimeFilePaths(projectRoot) {
  const sourceRoot = path.join(projectRoot, 'server');
  const entryPath = path.join(sourceRoot, 'webpilot-server.js');
  if (!fs.existsSync(entryPath)) {
    throw new Error(`The custom server entry is missing: ${entryPath}`);
  }

  const runtimeFiles = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && !entry.name.endsWith('.test.js')) {
        runtimeFiles.push(path.relative(sourceRoot, entryPath));
      }
    }
  };
  visit(sourceRoot);
  return runtimeFiles.sort();
}

function copyServerRuntime(projectRoot, target) {
  const sourceRoot = path.join(projectRoot, 'server');
  const runtimeFiles = serverRuntimeFilePaths(projectRoot);
  for (const relativePath of runtimeFiles) {
    const destination = path.join(target, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(path.join(sourceRoot, relativePath), destination);
  }
  return runtimeFiles;
}

function copyProductionRuntime(projectRoot, target) {
  const packagePaths = productionPackagePaths(projectRoot);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });

  copyBuildOutput(projectRoot, target);
  fs.cpSync(path.join(projectRoot, 'package.json'), path.join(target, 'package.json'));
  const envSource = path.join(projectRoot, '.env');
  if (fs.existsSync(envSource)) fs.cpSync(envSource, path.join(target, '.env'));

  for (const packagePath of packagePaths) {
    const source = path.join(projectRoot, packagePath);
    const destination = path.join(target, packagePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true });
  }
  return packagePaths;
}

module.exports = {
  assertProductionRuntimeSource,
  copyProductionRuntime,
  copyServerRuntime,
  productionPackagePaths,
  requiredProductionRuntimeEntries,
  serverRuntimeFilePaths,
};
