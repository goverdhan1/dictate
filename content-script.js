(function () {
  // Chrome extension: top frame only. Electron overlay may inject into ChatGPT child frames.
  if (window !== window.top && !window.__dictateElectron) return;

  // Prevent double-injection (manifest + scripting.executeScript).
  if (window.__dictateContentScriptLoaded) {
    console.log('[Auto-Dictate] Already loaded — skipping duplicate inject');
    return;
  }
  window.__dictateContentScriptLoaded = true;

  const DEFAULTS = {
    debounceMs: 400,
    restartMs: 800,
    sendAfterSubmitMs: 450
  };

  const COMPOSER_SELECTORS = [
    'form[data-type="unified-composer"]',
    'form:has(#prompt-textarea)',
    'div:has(> #prompt-textarea)',
    'form:has([data-testid="prompt-textarea"])',
    'div:has(> [data-testid="prompt-textarea"])'
  ];

  const INPUT_SELECTORS = [
    '#prompt-textarea',
    '[data-testid="prompt-textarea"]',
    '[data-testid="message-input"]',
    'div.ProseMirror[contenteditable="true"]',
    'div.ProseMirror[contenteditable="plaintext-only"]',
    '[contenteditable="plaintext-only"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[role="textbox"][contenteditable="plaintext-only"]',
    'div[role="textbox"]',
    'textarea[name="prompt-textarea"]',
    'textarea[placeholder*="Message" i]',
    'textarea[placeholder*="Ask" i]',
    '[data-id="root"][contenteditable]',
    'form[data-type="unified-composer"] [contenteditable]',
    'form[data-type="unified-composer"] textarea'
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
    'button[data-testid="fruitjuice-send-button"]',
    '#composer-submit-button',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
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
  let suppressInputWatch = false;

  function log(...args) {
    console.log('[Auto-Dictate]', ...args);
  }

  function extensionAlive() {
    try {
      return !!(chrome?.runtime?.id && chrome?.storage?.local);
    } catch {
      return false;
    }
  }

  async function isEnabled() {
    if (!extensionAlive()) return false;
    try {
      const data = await chrome.storage.local.get({ enabled: true });
      return data.enabled !== false;
    } catch (e) {
      // Common after extension reload while the ChatGPT tab is still open.
      console.warn('[Auto-Dictate] Storage unavailable (reload ChatGPT tab):', e?.message || e);
      return false;
    }
  }

  function isVisible(el) {
    if (!el || el.disabled) return false;
    const doc = el.ownerDocument || document;
    const win = doc.defaultView || window;
    let style;
    try {
      style = win.getComputedStyle(el);
    } catch {
      return false;
    }
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function collectDocuments(rootDoc = document, out = [], seen = new Set()) {
    if (!rootDoc || seen.has(rootDoc)) return out;
    seen.add(rootDoc);
    out.push(rootDoc);
    let iframes;
    try {
      iframes = rootDoc.querySelectorAll('iframe');
    } catch {
      return out;
    }
    for (const iframe of iframes) {
      try {
        const child = iframe.contentDocument;
        if (child) collectDocuments(child, out, seen);
      } catch {
        /* cross-origin */
      }
    }
    return out;
  }

  function isEditableInput(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return true;
    const ce = String(el.getAttribute('contenteditable') || el.contentEditable || '').toLowerCase();
    return ce === 'true' || ce === 'plaintext-only' || !!el.isContentEditable;
  }

  function resolveEditor(el) {
    if (!el) return null;
    if (isEditableInput(el)) return el;
    try {
      const inner = el.querySelector(
        '[contenteditable="true"], [contenteditable="plaintext-only"], textarea, [role="textbox"]'
      );
      if (inner) return inner;
    } catch {
      /* ignore */
    }
    return el;
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

  function queryComposerInput(root) {
    if (!root) return null;
    for (const sel of INPUT_SELECTORS) {
      let nodes;
      try {
        nodes = root.querySelectorAll(sel);
      } catch {
        continue;
      }
      for (const el of nodes) {
        const editor = resolveEditor(el);
        if (!editor) continue;
        if (editor.id === 'prompt-textarea' || editor.getAttribute('data-testid') === 'prompt-textarea') {
          return editor;
        }
        if (isVisible(editor) || editor.getBoundingClientRect().width > 40) return editor;
      }
    }
    return null;
  }

  function getInputEl() {
    const docs = collectDocuments();
    for (const doc of docs) {
      const found = queryComposerInput(doc);
      if (found) return found;
    }

    let best = null;
    let bestArea = 0;
    for (const doc of docs) {
      let nodes;
      try {
        nodes = doc.querySelectorAll(
          'textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]'
        );
      } catch {
        continue;
      }
      for (const el of nodes) {
        if (el.closest?.('nav, aside, [data-message-author-role]')) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 80) continue;
        const area = rect.width * Math.max(rect.height, 16);
        if (area > bestArea) {
          best = resolveEditor(el);
          bestArea = area;
        }
      }
    }
    return best;
  }

  function isLoginWall() {
    const href = String(location.href || '').toLowerCase();
    if (/\/auth|\/log-?in|signin|accounts\.google|auth0/.test(href)) return true;
    const hasComposer = !!document.querySelector(
      '#prompt-textarea, form[data-type="unified-composer"], [data-testid="prompt-textarea"]'
    );
    const loginBtn = document.querySelector(
      'button[data-testid="login-button"], button[data-testid="welcome-login-button"], a[href*="login"], a[href*="auth"]'
    );
    return !!(loginBtn && !hasComposer);
  }

  function clickBySelectors(selectors) {
    for (const sel of selectors) {
      try {
        const nodes = document.querySelectorAll(sel);
        for (const el of nodes) {
          if (isVisible(el)) {
            clickElement(el);
            return true;
          }
        }
      } catch {
        /* ignore */
      }
    }
    return false;
  }

  function clickByText(pattern) {
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
    const nodes = document.querySelectorAll('button, a, [role="button"]');
    for (const el of nodes) {
      const text = `${el.textContent || ''} ${buttonLabel(el)}`.replace(/\s+/g, ' ').trim();
      if (re.test(text) && isVisible(el)) {
        clickElement(el);
        return true;
      }
    }
    return false;
  }

  function dismissBlockingUi() {
    clickBySelectors([
      'button[aria-label="Close"]',
      'button[aria-label="Dismiss"]',
      'button[aria-label*="Close" i]',
      '[data-testid="close-button"]',
      '[role="dialog"] button[aria-label="Close"]'
    ]);
    clickByText(/^(okay|got it|continue|accept all|accept|agree|skip)$/i);
  }

  function openNewChat() {
    return clickBySelectors([
      'a[data-testid="create-new-chat-button"]',
      'button[data-testid="create-new-chat-button"]',
      '[data-testid="new-chat-button"]',
      'a[aria-label="New chat"]',
      'button[aria-label="New chat"]'
    ]) || clickByText(/^new chat$/i);
  }

  function missingInputError() {
    if (isLoginWall()) return 'Sign in to ChatGPT in the overlay first';
    if (document.querySelector('#prompt-textarea, form[data-type="unified-composer"], [data-testid="prompt-textarea"]')) {
      return 'ChatGPT composer is hidden — click the message box, then Send again';
    }
    return 'ChatGPT input not found — open a new chat in the overlay';
  }

  async function ensureComposerReady(maxMs = 12000) {
    const start = Date.now();
    dismissBlockingUi();
    let triedNewChat = false;
    while (Date.now() - start < maxMs) {
      const el = getInputEl();
      if (el) {
        try {
          el.click?.();
          el.focus?.();
        } catch {
          /* ignore */
        }
        return el;
      }
      if (isLoginWall()) return null;
      if (!triedNewChat && Date.now() - start > 2500) {
        triedNewChat = openNewChat();
      }
      dismissBlockingUi();
      await new Promise((r) => setTimeout(r, 300));
    }
    return getInputEl();
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
    const selectors = [
      ...SEND_SELECTORS,
      'button[aria-label="Send message"]',
      'button[aria-label*="Send message" i]',
      'button[data-testid="composer-send-button"]',
      'form[data-type="unified-composer"] button[type="submit"]'
    ];
    const btn = findFirst(selectors, root);
    if (btn) return btn;
    const fallback = root.querySelector('button[type="submit"]');
    if (fallback && isVisible(fallback) && !VOICE_MODE_RE.test(buttonLabel(fallback)) && !DICTATE_RE.test(buttonLabel(fallback))) {
      return fallback;
    }
    return null;
  }

  function isSendButtonReady(btn) {
    if (!btn || !isVisible(btn)) return false;
    if (btn.disabled) return false;
    if (btn.getAttribute('aria-disabled') === 'true') return false;
    if (btn.hasAttribute('disabled')) return false;
    return true;
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
      return true;
    } catch (e) {
      console.warn('[Auto-Dictate] click failed', e);
      try {
        el.click?.();
        return true;
      } catch {
        return false;
      }
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
    // Used by continuous dictate mode — may involve dictation submit first.
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

  /** Teams bridge path: only click the composer Send button (never dictation controls). */
  async function trySendComposer(maxWaitMs = 4000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const sendBtn = getSendBtn();
      if (isSendButtonReady(sendBtn)) {
        log('Clicking composer send:', buttonLabel(sendBtn));
        return clickElement(sendBtn);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    const sendBtn = getSendBtn();
    if (sendBtn) {
      log('Send button present but may be disabled; clicking anyway');
      return clickElement(sendBtn);
    }
    log('Send button not found');
    return false;
  }

  function getInputText(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
    return (el.innerText || el.textContent || '').replace(/\u200b/g, '');
  }

  function setInputText(el, text) {
    if (!el || !text) return false;
    const doc = el.ownerDocument || document;
    const win = doc.defaultView || window;
    el.focus();

    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA'
        ? win.HTMLTextAreaElement.prototype
        : win.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor?.set) {
        descriptor.set.call(el, text);
      } else {
        el.value = text;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return (el.value || '').trim().length > 0;
    }

    // ProseMirror / contenteditable — replace contents.
    try {
      el.focus();
      const selection = win.getSelection();
      const range = doc.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);

      let ok = doc.execCommand('insertText', false, text);
      if (!ok || !getInputText(el).trim()) {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        el.dispatchEvent(new win.ClipboardEvent('paste', {
          clipboardData: dt,
          bubbles: true,
          cancelable: true
        }));
      }

      if (!getInputText(el).trim()) {
        el.textContent = '';
        el.appendChild(doc.createTextNode(text));
        el.dispatchEvent(new win.InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: text
        }));
      }
    } catch (e) {
      log('setInputText contenteditable failed', e);
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }

    return getInputText(el).trim().length > 0;
  }

  function waitForInput(maxMs = 5000) {
    return ensureComposerReady(maxMs);
  }

  let lastTeamsPayload = '';
  let lastTeamsPayloadAt = 0;
  let receiveFromTeamsBusy = false;
  let responseWatchToken = 0;

  function getAssistantMessages() {
    const nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (nodes.length) return Array.from(nodes);
    return Array.from(document.querySelectorAll('article[data-testid^="conversation-turn"]')).filter((el) => {
      const role = el.getAttribute('data-message-author-role')
        || el.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role');
      return role === 'assistant';
    });
  }

  function extractAssistantText(el) {
    if (!el) return '';
    const markdown = el.querySelector('.markdown, [class*="markdown"]');
    return (markdown?.innerText || el.innerText || '').trim();
  }

  function relayResponseToTeams(question, answer, streaming) {
    if (!extensionAlive()) return;
    try {
      chrome.runtime.sendMessage({
        action: 'relayChatGPTResponse',
        question,
        answer,
        streaming
      });
    } catch (e) {
      log('relayResponseToTeams failed:', e?.message || e);
    }
  }

  async function watchAssistantResponse(question, assistantCountBefore) {
    const token = ++responseWatchToken;
    const started = Date.now();
    let lastText = '';
    let stableTicks = 0;

    relayResponseToTeams(question, 'Waiting for ChatGPT…', true);

    while (token === responseWatchToken && Date.now() - started < 120000) {
      await new Promise((r) => setTimeout(r, 600));
      const messages = getAssistantMessages();
      if (messages.length <= assistantCountBefore) continue;

      const latest = messages[messages.length - 1];
      const text = extractAssistantText(latest);
      if (!text) continue;

      if (text === lastText) {
        stableTicks += 1;
      } else {
        stableTicks = 0;
        lastText = text;
        relayResponseToTeams(question, text, true);
      }

      const streaming = !!document.querySelector(
        'button[aria-label*="Stop" i], button[data-testid="stop-button"], button[aria-label*="Stop streaming" i]'
      );
      if (!streaming && stableTicks >= 2) {
        relayResponseToTeams(question, text, false);
        log('Assistant response relayed to Teams overlay');
        return;
      }
    }

    if (lastText && token === responseWatchToken) {
      relayResponseToTeams(question, lastText, false);
    }
  }

  async function receiveFromTeams(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return { success: false, error: 'empty' };

    const now = Date.now();
    if (trimmed === lastTeamsPayload && now - lastTeamsPayloadAt < 5000) {
      log('Ignoring duplicate Teams payload');
      return { success: true, duplicate: true };
    }
    if (receiveFromTeamsBusy) {
      log('receiveFromTeams already busy');
      return { success: false, error: 'busy' };
    }

    receiveFromTeamsBusy = true;
    lastTeamsPayload = trimmed;
    lastTeamsPayloadAt = now;

    try {
      const inputEl = await ensureComposerReady(15000);
      if (!inputEl) {
        const err = missingInputError();
        log('ChatGPT input not found for Teams message', location.href, document.title, err);
        return { success: false, error: err };
      }

      suppressInputWatch = true;
      sending = true;

      const assistantCountBefore = getAssistantMessages().length;

      const ok = setInputText(inputEl, trimmed);
      if (!ok) {
        return { success: false, error: 'Could not set ChatGPT input' };
      }

      // Give React a moment, then wait until Send is enabled.
      await new Promise((r) => setTimeout(r, 300));
      lastAction = Date.now();
      lastValue = '';

      const sent = await trySendComposer(5000);
      if (!sent) {
        log('Send button not found after Teams insert');
        return { success: false, error: 'ChatGPT Send button not found/disabled' };
      }

      log('Received from Teams and sent:', trimmed);
      if (!window.__DICTATE_USE_NATIVE_OVERLAY__) {
        watchAssistantResponse(trimmed, assistantCountBefore);
      }
      return { success: true };
    } finally {
      setTimeout(() => {
        sending = false;
        suppressInputWatch = false;
        receiveFromTeamsBusy = false;
      }, DEFAULTS.sendAfterSubmitMs + 800);
    }
  }

  if (window.__dictateElectron) {
    window.__dictateReceiveFromTeams = receiveFromTeams;
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
      if (suppressInputWatch || sending) return;
      if (!extensionAlive()) return;
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
    if (!extensionAlive()) {
      sendResponse({ success: false, error: 'Extension context invalidated — reload this tab' });
      return;
    }
    if (message.action === 'ping') {
      sendResponse({ success: true, pong: true });
      return;
    }
    if (message.action === 'startContinuous') {
      startContinuous();
      sendResponse({ success: true });
    } else if (message.action === 'stopContinuous') {
      stopContinuous(true);
      sendResponse({ success: true });
    } else if (message.action === 'submit') {
      sendResponse({ success: submitCurrent() });
    } else if (message.action === 'receiveFromTeams') {
      receiveFromTeams(message.text)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ success: false, error: String(e) }));
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
