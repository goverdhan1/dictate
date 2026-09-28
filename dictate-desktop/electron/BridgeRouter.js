const { clipboard } = require('electron');
const { buildChatGPTInjection, injectIntoWebContents } = require('./injectScripts');
const { showOverlayWindow } = require('./WindowHelper');
const { readClipboardSnapshot, restoreClipboard } = require('./screenCapture');
const {
  buildPrimeOnlyMessage,
  buildScreenshotPrompt,
  contextNeedsPrime,
  prepareAgentMessage,
  readContextState
} = require('./aiContext');

const DELIVER_TIMEOUT_MS = 40000;
const PING_TIMEOUT_MS = 4000;

function agentName(appState) {
  return appState?.getAgent?.()?.name || 'ChatGPT';
}

function withTimeout(promise, ms, errorMessage) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(errorMessage)), ms);
    })
  ]);
}

class BridgeRouter {
  constructor(appState, bridgeServer = null, transcriptStore = null) {
    this.appState = appState;
    this.bridgeServer = bridgeServer;
    this.transcriptStore = transcriptStore;
    this.chatgptInjected = false;
    this.deliverInFlight = false;
    this.contextPrimeInFlight = false;
    this.contextPrimeFailedAt = 0;
  }

  async sendSavedContextOnce() {
    if (this.contextPrimeInFlight || this.deliverInFlight) return { success: false, skipped: true };
    if (this.contextPrimeFailedAt && Date.now() - this.contextPrimeFailedAt < 60000) {
      return { success: false, skipped: true };
    }
    const state = readContextState(this.appState);
    if (!contextNeedsPrime(state)) return { success: true, skipped: true };
    const message = buildPrimeOnlyMessage(state);
    if (!message) return { success: false, skipped: true };

    this.contextPrimeInFlight = true;
    try {
      const result = await this.forwardToChatGPT(message, { raw: true, markApplied: true });
      if (result?.success) {
        this.contextPrimeFailedAt = 0;
        this.relayToOverlay({
          status: `Sent your resume, job description, and instructions to ${agentName(this.appState)}`
        });
      } else {
        this.contextPrimeFailedAt = Date.now();
      }
      return result;
    } finally {
      this.contextPrimeInFlight = false;
    }
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
            || document.querySelector('[contenteditable="true"]')
            || document.querySelector('div.ProseMirror[contenteditable="true"]')
            || document.querySelector('[role="textbox"]')
            || document.querySelector('textarea')
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
        await injectIntoWebContents(wc, buildChatGPTInjection(agentName(this.appState)));
        this.chatgptInjected = true;
        await new Promise((r) => setTimeout(r, 800));
      } catch (e) {
        console.warn(`[Dictate] ${agentName(this.appState)} inject failed:`, e?.message || e);
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
      console.warn(`[Dictate] ${agentName(this.appState)} re-inject failed:`, e?.message || e);
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
        return { success: false, error: `${agentName(this.appState)} is not ready — sign in in the overlay` };
      }

      const wc = this.appState.getChatGPTWebContents();
      if (!wc) {
        return { success: false, error: `${agentName(this.appState)} view unavailable` };
      }

      const body = String(text || '');
      const usePaste = body.length >= 1200;
      wc.setBackgroundThrottling(false);
      showOverlayWindow(this.appState);
      const frame = await this.findChatGPTFrame(wc, { requireInput: true });
      let clip = null;

