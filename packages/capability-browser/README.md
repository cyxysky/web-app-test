# @webpilot/capability-browser

An agent-framework-neutral Playwright browser capability.

The root export owns one `browser` capability contract with `state`, `code`, and
`waitForHumanVerification` actions. `./node` owns BrowserSession,
the persistent JavaScript kernel, AX/DOM snapshots, tab lifecycle, screenshots,
preview state, and runtime discovery.

Applications inject artifact storage and optional persistent `agent.state`
services through `BrowserSessionOptions.host`. Browser Chat, databases, defect
reporting, model selection, and the Agent loop remain host responsibilities.

```ts
import { BrowserSession, createNodeBrowserCapability } from '@webpilot/capability-browser/node';

const session = new BrowserSession({ headless: true, isolated: true });
const provider = createNodeBrowserCapability({
  createOptions: (context) => ({
    session,
    runId: context.runId,
    ensureStarted: () => session.start(),
    disposeSession: true,
  }),
});
```

Pass this provider to the framework-neutral `mountCapabilities()` entrypoint,
map the resolved `browser` tool to the consuming TypeScript Agent framework,
and inject the package Skill before Browser execution. See the complete
[TypeScript Agent framework integration guide](../capability-sdk/FRAMEWORK_INTEGRATION.md).

`mountAISDKCapabilities()` is the optional AI SDK convenience path. Its returned
`agentOptions` contains both tools and eager/lazy Skill instructions; settings
are loaded from the selected host configuration store before Browser runtime
creation.

`@webpilot/capability-browser/mcp` exposes explicit sessions. Call
`browser.open` to obtain a `browserSessionId`, then pass it to
`browser.code`, `browser.snapshot`, and `browser.close`. The included
`webpilot-browser-mcp` executable serves this interface over stdio.
