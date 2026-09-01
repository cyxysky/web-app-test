# Web App Test

AI browser workspace built with Next.js, AI SDK, and Playwright.

The project is focused on persistent browser conversations, live browser control, reusable domain skills, personal memory, credentials, and observable Agent execution.

## Generated conversation files

Browser chat can create new downloadable files with the `generateFile` tool:

- UTF-8 text/code/data files selected by a supported extension, including Markdown, TXT, CSV, JSON, YAML, XML, HTML, and common source-code formats.
- PDF (`.pdf`) and Word (`.docx`) from complete Markdown-like content.
- Excel (`.xlsx`) from structured worksheets and rows.
- PowerPoint (`.pptx`) from structured slides or Markdown-like content.

These are real PDF and Office files, not renamed text files. `downloadFile` remains a separate tool for saving an existing remote file. PDF generation automatically uses an available CJK font on supported Windows and Linux images; set `WEBPILOT_DOCUMENT_FONT` and optionally `WEBPILOT_DOCUMENT_FONT_FAMILY` when a custom deployment stores its font elsewhere.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. Local direct access uses user ID `1` by default; set `WEBPILOT_DEFAULT_USER_ID` in `.env.local` to switch the development identity. There is no application login or local account initialization. For Docker, create `.env` in the project root.

The app uses DeepSeek by default:

```bash
DEEPSEEK_API_KEY=your_key
DEEPSEEK_BASE_URL=https://api.deepseek.com
AI_MODEL=deepseek-v4-flash
```

You can override `AI_PROVIDER`, `AI_MODEL`, `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `OPENAI_BASE_URL`, and `OPENAI_API_KEY` in `.env.local`. For the internal TLS forwarding endpoint, keep the hostname and configure `DEEPSEEK_BASE_URL=https://api.deepseek.com:8802` after mapping `api.deepseek.com` to the forwarding IP in the local hosts file.
Browser execution accepts `http` and `https` target URLs. Configure its operation mode, browser connection, safety policy, and runtime limits on the settings page.

## User initialization and same-port WebSockets

`npm run dev` and `npm start` use WebPilot's custom server. It serves Next.js and both WebSocket upgrade paths on the same public port (`3000` by default). Nginx is not required and the internal WebSocket ports must not be exposed.

There are two user ID sources:

- Local direct access: `WEBPILOT_DEFAULT_USER_ID`, defaulting to `1`.
- Online embedding: the `userId` passed once to `WebPilotQA.mount()`.

The mount endpoint converts the supplied ID into a signed, short-lived initialization ticket. The iframe consumes that ticket and receives an `HttpOnly` identity session cookie; ordinary APIs cannot submit or switch user IDs. Before opening a WebSocket, the frontend requests a short-lived, one-time ticket bound to the initialized user, purpose, public origin, and—for browser preview—the browser-chat session.

For online deployment, require the mounted ID:

```bash
WEBPILOT_REQUIRE_MOUNT_USER_ID=true
```

For a cross-site iframe over HTTPS, also set `WEBPILOT_CROSS_SITE_MOUNT=true`; this changes the identity cookie to `SameSite=None; Secure`.

WebPilot can also be published below one path. The path is part of the Next.js build, so set it before starting development or building a package:

```bash
WEBPILOT_BASE_PATH=/webpilot
```

Docker images include the project `.env`, so set `WEBPILOT_BASE_PATH` there before building. After changing it, recreate the image instead of only restarting the existing container:

```bash
docker compose build --no-cache webpilot-qa
docker compose up -d webpilot-qa
```

For a direct Docker build, the `.env` value is used by default. You can override it explicitly when needed:

```bash
docker build --build-arg WEBPILOT_BASE_PATH=/webpilot -t webpilot-qa:latest .
```

The host page initializes the online user ID while mounting:

```html
<div id="web-app-xxxx"></div>
<script src="/webpilot/embed/webpilot.js"></script>
<script>
  WebPilotQA.mount('#web-app-xxxx', {
    apiBaseUrl: '/webpilot',
    userId: 'u001',
    targetUrl: location.href
  });
</script>
```

The SDK also derives `/webpilot` from its own script URL, so `apiBaseUrl` may be omitted when the script and API use the same public path.

If a reverse proxy is added later for TLS or routing, proxy only the single public application port and preserve WebSocket upgrades. Set `WEBPILOT_TRUST_PROXY=true` only when requests can reach WebPilot exclusively through that trusted proxy; otherwise forwarded headers are deliberately discarded.

