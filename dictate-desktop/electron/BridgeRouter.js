const { buildChatGPTInjection, injectIntoWebContents } = require('./injectScripts');
const { showOverlayWindow } = require('./WindowHelper');

const DELIVER_TIMEOUT_MS = 40000;
const PING_TIMEOUT_MS = 4000;

function withTimeout(promise, ms, errorMessage) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(errorMessage)), ms);
    })
  ]);
}

class BridgeRouter {
  constructor(appState, bridgeServer = null) {
    this.appState = appState;
    this.bridgeServer = bridgeServer;
    this.chatgptInjected = false;
    this.deliverInFlight = false;
  }

  requestSendFromOverlay() {
    if (!this.bridgeServer) {
      return { success: false, error: 'Bridge server unavailable' };
    }
    this.bridgeServer.enqueueAction('sendMeetingQueue');
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

  listChatGPTFrames(wc) {
    const frames = [];
    try {
      const root = wc.mainFrame;
      if (root) frames.push(root);
      if (root?.framesInSubtree?.length) frames.push(...root.framesInSubtree);
    } catch {
      /* fall through */
    }
    return frames.length ? frames : [wc];
  }

  async findChatGPTFrame(wc, { requireInput = false } = {}) {
    const frames = this.listChatGPTFrames(wc);
    let bridgeFrame = null;
    for (const frame of frames) {
      try {
        const state = await frame.executeJavaScript(`({
          bridge: typeof window.__dictateReceiveFromTeams === "function",
          input: !!(
            document.querySelector('#prompt-textarea')
            || document.querySelector('[data-testid="prompt-textarea"]')
            || document.querySelector('form[data-type="unified-composer"]')
            || document.querySelector('[contenteditable="plaintext-only"]')
            || document.querySelector('div.ProseMirror[contenteditable="true"]')
            || document.querySelector('[role="textbox"]')
          )
        })`, true);
        if (state?.bridge && state?.input) return frame;
        if (state?.bridge && !bridgeFrame) bridgeFrame = frame;
        if (state?.input && !requireInput && state?.bridge) return frame;
      } catch {
        /* ignore frame */
      }
    }
    return bridgeFrame || frames[0] || wc;
  }

  async ensureChatGPTReady() {
    const wc = this.appState.getChatGPTWebContents();
    if (!wc) return false;

    wc.setBackgroundThrottling(false);

    const ping = async () => {
      try {
        const frame = await this.findChatGPTFrame(wc, { requireInput: false });
        const target = frame || wc;
        return await withTimeout(
          target.executeJavaScript(`
            new Promise((resolve) => {
              if (!window.chrome?.runtime?.sendMessage) return resolve(false);
              let done = false;
              const finish = (ok) => {
                if (done) return;
                done = true;
                resolve(ok);
              };
              window.chrome.runtime.sendMessage({ action: 'ping' }, (r) => finish(!!(r && r.pong)));
              setTimeout(() => finish(false), 3000);
            });
          `, true),
          PING_TIMEOUT_MS,
          'ping timed out'
        );
      } catch {
        return false;
      }
    };

    const hasReceiveBridge = async () => {
      try {
        const frame = await this.findChatGPTFrame(wc, { requireInput: false });
        const target = frame || wc;
        return await target.executeJavaScript(
          'typeof window.__dictateReceiveFromTeams === "function"',
          true
        );
      } catch {
        return false;
      }
    };

    if (!this.chatgptInjected) {
      try {
        await injectIntoWebContents(wc, buildChatGPTInjection());
        this.chatgptInjected = true;
        await new Promise((r) => setTimeout(r, 800));
      } catch (e) {
        console.warn('[Dictate] ChatGPT inject failed:', e?.message || e);
        return false;
      }
    }

    if (await ping() && await hasReceiveBridge()) return true;

    this.chatgptInjected = false;
    try {
      await injectIntoWebContents(wc, buildChatGPTInjection());
      this.chatgptInjected = true;
      await new Promise((r) => setTimeout(r, 800));
    } catch (e) {
      console.warn('[Dictate] ChatGPT re-inject failed:', e?.message || e);
      return false;
    }

    return await ping() && await hasReceiveBridge();
  }

  async deliverToChatGPTPage(text) {
    if (this.deliverInFlight) {
      return { success: false, error: 'Forward already in progress' };
    }

    this.deliverInFlight = true;

    try {
      const ready = await this.ensureChatGPTReady();
      if (!ready) {
        return { success: false, error: 'ChatGPT page not ready — sign in in the overlay' };
      }

      const wc = this.appState.getChatGPTWebContents();
      if (!wc) {
        return { success: false, error: 'ChatGPT view unavailable' };
      }

      const payload = JSON.stringify(String(text || ''));
      wc.setBackgroundThrottling(false);
      showOverlayWindow(this.appState);
      const frame = await this.findChatGPTFrame(wc, { requireInput: true });

      try {
        const result = await withTimeout(
          frame.executeJavaScript(`
            (async () => {
              const text = ${payload};
              if (typeof window.__dictateReceiveFromTeams !== 'function') {
                return { success: false, error: 'ChatGPT bridge not injected — restart Dictate Desktop' };
              }
              return await window.__dictateReceiveFromTeams(text);
            })()
          `, true),
          DELIVER_TIMEOUT_MS,
          'ChatGPT forward timed out — open a chat in the overlay'
        );

        return result;
      } catch (e) {
        return { success: false, error: e?.message || 'Forward failed' };
      }
    } finally {
      this.deliverInFlight = false;
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
    const overlay = this.appState.overlayWindow;
    if (!overlay || overlay.isDestroyed()) return;

    showOverlayWindow(this.appState);

    const error = payload?.error
      || (payload?.success === false || payload?.sent === false
        ? (payload.answer || payload.status)
        : '');
    const status = payload?.status && !payload?.streaming ? payload.status : '';
    if (!error && !status) return;

    overlay.webContents.send('overlay-data', {
      error: error || '',
      status: status || '',
      success: !error
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
        if (this.deliverInFlight) {
          return { success: false, error: 'Forward already in progress' };
        }
        return this.deliverToChatGPTPage(message.text);

      case 'relayChatGPTResponse':
        showOverlayWindow(this.appState);
        return { success: true };

      case 'claimSendQueue':
        return { success: this.bridgeServer?.tryClaimSendQueue() ?? false };

      case 'reportSendResult':
        if (this.bridgeServer) {
          this.bridgeServer.completeSendQueue();
        }
        this.appState.lastSendResult = {
          ...message,
          at: Date.now()
        };
        if (message.sent === false || message.success === false) {
          const err = message.error || message.status;
          if (err) {
            this.relayToOverlay({ error: err, success: false });
          }
        }
        return { success: true };

      default:
        return { success: false, error: `Unknown action: ${message.action}` };
    }
  }
}

module.exports = { BridgeRouter };