      try {
        if (usePaste) {
          clip = readClipboardSnapshot();
          await frame.executeJavaScript(`(() => {
            try { window.__dictateSuppressComposerWatch?.(); } catch (e) {}
            try { window.__dictateFocusComposer?.(); } catch (e) {}
            return true;
          })()`, true);
          clipboard.writeText(body);
          try { wc.focus(); } catch { /* ignore */ }
          wc.paste();
        }

        const fastScript = usePaste
          ? `(async () => {
              if (typeof window.__dictateSubmitPasted === 'function') {
                return await window.__dictateSubmitPasted(${body.length});
              }
              return { success: false, error: 'paste-empty' };
            })()`
          : `(async () => {
              const text = ${JSON.stringify(body)};
              if (typeof window.__dictateReceiveFromTeams !== 'function') {
                return { success: false, error: 'Agent bridge not injected — restart Dictate Desktop' };
              }
              return await window.__dictateReceiveFromTeams(text);
            })()`;

        let result = await withTimeout(
          frame.executeJavaScript(fastScript, true),
          DELIVER_TIMEOUT_MS,
          `${agentName(this.appState)} forward timed out — open a chat in the overlay`
        );

        if (usePaste && result?.error === 'paste-empty') {
          result = await withTimeout(
            frame.executeJavaScript(`
              (async () => {
                if (typeof window.__dictateReceiveFromTeams !== 'function') {
                  return { success: false, error: 'Agent bridge not injected — restart Dictate Desktop' };
                }
                return await window.__dictateReceiveFromTeams(${JSON.stringify(body)});
              })()
            `, true),
            DELIVER_TIMEOUT_MS,
            `${agentName(this.appState)} forward timed out — open a chat in the overlay`
          );
        }

        return result;
      } catch (e) {
        return { success: false, error: e?.message || 'Forward failed' };
      } finally {
        if (clip) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          restoreClipboard(clip);
        }
      }
    } finally {
      this.deliverInFlight = false;
    }
  }

  async forwardToChatGPT(text, options = {}) {
    let outgoing = String(text || '');
    let priming = false;
    if (!options.raw) {
      const prepared = prepareAgentMessage(readContextState(this.appState), outgoing);
      outgoing = prepared.text;
      priming = prepared.priming;
    }
    if (!outgoing.trim()) return { success: false, error: 'Nothing to send' };

    const now = Date.now();
    if (outgoing === this.appState.lastForwardKey && now - this.appState.lastForwardAt < 2500) {
      return { success: false, error: 'Already sending that text' };
    }

    this.appState.lastForwardKey = outgoing;
    this.appState.lastForwardAt = now;

    const result = await this.deliverToChatGPTPage(outgoing);
    if (result?.success && (priming || options.markApplied)) {
      this.appState.markAiContextApplied?.();
    }
    if (!result?.success) {
      console.warn(`[Dictate] forwardToChatGPT failed:`, result?.error || result);
    }
    return result;
  }

  async forwardScreenshot(payload) {
    if (this.deliverInFlight) {
      return { success: false, error: 'Forward already in progress' };
    }
    if (!payload?.image || !payload.base64) {
      return { success: false, error: 'Could not capture the screen' };
    }

    this.deliverInFlight = true;
    const snap = readClipboardSnapshot();
    let frame = null;

    try {
      const ready = await this.ensureChatGPTReady();
      if (!ready) {
        return { success: false, error: `${agentName(this.appState)} is not ready — sign in in the overlay` };
      }

      const wc = this.appState.getChatGPTWebContents();
      if (!wc) {
        return { success: false, error: `${agentName(this.appState)} view unavailable` };
      }

      wc.setBackgroundThrottling(false);
      showOverlayWindow(this.appState);
      frame = await this.findChatGPTFrame(wc, { requireInput: true });
      const shotPrompt = buildScreenshotPrompt(readContextState(this.appState));

      const before = await frame.executeJavaScript(`(() => {
        try { window.__dictateSuppressComposerWatch?.(); } catch (e) {}
        try { window.__dictateFocusComposer?.(); } catch (e) {}
        return typeof window.__dictateScreenshotAttachmentCount === 'function'
          ? window.__dictateScreenshotAttachmentCount()
          : 0;
      })()`, true);

      clipboard.writeImage(payload.image);
      try { wc.focus(); } catch { /* ignore */ }
      wc.paste();

      const result = await withTimeout(
        frame.executeJavaScript(`
          (async () => {
            if (typeof window.__dictateReceiveScreenshot !== 'function') {
              return { success: false, error: 'Screenshot bridge not injected — restart Dictate Desktop' };
            }
            return await window.__dictateReceiveScreenshot(
              ${JSON.stringify(payload.base64)},
              ${JSON.stringify(payload.mime || 'image/jpeg')},
              ${Number(before) || 0},
              ${JSON.stringify(shotPrompt.prompt || '')}
            );
          })()
        `, true),
        50000,
        `${agentName(this.appState)} screenshot timed out — open a chat in the overlay`
      );

      if (result?.success && shotPrompt.priming) {
        this.appState.markAiContextApplied?.();
      }
      if (!result?.success) {
        console.warn('[Dictate] forwardScreenshot failed:', result?.error || result);
      }
      return result || { success: false, error: 'Screenshot send failed' };
    } catch (e) {
      try {
        if (frame) {
          await frame.executeJavaScript('window.__dictateReleaseComposerWatch?.()', true);
        }
      } catch {
        /* ignore */
      }
      const error = e?.message || 'Screenshot send failed';
      console.warn('[Dictate] forwardScreenshot failed:', error);
      return { success: false, error };
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 400));
      restoreClipboard(snap);
      this.deliverInFlight = false;
    }
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
    const meetingId = payload?.meetingId || '';
    const meetingIdDisplay = payload?.meetingIdDisplay || '';
    if (!error && !status && !meetingId) return;

    overlay.webContents.send('overlay-data', {
      error: error || '',
      status: status || '',
      success: !error,
      joinUrl: payload?.joinUrl || '',
      joinLabel: payload?.joinLabel || '',
      meetingId,
      meetingIdDisplay
    });
  }

  async handleRuntimeMessage(message) {
    if (!message?.action) return { success: false, error: 'empty action' };

    switch (message.action) {
      case 'ping':
        return { success: true, pong: true };

      case 'showOverlay':
        if (typeof this.onShowOverlay === 'function') {
          this.onShowOverlay();
        } else {
          showOverlayWindow(this.appState);
        }
        return { success: true };

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

      case 'rememberSelfName':
        this.appState.rememberMeetingSelfName?.(message.name, message.platform);
        return { success: true };

      case 'appendTranscript':
        if (this.transcriptStore && message.line) {
          this.transcriptStore.append(message.line);
        }
        return { success: true };

      case 'markTranscriptSent':
        if (this.transcriptStore) {
          const entries = message.lines || (message.line ? [message.line] : []);
          this.transcriptStore.markSent(entries);
        }
        return { success: true };

      case 'getTranscript': {
        if (!this.transcriptStore) {
          return { success: false, text: '', count: 0 };
        }
        const current = this.transcriptStore.getCurrent();
        return {
          success: true,
          text: this.transcriptStore.formatText(),
          count: current.lines.length,
          startedAt: current.startedAt,
          platform: current.platform
        };
      }

      case 'endTranscript': {
        if (!this.transcriptStore) return { success: false, error: 'Transcript unavailable' };
        const current = this.transcriptStore.getCurrent();
        if (!current.lines.length) return { success: false, error: 'No captions to save' };
        return this.transcriptStore.endCall();
      }

      case 'claimSendQueue':
        return { success: this.bridgeServer?.tryClaimSendQueue() ?? false };

      case 'ackPendingPayload':
        return {
          success: this.bridgeServer?.ackPendingPayload({
            id: message.id,
            name: message.name || message.actionName
          }) ?? false
        };

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
            this.relayToOverlay({
              error: err,
              success: false,
              joinUrl: message.joinUrl,
              joinLabel: message.joinLabel
            });
          }
        }
        return { success: true };

      default:
        return { success: false, error: `Unknown action: ${message.action}` };
    }
  }
}

module.exports = { BridgeRouter };
