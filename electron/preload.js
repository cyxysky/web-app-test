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
  createTab(input) {
    return ipcRenderer.invoke('webpilot:embedded-browser:create-tab', input);
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
  reload() {
    return ipcRenderer.invoke('webpilot:embedded-browser:reload');
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
  setVisible(input) {
    return ipcRenderer.invoke('webpilot:embedded-browser:set-visible', input);
  },
});

contextBridge.exposeInMainWorld('webPilotSystem', {
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
  selectDirectory(input) {
    return ipcRenderer.invoke('webpilot:system:select-directory', input || {});
  },
});
