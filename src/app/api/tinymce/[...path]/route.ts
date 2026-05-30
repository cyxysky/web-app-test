import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: RouteContext) {
  const params = await context.params;
  const fileParts = Array.isArray(params.path) ? params.path : [String(params.path || '')];
  if (
    !fileParts.length ||
    fileParts.some((part) => !part || part === '.' || part === '..' || part.includes('/') || part.includes('\\'))
  ) {
    return NextResponse.json({ error: 'Invalid TinyMCE asset path' }, { status: 400 });
  }

  const tinymceRoot = path.join(process.cwd(), 'node_modules', 'tinymce');
  const filePath = path.join(tinymceRoot, ...fileParts);

  try {
    const file = await readFile(filePath);
    const contentType = contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    return new Response(file, {
      headers: {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Type': contentType,
      },
    });
  } catch {
    return NextResponse.json({ error: 'TinyMCE asset not found' }, { status: 404 });
  }
}
