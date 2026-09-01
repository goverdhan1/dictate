const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dictateSettings', {
  getSettings() {
    return ipcRenderer.invoke('dictate', { channel: 'get-settings', payload: {} });
  },
  setUndetectable(value) {
    return ipcRenderer.invoke('dictate', { channel: 'set-undetectable', payload: { value } });
  },
  setSetting(key, value) {
    return ipcRenderer.invoke('dictate', { channel: 'set-setting', payload: { key, value } });
  },
  getTranscript() {
    return ipcRenderer.invoke('transcript-get');
  },
  copyTranscript() {
    return ipcRenderer.invoke('transcript-copy');
  },
  exportTranscript() {
    return ipcRenderer.invoke('transcript-export');
  },
  endTranscript() {
    return ipcRenderer.invoke('transcript-end');
  }
});
