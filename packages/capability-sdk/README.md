# @webpilot/capability-sdk

Framework-neutral contracts and an immutable per-run registry for executable capabilities.

This package has no dependency on WebPilot, AI SDK, MCP, React, Next.js, Playwright, or a persistence implementation.

`CapabilityProvider`, `CapabilityManifest`, `CapabilityTool`,
`CapabilityResult`, and `CapabilityRunSnapshot` are the portable boundary for
all TypeScript Agent frameworks. A framework adapter maps each resolved tool's
name, description, JSON Schema, parser, execution function, policy, and result
to its native tool abstraction.

For the complete registration, Skill, execution, and lifecycle contract, see
the [TypeScript Agent framework integration guide](./FRAMEWORK_INTEGRATION.md).
