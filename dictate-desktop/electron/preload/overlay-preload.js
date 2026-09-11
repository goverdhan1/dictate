const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dictateOverlay', {
  onData(callback) {
    ipcRenderer.on('overlay-data', (_event, data) => callback(data));
  },
  hide() {
    return ipcRenderer.invoke('overlay-hide');
  },
  send() {
    return ipcRenderer.invoke('overlay-send');
  },
  copyTranscript() {
    return ipcRenderer.invoke('transcript-copy');
  },
  openUrl(url) {
    return ipcRenderer.invoke('overlay-open-url', { url });
  },
  resolveJoin() {
    return ipcRenderer.invoke('overlay-resolve-join');
  },
  resizeBy(dx, dy) {
    return ipcRenderer.invoke('overlay-resize-by', { dx, dy });
  },
  getUndetectable() {
    return ipcRenderer.invoke('overlay-get-undetectable');
  },
  setUndetectable(value) {
    return ipcRenderer.invoke('overlay-set-undetectable', { value });
  },
  openSettings() {
    return ipcRenderer.invoke('overlay-open-settings');
  },
  getAgent() {
    return ipcRenderer.invoke('overlay-get-agent');
  },
  setAgent(id) {
    return ipcRenderer.invoke('overlay-set-agent', { id });
  }
});
