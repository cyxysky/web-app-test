# Browser snapshot and input architecture

The browser agent uses a DOMSnapshot-first protocol with selective accessibility enrichment. A full AX tree is only a capture-failure fallback; it is not the normal model-facing representation.

## Observation

`takeSnapshot` calls CDP `DOMSnapshot.captureSnapshot` for the main document, flattened shadow DOM, and every captured frame. It requests a small computed-style whitelist, layout rectangles, clickability, input state, and paint order. Only ranked actionable candidates are enriched with `Accessibility.getPartialAXTree(fetchRelatives=false)`. It returns one of three semantic views:

- `actionable`: controls plus the minimum useful structural context.
- `full`: meaningful DOM controls, content, and structural nodes.
- `text`: deduplicated rendered text.

Actionable lines use a short-lived `uid`:

```text
uid=17 button "Save"
uid=18 textbox "Name" value="Alice" required=true
```

The output does not contain redundant `data-ai-*` attributes or an interactive marker. Snapshot records are flattened and slices remove hierarchy indentation for compact reading. A snapshot is paged by whole records at 20,000 characters by default. `nextCursor` continues the same cached generation and never scrolls the page.

`searchSnapshot` searches the complete latest cached generation, so the model does not need to page through a large tree merely to find a known label or role.

The actionable view preserves the original flattened DOMSnapshot order within each captured frame. It includes actionable nodes plus bounded structural context, but does not re-rank controls by role, text, or viewport position. Descendant text is assigned to its nearest actionable/card ancestor, nested pointer targets for the same entity are collapsed, and container text is bounded. Focusability is represented as `actions=focus`; it is not automatically treated as clickability, and structural focusable list/table nodes are excluded from the fallback action set.

### Frames, enrichment, and fallback

DOMSnapshot supplies the primary flattened DOM/layout model. Candidate names are derived from `aria-labelledby`, `aria-label`, associated labels, alt text, descendant rendered text, value, placeholder, title, and name metadata. Partial AX then replaces or augments role, computed accessible name, value, and widget state for ranked candidates. A lightweight Playwright-frame traversal remains a final supplement for runtime-specific controls that DOMSnapshot misses. When an actionable target has no readable accessible name, its output keeps the element's actual `class` and up to four nested SVG class descriptors (for example `icon=svg.icon-Filter-Fill`), then adds reliable nearby context without guessing the icon's purpose. The pipeline:

- enters every attached iframe and open shadow root;
- immediately prunes a subtree when the current element has `display:none`;
- ignores `script`, `style`, and other non-semantic content by selecting meaningful nodes rather than serializing HTML;
- de-duplicates a synthetic same-page DOM document before serialization;
- preserves class evidence for bare unlabeled SVG controls, rather than inventing an action name.

## Input

The model-facing input surface is deliberately small:

- `mouse`: `click`, `move`, `drag`, `scroll`, and `scrollIntoView` selected by `action`; mouse button, click count, and drag destination are parameters.
- `keyboard`: `type`, `press`, and `shortcut` selected by `action`.

There is no separate select or drag tool. Native selects are operated through the same mouse and keyboard primitives used by a real user.

Both tools accept either:

1. a fresh snapshot `uid`; or
2. thousandth coordinates from the latest viewport screenshot.

A UID operation resolves a unique Playwright accessibility locator, scrolls it into view, verifies visibility, enabled state, and top-layer hit testing, then performs the action in one tool call. Move uses locator hover, click preserves button and click count, and drag follows a real pointer path with an HTML5 `DataTransfer` fallback. Coordinate drag resolves its source and destination with `elementFromPoint` and uses the same fallback, so custom HTML5 drop zones receive a populated transfer object in either targeting mode. Keyboard typing explicitly focuses the target and emits the normal keydown/keypress/input/keyup sequence. CDP content quads remain the fallback for AX nodes without a unique locator.

Every input result includes a post-action check. Mouse checks use delivered browser-event counts plus hover, scroll-offset, drop, focus, popup, and navigation evidence as appropriate. Keyboard checks verify key/input events and editable-value changes. A mechanically undelivered action returns `ok=false` even when Playwright itself did not throw. The mouse and keyboard schemas live in one shared module and are consumed by both runtime executors.

`takeScreenshot` is the visual fallback for canvas, charts, ambiguous overlays, and custom rendering. Only the latest `viewport` screenshot can be used for coordinates; `fullPage` screenshots are evidence only.

Browser actions automatically maintain the semantic DOM snapshot through one page-state epoch, without classifying actions by invalidation level. An injected `MutationObserver` advances the epoch for DOM, text, and relevant attribute changes, while interaction listeners cover focus, keyboard, input, hover, scroll, click, and drag/drop state that may affect the actionable view without an immediate DOM mutation. Interaction counts remain exact for post-action verification, while synchronous event bursts are microtask-coalesced into one epoch increment. After every action, the generation refreshes only when that epoch changed and is otherwise reused. Screenshot coordinates are invalidated after every action. The action result exposes the current generation and a compact change view, so a separate `takeSnapshot` call is needed only when the increment is insufficient.

## Runtime rules

- Start with `takeSnapshot({ mode: "actionable", maxChars: 20000 })` for semantic UI.
- Use `searchSnapshot` for a known target in a large snapshot.
- Use a UID directly; the executor reveals offscreen targets internally.
- Use `takeScreenshot` plus coordinates only when semantic evidence is insufficient.
- Use the incremental snapshot returned after a browser action. Capture a separate fresh snapshot only when the returned changes do not contain enough evidence for the next decision.
- `takeSnapshot` is structure, while `takeScreenshot` is pixels; progress text must not confuse them.

## Debug export

The settings page's snapshot test browser exports `actionable`, `full`, and `text` from one generation into a JSON file (`version: 4`, `chromium-dom-snapshot-with-partial-ax`). Every view is split into whole-record chunks of at most 20,000 characters, and the aggregate `content` field joins those chunks for direct inspection.
