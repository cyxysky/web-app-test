import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

function aiScreenshotMaxBytes() {
  const kb = Number(process.env.AI_SCREENSHOT_MAX_KB || '');
  if (!Number.isFinite(kb) || kb <= 0) return undefined;
  return Math.max(1, Math.floor(kb * 1024));
}

async function compressScreenshotForAi(buffer: Buffer, maxBytes: number) {
  if (buffer.length <= maxBytes) return buffer;
  const metadata = await sharp(buffer, { failOn: 'none' }).rotate().metadata();
  const originalWidth = metadata.width || 0;
  const originalHeight = metadata.height || 0;
  const qualities = [80, 65, 50, 35, 25];
  let best = buffer;
  const render = (width: number | undefined, quality: number) => {
    const pipeline = width
      ? sharp(buffer, { failOn: 'none' }).rotate().resize({ width, withoutEnlargement: true })
      : sharp(buffer, { failOn: 'none' }).rotate();
    return pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
  };
  for (const quality of qualities) {
    const output = await render(undefined, quality);
    if (output.length < best.length) best = output;
    if (output.length <= maxBytes) return output;
  }
  if (!originalWidth || !originalHeight) return best;
  let scale = Math.sqrt(maxBytes / Math.max(best.length, 1)) * 0.92;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const width = Math.max(320, Math.floor(originalWidth * Math.max(0.18, Math.min(0.9, scale))));
    const output = await render(width, attempt < 4 ? 45 : 32);
    if (output.length < best.length) best = output;
    if (output.length <= maxBytes || width <= 320) return output.length < best.length ? output : best;
    scale *= Math.sqrt(maxBytes / Math.max(output.length, 1)) * 0.9;
  }
  return best;
}

export async function readScreenshotForAi(filePath: string) {
  const buffer = await readFile(filePath);
  const maxBytes = aiScreenshotMaxBytes();
  const data = maxBytes
    ? await compressScreenshotForAi(buffer, maxBytes).catch(() => buffer)
    : buffer;
  const mediaType = data[0] === 0xff && data[1] === 0xd8
    ? 'image/jpeg'
    : data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      ? 'image/png'
      : data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP'
        ? 'image/webp'
        : 'application/octet-stream';
  return { data, mediaType };
}
