export function snapshotHardRules(screenshotAvailable = true) {
  return [
    '- takeSnapshot captures a lightweight DOM-observation baseline, not a screenshot.',
    '- Use mode="actionable" normally, mode="full" for wider DOM structure, and mode="text" for deduplicated rendered copy.',
    '- Browser-changing actions return an incremental DOM delta, not a full snapshot. Keep an existing dom-* UID unless that delta lists it as removed; removed UIDs are invalid immediately.',
    '- Browser-changing actions already return their incremental DOM delta. When the page may have changed outside an action, call takeSnapshot for a fresh baseline; call it again if an action delta reports overflow.',
    '- Use searchSnapshot to narrow the current DOM baseline when needed; it returns the same dom-* UID namespace as takeSnapshot. Prefer existing DOM deltas when they already contain the needed target.',
    '- Never conclude that a control or result is absent from one bounded observation. Take a fresh snapshot or screenshot when broader evidence is needed.',
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
    '- Prefer takeSnapshot -> UID -> mouse/keyboard for buttons, links, forms, tables, menus, and offscreen elements. For a native <select>, use selectOption with its UID and an exact value or label exposed in the snapshot; do not open the platform dropdown to look for DOM changes.',
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
