# @webpilot/capability-git

Bounded Git inspection and explicitly enabled mutations. The Node adapter invokes Git without a shell and remains scoped to one host-selected repository root.

## TypeScript Agent framework integration

```ts
import { createNodeGitCapability } from '@webpilot/capability-git/node';

const provider = createNodeGitCapability({
  repository: './repository',
});
```

Register this provider with `mountCapabilities()` and expose the resolved `git`
tool through the consuming TypeScript Agent framework. Inject the required Git
Skill before use; the host must authorize writes independently of model intent.
See the complete
[TypeScript Agent framework integration guide](../capability-sdk/FRAMEWORK_INTEGRATION.md).
