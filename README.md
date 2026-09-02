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

Browser chat stores personal memory in the configured TypeORM backend database.
It does not require an embedding model or vector database. After a completed browser-chat turn, the app asks the current chat model to extract only concise durable items such as aliases, preferences, workflows, and domain facts. Future turns recall matching active items by user id, current domain, and keyword/alias match.

You can view, add, edit, disable, and delete memory items in Settings -> Personal Memory. The configured backend database remains the source of truth for backup or bulk cleanup.

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

Open-tab state is restored by the application rather than Chromium's native tab-group/session UI: each conversation persists its URLs, order, active tab, and logical group in the configured backend database, then rebuilds those tabs when that conversation next starts. Native colored tab groups remain a headed-browser-only enhancement.

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

- Backend records are managed through TypeORM. `DATABASE_DRIVER=sqlite` stores them in `.data/webpilot.db`; `DATABASE_DRIVER=postgres` stores them in the PostgreSQL database selected by `DATABASE_URL`.
- Electron-only window/workspace state remains local to the desktop client and is not part of the backend database selection.
- `artifacts/` keeps screenshots, traces, uploads, and other large generated files outside the database.
- Chromium profiles and caches remain managed by Chromium in their native file layout.

For unattended browser tasks, keep `HEADLESS_BROWSER=true`. For account-based interaction or manual verification, prefer a visible or CDP-connected browser.

### Backend database

The backend uses a single TypeORM `DataSource` and runs schema migrations at startup.

- SQLite (default): set `DATABASE_DRIVER=sqlite`; optionally set `SQLITE_DATABASE_PATH`.
- PostgreSQL: set `DATABASE_DRIVER=postgres` and provide `DATABASE_URL`.
- PostgreSQL startup fails immediately when `DATABASE_URL` is absent or the database cannot be reached; it does not fall back to SQLite.
- `DATABASE_POOL_SIZE`, `DATABASE_SSL`, and `DATABASE_SSL_REJECT_UNAUTHORIZED` control the PostgreSQL connection pool and TLS behavior.

Switching drivers selects a different database. It does not copy records between SQLite and PostgreSQL automatically.

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



方向是对的，而且值得做。但我建议把目标定义为：

> 保留 AI SDK Agent Loop 作为宿主核心，建立统一的 Capability SDK/Registry；File、Chart、Browser Code 是三个独立能力包，Node、MCP、WebPilot 插件只是同一能力内核的不同适配器。

不要把 MCP 本身当成内部核心抽象。AI SDK 官方也建议生产应用优先使用原生 AI SDK Tool，以获得类型安全、性能和完整控制；MCP 更适合外部接入和用户自带工具。[AI SDK Tools 与 MCP Tools](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)

## 一、当前代码为什么确实需要拆

现在的主要耦合点已经很明确：

- [browser-chat-executor.agent.ts](C:/Users/chenjf/Desktop/test2/web-app-test/src/server/ai/agents/browser-chat-executor.agent.ts:1306) 中的 `makeBrowserTools()` 同时定义了：
  - `browserCode`
  - `readBrowserState`
  - `waitForHumanVerification`
  - `file`
  - `fileVisual`
  - `chart`
  - Skill 自动加载
  - 工具追踪、审批、并发队列、浏览器预检
- [browser-chat-executor.agent.ts](C:/Users/chenjf/Desktop/test2/web-app-test/src/server/ai/agents/browser-chat-executor.agent.ts:3195) 又直接负责工具实例化、过滤和传给 AI SDK。
- File 层直接依赖 Browser 类型：
  - [file-artifact-tools.ts](C:/Users/chenjf/Desktop/test2/web-app-test/src/server/ai/agents/file-artifact-tools.ts:9) 使用 `BrowserActionResult`
  - 同文件还依赖 `BrowserCodeAttachmentBinding`
- Chart 层也依赖 Browser 类型：
  - [chart-artifact-tools.ts](C:/Users/chenjf/Desktop/test2/web-app-test/src/server/ai/agents/chart-artifact-tools.ts:4)
- Chart 的后端存储、API、Markdown 标记解析、React 渲染目前散落在：
  - [chart-artifact-tools.ts](C:/Users/chenjf/Desktop/test2/web-app-test/src/server/ai/agents/chart-artifact-tools.ts:243)
  - [browser-chat-markdown.ts](C:/Users/chenjf/Desktop/test2/web-app-test/src/components/browser-chat-markdown.ts:167)
  - [BrowserChatChart.tsx](C:/Users/chenjf/Desktop/test2/web-app-test/src/components/BrowserChatChart.tsx:21)
  - [charts route](C:/Users/chenjf/Desktop/test2/web-app-test/src/app/api/browser-chat/[sessionId]/charts/[chartId]/route.ts:1)
