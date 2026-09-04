# Capability packages

Each folder is an independently versioned and publishable npm package. Concrete
capability cores do not import WebPilot application code; framework-specific
dependencies are isolated behind explicit adapter entrypoints.

## TypeScript Agent framework integration

The primary integration path is framework-neutral:

```text
CapabilityProvider -> mountCapabilities() -> runtime tools and Skills -> Agent framework adapter
```

Any TypeScript Agent framework can register these packages by mapping the
resolved JSON Schema tools to its native tool type. AI SDK and MCP are optional
ready-made adapters, not the only supported runtimes. See the complete
[TypeScript Agent framework integration guide](./capability-sdk/FRAMEWORK_INTEGRATION.md)
for provider creation, mounting, tool conversion, Skill injection, execution,
policy enforcement, result handling, and disposal.

| Package | Responsibility |
| --- | --- |
| `@webpilot/capability-sdk` | Framework-neutral contracts and per-run registry |
| `@webpilot/capability-host` | Unified configuration stores, provider mounting and Skill catalog |
| `@webpilot/capability-adapter-ai-sdk` | AI SDK tool adapter |
| `@webpilot/capability-adapter-mcp` | Official MCP SDK adapter for stdio and Streamable HTTP |
| `@webpilot/capability-browser` | Playwright sessions, browser kernel, snapshots, runtime and MCP server |
| `@webpilot/capability-chart` | ECharts API, persistence, React rendering and MCP server |
| `@webpilot/capability-file` | File/Office workspace, workers, validation, preview and MCP server |
| `@webpilot/capability-code-sandbox` | Bounded JavaScript/Python execution with replaceable sandbox backends |
| `@webpilot/capability-research` | Provenance-preserving public search and document fetching |
| `@webpilot/capability-connectors` | MCP Streamable HTTP, OpenAPI and custom external connectors |
| `@webpilot/capability-knowledge` | Durable document ingestion and knowledge retrieval |
| `@webpilot/capability-data` | Structured source discovery and bounded SQL querying |
| `@webpilot/capability-media` | OCR, transcription, frame extraction and image-generation contracts |
| `@webpilot/capability-communication` | Draft-first outbound communication channels |
| `@webpilot/capability-git` | Bounded Git inspection and explicitly enabled repository writes |
| `@webpilot/capability-computer` | Desktop observation and input through host-selected drivers |
| `@webpilot/capability-workflow` | Durable dependency-aware workflows and checkpoints |
| `@webpilot/capability-sensitive-data` | Provider-boundary redaction, AI SDK adapter, local GLiNER runtime and packaging scripts |

Local development uses npm workspaces and the TypeScript path mappings in the
root `tsconfig.json`, so edits under `packages/` are consumed directly.

Every concrete package owns its public settings and Skills through its
`CapabilityManifest`. `@webpilot/capability-host` loads stored values, applies
package defaults, builds one configuration object per Capability id, and
injects it through `CapabilityRunContext.configuration`. It includes memory,
environment, JSON-file and TypeORM storage adapters; TypeORM uses the same
Repository implementation for SQLite and PostgreSQL. Skills use one
`CapabilitySkill` shape for every TypeScript Agent framework integration.
Concrete capability packages publish their Skills but never load or gate them during a capability
call. The consuming Agent host owns Skill preloading and tool availability. A
custom framework can adapt `CapabilityRunSnapshot.tools` directly; the AI SDK
adapter exposes one-call mounting with eager or lazy Skill context, while MCP
mounts the same providers and config store directly.

Cloud images use exact published npm versions by building with:

```sh
docker build --build-arg WEBPILOT_CAPABILITY_SOURCE=npm .
```

That mode removes only the workspace Capability links from the image manifest
and lockfile, resolves their exact application versions from npm, preserves the
rest of the lockfile, and uses `tsconfig.npm.json` so package imports resolve
from `node_modules`.

Publish dependency order is enforced by `npm run capabilities:publish`: SDK,
framework adapters, then concrete capabilities. Use
`npm run capabilities:publish:dry-run` to inspect package contents first.

The repository deliberately keeps the default Docker build on `workspace` so a
fresh clone remains buildable before a release exists. Cloud release pipelines
must pass `--build-arg WEBPILOT_CAPABILITY_SOURCE=npm`; local source changes are
then excluded from resolution and `tsconfig.npm.json` resolves the same imports
from `node_modules`.