## Personal Memory

Browser chat stores local personal memory in the SQLite runtime database.
It does not require an embedding model or vector database. After a completed browser-chat turn, the app asks the current chat model to extract only concise durable items such as aliases, preferences, workflows, and domain facts. Future turns recall matching active items by user id, current domain, and keyword/alias match.

You can view, add, edit, disable, and delete memory items in Settings -> Personal Memory. The local SQLite database remains the source of truth for backup or bulk cleanup.

Runtime controls:

- `AI_PERSONAL_MEMORY_ENABLED=false` disables recall and extraction.
- `AI_PERSONAL_MEMORY_EXTRACT_ENABLED=false` disables post-turn extraction while keeping manual memory recall available.
- `AI_PERSONAL_MEMORY_PROMPT_LIMIT=6` controls how many memory items are injected into one turn.
- `AI_PERSONAL_MEMORY_PROMPT_MAX_CHARS=12000` limits only the memory text injected into one model prompt; stored manual memory remains complete and keeps line breaks.

Minimal management API:

- `GET /api/personal-memory?domain=...&includeDisabled=true`
- `POST /api/personal-memory`
- `PATCH /api/personal-memory/{id}`
- `DELETE /api/personal-memory/{id}`

Browser conversations execute Playwright code through `browserCode`, with AX/DOM reads, actionability checks, iframe handling, screenshots, durable conversation state, and incremental `domChanges` available inside the same runtime.

## Reuse an Existing Browser

To reuse login state from an existing Chrome or Edge profile, start that browser with a remote debugging port, then set `BROWSER_CDP_ENDPOINT` in the settings page:

```powershell
chrome.exe --remote-debugging-port=9222 --user-data-dir="$env:TEMP\webpilot-qa-chrome"
```

Then set:

```bash
BROWSER_CDP_ENDPOINT=http://127.0.0.1:9222
```

When CDP is not configured, browser chats automatically use one persistent Chromium profile per application user. Cookies, local storage, and IndexedDB therefore survive the three-minute idle browser recycle in headless mode. You can set `BROWSER_USER_DATA_DIR` to override the profile root.

Open-tab state is restored by the application rather than Chromium's native tab-group/session UI: each conversation persists its URLs, order, active tab, and logical group in SQLite, then rebuilds those tabs when that conversation next starts. Native colored tab groups remain a headed-browser-only enhancement.

During Agent execution, `getHttpRequests` is available as a read-only diagnostic tool for the current tab. The Agent can use it to verify API status codes, failed requests, and missing-resource evidence before deciding the next browser action.

## Package and Run with Docker

Docker is available for packaged runs because the app depends on Playwright and a Chromium runtime.

1. Create `.env`, set the mounted/default user ID policy, and fill the provider key you want to use.
2. Build and start:

```bash
npm run docker:up
```

Then open `http://localhost:3000`.

The compose setup keeps runtime data outside the image:

- `.data/webpilot.db` is the SQLite source of truth for model/runtime settings, browser conversations, skills, personal memory, credentials metadata, and Electron workspace state.
- `artifacts/` keeps screenshots, traces, uploads, and other large generated files outside the database.
- Chromium profiles and caches remain managed by Chromium in their native file layout.

For unattended browser tasks, keep `HEADLESS_BROWSER=true`. For account-based interaction or manual verification, prefer a visible or CDP-connected browser.

## Package a Windows HTTP server

To distribute the backend without Electron as a single Windows installer, run:

```powershell
npm run server:installer
```

This produces `dist-server/WebPilot-Server-Setup-<version>-x64.exe`. The installer:

- bundles the build machine's compatible Node.js runtime, so Node.js is not required on the target machine;
- installs the complete Next.js server, Playwright Chromium, and LibreOffice under `Program Files`;
- registers and starts the automatic `WebPilotServer` Windows service;
- listens on `0.0.0.0:3000` and adds a TCP 3000 firewall rule for domain/private networks;
- stores runtime data and service logs under `C:\ProgramData\WebPilot` so upgrades do not overwrite them.

Administrator permission is required during installation. Uninstalling removes the service, application files, and firewall rule, while preserving `C:\ProgramData\WebPilot`.

To create only the unpacked server directory on the build machine, run:

```powershell
npm run server:package
```

