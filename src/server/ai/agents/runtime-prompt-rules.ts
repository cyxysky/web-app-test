export function snapshotHardRules(screenshotAvailable = true) {
  return [
    '- takeSnapshot captures a lightweight DOM-observation baseline, not a screenshot.',
    '- Use mode="full" by default for the complete loaded semantic DOM. mode="text" is the deduplicated reading view of ALL text from that same complete full DOM, including offscreen text; it is never limited to the current viewport. Use mode="changes" only for the persistent inter-action journal of observed DOM additions, updates, removals, and request summaries; changes has no interactive UIDs and does not replace the current DOM baseline.',
    '- Browser-changing actions return an incremental DOM delta, not a full snapshot. Keep an existing dom-* UID unless that delta lists it as removed; removed UIDs are invalid immediately.',
    '- Browser-changing actions already return their immediate incremental DOM delta. For delayed toasts, asynchronous UI updates, or requests that happened between tools, call takeSnapshot({mode:"changes"}); use getHttpRequests with the listed request IDs when request details are needed.',
    '- A takeSnapshot result with nextCursor is only one character page of an already frozen DOM result. Continue with the same mode and exact cursor; never scroll for snapshot pagination. The cursor stays valid across searchSnapshot, waiting, and arbitrary asynchronous DOM mutations, and is invalidated only by a browser interaction that may affect the UI or by an explicit fresh takeSnapshot.',
    '- If an action result says "Post-action form validation failed" or domChanges.extra.validationErrors is non-empty, the requested operation failed. State the validation error, correct the named field, and do not continue or report success until it is resolved.',
    '- Use searchSnapshot to narrow the current frozen DOM baseline when needed; it returns the same dom-* UID namespace as takeSnapshot and is a pure read that never scrolls, consumes the mutation queue, or changes snapshot pagination. Prefer existing DOM deltas when they already contain the needed target.',
    '- Never conclude that a control or result is absent from one bounded observation. Take a fresh snapshot or screenshot when broader evidence is needed.',
    '- Never invent a room id, entity id, href, or navigation URL. Navigation targets and factual identifiers must come from the user, the current semantic DOM snapshot, a screenshot, or an observed network response.',
    screenshotAvailable
      ? '- mouse and keyboard accept either one fresh UID or coordinates from the latest viewport screenshot, never both.'
      : '- mouse and keyboard must use one fresh UID from the latest semantic DOM snapshot; image-coordinate targeting is unavailable.',
    '- A UID mouse/keyboard action automatically scrolls an offscreen target into view. Do not issue a separate scroll merely to reach an existing UID.',
    '- domChanges.overflow means only that the MutationObserver change queue exceeded its capacity. It NEVER means there is more page content below and must never cause a "scroll to bottom" instruction, including in child-Agent tasks.',
    '- Use mouse action="scroll" only for lazy-loaded, virtualized, or viewport-created content that is absent from the current snapshot.',
    screenshotAvailable
      ? '- If semantic evidence is missing or visual layering is ambiguous, call takeScreenshot. Only its latest viewport capture may supply x_thousandth/y_thousandth coordinates; fullPage screenshots are read-only.'
      : '- When browser evidence is needed, call takeSnapshot and operate only on UIDs returned by its latest result.',
    screenshotAvailable
      ? '- Progress text must match the selected observation tool: screenshot means takeScreenshot; structured page snapshot means takeSnapshot.'
      : '- Describe takeSnapshot as a structured semantic DOM snapshot, not as an image or screenshot.',
  ];
}

export function browserActionRules(screenshotAvailable = true) {
  return [
    '- Native HTML <select> hard rule: you MUST call selectOption directly with the select UID and an exact option value or full visible label from the snapshot. Never click the select first, never use keyboard letters/ArrowUp/ArrowDown/Enter to choose, and never inspect the platform dropdown for DOM changes.',
    '- Prefer takeSnapshot -> UID -> mouse/keyboard for buttons, links, forms, tables, menus, and offscreen elements.',
    screenshotAvailable
      ? '- Use takeScreenshot -> thousandth coordinates for canvas, charts, icon-only controls, custom rendered widgets, or ambiguous overlays.'
      : '- Use only fresh semantic-snapshot UIDs for pointer and keyboard actions; do not invent image coordinates.',
    '- mouse unifies click, double/right/middle click, move/hover, drag, scrolling, and scrollIntoView through action/button/clickCount/destination parameters.',
    screenshotAvailable
      ? '- keyboard unifies text entry, key presses, and shortcuts. It may focus a UID or latest screenshot coordinate before typing.'
      : '- keyboard unifies text entry, key presses, and shortcuts. Focus targets only with a fresh UID.',
    screenshotAvailable
      ? '- When multiple visible layers contain similar actions, use a fresh viewport screenshot to identify the topmost active layer.'
      : '- When multiple layers contain similar actions, take a fresh full snapshot and use the UID from the current active layer.',
  ];
}

export function currentSnapshotContextLine(browserChatMode: boolean) {
  return browserChatMode
    ? 'No live page snapshot is preloaded. Call takeSnapshot({mode:"full"}) when browser evidence is needed.'
    : 'No initial page snapshot is included. Call takeSnapshot({mode:"full"}) before choosing a browser UID action.';
}

export function screenshotObservationRule(screenshotAvailable = true) {
  return screenshotAvailable
    ? '- No live screenshot is attached automatically. Models with image input can call takeScreenshot explicitly; the latest viewport screenshot enables thousandth-coordinate mouse/keyboard actions.'
    : '- No image observation is available in this model configuration. Use takeSnapshot and fresh UIDs for browser inspection and actions.';
}
