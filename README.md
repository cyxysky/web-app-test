# Web App Test

AI-driven browser testing MVP built with Next.js, AI SDK, and Playwright.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

The app uses the OpenAI-compatible mirror by default:

```ts
createOpenAI({
  baseURL: 'http://mirrors.shterm.com:8801/openai',
  apiKey: '-',
  compatibility: 'compatible',
}).chat('gpt-5.4')
```

You can override `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `AI_MODEL` in `.env.local`. If the model call fails, generation falls back to a local structured test case so the app remains usable.
