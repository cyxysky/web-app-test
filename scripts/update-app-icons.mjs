import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artwork = await readFile(path.join(root, 'assets/orbit-icon-source.png'));
const master = await readFile(path.join(root, 'assets/orbit-icon.svg'), 'utf8');
// Inline the original artwork so SVG rendering does not depend on external file loading.
const source = Buffer.from(master.replace('href="orbit-icon-source.png"', `href="data:image/png;base64,${artwork.toString('base64')}"`));
const metadata = await sharp(source).metadata();
if (!metadata.width || metadata.width !== metadata.height) throw new Error('The app icon master must be square.');
const alpha = (await sharp(source).ensureAlpha().stats()).channels[3];
if (alpha.min !== 0 || alpha.max !== 255) throw new Error('The app icon must contain transparent space and opaque ribbons.');

const images = new Map();
async function png(size) {
  if (!images.has(size)) images.set(size, await sharp(source).resize(size, size).ensureAlpha().png({ compressionLevel: 9 }).toBuffer());
  return images.get(size);
}

async function save(relativePath, content) {
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Icon output must stay inside the project.');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

// Small DIB frames retain compatibility with installer resource editors; 256px uses PNG.
async function dib(size) {
  const pixels = await sharp(await png(size)).ensureAlpha().raw().toBuffer();
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4, 20);
  const bitmap = Buffer.alloc(size * size * 4);
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sourceOffset = (y * size + x) * 4;
    const destination = ((size - 1 - y) * size + x) * 4;
    bitmap[destination] = pixels[sourceOffset + 2];
    bitmap[destination + 1] = pixels[sourceOffset + 1];
    bitmap[destination + 2] = pixels[sourceOffset];
    bitmap[destination + 3] = pixels[sourceOffset + 3];
    if (pixels[sourceOffset + 3] === 0) mask[(size - 1 - y) * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return Buffer.concat([header, bitmap, mask]);
}

async function ico(sizes) {
  const frames = [];
  for (const size of sizes) frames.push(size === 256 ? await png(size) : await dib(size));
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frames[index].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frames[index].length;
  });
  return Buffer.concat([header, ...frames]);
}

await save('assets/app-icon.png', await png(1024));
await save('assets/app-icon-small.png', await png(128));
await save('assets/app-icon.ico', await ico([16, 24, 32, 48, 64, 128, 256]));
await save('src/app/favicon.ico', await ico([16, 32, 48]));
await save('src/app/icon.png', await png(512));
await save('src/app/apple-icon.png', await png(180));

// Retain existing SVG asset paths as self-contained wrappers of the approved artwork.
for (const [name, size] of [['app-icon.svg', 512], ['app-icon-small.svg', 128]]) {
  const data = (await png(size)).toString('base64');
  await save(`assets/${name}`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="Orbit"><image width="${size}" height="${size}" href="data:image/png;base64,${data}"/></svg>\n`);
}
for (const size of [16, 32, 48, 128]) {
  await save(`packages/capability-browser/runtime/session-tab-grouper-extension/icons/orbit-${size}.png`, await png(size));
}
console.log('Updated Orbit desktop, installer, web, touch, and extension icons from the approved source.');