This produces `dist-server/WebPilot-Server`. When copied directly instead of installed through the EXE, the target machine needs Node.js 22.16 or later and starts it with `start.cmd`. It includes the complete production dependency tree, Playwright Chromium, and LibreOffice, so the target machine does not need `npm install`, `npx playwright install chromium`, or a separate LibreOffice installation.

By default it listens on all network interfaces at port `3000` (locally: `http://127.0.0.1:3000`), stores application data under `runtime/`, and runs the browser headlessly. Set `PORT`, `APP_DATA_DIR`, `ARTIFACTS_DIR`, or `HEADLESS_BROWSER` before `start.cmd` to override those defaults.

## Desktop development

Start the Next.js server first, then launch Electron in another PowerShell window:

```powershell
$env:WEBPILOT_ELECTRON_SERVER_URL="http://127.0.0.1:3000"
npx electron .
```

## Publish a Docker Hub image

Set the Docker Hub namespace before constructing the image tag. An empty namespace produces an invalid tag such as `/webpilot-qa:1.0.0`.

```powershell
$DockerHubUser = (Read-Host "Docker Hub username").Trim()
$ImageVersion = "1.0.0"
if (-not $DockerHubUser) { throw "Docker Hub username is required." }

docker build --build-arg WEBPILOT_BASE_PATH=/webpilot -t "${DockerHubUser}/webpilot-qa:${ImageVersion}" -t "${DockerHubUser}/webpilot-qa:latest" .
docker login
docker push "${DockerHubUser}/webpilot-qa:${ImageVersion}"
docker push "${DockerHubUser}/webpilot-qa:latest"
```


1.还有所有文件操作skill，也作为内嵌skill，包括文件生成，编辑，查看等所有文件这个工具能够进行的操作，都集合成一个skill，并且强制要求模型在进行文件操作时读取
2.还有什么工具也需要skill提示，你给出方案

需要新增 Skill 的主要是两类：`file/fileVisual` 和 `subagent`。其余工具不建议强制读取，否则会增加无意义的模型步骤。

## 推荐分层

| 工具 | 是否需要隐藏 Skill | 触发时机 | 原因 |
|---|---|---|---|
| `browserCode` | 已完成 | 第一次调用前 | API 多、状态复杂、涉及页面安全和 Surface |
| `file` | 强烈建议 | 第一次写入型操作前 | 存在 plan/generate/edit/render 状态机、revision/digest、UNO/JS 分支 |
| `fileVisual` | 与 `file` 共用 | 第一次视觉 QA 前 | 与文件版本、renderedDigest、逐页审核强绑定 |
| `subagent` | 建议 | 第一次 `spawn` 前 | 涉及任务拆分、共享浏览器、Cookie、标签页归属和结果读取顺序 |
| `readBrowserState` | 不需要 | — | 单一只读工具，本身就是 browserCode 前置步骤 |
| `waitForHumanVerification` | 不需要 | — | 行为单一，工具描述和服务端限制足够 |
| `skill` | 不需要 | — | 它是读取 Skill 的入口，不能再依赖 Skill |
| `attachmentVault` / `credentialVault` / `tab.cua` | 不单独增加 | — | 已属于 browserCode 运行环境，应继续放在浏览器 Skill 中 |
| 外部插件工具 | 按插件提供 | 首次使用插件复杂操作前 | 不应该由项目维护一个包含所有插件的巨大系统 Skill |

## 1. 文件工具 Skill

建议增加隐藏 Skill：

```text
system-file-artifact-runtime
```

它统一覆盖 `file` 和 `fileVisual`，不要拆成两个 Skill，否则生成一个文件要多一次模型往返。

内容包括：

- `list → plan → generate → edit → render` 完整状态机
- 什么时候使用 `read`、`download`、`convert`
- `documentId`、revision、sourceDigest、renderedDigest 的含义
- JavaScript 与 UNO 模式选择
- `jsApi`、`unoApi` 的正确调用顺序
- 修改附件时的 `operation=modify`
- edit 的事务、回滚和行号刷新规则
- 视觉模型和非视觉模型不同的 QA 门控
- 失败后如何依据 `requiredNextAction` 继续原文档，而不是创建替代文档

门控不要作用于所有 file 操作：

- 不门控：`list`、`read`、`download`
- 强制读取：`plan`、`generate`、`edit`、`render`、`convert`、`jsApi`、`unoApi`
- `fileVisual` 强制使用同一个 Skill

这样普通附件读取不会白白多一个步骤，但真正开始生成或修改文件前一定理解工作流。