- 设置页目前还是静态页签，没有 Capability/Plugin Registry：
  - [settings.ts](C:/Users/chenjf/Desktop/test2/web-app-test/src/config/settings.ts:3)
  - [environment-settings-model.ts](C:/Users/chenjf/Desktop/test2/web-app-test/src/components/environment-settings-model.ts:3)

粗略看，Browser 非测试代码约 1.8 万行，File/Office 约 1.55 万行。它们不是简单移动几个函数就能完成的模块。

## 二、目标架构

```text
                   ┌─────────────────────────┐
用户请求 ──────────▶│ AI SDK Agent Loop       │
                   │ prepareStep / stopWhen  │
                   │ Working Memory / Trace  │
                   └────────────┬────────────┘
                                │
                     Capability Registry
                                │
          ┌─────────────────────┼─────────────────────┐
          │                     │                     │
   File Capability       Chart Capability     Browser Capability
          │                     │                     │
   Office/Python          ECharts/Renderer      Playwright/Kernel
   LibreOffice            Artifact Marker       Browser Session
          │                     │                     │
          └─────────────────────┼─────────────────────┘
                                │
                    Host Services / Permissions
              Artifact、Storage、Secrets、Approval、Log
                                │
           ┌────────────────────┼────────────────────┐
           │                    │                    │
      AI SDK Adapter       MCP Adapter        WebPilot Plugin
```

AI SDK 的 `ToolLoopAgent` 本身已经支持 `tools`、`activeTools`、`prepareStep`、`stopWhen` 等机制，所以 Agent Loop 不需要重写，只需要把静态工具表改为 Registry 动态装配。[AI SDK ToolLoopAgent](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent)

## 三、建议新增四个包

三个是业务能力库，第四个只是很薄的共享协议，不属于业务能力。

```text
packages/
  capability-sdk/
  capability-file/
  capability-chart/
  capability-browser/
```

### `@webpilot/capability-sdk`

只放稳定契约：

- 插件 Manifest
- Capability 生命周期
- Tool 定义
- Host Context
- Artifact 输出协议
- 权限声明
- UI Renderer 协议
- Health Check
- Progress/Trace 事件

它不能依赖：

- Next.js
- React
- Browser Chat
- TypeORM, SQLite, PostgreSQL
- WebPilot 的具体 API 路由
- Playwright、LibreOffice、ECharts

建议的核心接口：

```ts
export interface CapabilityPlugin {
  manifest: CapabilityManifest;

  activate(context: CapabilityHostContext):
    Promise<CapabilityInstance>;
}

export interface CapabilityInstance {
  tools: Record<string, CapabilityTool>;
  instructions?: CapabilityInstructions[];
  renderers?: CapabilityRendererContribution[];
  routes?: CapabilityRouteContribution[];

  health(): Promise<CapabilityHealth>;
  dispose(): Promise<void>;
}

export interface CapabilityTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(
    input: unknown,
    context: CapabilityExecutionContext,
  ): Promise<CapabilityResult>;
}
```

统一结果不能再叫 `BrowserActionResult`，建议改成：

```ts
type CapabilityResult = {
  ok: boolean;
  summary?: string;
  data?: unknown;
  content?: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; artifactId: string }
    | { type: 'artifact'; artifactId: string; downloadUrl?: string }
    | { type: 'ui'; renderer: string; resourceId: string }
  >;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
};
```

这样 File、Chart 不再依赖 Browser 模块。

### `@webpilot/capability-file`

包含：

- 文件列表、读取、下载、转换
- Office `plan → generate → edit → render`
- DOCX/XLSX/PPTX/PDF
- Python Worker
- LibreOffice/UNO
- JavaScript Office Worker
- Office 校验、预览、视觉检查
- Artifact 生命周期
- `file`、`fileVisual` Tool
- File Runtime Skill

但要把宿主部分注入：

- Artifact 根目录
- Attachment 读取
- 下载 URL 生成
- 用户/session/run 标识
- 进度回调
- AbortSignal
- Secret/网络策略

Python 和 LibreOffice 不应直接塞进普通 npm 包。建议拆成：

