/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const preparedGlinerRuntimeRoot = path.join(projectRoot, 'dist-gliner-runtime', 'win32-x64');

function requiredGlinerRuntimeEntries(runtimeRoot = preparedGlinerRuntimeRoot) {
  return [
    path.join(runtimeRoot, 'runtime-manifest.json'),
    path.join(runtimeRoot, 'python', 'python.exe'),
    path.join(runtimeRoot, 'service', 'app.py'),
    path.join(runtimeRoot, 'service', 'candidate_resolution.py'),
    path.join(runtimeRoot, 'service', 'entity_boundaries.py'),
    path.join(runtimeRoot, 'models', 'gliner2', 'config.json'),
    path.join(runtimeRoot, 'models', 'chinese-roberta', 'config.json'),
  ];
}

function assertGlinerRuntime(runtimeRoot = preparedGlinerRuntimeRoot) {
  const missing = requiredGlinerRuntimeEntries(runtimeRoot).filter((entry) => !fs.existsSync(entry));
  if (missing.length) {
    throw new Error(`The bundled GLiNER runtime is incomplete. Run "npm run gliner:bundle" first. Missing:\n${missing.join('\n')}`);
  }
  return runtimeRoot;
}

function copyGlinerRuntime(targetRoot, sourceRoot = preparedGlinerRuntimeRoot) {
  assertGlinerRuntime(sourceRoot);
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
  fs.cpSync(sourceRoot, targetRoot, { recursive: true });
  assertGlinerRuntime(targetRoot);
  return targetRoot;
}

module.exports = {
  assertGlinerRuntime,
  copyGlinerRuntime,
  preparedGlinerRuntimeRoot,
  requiredGlinerRuntimeEntries,
};
