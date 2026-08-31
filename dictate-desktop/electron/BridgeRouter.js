const { buildChatGPTInjection, injectIntoWebContents } = require('./injectScripts');

class BridgeRouter {
  constructor(appState, bridgeServer = null) {
    this.appState = appState;
    this.bridgeServer = bridgeServer;
    this.chatgptInjected = false;
  }

  requestSendFromOverlay() {
    if (!this.bridgeServer) {
      return { success: false, error: 'Bridge server unavailable' };
    }
    this.bridgeServer.enqueueAction('sendTeamsQueue');
    return { success: true, queued: true };
  }

  handleStorageGet(keys) {
    const defaults = this.appState.getAll();
    if (!keys || typeof keys !== 'object') return defaults;
    const out = {};
    for (const [k, defaultVal] of Object.entries(keys)) {
      out[k] = this.appState.get(k) ?? defaultVal;
    }
    return out;
  }

  handleStorageSet(data) {
    if (!data || typeof data !== 'object') return { success: true };
    for (const [k, v] of Object.entries(data)) {
      this.appState.set(k, v);
    }
    return { success: true };
  }

  async ensureChatGPTReady() {
    const win = this.appState.chatgptWindow;
    if (!win || win.isDestroyed()) return false;

    win.webContents.setBackgroundThrottling(false);

    const ping = async () => {
      try {
        return await win.webContents.executeJavaScript(`
          new Promise((resolve) => {
            if (!window.chrome?.runtime?.sendMessage) return resolve(false);
            window.chrome.runtime.sendMessage({ action: 'ping' }, (r) => resolve(!!(r && r.pong)));
          });
        `, true);
      } catch {
        return false;
      }
    };

    if (!this.chatgptInjected) {
      try {
        await injectIntoWebContents(win.webContents, buildChatGPTInjection());
        this.chatgptInjected = true;
        await new Promise((r) => setTimeout(r, 800));
      } catch (e) {
        console.warn('[Dictate] ChatGPT inject failed:', e?.message || e);
        return false;
      }
    }

    if (await ping()) return true;

    this.chatgptInjected = false;
    try {
      await injectIntoWebContents(win.webContents, buildChatGPTInjection());
      this.chatgptInjected = true;
      await new Promise((r) => setTimeout(r, 800));
    } catch (e) {
      console.warn('[Dictate] ChatGPT re-inject failed:', e?.message || e);
      return false;
    }

    return ping();
  }

  async deliverToChatGPTPage(text) {
    const ready = await this.ensureChatGPTReady();
    if (!ready) {
      return { success: false, error: 'ChatGPT page not ready — sign in in Dictate Desktop' };
    }

    const win = this.appState.chatgptWindow;
    const payload = JSON.stringify(String(text || ''));
    const wasVisible = win.isVisible();
    win.webContents.setBackgroundThrottling(false);
    if (!wasVisible) win.showInactive();

    try {
      const result = await win.webContents.executeJavaScript(`
        (async () => {
          if (typeof window.__dictateReceiveFromTeams === 'function') {
            return await window.__dictateReceiveFromTeams(${payload});
          }
          return new Promise((resolve) => {
            window.chrome.runtime.sendMessage(
              { action: 'receiveFromTeams', text: ${payload} },
              (r) => resolve(r || { success: false, error: 'No response from ChatGPT bridge' })
            );
          });
        })()
      `, true);

      if (result?.success) {
        this.relayToOverlay({
          question: String(text || '').slice(0, 400),
          answer: 'Waiting for ChatGPT…',
          streaming: true
        });
      }

      return result;
    } catch (e) {
      return { success: false, error: e?.message || 'Forward failed' };
    } finally {
      if (!wasVisible) {
        setTimeout(() => {
          if (!win.isDestroyed()) win.hide();
        }, 800);
      }
    }
  }

  async forwardToChatGPT(text) {
    const key = String(text || '');
    const now = Date.now();
    if (key && key === this.appState.lastForwardKey && now - this.appState.lastForwardAt < 2500) {
      return { success: false, error: 'Already sending that text' };
    }

    this.appState.lastForwardKey = key;
    this.appState.lastForwardAt = now;

    const result = await this.deliverToChatGPTPage(text);
    if (!result?.success) {
      console.warn('[Dictate] forwardToChatGPT failed:', result?.error || result);
    }
    return result;
  }

  relayToOverlay(payload) {
    if (this.appState.get('showAnswerOverlay') === false) return;
    const overlay = this.appState.overlayWindow;
    if (!overlay || overlay.isDestroyed()) return;

    overlay.setOpacity(0);
    overlay.show();
    setTimeout(() => overlay.setOpacity(1), 50);

    overlay.webContents.send('overlay-data', {
      question: payload.question || '',
      answer: payload.answer || '',
      streaming: payload.streaming === true
    });
  }

  async handleRuntimeMessage(message) {
    if (!message?.action) return { success: false, error: 'empty action' };

    switch (message.action) {
      case 'ping':
        return { success: true, pong: true };

      case 'storage-get':
        return this.handleStorageGet(message.keys);

      case 'storage-set':
        return this.handleStorageSet(message.data);

      case 'forwardToChatGPT':
        return this.forwardToChatGPT(message.text);

      case 'receiveFromTeams':
        return this.deliverToChatGPTPage(message.text);

      case 'relayChatGPTResponse':
        this.relayToOverlay(message);
        return { success: true };

      case 'reportSendResult':
        this.appState.lastSendResult = {
          ...message,
          at: Date.now()
        };
        if (message.sent === false || message.success === false) {
          const err = message.error || message.status;
          if (err) {
            this.relayToOverlay({ answer: err, streaming: false });
          }
        }
        return { success: true };

      default:
        return { success: false, error: `Unknown action: ${message.action}` };
    }
  }
}

module.exports = { BridgeRouter };