```text
capability-file/
  src/
  runtime/
    python/
    libreoffice/
    workers/
  adapters/
    ai-sdk/
    mcp/
    webpilot/
```

Manifest 声明运行时要求：

```json
{
  "runtimeRequirements": {
    "node": ">=22.16",
    "python": ">=3.11",
    "libreoffice": ">=25",
    "platforms": ["win32-x64", "linux-x64"]
  }
}
```

WebPilot 安装器负责检测或安装运行时；离线桌面包继续携带固定版本的 LibreOffice 和 Python Worker。

### `@webpilot/capability-chart`

包含完整链路：

- ECharts API 索引
- Option 校验
- Chart Artifact 持久化
- 模型 Tool
- 输出标记解析
- 前端 Renderer
- Canvas/SVG 渲染
- MCP 降级输出

当前 `chart_000001` 裸行替换可以先迁入包中，但不建议继续作为永久协议。直接改成结构化标记更稳：

```text
:::webpilot-artifact
{"kind":"chart","resourceId":"chart_000001"}
:::
```

更理想的是 Agent 消息本身保存结构化 `ui` part，Markdown 只负责普通文本。这样不会出现模型偶然输出 `chart_000001` 就被替换的问题。

Chart 的 MCP 版本必须考虑宿主能力差异：

- 支持 MCP Apps/自定义 UI 的宿主：显示交互式 ECharts
- 普通 MCP Client：返回 ECharts JSON、SVG/PNG Artifact 或 Resource Link
- Node/WebPilot 插件：使用完整交互式 Renderer

所以可以“同一能力多格式发布”，但不能承诺每种宿主都有完全相同的 UI。

### `@webpilot/capability-browser`

包含：

- Playwright
- BrowserSession
- Browser Code Kernel
- 页面运行时注入
- AX/DOM Snapshot
- 浏览器启停、恢复、标签页管理
- 截图与视觉证据
- Web Preview/Screencast
- 浏览器运行时状态
- `browserCode`
- `readBrowserState`
- `waitForHumanVerification`
- Browser Runtime Skill
- 测试浏览器发现和运行时检查

不要把下面内容放进去：

- Browser Chat 消息持久化
- Agent Loop
- 用户会话数据库
- 缺陷数据库
- WebPilot 权限体系
- 模型配置

`reportDefect` 建议留在 WebPilot 宿主。它属于测试产品工作流，只是消费 Browser Capability 的截图证据，不属于通用浏览器自动化库。

Browser MCP 不能继续隐式依赖 `runId`。对外应显式提供句柄：

```text
browser.open     -> browserSessionId
browser.code     -> browserSessionId + code
browser.snapshot -> browserSessionId
browser.close    -> browserSessionId
```

WebPilot 内部仍然可以将这些能力合并成模型看到的 `browserCode` Tool。

## 四、同一内核如何发布成三种格式

每个能力包生成三层出口：

```json
{
  "exports": {
    ".": "./dist/core/index.js",
    "./ai-sdk": "./dist/adapters/ai-sdk.js",
    "./mcp": "./dist/adapters/mcp.js",
    "./webpilot": "./dist/adapters/webpilot.js",
    "./client": "./dist/client/index.js"
  },
  "bin": {
    "webpilot-chart-mcp": "./dist/bin/mcp.js"
  }
}
```

| 格式 | 用途 | 执行方式 |
|---|---|---|
| Node 包 | 其他 Node/AI SDK 项目直接调用 | 进程内 |
| WebPilot 插件 | 设置页导入，具备完整宿主能力和 UI | Worker/独立进程 |
| MCP stdio | 本地客户端、桌面应用 | 子进程 |
| MCP Streamable HTTP | 远程部署、多用户 | 独立服务 |

MCP 当前标准传输主要是 stdio 和 Streamable HTTP；stdio 适合本地子进程，远程服务使用 Streamable HTTP，并需要认证、Origin 校验等保护。[MCP Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)

## 五、WebPilot 插件格式

建议定义 `.wpp`，本质是签名 ZIP：

```text
com.webpilot.chart-1.0.0.wpp
  manifest.json
  integrity.json
  dist/
    server.mjs
    client.js
    mcp.mjs
  assets/
  runtime/
```

Manifest 示例：

