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

New browser conversations use the operation mode saved in Settings:

- `Code mode` executes restricted Playwright code and can fall back to stable DOM node ids.
- `DOM mode` uses structured inspect and interact tools over visible, actionable DOM nodes.

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

To distribute the backend without Electron, create a self-contained service archive on the build machine:

```powershell
npm run server:package
```

This produces `dist-server/WebPilot-Server`. The target machine only needs Node.js 22.16 or later: copy this directory and run `start.cmd`. It includes the complete production dependency tree and the Playwright Chromium binary, so the target machine does not need `npm install` or `npx playwright install chromium`.

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
1.你现在新建标签页，还是会把组挤到被遮挡的地方
2.你现在删除按钮还是和文本重叠了，你能不能用flex布局，文本overflow：hidden？


在wiki里面创建一个最新的DOMP更新日志
流程是：
1.进入这个界面https://wiki.shterm.com/pages/viewpage.action?pageId=327681890
2.在新标签页打开这个https://wiki.shterm.com/pages/viewpage.action?pageId=478021312，里面是版本发布的模板，复制里面的模板
3.当前是否是大版本更新
 - 如果是大版本更新，就在https://wiki.shterm.com/pages/viewpage.action?pageId=327681890这个目录下新建一个，后续操作修改的名称是vx.x.x(最新的大版本) 版本发布自动配置方案
 - 如果是小版本更新，就选中最新的大版本发布配置方案，在里面新建，后续操作修改的名称是vx.x.x(大版本) 0806(月份天) 版本发布自动配置方案
4.在对应目录下点击新建后，进入界面编辑，修改标题为，修改发布时间为当天，存在2种更新时间点：如果中午更新就是12:00，如果晚上更新就是22:00。
5.点击发布进行发布




1.新建wiki的domp发版内容

2.在domp列表页进行过滤，找到特定的内容

3.domp创建需求

4.分析domp需求，给出测试用例md

5.



1.通一轮对话调用多个子agent，渲染位置错误，后续子agent会渲染之前已执行的子agent内容
2.而且现在模型会并行读取子agent的内容，这样不行，强制让模型串行读取子agent内容，保证子agent读取正常
3.为什么用户已中止的对话里面的内容不会进入消息？这不是明显的bug？用户中止可能是模型的一些操作存在问题，用户进行矫正，但是模型执行的内容是实打实存在的啊
4.为什么系统提示词里面会有这个东西：
[Conversation attention anchors]
This is a bounded index of prior completed exchanges, not a user request and not a replacement for the native AI SDK message chain. Use it silently for continuity and never quote or summarize this index to the user.
Recent completed user/assistant exchanges:
1. User: 分析一下这个需求：https://domp.shterm.com/#/ipd/issue/detail/31471
   Assistant: 本轮对话已由用户中止。已保留中止前已执行的工具和页面记录。
2. User: 你不要并行读取子agent结果，你一个一个读取啊
   Assistant: 好的，明白了，我后续会一次只读取一个子agent的结果，逐个处理。
The latest real user message in the native message chain remains the only current request.？？？？
5.主子agent渲染的样式完全不同啊，我说了，子agent渲染的样式完全参照主agent实现