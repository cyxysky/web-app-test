import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

const contentTypes: Record<string, string> = {
  '.apng': 'image/apng',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
};

function resolveArtifactPath(segments: string[]) {
  const root = path.resolve(process.cwd(), 'artifacts');
  const filePath = path.resolve(root, ...segments);
  const relative = path.relative(root, filePath);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return filePath;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { path: pathSegments } = await context.params;
  const filePath = resolveArtifactPath(pathSegments || []);

  if (!filePath) {
    return NextResponse.json({ error: 'Invalid artifact path' }, { status: 400 });
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
    }

    const body = await readFile(filePath);
    const contentType = contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';

    return new NextResponse(body, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Length': String(fileStat.size),
        'Content-Type': contentType,
      },
    });
  } catch {
    return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
  }
}
