# Web App Test

AI-driven web testing workspace built with Next.js, AI SDK, and Playwright.

The project is focused on test execution, exploratory coverage, replay, evidence capture, and final test reports. Browser automation is treated as the execution mechanism, not the product goal.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. Create a `.env.local` file for local development; for Docker, create `.env` in the project root.

The app uses DeepSeek by default:

```bash
DEEPSEEK_API_KEY=your_key
AI_MODEL=deepseek-v4-flash
```

You can override `AI_PROVIDER`, `AI_MODEL`, `DEEPSEEK_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_API_KEY` in `.env.local`.
If the model call fails, generation falls back to a local structured test case and records the failure reason in the test case risks.

Browser execution accepts `http` and `https` target URLs by default. Set `ALLOWED_TEST_DOMAINS=localhost,127.0.0.1,example.com` to restrict runs to a domain allowlist.

## Personal Memory

Browser chat stores local personal memory in the SQLite runtime database.
It does not require an embedding model or vector database. After a completed browser-chat turn, the app asks the current chat model to extract only concise durable items such as aliases, preferences, workflows, and domain facts. Future turns recall matching active items by user id, current domain, and keyword/alias match.

You can view, add, edit, disable, and delete memory items in Settings -> Personal Memory. The local SQLite database remains the source of truth for backup or bulk cleanup.

Runtime controls:

- `AI_PERSONAL_MEMORY_ENABLED=false` disables recall and extraction.
- `AI_PERSONAL_MEMORY_EXTRACT_ENABLED=false` disables post-turn extraction while keeping manual memory recall available.
- `AI_PERSONAL_MEMORY_PROMPT_LIMIT=6` controls how many memory items are injected into one turn.
- `AI_PERSONAL_MEMORY_EXTRACTION_TIMEOUT_MS=30000` controls the extraction request timeout.

Minimal management API:

- `GET /api/personal-memory?userId=...&domain=...&includeDisabled=true`
- `POST /api/personal-memory`
- `PATCH /api/personal-memory/{id}`
- `DELETE /api/personal-memory/{id}`

Each test case can choose a browser operation mode:

- `Default configuration` keeps compatibility with `isClick` / `AI_BROWSER_MODE`.
- `DOM interaction` uses textual interactive candidates and the simplified DOM tree.
- `Visual markers` sends one viewport screenshot with numbered marker labels overlaid by default.

## Reuse an Existing Browser

To reuse login state from an existing Chrome or Edge profile, start that browser with a remote debugging port, then set `BROWSER_CDP_ENDPOINT` in the settings page:

```powershell
chrome.exe --remote-debugging-port=9222 --user-data-dir="$env:TEMP\webpilot-qa-chrome"
```

Then set:

```bash
BROWSER_CDP_ENDPOINT=http://127.0.0.1:9222
```

You can also set `BROWSER_USER_DATA_DIR` to let Playwright launch a persistent browser profile when a CDP endpoint is not configured.

Replay uses `REPLAY_STEP_DELAY_MS` between recorded actions by default, so fixed flows wait for page transitions instead of firing every operation immediately. If a recorded flow reaches CAPTCHA, login verification, or another user-side security check, the run pauses and waits for the user to click “执行完毕” before continuing.

When a recorded operation fails, `REPLAY_AI_REPAIR=true` lets the AI inspect the current page, choose a replacement operation, record the failed replay action as an issue, and continue the remaining replay flow after the repair succeeds.

During AI execution, `getHttpRequests` is available as a read-only diagnostic tool for the current tab. The agent can use it to verify API status codes, failed requests, and missing resource evidence before recording a network-related issue. Issues and risks in the final report include the reason and a screenshot from the source step when available.

## Package and Run with Docker

Docker is available for packaged runs because the app depends on Playwright and a Chromium runtime.

1. Create `.env` and fill the provider key you want to use.
2. Build and start:

```bash
npm run docker:up
```

Then open `http://localhost:3000`.

The compose setup keeps runtime data outside the image:

- `.data/webpilot.db` is the SQLite source of truth for model/runtime settings, test cases, runs, browser-chat sessions, personal memory, and Electron workspace state.
- `artifacts/` keeps screenshots, traces, uploads, reports, and other large generated files outside the database.
- Chromium profiles and caches remain managed by Chromium in their native file layout.

For unattended packaged regression runs, keep `HEADLESS_BROWSER=true`. For account-based exploratory testing or manual verification, prefer a visible or CDP-connected browser.

## Desktop development

Start the Next.js server first, then launch Electron in another PowerShell window:

```powershell
$env:WEBPILOT_ELECTRON_SERVER_URL="http://127.0.0.1:3000"
npx electron .
```

你生成时，模型判断需要用户补充的内容只需要让用户输入文本即可，不需要别的东西，用户输入完后，点击目标卡片执行，ai再次确认是否还需要别的内容，如果需要，继续，否则ai开始执行，以下是个例子
注意，消息的补充可以让用户直接回复文本，也可以在卡片里面添加表单让用户输入，看你的想法
用户的一个需求：
admin在配置界面配置
使用者，在一个列表页进行3次不同的操作，判断对应的数据以及样式是否正确

用户提问：
测试这个需求

ai分析：
需求了解了，需要用户提供的资料有：
admin登录账号密码
使用者账号密码

用户在目标卡片中输入账号密码继续

ai分析：
该需求的资料收集完毕了，生成目标流程树，调用目标模式工具

流程1  
目标：使用admin登录系统，进入配置页配置
验证：配置页界面在配置操作完成后，有对应的配置数据

流程2                                  流程3      并行流程
目标：使用者1进入列表页操作1             目标：     使用者2进入界面进行操作
验证：操作1完成后，数据是否正确           验证：    操作2完成后，数据是否正确          

流程4
总结，配置是否成功，操作是否成功

你改完后自行进行一个测试，例子就用我给你的这个，你稍微完善优化一下语言，然后实际执行测试一下




bug
1.工具开始执行时，省略展开收起文本为工具调用失败
2.