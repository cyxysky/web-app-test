'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkSafeBreaks } from '@/lib/markdown';

export function MarkdownReport({ markdown, onImageClick }: { markdown: string; onImageClick?: (url: string) => void }) {
  return (
    <div className="markdown-report">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkSafeBreaks]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} rel="noopener noreferrer" target="_blank" />
          ),
          img: ({ node: _node, alt = '', src, ...props }) => {
            const imageUrl = typeof src === 'string' ? src : '';
            if (!imageUrl) return null;
            return (
              <img
                {...props}
                alt={alt}
                className="report-markdown-image"
                onClick={onImageClick ? () => onImageClick(imageUrl) : undefined}
                src={imageUrl}
              />
            );
          },
          table: ({ node: _node, ...props }) => (
            <div className="markdown-table-wrap">
              <table {...props} />
            </div>
          ),
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
