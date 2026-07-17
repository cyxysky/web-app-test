const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('webPilotEmbeddedBrowserLibrary', {
  clearHistory() {
    return ipcRenderer.invoke('webpilot:embedded-browser:clear-history');
  },
  close() {
    return ipcRenderer.invoke('webpilot:embedded-browser:set-library-panel', { panel: null });
  },
  getState() {
    return ipcRenderer.invoke('webpilot:embedded-browser:get-state');
  },
  navigate(input) {
    return ipcRenderer.invoke('webpilot:embedded-browser:navigate', input);
  },
  panelReady(input) {
    return ipcRenderer.invoke('webpilot:embedded-browser:library-panel-ready', input);
  },
  onStateChange(listener) {
    if (typeof listener !== 'function') return () => {};
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('webpilot:embedded-browser:state-changed', handler);
    return () => ipcRenderer.removeListener('webpilot:embedded-browser:state-changed', handler);
  },
  removeBookmark(input) {
    return ipcRenderer.invoke('webpilot:embedded-browser:remove-bookmark', input);
  },
});
