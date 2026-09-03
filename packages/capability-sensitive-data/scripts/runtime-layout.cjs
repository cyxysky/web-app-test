/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');

const hostRoot = process.cwd();
const preparedSensitiveDataRuntimeRoot = path.resolve(
  process.env.SENSITIVE_DATA_BUNDLE_OUTPUT_DIR
    || path.join(hostRoot, 'dist-sensitive-data-runtime', 'win32-x64'),
);

function requiredSensitiveDataRuntimeEntries(runtimeRoot = preparedSensitiveDataRuntimeRoot) {
  return [
    path.join(runtimeRoot, 'runtime-manifest.json'),
    path.join(runtimeRoot, 'python', 'python.exe'),
    path.join(runtimeRoot, 'service', 'app.py'),
    path.join(runtimeRoot, 'service', 'candidate_resolution.py'),
    path.join(runtimeRoot, 'service', 'entity_boundaries.py'),
    path.join(runtimeRoot, 'service', 'deterministic_spans.py'),
    path.join(runtimeRoot, 'models', 'gliner2', 'config.json'),
    path.join(runtimeRoot, 'models', 'chinese-roberta', 'config.json'),
    path.join(runtimeRoot, 'models', 'liquid-pii', 'config.json'),
    path.join(runtimeRoot, 'models', 'liquid-pii', 'pii_hybrid_decode.py'),
  ];
}

function assertSensitiveDataRuntime(runtimeRoot = preparedSensitiveDataRuntimeRoot) {
  const missing = requiredSensitiveDataRuntimeEntries(runtimeRoot).filter((entry) => !fs.existsSync(entry));
  if (missing.length) {
    throw new Error(`The bundled sensitive-data runtime is incomplete. Run "npm run sensitive-data:bundle" first. Missing:\n${missing.join('\n')}`);
  }
  return runtimeRoot;
}

function copySensitiveDataRuntime(targetRoot, sourceRoot = preparedSensitiveDataRuntimeRoot) {
  assertSensitiveDataRuntime(sourceRoot);
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
  fs.cpSync(sourceRoot, targetRoot, { recursive: true });
  assertSensitiveDataRuntime(targetRoot);
  return targetRoot;
}

module.exports = {
  assertSensitiveDataRuntime,
  copySensitiveDataRuntime,
  preparedSensitiveDataRuntimeRoot,
  requiredSensitiveDataRuntimeEntries,
};
