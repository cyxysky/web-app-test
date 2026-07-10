export function snapshotHardRules() {
  return [
    '- takeSnapshot captures a Chromium accessibility-tree snapshot for the main document and every attached iframe. It is not a screenshot.',
    '- Omit cursor to capture a fresh snapshot. A nextCursor only continues the same cached snapshot and never means the page should be scrolled.',
    '- Use mode="actionable" normally, mode="full" for wider structure, and mode="text" for deduplicated accessible copy.',
    '- UIDs are valid only in the latest snapshot. After any browser-changing action, take a fresh snapshot before choosing another UID.',
    '- Use searchSnapshot to search the complete latest snapshot instead of paging blindly through a large result.',
    '- mouse and keyboard accept either one fresh UID or coordinates from the latest viewport screenshot, never both.',
    '- A UID mouse/keyboard action automatically scrolls an offscreen target into view. Do not issue a separate scroll merely to reach an existing UID.',
    '- Use mouse action="scroll" only for lazy-loaded, virtualized, or viewport-created content that is absent from the current snapshot.',
    '- If semantic evidence is missing or visual layering is ambiguous, call takeScreenshot. Only its latest viewport capture may supply x_thousandth/y_thousandth coordinates; fullPage screenshots are read-only.',
    '- Progress text must match the selected observation tool: screenshot means takeScreenshot; structured page snapshot means takeSnapshot.',
  ];
}

export function browserActionRules() {
  return [
    '- Prefer takeSnapshot -> UID -> mouse/keyboard for buttons, links, forms, tables, menus, and offscreen elements.',
    '- Use takeScreenshot -> thousandth coordinates for canvas, charts, icon-only controls, custom rendered widgets, or ambiguous overlays.',
    '- mouse unifies click, double/right/middle click, move/hover, drag, scrolling, and scrollIntoView through action/button/clickCount/destination parameters.',
    '- keyboard unifies text entry, key presses, and shortcuts. It may focus a UID or latest screenshot coordinate before typing.',
    '- When multiple visible layers contain similar actions, use a fresh viewport screenshot to identify the topmost active layer.',
  ];
}

export function currentSnapshotContextLine(browserChatMode: boolean) {
  return browserChatMode
    ? 'No live page snapshot is preloaded. Call takeSnapshot({mode:"actionable",maxChars:10000}) when browser evidence is needed.'
    : 'No initial page snapshot is included. Call takeSnapshot({mode:"actionable",maxChars:10000}) before choosing a browser UID action.';
}

export const noAutomaticScreenshotRule = '- No live screenshot is attached automatically. Models with image input can call takeScreenshot explicitly; the latest viewport screenshot enables thousandth-coordinate mouse/keyboard actions.';
