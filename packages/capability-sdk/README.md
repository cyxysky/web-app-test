# @webpilot/capability-sdk

Framework-neutral contracts and an immutable per-run registry for executable capabilities.

This package has no dependency on Orbit, AI SDK, MCP, React, Next.js, Playwright, or a persistence implementation.

`CapabilityProvider`, `CapabilityManifest`, `CapabilityTool`,
`CapabilityResult`, and `CapabilityRunSnapshot` are the portable boundary for
all TypeScript Agent frameworks. A framework adapter maps each resolved tool's
name, description, JSON Schema, parser, execution function, policy, and result
to its native tool abstraction.

For the complete registration, Skill, execution, and lifecycle contract, see
the [TypeScript Agent framework integration guide](./FRAMEWORK_INTEGRATION.md).

`createCapabilityExecutor({ authorize, prerequisite, reportProgress })` provides shared execution policy handling for adapters. Authorization callbacks belong to the host; serial groups are enforced per executor. Mounted snapshots expose their combined `abortSignal`. Disposal is idempotent, aborts and waits for active tool invocations, then closes providers in reverse mount order. Cleanup failures are aggregated; supply `onDisposeError` to handle them explicitly. Node-only persistence and cancellable process helpers are exported from `@webpilot/capability-sdk/node`.
