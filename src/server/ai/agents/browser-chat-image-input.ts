import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

function aiScreenshotMaxBytes() {
  const kb = Number(process.env.AI_SCREENSHOT_MAX_KB || '');
  if (!Number.isFinite(kb) || kb <= 0) return undefined;
  return Math.max(1, Math.floor(kb * 1024));
}

async function compressScreenshotForAi(buffer: Buffer, maxBytes: number) {
  if (buffer.length <= maxBytes) return buffer;
  const qualities = [80, 65, 50, 35, 25];
  let best = buffer;
  for (const quality of qualities) {
    const output = await sharp(buffer, { failOn: 'none' })
      .rotate()
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    if (output.length < best.length) best = output;
    if (output.length <= maxBytes) return output;
  }
  return best;
}

function supportedImageMediaType(data: Buffer) {
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}

async function normalizeImageForAi(buffer: Buffer) {
  const mediaType = supportedImageMediaType(buffer);
  if (mediaType) return { data: buffer, mediaType };
  try {
    const data = await sharp(buffer, { failOn: 'warning', pages: 1 })
      .rotate()
      .png()
      .toBuffer();
    return { data, mediaType: 'image/png' } as const;
  } catch (error) {
    throw new Error(`图片格式无法解码或转换为模型可读取的 PNG：${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function readScreenshotForAi(filePath: string) {
  const normalized = await normalizeImageForAi(await readFile(filePath));
  const maxBytes = aiScreenshotMaxBytes();
  const data = maxBytes
    ? await compressScreenshotForAi(normalized.data, maxBytes).catch(() => normalized.data)
    : normalized.data;
  return { data, mediaType: supportedImageMediaType(data) || normalized.mediaType };
}
