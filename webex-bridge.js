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
    findMenuItems
  } = dom;

  const CAPTION_PANEL = '[class*="captions-container"]';
  const CAPTION_ITEM = '[class*="caption-item"]';
  const CAPTION_NAME = '[class*="caption-name"]';
  const CAPTION_TEXT = '[class*="caption-text"]';
  const FLOATING_CAPTION = '[class*="caption-text-box"], [class*="caption-NGr6E"]';

  const CC_ON_PATTERNS = [
    /closed captions?/i,
    /webex assistant is turned on/i,
    /captions?\s*&\s*highlights/i
  ];
  const CC_ENABLE_PATTERNS = [
    /turn on closed captions?/i,
    /enable closed captions?/i,
    /show captions?/i,
    /start captions?/i
  ];

  function isInMeeting() {
    const leave = document.querySelector(
      'button[data-doi*="LEAVE"], button[aria-label*="Leave" i], button[aria-label*="End meeting" i], button[aria-label*="End call" i]'
    );
    if (leave && isVisible(leave)) return true;
    return !!document.querySelector('button[data-doi*="PARTICIPANT"], button[aria-label*="Participants" i]');
  }

  function isLikelyMeetingFrame() {
    if (isInMeeting()) return true;
    const href = `${window.location.pathname}${window.location.search}`;
    return /\/meet\//i.test(href) || /webex\.com/i.test(window.location.hostname);
  }

  function isCaptionsUiVisible() {
    try {
      if (document.querySelector(CAPTION_PANEL)) return true;
      if (document.querySelector(FLOATING_CAPTION)) return true;
      const items = document.querySelectorAll(CAPTION_ITEM);
      return items.length > 0;
    } catch {
      return false;
    }
  }

  async function enableLiveCaptions(helpers) {
    if (isCaptionsUiVisible()) {
      helpers.setCaptionsConfirmed(true);
      return true;
    }

    if (!isInMeeting()) return false;

    revealMeetingControls();
    await sleep(250);

    const ccButtons = document.querySelectorAll(
      'button[aria-label*="Closed captions" i], button[data-doi*="CLOSED_CAPTION"], button[aria-label*="CC" i], button[data-doi*="WEBEX_ASSISTANT"]'
    );
    for (const btn of ccButtons) {
      if (!isVisible(btn)) continue;
      const pressed = btn.getAttribute('aria-pressed');
      if (pressed === 'true') {
        helpers.setCaptionsConfirmed(true);
        return true;
      }
      clickElement(btn);
      await sleep(800);
      if (isCaptionsUiVisible()) {
        helpers.setCaptionsConfirmed(true);
        return true;
      }
    }

    const moreBtn = document.querySelector('button[aria-label*="More options" i], button[aria-label*="more" i]');
    if (moreBtn && isVisible(moreBtn)) {
      clickElement(moreBtn);
      await waitFor(() => findMenuItems().length > 0, 2000);

      const items = findMenuItems();
      const panelItem = findByLabel(/captions?\s*&\s*highlights|captions?\s*panel/i, items);
      if (panelItem) {
        clickElement(panelItem);
        await sleep(600);
      }

      const enableItem = findByLabel(new RegExp(CC_ENABLE_PATTERNS.map((p) => p.source).join('|'), 'i'), items);
      if (enableItem) {
        clickElement(enableItem);
        await sleep(800);
      }

      await closeOpenMenus();
      if (isCaptionsUiVisible()) {
        helpers.setCaptionsConfirmed(true);
        return true;
      }
    }

    return isCaptionsUiVisible();
  }

  function collectFromPanel(helpers) {
    const items = document.querySelectorAll(CAPTION_ITEM);
    for (const item of items) {
      const nameEl = item.querySelector(CAPTION_NAME);
      const textEl = item.querySelector(CAPTION_TEXT);
      const author = helpers.normalizeAuthor(nameEl?.textContent || '');
      const text = helpers.normalizeCaptionText(textEl?.textContent || item.textContent || '');
      if (text) helpers.rememberCaption({ author, text });
    }
  }

  function collectFromFloating(helpers) {
    document.querySelectorAll(FLOATING_CAPTION).forEach((box) => {
      const speakerEl = box.querySelector('[class*="speaker-name"]');
      const paragraphs = box.querySelectorAll('p[dir="auto"], p[class*="ltr-text"]');
      let text = '';
      if (paragraphs.length) {
        text = helpers.normalizeCaptionText(paragraphs[paragraphs.length - 1].textContent || '');
      } else {
        text = helpers.normalizeCaptionText(box.textContent || '');
      }
      const author = helpers.normalizeAuthor(speakerEl?.textContent || '');
      if (text) helpers.rememberCaption({ author, text });
    });
  }

  function collectCaptionsFromDom(helpers) {
    collectFromPanel(helpers);
    collectFromFloating(helpers);

    if (!helpers.captionQueue.length) {
      document.querySelectorAll(CAPTION_TEXT).forEach((el) => {
        const text = helpers.normalizeCaptionText(el.textContent || '');
        if (text) helpers.rememberCaption({ author: '', text });
      });
    }
  }

  createPlatformBridge({
    id: 'webex',
    logPrefix: '[Webex→ChatGPT]',
    globalFlag: '__dictateWebexBridgeLoaded',
    captionSourceLabel: 'Webex caption',
    captionEnableHint: 'Failed — enable Closed captions or Captions & Highlights',
    isInMeeting,
    isLikelyMeetingFrame,
    collectCaptionsFromDom,
    isCaptionsUiVisible,
    enableLiveCaptions
  });
})();
