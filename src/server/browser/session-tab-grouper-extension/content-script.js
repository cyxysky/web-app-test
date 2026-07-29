const SESSION_ID_ATTRIBUTE = 'data-ai-web-test-session-group-id';
const SESSION_TITLE_ATTRIBUTE = 'data-ai-web-test-session-group-title';
const GROUPED_ID_ATTRIBUTE = 'data-ai-web-test-session-grouped-id';

let groupedKey = '';
let pendingGroupKey = '';
let pendingGroupPromise;

function cleanMarkerText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function markerFromDocument() {
  const root = document.documentElement;
  const sessionId = cleanMarkerText(root?.getAttribute(SESSION_ID_ATTRIBUTE));
  if (!sessionId) return undefined;
  return {
    sessionId,
    groupTitle: cleanMarkerText(root?.getAttribute(SESSION_TITLE_ATTRIBUTE)) || sessionId,
  };
}

function markGrouped(sessionId) {
  if (document.documentElement?.getAttribute(GROUPED_ID_ATTRIBUTE) !== sessionId) {
    document.documentElement?.setAttribute(GROUPED_ID_ATTRIBUTE, sessionId);
  }
}

function groupCurrentTab(sessionId, groupTitle) {
  const cleanSessionId = cleanMarkerText(sessionId);
  if (!cleanSessionId) return Promise.resolve(false);
  const cleanGroupTitle = cleanMarkerText(groupTitle) || cleanSessionId;
  const key = `${cleanSessionId}:${cleanGroupTitle}`;
  if (groupedKey === key) {
    markGrouped(cleanSessionId);
    return Promise.resolve(true);
  }
  if (pendingGroupKey === key && pendingGroupPromise) return pendingGroupPromise;

  pendingGroupKey = key;
  pendingGroupPromise = Promise.resolve(chrome.runtime.sendMessage({
    type: 'group-tab',
    sessionId: cleanSessionId,
    groupTitle: cleanGroupTitle,
  })).then((result) => {
    if (!result?.ok) return false;
    groupedKey = key;
    markGrouped(cleanSessionId);
    return true;
  }).catch(() => false).finally(() => {
    if (pendingGroupKey === key) {
      pendingGroupKey = '';
      pendingGroupPromise = undefined;
    }
  });
  return pendingGroupPromise;
}

function injectSessionMarker(sessionId, groupTitle) {
  const cleanSessionId = cleanMarkerText(sessionId);
  if (!cleanSessionId) return;
  const cleanGroupTitle = cleanMarkerText(groupTitle) || cleanSessionId;
  if (document.documentElement?.getAttribute(SESSION_ID_ATTRIBUTE) !== cleanSessionId) {
    document.documentElement?.setAttribute(SESSION_ID_ATTRIBUTE, cleanSessionId);
  }
  if (document.documentElement?.getAttribute(SESSION_TITLE_ATTRIBUTE) !== cleanGroupTitle) {
    document.documentElement?.setAttribute(SESSION_TITLE_ATTRIBUTE, cleanGroupTitle);
  }
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
    window.addEventListener('DOMContentLoaded', () => injectSessionMarker(cleanSessionId, cleanGroupTitle), { once: true });
  } else {
    parent.appendChild(script);
    script.remove();
  }
  void groupCurrentTab(cleanSessionId, cleanGroupTitle);
}

function groupFromDocumentMarker() {
  const marker = markerFromDocument();
  if (marker) void groupCurrentTab(marker.sessionId, marker.groupTitle);
}

function requestStoredSessionMarker() {
  try {
    const response = chrome.runtime.sendMessage({ type: 'get-tab-session' });
    if (response && typeof response.then === 'function') {
      response.then((result) => {
        const record = result?.record;
        injectSessionMarker(record?.sessionId, record?.groupTitle);
      }).catch(() => undefined);
    }
  } catch {
    // Restoring the marker is best-effort; Playwright can still operate the page.
  }
}

const markerObserver = new MutationObserver(groupFromDocumentMarker);
let observedDocumentElement;
function observeDocumentMarker() {
  const root = document.documentElement;
  if (!root || root === observedDocumentElement) return;
  observedDocumentElement = root;
  markerObserver.disconnect();
  markerObserver.observe(root, {
    attributeFilter: [SESSION_ID_ATTRIBUTE, SESSION_TITLE_ATTRIBUTE],
    attributes: true,
  });
  groupFromDocumentMarker();
}
new MutationObserver(observeDocumentMarker).observe(document, { childList: true });
observeDocumentMarker();
requestStoredSessionMarker();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'apply-tab-session-marker') return false;
  injectSessionMarker(message.sessionId, message.groupTitle);
  sendResponse({ ok: true });
  return false;
});

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const message = event.data;
  if (!message || message.source !== 'AI_WEB_TEST_SESSION_TAB_GROUP') return;
  if (message.type !== 'group-tab') return;
  injectSessionMarker(message.sessionId, message.groupTitle);
});
