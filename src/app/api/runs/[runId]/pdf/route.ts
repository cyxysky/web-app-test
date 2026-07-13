import { NextResponse } from 'next/server';
import { store } from '@/server/db/mock-store';

export const runtime = 'nodejs';

type RouteContext = {
  params: Promise<{ runId: string }>;
};

function localPrintOrigin(request: Request) {
  const configuredUrl = process.env.WEBPILOT_ELECTRON_SERVER_URL?.trim();
  const url = new URL(configuredUrl || request.url);
  const hostname = url.hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) {
    throw new Error('PDF export requires a local application server URL.');
  }
  return url.origin;
}

export async function GET(request: Request, context: RouteContext) {
  const { runId } = await context.params;
  const run = store.getRun(runId);
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

  const { chromium } = await import('playwright');
  const executablePath = process.env.AI_WEB_TEST_CHROMIUM_EXECUTABLE_PATH?.trim() || undefined;
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  try {
    const page = await browser.newPage();
    const printUrl = new URL(`/runs/${encodeURIComponent(run.id)}/print`, localPrintOrigin(request));
    const response = await page.goto(printUrl.toString(), { waitUntil: 'load' });
    if (!response?.ok()) throw new Error(`PDF print page failed to load (${response?.status() || 'no response'}).`);
    await page.addStyleTag({ content: 'html, body { background: #ffffff !important; }' });
    await page.waitForSelector('[data-pdf-report-ready="true"]', { timeout: 15000 });
    await page.evaluate(async () => {
      await document.fonts.ready;
      const imageReady = Promise.all(Array.from(document.images).map((image) => (
        image.complete
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              image.addEventListener('load', () => resolve(), { once: true });
              image.addEventListener('error', () => resolve(), { once: true });
            })
      )));
      await Promise.race([imageReady, new Promise<void>((resolve) => window.setTimeout(resolve, 10000))]);
    });
    await page.emulateMedia({ media: 'print' });
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
