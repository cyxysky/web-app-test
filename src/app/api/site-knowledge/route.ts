import { NextRequest, NextResponse } from 'next/server';
import { store } from '@/server/db/sqlite-store';

function stringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

export async function GET(request: NextRequest) {
  const targetUrl = request.nextUrl.searchParams.get('targetUrl') || '';
  if (targetUrl) {
    return NextResponse.json({ item: await store.getSiteKnowledgeForUrl(targetUrl) });
  }
  return NextResponse.json({ items: await store.listSiteKnowledge() });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const item = await store.upsertSiteKnowledge({
      targetUrl: typeof body.targetUrl === 'string' ? body.targetUrl : undefined,
      origin: typeof body.origin === 'string' ? body.origin : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
      loginMethods: stringList(body.loginMethods),
      pageStructure: stringList(body.pageStructure),
      reliableSelectors: stringList(body.reliableSelectors),
      commonFailures: stringList(body.commonFailures),
      businessConcepts: stringList(body.businessConcepts),
      repairHints: stringList(body.repairHints),
      notes: typeof body.notes === 'string' ? body.notes : undefined,
    });
    return NextResponse.json({ ok: true, item });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '保存站点知识失败' },
      { status: 400 },
    );
  }
}
