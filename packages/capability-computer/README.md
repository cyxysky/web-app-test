# @webpilot/capability-computer

Desktop observation and input contracts for agents. On Windows, enabling the
capability is enough: the Node adapter lazily starts a loopback-only driver,
creates an in-memory Bearer credential, and reuses that driver for the process.
No endpoint or token setup is required.

The built-in driver runs in the current interactive Windows user session and
supports screenshots, mouse input, keyboard chords, Unicode text input,
scrolling, and waits without third-party runtime dependencies. Locked desktops
and Windows Session 0 services cannot provide interactive computer control.

```ts
import { createNodeComputerCapability } from '@webpilot/capability-computer/node';

const computer = createNodeComputerCapability();
```

Set `AGENT_COMPUTER_ENABLED=true`, or enable **Computer control** in the host's
settings. A host may pass `screenshotDirectory` when screenshots should be
published from an application-owned artifact directory; otherwise the package
uses an isolated temporary directory.

The model-facing `computer` tool uses normalized click coordinates: `x=0` is
the left edge, `x=1000` is the right edge, `y=0` is the top edge, and `y=1000`
is the bottom edge of the latest screenshot. The capability converts those
values back to physical display pixels before calling the driver. This keeps
clicks aligned when an AI provider resizes an image before visual inference.

## Remote driver protocol

`AGENT_COMPUTER_ENDPOINT` is an optional advanced override for deployments that
provide a different desktop host. It is not an RDP/VNC URL and is not the URL
that the agent should browse. The adapter sends one action per request:

- `HEAD <endpoint>` is the health check and must return a 2xx response.
- `POST <endpoint>` receives JSON and must return a JSON object.
- `AGENT_COMPUTER_AUTHORIZATION`, when set, is forwarded verbatim as the
  `Authorization` header. A typical value is `Bearer <token>`.

Example request:

```json
{
  "action": "click",
  "reason": "Activate the control visible in the latest observation",
  "x": 120,
  "y": 240,
  "button": "left",
  "clickCount": 1,
  "timeoutMs": 30000
}
```

The HTTP driver boundary receives physical pixel coordinates. Coordinate
normalization is handled by the capability tool before this request is sent,
so existing desktop-driver implementations do not need to implement image
scaling themselves.

Supported actions are `observe`, `screenshot`, `click`, `type`, `key`,
`scroll`, and `wait`. An observation response can include `displayId`, `width`,
`height`, `activeWindow`, `elements`, `sequence`, and a published screenshot's
`artifactId` and `mediaType`. A remote driver can instead return
`screenshotBase64` with `mediaType`; the Node capability validates and writes
the image into its configured screenshot directory before publishing it as
capability image content.

External endpoint and authorization overrides are startup settings. The
automatically managed built-in endpoint and credential are never exposed as
user settings.