目前 `file` 的大量规则同时散落在工具描述和系统提示中，[browser-chat-executor.agent.ts](C:/Users/chenjf/Desktop/test2/web-app-test/src/server/ai/agents/browser-chat-executor.agent.ts:1358) 和 [runtime-prompt-rules.ts](C:/Users/chenjf/Desktop/test2/web-app-test/src/server/ai/agents/runtime-prompt-rules.ts:3) 都很长。迁移成隐藏 Skill 后，可以明显缩短每次模型请求的固定上下文。

## 2. 子 Agent Skill

建议增加：

```text
system-subagent-runtime
```

只在 `subagent action=spawn` 前强制读取，`action=read` 不门控，避免已经有待回收结果时被卡住。

内容重点应该包括：

- 只能拆分独立、可并行的任务
- 不能把同一交互页面上的连续步骤分配给不同子 Agent
- 子 Agent 可以复用父级浏览器上下文和 Cookie 登录态
- 子 Agent 应拥有独立页面或标签页，不争抢父级当前活动页
- 后台子 Agent 不应抢前台焦点
- 标签页所有权、关闭范围和最终保留规则
- 多个 UUID 的结果读取顺序
- 父 Agent 才负责整合结论和最终交付
- 子 Agent 浏览器失败时如何把 surface ID、页面状态和建议返回父级

这正好可以固化此前实现的“共享浏览器上下文、隔离页面所有权”方案，避免模型只看到一个简短工具描述后错误拆分。

## 统一实现方案

不要继续为每个工具手写一套门控判断，建议抽象成注册表：

```ts
const hiddenRuntimeSkillPolicies = {
  browserCode: {
    skillId: 'system-browser-code-runtime',
    requires: () => true,
  },
  file: {
    skillId: 'system-file-artifact-runtime',
    requires: input =>
      ['plan', 'generate', 'edit', 'render', 'convert', 'jsApi', 'unoApi']
        .includes(input.action),
  },
  fileVisual: {
    skillId: 'system-file-artifact-runtime',
    requires: () => true,
  },
  subagent: {
    skillId: 'system-subagent-runtime',
    requires: input => input.action === 'spawn',
  },
};
```

运行逻辑统一为：

1. 模型决定调用某个复杂工具。
2. 服务端检查本轮 trace 是否成功读取对应隐藏 Skill。
3. 未读取则拒绝执行，并返回：

```json
{
  "ok": false,
  "requiredSkillId": "system-file-artifact-runtime",
  "requiredNextAction": "先通过 skill action=read 读取该隐藏运行规范，再重新调用原工具。"
}
```

4. Skill 成功读取状态写入本轮 trace，后续模型步骤继续有效。
5. 新 Agent run 自动清空，不跨任务永久缓存。
6. 隐藏 Skill 始终可调用，但不进入用户的账号/Skill 管理列表。

## 实施顺序

建议下一步这样做：

1. 抽象通用的隐藏 Skill 注册与门控机制。
2. 新增 `system-file-artifact-runtime`，迁移 `file/fileVisual` 的长篇固定说明。
3. 新增 `system-subagent-runtime`，固化共享浏览器和页面所有权规则。
4. 精简现有工具 description，只保留用途、参数和“需要先读取哪个 Skill”。
5. 增加测试：按 action 门控、跨模型步骤保留、对象协议和原生工具协议一致、隐藏 Skill 不出现在用户列表。

不建议一次性给所有工具加 Skill。最终保持三个隐藏运行时 Skill 就比较合理：浏览器、文件、子 Agent。


1.为什么这个pdf图标有问题
2.生成用例，skill的弹窗样式存在明显问题，你所有弹窗的样式为什么不能统一使用?
3.新增的预期敏感原文对于的类型呢？你现在所有新增的都是其他，坑定有问题啊








你需要在当前项目中，从零完成一次“UNO 全能力文档生成”。

主题：选择一个内容丰富、结构清晰的 Wikipedia 词条，例如詹姆斯·韦布空间望远镜、古埃及、罗马帝国、太阳系等。先提取并整理可靠内容，再分别生成 PPTX、DOCX、XLSX 以及对应的 PDF 预览。

重要：不要只写计划，不要停在说明阶段，必须实际生成文件并自行检查、修复，直到可以交付。

二、内容要求

内容不能只是简短概述，必须包含：