```json
{
  "schemaVersion": 1,
  "id": "com.webpilot.chart",
  "name": "Chart",
  "version": "1.0.0",
  "engine": {
    "webpilot": ">=1.0.0",
    "node": ">=22.16"
  },
  "entrypoints": {
    "server": "./dist/server.mjs",
    "client": "./dist/client.js",
    "mcp": "./dist/mcp.mjs"
  },
  "tools": [
    {
      "name": "chart",
      "publicName": "chart"
    }
  ],
  "renderers": [
    {
      "kind": "chart",
      "entrypoint": "./dist/client.js"
    }
  ],
  "permissions": [
    "artifact:read",
    "artifact:write"
  ]
}
```

三个内置插件权限大致为：

| 插件 | 权限 |
|---|---|
| Chart | Artifact 读写、客户端 Renderer |
| File | Artifact/Attachment 读写、网络下载、子进程、Office Runtime |
| Browser | 浏览器启动/CDP、网络访问、附件受控读取、凭据受控填充、截图 |

## 六、设置页和安装流程

增加“能力插件”页签，和现有 Skills 分开。Skill 是提示和使用方法，Plugin 是可执行代码，两者不能混为一类。

页面功能：

- 导入 `.wpp`
- 添加 MCP URL
- 添加本地 MCP stdio 配置
- 查看已安装版本、来源、权限、工具
- 启用/禁用
- 配置运行时
- 运行健康检查
- 升级、卸载
- 查看最近激活错误

状态建议：

```text
installed
enabled
disabled
incompatible
needs-runtime
unhealthy
```

安装流程：

1. 上传到临时目录。
2. 校验文件大小、ZIP 路径、Manifest Schema。
3. 校验 SHA-256 和签名。
4. 检查 WebPilot/Node/平台版本。
5. 显示权限确认。
6. 解压到版本目录。
7. 执行 `health()`，不执行包内 `postinstall`。
8. 原子写入插件记录。
9. 启用后，从下一次 Agent Run 开始生效。
10. 已经运行中的 Agent Loop 不动态改变 Tool Schema。

不要让设置页直接执行任意 `npm install`。上传插件本质上是授予服务器代码执行权，必须：

- 仅管理员可安装
- 禁止生命周期脚本
- 校验签名和完整性
- 版本化目录、原子切换
- 在 Worker/子进程中执行
- Secret 单独保存，只向插件传引用
- 禁止插件直接访问 WebPilot 数据库
- 限制解压路径，防止 Zip Slip

## 七、Agent Loop 的改造方式

Agent Core 继续拥有：

- AI SDK `ToolLoopAgent`
- `prepareStep`
- `stopWhen`
- Working Memory
- Visual Context Manager
- trace store
- 上下文压缩
- 模型重试
- Tool Approval
- 工具结果持久化
- Prompt Cache

插件拥有：

- Tool Schema
- Tool Description
- Tool Execution
- 能力自己的 Runtime Skill
- 前置条件声明
- 权限声明
- 输出 Renderer

把当前 `record()` 中的逻辑拆成通用中间件：

```text
PermissionMiddleware
→ HiddenSkillMiddleware
→ PrerequisiteMiddleware
→ ApprovalMiddleware
→ ConcurrencyMiddleware
→ TraceMiddleware
→ ResultNormalizationMiddleware
```

Registry 每次 Agent Run 开始时：

```ts
const snapshot = await capabilityRegistry.resolve({
  userId,
  sessionId,
  requestedCapabilities,
});

const tools = await aiSdkAdapter.toToolSet(snapshot.tools);

const agent = new ToolLoopAgent({
  model,
  tools,
  prepareStep,
  stopWhen,
});
```

工具内部 ID 使用：

```text
com.webpilot.file:file
com.webpilot.chart:chart
com.webpilot.browser:browserCode
```

模型看到的名字仍然是：

```text
file
chart
browserCode
```

Registry 必须检查公开名称冲突，两个启用插件不能同时声明同一个 `publicName`。

## 八、持久化设计

当前项目后端已通过 TypeORM 同时支持 SQLite 和 PostgreSQL；插件存储继续通过 Repository 接口实现，避免上层直接写 SQL：

```text
capability_plugin
  id
  version
  source_kind
  manifest_json
  install_path
  integrity
  status
  installed_by
  installed_at
  updated_at

capability_plugin_user
  plugin_id
  user_id
  enabled
  config_json
  updated_at

capability_plugin_health
  plugin_id
  version
  status
  details_json
  checked_at
```

敏感配置不要写入 `config_json`，单独进入 Secret Store，仅保存 `secretRef`。

## 九、推荐实施顺序

### 阶段 0：固定当前基线

