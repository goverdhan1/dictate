const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dictateOverlay', {
  onData(callback) {
    ipcRenderer.on('overlay-data', (_event, data) => callback(data));
  },
  hide() {
    return ipcRenderer.invoke('overlay-hide');
  },
  getCaptionMode() {
    return ipcRenderer.invoke('overlay-get-caption-mode');
  },
  openDictateMenu(x, y) {
    return ipcRenderer.invoke('overlay-dictate-menu', { x, y });
  },
  send() {
    return ipcRenderer.invoke('overlay-send');
  },
  sendScreenshot() {
    return ipcRenderer.invoke('overlay-send-screenshot');
  },
  sendContext() {
    return ipcRenderer.invoke('overlay-send-context');
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
  moveBy(dx, dy) {
    return ipcRenderer.invoke('overlay-move-by', { dx, dy });
  },
  toggleMaximize() {
    return ipcRenderer.invoke('overlay-toggle-maximize');
  },
  getWindowChrome() {
    return ipcRenderer.invoke('overlay-get-window-chrome');
  },
  setOpacity(opacity) {
    return ipcRenderer.invoke('overlay-set-opacity', { opacity });
  },
  toggleCompact() {
    return ipcRenderer.invoke('overlay-toggle-compact');
  },
  setCompact(compact) {
    return ipcRenderer.invoke('overlay-set-compact', { compact });
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
