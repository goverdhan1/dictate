(function () {
  const { createPlatformBridge, dom } = window.DictateMeetingBridge;
  const {
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
    findMenuItems
  } = dom;

  const CAPTION_SELECTORS = {
    list: "[data-tid='closed-caption-v2-virtual-list-content']",
    text: "[data-tid='closed-caption-text']",
    author: "[data-tid='author']"
  };

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
    roster: '#roster-button, [data-tid="roster-button"], [data-inp="roster-button"]'
  };

  const ENABLE_CAPTIONS_RE = /^(show|turn on|enable|start)\s+(live\s+)?captions?$/i;
  const ENABLE_CAPTIONS_LOOSE_RE = /(show|turn on|enable|start)\s+(live\s+)?captions?/i;
  const DISABLE_CAPTIONS_RE = /(hide|turn off|disable|stop)\s+(live\s+)?captions?/i;
  const LANGUAGE_SPEECH_RE = /language and speech|language\s*&\s*speech/i;

  const CAPTION_HIDE_STYLE_ID = 'dictate-hide-live-captions';
  const CAPTION_HIDE_SELECTORS = [
    "[data-tid='closed-captions-renderer']",
    "[data-tid='closed-caption-v2-virtual-list-content']",
    "[data-tid='cc-vertical-list']"
  ].join(', ');

  let cachedCaptionRoot = null;
  let enableCaptionsInFlight = false;

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
          /* invalid selector */
        }
      }
      const buttons = root.querySelectorAll?.('button') || [];
      for (const btn of buttons) {
        if (!isVisible(btn)) continue;
        const label = elementLabel(btn);
        if (/^more( actions)?$/i.test(label) || /more actions/i.test(label)) return btn;
      }
      return null;
    });
  }

  function isInMeeting() {
    return !!(
      queryAllDeep(CAPTIONS_UI.hangup).some(isVisible) ||
      queryAllDeep(CAPTIONS_UI.roster).some(isVisible) ||
      findMoreButton()
    );
  }

  function isCaptionsUiVisible() {
    try {
      return !!(
        document.querySelector(CAPTION_SELECTORS.list)
        || document.querySelector(CAPTION_SELECTORS.text)
        || document.querySelector("[data-tid='closed-captions-renderer']")
        || document.querySelector("[data-tid='cc-vertical-list']")
        || (cachedCaptionRoot && cachedCaptionRoot.isConnected)
      );
    } catch {
      return false;
    }
  }

  function ensureCaptionHideStyle() {
    let style = document.getElementById(CAPTION_HIDE_STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = CAPTION_HIDE_STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = `
      ${CAPTION_HIDE_SELECTORS} {
        height: 1px !important;
        max-height: 1px !important;
        min-height: 0 !important;
        overflow: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
        margin: 0 !important;
        padding: 0 !important;
        border: none !important;
        box-shadow: none !important;
      }
      ${CAPTION_HIDE_SELECTORS} * {
        pointer-events: none !important;
      }
    `;
  }

  function applyCaptionHideInline(el) {
    if (!el) return;
    try {
      el.style.setProperty('height', '1px', 'important');
      el.style.setProperty('max-height', '1px', 'important');
      el.style.setProperty('min-height', '0', 'important');
      el.style.setProperty('overflow', 'hidden', 'important');
      el.style.setProperty('opacity', '0', 'important');
      el.style.setProperty('pointer-events', 'none', 'important');
      el.style.setProperty('margin', '0', 'important');
      el.style.setProperty('padding', '0', 'important');
      if (el.dataset) el.dataset.dictateCaptionHidden = '1';
    } catch {
      /* ignore */
    }
  }

  function hideCaptionOverlay() {
    ensureCaptionHideStyle();
    try {
      document.querySelectorAll(CAPTION_HIDE_SELECTORS).forEach(applyCaptionHideInline);
    } catch {
      /* ignore */
    }
    if (cachedCaptionRoot?.isConnected) applyCaptionHideInline(cachedCaptionRoot);
  }

  function findEnableCaptionsItem() {
    const items = findMenuItems();
    return findByLabel(ENABLE_CAPTIONS_RE, items)
      || findByLabel(ENABLE_CAPTIONS_LOOSE_RE, items.filter((el) => !DISABLE_CAPTIONS_RE.test(elementLabel(el))));
  }

  function findDisableCaptionsItem() {
    return findByLabel(DISABLE_CAPTIONS_RE, findMenuItems());
  }

  function findLanguageSpeechItem() {
    return findByLabel(LANGUAGE_SPEECH_RE, findMenuItems());
  }

  async function openMoreMenu() {
    revealMeetingControls();
    await sleep(250);
    const moreBtn = findMoreButton();
    if (!moreBtn) return null;

    if (findLanguageSpeechItem() || findEnableCaptionsItem() || findDisableCaptionsItem()) {
      return moreBtn;
    }

    clickElement(moreBtn);
    const opened = await waitFor(
      () => findLanguageSpeechItem() || findEnableCaptionsItem() || findDisableCaptionsItem() || findMenuItems().length > 0,
      2500
    );
    if (!opened) {
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
    if (!findEnableCaptionsItem() && !findDisableCaptionsItem()) {
      clickElement(lang);
      await sleep(500);
    }

    lang = findLanguageSpeechItem();
    if (lang) hoverElement(lang);

    await waitFor(() => findEnableCaptionsItem() || findDisableCaptionsItem(), 2000);
    return !!(findEnableCaptionsItem() || findDisableCaptionsItem());
  }

  async function detectCaptionsAlreadyOn(helpers) {
    const moreBtn = await openMoreMenu();
    if (!moreBtn) return false;

    if (findDisableCaptionsItem()) {
      helpers.setCaptionsConfirmed(true);
      await closeOpenMenus();
      return true;
    }
    if (findEnableCaptionsItem()) {
      await closeOpenMenus();
      return false;
    }

    await openLanguageAndSpeech();
    if (findDisableCaptionsItem()) {
      helpers.setCaptionsConfirmed(true);
      await closeOpenMenus();
      return true;
    }
    await closeOpenMenus();
    return false;
  }

  async function enableLiveCaptions(helpers) {
    if (enableCaptionsInFlight) return false;
    enableCaptionsInFlight = true;

    try {
      if (isCaptionsUiVisible()) {
        helpers.setCaptionsConfirmed(true);
        return true;
      }

      if (!isInMeeting()) return false;

      helpers.updateStatus('Opening More menu…');
      const moreBtn = await openMoreMenu();
      if (!moreBtn) {
        helpers.updateStatus('More button not found — join meeting first');
        return false;
      }

      if (findDisableCaptionsItem()) {
        helpers.setCaptionsConfirmed(true);
        await closeOpenMenus();
        return true;
      }

      let enableBtn = findEnableCaptionsItem();

      if (!enableBtn) {
        helpers.updateStatus('Opening Language and speech…');
        const opened = await openLanguageAndSpeech();
        if (!opened) {
          await closeOpenMenus();
          return false;
        }

        if (findDisableCaptionsItem()) {
          helpers.setCaptionsConfirmed(true);
          await closeOpenMenus();
          return true;
        }
        enableBtn = findEnableCaptionsItem();
      }

      if (!enableBtn) {
        helpers.updateStatus('Captions menu item not found');
        await closeOpenMenus();
        return false;
      }

      const label = elementLabel(enableBtn);
      if (DISABLE_CAPTIONS_RE.test(label)) {
        helpers.setCaptionsConfirmed(true);
        await closeOpenMenus();
        return true;
      }

      helpers.updateStatus(`Clicking: ${label.slice(0, 40)}`);
      clickElement(enableBtn);
      await sleep(1000);
      helpers.setCaptionsConfirmed(true);
      await waitFor(() => isCaptionsUiVisible(), 2500);
      hideCaptionOverlay();
      await closeOpenMenus();
      return true;
    } finally {
      enableCaptionsInFlight = false;
    }
  }

  function findCaptionNodes() {
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

    nodes = queryAllDeep(CAPTION_SELECTORS.text, document, 800);
    if (nodes.length) {
      const root = nodes[0].closest?.(
        "[data-tid='closed-caption-v2-virtual-list-content'], [data-tid='closed-captions-renderer']"
      );
      if (root) cachedCaptionRoot = root;
    }
    return nodes;
  }

  function readCaptionFromNode(node, helpers) {
    const text = helpers.normalizeCaptionText(node.textContent || '');
    if (!text) return null;
    const row = node.closest('.fui-ChatMessageCompact') || node.parentElement;
    let author = '';
    if (row) {
      const authorEl = row.querySelector?.(CAPTION_SELECTORS.author);
      author = helpers.normalizeAuthor(authorEl?.textContent || '');
    }
    return { author, text };
  }

  function collectCaptionsFromDom(helpers) {
    const nodes = findCaptionNodes();
    for (const node of nodes) {
      const caption = readCaptionFromNode(node, helpers);
      if (caption) helpers.rememberCaption(caption);
    }
  }

  function rebuildCaptionsForSend(helpers) {
    const nodes = findCaptionNodes();
    for (const node of nodes) {
      const caption = readCaptionFromNode(node, helpers);
      if (!caption) continue;
      const sim = helpers.similarityKey(caption.author, caption.text);
      const alreadySent = helpers.captionQueue.some((c) => c.sent && (
        c.sim === sim || helpers.bareText(c.text) === helpers.bareText(caption.text)
      ));
      if (!alreadySent) {
        const existing = helpers.captionQueue.find((c) => !c.sent && (
          c.sim === sim || c.key === helpers.captionKey(caption.author, caption.text)
        ));
        if (!existing) {
          helpers.seenCaptions.delete(helpers.captionKey(caption.author, caption.text));
          helpers.seenCaptions.delete(sim);
          helpers.rememberCaption(caption);
        }
      }
    }
  }

  function isLikelyMeetingFrame() {
    if (isInMeeting()) return true;
    const href = `${window.location.pathname}${window.location.search}`;
    if (/\/meet|\/calling|\/call\b|light-meetings|launcher/i.test(href)) return true;
    if (window.self !== window.top) {
      return !!document.querySelector(
        '[data-tid*="hangup"], [data-tid*="calling"], [data-tid*="roster"], [data-tid*="showMore"]'
      );
    }
    return false;
  }

  createPlatformBridge({
    id: 'teams',
    logPrefix: '[Teams→ChatGPT]',
    globalFlag: '__dictateTeamsBridgeLoaded',
    captionSourceLabel: 'Teams caption',
    captionEnableHint: 'Failed — open More → Language and speech → Show live captions',
    isInMeeting,
    isLikelyMeetingFrame,
    collectCaptionsFromDom,
    rebuildCaptionsForSend,
    hideCaptionOverlay,
    isCaptionsUiVisible,
    enableLiveCaptions,
    detectCaptionsAlreadyOn,
    onInit: ensureCaptionHideStyle
  });
})();
