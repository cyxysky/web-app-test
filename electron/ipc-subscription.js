function subscribeIpc(ipcRenderer, channel, listener, valueFromArguments = (_event, value) => value) {
  if (typeof listener !== 'function') return () => {};
  const handler = (...args) => listener(valueFromArguments(...args));
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

module.exports = { subscribeIpc };
