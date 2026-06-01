import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const file = form.get('file');

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'File is required' }, { status: 400 });
  }

  if (!file.type.startsWith('image/')) {
    return NextResponse.json({ error: 'Only image uploads are supported' }, { status: 400 });
  }

  const ext = path.extname(file.name) || '.png';
  const imageId = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
  const dir = path.join(process.cwd(), 'artifacts', 'uploads');
  const filePath = path.join(dir, imageId);

  await mkdir(dir, { recursive: true });
  await writeFile(filePath, Buffer.from(await file.arrayBuffer()));

  return NextResponse.json({ imageId, filePath, type: file.type, size: file.size });
}
