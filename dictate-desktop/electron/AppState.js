const Store = require('electron-store');
const { DEFAULT_PROVIDER_ID, getProvider } = require('./aiProviders');

const store = new Store({
  defaults: {
    undetectable: true,
    bridgeEnabled: true,
    autoEnableCaptions: true,
    autoForwardMode: 'off',
    showAnswerOverlay: true,
    enabled: true,
    agentProvider: DEFAULT_PROVIDER_ID
  }
});

class AppState {
  constructor() {
    this.chatgptWebContents = null;
    this.overlayWindow = null;
    this.settingsWindow = null;
    this.lastForwardKey = '';
    this.lastForwardAt = 0;
    this.lastSendResult = null;
    // Undetectable Mode is always on when the app starts (Teams/Zoom capture exclusion).
    this.setUndetectable(true);
    // Meeting→ChatGPT bridge is always on; captions go via manual Send only.
    this.set('bridgeEnabled', true);
    this.set('autoForwardMode', 'off');
    store.delete('forwardPrefix');
  }

  get(key) {
    return store.get(key);
  }

  set(key, value) {
    store.set(key, value);
  }

  getAll() {
    return {
      ...store.store,
      undetectable: this.isUndetectable(),
      agentProvider: this.getAgentProvider()
    };
  }

  getAgentProvider() {
    return getProvider(store.get('agentProvider')).id;
  }

  getAgent() {
    return getProvider(this.getAgentProvider());
  }

  setAgentProvider(id) {
    const provider = getProvider(id);
    store.set('agentProvider', provider.id);
    return provider;
  }

  isUndetectable() {
    return store.get('undetectable') !== false;
  }

  setUndetectable(value) {
    store.set('undetectable', !!value);
  }

  getChatGPTWebContents() {
    const wc = this.chatgptWebContents;
    if (!wc || wc.isDestroyed()) return null;
    return wc;
  }
}

module.exports = { AppState, store };
