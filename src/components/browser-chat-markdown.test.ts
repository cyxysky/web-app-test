import assert from 'node:assert/strict';
import test from 'node:test';
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
