export function domObservationHardRules() {
  return [
    '- If the page may have changed or you need fresh DOM/text/screenshot evidence, call getPageState explicitly. The backend will not silently refresh page state between model calls.',
    '- After getPageState in DOM mode, inspect Node-processed content with readObservation(type,offset,maxChars). Use type="text" for plain page text or type="interactive" for actionable DOM node_id entries. maxChars values below 10000 are raised to 10000.',
  ];
}

export function domModeActionRules() {
  return [
    '- DOM mode getPageState has two readObservation views generated on the Node backend from the browser DOM tree: text for plain page text, and interactive for actionable node_id entries.',
    '- getPageState returns only a summary and refreshes the current observation; call readObservation(type="text"|"interactive", offset, maxChars) to inspect full content.',
    '- For normal DOM-mode clicking/filling/hovering, use clickDomNode/fillDomNodes/hoverDomNode with a fresh node_id from readObservation(type="interactive").',
    '- Use findByText(targetText) then clickLocator(locatorId,text?) only as recovery when a node_id target is unavailable or unreliable.',
    '- For hover-only menus in DOM mode, use current text/interactive node_id evidence to choose a supported hover path, then call getPageState before choosing a revealed target.',
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

export const domNoScreenshotRule = '- DOM mode: no screenshot image/path is attached. Use getPageState to collect the DOM tree into Node and refresh the stored observation, then readObservation(type="text"|"interactive") for Node-processed page text and actionable node_id entries. Use clickDomNode/fillDomNodes/hoverDomNode with a current node_id, or findByText/clickLocator only for text-accessible recovery.';
