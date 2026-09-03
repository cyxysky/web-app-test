# @webpilot/capability-adapter-ai-sdk

Mounts framework-neutral Capability providers as an AI SDK `ToolSet` and
injectable Skill instructions.

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

The adapter depends on `@webpilot/capability-host`, so consumers do not install
the host package separately unless they want to import its framework-neutral
APIs directly. The `/node` and `/typeorm` adapter entrypoints re-export the
corresponding built-in configuration stores. Using `/typeorm` requires the host
application to install TypeORM and its selected SQLite or PostgreSQL driver.
