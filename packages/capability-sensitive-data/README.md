# @webpilot/capability-sensitive-data

Provider-boundary sensitive-data redaction that can be installed independently
from WebPilot. The package contains:

- a framework-neutral HTTP redaction client;
- an AI SDK v4 prompt adapter;
- an optional managed Node/Python GLiNER runtime;
- deterministic business/credential rules, LiquidAI PII detection, GLiNER2.5
  open-label detection, and Chinese RoBERTa boundary correction;
- scripts for installing, starting, and bundling the local runtime.

Use `createNodeSensitiveDataFilter({ getConfig })` from
`@webpilot/capability-sensitive-data/node` when the host injects configuration.
Use the root export plus `@webpilot/capability-sensitive-data/ai-sdk` when the
host supplies its own trusted redaction endpoint.

This is model middleware, not an Agent tool. It must wrap the final provider
call so system messages, user/assistant text, tool arguments, and tool results
are filtered consistently.

For TypeScript Agent frameworks other than AI SDK, call the framework-neutral
redaction client at the final model-provider boundary: transform the complete
outbound model request immediately before the provider call, and do not apply it
only to user text or individual tools. This package does not create a
`CapabilityProvider` and must not be registered as an Agent tool. See the
[TypeScript Agent framework integration guide](../capability-sdk/FRAMEWORK_INTEGRATION.md)
for its position relative to ordinary Capability packages.

## Entrypoints

- `@webpilot/capability-sensitive-data`: manifest, settings, configuration types, and portable HTTP client.
- `@webpilot/capability-sensitive-data/ai-sdk`: AI SDK prompt traversal and provider-call filter factory.
- `@webpilot/capability-sensitive-data/node`: injected filter factory and managed local runtime.

The package scripts `install-runtime`, `start-runtime`, and `bundle-runtime`
manage the optional Python runtime. A host can instead set
`GLINER_RUNTIME_MODE=external` and supply a trusted `GLINER_SERVICE_URL`.
