const { contextBridge, ipcRenderer } = require('electron');
const { subscribeIpc } = require('./ipc-subscription');

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
  onStateChange(listener) {
    return subscribeIpc(ipcRenderer, 'webpilot:embedded-browser:state-changed', listener);
  },
  removeBookmark(input) {
    return ipcRenderer.invoke('webpilot:embedded-browser:remove-bookmark', input);
  },
});
