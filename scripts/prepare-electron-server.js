const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outputRoot = path.join(root, 'dist-desktop');
const serverOutput = path.join(outputRoot, 'server');

function copyDir(source, target) {
  if (!fs.existsSync(source)) return;
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

function copyInto(source, target) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

function copyFfmpegStatic() {
  const source = path.join(root, 'node_modules', 'ffmpeg-static');
  if (!fs.existsSync(source)) {
    throw new Error('ffmpeg-static was not found. Run npm install before packaging the desktop app.');
  }
  copyInto(source, path.join(serverOutput, 'node_modules', 'ffmpeg-static'));
}

fs.rmSync(outputRoot, { recursive: true, force: true });
copyDir(path.join(root, '.next', 'standalone'), serverOutput);
copyInto(path.join(root, '.next', 'static'), path.join(serverOutput, '.next', 'static'));
copyInto(path.join(root, 'public'), path.join(serverOutput, 'public'));
copyFfmpegStatic();

if (!fs.existsSync(path.join(serverOutput, 'server.js'))) {
  throw new Error('Next standalone server was not found. Run next build with output: "standalone" first.');
}

console.log(`Prepared desktop server at ${serverOutput}`);
