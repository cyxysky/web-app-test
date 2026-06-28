export function domObservationHardRules() {
  return [
    '- If the page may have changed or you need fresh DOM/text/screenshot evidence, call getPageState explicitly. The backend will not silently refresh page state between model calls.',
    '- After getPageState in DOM mode, inspect full content with readObservation(type,offset,maxChars). Use type="text" for hierarchical page text or type="interactive" for hierarchical visible actionable elements without coordinates. maxChars values below 10000 are raised to 10000.',
  ];
}

export function domModeActionRules() {
  return [
    '- DOM mode getPageState has two readObservation views: text for hierarchical page text, and interactive for hierarchical visible interactive elements without coordinates.',
    '- getPageState returns only a summary and refreshes the current observation; call readObservation(type="text"|"interactive", offset, maxChars) to inspect full content.',
    '- getPageState text/interactive content does not invent numeric node_id attributes. Use visible interactive elements and plain text to identify targets.',
    '- For normal DOM-mode clicking/filling, prefer clickCandidate(id,targetVisual,text?) using a fresh #id from the latest hierarchical interactive elements list, especially for unlabeled icon-only controls.',
    '- Use findByText(targetText) then clickLocator(locatorId,text?) only for text-accessible targets when a candidate #id is unavailable.',
    '- For hover-only menus in DOM mode, use hierarchical text/interactive evidence to choose a supported hover/candidate path, then call getPageState before choosing a revealed target.',
    '- Use scrollArea only when interaction requires changing the visual viewport or lazy-loaded content is absent from the text/interactive context. After scrolling or any browser-changing action, call getPageState before using new ids or locators.',
    '- Before scrollArea, check the latest area summary/result: do not scroll down when atBottom or remainingDown=0, and do not scroll up when atTop or remainingUp=0.',
    '- visualAfter defaults to {capture:"auto", retention:"replace"}. Use retention:"append" only when the next turn must compare with or continue from the previous state.',
  ];
}

export function domCurrentContextLine(browserChatMode: boolean) {
  return browserChatMode
    ? 'No DOM/page observation or tool result is preloaded in the initial messages. In DOM mode, call getPageState when fresh URL, tabs, focus, scroll state, DOM snapshot, or page text is needed.'
    : 'No initial DOM page observation is included. Call getPageState for fresh URL, tabs, focus, scroll state, DOM snapshot, and page text.';
}

export const domNoScreenshotRule = '- DOM mode: no screenshot image/path is attached. Use getPageState to refresh the current observation, then readObservation for hierarchical text/interactive elements. Use clickCandidate with a current #id from the interactive list for visible controls, or findByText/clickLocator for text-accessible recovery.';
