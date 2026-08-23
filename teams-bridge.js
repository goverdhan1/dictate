(function () {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  const CAPTION_SELECTORS = {
    list: "[data-tid='closed-caption-v2-virtual-list-content']",
    text: "[data-tid='closed-caption-text']",
    author: "[data-tid='author']"
  };

  let bridgeActive = false;
  let captionObserver = null;
  let recognition = null;
  let seenCaptions = new Set();
  let lastForwarded = '';
  let lastCaption = { author: '', text: '' };
  let forwardTimer = null;
  let captionEnableTimer = null;

  const CAPTIONS_UI = {
    moreBtn: '[data-tid="callingButtons-showMoreBtn"], #callingButtons-showMoreBtn',
    renderer: "[data-tid='closed-captions-renderer']"
  };

  function log(...args) {
    console.log('[Teams→ChatGPT]', ...args);
  }

  async function getSettings() {
    try {
      const data = await chrome.storage.local.get({
        bridgeEnabled: true,
        autoEnableCaptions: true,
        autoForwardMode: 'questions',
        autoForwardQuestions: true,
        forwardPrefix: 'Answer this meeting question: '
      });
      // Backward compatibility with older checkbox setting
      if (data.autoForwardMode == null) {
        data.autoForwardMode = data.autoForwardQuestions === false ? 'off' : 'questions';
      }
      return data;
    } catch (e) {
      return {
        bridgeEnabled: true,
        autoEnableCaptions: true,
        autoForwardMode: 'questions',
        forwardPrefix: 'Answer this meeting question: '
      };
    }
  }

  function updateStatus(text) {
    const el = document.getElementById('teams-chatgpt-status');
    if (el) el.textContent = text;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function walkShadowRoots(root, fn) {
    const direct = fn(root);
    if (direct) return direct;
    const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of nodes) {
      if (el.shadowRoot) {
        const found = walkShadowRoots(el.shadowRoot, fn);
        if (found) return found;
      }
    }
    return null;
  }

  function queryAllDeep(selector, root = document) {
    const results = [];
    function walk(r) {
      if (!r.querySelectorAll) return;
      r.querySelectorAll(selector).forEach((el) => results.push(el));
      r.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) walk(el.shadowRoot);
      });
    }
    walk(root);
    return results;
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function clickElement(el) {
    if (!el) return false;
    try {
      el.focus?.();
      const opts = { bubbles: true, cancelable: true, view: window, composed: true };
      el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse' }));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse' }));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
      if (typeof el.click === 'function') el.click();
      return true;
    } catch (e) {
      log('Click failed', e);
      return false;
    }
  }

  function elementLabel(el) {
    return (el?.textContent || el?.getAttribute?.('aria-label') || '').replace(/\s+/g, ' ').trim();
  }

  function isCaptionsEnabled() {
    if (document.querySelector(CAPTION_SELECTORS.list)) return true;
    if (queryAllDeep(CAPTIONS_UI.renderer).some(isVisible)) return true;
    if (queryAllDeep(CAPTION_SELECTORS.text).some(isVisible)) return true;
    return false;
  }

  function findMoreButton() {
    return walkShadowRoots(document, (root) => {
      for (const sel of CAPTIONS_UI.moreBtn.split(',').map((s) => s.trim())) {
        const el = root.querySelector(sel);
        if (isVisible(el)) return el;
      }
      return null;
    });
  }

  function findCaptionMenuItem() {
    const candidates = queryAllDeep('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], button, [data-tid*="caption" i]');
    const enableRe = /(show|turn on|enable|start)\s+(live\s+)?captions?|live\s+captions?\s+on/i;
    const disableRe = /(hide|turn off|disable|stop)\s+(live\s+)?captions?|live\s+captions?\s+off/i;

    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const label = elementLabel(el);
      if (!label || disableRe.test(label)) continue;
      if (enableRe.test(label) || (/caption/i.test(label) && !disableRe.test(label))) {
        return el;
      }
    }
    return null;
  }

  function findLanguageSpeechMenuItem() {
    const candidates = queryAllDeep('[role="menuitem"], [role="menuitemradio"], button');
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const label = elementLabel(el);
      if (/language and speech|language & speech/i.test(label)) return el;
    }
    return null;
  }

  async function enableLiveCaptions() {
    if (isCaptionsEnabled()) {
      log('Live captions already enabled');
      return true;
    }

    const moreBtn = findMoreButton();
    if (!moreBtn) {
      log('More actions button not found (join a meeting first)');
      return false;
    }

    log('Opening More actions to enable live captions');
    clickElement(moreBtn);
    await sleep(900);

    let captionsBtn = findCaptionMenuItem();
    if (!captionsBtn) {
      const langMenu = findLanguageSpeechMenuItem();
      if (langMenu) {
        log('Opening Language and speech submenu');
        clickElement(langMenu);
        await sleep(700);
        captionsBtn = findCaptionMenuItem();
      }
    }

    if (!captionsBtn) {
      log('Live captions menu item not found');
      clickElement(moreBtn);
      return false;
    }

    log('Clicking:', elementLabel(captionsBtn));
    clickElement(captionsBtn);
    await sleep(1200);

    if (isCaptionsEnabled()) {
      log('Live captions enabled');
      return true;
    }

    log('Captions click sent; waiting for caption panel');
    return false;
  }

  async function enableLiveCaptionsWithRetry(maxAttempts = 6, intervalMs = 2000) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (isCaptionsEnabled()) return true;

      updateStatus(`Enabling live captions (${attempt}/${maxAttempts})…`);
      const clicked = await enableLiveCaptions();
      if (clicked || isCaptionsEnabled()) return true;

      if (attempt < maxAttempts) await sleep(intervalMs);
    }
    return isCaptionsEnabled();
  }

  function stopCaptionEnableRetry() {
    if (captionEnableTimer) {
      clearInterval(captionEnableTimer);
      captionEnableTimer = null;
    }
  }

  function startCaptionEnableRetry() {
    stopCaptionEnableRetry();
    let attempts = 0;
    captionEnableTimer = setInterval(async () => {
      if (!bridgeActive || isCaptionsEnabled() || attempts >= 8) {
        stopCaptionEnableRetry();
        return;
      }
      attempts++;
      await enableLiveCaptions();
    }, 3000);
  }

  function formatMessage(_source, author, text) {
    return author ? `${author}: ${text}` : text;
  }

  function shouldAutoForward(text, settings) {
    const trimmed = text.trim();
    if (!trimmed || settings.autoForwardMode === 'off') return false;

    if (settings.autoForwardMode === 'questions') {
      return /\?\s*$/.test(trimmed);
    }

    if (settings.autoForwardMode === 'sentences') {
      return /[.!?]\s*$/.test(trimmed) && trimmed.length >= 8;
    }

    return false;
  }

  function scheduleForward(source, author, text, delayMs = 800) {
    clearTimeout(forwardTimer);
    forwardTimer = setTimeout(() => forwardToChatGPT(source, author, text), delayMs);
  }

  async function forwardToChatGPT(source, author, text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return;

    const settings = await getSettings();
    if (!settings.bridgeEnabled) return;

    const payload = settings.forwardPrefix
      ? settings.forwardPrefix + formatMessage(source, author, trimmed)
      : formatMessage(source, author, trimmed);

    if (payload === lastForwarded) return;
    lastForwarded = payload;

    updateStatus('Sending to ChatGPT…');
    log('Forwarding:', payload);

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'forwardToChatGPT',
        text: payload
      });
      if (response?.success) {
        updateStatus('Sent to ChatGPT');
      } else {
        updateStatus(response?.error || 'ChatGPT tab not ready');
      }
    } catch (e) {
      log('Forward failed:', e);
      updateStatus('Could not reach ChatGPT');
    }
  }

  function scanCaptions() {
    if (!bridgeActive) return;

    const nodes = document.querySelectorAll(CAPTION_SELECTORS.text);
    for (const node of nodes) {
      const text = (node.textContent || '').trim();
      if (!text) continue;

      const row = node.closest('.fui-ChatMessageCompact') || node.parentElement;
      const authorEl = row?.querySelector(CAPTION_SELECTORS.author);
      const author = (authorEl?.textContent || '').trim();
      const key = `${author}::${text}`;

      if (seenCaptions.has(key)) continue;
      seenCaptions.add(key);

      lastCaption = { author, text };
      log('Caption captured:', author, text);
      updateStatus(`Heard: ${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`);

      getSettings().then((settings) => {
        if (shouldAutoForward(text, settings)) {
          forwardToChatGPT('Teams caption', author, text);
        }
      });
    }
  }

  function startCaptionWatch() {
    if (captionObserver) return;
    scanCaptions();
    captionObserver = new MutationObserver(() => scanCaptions());
    captionObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    log('Live caption watch started');
  }

  function stopCaptionWatch() {
    if (captionObserver) {
      captionObserver.disconnect();
      captionObserver = null;
    }
  }

  function getRecognition() {
    if (!SpeechRecognition) return null;
    if (recognition) return recognition;

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';

    recognition.onresult = (event) => {
      if (!bridgeActive) return;
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          finalText += event.results[i][0].transcript;
        }
      }
      finalText = finalText.trim();
      if (!finalText) return;

      lastCaption = { author: 'You', text: finalText };
      log('Mic captured:', finalText);
      updateStatus(`You said: ${finalText.slice(0, 60)}${finalText.length > 60 ? '…' : ''}`);

      getSettings().then((settings) => {
        if (shouldAutoForward(finalText, settings)) {
          forwardToChatGPT('Microphone', 'You', finalText);
        }
      });
    };

    recognition.onerror = (event) => {
      log('Mic error:', event.error);
      if (event.error === 'not-allowed') {
        updateStatus('Microphone blocked');
      }
    };

    recognition.onend = () => {
      if (bridgeActive) {
        setTimeout(() => {
          try { recognition.start(); } catch (e) { /* already running */ }
        }, 300);
      }
    };

    return recognition;
  }

  function startMicListen() {
    const rec = getRecognition();
    if (!rec) {
      updateStatus('Mic speech API unavailable');
      return;
    }
    try {
      rec.start();
      log('Microphone listen started');
    } catch (e) {
      log('Mic start failed:', e);
    }
  }

  function stopMicListen() {
    if (!recognition) return;
    try { recognition.stop(); } catch (e) { /* ignore */ }
  }

  function startBridge() {
    if (bridgeActive) return;
    bridgeActive = true;
    seenCaptions.clear();
    lastForwarded = '';

    getSettings().then(async (settings) => {
      if (settings.autoEnableCaptions !== false) {
        const enabled = await enableLiveCaptionsWithRetry();
        if (enabled) {
          updateStatus('Live captions on — listening…');
        } else {
          updateStatus('Join meeting; retrying captions…');
          startCaptionEnableRetry();
        }
      }

      startCaptionWatch();
      startMicListen();
      if (!document.getElementById('teams-chatgpt-status')?.textContent?.includes('captions')) {
        updateStatus('Listening to Teams…');
      }
      log('Bridge started');
    });
  }

  function stopBridge() {
    bridgeActive = false;
    clearTimeout(forwardTimer);
    stopCaptionEnableRetry();
    stopCaptionWatch();
    stopMicListen();
    updateStatus('Stopped');
    log('Bridge stopped');
  }

  function sendLastToChatGPT() {
    if (!lastCaption.text) {
      updateStatus('Nothing captured yet');
      return;
    }
    forwardToChatGPT('Manual', lastCaption.author, lastCaption.text);
  }

  function injectPanel() {
    if (document.getElementById('teams-chatgpt-bridge')) return;
    if (!document.body) return;

    const panel = document.createElement('div');
    panel.id = 'teams-chatgpt-bridge';
    panel.style.cssText = `
      position: fixed;
      top: 60px;
      right: 12px;
      z-index: 2147483647;
      font-family: "Segoe UI", Arial, sans-serif;
      font-size: 13px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 170px;
    `;

    const btnStyle = 'padding:8px 10px;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;';

    const startBtn = document.createElement('button');
    startBtn.textContent = 'Start Teams→ChatGPT';
    startBtn.style.cssText = btnStyle + 'background:#6264a7;';
    startBtn.addEventListener('click', () => startBridge());

    const captionsBtn = document.createElement('button');
    captionsBtn.textContent = 'Enable Live Captions';
    captionsBtn.style.cssText = btnStyle + 'background:#107c10;';
    captionsBtn.addEventListener('click', async () => {
      updateStatus('Enabling live captions…');
      const ok = await enableLiveCaptionsWithRetry(3, 1500);
      updateStatus(ok ? 'Live captions enabled' : 'Could not enable captions');
    });

    const sendBtn = document.createElement('button');
    sendBtn.textContent = 'Send Last to ChatGPT';
    sendBtn.style.cssText = btnStyle + 'background:#2563eb;';
    sendBtn.addEventListener('click', () => sendLastToChatGPT());

    const stopBtn = document.createElement('button');
    stopBtn.textContent = 'Stop';
    stopBtn.style.cssText = btnStyle + 'background:#c4314b;';
    stopBtn.addEventListener('click', () => stopBridge());

    const status = document.createElement('div');
    status.id = 'teams-chatgpt-status';
    status.style.cssText = `
      font-size: 11px;
      color: #242424;
      text-align: center;
      background: #fff;
      padding: 6px 8px;
      border-radius: 6px;
      box-shadow: 0 2px 8px rgba(0,0,0,.18);
      line-height: 1.3;
    `;
    status.textContent = 'Idle';

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:10px;color:#605e5c;text-align:center;background:#f3f2f1;padding:4px 6px;border-radius:4px;line-height:1.3;';
    hint.textContent = 'Live captions auto-enable when bridge starts (if in a meeting).';

    panel.appendChild(startBtn);
    panel.appendChild(captionsBtn);
    panel.appendChild(sendBtn);
    panel.appendChild(stopBtn);
    panel.appendChild(status);
    panel.appendChild(hint);
    document.body.appendChild(panel);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'startTeamsBridge') {
      startBridge();
      sendResponse({ success: true });
    } else if (message.action === 'stopTeamsBridge') {
      stopBridge();
      sendResponse({ success: true });
    }
  });

  function init() {
    injectPanel();
    log('Teams bridge ready');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  setTimeout(init, 1500);
})();
