/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { loadEnvConfig } = require('@next/env');

const root = path.resolve(__dirname, '..');
loadEnvConfig(root, true);

const virtualPython = path.join(
  root,
  '.venv-gliner',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python',
);
const configuredPython = String(process.env.GLINER_PYTHON_PATH || '').trim();
const pythonCommand = configuredPython || (fs.existsSync(virtualPython)
  ? virtualPython
  : process.platform === 'win32' ? 'python' : 'python3');
const endpoint = new URL(process.env.GLINER_SERVICE_URL || 'http://127.0.0.1:18001');
const configuredModelName = String(process.env.GLINER_MODEL || '').trim();
const modelName = !configuredModelName || configuredModelName === 'urchade/gliner_multi-v2.1'
  ? 'fastino/gliner2.5-multi-v1'
  : configuredModelName;
if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
  throw new Error('npm run gliner:start requires a loopback GLINER_SERVICE_URL.');
}

const child = spawn(pythonCommand, [
  '-m',
  'uvicorn',
  'app:app',
  '--host',
  endpoint.hostname,
  '--port',
  endpoint.port || '80',
  '--no-access-log',
], {
  cwd: path.join(root, 'services', 'gliner'),
  env: {
    ...process.env,
    GLINER_MODEL: modelName,
    HF_HOME: process.env.HF_HOME || path.join(root, '.data', 'gliner-models'),
    TRANSFORMERS_CACHE: process.env.TRANSFORMERS_CACHE || path.join(root, '.data', 'gliner-models'),
  },
  stdio: 'inherit',
  windowsHide: true,
});

child.once('error', (error) => {
  console.error(`Unable to start local GLiNER: ${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});

const stop = () => {
  if (child.exitCode === null && !child.killed) child.kill();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
