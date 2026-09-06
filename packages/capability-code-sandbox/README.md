# @webpilot/capability-code-sandbox

Bounded Python and JavaScript execution for agents. The portable core accepts
an injected executor. The local Node adapter is only for trusted single-machine
development; production deployments should use the HTTP runner in
`Dockerfile.code-sandbox`.

## TypeScript Agent framework integration

```ts
import { createNodeCodeSandboxCapability } from '@webpilot/capability-code-sandbox/node';

const provider = createNodeCodeSandboxCapability({
  workspaceDirectory: './agent-workspaces/code',
});
```

Register this provider with `mountCapabilities()`, expose the resolved
`codeSandbox` tool through the consuming framework, and inject the package Skill
before execution.

The tool accepts exact-version dependencies through `packages`, for example
`lodash@4.17.21` or `requests==2.32.3`. JavaScript dependencies are installed
with npm lifecycle scripts disabled; Python dependencies are installed into a
disposable target directory. The host must enforce the declared process,
network, and workspace policy in addition to the package's bounded runner.

## Production runner

Build and start the isolated runner beside the Orbit service:

```sh
docker compose up -d --build
```

Set `CODE_SANDBOX_RUNNER_TOKEN` to a long random value. The runner has no
Orbit artifacts or application environment mounted, runs as a non-root user,
uses a read-only root filesystem, and has container-level CPU, memory, process,
and temporary-space limits. Its outbound network is enabled so code and package
installation can use the network. This is intentionally full outbound network
access, not a domain allowlist; add an egress proxy/firewall before exposing
the runner to untrusted tenants. Use the `local` backend only in a trusted
development environment.
