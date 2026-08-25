/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');
const { copyProductionRuntime, copyServerRuntime } = require('./server-package-layout');

const root = path.resolve(__dirname, '..');
const outputRoot = path.join(root, 'dist-desktop');
const serverOutput = path.join(outputRoot, 'server');

function copyInto(source, target) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

fs.rmSync(outputRoot, { recursive: true, force: true });
const productionPackagePaths = copyProductionRuntime(root, serverOutput);
copyInto(path.join(root, 'public'), path.join(serverOutput, 'public'));
const serverRuntimeFiles = copyServerRuntime(root, serverOutput);
copyInto(
  path.join(root, 'src', 'server', 'files', 'libreoffice-program-worker.py'),
  path.join(serverOutput, 'src', 'server', 'files', 'libreoffice-program-worker.py'),
);
copyInto(
  path.join(root, 'src', 'server', 'files', 'office-js-program-worker.mjs'),
  path.join(serverOutput, 'src', 'server', 'files', 'office-js-program-worker.mjs'),
);
copyInto(
  path.join(root, 'src', 'server', 'browser', 'session-tab-grouper-extension'),
  path.join(serverOutput, 'src', 'server', 'browser', 'session-tab-grouper-extension'),
);

if (
  !fs.existsSync(path.join(serverOutput, '.next', 'BUILD_ID'))
  || !fs.existsSync(path.join(serverOutput, '.next', 'required-server-files.json'))
  || !fs.existsSync(path.join(serverOutput, 'webpilot-server.js'))
  || !fs.existsSync(path.join(serverOutput, 'webpilot-identity.js'))
  || !fs.existsSync(path.join(serverOutput, 'realtime-refresh-hub.js'))
  || !fs.existsSync(path.join(serverOutput, 'node_modules', 'next', 'package.json'))
) {
  throw new Error('The complete production runtime required by the WebPilot custom server was not found. Run npm run build before packaging.');
}

console.log(`Prepared desktop server with ${productionPackagePaths.length} package directories and ${serverRuntimeFiles.length} custom server files at ${serverOutput}`);
