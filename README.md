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
DEEPSEEK_BASE_URL=https://api.deepseek.com
AI_MODEL=deepseek-v4-flash
```

You can override `AI_PROVIDER`, `AI_MODEL`, `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `OPENAI_BASE_URL`, and `OPENAI_API_KEY` in `.env.local`. For the internal TLS forwarding endpoint, keep the hostname and configure `DEEPSEEK_BASE_URL=https://api.deepseek.com:8802` after mapping `api.deepseek.com` to the forwarding IP in the local hosts file.
If the model call fails, generation falls back to a local structured test case and records the failure reason in the test case risks.

Browser execution accepts `http` and `https` target URLs by default. Set `ALLOWED_TEST_DOMAINS=localhost,127.0.0.1,example.com` to restrict runs to a domain allowlist.

## Embed behind one Nginx path

WebPilot can be published below one path so the host application does not need to proxy every API separately. The path is part of the Next.js build, so set it before starting development or building a package:

```bash
WEBPILOT_BASE_PATH=/webpilot
WEBPILOT_PUBLIC_BASE_URL=http://localhost:8080/webpilot
```

`WEBPILOT_PUBLIC_BASE_URL` is the browser-visible URL. It is optional when Nginx forwards `Host`, `X-Forwarded-Host`, and `X-Forwarded-Proto` correctly, but setting it explicitly avoids ambiguity.

Docker Compose passes `WEBPILOT_BASE_PATH` from `.env` into the image build. After changing it, recreate the image instead of only restarting the existing container:

```bash
docker compose build --no-cache webpilot-qa
docker compose up -d webpilot-qa
```

For a direct Docker build, pass the same value explicitly:

```bash
docker build --build-arg WEBPILOT_BASE_PATH=/webpilot -t webpilot-qa:latest .
```

The important Nginx detail is that `proxy_pass` has no trailing `/`; WebPilot's `/webpilot` prefix must reach Next.js unchanged:

```nginx
server {
    listen 8080;

    location = /webpilot {
        return 308 /webpilot/;
    }

    location /webpilot/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
    }

    location / {
        proxy_pass http://127.0.0.1:4300;
    }
}
```

Open the Angular application through Nginx at `http://localhost:8080`, not through its original port. The Angular template can then use one same-origin prefix:

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

## Package a standalone HTTP server for Windows

To distribute the backend without Electron, create a self-contained service archive on the build machine:

```powershell
npm run server:package
```

This produces `dist-server/WebPilot-Server-<version>.zip`. The target machine only needs Node.js 22.13 or later: extract the archive and run `start.cmd`. It includes all traced Node dependencies and the Playwright Chromium binary, so the target machine does not need `npm install` or `npx playwright install chromium`.

By default it listens on all network interfaces at port `3000` (locally: `http://127.0.0.1:3000`), stores application data under `runtime/`, and runs the browser headlessly. Set `PORT`, `APP_DATA_DIR`, `ARTIFACTS_DIR`, or `HEADLESS_BROWSER` before `start.cmd` to override those defaults.

## Desktop development

Start the Next.js server first, then launch Electron in another PowerShell window:

```powershell
$env:WEBPILOT_ELECTRON_SERVER_URL="http://127.0.0.1:3000"
npx electron .
```
