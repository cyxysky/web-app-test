# Browser snapshot and input architecture

The browser agent uses a snapshot-first protocol modeled after modern accessibility-tree browser tools. The old HTML-like DOM observation and per-action tool set are not part of the model contract.

## Observation

`takeSnapshot` captures Chromium's accessibility tree with CDP for the main document and every frame in the current frame tree. It returns one of three semantic views:

- `actionable`: controls plus the minimum useful structural context.
- `full`: all meaningful accessibility nodes.
- `text`: deduplicated accessible text.

Every line uses a short-lived `uid`:

```text
uid=17 button "Save"
uid=18 textbox "Name" value="Alice" required=true
```

The output does not contain redundant `data-ai-*` attributes or an interactive marker. A snapshot is paged by whole records at 10,000 characters by default. `nextCursor` continues the same cached generation and never scrolls the page.

`searchSnapshot` searches the complete latest cached generation, so the model does not need to page through a large tree merely to find a known label or role.

### Frames and fallback

CDP capture is attempted for every frame concurrently. If Chromium cannot expose an AX tree for a frame, a lightweight Playwright-frame traversal supplies semantic text and actionable controls. This traversal:

- enters every attached iframe and open shadow root;
- immediately prunes a subtree when the current element has `display:none`;
- ignores `script`, `style`, and other non-semantic content by selecting meaningful nodes rather than serializing HTML;
- treats accessible SVG controls through their AX role/name and only uses the DOM fallback when AX data is unavailable.

## Input

The model-facing input surface is deliberately small:

- `mouse`: `click`, `move`, `drag`, `scroll`, and `scrollIntoView` selected by `action`; mouse button, click count, and drag destination are parameters.
- `keyboard`: `type`, `press`, and `shortcut` selected by `action`.

There is no separate select or drag tool. Native selects are operated through the same mouse and keyboard primitives used by a real user.

Both tools accept either:

1. a fresh snapshot `uid`; or
2. thousandth coordinates from the latest viewport screenshot.

A UID operation calls CDP `DOM.scrollIntoViewIfNeeded`, resolves the current content quad, and performs the action in one tool call. This keeps offscreen elements discoverable without pretending that they are already visible and avoids an extra model-driven scroll step.

`takeScreenshot` is the visual fallback for canvas, charts, ambiguous overlays, and custom rendering. Only the latest `viewport` screenshot can be used for coordinates; `fullPage` screenshots are evidence only. Any browser-changing action invalidates both the current UID generation and coordinate screenshot.

## Runtime rules

- Start with `takeSnapshot({ mode: "actionable", maxChars: 10000 })` for semantic UI.
- Use `searchSnapshot` for a known target in a large snapshot.
- Use a UID directly; the executor reveals offscreen targets internally.
- Use `takeScreenshot` plus coordinates only when semantic evidence is insufficient.
- Capture a fresh snapshot after every browser-changing action.
- `takeSnapshot` is structure, while `takeScreenshot` is pixels; progress text must not confuse them.

## Debug export

The settings page's snapshot test browser exports `actionable`, `full`, and `text` from one generation into a JSON file. Every view is split into whole-record chunks of at most 10,000 characters.
