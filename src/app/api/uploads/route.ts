import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { artifactApiUrlFromRelative } from '@/lib/artifacts';
import { artifactPath } from '@/server/storage/paths';

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const file = form.get('file');

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'File is required' }, { status: 400 });
  }

  const ext = path.extname(file.name) || (file.type.startsWith('image/') ? '.png' : '.bin');
  const prefix = file.type.startsWith('image/') ? 'img' : 'file';
  const fileId = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
  const dir = artifactPath('uploads');
  const filePath = path.join(dir, fileId);

  await mkdir(dir, { recursive: true });
  await writeFile(filePath, Buffer.from(await file.arrayBuffer()));

  return NextResponse.json({
    fileId,
    imageId: file.type.startsWith('image/') ? fileId : undefined,
    filePath,
    path: `uploads/${fileId}`,
    url: artifactApiUrlFromRelative(`uploads/${fileId}`),
    name: file.name,
    type: file.type,
    size: file.size,
  });
}
