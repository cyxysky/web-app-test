import { NextResponse } from 'next/server';
import { store } from '@/server/db/mock-store';

type RouteContext = {
  params: Promise<{ runId: string }>;
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function reportHtml(markdown: string, title: string) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { color: #171717; font-family: Arial, "Microsoft YaHei", sans-serif; line-height: 1.6; padding: 32px; }
    h1 { font-size: 24px; margin: 0 0 20px; }
    pre { background: #f7f5ef; border: 1px solid #ded9cf; border-radius: 8px; padding: 16px; white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <pre>${escapeHtml(markdown)}</pre>
</body>
</html>`;
}

export async function GET(_request: Request, context: RouteContext) {
  const { runId } = await context.params;
  const run = store.getRun(runId);
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

  const testCase = store.getTestCase(run.testCaseId);
  const markdown = run.report?.markdown || `测试报告生成中。\n运行 ID：${run.id}\n状态：${run.status}`;
  const title = run.report?.title || `测试报告：${testCase?.title || run.id}`;
  const { chromium } = await import('playwright');
  const executablePath = process.env.AI_WEB_TEST_CHROMIUM_EXECUTABLE_PATH?.trim() || undefined;
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.setContent(reportHtml(markdown, title), { waitUntil: 'load' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' } });
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${run.id}.pdf"`,
      },
    });
  } finally {
    await browser.close();
  }
}