- 主题背景与核心概念；
- 历史或发展时间线；
- 关键组成部分；
- 数据与指标；
- 技术或运作流程；
- 影响、价值或应用；
- 风险、限制与争议；
- 总结与资料来源。

至少使用 5 张与内容直接相关的图片，保持原始比例，不拉伸、不裁掉关键区域。图片和正文不得保存成超大 Base64 状态值；优先保存为项目资产文件或分块数据。

三、PPTX 要求

生成至少 16～20 页的精美演示文稿，要求风格统一但页面形式丰富。

必须覆盖：

- 封面、目录、章节页、结束页；
- 时间线；
- 流程图和带箭头连接关系；
- 数据卡片与 KPI；
- 原生 TableShape 表格；
- 柱状图；
- 折线图或光谱图；
- 饼图、环形图或其他比例图；
- 矩阵、风险表或对比表；
- SVG/图片；
- RectangleShape、EllipseShape、CustomShape、CaptionShape；
- ConnectorShape、LineShape、MeasureShape、TextShape、GraphicObject；
- 渐变、阴影、透明度、旋转；
- 文档元数据；
- 内部跳转和外部超链接；
- 页码和统一页脚。

注意：

- PPTX 中不要使用经过往返保存后会变成 0×0 或空白的 OLE2 图表。
- PPT 图表可以使用稳定的 UNO 矢量形状组合实现。
- 每张幻灯片必须有明确内容区和安全边距。
- 正文建议不小于 16pt，标题不小于 30pt。
- 不得让文本、图片、表格或图形互相覆盖。
- 不得通过简单设置 allowOverlap 来掩盖真实重叠。

四、DOCX 要求

生成至少 10～12 页的 Writer 报告，必须覆盖：

- 封面；
- 页眉和页脚；
- 动态阿拉伯数字页码；
- Heading 1/2/3 等标题层级；
- 正文、列表、引用和强调文字；
- 多个原生 Writer 表格；
- 图片、图注；
- 脚注；
- 可点击超链接；
- TextFrame；
- 原生 TextSection + TextColumns 双栏；
- 双栏结束后恢复单栏；
- 图片、文本框和表格的可靠锚定；
- 手动分页；
- 文档标题、作者、主题、关键词等元数据。

必须保证：

- 表格不拆出单独的孤立尾行；
- 图片不压住正文；
- TextFrame 不遮挡标题或页脚；
- 不出现文字溢出、异常换行和跨页重叠；
- 不使用 Microsoft Office 与 LibreOffice 页数差异作为阻断条件，只以 LibreOffice 结果为准。

五、XLSX 要求

生成至少 7 张工作表，包括：

- Dashboard；
- 原始数据；
- 指标比较；
- 时间序列；
- 风险矩阵；
- PivotLab；
- FormulaLab。

必须覆盖：

- 合并单元格；
- 字体、背景色、边框、对齐、换行；
- 行高、列宽；
- 命名区域；
- 跨表引用；
- SUM、AVERAGE、MAX、MIN、COUNT、ROUND 等公式；
- 百分比、日期、货币、小数和科学计数格式；
- 批注；
- 可点击超链接；
- 数据验证下拉列表；
- DatabaseRange；
- 冻结窗格；
- 重复打印标题；
- 每张工作表独立打印区域；
- 原生 DataPilot 透视表；
- 至少 5 个真正可编辑的 Calc 原生图表，例如分组柱状图、折线图、面积图、雷达图和透视结果图；
- 工作表图片或绘图对象。

图表数据源必须包含正确的标题行和全部数据行。图表锚定范围必须完全位于打印区域内，禁止因为打印区域过小造成图表被裁成半个或漏掉最后一个类别。

最终回复必须简洁报告：

- 文件位置；
- 实际覆盖的 UNO 能力；
- 结构校验结果；
- 视觉检查结果；
- 修复过的真实问题；
- 仍然存在的兼容性边界。

现在直接开始执行，不要再次复述任务，也不要只输出计划。




你需要在当前项目中，从零完成一次“UNO 全能力文档生成”。

主题：选择一个内容丰富、结构清晰的 Wikipedia 词条，例如詹姆斯·韦布空间望远镜、古埃及、罗马帝国、太阳系等。先提取并整理可靠内容，再生成 PPTX

重要：不要只写计划，不要停在说明阶段，必须实际生成文件并自行检查、修复，直到可以交付。

二、内容要求

内容不能只是简短概述，必须包含：

