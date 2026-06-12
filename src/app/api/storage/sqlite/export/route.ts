import { exportRuntimeData } from '@/server/db/sqlite-store-engine';

export async function GET() {
  const payload = await exportRuntimeData();
  const fileName = `ai-web-test-export-${payload.exportedAt.replace(/[:.]/g, '-')}.json`;
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}
