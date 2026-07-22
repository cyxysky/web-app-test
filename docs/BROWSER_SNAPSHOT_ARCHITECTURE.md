# Browser Code Architecture

## Model-facing surface

The model has one browser inspection and operation tool: `browserCode`.

The tool accepts one ordinary JavaScript cell. A persistent Node-backed kernel connects to the current browser through Playwright and binds the real Playwright `page` and `context` objects. Cells use top-level statements and top-level `await`, keep bindings across calls, and emit structured output with `nodeRepl.write(value)`. They are not functions or ES modules. Execution has no startup, preparation, action, navigation, or whole-cell deadline and ends only on explicit abort or session close. There is no locator facade, UID resolver, snapshot reference, RPC operation switch, or compatibility forwarding layer.

`page.locator(...)`, `page.getByRole(...)`, `page.keyboard`, `page.mouse`, and `context.pages()` are ordinary Playwright APIs used inside the submitted JavaScript. They are not separate Agent tools.

For DOM-only logic, the program can call `page.evaluate(...)`; that callback runs in the browser page VM. The surrounding program runs in the isolated Node process.

## Isolation and limits

Each call has a whole-program timeout, process memory limits, bounded serialized output, execution logs, and pre-execution risk analysis for actions that may affect external systems or sensitive data. The process starts with Node permissions enabled, no filesystem write access, read access only to the packaged Playwright modules, no child-process or nested-worker permission, and a sanitized environment. The submitted program receives only `page`, `context`, and the bounded console in its VM scope.

The process connects to the exact active page using a one-time execution marker. Browser sessions launched by WebPilot expose a private Playwright or loopback CDP endpoint for this connection; externally connected and Electron-embedded sessions reuse their existing CDP endpoint.

## Independent capabilities

`takeScreenshot`, `readFile`, user confirmation, and subagents remain independent capabilities. Screenshots provide pixel evidence, file reading handles local artifacts, confirmation carries user authority, and subagents provide parallel work. Structured page inspection and every browser operation belong in `browserCode`.

`takeSnapshot`, `searchSnapshot`, `page.uid(...)`, and the old granular browser action tools are not part of the model-facing protocol.
