const { contextBridge, ipcRenderer } = require('electron');

function markAppShell() {
  try {
    Object.defineProperty(window, '__webPilotAppShell', {
      configurable: false,
      enumerable: false,
      value: true,
    });
  } catch {
    window.__webPilotAppShell = true;
  }

  const applyDocumentMarker = () => {
    try {
      document.documentElement?.setAttribute('data-webpilot-app-shell', 'true');
    } catch {
      // This marker is only a hint for Playwright page selection.
    }
  };

  applyDocumentMarker();
  window.addEventListener('DOMContentLoaded', applyDocumentMarker, { once: true });
}

markAppShell();

contextBridge.exposeInMainWorld('webPilotEmbeddedBrowser', {
  activateTab(input) {
    return ipcRenderer.invoke('webpilot:embedded-browser:activate-tab', input);
  },
  closeActiveTab() {
    return ipcRenderer.invoke('webpilot:embedded-browser:close-active-tab');
  },
  closeTab(input) {
    return ipcRenderer.invoke('webpilot:embedded-browser:close-tab', input);
  },
  closeGroup(input) {
    return ipcRenderer.invoke('webpilot:embedded-browser:close-group', input);
  },
  discardGroup(input) {
    return ipcRenderer.invoke('webpilot:embedded-browser:discard-group', input);
  },
  clearHistory() {
    return ipcRenderer.invoke('webpilot:embedded-browser:clear-history');
  },
  createTab(input) {
    return ipcRenderer.invoke('webpilot:embedded-browser:create-tab', input);
  },
  createGroup(input) {
    return ipcRenderer.invoke('webpilot:embedded-browser:create-group', input);
  },
  getState() {
    return ipcRenderer.invoke('webpilot:embedded-browser:get-state');
  },
  goBack() {
    return ipcRenderer.invoke('webpilot:embedded-browser:go-back');
  },
  goForward() {
    return ipcRenderer.invoke('webpilot:embedded-browser:go-forward');
  },
  navigate(input) {
    return ipcRenderer.invoke('webpilot:embedded-browser:navigate', input);
  },
  onStateChange(listener) {
    if (typeof listener !== 'function') return () => {};
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('webpilot:embedded-browser:state-changed', handler);
    return () => ipcRenderer.removeListener('webpilot:embedded-browser:state-changed', handler);
  },
  onFocusAddress(listener) {
    if (typeof listener !== 'function') return () => {};
    const handler = () => listener();
    ipcRenderer.on('webpilot:embedded-browser:focus-address', handler);
    return () => ipcRenderer.removeListener('webpilot:embedded-browser:focus-address', handler);
  },
  reload() {
    return ipcRenderer.invoke('webpilot:embedded-browser:reload');
  },
  stop() {
    return ipcRenderer.invoke('webpilot:embedded-browser:stop');
  },
  removeBookmark(input) {
    return ipcRenderer.invoke('webpilot:embedded-browser:remove-bookmark', input);
  },
  moveTab(input) {
    return ipcRenderer.invoke('webpilot:embedded-browser:move-tab', input);
  },
  reset() {
    return ipcRenderer.invoke('webpilot:embedded-browser:reset');
  },
  setBounds(bounds) {
    return ipcRenderer.invoke('webpilot:embedded-browser:set-bounds', bounds);
  },
  setGroupCollapsed(input) {
    return ipcRenderer.invoke('webpilot:embedded-browser:set-group-collapsed', input);
  },
  setLibraryPanel(input) {
    return ipcRenderer.invoke('webpilot:embedded-browser:set-library-panel', input);
  },
  toggleLibraryPanel(input) {
    return ipcRenderer.invoke('webpilot:embedded-browser:set-library-panel', { ...(input || {}), toggle: true });
  },
  setTabMuted(input) {
    return ipcRenderer.invoke('webpilot:embedded-browser:set-tab-muted', input);
  },
  showTabContextMenu(input) {
    return ipcRenderer.invoke('webpilot:embedded-browser:show-tab-context-menu', input);
  },
  setVisible(input) {
    return ipcRenderer.invoke('webpilot:embedded-browser:set-visible', input);
  },
  toggleBookmark() {
    return ipcRenderer.invoke('webpilot:embedded-browser:toggle-bookmark');
  },
});

contextBridge.exposeInMainWorld('webPilotSystem', {
  cancelDownload(input) {
    return ipcRenderer.invoke('webpilot:system:cancel-download', input || {});
  },
  chooseDownloadDirectory(input) {
    return ipcRenderer.invoke('webpilot:system:choose-download-directory', input || {});
  },
  downloadUrl(input) {
    return ipcRenderer.invoke('webpilot:system:download-url', input || {});
  },
  getDownloads() {
    return ipcRenderer.invoke('webpilot:system:get-downloads');
  },
  onDownloadProgress(listener) {
    if (typeof listener !== 'function') return () => {};
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('webpilot:system:download-progress', handler);
    return () => ipcRenderer.removeListener('webpilot:system:download-progress', handler);
  },
  onDownloadRemoved(listener) {
    if (typeof listener !== 'function') return () => {};
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('webpilot:system:download-removed', handler);
    return () => ipcRenderer.removeListener('webpilot:system:download-removed', handler);
  },
  openDownload(input) {
    return ipcRenderer.invoke('webpilot:system:open-download', input || {});
  },
  removeDownload(input) {
    return ipcRenderer.invoke('webpilot:system:remove-download', input || {});
  },
  selectDirectory(input) {
    return ipcRenderer.invoke('webpilot:system:select-directory', input || {});
  },
  showDownloadInFolder(input) {
    return ipcRenderer.invoke('webpilot:system:show-download-in-folder', input || {});
  },
});
