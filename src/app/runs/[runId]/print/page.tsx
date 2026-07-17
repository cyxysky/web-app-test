import { notFound } from 'next/navigation';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkSafeBreaks } from '@/lib/markdown';
import { store } from '@/server/db/mock-store';
import styles from './print.module.css';

export const dynamic = 'force-dynamic';

type PageProps = {
  params: Promise<{ runId: string }>;
};

function markdownWithTitle(markdown: string, title: string) {
  return /^\s*#\s+\S/.test(markdown) ? markdown : `# ${title}\n\n${markdown}`;
}

function localArtifactUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const base = new URL('http://webpilot-print.local');
    const parsed = new URL(value, base);
    if (parsed.origin !== base.origin || !parsed.pathname.startsWith('/api/artifacts/')) return undefined;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return undefined;
  }
}

const markdownComponents: Components = {
  a: ({ node, ...props }) => {
    void node;
    return <a {...props} rel="noopener noreferrer" />;
  },
  img: ({ node: _node, alt = '', src }) => {
    void _node;
    const safeUrl = localArtifactUrl(typeof src === 'string' ? src : undefined);
    return safeUrl
      ? <img alt={alt} src={safeUrl} />
      : <span className={styles.imageOmitted}>{alt ? `图片已省略：${alt}` : '外部图片已省略'}</span>;
  },
  table: ({ node, ...props }) => {
    void node;
    return (
      <div className={styles.tableWrap}>
        <table {...props} />
      </div>
    );
  },
};

export default async function RunReportPrintPage({ params }: PageProps) {
  const { runId } = await params;
  const run = store.getRun(runId);
  if (!run) notFound();

  const testCase = store.getTestCase(run.testCaseId);
  const title = run.report?.title || `测试报告：${testCase?.title || run.id}`;
  const markdown = run.report?.markdown || `运行 ID：${run.id}\n\n状态：${run.status}`;

  return (
    <main className={styles.page} data-pdf-report-ready="true">
      <article className={styles.report}>
        <ReactMarkdown
          components={markdownComponents}
          remarkPlugins={[remarkGfm, remarkSafeBreaks]}
          skipHtml
        >
          {markdownWithTitle(markdown, title)}
        </ReactMarkdown>
      </article>
    </main>
  );
}
