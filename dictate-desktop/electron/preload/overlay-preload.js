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
  resizeBy(dx, dy) {
    return ipcRenderer.invoke('overlay-resize-by', { dx, dy });
  }
});
