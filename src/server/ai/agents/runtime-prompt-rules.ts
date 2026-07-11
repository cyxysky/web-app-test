export function snapshotHardRules(screenshotAvailable = true) {
  return [
    '- takeSnapshot captures a Chromium DOMSnapshot enriched with partial accessibility data for high-value candidates. It is not a screenshot.',
    '- Omit cursor to capture a fresh snapshot. A nextCursor only continues the same cached snapshot and never means the page should be scrolled.',
    '- Use mode="actionable" normally, mode="full" for wider DOM structure, and mode="text" for deduplicated rendered copy.',
    '- UIDs are valid only in the latest snapshot. Browser-changing actions automatically return a refreshed incremental snapshot when DOM state is available; use its fresh UIDs. Call takeSnapshot when that increment is absent or insufficient.',
    '- Use searchSnapshot to search the complete latest snapshot instead of paging blindly through a large result.',
    '- Never conclude that a control or result is absent from one truncated snapshot slice. Search the complete generation first, then inspect the next cursor or screenshot when needed.',
    '- Never invent a room id, entity id, href, or navigation URL. Navigation targets and factual identifiers must come from the user, the current semantic DOM snapshot, a screenshot, or an observed network response.',
    screenshotAvailable
      ? '- mouse and keyboard accept either one fresh UID or coordinates from the latest viewport screenshot, never both.'
      : '- mouse and keyboard must use one fresh UID from the latest semantic DOM snapshot; image-coordinate targeting is unavailable.',
    '- A UID mouse/keyboard action automatically scrolls an offscreen target into view. Do not issue a separate scroll merely to reach an existing UID.',
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
      : '- When multiple layers contain similar actions, take a fresh actionable snapshot and use the UID from the current active layer.',
  ];
}

export function currentSnapshotContextLine(browserChatMode: boolean) {
  return browserChatMode
    ? 'No live page snapshot is preloaded. Call takeSnapshot({mode:"actionable",maxChars:10000}) when browser evidence is needed.'
    : 'No initial page snapshot is included. Call takeSnapshot({mode:"actionable",maxChars:10000}) before choosing a browser UID action.';
}

export function screenshotObservationRule(screenshotAvailable = true) {
  return screenshotAvailable
    ? '- No live screenshot is attached automatically. Models with image input can call takeScreenshot explicitly; the latest viewport screenshot enables thousandth-coordinate mouse/keyboard actions.'
    : '- No image observation is available in this model configuration. Use takeSnapshot and fresh UIDs for browser inspection and actions.';
}
