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

Pass this provider to `mountCapabilities()`, map the resolved `computer` tool to
the native tool type of the consuming TypeScript Agent framework, and inject the
package Skill before the first desktop action. The host remains responsible for
approval of input actions and for forwarding image content to models that
support it. See the complete
[TypeScript Agent framework integration guide](../capability-sdk/FRAMEWORK_INTEGRATION.md).

Set `AGENT_COMPUTER_ENABLED=true`, or enable **Computer control** in the host's
settings. A host may pass `screenshotDirectory` when screenshots should be
published from an application-owned artifact directory; otherwise the package
uses an isolated temporary directory.

The model-facing `computer` tool returns the exact saved screenshot width and
height. Click coordinates are direct pixels in that latest screenshot: `(0, 0)`
is the top-left pixel and `(width - 1, height - 1)` is the bottom-right pixel.
No normalized-coordinate conversion is performed before calling the driver.
The tool rejects coordinates outside the latest screenshot bounds.

On Windows, observations also discover foreground-window elements. Native UI
Automation is preferred, with Windows desktop icons discovered through their
legacy accessibility objects. When an application exposes no actionable
controls, the built-in driver falls back to Windows OCR and generic
visual-region detection. Each element includes a current-screenshot `bounds`, `center`, and
ephemeral `elementId`. Pass that id to `action: "click"` instead of estimating
coordinates. The capability resolves the id to physical pixels and invalidates
the element map after the action.

For named desktop or Start-menu applications, use `action: "launch"` with the
visible shortcut name. This avoids locating an application icon by image
coordinates when Windows already provides a stable application identity.

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

Element-based click request:

```json
{
  "action": "click",
  "reason": "Activate the exact Login element returned by the latest observation",
  "elementId": "visual:1788494725746:0",
  "button": "left",
  "clickCount": 1
}
```

The HTTP driver boundary receives the same screenshot pixel coordinates supplied
by the model. The Node adapter derives observation width and height from the
persisted PNG or JPEG bytes so the returned dimensions describe the actual
image, even if a remote driver supplied stale metadata.

`observe` already captures and attaches one fresh screenshot; there is no
separate duplicate screenshot action. Supported actions are `observe`,
`launch`, `click`, `type`, `key`,
`scroll`, and `wait`. An observation response can include `displayId`, `width`,
`height`, `activeWindow`, `elements`, `sequence`, and a published screenshot's
`artifactId` and `mediaType`. A remote driver can instead return
`screenshotBase64` with `mediaType`; the Node capability validates and writes
the image into its configured screenshot directory before publishing it as
capability image content.

External endpoint and authorization overrides are startup settings. The
automatically managed built-in endpoint and credential are never exposed as
user settings.
