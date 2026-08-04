/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');

const requiredNextRuntimeFiles = [
  'package.json',
  path.join('dist', 'compiled', 'webpack', 'webpack.js'),
];

function assertCompleteNextRuntime(nextRoot, context = 'Next runtime') {
  const missing = requiredNextRuntimeFiles.filter((relativePath) => (
    !fs.existsSync(path.join(nextRoot, relativePath))
  ));
  if (missing.length) {
    throw new Error(`${context} is incomplete. Missing: ${missing.join(', ')}`);
  }
}

function copyCompleteNextRuntime(projectRoot, packagedServerRoot) {
  const source = path.join(projectRoot, 'node_modules', 'next');
  const target = path.join(packagedServerRoot, 'node_modules', 'next');
  assertCompleteNextRuntime(source, 'Installed Next runtime');
  fs.rmSync(target, { force: true, recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  assertCompleteNextRuntime(target, 'Packaged Next runtime');
}

module.exports = {
  assertCompleteNextRuntime,
  copyCompleteNextRuntime,
  requiredNextRuntimeFiles,
};
