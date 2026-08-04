import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { normalizeBrowserChatMarkdown } from './browser-chat-markdown';

test('restores headings and tables from a collapsed model Markdown reply', () => {
  const collapsed = '已找到目标需求！以下是搜索结果： --- ## 找到需求：薪酬管理2期 | 字段 | 内容 | |------|------| | **标题** | 薪酬管理2期 | | **编号** | **31465** | | **截止日期** | 2026/07/15 | **需求详情页链接**：[详情](https://example.com/31465) --- 需要继续查看吗？';
  const normalized = normalizeBrowserChatMarkdown(collapsed);

  assert.match(normalized, /搜索结果：\n\n---\n\n## 找到需求/);
  assert.match(normalized, /\n\n\| 字段 \| 内容 \|\n\|------\|------\|/);
  assert.match(normalized, /\| \*\*截止日期\*\* \| 2026\/07\/15 \|\n\n\*\*需求详情页链接\*\*/);
  assert.match(normalized, /\n\n---\n\n需要继续查看吗？$/);
});

test('keeps valid Markdown and code spans intact', () => {
  const markdown = '## 标题\n\n| 字段 | 内容 |\n|---|---|\n| 编号 | 31465 |\n\n`a --- ## b`\n\n```txt\na --- ## b\n```';

  assert.equal(normalizeBrowserChatMarkdown(markdown), markdown);
});

test('keeps a hash table header and artifact links as one GFM table', () => {
  const markdown = [
    '## 文件下载',
    '',
    '| # | 格式 | 文件名 | 下载 |',
    '|---|---|---|---|',
    '| 1 | **MD** | `report.md` | [下载](/api/artifacts/chat_1/generated/report.md?download=1) |',
    '| 2 | **Word** | `report.docx` | [下载](/api/artifacts/chat_1/generated/report.docx?download=1) |',
  ].join('\n');
  const normalized = normalizeBrowserChatMarkdown(markdown);
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm],
  }, normalized));

  assert.equal(normalized, markdown);
  assert.match(html, /<table>/);
  assert.match(html, /<th>#<\/th>/);
  assert.match(html, /report\.docx/);
});

test('renders emphasized URLs correctly before Chinese punctuation', () => {
  const messages = [
    '已为您打开 **https://10.10.0.90**。需要继续操作吗？',
    '已为您打开 \\*\\*https://10.10.0.90\\*\\*。保留孤立的 \\*，以及 `\\*\\*code\\*\\*`。',
  ];

  for (const markdown of messages) {
    const normalized = normalizeBrowserChatMarkdown(markdown);
    const html = renderToStaticMarkup(createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm],
    }, normalized));

    assert.match(normalized, /\*\*<https:\/\/10\.10\.0\.90>\*\*。/);
    assert.match(html, /<strong><a href="https:\/\/10\.10\.0\.90">https:\/\/10\.10\.0\.90<\/a><\/strong>。/);
    assert.doesNotMatch(html, /\*\*https:\/\//);
  }
});
