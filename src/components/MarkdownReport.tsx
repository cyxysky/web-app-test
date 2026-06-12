'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function stripUnwantedSections(markdown: string) {
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(/\n##\s*(?:Evidence Index|证据索引|证据关系图|Evidence Graph|Run Diagnostics|运行诊断)\b[\s\S]*?(?=\n##\s+|$)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeReportMarkdown(markdown: string) {
  return stripUnwantedSections(markdown)
    .replace(/([^\n])\n(#{1,6}\s+)/g, '$1\n\n$2')
    .replace(/(#{1,6}[^\n]+)\n(?!\n)/g, '$1\n\n')
    .replace(/([^\n])\n(-\s+)/g, '$1\n$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function MarkdownReport({ markdown, onImageClick }: { markdown: string; onImageClick?: (url: string) => void }) {
  const normalized = normalizeReportMarkdown(markdown);
  return (
    <article className="markdown-report">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a href={href} rel="noreferrer" target={href?.startsWith('#') ? undefined : '_blank'}>
              {children}
            </a>
          ),
          img: ({ alt, src }) => {
            const imageSrc = typeof src === 'string' ? src : '';
            return (
              <img
                alt={alt || 'report screenshot'}
                className="markdown-report-image"
                onClick={() => imageSrc && onImageClick?.(imageSrc)}
                src={imageSrc}
              />
            );
          },
          table: ({ children }) => <div className="markdown-table-wrap"><table>{children}</table></div>,
        }}
      >
        {normalized}
      </ReactMarkdown>
    </article>
  );
}
