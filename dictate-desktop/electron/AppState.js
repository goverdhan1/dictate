const Store = require('electron-store');

const store = new Store({
  defaults: {
    undetectable: true,
    bridgeEnabled: true,
    autoEnableCaptions: true,
    autoForwardMode: 'questions',
    forwardPrefix: '',
    showAnswerOverlay: true,
    enabled: true
  }
});

class AppState {
  constructor() {
    this.chatgptWindow = null;
    this.overlayWindow = null;
    this.settingsWindow = null;
    this.lastForwardKey = '';
    this.lastForwardAt = 0;
    this.lastSendResult = null;
  }

  get(key) {
    return store.get(key);
  }

  set(key, value) {
    store.set(key, value);
  }

  getAll() {
    return store.store;
  }

  isUndetectable() {
    return store.get('undetectable') !== false;
  }

  setUndetectable(value) {
    store.set('undetectable', !!value);
  }
}

module.exports = { AppState, store };
