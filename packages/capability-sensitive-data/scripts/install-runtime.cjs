/* eslint-disable @typescript-eslint/no-require-imports */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const hostRoot = process.cwd();
const virtualEnvironment = path.resolve(process.env.GLINER_VENV_DIR || path.join(hostRoot, '.venv-gliner'));
const virtualPython = path.join(
  virtualEnvironment,
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python',
);

function succeeds(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  return result.status === 0;
}

function bootstrapPython() {
  const configured = String(process.env.GLINER_BOOTSTRAP_PYTHON || '').trim();
  const candidates = [
    ...(configured ? [{ command: configured, args: [] }] : []),
    { command: 'python', args: [] },
    ...(process.platform === 'win32' ? [{ command: 'py', args: ['-3.11'] }] : []),
    { command: 'python3', args: [] },
  ];
  return candidates.find((candidate) => succeeds(candidate.command, [...candidate.args, '-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)']));
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: hostRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}.`);
}

if (!fs.existsSync(virtualPython)) {
  const python = bootstrapPython();
  if (!python) {
    throw new Error('Python 3.10 or newer was not found. Install Python 3.11 or set GLINER_BOOTSTRAP_PYTHON.');
  }
  console.log(`Creating GLiNER virtual environment at ${virtualEnvironment}`);
  run(python.command, [...python.args, '-m', 'venv', virtualEnvironment]);
}

run(virtualPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
run(virtualPython, ['-m', 'pip', 'install', '-r', path.join(packageRoot, 'runtime', 'python', 'requirements.txt')]);
console.log('Local GLiNER dependencies are installed. npm run dev will start the sidecar on demand in auto/local mode.');
