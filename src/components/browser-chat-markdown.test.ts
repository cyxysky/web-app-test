import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import {
  normalizeBrowserChatMarkdown,
  remarkBrowserChatCjkStrong,
} from './browser-chat-markdown';

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

test('repairs a fenced code block attached to preceding prose', () => {
  const markdown = '安全提醒：关闭端口 ```bash\nfirewall-cmd --reload\n```\n\n### 关键点\n\n- 后续正文';
  const normalized = normalizeBrowserChatMarkdown(markdown);
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm],
  }, normalized));

  assert.match(normalized, /关闭端口\n```bash/);
  assert.match(html, /<pre><code class="language-bash">firewall-cmd --reload/);
  assert.match(html, /<h3>关键点<\/h3>/);
  assert.match(html, /<li>后续正文<\/li>/);
});

test('keeps the text after an attached shell fence outside the code block', () => {
  const markdown = [
    '**第 5 步（⚠️ 安全提醒）**：执行**安全扫描**时，必须把 9200 端口关闭，否则会扫出漏洞```bash',
    'firewall-cmd --permanent --remove-port=9200/tcp',
    'firewall-cmd --reload',
    '```',
    '',
    '---',
    '',
    '### 💡 这份文档的关键点',
    '',
    '1. **是个 Chrome 浏览器扩展插件**',
    '2. **核心价值**：让 Elasticsearch 的数据查看更直观',
  ].join('\n');
  const normalized = normalizeBrowserChatMarkdown(markdown);
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm],
  }, normalized));

  assert.match(normalized, /漏洞\n```bash/);
  assert.equal((html.match(/<pre>/g) || []).length, 1);
  assert.match(html, /<h3>💡 这份文档的关键点<\/h3>/);
  assert.match(html, /<li><strong>核心价值<\/strong>：让 Elasticsearch 的数据查看更直观<\/li>/);
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

test('does not turn spaced GFM table delimiters into horizontal rules', () => {
  const markdown = [
    '| 参数 | 说明 | 示例 |',
    '| --- | --- | --- |',
    '| **产品** | 要查看的产品名 | `DOMP` |',
    '| **版本号** | 要查看的发布版本号 | `2.4.9` |',
  ].join('\n');
  const normalized = normalizeBrowserChatMarkdown(markdown);
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm],
  }, normalized));

  assert.equal(normalized, markdown);
  assert.match(html, /<table>/);
  assert.match(html, /<th>参数<\/th>/);
  assert.match(html, /<strong>产品<\/strong>/);
  assert.doesNotMatch(html, /<hr/);
});

test('repairs full-width list rows and a Markdown heading stuck to the next table header', () => {
  const markdown = [
    '#### 主区域 - 列表展示**列表字段（带过滤与排序 ↕）**：',
    '1. 状态',
    '2. 薪资期间',
    '3. 开始日',
    '4. 结束日',
    '5. 计算时间',
    '6. 签发时间',
    '7. 封账时间',
    '8. 操作',
    '',
    '**分页**：每页显示 100 条，当前 1/2 页，共 45 条',
    '',
    '**样例数据（共 3 条可见）**：',
    '',
    '- 待计算｜2026/05｜2026/05/01｜2026/05/31｜—｜—｜—｜操作：计算',
    '',
    '- 已封账｜2026/04｜2026/04/01｜2026/04/30｜2026/04/22 16:08:15｜2026/04/22 17:08:15｜2026/04/28 17:08:15｜操作：工资明细',
    '',
    '- 已封账｜2026/03｜2026/03/01｜2026/03/30｜2026/03/02 16:08:15｜2026/03/02 17:08:15｜2026/03/31 17:08:15｜操作：同上',
    '',
    '### 状态机与操作按钮矩阵| 状态 | 可用操作按钮 |',
    '| --- | --- |',
    '| 待计算 | 计算 |',
    '| 待签发 | 计算、签发 |',
  ].join('\n');
  const normalized = normalizeBrowserChatMarkdown(markdown);
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm],
  }, normalized));

  assert.match(normalized, /\| 状态 \| 薪资期间 \| 开始日 \| 结束日 \| 计算时间 \| 签发时间 \| 封账时间 \| 操作 \|/);
  assert.match(normalized, /\| 待计算 \| 2026\/05 \| 2026\/05\/01 \| 2026\/05\/31 \| — \| — \| — \| 操作：计算 \|/);
  assert.match(normalized, /### 状态机与操作按钮矩阵\n\n\| 状态 \| 可用操作按钮 \|/);
  assert.equal((html.match(/<table>/g) || []).length, 2);
  assert.match(html, /<h3>状态机与操作按钮矩阵<\/h3>/);
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

test('renders emphasis whose closing delimiter touches Chinese text', () => {
  const markdown = '核心产生的高能**光子（伽马射线）**向外传播：';
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkBrowserChatCjkStrong],
  }, normalizeBrowserChatMarkdown(markdown)));

  assert.match(html, /核心产生的高能<strong>光子（伽马射线）<\/strong>向外传播：/);
  assert.doesNotMatch(html, /\*\*/);
});

test('renders block math with KaTeX instead of exposing TeX delimiters', () => {
  const markdown = '$$\\Delta v = v_e \\cdot \\ln\\frac{m_0}{m_f}$$';
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    rehypePlugins: [rehypeKatex],
    remarkPlugins: [remarkGfm, remarkMath, remarkBrowserChatCjkStrong],
  }, normalizeBrowserChatMarkdown(markdown)));

  assert.match(html, /class="katex-display"/);
  assert.match(html, /<math/);
  assert.doesNotMatch(html, /\$\$/);
});
