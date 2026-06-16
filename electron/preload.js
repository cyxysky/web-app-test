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
  getState() {
    return ipcRenderer.invoke('webpilot:embedded-browser:get-state');
  },
  navigate(input) {
    return ipcRenderer.invoke('webpilot:embedded-browser:navigate', input);
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
  selectDirectory(input) {
    return ipcRenderer.invoke('webpilot:system:select-directory', input || {});
  },
});
