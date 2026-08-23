(function () {
  const DEFAULTS = {
    debounceMs: 400,
    restartMs: 800,
    sendAfterSubmitMs: 450
  };

  const COMPOSER_SELECTORS = [
    'form[data-type="unified-composer"]',
    'form:has(#prompt-textarea)',
    'div:has(> #prompt-textarea)'
  ];

  const INPUT_SELECTORS = [
    '#prompt-textarea',
    'div.ProseMirror[contenteditable="true"]',
    'textarea[name="prompt-textarea"]'
  ];

  const DICTATE_START_SELECTORS = [
    'button[aria-label="Start dictation"]',
    'button[aria-label="Dictate button"]',
    'button[aria-label="Dictate"]',
    'button[aria-label*="Start dictation" i]',
    'button[aria-label*="Dictate button" i]',
    'button[data-testid*="speech" i]',
    'button[data-testid*="dictat" i]'
  ];

  const DICTATE_SUBMIT_SELECTORS = [
    'button[aria-label="Submit dictation"]',
    'button[aria-label*="Submit dictation" i]'
  ];

  const DICTATE_STOP_SELECTORS = [
    'button[aria-label="Cancel dictation"]',
    'button[aria-label="Stop dictation"]',
    'button[aria-label*="Cancel dictation" i]',
    'button[aria-label*="Stop dictation" i]'
  ];

  const SEND_SELECTORS = [
    'button[data-testid="send-button"]',
    '#composer-submit-button',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send"]'
  ];

  const VOICE_MODE_RE = /voice mode|start voice|use voice|read aloud/i;
  const DICTATE_RE = /dictat/i;

  let lastValue = '';
  let lastAction = 0;
  let continuousMode = false;
  let composerObserver = null;
  let pageObserver = null;
  let attachInterval = null;
  let checkTimeout = null;
  let restartTimeout = null;
  let lastDictateState = 'inactive';
  let observedInput = null;
  let inputObserver = null;
  let sending = false;

  function log(...args) {
    console.log('[Auto-Dictate]', ...args);
  }

  function isVisible(el) {
    if (!el || el.disabled) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function buttonLabel(el) {
    if (!el) return '';
    return [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-testid')
    ].filter(Boolean).join(' ');
  }

  function findFirst(selectors, root = document) {
    if (!root) return null;
    for (const sel of selectors) {
      let nodes;
      try {
        nodes = root.querySelectorAll(sel);
      } catch (e) {
        continue;
      }
      for (const el of nodes) {
        if (isVisible(el) && !VOICE_MODE_RE.test(buttonLabel(el))) return el;
      }
    }
    return null;
  }

  function getComposer() {
    for (const sel of COMPOSER_SELECTORS) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch (e) {
        // :has() or other selector unsupported
      }
    }
    const input = document.querySelector('#prompt-textarea');
    if (input) return input.closest('form') || input.parentElement || document;
    return document;
  }

  function findDictateByLabel(root, pattern) {
    const buttons = root.querySelectorAll('button');
    for (const btn of buttons) {
      const label = buttonLabel(btn);
      if (!isVisible(btn) || VOICE_MODE_RE.test(label)) continue;
      if (pattern.test(label)) return btn;
    }
    return null;
  }

  function getInputEl() {
    return findFirst(INPUT_SELECTORS, document);
  }

  function getDictateStartBtn() {
    const root = getComposer();
    return findFirst(DICTATE_START_SELECTORS, root)
      || findDictateByLabel(root, /start dictation|dictate button|^dictate$/i);
  }

  function getDictateSubmitBtn() {
    const root = getComposer();
    return findFirst(DICTATE_SUBMIT_SELECTORS, root)
      || findDictateByLabel(root, /submit dictation/i);
  }

  function getDictateStopBtn() {
    const root = getComposer();
    return findFirst(DICTATE_STOP_SELECTORS, root)
      || findDictateByLabel(root, /cancel dictation|stop dictation/i);
  }

  function getSendBtn() {
    const root = getComposer();
    const btn = findFirst(SEND_SELECTORS, root);
    if (btn) return btn;
    // Last resort: composer submit that is not dictate/voice
    const fallback = root.querySelector('button[type="submit"]');
    if (fallback && isVisible(fallback) && !VOICE_MODE_RE.test(buttonLabel(fallback)) && !DICTATE_RE.test(buttonLabel(fallback))) {
      return fallback;
    }
    return null;
  }

  async function isEnabled() {
    try {
      const data = await chrome.storage.local.get({ enabled: true });
      return data.enabled !== false;
    } catch (e) {
      console.warn('[Auto-Dictate] Extension context invalidated:', e);
      return false;
    }
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
      console.warn('[Auto-Dictate] click failed', e);
      return false;
    }
  }

  function getDictateState() {
    if (getDictateSubmitBtn() || getDictateStopBtn()) return 'active';
    if (getDictateStartBtn()) return 'inactive';
    return 'unknown';
  }

  function tryStartDictate() {
    const btn = getDictateStartBtn();
    if (!btn) {
      log('Start dictation button not found in composer');
      return false;
    }
    log('Clicking start dictation:', buttonLabel(btn));
    return clickElement(btn);
  }

  function tryStopDictate() {
    const btn = getDictateStopBtn();
    if (!btn) return false;
    log('Clicking stop/cancel dictation:', buttonLabel(btn));
    return clickElement(btn);
  }

  function trySend() {
    const submit = getDictateSubmitBtn();
    if (submit) {
      log('Submitting dictation, then sending');
      clickElement(submit);
      setTimeout(() => {
        const sendBtn = getSendBtn();
        if (sendBtn) {
          log('Clicking send:', buttonLabel(sendBtn));
          clickElement(sendBtn);
        }
      }, DEFAULTS.sendAfterSubmitMs);
      return true;
    }
    const sendBtn = getSendBtn();
    if (!sendBtn) {
      log('Send button not found');
      return false;
    }
    log('Clicking send:', buttonLabel(sendBtn));
    return clickElement(sendBtn);
  }

  function getInputText(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
    return (el.innerText || el.textContent || '').replace(/\u200b/g, '');
  }

  function setInputText(el, text) {
    if (!el || !text) return false;
    el.focus();

    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      el.value = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return true;
    }

    el.textContent = '';
    const inserted = document.execCommand('insertText', false, text);
    if (!inserted) {
      el.textContent = text;
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return true;
  }

  async function receiveFromTeams(text) {
    const inputEl = getInputEl();
    if (!inputEl) {
      log('ChatGPT input not found for Teams message');
      return { success: false, error: 'ChatGPT input not found' };
    }

    const ok = setInputText(inputEl, text);
    if (!ok) {
      return { success: false, error: 'Could not set ChatGPT input' };
    }

    setTimeout(() => {
      sending = true;
      lastAction = Date.now();
      lastValue = '';
      trySend();
      setTimeout(() => { sending = false; }, DEFAULTS.sendAfterSubmitMs + 200);
    }, 350);

    log('Received from Teams and queued send:', text);
    return { success: true };
  }

  function clearInput(inputEl) {
    if (!inputEl) return;
    if (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT') {
      inputEl.value = '';
    } else {
      inputEl.innerText = '';
      inputEl.textContent = '';
    }
    lastValue = '';
  }

  function scheduleRestartDictate() {
    if (!continuousMode) return;
    clearTimeout(restartTimeout);
    restartTimeout = setTimeout(() => {
      if (!continuousMode) return;
      if (getDictateState() === 'active') return;
      const started = tryStartDictate();
      log('Restart dictation:', started);
    }, DEFAULTS.restartMs);
  }

  function maybeSendOnDictation(value) {
    const now = Date.now();
    if (sending) return;
    if (now - lastAction < DEFAULTS.debounceMs) return;

    if (!value) {
      if (lastValue !== '' && continuousMode && getDictateState() !== 'active') {
        log('Input cleared after send, restarting dictation');
        scheduleRestartDictate();
      }
      lastValue = '';
      return;
    }

    const grew = value.length > lastValue.length + 1;
    const endedWithPunctuation = /[.?!]$/.test(value);
    const chunkAppeared = value.length - lastValue.length > 5;
    log('Dictation check:', { value, lastValue, grew, endedWithPunctuation, chunkAppeared, continuousMode, state: getDictateState() });

    if (grew && (endedWithPunctuation || chunkAppeared)) {
      sending = true;
      lastAction = now;
      lastValue = '';
      const sent = trySend();
      log('Sending message:', sent);
      setTimeout(() => { sending = false; }, DEFAULTS.sendAfterSubmitMs + 200);
      if (sent && continuousMode) {
        scheduleRestartDictate();
      }
    } else {
      lastValue = value;
    }
  }

  function observeInput(inputEl) {
    if (!inputEl || observedInput === inputEl) return;

    if (inputObserver) {
      inputObserver.disconnect();
      inputObserver = null;
    }
    observedInput = inputEl;
    log('Observing input', inputEl.id || inputEl.tagName);

    const onChange = async () => {
      if (!(await isEnabled())) return;
      clearTimeout(checkTimeout);
      checkTimeout = setTimeout(() => maybeSendOnDictation(getInputText(inputEl).trim()), 120);
    };

    if (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT') {
      inputEl.addEventListener('input', onChange);
    } else {
      inputObserver = new MutationObserver(onChange);
      inputObserver.observe(inputEl, { childList: true, subtree: true, characterData: true });
      inputEl.addEventListener('input', onChange);
    }
  }

  function onDictateStateChange(state) {
    if (state === lastDictateState) return;
    const prev = lastDictateState;
    lastDictateState = state;
    log('Dictate state:', prev, '->', state);

    if (!continuousMode) return;

    if (prev === 'active' && state === 'inactive') {
      const inputEl = getInputEl();
      const value = getInputText(inputEl).trim();
      if (value) {
        log('Dictation ended with text, auto-sending');
        sending = true;
        lastAction = Date.now();
        trySend();
        setTimeout(() => { sending = false; }, DEFAULTS.sendAfterSubmitMs + 200);
        scheduleRestartDictate();
      } else {
        log('Dictation ended empty, restarting');
        clearInput(inputEl);
        scheduleRestartDictate();
      }
    }
  }

  function setupComposerObserver() {
    const composer = getComposer();
    if (!composer || composer === document) return;

    if (composerObserver) {
      composerObserver.disconnect();
      composerObserver = null;
    }

    lastDictateState = getDictateState();

    composerObserver = new MutationObserver(() => {
      onDictateStateChange(getDictateState());
    });
    composerObserver.observe(composer, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-label', 'data-testid', 'disabled']
    });
  }

  function attachObservers() {
    const inputEl = getInputEl();
    if (inputEl) {
      observeInput(inputEl);
      if (attachInterval) {
        clearInterval(attachInterval);
        attachInterval = null;
      }
    } else if (!attachInterval) {
      attachInterval = setInterval(() => {
        const el = getInputEl();
        if (el) {
          observeInput(el);
          clearInterval(attachInterval);
          attachInterval = null;
        }
      }, 400);
    }
    setupComposerObserver();
  }

  function updateControlStatus() {
    const status = document.getElementById('auto-dictate-status');
    if (!status) return;
    const state = getDictateState();
    if (continuousMode && state === 'active') {
      status.textContent = 'Listening…';
    } else if (continuousMode) {
      status.textContent = getDictateStartBtn() ? 'Ready' : 'Mic not found';
    } else {
      status.textContent = getDictateStartBtn() ? 'Idle' : 'Mic not found';
    }
  }

  function stopContinuous(sendCurrent) {
    continuousMode = false;
    clearTimeout(restartTimeout);
    if (composerObserver) {
      composerObserver.disconnect();
      composerObserver = null;
    }

    const inputEl = getInputEl();
    const currentValue = getInputText(inputEl).trim();
    const recording = getDictateState() === 'active';

    if (sendCurrent && (currentValue || recording)) {
      trySend();
      setTimeout(() => {
        if (getDictateState() === 'active') tryStopDictate();
        log('Dictate mode stopped after send');
        updateControlStatus();
      }, recording ? DEFAULTS.sendAfterSubmitMs + 200 : 200);
    } else {
      if (recording) tryStopDictate();
      log('Dictate mode stopped');
    }
    updateControlStatus();
  }

  function startContinuous() {
    continuousMode = true;
    setupComposerObserver();
    if (getDictateState() !== 'active') {
      tryStartDictate();
    }
    log('Dictate mode started');
    updateControlStatus();
  }

  function submitCurrent() {
    const inputEl = getInputEl();
    const currentValue = getInputText(inputEl).trim();
    const recording = getDictateState() === 'active';

    if (!recording && !currentValue) {
      log('Nothing to submit');
      updateControlStatus();
      return false;
    }

    sending = true;
    lastAction = Date.now();
    lastValue = '';
    const sent = trySend();
    log('Submit clicked:', sent);
    setTimeout(() => { sending = false; }, DEFAULTS.sendAfterSubmitMs + 200);

    if (sent && continuousMode) {
      scheduleRestartDictate();
    }
    updateControlStatus();
    return sent;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'startContinuous') {
      startContinuous();
      sendResponse({ success: true });
    } else if (message.action === 'stopContinuous') {
      stopContinuous(true);
      sendResponse({ success: true });
    } else if (message.action === 'submit') {
      sendResponse({ success: submitCurrent() });
    } else if (message.action === 'receiveFromTeams') {
      receiveFromTeams(message.text).then(sendResponse);
      return true;
    }
  });

  function injectButtons() {
    if (document.getElementById('auto-dictate-controls')) {
      updateControlStatus();
      return;
    }
    if (!document.body) return;

    const controlsDiv = document.createElement('div');
    controlsDiv.id = 'auto-dictate-controls';
    controlsDiv.style.cssText = `
      position: fixed;
      top: 50px;
      right: 10px;
      z-index: 2147483647;
      font-family: Arial, sans-serif;
      font-size: 14px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      align-items: stretch;
    `;

    const btnStyle = 'padding: 8px; color: white; border: none; border-radius: 4px; cursor: pointer;';

    const startBtn = document.createElement('button');
    startBtn.id = 'auto-dictate-start';
    startBtn.textContent = 'Start Dictate';
    startBtn.style.cssText = btnStyle + ' background-color: #2563eb;';
    startBtn.addEventListener('click', () => startContinuous());

    const submitBtn = document.createElement('button');
    submitBtn.id = 'auto-dictate-submit';
    submitBtn.textContent = 'Submit';
    submitBtn.style.cssText = btnStyle + ' background-color: #16a34a;';
    submitBtn.addEventListener('click', () => submitCurrent());

    const stopBtn = document.createElement('button');
    stopBtn.id = 'auto-dictate-stop';
    stopBtn.textContent = 'Stop Dictate';
    stopBtn.style.cssText = btnStyle + ' background-color: #dc2626;';
    stopBtn.addEventListener('click', () => stopContinuous(true));

    const status = document.createElement('div');
    status.id = 'auto-dictate-status';
    status.style.cssText = 'font-size: 12px; color: #444; text-align: center; background: #fff; padding: 4px 6px; border-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,.15);';
    status.textContent = 'Idle';

    controlsDiv.appendChild(startBtn);
    controlsDiv.appendChild(submitBtn);
    controlsDiv.appendChild(stopBtn);
    controlsDiv.appendChild(status);
    document.body.appendChild(controlsDiv);
    updateControlStatus();
  }

  function startPageObserver() {
    if (pageObserver || !document.body) return;
    let debounce;
    pageObserver = new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        attachObservers();
        injectButtons();
        updateControlStatus();
      }, 300);
    });
    pageObserver.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    attachObservers();
    injectButtons();
    startPageObserver();
    log('Content script running');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  setTimeout(() => {
    attachObservers();
    injectButtons();
  }, 1500);
})();
