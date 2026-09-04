# @webpilot/capability-code-sandbox

Bounded Python and JavaScript process execution for agents. The portable core accepts an injected executor; the Node adapter uses argument-safe child processes, a sanitized environment, a fixed workspace, output limits, timeouts, and abort handling. It is not an OS security boundary, so hosts must isolate untrusted execution with a container or remote sandbox.

## TypeScript Agent framework integration

```ts
import { createNodeCodeSandboxCapability } from '@webpilot/capability-code-sandbox/node';

const provider = createNodeCodeSandboxCapability({
  workspaceDirectory: './agent-workspaces/code',
});
```

Register this provider with `mountCapabilities()`, expose the resolved
`codeSandbox` tool through the consuming framework, and inject the package Skill
before execution. The host must enforce the declared process and workspace
policy in addition to the package's bounded runner. See the complete
[TypeScript Agent framework integration guide](../capability-sdk/FRAMEWORK_INTEGRATION.md).
