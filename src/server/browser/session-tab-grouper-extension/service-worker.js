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

async function findExistingGroups(title) {
  const groups = await chrome.tabGroups.query({}).catch(() => []);
  return groups.filter((group) => group.title === title);
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

function tabSnapshot(tab) {
  return {
    tabId: tab.id,
    url: tab.url || '',
    title: tab.title || '',
    active: Boolean(tab.active),
    groupId: tab.groupId,
    windowId: tab.windowId,
  };
}

async function applySessionMarkerToTab(tab, sessionId) {
  if (!tab?.id || !sessionId) return;
  await chrome.tabs.sendMessage(tab.id, {
    type: 'apply-tab-session-marker',
    sessionId,
  }).catch(() => undefined);
}

async function findSessionGroupTabs(input) {
  const sessionId = cleanText(input?.sessionId, '');
  const groupTitle = cleanText(input?.groupTitle, sessionId ? `AI Session ${sessionId}` : 'AI Session');
  if (!sessionId) return { found: false, tabs: [] };

  const groups = await findExistingGroups(groupTitle);
  const tabs = [];
  for (const group of groups) {
    const groupTabs = await chrome.tabs.query({ groupId: group.id }).catch(() => []);
    for (const tab of groupTabs) {
      await rememberTabSession(tab, sessionId, groupTitle, group.id);
      await applySessionMarkerToTab(tab, sessionId);
      tabs.push(tabSnapshot({ ...tab, groupId: group.id }));
    }
  }
  return { found: groups.length > 0, tabs };
}

async function activateSessionGroupTab(input) {
  const lookup = await findSessionGroupTabs(input);
  const requestedTabId = Number(input?.tabId || 0);
  const target = requestedTabId
    ? lookup.tabs.find((tab) => tab.tabId === requestedTabId)
    : lookup.tabs.find((tab) => tab.active && tab.url)
      || lookup.tabs.find((tab) => tab.url && !/^chrome:\/\/new-tab-page|^about:blank|^about:newtab/i.test(tab.url))
      || lookup.tabs.at(-1);
  if (!target?.tabId) return { ok: false, lookup };

  await chrome.windows.update(target.windowId, { focused: true }).catch(() => undefined);
  const tab = await chrome.tabs.update(target.tabId, { active: true }).catch(() => undefined);
  if (tab) await applySessionMarkerToTab(tab, cleanText(input?.sessionId, ''));
  return { ok: Boolean(tab), tab: tab ? tabSnapshot(tab) : target, lookup };
}

globalThis.aiWebTestSessionTabGrouper = {
  findSessionGroupTabs,
  activateSessionGroupTab,
};

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
