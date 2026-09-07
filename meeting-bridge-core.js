/**
 * Shared meeting-caption → ChatGPT bridge core.
 *
 * Adapter checklist for new platforms:
 * 1. Add manifest host_permissions + content_scripts (caption-utils.js, core, *-bridge.js; all_frames if needed)
 * 2. Register platform in background.js MEETING_PLATFORMS (same file order)
 * 3. Implement *-bridge.js with: isInMeeting, isLikelyMeetingFrame, collectCaptionsFromDom,
 *    isCaptionsUiVisible, enableLiveCaptions, hideCaptionOverlay (optional)
 * 4. Manual test: join meeting, enable captions, Send on desktop overlay
 *
 * Requires caption-utils.js (DictateCaptionUtils) to load first.
 * See docs/ARCHITECTURE.md and docs/DEVELOPMENT.md.
 */
(function () {
  const globalRoot = typeof window !== 'undefined' ? window : self;

  const captionUtils = (function loadCaptionUtils() {
    if (typeof require === 'function') {
      try { return require('./caption-utils'); } catch { /* content script */ }
    }
    return globalRoot.DictateCaptionUtils;
  })();

  if (!captionUtils) {
    console.error('[Dictate] caption-utils.js must load before meeting-bridge-core.js');
    return;
  }

  const {
    normalizeCaptionText,
    normalizeAuthor,
    bareText,
    captionKey,
    similarityKey,
    shouldAutoForward,
    formatMessage,
    formatSendLine,
    linesRelated,
    emptyTranscript,
    mergeTranscriptLine,
    takeUnsentChunkFrom,
    markLinesSent,
    SEND_CHUNK_CHARS,
    isSpokenCaptionText,
    parseZoomMeetingId,
    parseZoomPasscode,
    buildZoomJoinUrl
  } = captionUtils;

  const DESKTOP_BRIDGE = 'http://127.0.0.1:38473';
  const SEND_QUEUE_ACTIONS = ['sendMeetingQueue', 'sendTeamsQueue'];
  const START_ACTIONS = ['startMeetingBridge', 'startTeamsBridge'];
  const STOP_ACTIONS = ['stopMeetingBridge', 'stopTeamsBridge'];
  const ENABLE_CAPTIONS_ACTIONS = ['enableMeetingCaptions', 'enableTeamsCaptions'];
  const STATUS_ACTIONS = ['getMeetingBridgeStatus', 'getTeamsBridgeStatus'];

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function walkShadowRoots(root, fn) {
    const direct = fn(root);
    if (direct) return direct;
    if (!root.querySelectorAll) return null;
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
    const x = Math.floor(window.innerWidth / 2);
    const y = Math.max(40, window.innerHeight - 40);
    const target = document.elementFromPoint(x, y) || document.body;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, composed: true };
    target.dispatchEvent(new MouseEvent('mousemove', opts));
    document.body.dispatchEvent(new MouseEvent('mousemove', opts));
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

  function findByLabel(regex, candidates) {
    for (const el of candidates) {
      const label = elementLabel(el);
      if (label && regex.test(label)) return el;
    }
    return null;
  }

  function findMenuItems() {
    return queryAllDeep(
      '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], button[role="menuitem"]'
    ).filter(isVisible);
  }

  function waitForByLabelOrText(selector, patterns, timeoutMs = 2000) {
    return waitFor(() => {
      const nodes = document.querySelectorAll(selector);
      for (const el of nodes) {
        if (!isVisible(el)) continue;
        const label = elementLabel(el);
        for (const re of patterns) {
          if (re.test(label)) return el;
        }
      }
      return null;
    }, timeoutMs);
  }

  function collapseDuplicatedPayload(text) {
    let t = (text || '').trim();
    if (!t) return t;

    if (t.length >= 20) {
      const mid = Math.floor(t.length / 2);
      const a = t.slice(0, mid).trim();
      const b = t.slice(mid).trim();
      if (a && a === b) t = a;
    }

    let lines = t.split(/\n+/).map((l) => l.trim()).filter(Boolean);

    if (lines.length >= 2 && lines.length % 2 === 0) {
      const half = lines.length / 2;
      const first = lines.slice(0, half).join('\n');
      const second = lines.slice(half).join('\n');
      if (first === second) lines = lines.slice(0, half);
    }

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

  /**
   * @param {object} config Platform adapter configuration
   */
  function createPlatformBridge(config) {
    if (globalRoot[config.globalFlag]) {
      console.log(config.logPrefix, 'Already loaded — skipping duplicate inject');
      return;
    }
    globalRoot[config.globalFlag] = true;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const captionSourceLabel = config.captionSourceLabel || 'Meeting caption';
    const captionEnableHint = config.captionEnableHint || 'Failed — enable live captions manually';

    let bridgeActive = false;
    let recognition = null;
    let seenCaptions = new Set();
    let lastForwarded = '';
    let captionQueue = [];
    let forwardTimer = null;
    let captionEnableTimer = null;
    let captionsConfirmedOn = false;
    let enableCaptionsInFlight = false;
    let captionPollTimer = null;
    let captionScanTimer = null;
    let captionScanInFlight = false;
    let lastStatusText = 'Idle';
    let answerOverlayCollapsed = false;
    let desktopSendPollTimer = null;
    let desktopSendInFlight = false;

    function log(...args) {
      console.log(config.logPrefix, ...args);
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
        if (data.autoForwardMode == null) {
          data.autoForwardMode = data.autoForwardQuestions === false ? 'off' : 'questions';
        }
        if (data.forwardPrefix === 'Answer this meeting question: ' || data.forwardPrefix === 'Answer this meeting question:') {
          data.forwardPrefix = '';
          chrome.storage.local.set({ forwardPrefix: '' });
        }
        return data;
      } catch {
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
      log('Status:', lastStatusText);
    }

    function rememberCaption(caption) {
      const author = normalizeAuthor(caption?.author);
      const text = normalizeCaptionText(caption?.text);
      if (!isSpokenCaptionText(text)) return null;

      const key = captionKey(author, text);
      const sim = similarityKey(author, text);
      const bare = bareText(text);

      if (seenCaptions.has(key) || seenCaptions.has(sim)) return null;

      for (let i = captionQueue.length - 1; i >= 0; i--) {
        const existing = captionQueue[i];
        if (!linesRelated(existing, author, text)) continue;

        if (text.length > existing.text.length) {
          persistTranscript({ author, text, key, sim });
        }

        if (existing.sent) {
          const existingBare = bareText(existing.text);
          const isGrowth = bare.startsWith(existingBare) || existingBare.startsWith(bare);
          if (isGrowth) {
            seenCaptions.add(key);
            seenCaptions.add(sim);
            return null;
          }
          continue;
        }

        if (text.length > existing.text.length) {
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
      persistTranscript(entry);
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
      for (const sent of entries || []) {
        seenCaptions.add(captionKey(sent.author, sent.text));
        seenCaptions.add(sent.sim || similarityKey(sent.author, sent.text));
      }
      markLinesSent(captionQueue, entries);
    }

    function formatCaptionBatch(entries) {
      return dedupeCaptionEntries(entries)
        .map((c) => (c.author ? `${c.author}: ${c.text}` : c.text))
        .join('\n');
    }

    const bridgeHelpers = {
      rememberCaption,
      normalizeCaptionText,
      normalizeAuthor,
      bareText,
      captionKey,
      similarityKey,
      seenCaptions,
      captionQueue,
      log,
      updateStatus,
      setCaptionsConfirmed: (v) => { captionsConfirmedOn = v; },
      getCaptionsConfirmed: () => captionsConfirmedOn
    };

    function safeSendResponse(sendResponse, data) {
      if (!sendResponse) return;
      try {
        sendResponse(data);
      } catch {
        /* message channel already closed */
      }
    }

    async function isDesktopBridgeUp() {
      try {
        const res = await fetch(`${DESKTOP_BRIDGE}/health`, { method: 'GET' });
        return res.ok;
      } catch {
        return false;
      }
    }

    async function postToDesktopBridge(message) {
      const res = await fetch(`${DESKTOP_BRIDGE}/bridge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message)
      });
      return res.json();
    }

    let transcriptWriteTimer = null;
    let pendingTranscriptLines = [];

    function persistTranscript(entry) {
      if (!entry?.text) return;
      const line = {
        at: Date.now(),
        author: entry.author || '',
        text: entry.text,
        platform: config.id || '',
        source: 'browser',
        sent: false
      };
      pendingTranscriptLines.push(line);

      isDesktopBridgeUp().then((up) => {
        if (!up) return;
        return postToDesktopBridge({ action: 'appendTranscript', line });
      }).catch(() => {});

      if (transcriptWriteTimer) return;
      transcriptWriteTimer = setTimeout(() => {
        flushStoredTranscript().catch((e) => log('transcript persist failed:', e));
      }, 400);
    }

    async function flushStoredTranscript() {
      if (transcriptWriteTimer) {
        clearTimeout(transcriptWriteTimer);
        transcriptWriteTimer = null;
      }
      const batch = pendingTranscriptLines.splice(0, pendingTranscriptLines.length);
      try {
        const data = await chrome.storage.local.get({
          meetingTranscript: emptyTranscript()
        });
        const t = data.meetingTranscript && Array.isArray(data.meetingTranscript.lines)
          ? data.meetingTranscript
          : emptyTranscript();
        for (const next of batch) mergeTranscriptLine(t, next, { platform: config.id, source: 'browser' });
        await chrome.storage.local.set({ meetingTranscript: t });
        return t;
      } catch (e) {
        log('transcript persist failed:', e);
        return emptyTranscript();
      }
    }

    async function markStoredTranscriptSent(entries) {
      const t = await flushStoredTranscript();
      markLinesSent(t.lines, entries);
      await chrome.storage.local.set({ meetingTranscript: t });
      isDesktopBridgeUp().then((up) => {
        if (!up) return;
        return postToDesktopBridge({ action: 'markTranscriptSent', lines: entries });
      }).catch(() => {});
    }

    async function sendToExtensionBackground(message) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await chrome.runtime.sendMessage(message);
        } catch (e) {
          if (attempt >= 2) throw e;
          await sleep(500);
        }
      }
      return null;
    }

    function startExtensionKeepalive() {
      try {
        const port = chrome.runtime.connect({ name: 'dictate-keepalive' });
        port.onDisconnect.addListener(() => {
          setTimeout(startExtensionKeepalive, 1500);
        });
      } catch {
        /* extension context unavailable */
      }
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

      if (!force && payload === lastForwarded) {
        log('Skipping duplicate auto-forward');
        return { success: false, error: 'duplicate' };
      }
      lastForwarded = payload;

      updateStatus('Sending to ChatGPT…');
      log('Forwarding:', payload);

      try {
        let response;
        if (await isDesktopBridgeUp()) {
          response = await Promise.race([
            postToDesktopBridge({ action: 'forwardToChatGPT', text: payload }),
            sleep(35000).then(() => ({ success: false, error: 'Forward timed out — check Dictate Desktop' }))
          ]);
        } else {
          response = await Promise.race([
            sendToExtensionBackground({
              action: 'forwardToChatGPT',
              text: payload
            }),
            sleep(22000).then(() => ({ success: false, error: 'Forward timed out — reload extension' }))
          ]);
        }
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

    function isCaptionsUiVisible() {
      if (config.isCaptionsUiVisible) return config.isCaptionsUiVisible();
      return false;
    }

    async function enableLiveCaptionsWithRetry(maxAttempts = 4, intervalMs = 2500) {
      if (captionsConfirmedOn || isCaptionsUiVisible()) {
        captionsConfirmedOn = true;
        return true;
      }

      if (config.detectCaptionsAlreadyOn) {
        try {
          if (await config.detectCaptionsAlreadyOn(bridgeHelpers)) {
            captionsConfirmedOn = true;
            return true;
          }
        } catch (e) {
          log('Caption detection failed:', e);
        }
      }

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (captionsConfirmedOn || isCaptionsUiVisible()) return true;

        updateStatus(`Enabling live captions (${attempt}/${maxAttempts})…`);
        const ok = await config.enableLiveCaptions(bridgeHelpers);
        if (ok) {
          captionsConfirmedOn = true;
          return true;
        }

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
        const ok = await config.enableLiveCaptions(bridgeHelpers);
        if (ok) captionsConfirmedOn = true;
      }, 4000);
    }

    function scanCaptions() {
      if (captionScanInFlight) return;
      captionScanInFlight = true;
      try {
        if (config.hideCaptionOverlay) config.hideCaptionOverlay();
        const beforeCount = captionQueue.length;
        config.collectCaptionsFromDom(bridgeHelpers);

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
            forwardToChatGPT(captionSourceLabel, entry.author, entry.text).then((result) => {
              if (result?.success) {
                markCaptionsSent([entry]);
                markStoredTranscriptSent([entry]);
              }
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
      captionPollTimer = setInterval(scheduleCaptionScan, 1200);
      log('Live caption watch started (polling)');
    }

    function stopCaptionWatch() {
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

        const entry = rememberCaption({ author: 'You', text: finalText });
        log('Mic captured:', finalText);
        const pending = getUnsentCaptions().length;
        updateStatus(`${pending} new · You: ${finalText.slice(0, 40)}${finalText.length > 40 ? '…' : ''}`);

        getSettings().then((settings) => {
          if (!entry || !shouldAutoForward(finalText, settings)) return;
          forwardToChatGPT('Microphone', 'You', finalText).then((result) => {
            if (result?.success) {
              markCaptionsSent([entry]);
              markStoredTranscriptSent([entry]);
            }
          });
        });
      };

      recognition.onerror = (event) => {
        if (event.error === 'no-speech' || event.error === 'aborted') return;
        log('Mic error:', event.error);
        if (event.error === 'not-allowed') updateStatus('Microphone blocked');
      };

      recognition.onend = () => {
        if (bridgeActive) {
          setTimeout(() => {
            try { recognition.start(); } catch { /* already running */ }
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
      try { recognition.stop(); } catch { /* ignore */ }
    }

    async function reportSendResultToDesktop(result) {
      try {
        await fetch(`${DESKTOP_BRIDGE}/bridge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'reportSendResult', ...(result || { success: false }) })
        });
      } catch (e) {
        log('reportSendResult failed:', e);
      }
    }

    async function pollDesktopSendRequest() {
      if (desktopSendInFlight || sendLastToChatGPT._busy) return;

      let claimed = false;
      let result = { success: false, sent: false, status: lastStatusText };

      try {
        const res = await fetch(`${DESKTOP_BRIDGE}/pending`);
        if (!res.ok) return;
        const data = await res.json();
        const actions = Array.isArray(data.actions) ? data.actions : [];
        if (!SEND_QUEUE_ACTIONS.some((a) => actions.includes(a))) return;

        const claimRes = await fetch(`${DESKTOP_BRIDGE}/bridge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'claimSendQueue' })
        });
        const claimData = await claimRes.json().catch(() => ({}));
        if (!claimData?.success) return;

        claimed = true;
        desktopSendInFlight = true;
        ensureBridgeStarted();
        if (!captionsConfirmedOn && !isCaptionsUiVisible()) {
          await enableLiveCaptionsWithRetry(1, 1000);
        }
        result = await sendLastToChatGPT();
      } catch (e) {
        log('Desktop send poll failed:', e);
        result = { success: false, sent: false, error: String(e), status: lastStatusText };
      } finally {
        if (claimed) {
          try {
            await reportSendResultToDesktop(result);
          } catch (e) {
            log('reportSendResult failed:', e);
          }
        }
        desktopSendInFlight = false;
      }
    }

    function startDesktopSendPoll() {
      if (desktopSendPollTimer) return;
      desktopSendPollTimer = setInterval(pollDesktopSendRequest, 400);
      pollDesktopSendRequest();
    }

    function startBridge() {
      if (bridgeActive) return;
      bridgeActive = true;
      lastForwarded = '';
      captionsConfirmedOn = isCaptionsUiVisible();

      getSettings().then(async (settings) => {
        if (settings.autoEnableCaptions !== false) {
          const enabled = await enableLiveCaptionsWithRetry();
          if (enabled) {
            updateStatus('Live captions on — listening…');
          } else {
            updateStatus('Could not enable captions — try manually');
            startCaptionEnableRetry();
          }
        }

        startCaptionWatch();
        startMicListen();
        if (!(captionsConfirmedOn || isCaptionsUiVisible())) {
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
      stopMicListen();
      captionsConfirmedOn = false;
      updateStatus('Stopped');
      log('Bridge stopped');
    }

    async function sendLastToChatGPT() {
      if (sendLastToChatGPT._busy) {
        updateStatus('Send in progress…');
        return { success: false, sent: false, status: lastStatusText };
      }
      sendLastToChatGPT._busy = true;

      try {
        config.collectCaptionsFromDom(bridgeHelpers);
        if (config.rebuildCaptionsForSend) {
          config.rebuildCaptionsForSend(bridgeHelpers);
        }

        const stored = await flushStoredTranscript();
        const chunk = takeUnsentChunkFrom(stored.lines, SEND_CHUNK_CHARS);
        let unsent = chunk.lines;
        if (!unsent.length) {
          unsent = getUnsentCaptions();
        }

        if (!unsent.length) {
          updateStatus('No new captions yet — turn on live captions and wait for speech');
          return {
            success: false,
            sent: false,
            status: lastStatusText,
            error: 'No new captions yet — in the Chrome meeting, turn on Captions / Live Transcript, wait for speech, then click Send'
          };
        }

        let body = collapseDuplicatedPayload(unsent.map((c) => formatSendLine(c)).filter(Boolean).join('\n'));
        if (!body.trim()) {
          updateStatus('No new captions yet — turn on live captions and wait for speech');
          return {
            success: false,
            sent: false,
            status: lastStatusText,
            error: 'No new captions yet — in the Chrome meeting, turn on Captions / Live Transcript, wait for speech, then click Send'
          };
        }

        const lineCount = unsent.length;
        const remaining = chunk.remaining;
        updateStatus(`Sending ${lineCount} from transcript…`);

        const result = await forwardToChatGPT('Manual', '', body, { force: true });
        if (result?.success) {
          markCaptionsSent(unsent);
          markLinesSent(stored.lines, unsent);
          await chrome.storage.local.set({ meetingTranscript: stored });
          isDesktopBridgeUp().then((up) => {
            if (!up) return;
            return postToDesktopBridge({ action: 'markTranscriptSent', lines: unsent });
          }).catch(() => {});
          updateStatus(remaining
            ? `Sent ${lineCount} from transcript · ${remaining} still queued, click Send again`
            : `Sent ${lineCount} from transcript`);
          return { success: true, sent: true, status: lastStatusText, lineCount, remaining };
        }
        updateStatus(result?.error || 'Send failed');
        return { success: false, sent: false, status: lastStatusText, error: result?.error || 'Send failed' };
      } catch (e) {
        log('Send failed:', e);
        updateStatus('Send failed');
        return { success: false, sent: false, status: lastStatusText, error: String(e) };
      } finally {
        sendLastToChatGPT._busy = false;
      }
    }

    function ensureAnswerOverlay() {
      let overlay = document.getElementById('dictate-chatgpt-overlay');
      if (overlay) return overlay;

      overlay = document.createElement('div');
      overlay.id = 'dictate-chatgpt-overlay';
      overlay.style.cssText = `
        position: fixed;
        top: 12px;
        right: 12px;
        width: min(380px, calc(100vw - 24px));
        max-height: min(420px, calc(100vh - 100px));
        z-index: 2147483646;
        font-family: "Segoe UI", Arial, sans-serif;
        font-size: 13px;
        display: flex;
        flex-direction: column;
        background: rgba(20, 20, 24, 0.94);
        color: #f3f2f1;
        border-radius: 10px;
        box-shadow: 0 8px 32px rgba(0,0,0,.45);
        overflow: hidden;
        opacity: 0;
        pointer-events: auto;
        transition: opacity 0.2s ease;
      `;

      const header = document.createElement('div');
      header.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 10px;
        background: rgba(0,0,0,.25);
        cursor: move;
        user-select: none;
      `;

      const title = document.createElement('span');
      title.textContent = 'ChatGPT';
      title.style.cssText = 'font-weight: 600; font-size: 12px;';

      const headerBtns = document.createElement('div');
      headerBtns.style.cssText = 'display:flex;gap:4px;';

      const collapseBtn = document.createElement('button');
      collapseBtn.type = 'button';
      collapseBtn.textContent = '−';
      collapseBtn.title = 'Collapse';
      collapseBtn.style.cssText = `
        border: none; background: transparent; color: #fff; cursor: pointer;
        width: 24px; height: 24px; font-size: 16px; line-height: 1; border-radius: 4px;
      `;

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.textContent = '×';
      closeBtn.title = 'Hide';
      closeBtn.style.cssText = collapseBtn.style.cssText;

      headerBtns.appendChild(collapseBtn);
      headerBtns.appendChild(closeBtn);
      header.appendChild(title);
      header.appendChild(headerBtns);

      const body = document.createElement('div');
      body.id = 'dictate-chatgpt-overlay-body';
      body.style.cssText = `
        padding: 10px 12px;
        overflow-y: auto;
        line-height: 1.45;
        flex: 1;
      `;

      const questionEl = document.createElement('div');
      questionEl.id = 'dictate-chatgpt-overlay-question';
      questionEl.style.cssText = 'font-size: 11px; color: #a19f9d; margin-bottom: 8px; white-space: pre-wrap;';

      const answerEl = document.createElement('div');
      answerEl.id = 'dictate-chatgpt-overlay-answer';
      answerEl.style.cssText = 'white-space: pre-wrap; word-break: break-word;';

      body.appendChild(questionEl);
      body.appendChild(answerEl);
      overlay.appendChild(header);
      overlay.appendChild(body);

      collapseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        answerOverlayCollapsed = !answerOverlayCollapsed;
        body.style.display = answerOverlayCollapsed ? 'none' : 'block';
        collapseBtn.textContent = answerOverlayCollapsed ? '+' : '−';
      });

      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        overlay.style.opacity = '0';
        overlay.style.pointerEvents = 'none';
        setTimeout(() => { overlay.style.display = 'none'; }, 200);
      });

      let drag = null;
      header.addEventListener('mousedown', (e) => {
        if (e.target === collapseBtn || e.target === closeBtn) return;
        drag = { x: e.clientX, y: e.clientY, left: overlay.offsetLeft, top: overlay.offsetTop };
        overlay.style.right = 'auto';
      });
      document.addEventListener('mousemove', (e) => {
        if (!drag) return;
        overlay.style.left = `${Math.max(0, drag.left + (e.clientX - drag.x))}px`;
        overlay.style.top = `${Math.max(0, drag.top + (e.clientY - drag.y))}px`;
      });
      document.addEventListener('mouseup', () => { drag = null; });

      document.body.appendChild(overlay);
      return overlay;
    }

    function showChatGPTAnswerOverlay({ question = '', answer = '', streaming = false } = {}) {
      if (window.__DICTATE_USE_NATIVE_OVERLAY__) return;
      const overlay = ensureAnswerOverlay();
      const questionEl = document.getElementById('dictate-chatgpt-overlay-question');
      const answerEl = document.getElementById('dictate-chatgpt-overlay-answer');
      const body = document.getElementById('dictate-chatgpt-overlay-body');

      if (questionEl && question) {
        const q = question.length > 240 ? `${question.slice(0, 240)}…` : question;
        questionEl.textContent = q;
      }
      if (answerEl) {
        answerEl.textContent = answer || (streaming ? '…' : '');
      }
      if (body && answerOverlayCollapsed) {
        body.style.display = 'block';
        answerOverlayCollapsed = false;
        const collapseBtn = overlay.querySelector('button[title="Collapse"]');
        if (collapseBtn) collapseBtn.textContent = '−';
      }

      overlay.style.display = 'flex';
      overlay.style.pointerEvents = 'auto';
      overlay.style.opacity = '0';
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          overlay.style.opacity = '1';
        });
      });

      if (streaming) {
        updateStatus('ChatGPT answering…');
      } else if (answer && answer !== 'Waiting for ChatGPT…') {
        updateStatus('Answer on overlay');
      }
    }

    function isInMeeting() {
      return config.isInMeeting();
    }

    function isLikelyMeetingFrame() {
      return config.isLikelyMeetingFrame();
    }

    function ensureBridgeStarted() {
      if (bridgeActive) return;
      if (!isLikelyMeetingFrame() && !isInMeeting()) return;
      startBridge();
    }

    function matchesAction(action, list) {
      return list.includes(action);
    }

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.action === 'ping') {
        sendResponse({ success: true, pong: true });
        return false;
      }
      if (message.action === 'showChatGPTAnswer') {
        if (!window.__DICTATE_USE_NATIVE_OVERLAY__) {
          showChatGPTAnswerOverlay(message);
        }
        sendResponse({ success: true });
        return false;
      }
      if (matchesAction(message.action, START_ACTIONS)) {
        startBridge();
        sendResponse({ success: true });
        return false;
      }
      if (matchesAction(message.action, STOP_ACTIONS)) {
        stopBridge();
        sendResponse({ success: true });
        return false;
      }
      if (matchesAction(message.action, ENABLE_CAPTIONS_ACTIONS)) {
        safeSendResponse(sendResponse, { success: true, started: true, status: lastStatusText });
        (async () => {
          captionsConfirmedOn = false;
          updateStatus('Enabling live captions…');
          const ok = await enableLiveCaptionsWithRetry(3, 2000);
          updateStatus(ok ? 'Live captions enabled (or already on)' : captionEnableHint);
        })().catch((e) => log('enableLiveCaptions failed:', e));
        return false;
      }
      if (matchesAction(message.action, STATUS_ACTIONS)) {
        const pageUrl = String(location?.href || '');
        const meetingId = parseZoomMeetingId?.(pageUrl) || '';
        const passcode = parseZoomPasscode?.(pageUrl) || '';
        const joinUrl = config.id === 'zoom'
          ? (buildZoomJoinUrl?.({ meetingId, passcode }) || 'https://app.zoom.us/wc/join')
          : '';
        sendResponse({
          success: true,
          status: lastStatusText || 'Idle',
          bridgeActive,
          inMeeting: isInMeeting(),
          platform: config.id,
          unsentCount: getUnsentCaptions().length,
          captionsVisible: isCaptionsUiVisible(),
          meetingId,
          passcode,
          joinUrl,
          joinLabel: meetingId ? `Open Zoom ${meetingId} in Chrome` : 'Open Zoom in Chrome'
        });
        return false;
      }
      if (matchesAction(message.action, SEND_QUEUE_ACTIONS)) {
        (async () => {
          let result = { success: false, sent: false, status: lastStatusText };
          try {
            ensureBridgeStarted();
            result = await sendLastToChatGPT();
          } catch (e) {
            result = { success: false, sent: false, error: String(e), status: lastStatusText };
          }
          await reportSendResultToDesktop(result);
          safeSendResponse(sendResponse, result);
        })();
        return true;
      }
    });

    function init() {
      if (config.onInit) config.onInit();

      const bootCaptions = () => {
        if (isInMeeting() || isLikelyMeetingFrame()) {
          ensureBridgeStarted();
          startCaptionWatch();
          return true;
        }
        return false;
      };
      if (!bootCaptions()) {
        let attempts = 0;
        const retry = setInterval(() => {
          attempts += 1;
          if (bootCaptions() || attempts >= 60) clearInterval(retry);
        }, 2000);
      }

      log('Bridge ready');
      startExtensionKeepalive();
      startDesktopSendPoll();
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
      init();
    }

    setTimeout(init, 1500);
  }

  globalRoot.DictateMeetingBridge = {
    createPlatformBridge,
    shouldAutoForward,
    normalizeCaptionText,
    bareText,
    captionKey,
    similarityKey,
    collapseDuplicatedPayload,
    dom: {
      sleep,
      walkShadowRoots,
      queryAllDeep,
      isVisible,
      clickElement,
      elementLabel,
      hoverElement,
      revealMeetingControls,
      waitFor,
      closeOpenMenus,
      findByLabel,
      findMenuItems,
      waitForByLabelOrText
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = globalRoot.DictateMeetingBridge;
  }
})();