- 主题背景与核心概念；
- 历史或发展时间线；
- 关键组成部分；
- 数据与指标；
- 技术或运作流程；
- 影响、价值或应用；
- 风险、限制与争议；
- 总结与资料来源。

至少使用 5 张与内容直接相关的图片，保持原始比例，不拉伸、不裁掉关键区域。图片和正文不得保存成超大 Base64 状态值；优先保存为项目资产文件或分块数据。

三、PPTX 要求

生成至少 30～35 页的精美演示文稿，要求风格统一但页面形式丰富。

必须覆盖：

- 封面、目录、章节页、结束页；
- 时间线；
- 流程图和带箭头连接关系；
- 数据卡片与 KPI；
- 原生 TableShape 表格；
- 柱状图；
- 折线图或光谱图；
- 饼图、环形图或其他比例图；
- 矩阵、风险表或对比表；
- SVG/图片；
- RectangleShape、EllipseShape、CustomShape、CaptionShape；
- ConnectorShape、LineShape、MeasureShape、TextShape、GraphicObject；
- 渐变、阴影、透明度、旋转；
- 文档元数据；
- 内部跳转和外部超链接；
- 页码和统一页脚。

注意：

- PPTX 中不要使用经过往返保存后会变成 0×0 或空白的 OLE2 图表。
- PPT 图表可以使用稳定的 UNO 矢量形状组合实现。
- 每张幻灯片必须有明确内容区和安全边距。
- 正文建议不小于 16pt，标题不小于 30pt。
- 不得让文本、图片、表格或图形互相覆盖。
- 不得通过简单设置 allowOverlap 来掩盖真实重叠。


最终回复必须简洁报告：

- 文件位置；
- 实际覆盖的 UNO 能力；
- 结构校验结果；
- 视觉检查结果；
- 修复过的真实问题；
- 仍然存在的兼容性边界。

现在直接开始执行，不要再次复述任务，也不要只输出计划。

1.你不用一次性输出所有的unoApi，可以跟之前一样，支持模型一个模块一个模块查询，但是每个模型要有对应api的所有的示例，你要告诉模型实际上是怎么使用的
2.你为什么还在搞兼容？？？你是弱智听不懂人话吗？？？你应该引导模型使用我们示例中的api，而不是让模型猜我们的api是怎么实现的  

根因不是文件大，也不是 PNG 处理慢，而是 Wikimedia 限流触发了错误的长时间重试链。

我刚实测这个 URL：

1. `800px-...png` 首先返回 `400 Use thumbnail sizes listed`。
2. 下载器自动回退到原始 SVG。
3. 原始 SVG 返回 `429 Too many requests`，并要求 `Retry-After: 600` 秒。
4. 当前代码把等待截为 30 秒，然后继续重试，最多产生约 `30 + 30 + 30` 秒无效等待，最终还可能失败。
5. 所有 Wikimedia 下载还共享同一域名队列和冷却状态，因此前面连续下载十多张图会加重这个问题。

所以截图中的 36.9 秒基本就是第一次 30 秒冷却加网络请求；继续等待可能接近 90–120 秒。

相关代码在：

- [下载超时及重试配置](/C:/Users/chenjf/Desktop/test2/web-app-test/src/server/ai/agents/file-artifact-tools.ts:34)
- [Wikimedia 400 回退逻辑](/C:/Users/chenjf/Desktop/test2/web-app-test/src/server/ai/agents/file-artifact-tools.ts:1152)
- [429 冷却和重试](/C:/Users/chenjf/Desktop/test2/web-app-test/src/server/ai/agents/file-artifact-tools.ts:1188)
- [工具全局串行队列](/C:/Users/chenjf/Desktop/test2/web-app-test/src/server/ai/agents/browser-chat-executor.agent.ts:1346)

还有一个问题：回退地址是原始 SVG，但请求声明的是 `fileType: png`。即使下载成功，当前逻辑也可能把输出改成 SVG，而不是生成真正的 PNG。

合理修复应是：

- Wikimedia 缩略图 `400` 后下载原始 SVG，并在本地一次性转成 PNG。
- `429 Retry-After: 600` 不再每隔 30 秒盲目重试；直接快速失败或等待一次后返回明确错误。
- UI 显示“Wikimedia 429，等待重试”，不只显示“正在执行工具”。
- 下载任务使用独立的有限并发队列，不阻塞无关文件工具。

本轮只做了诊断，没有修改代码。