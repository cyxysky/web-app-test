import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { artifactsRoot } from '@/server/storage/paths';

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

const contentTypes: Record<string, string> = {
  '.apng': 'image/apng',
  '.gif': 'image/gif',
  '.csv': 'text/csv; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'application/yaml; charset=utf-8',
  '.yml': 'application/yaml; charset=utf-8',
  '.zip': 'application/zip',
};

function resolveArtifactPath(segments: string[]) {
  const root = artifactsRoot();
  const filePath = path.resolve(root, ...segments);
  const relative = path.relative(root, filePath);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return filePath;
}

function contentDispositionHeader(filePath: string) {
  return path.basename(filePath).replace(/["\r\n]/g, '_');
}

export async function GET(request: NextRequest, context: RouteContext) {
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

    const headers: Record<string, string> = {
      'Cache-Control': 'no-store',
      'Content-Length': String(fileStat.size),
      'Content-Type': contentType,
    };
    if (request.nextUrl.searchParams.get('download') === '1') {
      const fileName = contentDispositionHeader(filePath);
      const asciiName = fileName.replace(/[^\x20-\x7E]/g, '_');
      headers['Content-Disposition'] = `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
    }

    return new NextResponse(body, { headers });
  } catch {
    return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
  }
}
