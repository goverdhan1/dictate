(function () {
  const { createPlatformBridge, dom } = window.DictateMeetingBridge;
  const {
    sleep,
    isVisible,
    clickElement,
    elementLabel,
    revealMeetingControls,
    waitFor,
    closeOpenMenus,
    findByLabel,
    findMenuItems,
    waitForByLabelOrText
  } = dom;

  const CAPTION_REGION_SELECTORS = [
    '[jsname="tgaKEf"]',
    '[role="region"][aria-label*="caption" i]',
    '[role="region"][aria-label="Captions"]',
    '[aria-live="polite"]'
  ].join(', ');

  const CAPTION_ROW_SELECTORS = 'div[jsname="dsyhDe"], div.CNusmb, div.TBMuR';
  const SPEAKER_SELECTORS = 'div.KcIKyf, div.zs7s8d, span[jsname="YSxPC"]';
  const TEXT_SELECTORS = 'div.bh44bd, span[jsname="tgaKEf"], div.iTTPOb';

  const TURN_ON_CAPTIONS_RE = /turn on captions?|show captions?|enable captions?|start captions?|activar subtítulos|sous-titres/i;
  const DISABLE_CAPTIONS_RE = /turn off captions?|hide captions?|disable captions?|stop captions?/i;

  let cachedCaptionRegion = null;

  function isInMeeting() {
    const leaveBtn = document.querySelector(
      'button[aria-label*="Leave call" i], button[data-tooltip*="Leave" i], button[aria-label*="Leave meeting" i]'
    );
    if (leaveBtn && isVisible(leaveBtn)) return true;
    const path = window.location.pathname;
    return /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(path) || path.includes('/lookup/');
  }

  function isLikelyMeetingFrame() {
    if (isInMeeting()) return true;
    const href = `${window.location.pathname}${window.location.search}`;
    if (/\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(href)) return true;
    return !!document.querySelector(CAPTION_REGION_SELECTORS);
  }

  function findCaptionRegion() {
    if (cachedCaptionRegion?.isConnected) return cachedCaptionRegion;

    for (const sel of CAPTION_REGION_SELECTORS.split(',').map((s) => s.trim())) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          const label = (el.getAttribute('aria-label') || '').trim();
          if (sel.includes('aria-live') && label && !/caption|sous-titre|untertitel|leyenda|字幕/i.test(label)) {
            continue;
          }
          cachedCaptionRegion = el;
          return el;
        }
      } catch {
        /* ignore */
      }
    }

    const labelled = document.querySelectorAll('[aria-label]');
    for (const el of labelled) {
      const lbl = (el.getAttribute('aria-label') || '').trim();
      if (/^(captions|sous-titres|untertitel|leyendas|字幕)$/i.test(lbl)) {
        cachedCaptionRegion = el;
        return el;
      }
    }
    return null;
  }

  function isCaptionsUiVisible() {
    return !!findCaptionRegion();
  }

  async function openMoreOptions() {
    revealMeetingControls();
    await sleep(200);
    const more = document.querySelector(
      'button[aria-label="More options"], button[data-tooltip="More options"], button[aria-label*="More options" i]'
    );
    if (!more || !isVisible(more)) return false;
    clickElement(more);
    await waitFor(() => findMenuItems().length > 0, 2000);
    return true;
  }

  async function enableLiveCaptions(helpers) {
    if (isCaptionsUiVisible()) {
      helpers.setCaptionsConfirmed(true);
      return true;
    }

    if (!isInMeeting()) return false;

    if (await openMoreOptions()) {
      const items = findMenuItems();
      const turnOn = findByLabel(TURN_ON_CAPTIONS_RE, items);
      if (turnOn) {
        clickElement(turnOn);
        await sleep(800);
        if (isCaptionsUiVisible()) {
          helpers.setCaptionsConfirmed(true);
          await closeOpenMenus();
          return true;
        }
      }
      const turnOff = findByLabel(DISABLE_CAPTIONS_RE, items);
      if (turnOff) {
        helpers.setCaptionsConfirmed(true);
        await closeOpenMenus();
        return true;
      }
      await closeOpenMenus();
    }

  // Some Meet layouts expose CC on toolbar directly
    const ccBtn = await waitForByLabelOrText(
      'button',
      [/captions?/i, /subtitles?/i, /CC/i],
      500
    );
    if (ccBtn && isVisible(ccBtn)) {
      clickElement(ccBtn);
      await sleep(800);
      if (isCaptionsUiVisible()) {
        helpers.setCaptionsConfirmed(true);
        return true;
      }
    }

    return isCaptionsUiVisible();
  }

  function collectCaptionsFromDom(helpers) {
    const region = findCaptionRegion();
    if (!region) return;

    const rows = region.querySelectorAll(CAPTION_ROW_SELECTORS);
    if (rows.length) {
      for (const row of rows) {
        const spkEl = row.querySelector(SPEAKER_SELECTORS);
        const txtEl = row.querySelector(TEXT_SELECTORS);
        const author = helpers.normalizeAuthor(spkEl?.textContent || '');
        const text = helpers.normalizeCaptionText(txtEl?.textContent || row.textContent || '');
        if (text) helpers.rememberCaption({ author, text });
      }
      return;
    }

    const lines = (region.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length) {
      const text = lines[lines.length - 1];
      if (text.length > 1) helpers.rememberCaption({ author: '', text });
    }
  }

  createPlatformBridge({
    id: 'meet',
    logPrefix: '[Meet→ChatGPT]',
    globalFlag: '__dictateMeetBridgeLoaded',
    captionSourceLabel: 'Meet caption',
    captionEnableHint: 'Failed — open More options → Turn on captions',
    isInMeeting,
    isLikelyMeetingFrame,
    collectCaptionsFromDom,
    isCaptionsUiVisible,
    enableLiveCaptions
  });
})();
