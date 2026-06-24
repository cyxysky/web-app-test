# Web App Test

AI-driven web testing workspace built with Next.js, AI SDK, and Playwright.

The project is focused on test execution, exploratory coverage, replay, evidence capture, and final test reports. Browser automation is treated as the execution mechanism, not the product goal.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

The app uses DeepSeek by default:

```bash
DEEPSEEK_API_KEY=your_key
AI_MODEL=deepseek-v4-flash
```

You can override `AI_PROVIDER`, `AI_MODEL`, `DEEPSEEK_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_API_KEY` in `.env.local`.
If the model call fails, generation falls back to a local structured test case and records the failure reason in the test case risks.

Browser execution accepts `http` and `https` target URLs by default. Set `ALLOWED_TEST_DOMAINS=localhost,127.0.0.1,example.com` to restrict runs to a domain allowlist.

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

1. Copy `.env.example` to `.env` and fill the provider key you want to use.
2. Build and start:

```bash
npm run docker:up
```

Then open `http://localhost:3000`.

The compose setup keeps runtime data outside the image:

- `.data/store.json` stores test cases and runs.
- `artifacts/` stores screenshots and reports.

For unattended packaged regression runs, keep `HEADLESS_BROWSER=true`. For account-based exploratory testing or manual verification, prefer a visible or CDP-connected browser.


$env:WEBPILOT_ELECTRON_SERVER_URL="http://127.0.0.1:3000"
npx electron .

gpt-5.3-codex-spark


DOM observation 改成“单条当前 observation”
不再让 readObservation 输入 obs_xxx。
getPageState 每次刷新当前唯一 observation。
readObservation(type, offset, maxChars) 永远读取最新 getPageState 保存的那条。
旧的多 observation id 存储逻辑被替换成按 runId 保存当前 observation。

取消自动刷新 DOM
最终逻辑不是“每次操作后自动更新 DOM”。
DOM 模式下浏览器变化后，仍需要模型显式调用 getPageState 刷新，再调用 readObservation 读文本/可交互元素。

getPageState 不再把完整 hierarchical interactive elements 直接塞回 message
它只返回页面状态摘要。
完整文本和可交互元素被存到当前 observation。
模型需要自己调用 readObservation(type="text") 或 readObservation(type="interactive") 获取。

readObservation 最小读取量调大
maxChars 下限改成 10000。
DOM observation 相关工具结果预算也按 10000 起步，减少模型反复分段读取。

历史 observation 压缩
历史消息中，最后一次 getPageState 之前的旧 readObservation 结果会在发给 AI 前压缩成 已失效。
目的就是减少上下文长度。
最新 getPageState 之后的 readObservation 不应该被清掉。

删除模型可调用的旧 DOM node 工具
从 runtime 工具列表、prompt、录制回放路径中移除了这些工具：getDomNodeText
clickDomNode
hoverDomNode
doubleClickDomNode
dragDomNode
fillDomNodes

但 BrowserSession 里这些底层方法还没有物理删除，只是不再暴露给模型调用。

DOM 模式下 browser-chat 不截图
browser-chat 的 DOM 模式不再做 before/after screenshot。
recoverable error 也不会额外补 after screenshot。
AI input 中 DOM 模式不再附截图路径/图片。

修复 step 7 变 step 1 / messages 丢失
browser-chat-executor 增加了 runtimeMessageState。
外层每个 browser-chat step 之间会继续传递上一轮 AI SDK 的 messages 和 agentStepOffset。
工具已经执行后如果 SDK 后续中断，也会保留 partial message state。
同时修正 response messages 追加逻辑，避免重复追加旧 SDK step 的消息。

prompt 同步更新
Codex object prompt 不再提示使用 DOM node id 工具。
改为提示：getPageState 刷新当前 observation，readObservation 读取，操作优先用 clickCandidate 或 findByText/clickLocator。

一个错误提示更新
findByText 找不到时，不再提示 getDomNodeText。
改成提示重新 findByText 或 getPageState + readObservation(type="interactive") 获取新候选。