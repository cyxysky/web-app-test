const sessionGroups = new Map();
const TAB_GROUP_ID_NONE = -1;
const TAB_SESSION_STORAGE_KEY = 'aiWebTestTabSessions';

function cleanText(value, fallback) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return (text || fallback).slice(0, 48);
}

async function findExistingGroup(windowId, title) {
  const groups = await chrome.tabGroups.query({ windowId }).catch(() => []);
  return groups.find((group) => group.title === title);
}

async function readTabSessions() {
  const value = await chrome.storage.local.get(TAB_SESSION_STORAGE_KEY).catch(() => ({}));
  const records = value?.[TAB_SESSION_STORAGE_KEY];
  return records && typeof records === 'object' && !Array.isArray(records) ? records : {};
}

async function rememberTabSession(tab, sessionId, groupTitle, groupId) {
  if (!tab?.id || !sessionId) return;
  const records = await readTabSessions();
  records[String(tab.id)] = {
    groupId,
    groupTitle,
    sessionId,
    updatedAt: Date.now(),
    windowId: tab.windowId,
  };
  await chrome.storage.local.set({ [TAB_SESSION_STORAGE_KEY]: records }).catch(() => undefined);
}

async function forgetTabSession(tabId) {
  const records = await readTabSessions();
  if (!records[String(tabId)]) return;
  delete records[String(tabId)];
  await chrome.storage.local.set({ [TAB_SESSION_STORAGE_KEY]: records }).catch(() => undefined);
}

async function storedTabSession(tab) {
  if (!tab?.id) return undefined;
  const liveTab = await chrome.tabs.get(tab.id).catch(() => tab);
  tab = { ...tab, ...liveTab };
  const records = await readTabSessions();
  const stored = records[String(tab.id)];
  if (stored?.sessionId) return stored;
  if (typeof tab.groupId === 'number' && tab.groupId !== TAB_GROUP_ID_NONE) {
    const group = await chrome.tabGroups.get(tab.groupId).catch(() => undefined);
    if (group?.title) {
      const match = Object.values(records).find((record) => record?.groupTitle === group.title && record?.sessionId);
      if (match) {
        records[String(tab.id)] = {
          ...match,
          groupId: tab.groupId,
          updatedAt: Date.now(),
          windowId: tab.windowId,
        };
        await chrome.storage.local.set({ [TAB_SESSION_STORAGE_KEY]: records }).catch(() => undefined);
        return records[String(tab.id)];
      }
    }
  }
  return undefined;
}

async function groupTab(tab, sessionId, groupTitle) {
  if (!tab?.id || !tab.windowId || !sessionId) return;
  const title = cleanText(groupTitle, `AI Session ${sessionId}`);
  const key = `${tab.windowId}:${sessionId}`;
  let groupId = sessionGroups.get(key);

  if (typeof groupId !== 'number') {
    const existing = await findExistingGroup(tab.windowId, title);
    groupId = existing?.id;
  }

  if (typeof groupId === 'number' && groupId !== TAB_GROUP_ID_NONE) {
    groupId = await chrome.tabs.group({ tabIds: tab.id, groupId }).catch(() => undefined);
  }

  if (typeof groupId !== 'number') {
    groupId = await chrome.tabs.group({
      tabIds: tab.id,
      createProperties: { windowId: tab.windowId },
    }).catch(() => undefined);
  }

  if (typeof groupId !== 'number') return;
  sessionGroups.set(key, groupId);
  await chrome.tabGroups.update(groupId, {
    title,
    color: 'cyan',
    collapsed: false,
  }).catch(() => undefined);
  await rememberTabSession(tab, sessionId, title, groupId);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tab = sender.tab;
  if (message?.type === 'get-tab-session') {
    storedTabSession(tab)
      .then((record) => sendResponse({ ok: true, record }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type !== 'group-tab') return false;
  const sessionId = cleanText(message.sessionId, '');
  const groupTitle = cleanText(message.groupTitle, sessionId ? `AI Session ${sessionId}` : 'AI Session');
  groupTab(tab, sessionId, groupTitle)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTabSession(tabId).catch(() => undefined);
});
