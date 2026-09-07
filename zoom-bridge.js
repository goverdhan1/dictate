(function () {
  const { createPlatformBridge, dom } = window.DictateMeetingBridge;
  const {
    sleep,
    queryAllDeep,
    walkShadowRoots,
    isVisible,
    clickElement,
    revealMeetingControls,
    waitFor,
    closeOpenMenus,
    findByLabel,
    findMenuItems
  } = dom;

  const CAPTION_LINE_SELECTORS = [
    '.live-transcription-subtitle__item',
    '.live-transcription-subtitle-item',
    '[class*="live-transcription-subtitle__item"]',
    '[class*="live-transcription-subtitle-item"]',
    '[class*="live-transcription-subtitle"]',
    '[class*="live-transcript"]',
    '[class*="closed-caption"]',
    '[class*="caption-text"]',
    '[class*="cc-text"]',
    '[class*="subtitle-text"]',
    '[class*="transcript-text"]',
    '[class*="video-caption"]',
    '[class*="VideoCaption"]',
    '.caption-line span',
    '.captions-box span',
    '.zm-closed-caption',
    '#live-transcription-subtitle',
    '#live-transcription-subtitle span',
    '#live-caption',
    '#live-caption span',
    '[data-testid*="caption"]',
    '[data-testid*="transcript"]'
  ].join(', ');

  const CAPTION_CONTAINER_SELECTORS = [
    '.captions-box',
    '[class*="live-transcription"]',
    '[class*="live-transcript"]',
    '#live-transcription-subtitle',
    '[class*="live-transcription-subtitle"]',
    '[class*="closed-caption"]',
    '[class*="transcript-panel"]',
    '[class*="caption-panel"]',
    '[class*="video-caption"]',
    '.zm-closed-caption',
    '#live-caption',
    '#aria-notify-area',
    '[aria-label*="live transcript" i]',
    '[aria-label*="caption" i]',
    '[aria-label*="subtitle" i]',
    '[role="log"]',
    '[aria-live="polite"]',
    '[aria-live="assertive"]'
  ].join(', ');

  const SPEAKER_SELECTORS = [
    '[class*="live-transcription-subtitle__name"]',
    '[class*="live-transcription-subtitle__user"]',
    '[class*="subtitle-name"]',
    '[class*="speaker-name"]',
    '[class*="caption-name"]',
    '[class*="display-name"]'
  ].join(', ');

  const CAPTIONS_ON_PATTERNS = [
    /^\s*(Show\s+)?Captions?\s*$/i,
    /Live\s+Transcription/i,
    /Subtitle/i,
    /Closed\s+Caption/i
  ];
  const SHOW_CAPTIONS_PATTERNS = [
    /Show\s+Captions?/i,
    /Show\s+Subtitles?/i,
    /Turn\s+on\s+Captions?/i,
    /Enable\s+Captions?/i,
    /Enable\s+Auto-Transcription/i,
    /Start\s+Captions?/i
  ];

  const UI_NOISE_RE = /^(show|hide|turn on|turn off|enable|disable|live transcript(ion)?|captions?|cc|subtitles?|more|ok|close|settings)$/i;
  const TOOLBAR_RE = /^(mute|unmute|start video|stop video|participants|chat|share|record|security|reactions|apps|whiteboards|breakout|polls|support|leave|end|audio|video)$/i;

  let lastScrapeDebug = '';

  function getSearchRoots() {
    const roots = [document];
    const ids = ['zmmtg-root', 'wc-container', 'wc-content', 'foot-bar'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) roots.push(el);
    }
    return roots;
  }

  function isCaptionLikeText(text) {
    const t = (text || '').trim();
    if (t.length < 2) return false;
    if (UI_NOISE_RE.test(t)) return false;
    if (TOOLBAR_RE.test(t)) return false;
    if (/^[\d\s:APM]+$/i.test(t) && t.length < 12) return false;
    const utils = window.DictateCaptionUtils;
    if (utils?.isSpokenCaptionText && !utils.isSpokenCaptionText(t)) return false;
    return true;
  }

  function readSpeakerNear(el) {
    const row = el.closest?.(
      '[class*="live-transcription"], [class*="subtitle"], [class*="caption"], [class*="transcript"], [role="log"]'
    ) || el.parentElement;
    if (!row) return '';
    const spk = row.querySelector(SPEAKER_SELECTORS);
    return (spk?.textContent || '').trim();
  }

  function parseSpeakerTextLines(lines) {
    const results = [];
    const cleaned = lines.map((l) => l.trim()).filter(isCaptionLikeText);
    for (let i = 0; i < cleaned.length; i++) {
      const line = cleaned[i];
      const next = cleaned[i + 1];
      if (
        next
        && line.length <= 48
        && !/[.!?]$/.test(line)
        && next.length >= line.length
        && !line.includes(':')
      ) {
        results.push({ author: line, text: next });
        i += 1;
      } else {
        const m = line.match(/^([^:]{1,48}):\s*(.+)$/);
        if (m && isCaptionLikeText(m[2])) {
          results.push({ author: m[1].trim(), text: m[2].trim() });
        } else {
          results.push({ author: '', text: line });
        }
      }
    }
    return results;
  }

  function collectFromElements(helpers, elements) {
    const batch = [];
    const seenText = new Set();
    for (const el of elements) {
      const text = helpers.normalizeCaptionText(el.textContent || '');
      if (!isCaptionLikeText(text)) continue;
      const bare = helpers.bareText(text);
      if (seenText.has(bare)) continue;
      seenText.add(bare);
      const author = helpers.normalizeAuthor(readSpeakerNear(el));
      batch.push({ author, text });
    }
    return batch;
  }

  function collectFromContainers(helpers, containers) {
    const batch = [];
    const seenText = new Set();
    for (const container of containers) {
      const lines = (container.innerText || '')
        .split('\n')
        .map((l) => helpers.normalizeCaptionText(l))
        .filter(isCaptionLikeText);
      for (const entry of parseSpeakerTextLines(lines)) {
        const bare = helpers.bareText(entry.text);
        if (seenText.has(bare)) continue;
        seenText.add(bare);
        batch.push(entry);
      }
    }
    return batch;
  }

  function queryCaptionElements() {
    const results = [];
    const seen = new Set();

    function addEl(el) {
      if (!el || seen.has(el)) return;
      seen.add(el);
      results.push(el);
    }

    for (const root of getSearchRoots()) {
      try {
        root.querySelectorAll(CAPTION_LINE_SELECTORS).forEach(addEl);
      } catch {
        /* ignore */
      }
      queryAllDeep(CAPTION_LINE_SELECTORS, root, 3000).forEach(addEl);
    }

    const zmmtg = document.getElementById('zmmtg-root');
    if (zmmtg) {
      walkShadowRoots(zmmtg, (r) => {
        try {
          r.querySelectorAll(CAPTION_LINE_SELECTORS).forEach(addEl);
          r.querySelectorAll('[aria-live], [role="log"]').forEach(addEl);
        } catch {
          /* ignore */
        }
        return null;
      });
    }

    return results;
  }

  function queryCaptionContainers() {
    const results = [];
    const seen = new Set();

    function addEl(el) {
      if (!el || seen.has(el)) return;
      seen.add(el);
      results.push(el);
    }

    for (const root of getSearchRoots()) {
      try {
        root.querySelectorAll(CAPTION_CONTAINER_SELECTORS).forEach(addEl);
      } catch {
        /* ignore */
      }
      queryAllDeep(CAPTION_CONTAINER_SELECTORS, root, 2000).forEach(addEl);
    }

    return results;
  }

  function scrapeCaptionBatch(helpers) {
    const batch = [];
    const seenBare = new Set();

    function pushEntry(entry) {
      const text = helpers.normalizeCaptionText(entry.text);
      if (!isCaptionLikeText(text)) return;
      const author = helpers.normalizeAuthor(entry.author);
      const bare = helpers.bareText(text);
      if (seenBare.has(bare)) return;
      seenBare.add(bare);
      batch.push({ author, text });
    }

    for (const entry of collectFromElements(helpers, queryCaptionElements())) {
      pushEntry(entry);
    }

    for (const entry of collectFromContainers(helpers, queryCaptionContainers())) {
      pushEntry(entry);
    }

  // Zoom often updates #aria-notify-area for screen-reader caption announcements
    const notify = document.getElementById('aria-notify-area');
    if (notify) {
      for (const entry of parseSpeakerTextLines(
        (notify.innerText || '').split('\n').map((l) => helpers.normalizeCaptionText(l))
      )) {
        pushEntry(entry);
      }
    }

    lastScrapeDebug = batch.length
      ? `scraped ${batch.length} line(s)`
      : `no lines (containers=${queryCaptionContainers().length}, elements=${queryCaptionElements().length})`;
    return batch;
  }

  function isInMeeting() {
    if (document.getElementById('zmmtg-root')) return true;
    if (document.querySelector('#foot-bar')) return true;
    const leave = document.querySelector(
      '[feature-type="leave"], button[aria-label*="Leave" i], button[aria-label*="End" i], button[aria-label*="leave meeting" i]'
    );
    return leave && isVisible(leave);
  }

  function isLikelyMeetingFrame() {
    if (isInMeeting()) return true;
    const href = `${window.location.pathname}${window.location.search}`;
    if (/\/wc\//i.test(href) || /\/j\//i.test(href)) return true;
    if (window.self !== window.top) {
      return !!document.querySelector('#foot-bar, #zmmtg-root, [feature-type="leave"]');
    }
    return false;
  }

  function areCaptionsEnabled() {
    return scrapeCaptionBatch({
      normalizeCaptionText: (t) => (t || '').replace(/\s+/g, ' ').trim(),
      normalizeAuthor: (a) => (a || '').trim(),
      bareText: (t) => (t || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim()
    }).length > 0;
  }

  function isCaptionsUiVisible() {
    return areCaptionsEnabled();
  }

  async function tryShowCaptionsSubAction() {
    await sleep(400);
    const items = findMenuItems();
    const show = findByLabel(new RegExp(SHOW_CAPTIONS_PATTERNS.map((p) => p.source).join('|'), 'i'), items);
    if (show) {
      clickElement(show);
      await sleep(600);
      return areCaptionsEnabled();
    }
    return areCaptionsEnabled();
  }

  async function enableLiveCaptions(helpers) {
    if (areCaptionsEnabled()) {
      helpers.setCaptionsConfirmed(true);
      return true;
    }

    if (!isInMeeting()) return false;

    revealMeetingControls();
    await sleep(250);

    const directBtn = document.querySelector(
      'button[aria-label="Live Transcript"], button[aria-label*="Live Transcript" i], button[aria-label*="CC" i], button[aria-label*="Caption" i]'
    );
    if (directBtn && isVisible(directBtn)) {
      clickElement(directBtn);
      if (await tryShowCaptionsSubAction()) {
        helpers.setCaptionsConfirmed(true);
        return true;
      }
    }

    const moreBtn = document.querySelector('div[feature-type="more"] button, button[aria-label="More" i]');
    if (moreBtn && isVisible(moreBtn)) {
      clickElement(moreBtn);
      await waitFor(() => findMenuItems().length > 0, 2000);

      const items = findMenuItems();
      const captionsItem = findByLabel(new RegExp(CAPTIONS_ON_PATTERNS.map((p) => p.source).join('|'), 'i'), items);
      if (captionsItem) {
        clickElement(captionsItem);
        if (await tryShowCaptionsSubAction()) {
          helpers.setCaptionsConfirmed(true);
          await closeOpenMenus();
          return true;
        }
      }
      await closeOpenMenus();
    }

    return areCaptionsEnabled();
  }

  function collectCaptionsFromDom(helpers) {
    const batch = scrapeCaptionBatch(helpers);
    if (batch.length) {
      helpers.log('Caption scrape:', lastScrapeDebug, batch.map((b) => b.text).join(' | '));
    } else if (isInMeeting()) {
      helpers.log('Caption scrape empty:', lastScrapeDebug);
    }
    for (const line of batch) {
      helpers.rememberCaption(line);
    }
  }

  function rebuildCaptionsForSend(helpers) {
    for (const key of [...helpers.seenCaptions]) {
      helpers.seenCaptions.delete(key);
    }

    const batch = scrapeCaptionBatch(helpers);
    helpers.log('Send rebuild:', lastScrapeDebug);
    for (const line of batch) {
      helpers.rememberCaption(line);
    }

    if (!batch.length) {
      collectCaptionsFromDom(helpers);
    }
  }

  createPlatformBridge({
    id: 'zoom',
    logPrefix: '[Zoom→ChatGPT]',
    globalFlag: '__dictateZoomBridgeLoaded',
    captionSourceLabel: 'Zoom caption',
    captionEnableHint: 'Failed — open Live Transcript or More → Captions',
    isInMeeting,
    isLikelyMeetingFrame,
    collectCaptionsFromDom,
    rebuildCaptionsForSend,
    isCaptionsUiVisible,
    enableLiveCaptions
  });
})();
