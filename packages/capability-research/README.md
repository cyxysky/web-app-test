# @webpilot/capability-research

Portable search and document-fetch contracts for research agents. Results retain URL, title, retrieval time, provider, and source identifiers. The Node fetch adapter blocks local/private targets by default and accepts an injected search provider.

## TypeScript Agent framework integration

```ts
import { createNodeResearchCapability } from '@webpilot/capability-research/node';

const provider = createNodeResearchCapability({
  search: researchSearchProvider,
});
```

`researchSearchProvider` is the host-selected search implementation; omit it
when the Agent only needs public URL fetching. Register the provider with
`mountCapabilities()`, expose the resolved `research` tool through the consuming
TypeScript Agent framework, and inject the package Skill before use. See the
complete
[TypeScript Agent framework integration guide](../capability-sdk/FRAMEWORK_INTEGRATION.md).

The default Node HTTP transport connects to the DNS address checked by the public-network policy while preserving hostname and TLS verification. Redirect bodies are cancelled before the next target is checked. A custom `fetchImpl` owns its connection policy and must provide equivalent address pinning when required.
