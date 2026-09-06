# @webpilot/capability-browser

An agent-framework-neutral Playwright browser capability.

The root export owns one `browser` capability contract with `state`, `code`, and
`waitForHumanVerification` actions. `./node` owns BrowserSession,
the persistent JavaScript kernel, AX/DOM snapshots, tab lifecycle, screenshots,
preview state, and runtime discovery.

Applications inject artifact storage and optional persistent `agent.state`
services through `BrowserSessionOptions.host`. Browser Chat, databases, defect
reporting, model selection, and the Agent loop remain host responsibilities.

Session operations serialize preparation, execution and result collection together,
including live input and tab switching. Independent sessions can still run concurrently.
Closing a session cancels queued work and drains active cleanup before releasing it.

`state` / `browser.snapshot` accept `scope: 'active' | 'all'`, an exact `frame`
path (`main` for the main frame), a unique `selector`, literal `query`, and
`maxOutputChars`. Pass a returned `nextCursor` as `cursor` to continue the same
immutable capture. Keep the selection unchanged; cursors expire after two minutes,
navigation, a new capture, or a code action. `capturedAt` describes historical
capture time, so re-check live locators before acting on a continuation page.

Code results include `executionState`: attempted actions, completed Playwright calls,
execution phase, outcome and `requiresStateRefresh`. A timeout/abort/crash has an
unknown outcome once execution started; read live state before retrying. A completed
Playwright call alone is not proof that the application's business operation succeeded.
`kernelReset.reason` also covers timeout, abort and crash; JavaScript bindings are lost.

Hosts can set `host.receiveDownload` to persist actual browser download bytes,
including authenticated, POST-generated and blob downloads. The File package exports
`createNodeFileDownloadReceiver({ artifactsRoot, artifactUrl })` for this contract.
Code results expose `downloads` with artifact IDs usable by File `readContent`.
Without this adapter, the existing live-preview URL relay remains available.

The session facade delegates shared browser leases, scheduling, state pagination and
download lifecycle to separate internal modules; existing public imports are preserved.

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
