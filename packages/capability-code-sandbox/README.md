# @webpilot/capability-code-sandbox

Bounded Python and JavaScript process execution for agents. The portable core accepts an injected executor; the Node adapter uses argument-safe child processes, a sanitized environment, a fixed workspace, output limits, timeouts, and abort handling. It is not an OS security boundary, so hosts must isolate untrusted execution with a container or remote sandbox.
