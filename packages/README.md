# Capability packages

Each folder is an independently versioned and publishable npm package. Concrete
capabilities do not import WebPilot application code or an agent framework.

| Package | Responsibility |
| --- | --- |
| `@webpilot/capability-sdk` | Framework-neutral contracts and per-run registry |
| `@webpilot/capability-adapter-ai-sdk` | AI SDK tool adapter |
| `@webpilot/capability-adapter-mcp` | Official MCP SDK adapter for stdio and Streamable HTTP |
| `@webpilot/capability-browser` | Playwright sessions, browser kernel, snapshots, runtime and MCP server |
| `@webpilot/capability-chart` | ECharts API, persistence, React rendering and MCP server |
| `@webpilot/capability-file` | File/Office workspace, workers, validation, preview and MCP server |

Local development uses npm workspaces and the TypeScript path mappings in the
root `tsconfig.json`, so edits under `packages/` are consumed directly.

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