当前工作区在 Agent、File、Chart 和 Browser Chat 等关键文件上存在未提交改动，实施前应先形成可回退基线，避免把正在开发的 Chart 逻辑和架构迁移混为一次变更。

### 阶段 1：建立 Capability SDK 和 Registry

先完成：

- Manifest
- Host Context
- CapabilityResult
- 生命周期
- Tool 中间件
- 插件 Repository
- 动态 ToolSet 装配
- 设置页基础列表

这一阶段不移动三个能力，只让内置工具也通过 Registry 注册。

### 阶段 2：先迁移 Chart

Chart 规模最小，又同时覆盖：

- 后端 Tool
- Artifact 存储
- API
- 前端 Renderer
- Markdown/消息替换
- npm/MCP/plugin 三种适配器

它最适合验证插件协议是否真的可行。

完成后删除 Agent Executor 里的 Chart Schema 和硬编码 Prompt。

### 阶段 3：迁移 File

建议按以下内部子层拆：

```text
file-core
file-download
office-workflow
office-uno-runtime
office-js-runtime
office-validation
office-preview
file-ai-sdk-adapter
file-mcp-adapter
file-webpilot-adapter
```

迁移时同时消除：

- `BrowserActionResult`
- `BrowserCodeAttachmentBinding`
- `artifactPath`
- Browser Chat 专属 URL
- Browser Chat 专属 Abort 错误文本

全部改为 Host Context 注入。

### 阶段 4：迁移 Browser

顺序应为：

1. Browser runtime/config
2. Browser Code Kernel
3. BrowserSession
4. AX/DOM Snapshot
5. 浏览器生命周期
6. Screencast/Preview
7. Electron Bridge
8. AI SDK Adapter
9. MCP Adapter

不要第一步就移动 8800 行的 `browser-session.ts`。先让它只依赖 Browser 包内部接口，再物理移动。

### 阶段 5：设置页正式启用导入

接入：

- `.wpp` 上传
- MCP HTTP/stdio
- 权限确认
- Health Check
- 启用/禁用
- 工具预览
- 下一 Agent Run 生效

### 阶段 6：删除旧路径

按照这个项目当前阶段，不保留双注册、旧 Schema、旧 Prompt 分支或旧 Marker 兼容层。新 Registry 工作后直接删除：

- `makeBrowserTools()` 中三个能力的硬编码
- `runtimeToolNames()` 静态名单
- 内置能力硬编码 Skill ID
- Chart 专属宿主路由
- File 对 Browser 类型的依赖
- 旧工具选择分支

## 十、验收标准

不新增测试文件，按以下结果验收：

- 未安装三个插件时，模型请求中不存在 `file/chart/browserCode`。
- 启用 Chart 后，只增加 `chart`，能生成并渲染。
- 启用 File 后，只增加 `file/fileVisual`，LibreOffice 缺失时显示 `needs-runtime`。
- 启用 Browser 后，能恢复会话、执行 Playwright、截图和关闭。
- 禁用插件后，下一个 Agent Run 的 Tool Schema 立即移除对应工具。
- 一个插件执行失败，不影响 Agent Core 和其他插件。
- Node 包、MCP、`.wpp` 使用同一核心实现和同一版本号。
- MCP 断开时能够释放浏览器、Worker 和 LibreOffice 子进程。
- Agent 日志记录插件 ID、版本、工具名、执行时间和权限决定。
- TypeScript 包之间不存在反向依赖。
- 不运行项目 `dev/build`，不新增测试文件；使用类型检查、依赖边界扫描、Manifest 校验、插件 `health/doctor` 和现有运行环境中的功能验收。

## 十一、投入估算

按一名熟悉当前项目的工程师估算：

| 阶段 | 人日 |
|---|---:|
| Capability SDK、Registry、存储 | 5–7 |
| Chart 迁移 | 3–4 |
| File/Office 迁移 | 8–12 |
| Browser 迁移 | 12–18 |
| 设置页、安装器、安全边界 | 6–9 |
| 清理、打包和验收 | 3–5 |

三个内置能力完成真正解耦，大约需要 37–55 人日。若第一版只支持官方三个 `.wpp`，暂不开放任意第三方代码安装，可压缩到约 25–35 人日。

最适合立即开始的第一步不是移动 File 或 Browser，而是先实现 `capability-sdk + registry`，然后用 Chart 跑通完整纵向链路。Chart 跑通后，接口是否合理会非常清楚，之后再处理体量最大的 File 和 Browser，返工风险最低。
