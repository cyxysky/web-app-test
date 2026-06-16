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