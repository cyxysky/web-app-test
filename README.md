# Web App Test

AI-driven browser testing MVP built with Next.js, AI SDK, and Playwright.

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
