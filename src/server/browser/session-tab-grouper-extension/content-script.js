function injectSessionMarker(sessionId) {
  const cleanSessionId = String(sessionId || '').trim();
  if (!cleanSessionId) return;
  document.documentElement?.setAttribute('data-ai-web-test-session-group-id', cleanSessionId);
  const script = document.createElement('script');
  script.textContent = `
    (() => {
      const sessionId = ${JSON.stringify(cleanSessionId)};
      Object.defineProperty(window, '__aiWebTestSessionGroupId', {
        configurable: true,
        enumerable: false,
        value: sessionId,
        writable: true,
      });
      const marker = 'AI_WEB_TEST_SESSION_GROUP:' + sessionId + ';';
      const previous = String(window.name || '').replace(/^AI_WEB_TEST_SESSION_GROUP:[^;]*;/, '');
      window.name = marker + previous;
    })();
  `;
  const parent = document.documentElement || document.head || document.body;
  if (!parent) {
    window.addEventListener('DOMContentLoaded', () => injectSessionMarker(cleanSessionId), { once: true });
    return;
  }
  parent.appendChild(script);
  script.remove();
}

function requestStoredSessionMarker() {
  try {
    const response = chrome.runtime.sendMessage({ type: 'get-tab-session' });
    if (response && typeof response.then === 'function') {
      response.then((result) => injectSessionMarker(result?.record?.sessionId)).catch(() => undefined);
    }
  } catch {
    // Restoring the marker is best-effort; Playwright can still operate the page.
  }
}

requestStoredSessionMarker();

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const message = event.data;
  if (!message || message.source !== 'AI_WEB_TEST_SESSION_TAB_GROUP') return;
  if (message.type !== 'group-tab') return;

  try {
    injectSessionMarker(message.sessionId);
    const response = chrome.runtime.sendMessage({
      type: 'group-tab',
      sessionId: String(message.sessionId || ''),
      groupTitle: String(message.groupTitle || ''),
    });
    if (response && typeof response.catch === 'function') response.catch(() => undefined);
  } catch {
    // Tab grouping is a browser-chrome enhancement; page automation must continue if it is unavailable.
  }
});
