# @webpilot/capability-adapter-ai-sdk

Mounts framework-neutral Capability providers as an AI SDK `ToolSet` and
injectable Skill instructions.

This package is an optional convenience adapter for AI SDK. Capability packages
do not depend on it and can be registered with any TypeScript Agent framework
through `@webpilot/capability-host`. See the
[framework-neutral integration guide](../capability-sdk/FRAMEWORK_INTEGRATION.md).

```ts
import { ToolLoopAgent } from 'ai';
import {
  JsonFileCapabilityConfigStore,
  mountAISDKCapabilities,
} from '@webpilot/capability-adapter-ai-sdk/node';

const capabilities = await mountAISDKCapabilities({
  providers,
  context: { runId: crypto.randomUUID() },
  configStore: new JsonFileCapabilityConfigStore('./agent-config.json'),
  skills: { mode: 'lazy' },
});

const agent = new ToolLoopAgent({
  model,
  ...capabilities.agentOptions,
});

await capabilities.dispose();
```

`skills.mode` supports `lazy`, `eager`, or `disabled`. Lazy mode adds a `skill`
tool for explicit Agent reads. Capability calls never load a Skill or enforce a
Skill gate as a side effect. The Agent host owns preloading and any rule that
requires a successful read before exposing or executing related tools. Set
`includeTool: false` when the host already supplies its own Skill tool.

`toAISDKToolSet(snapshot)` remains the low-level adapter for hosts that mount
and manage configuration themselves.

`toAISDKToolSet(snapshot, { policy, abortSignal })` serializes tools sharing a serial concurrency group and combines the mounted run, adapter and individual invocation cancellation signals. `policy.authorize`, `policy.prerequisite` and `policy.reportProgress` connect host authorization, prerequisites and progress reporting, including calls using a custom `execute` wrapper. Without an authorization callback the host remains responsible for granting access; declared prerequisites require a callback.

The adapter depends on `@webpilot/capability-host`, so consumers do not install
the host package separately unless they want to import its framework-neutral
APIs directly. The `/node` and `/typeorm` adapter entrypoints re-export the
corresponding built-in configuration stores. Using `/typeorm` requires the host
application to install TypeORM and its selected SQLite or PostgreSQL driver.
