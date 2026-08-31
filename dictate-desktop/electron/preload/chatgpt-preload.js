const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__dictateApi', {
  invoke(channel, payload) {
    return ipcRenderer.invoke('dictate', { channel, payload });
  },
  onPush(callback) {
    ipcRenderer.on('dictate-push', (_event, data) => {
      try {
        callback(data);
      } catch (e) {
        console.warn('[Dictate] push handler error:', e);
      }
    });
  }
});
