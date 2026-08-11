# WorkflowAgent durability prototype

This prototype is intentionally isolated from the production browser-chat path. It validates the durable orchestration boundary before any live `BrowserSession`, Playwright `Page`, or Electron `BrowserView` is moved into a workflow.

## What it proves

- `WorkflowAgent` can cross durable model/tool step boundaries.
- A workflow-level Hook can suspend without keeping the original HTTP request or Run object alive.
- A later caller can recover the run by `runId`, resolve the human-approval Hook, and continue the same workflow to completion.
- The model instance crossing a step boundary has explicit Workflow serialization instead of relying on live process objects.

Run the focused integration test with:

```bash
npm run test:workflow
```

The test uses a deterministic model and never opens a browser or calls the configured production model.

## Restart boundary

The integration test deliberately discards the original Run handle and reacquires it through `getRun(runId)` before approval. This exercises persisted run rehydration and delayed approval.

The Workflow SDK Local World stores event data on disk, but its queue is in memory and is not a production restart guarantee. A real server-process restart test must run the same workflow against a persistent production World, such as Postgres World, then terminate and restart the worker while the approval Hook is pending. Do not connect the browser-chat production path until that deployment-level test passes.

## Browser migration prerequisites

Only serializable identifiers may cross workflow steps: `sessionId`, `profileKey`, `tabId`, `approvalId`, snapshot IDs, and trace IDs. Live browser objects must be reacquired inside step functions. Browser-changing steps must also be idempotent or carry a durable operation key so a retry cannot repeat a submit, delete, payment, authorization, or external send.
