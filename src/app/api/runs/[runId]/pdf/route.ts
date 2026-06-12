import { NextResponse } from 'next/server';
import { store } from '@/server/db/sqlite-store';

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

function inlineHtml(value: string) {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)]\(([^)]+)\)/g, (_match, label: string, url: string) => {
      const safeUrl = escapeHtml(url);
      return `<a href="${safeUrl}">${escapeHtml(label)}</a>`;
    });
}

function markdownToHtml(markdown: string) {
  const lines = markdown.split(/\r?\n/);
  const html: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    const sectionTitle = trimmed.match(/^##\s+(.+)$/)?.[1];
    if (/^(Evidence Index|证据索引|证据关系图|Evidence Graph|Run Diagnostics|运行诊断)$/i.test(sectionTitle || '')) {
      index += 1;
      while (index < lines.length && !/^##\s+/.test(lines[index].trim())) index += 1;
      continue;
    }

    const image = trimmed.match(/^!\[(.*)]\((.*)\)$/);
    if (image) {
      html.push(`<figure><img alt="${escapeHtml(image[1])}" src="${escapeHtml(image[2])}" /><figcaption>${escapeHtml(image[1])}</figcaption></figure>`);
      index += 1;
      continue;
    }

    if (trimmed.startsWith('# ')) html.push(`<h1>${inlineHtml(trimmed.slice(2))}</h1>`);
    else if (trimmed.startsWith('## ')) html.push(`<h2>${inlineHtml(trimmed.slice(3))}</h2>`);
    else if (trimmed.startsWith('### ')) html.push(`<h3>${inlineHtml(trimmed.slice(4))}</h3>`);
    else if (trimmed.startsWith('- ')) {
      const items: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('- ')) {
        items.push(`<li>${inlineHtml(lines[index].trim().slice(2))}</li>`);
        index += 1;
      }
      html.push(`<ul>${items.join('')}</ul>`);
      continue;
    } else {
      html.push(`<p>${inlineHtml(trimmed)}</p>`);
    }
    index += 1;
  }

  return html.join('\n');
}

function reportHtml(markdown: string, title: string) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { color: #171717; font-family: Arial, "Microsoft YaHei", sans-serif; line-height: 1.6; padding: 32px; }
    h1 { font-size: 24px; margin: 0 0 20px; }
    h2 { border-top: 1px solid #ded9cf; font-size: 18px; margin: 24px 0 10px; padding-top: 16px; }
    h3 { font-size: 15px; margin: 16px 0 8px; }
    p, li { font-size: 13px; }
    a { color: #304081; }
    ul { margin: 8px 0 14px; padding-left: 22px; }
    figure { border: 1px solid #ded9cf; border-radius: 8px; margin: 14px 0; overflow: hidden; padding: 10px; }
    figure img { display: block; max-width: 100%; }
    figcaption { color: #6d6559; font-size: 12px; margin-top: 8px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${markdownToHtml(markdown)}
</body>
</html>`;
}

export async function GET(_request: Request, context: RouteContext) {
  const { runId } = await context.params;
  const run = await store.getRun(runId);
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

  const testCase = await store.getTestCase(run.testCaseId);
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
