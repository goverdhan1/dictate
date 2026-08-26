(function () {
  if (window.__dictateTeamsBridgeLoaded) {
    console.log('[Teams→ChatGPT] Already loaded — skipping duplicate inject');
    return;
  }
  window.__dictateTeamsBridgeLoaded = true;

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
  /** Ordered captions captured this session. Each: { author, text, key, sent } */
  let captionQueue = [];
  let forwardTimer = null;
  let captionEnableTimer = null;
  let captionsConfirmedOn = false;
  let enableCaptionsInFlight = false;
  let captionPollTimer = null;
  let captionScanTimer = null;
  let captionScanInFlight = false;
  let lastStatusText = 'Idle';
  let controlsMountTimer = null;
  let cachedControls = null;
  let cachedCaptionRoot = null;

  const CAPTIONS_UI = {
    moreBtn: [
      '[data-tid="callingButtons-showMoreBtn"]',
      '[data-inp="callingButtons-showMoreBtn"]',
      '#callingButtons-showMoreBtn',
      'button[aria-label="More"]',
      'button[aria-label="More actions"]',
      'button[aria-label*="More actions" i]',
      'button[title="More"]',
      'button[title="More actions"]'
    ].join(', '),
    hangup: '#hangup-button, [data-tid="hangup-button"], [data-inp="hangup-button"]',
    roster: '#roster-button, [data-tid="roster-button"], [data-inp="roster-button"]',
    renderer: [
      "[data-tid='closed-captions-renderer']",
      "[data-tid='closed-caption-v2-virtual-list-content']",
      "[data-tid='closed-caption-text']",
      "[data-tid='cc-vertical-list']"
    ].join(', ')
  };

  const ENABLE_CAPTIONS_RE = /^(show|turn on|enable|start)\s+(live\s+)?captions?$/i;
  const ENABLE_CAPTIONS_LOOSE_RE = /(show|turn on|enable|start)\s+(live\s+)?captions?/i;
  const DISABLE_CAPTIONS_RE = /(hide|turn off|disable|stop)\s+(live\s+)?captions?/i;
  const LANGUAGE_SPEECH_RE = /language and speech|language\s*&\s*speech/i;

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
        forwardPrefix: ''
      });
      // Backward compatibility with older checkbox setting
      if (data.autoForwardMode == null) {
        data.autoForwardMode = data.autoForwardQuestions === false ? 'off' : 'questions';
      }
      // Drop the old default prefix if it was never customized.
      if (data.forwardPrefix === 'Answer this meeting question: ' || data.forwardPrefix === 'Answer this meeting question:') {
        data.forwardPrefix = '';
        chrome.storage.local.set({ forwardPrefix: '' });
      }
      return data;
    } catch (e) {
      return {
        bridgeEnabled: true,
        autoEnableCaptions: true,
        autoForwardMode: 'questions',
        forwardPrefix: ''
      };
    }
  }

  function updateStatus(text) {
    if (text === lastStatusText) return;
    lastStatusText = text || 'Idle';
    const el = document.getElementById('teams-chatgpt-status');
    if (el) el.textContent = lastStatusText;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function walkShadowRoots(root, fn) {
    const direct = fn(root);
    if (direct) return direct;
    if (!root.querySelectorAll) return null;
    // Cap work — full Teams DOM walks freeze the page.
    const nodes = root.querySelectorAll('*');
    const limit = Math.min(nodes.length, 1500);
    for (let i = 0; i < limit; i++) {
      const el = nodes[i];
      if (el.shadowRoot) {
        const found = walkShadowRoots(el.shadowRoot, fn);
        if (found) return found;
      }
    }
    return null;
  }

  function queryAllDeep(selector, root = document, maxNodes = 2000) {
    const results = [];
    function walk(r, budget) {
      if (!r.querySelectorAll || budget.left <= 0) return;
      try {
        r.querySelectorAll(selector).forEach((el) => results.push(el));
      } catch {
        return;
      }
      const nodes = r.querySelectorAll('*');
      const limit = Math.min(nodes.length, budget.left);
      for (let i = 0; i < limit; i++) {
        budget.left--;
        const el = nodes[i];
        if (el.shadowRoot) walk(el.shadowRoot, budget);
        if (budget.left <= 0) return;
      }
    }
    walk(root, { left: maxNodes });
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
    if (!el) return '';
    return [
      el.getAttribute?.('aria-label'),
      el.getAttribute?.('title'),
      el.getAttribute?.('data-tid'),
      el.textContent
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  function hoverElement(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, view: window, composed: true };
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mouseenter', opts));
    el.dispatchEvent(new PointerEvent('pointerover', { ...opts, pointerId: 1, pointerType: 'mouse' }));
  }

  function revealMeetingControls() {
    // Meeting control bar often hides until the pointer moves near the bottom.
    const x = Math.floor(window.innerWidth / 2);
    const y = Math.max(40, window.innerHeight - 40);
    const target = document.elementFromPoint(x, y) || document.body;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, composed: true };
    target.dispatchEvent(new MouseEvent('mousemove', opts));
    document.body.dispatchEvent(new MouseEvent('mousemove', opts));
  }

  function isInMeeting() {
    return !!(
      queryAllDeep(CAPTIONS_UI.hangup).some(isVisible) ||
      queryAllDeep(CAPTIONS_UI.roster).some(isVisible) ||
      findMoreButton()
    );
  }

  function isCaptionsUiVisible() {
    return queryAllDeep(CAPTIONS_UI.renderer).some(isVisible)
      || queryAllDeep(CAPTION_SELECTORS.text).some(isVisible)
      || !!document.querySelector(CAPTION_SELECTORS.list);
  }

  function findMenuItems() {
    return queryAllDeep(
      '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], button[role="menuitem"]'
    ).filter(isVisible);
  }

  function findByLabel(regex, candidates) {
    for (const el of candidates) {
      const label = elementLabel(el);
      if (label && regex.test(label)) return el;
    }
    return null;
  }

  function findMoreButton() {
    revealMeetingControls();
    return walkShadowRoots(document, (root) => {
      for (const sel of CAPTIONS_UI.moreBtn.split(',').map((s) => s.trim())) {
        try {
          const nodes = root.querySelectorAll(sel);
          for (const el of nodes) {
            if (isVisible(el)) return el;
          }
        } catch {
          // invalid selector in this context
        }
      }
      // Fallback: toolbar buttons whose aria-label is exactly More / More actions
      const buttons = root.querySelectorAll?.('button') || [];
      for (const btn of buttons) {
        if (!isVisible(btn)) continue;
        const label = elementLabel(btn);
        if (/^more( actions)?$/i.test(label) || /more actions/i.test(label)) return btn;
      }
      return null;
    });
  }

  function findEnableCaptionsItem() {
    const items = findMenuItems();
    // Prefer exact enable labels; never pick hide/turn off.
    return findByLabel(ENABLE_CAPTIONS_RE, items)
      || findByLabel(ENABLE_CAPTIONS_LOOSE_RE, items.filter((el) => !DISABLE_CAPTIONS_RE.test(elementLabel(el))));
  }

  function findDisableCaptionsItem() {
    return findByLabel(DISABLE_CAPTIONS_RE, findMenuItems());
  }

  function findLanguageSpeechItem() {
    return findByLabel(LANGUAGE_SPEECH_RE, findMenuItems());
  }

  async function waitFor(predicate, timeoutMs = 2500, stepMs = 150) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const value = predicate();
      if (value) return value;
      await sleep(stepMs);
    }
    return predicate();
  }

  async function closeOpenMenus() {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true
    }));
    await sleep(200);
  }

  async function openMoreMenu() {
    revealMeetingControls();
    await sleep(250);
    const moreBtn = findMoreButton();
    if (!moreBtn) return null;

    // If a menu is already open with language/speech/captions, reuse it.
    if (findLanguageSpeechItem() || findEnableCaptionsItem() || findDisableCaptionsItem()) {
      return moreBtn;
    }

    clickElement(moreBtn);
    const opened = await waitFor(
      () => findLanguageSpeechItem() || findEnableCaptionsItem() || findDisableCaptionsItem() || findMenuItems().length > 0,
      2500
    );
    if (!opened) {
      // Retry once after revealing controls again.
      revealMeetingControls();
      await sleep(300);
      clickElement(moreBtn);
      await waitFor(
        () => findLanguageSpeechItem() || findEnableCaptionsItem() || findDisableCaptionsItem(),
        2000
      );
    }
    return moreBtn;
  }

  async function openLanguageAndSpeech() {
    let lang = findLanguageSpeechItem();
    if (!lang) return false;

    hoverElement(lang);
    await sleep(350);
    // Some Fluent menus open flyouts on hover; others need a click.
    if (!findEnableCaptionsItem() && !findDisableCaptionsItem()) {
      clickElement(lang);
      await sleep(500);
    }

    lang = findLanguageSpeechItem();
    if (lang) hoverElement(lang);

    await waitFor(() => findEnableCaptionsItem() || findDisableCaptionsItem(), 2000);
    return !!(findEnableCaptionsItem() || findDisableCaptionsItem());
  }

  function isCaptionsEnabled() {
    if (captionsConfirmedOn) return true;
    if (isCaptionsUiVisible()) {
      captionsConfirmedOn = true;
      return true;
    }
    return false;
  }

  async function detectCaptionsAlreadyOnViaMenu() {
    const moreBtn = await openMoreMenu();
    if (!moreBtn) return false;

    // Direct caption item in root menu (older UI)
    if (findDisableCaptionsItem()) {
      captionsConfirmedOn = true;
      await closeOpenMenus();
      return true;
    }
    if (findEnableCaptionsItem()) {
      await closeOpenMenus();
      return false;
    }

    // Newer UI: Language and speech submenu
    await openLanguageAndSpeech();
    if (findDisableCaptionsItem()) {
      captionsConfirmedOn = true;
      await closeOpenMenus();
      return true;
    }
    await closeOpenMenus();
    return false;
  }

  async function enableLiveCaptions() {
    if (enableCaptionsInFlight) return false;
    enableCaptionsInFlight = true;

    try {
      if (isCaptionsUiVisible()) {
        captionsConfirmedOn = true;
        log('Live captions UI already visible');
        return true;
      }

      if (!isInMeeting()) {
        log('Not in a meeting yet — hangup/roster/more controls missing');
        return false;
      }

      updateStatus('Opening More menu…');
      const moreBtn = await openMoreMenu();
      if (!moreBtn) {
        log('More actions button not found');
        updateStatus('More button not found — join meeting first');
        return false;
      }

      // Already on?
      if (findDisableCaptionsItem()) {
        captionsConfirmedOn = true;
        await closeOpenMenus();
        log('Captions already on (Hide live captions present)');
        return true;
      }

      let enableBtn = findEnableCaptionsItem();

      if (!enableBtn) {
        updateStatus('Opening Language and speech…');
        const opened = await openLanguageAndSpeech();
        if (!opened) {
          log('Language and speech submenu not found');
          await closeOpenMenus();
          return false;
        }

        if (findDisableCaptionsItem()) {
          captionsConfirmedOn = true;
          await closeOpenMenus();
          log('Captions already on via Language and speech');
          return true;
        }
        enableBtn = findEnableCaptionsItem();
      }

      if (!enableBtn) {
        log('Show/Turn on live captions menu item not found');
        updateStatus('Captions menu item not found');
        await closeOpenMenus();
        return false;
      }

      const label = elementLabel(enableBtn);
      if (DISABLE_CAPTIONS_RE.test(label)) {
        // Safety: never click a disable/hide item.
        captionsConfirmedOn = true;
        await closeOpenMenus();
        return true;
      }

      updateStatus(`Clicking: ${label.slice(0, 40)}`);
      log('Clicking captions control:', label);
      clickElement(enableBtn);
      await sleep(1000);

      // Mark as on after a successful enable click even if no caption text yet
      // (silence means no caption nodes). Otherwise retries would toggle them off.
      captionsConfirmedOn = true;

      // Give the caption panel a moment to mount.
      await waitFor(() => isCaptionsUiVisible(), 2500);
      await closeOpenMenus();
      log('Live captions enable click completed');
      return true;
    } finally {
      enableCaptionsInFlight = false;
    }
  }

  async function enableLiveCaptionsWithRetry(maxAttempts = 4, intervalMs = 2500) {
    if (captionsConfirmedOn || isCaptionsUiVisible()) {
      captionsConfirmedOn = true;
      return true;
    }

    // First check via menu whether captions are already on (avoid toggle-off).
    try {
      if (await detectCaptionsAlreadyOnViaMenu()) return true;
    } catch (e) {
      log('Caption detection failed:', e);
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (captionsConfirmedOn || isCaptionsUiVisible()) return true;

      updateStatus(`Enabling live captions (${attempt}/${maxAttempts})…`);
      const ok = await enableLiveCaptions();
      if (ok) return true;

      if (attempt < maxAttempts) await sleep(intervalMs);
    }

    return captionsConfirmedOn || isCaptionsUiVisible();
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
      if (!bridgeActive || captionsConfirmedOn || isCaptionsUiVisible() || attempts >= 6) {
        if (captionsConfirmedOn || isCaptionsUiVisible()) {
          captionsConfirmedOn = true;
          updateStatus('Live captions on — listening…');
        }
        stopCaptionEnableRetry();
        return;
      }
      attempts++;
      await enableLiveCaptions();
    }, 4000);
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

  async function forwardToChatGPT(source, author, text, options = {}) {
    const force = options.force === true;
    const trimmed = (text || '').trim();
    if (!trimmed) {
      updateStatus('Nothing to send');
      return { success: false, error: 'empty' };
    }

    const settings = await getSettings();
    if (!settings.bridgeEnabled && !force) {
      updateStatus('Bridge disabled in popup');
      return { success: false, error: 'bridge-disabled' };
    }

    const payload = settings.forwardPrefix
      ? settings.forwardPrefix + formatMessage(source, author, trimmed)
      : formatMessage(source, author, trimmed);

    // Auto-forward skips duplicates; manual Send Last always retries.
    if (!force && payload === lastForwarded) {
      log('Skipping duplicate auto-forward');
      return { success: false, error: 'duplicate' };
    }
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
        return { success: true };
      }
      const err = response?.error || 'ChatGPT tab not ready';
      updateStatus(err);
      return { success: false, error: err };
    } catch (e) {
      log('Forward failed:', e);
      updateStatus('Could not reach ChatGPT — reload extension');
      return { success: false, error: String(e) };
    }
  }

  function normalizeCaptionText(text) {
    return (text || '')
      .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeAuthor(author) {
    return normalizeCaptionText(author);
  }

  function bareText(text) {
    return normalizeCaptionText(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function captionKey(author, text) {
    return `${normalizeAuthor(author)}::${normalizeCaptionText(text)}`.toLowerCase();
  }

  function similarityKey(author, text) {
    return `${normalizeAuthor(author).toLowerCase()}::${bareText(text)}`;
  }

  function rememberCaption(caption) {
    const author = normalizeAuthor(caption?.author);
    const text = normalizeCaptionText(caption?.text);
    if (!text) return null;

    lastCaption = { author, text };
    const key = captionKey(author, text);
    const sim = similarityKey(author, text);
    const bare = bareText(text);

    // Never re-queue anything already marked sent / seen (including punctuation variants).
    if (seenCaptions.has(key) || seenCaptions.has(sim)) {
      return null;
    }

    for (let i = captionQueue.length - 1; i >= 0; i--) {
      const existing = captionQueue[i];
      if (existing.author !== author) continue;

      existing.sim = existing.sim || similarityKey(existing.author, existing.text);
      const existingBare = bareText(existing.text);
      const sameMeaning = existing.sim === sim || existing.key === key || existingBare === bare;
      const related = sameMeaning
        || bare.startsWith(existingBare)
        || existingBare.startsWith(bare)
        || text.startsWith(existing.text)
        || existing.text.startsWith(text);

      if (!related) continue;

      // Already forwarded this thought (or a shorter/longer form of it).
      if (existing.sent) {
        seenCaptions.add(key);
        seenCaptions.add(sim);
        return null;
      }

      // Merge into the unsent row — keep the longer wording.
      if (text.length >= existing.text.length) {
        existing.text = text;
        existing.key = key;
        existing.sim = sim;
      }
      seenCaptions.add(key);
      seenCaptions.add(sim);
      return existing;
    }

    if (captionQueue.some((c) => {
      const cSim = c.sim || similarityKey(c.author, c.text);
      return c.key === key || cSim === sim || (c.author === author && bareText(c.text) === bare);
    })) {
      return null;
    }

    const entry = { author, text, key, sim, sent: false };
    captionQueue.push(entry);
    seenCaptions.add(key);
    seenCaptions.add(sim);
    log('Caption queued:', author, text);
    return entry;
  }

  function dedupeCaptionEntries(entries) {
    const result = [];
    for (const entry of entries) {
      const author = normalizeAuthor(entry.author);
      const text = normalizeCaptionText(entry.text);
      if (!text) continue;
      const sim = entry.sim || similarityKey(author, text);
      const bare = bareText(text);

      let merged = false;
      for (let i = 0; i < result.length; i++) {
        const other = result[i];
        if (other.author !== author) continue;
        const otherBare = bareText(other.text);
        const related = other.sim === sim
          || otherBare === bare
          || bare.startsWith(otherBare)
          || otherBare.startsWith(bare);
        if (!related) continue;
        if (text.length > other.text.length) {
          result[i] = { ...entry, author, text, key: captionKey(author, text), sim };
        }
        merged = true;
        break;
      }
      if (!merged) {
        result.push({ ...entry, author, text, key: captionKey(author, text), sim });
      }
    }
    return result;
  }

  function getUnsentCaptions() {
    return dedupeCaptionEntries(captionQueue.filter((c) => !c.sent && normalizeCaptionText(c.text)));
  }

  function markCaptionsSent(entries) {
    for (const sent of entries) {
      const sentAuthor = normalizeAuthor(sent.author);
      const sentBare = bareText(sent.text);
      const sentSim = sent.sim || similarityKey(sent.author, sent.text);
      const sentKey = captionKey(sent.author, sent.text);
      seenCaptions.add(sentKey);
      seenCaptions.add(sentSim);

      for (const entry of captionQueue) {
        if (entry.author !== sentAuthor) continue;
        const entryBare = bareText(entry.text);
        const entrySim = entry.sim || similarityKey(entry.author, entry.text);
        if (
          entry.key === sentKey
          || entrySim === sentSim
          || entryBare === sentBare
          || entryBare.startsWith(sentBare)
          || sentBare.startsWith(entryBare)
        ) {
          entry.sent = true;
          seenCaptions.add(entry.key);
          seenCaptions.add(entrySim);
        }
      }
    }
  }

  function formatCaptionBatch(entries) {
    return dedupeCaptionEntries(entries)
      .map((c) => (c.author ? `${c.author}: ${c.text}` : c.text))
      .join('\n');
  }

  /** Collapse payloads that are an exact or line-wise duplicated block. */
  function collapseDuplicatedPayload(text) {
    let t = (text || '').trim();
    if (!t) return t;

    // Exact doubled string: ABCABC
    if (t.length >= 20) {
      const mid = Math.floor(t.length / 2);
      const a = t.slice(0, mid).trim();
      const b = t.slice(mid).trim();
      if (a && a === b) t = a;
    }

    let lines = t.split(/\n+/).map((l) => l.trim()).filter(Boolean);

    // First half of lines equals second half.
    if (lines.length >= 2 && lines.length % 2 === 0) {
      const half = lines.length / 2;
      const first = lines.slice(0, half).join('\n');
      const second = lines.slice(half).join('\n');
      if (first === second) lines = lines.slice(0, half);
    }

    // Drop similar/duplicate lines while keeping order.
    const unique = [];
    for (const line of lines) {
      const m = line.match(/^(.*?):\s*(.*)$/);
      const author = m ? m[1] : '';
      const body = m ? m[2] : line;
      const sim = similarityKey(author, body);
      const bare = bareText(body);
      let replaced = false;
      for (let i = 0; i < unique.length; i++) {
        const um = unique[i].match(/^(.*?):\s*(.*)$/);
        const uAuthor = um ? um[1] : '';
        const uBody = um ? um[2] : unique[i];
        if (normalizeAuthor(uAuthor) !== normalizeAuthor(author)) continue;
        const uBare = bareText(uBody);
        if (similarityKey(uAuthor, uBody) === sim || uBare === bare || uBare.startsWith(bare) || bare.startsWith(uBare)) {
          if (body.length > uBody.length) unique[i] = line;
          replaced = true;
          break;
        }
      }
      if (!replaced) unique.push(line);
    }
    return unique.join('\n');
  }

  function findCaptionNodes() {
    // Prefer cheap light-DOM queries. Avoid full-page shadow walks every tick.
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(CAPTION_SELECTORS.text));
    } catch {
      nodes = [];
    }

    if (nodes.length) {
      const root = nodes[0].closest?.(
        "[data-tid='closed-caption-v2-virtual-list-content'], [data-tid='closed-captions-renderer']"
      );
      if (root) cachedCaptionRoot = root;
      return nodes;
    }

    if (cachedCaptionRoot?.isConnected) {
      try {
        nodes = Array.from(cachedCaptionRoot.querySelectorAll(CAPTION_SELECTORS.text));
        if (nodes.length) return nodes;
      } catch {
        /* ignore */
      }
    }

    // Rare fallback: limited deep search (Teams sometimes nests captions).
    nodes = queryAllDeep(CAPTION_SELECTORS.text, document, 800);
    if (nodes.length) {
      const root = nodes[0].closest?.(
        "[data-tid='closed-caption-v2-virtual-list-content'], [data-tid='closed-captions-renderer']"
      );
      if (root) cachedCaptionRoot = root;
    }
    return nodes;
  }

  function readCaptionFromNode(node) {
    const text = normalizeCaptionText(node.textContent || '');
    if (!text) return null;
    const row = node.closest('.fui-ChatMessageCompact') || node.parentElement;
    let author = '';
    if (row) {
      const authorEl = row.querySelector?.(CAPTION_SELECTORS.author);
      author = normalizeAuthor(authorEl?.textContent || '');
    }
    return { author, text };
  }

  function collectCaptionsFromDom() {
    const nodes = findCaptionNodes();
    for (const node of nodes) {
      const caption = readCaptionFromNode(node);
      if (caption) rememberCaption(caption);
    }
  }

  function scanCaptions() {
    if (captionScanInFlight) return;
    captionScanInFlight = true;
    try {
      const beforeCount = captionQueue.length;
      collectCaptionsFromDom();

      // Prevent unbounded growth in long meetings.
      if (captionQueue.length > 400) {
        captionQueue = captionQueue.slice(-300);
      }

      const unsent = getUnsentCaptions();
      if (unsent.length) {
        const latest = unsent[unsent.length - 1];
        updateStatus(`${unsent.length} new · ${latest.text.slice(0, 40)}${latest.text.length > 40 ? '…' : ''}`);
      }

      if (!bridgeActive) return;
      if (captionQueue.length <= beforeCount) return;

      const newlyAdded = captionQueue.slice(beforeCount);
      getSettings().then((settings) => {
        for (const entry of newlyAdded) {
          if (entry.sent || !shouldAutoForward(entry.text, settings)) continue;
          forwardToChatGPT('Teams caption', entry.author, entry.text).then((result) => {
            if (result?.success) markCaptionsSent([entry]);
          });
        }
      });
    } finally {
      captionScanInFlight = false;
    }
  }

  function scheduleCaptionScan() {
    if (captionScanTimer) return;
    captionScanTimer = setTimeout(() => {
      captionScanTimer = null;
      scanCaptions();
    }, 600);
  }

  function startCaptionWatch() {
    if (captionPollTimer) return;
    scanCaptions();
    // Polling avoids MutationObserver storms on Teams' huge live DOM.
    captionPollTimer = setInterval(scheduleCaptionScan, 1200);
    log('Live caption watch started (polling)');
  }

  function stopCaptionWatch() {
    if (captionObserver) {
      captionObserver.disconnect();
      captionObserver = null;
    }
    if (captionPollTimer) {
      clearInterval(captionPollTimer);
      captionPollTimer = null;
    }
    if (captionScanTimer) {
      clearTimeout(captionScanTimer);
      captionScanTimer = null;
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
      const entry = rememberCaption({ author: 'You', text: finalText });
      log('Mic captured:', finalText);
      const pending = getUnsentCaptions().length;
      updateStatus(`${pending} new · You: ${finalText.slice(0, 40)}${finalText.length > 40 ? '…' : ''}`);

      getSettings().then((settings) => {
        if (!entry || !shouldAutoForward(finalText, settings)) return;
        forwardToChatGPT('Microphone', 'You', finalText).then((result) => {
          if (result?.success) markCaptionsSent([entry]);
        });
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
    // Keep captionQueue / sent history so Send still knows what was already forwarded.
    lastForwarded = '';
    captionsConfirmedOn = isCaptionsUiVisible();

    getSettings().then(async (settings) => {
      if (settings.autoEnableCaptions !== false) {
        const enabled = await enableLiveCaptionsWithRetry();
        if (enabled) {
          updateStatus('Live captions on — listening…');
        } else {
          updateStatus('Could not enable captions — try the green button');
          startCaptionEnableRetry();
        }
      }

      startCaptionWatch();
      startMicListen();
      if (!(captionsConfirmedOn || isCaptionsUiVisible())) {
        // Keep listening via mic even if captions failed.
        if (!/captions/i.test(lastStatusText)) {
          updateStatus('Listening (mic) — captions not confirmed');
        }
      }
      log('Bridge started');
    });
  }

  function stopBridge() {
    bridgeActive = false;
    clearTimeout(forwardTimer);
    stopCaptionEnableRetry();
    // Keep passive caption watch running so Send Last still works.
    stopMicListen();
    captionsConfirmedOn = false;
    updateStatus('Stopped');
    log('Bridge stopped');
  }

  async function sendLastToChatGPT() {
    if (sendLastToChatGPT._busy) {
      updateStatus('Send already in progress…');
      return;
    }
    sendLastToChatGPT._busy = true;

    try {
      collectCaptionsFromDom();
      let unsent = getUnsentCaptions();

      // If queue looks empty but captions are on screen, rebuild from DOM once.
      if (!unsent.length) {
        const nodes = findCaptionNodes();
        for (const node of nodes) {
          const caption = readCaptionFromNode(node);
          if (!caption) continue;
          const sim = similarityKey(caption.author, caption.text);
          const alreadySent = captionQueue.some((c) => c.sent && (
            c.sim === sim || bareText(c.text) === bareText(caption.text)
          ));
          if (!alreadySent) {
            // Allow re-queue of on-screen lines that never made it into unsent.
            const existing = captionQueue.find((c) => !c.sent && (c.sim === sim || c.key === captionKey(caption.author, caption.text)));
            if (!existing) {
              seenCaptions.delete(captionKey(caption.author, caption.text));
              seenCaptions.delete(sim);
              rememberCaption(caption);
            }
          }
        }
        unsent = getUnsentCaptions();
      }

      if (!unsent.length) {
        updateStatus('No new captions — wait for speech, then Send');
        return;
      }

      let body = collapseDuplicatedPayload(formatCaptionBatch(unsent));
      if (!body.trim()) {
        updateStatus('No new captions — wait for speech, then Send');
        return;
      }

      const lineCount = body.split('\n').filter(Boolean).length;
      updateStatus(`Sending ${lineCount} caption(s)…`);

      const result = await forwardToChatGPT('Manual', '', body, { force: true });
      if (result?.success) {
        markCaptionsSent(unsent);
        updateStatus(`Sent ${lineCount} to ChatGPT`);
      } else {
        updateStatus(result?.error || 'Send failed — open ChatGPT and retry');
      }
    } catch (e) {
      log('Send failed:', e);
      updateStatus('Send failed — reload extension / refresh tabs');
    } finally {
      sendLastToChatGPT._busy = false;
    }
  }

  function positionSettingsMenu(panel, settingsMenu, settingsToggle) {
    if (settingsMenu.style.display !== 'flex') return;
    const rect = settingsToggle.getBoundingClientRect();
    const menuWidth = Math.min(220, window.innerWidth - 16);
    let left = rect.right - menuWidth;
    left = Math.max(8, Math.min(left, window.innerWidth - menuWidth - 8));
    settingsMenu.style.position = 'fixed';
    settingsMenu.style.left = `${left}px`;
    settingsMenu.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`;
    settingsMenu.style.top = 'auto';
    settingsMenu.style.zIndex = '2147483647';
    settingsMenu.style.width = `${menuWidth}px`;
  }

  function buildControls() {
    if (cachedControls && document.contains(cachedControls)) return cachedControls;

    document.getElementById('teams-chatgpt-settings')?.remove();
    document.getElementById('teams-chatgpt-bridge')?.remove();
    cachedControls = null;

    const panel = document.createElement('div');
    panel.id = 'teams-chatgpt-bridge';
    panel.setAttribute('data-dictate-controls', '1');
    panel.style.cssText = `
      display: inline-flex;
      flex-direction: column;
      align-items: stretch;
      gap: 4px;
      margin: 0 4px;
      font-family: "Segoe UI", Arial, sans-serif;
      font-size: 12px;
      vertical-align: middle;
      position: relative;
      z-index: 5;
    `;

    const row = document.createElement('div');
    row.style.cssText = 'display:inline-flex;align-items:center;gap:4px;';

    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.textContent = 'Send';
    sendBtn.title = 'Send new captions to ChatGPT';
    sendBtn.style.cssText = `
      padding: 6px 12px;
      height: 32px;
      color: #fff;
      background: #2563eb;
      border: none;
      border-radius: 999px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      box-sizing: border-box;
    `;
    sendBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      sendLastToChatGPT().catch((err) => {
        log('Send failed:', err);
        updateStatus('Send failed — see console');
      });
    });

    const settingsToggle = document.createElement('button');
    settingsToggle.type = 'button';
    settingsToggle.setAttribute('aria-label', 'Settings');
    settingsToggle.title = 'Settings';
    settingsToggle.textContent = '⚙';
    settingsToggle.style.cssText = `
      width: 32px;
      height: 32px;
      border: none;
      background: rgba(255,255,255,0.14);
      color: #fff;
      border-radius: 999px;
      cursor: pointer;
      padding: 0;
      font-size: 14px;
      line-height: 1;
      flex: 0 0 auto;
    `;

    row.appendChild(sendBtn);
    row.appendChild(settingsToggle);

    const settingsMenu = document.createElement('div');
    settingsMenu.id = 'teams-chatgpt-settings';
    settingsMenu.hidden = true;
    settingsMenu.style.cssText = `
      display: none;
      flex-direction: column;
      gap: 6px;
      background: #fff;
      padding: 8px;
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,.28);
      color: #242424;
    `;

    const btnStyle = 'padding:8px 10px;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;width:100%;box-sizing:border-box;';

    const startBtn = document.createElement('button');
    startBtn.type = 'button';
    startBtn.textContent = 'Start Teams→ChatGPT';
    startBtn.style.cssText = btnStyle + 'background:#6264a7;';
    startBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startBridge();
    });

    const captionsBtn = document.createElement('button');
    captionsBtn.type = 'button';
    captionsBtn.textContent = 'Enable Live Captions';
    captionsBtn.style.cssText = btnStyle + 'background:#107c10;';
    captionsBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      captionsConfirmedOn = false;
      updateStatus('Enabling live captions…');
      const ok = await enableLiveCaptionsWithRetry(3, 2000);
      updateStatus(ok
        ? 'Live captions enabled (or already on)'
        : 'Failed — open More → Language and speech → Show live captions');
    });

    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.textContent = 'Stop';
    stopBtn.style.cssText = btnStyle + 'background:#c4314b;';
    stopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      stopBridge();
    });

    settingsMenu.appendChild(startBtn);
    settingsMenu.appendChild(captionsBtn);
    settingsMenu.appendChild(stopBtn);

    const status = document.createElement('div');
    status.id = 'teams-chatgpt-status';
    status.style.cssText = `
      font-size: 11px;
      color: #242424;
      text-align: center;
      background: #f3f2f1;
      padding: 6px 8px;
      border-radius: 6px;
      line-height: 1.3;
    `;
    status.textContent = lastStatusText || 'Idle';

    const settingsHint = document.createElement('div');
    settingsHint.style.cssText = 'font-size:10px;color:#605e5c;line-height:1.3;';
    settingsHint.textContent = 'Send forwards all new captions since the last successful send.';

    settingsMenu.appendChild(status);
    settingsMenu.appendChild(settingsHint);

    const closeSettings = () => {
      settingsMenu.style.display = 'none';
      settingsMenu.hidden = true;
      settingsToggle.style.background = 'rgba(255,255,255,0.14)';
    };

    settingsToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = settingsMenu.style.display === 'flex';
      if (open) {
        closeSettings();
      } else {
        settingsMenu.style.display = 'flex';
        settingsMenu.hidden = false;
        settingsToggle.style.background = 'rgba(255,255,255,0.28)';
        // Prefer body portal so menu isn't clipped by Teams overflow.
        if (settingsMenu.parentElement !== document.body) {
          document.body.appendChild(settingsMenu);
        }
        positionSettingsMenu(panel, settingsMenu, settingsToggle);
      }
    });

    document.addEventListener('click', (e) => {
      if (settingsMenu.style.display !== 'flex') return;
      if (settingsMenu.contains(e.target) || settingsToggle.contains(e.target)) return;
      closeSettings();
    }, true);

    window.addEventListener('resize', () => {
      positionSettingsMenu(panel, settingsMenu, settingsToggle);
    });

    panel.appendChild(row);
    // Keep a reference; menu moves to body when open.
    panel._settingsMenu = settingsMenu;
    panel._settingsToggle = settingsToggle;
    cachedControls = panel;
    return panel;
  }

  function controlsAreBeforeMore(panel, moreBtn) {
    if (!panel || !moreBtn || !moreBtn.parentElement) return false;
    return panel.parentElement === moreBtn.parentElement && panel.nextSibling === moreBtn;
  }

  function mountControls(force = false) {
    const panel = buildControls();
    const moreBtn = findMoreButton();

    if (moreBtn && moreBtn.parentElement) {
      if (!force && controlsAreBeforeMore(panel, moreBtn)) {
        const status = document.getElementById('teams-chatgpt-status');
        if (status && status.textContent !== lastStatusText) status.textContent = lastStatusText;
        return;
      }
      // Clear fixed fallback styles when attaching to toolbar.
      delete panel.dataset.mountMode;
      panel.style.position = '';
      panel.style.bottom = '';
      panel.style.left = '';
      panel.style.transform = '';
      panel.style.zIndex = '5';
      panel.style.display = 'inline-flex';
      panel.style.flexDirection = 'column';
      panel.style.margin = '0 4px';
      moreBtn.parentElement.insertBefore(panel, moreBtn);
      return;
    }

    // Fallback: bottom-center overlay when not in a meeting yet.
    if (!document.body) return;
    if (!force && panel.parentElement === document.body && panel.dataset.mountMode === 'fallback') return;

    panel.dataset.mountMode = 'fallback';
    panel.style.cssText = `
      position: fixed;
      bottom: 72px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483646;
      display: inline-flex;
      flex-direction: column;
      align-items: stretch;
      gap: 4px;
      font-family: "Segoe UI", Arial, sans-serif;
      font-size: 12px;
    `;
    if (panel.parentElement !== document.body) document.body.appendChild(panel);
  }

  function startControlsMountWatch() {
    if (controlsMountTimer) return;
    controlsMountTimer = setInterval(() => {
      try {
        mountControls(false);
      } catch (e) {
        log('Controls remount failed:', e);
      }
    }, 1500);
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
    mountControls(true);
    startControlsMountWatch();
    startCaptionWatch();
    log('Teams bridge ready (controls on meeting bar)');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  setTimeout(init, 1500);
})();
