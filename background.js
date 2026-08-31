const CHATGPT_URL_PATTERNS = [
  'https://chatgpt.com/*',
  'https://www.chatgpt.com/*',
  'https://chat.openai.com/*'
];

const TEAMS_URL_PATTERNS = [
  'https://teams.microsoft.com/*',
  'https://*.teams.microsoft.com/*',
  'https://teams.live.com/*',
  'https://*.teams.live.com/*',
  'https://teams.cloud.microsoft/*',
  'https://*.teams.cloud.microsoft.com/*',
  'https://teams.microsoft.us/*',
  'https://*.teams.microsoft.us/*'
];

const MEET_URL_PATTERNS = [
  'https://meet.google.com/*'
];

const ZOOM_URL_PATTERNS = [
  'https://zoom.us/*',
  'https://*.zoom.us/*',
  'https://app.zoom.us/*'
];

const WEBEX_URL_PATTERNS = [
  'https://*.webex.com/meet/*',
  'https://*.webex.com/*'
];

const MEETING_PLATFORMS = [
  {
    id: 'teams',
    patterns: TEAMS_URL_PATTERNS,
    bridgeFiles: ['meeting-bridge-core.js', 'teams-bridge.js'],
    isUrl: isTeamsUrl,
    frameScore: (url) => {
      const u = String(url || '');
      if (/meet|calling|light-meetings|\/v2\//i.test(u)) return 0;
      if (/teams\.(microsoft|live)\.com/i.test(u)) return 1;
      return 2;
    },
    tabError: 'Open your meeting in Chrome (teams.microsoft.com or teams.cloud.microsoft.com)'
  },
  {
    id: 'meet',
    patterns: MEET_URL_PATTERNS,
    bridgeFiles: ['meeting-bridge-core.js', 'meet-bridge.js'],
    isUrl: isMeetUrl,
    frameScore: (url) => {
      const u = String(url || '');
      if (/meet\.google\.com/i.test(u) && !/\/landing/i.test(u)) return 0;
      return 1;
    },
    tabError: 'Open your meeting in Chrome (meet.google.com)'
  },
  {
    id: 'zoom',
    patterns: ZOOM_URL_PATTERNS,
    bridgeFiles: ['meeting-bridge-core.js', 'zoom-bridge.js'],
    isUrl: isZoomUrl,
    frameScore: (url) => {
      const u = String(url || '');
      if (/\/wc\//i.test(u)) return 0;
      if (/zmmtg-root|webclient/i.test(u)) return 0;
      if (/zoom\.us/i.test(u)) return 1;
      return 2;
    },
    tabError: 'Open your meeting in Chrome (zoom.us web client)'
  },
  {
    id: 'webex',
    patterns: WEBEX_URL_PATTERNS,
    bridgeFiles: ['meeting-bridge-core.js', 'webex-bridge.js'],
    isUrl: isWebexUrl,
    frameScore: (url) => {
      const u = String(url || '');
      if (/\/meet\//i.test(u)) return 0;
      if (/webex\.com/i.test(u)) return 1;
      return 2;
    },
    tabError: 'Open your meeting in Chrome (webex.com)'
  }
];

const ALL_MEETING_URL_PATTERNS = MEETING_PLATFORMS.flatMap((p) => p.patterns);

const SEND_QUEUE_ACTIONS = ['sendMeetingQueue', 'sendTeamsQueue'];
const START_BRIDGE_ACTIONS = ['startMeetingBridge', 'startTeamsBridge'];
const STOP_BRIDGE_ACTIONS = ['stopMeetingBridge', 'stopTeamsBridge'];
const ENABLE_CAPTIONS_ACTIONS = ['enableMeetingCaptions', 'enableTeamsCaptions'];
const STATUS_ACTIONS = ['getMeetingBridgeStatus', 'getTeamsBridgeStatus'];

const DESKTOP_BRIDGE = 'http://127.0.0.1:38473';

let forwardInFlight = null;
let lastForwardKey = '';
let lastForwardAt = 0;
let desktopBridgeAvailable = null;
let desktopBridgeCheckedAt = 0;
let desktopPollTimer = null;

function isTeamsUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'teams.cloud.microsoft.com'
      || host.endsWith('.teams.cloud.microsoft.com')
      || host === 'teams.microsoft.com'
      || host.endsWith('.teams.microsoft.com')
      || host === 'teams.live.com'
      || host.endsWith('.teams.live.com')
      || host.includes('teams.microsoft.us');
  } catch {
    return false;
  }
}

function isMeetUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase() === 'meet.google.com';
  } catch {
    return false;
  }
}

function isZoomUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'zoom.us' || host.endsWith('.zoom.us');
  } catch {
    return false;
  }
}

function isWebexUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase().endsWith('.webex.com');
  } catch {
    return false;
  }
}

function detectPlatformFromUrl(url) {
  for (const platform of MEETING_PLATFORMS) {
    if (platform.isUrl(url)) return platform;
  }
  return null;
}

function isMeetingUrl(url) {
  return !!detectPlatformFromUrl(url);
}

async function findAllMeetingTabs(platformFilter = null) {
  const platforms = platformFilter
    ? MEETING_PLATFORMS.filter((p) => p.id === platformFilter)
    : MEETING_PLATFORMS;

  const patterns = platforms.flatMap((p) => p.patterns);
  let tabs = await chrome.tabs.query({ url: patterns });
  if (tabs.length) return tabs;

  const allTabs = await chrome.tabs.query({});
  return allTabs.filter((tab) => {
    const platform = detectPlatformFromUrl(tab.url || '');
    if (!platform) return false;
    return !platformFilter || platform.id === platformFilter;
  });
}

async function isDesktopBridgeAvailable() {
  const now = Date.now();
  if (desktopBridgeAvailable !== null && now - desktopBridgeCheckedAt < 5000) {
    return desktopBridgeAvailable;
  }
  desktopBridgeCheckedAt = now;
  try {
    const res = await fetch(`${DESKTOP_BRIDGE}/health`, { method: 'GET' });
    desktopBridgeAvailable = res.ok;
  } catch {
    desktopBridgeAvailable = false;
  }
  return desktopBridgeAvailable;
}

async function postToDesktop(message) {
  const res = await fetch(`${DESKTOP_BRIDGE}/bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message)
  });
  return res.json();
}

async function getMeetingTabFrames(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (frames?.length) return frames;
  } catch {
    /* ignore */
  }
  return [{ frameId: 0 }];
}

async function ensureMeetingBridge(tabId, frameId, bridgeFiles) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { action: 'ping' }, { frameId });
    if (res?.pong) return true;
  } catch {
    /* not injected yet */
  }
  try {
    const target = frameId === 0
      ? { tabId, allFrames: true }
      : { tabId, frameIds: [frameId] };
    await chrome.scripting.executeScript({
      target,
      files: bridgeFiles
    });
    for (let attempt = 0; attempt < 4; attempt++) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const res = await chrome.tabs.sendMessage(tabId, { action: 'ping' }, { frameId });
        if (res?.pong) return true;
      } catch {
        /* retry */
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function probeMeetingFrame(tabId, frame, platform) {
  await ensureMeetingBridge(tabId, frame.frameId, platform.bridgeFiles);
  try {
    const status = await chrome.tabs.sendMessage(
      tabId,
      { action: 'getMeetingBridgeStatus' },
      { frameId: frame.frameId }
    );
    return status || null;
  } catch {
    return null;
  }
}

async function messageMeetingTab(tabId, message, platform) {
  const frames = await getMeetingTabFrames(tabId);
  const ranked = frames.map((frame) => {
    const urlScore = platform.frameScore ? platform.frameScore(frame.url) : 1;
    return { frame, urlScore };
  });

  const probed = [];
  for (const entry of ranked) {
    const status = await probeMeetingFrame(tabId, entry.frame, platform);
    const meetingScore = status?.inMeeting ? 0 : 1;
    const unsent = Number(status?.unsentCount || 0);
    const captions = status?.captionsVisible ? 1 : 0;
    probed.push({
      frame: entry.frame,
      status,
      sortKey: meetingScore * 10000 - unsent * 10 - captions * 5 + entry.urlScore
    });
  }

  probed.sort((a, b) => a.sortKey - b.sortKey);

  const messageTimeoutMs = SEND_QUEUE_ACTIONS.includes(message.action) ? 20000 : 8000;

  let lastResult = null;
  let lastSendResult = null;
  for (const { frame, status } of probed) {
    if (SEND_QUEUE_ACTIONS.includes(message.action) && status && !status.inMeeting && !status.captionsVisible) {
      continue;
    }
    try {
      const res = await Promise.race([
        chrome.tabs.sendMessage(tabId, message, { frameId: frame.frameId }),
        new Promise((resolve) => setTimeout(() => resolve(null), messageTimeoutMs))
      ]);
      if (!res) continue;
      if (SEND_QUEUE_ACTIONS.includes(message.action)) {
        if (res.sent) return res;
        lastSendResult = res;
        continue;
      }
      if (STATUS_ACTIONS.includes(message.action) && res.inMeeting) return res;
      if (res.success) lastResult = res;
    } catch {
      /* frame without bridge */
    }
  }
  if (SEND_QUEUE_ACTIONS.includes(message.action)) return lastSendResult;
  return lastResult;
}

async function findMeetingTab(preferredPlatformId = null) {
  if (preferredPlatformId) {
    const tabs = await findAllMeetingTabs(preferredPlatformId);
    if (tabs.length) {
      return {
        tab: tabs.find((t) => t.active) || tabs.find((t) => t.status === 'complete') || tabs[0],
        platform: MEETING_PLATFORMS.find((p) => p.id === preferredPlatformId)
      };
    }
  }

  const allTabs = await findAllMeetingTabs();
  if (!allTabs.length) return { tab: null, platform: null };

  const tab = allTabs.find((t) => t.active) || allTabs.find((t) => t.status === 'complete') || allTabs[0];
  const platform = detectPlatformFromUrl(tab.url || '');
  return { tab, platform };
}

async function sendToMeetingTab(action, preferredPlatformId = null) {
  const isSendQueue = SEND_QUEUE_ACTIONS.includes(action);

  if (isSendQueue) {
    const tabs = await findAllMeetingTabs(preferredPlatformId || null);
    if (!tabs.length) {
      return {
        success: false,
        sent: false,
        error: 'Open Zoom in Chrome (zoom.us/wc) — the desktop app cannot be bridged',
        status: 'Open meeting in Chrome'
      };
    }

    const sortedTabs = [
      ...tabs.filter((t) => t.active),
      ...tabs.filter((t) => !t.active)
    ];

    let lastResult = null;
    for (const tab of sortedTabs) {
      const platform = detectPlatformFromUrl(tab.url || '');
      if (!platform?.id || !tab.id) continue;
      const result = await messageMeetingTab(tab.id, { action }, platform);
      if (result?.sent) return result;
      if (result) lastResult = result;
    }

    return lastResult || {
      success: false,
      sent: false,
      error: 'Meeting not ready in Chrome — join the meeting in your browser tab',
      status: 'Join meeting in Chrome'
    };
  }

  const { tab, platform } = await findMeetingTab(preferredPlatformId);
  if (!tab?.id || !platform) {
    return {
      success: false,
      sent: false,
      error: 'Open your meeting in Chrome with live captions enabled',
      status: 'Open meeting in Chrome'
    };
  }

  const result = await messageMeetingTab(tab.id, { action }, platform);
  return result || {
    success: false,
    sent: false,
    error: platform.tabError || 'Meeting not ready in Chrome — join the meeting in your browser tab',
    status: 'Join meeting in Chrome'
  };
}

async function pollDesktopPendingActions() {
  if (!(await isDesktopBridgeAvailable())) return;

  let claimed = false;
  let result = { success: false, sent: false };

  try {
    const res = await fetch(`${DESKTOP_BRIDGE}/pending`);
    if (!res.ok) return;
    const data = await res.json();
    const actions = Array.isArray(data.actions) ? data.actions : [];
    if (!SEND_QUEUE_ACTIONS.some((a) => actions.includes(a))) return;

    const tabs = await findAllMeetingTabs();
    for (const tab of tabs) {
      const platform = detectPlatformFromUrl(tab.url || '');
      if (!tab?.id || !platform) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: platform.bridgeFiles
        });
      } catch {
        /* ignore inject errors */
      }
    }

    await new Promise((r) => setTimeout(r, 1200));

    const claimRes = await postToDesktop({ action: 'claimSendQueue' });
    if (!claimRes?.success) return;

    claimed = true;
    await sendToMeetingTab('startMeetingBridge');
    result = await sendToMeetingTab('sendMeetingQueue');
  } catch (e) {
    result = { success: false, sent: false, error: String(e) };
  } finally {
    if (claimed) {
      try {
        await postToDesktop({ action: 'reportSendResult', ...(result || { success: false }) });
      } catch {
        /* ignore */
      }
    }
  }
}

function ensureDesktopPollAlarm() {
  if (!chrome.alarms) return;
  chrome.alarms.create('desktop-bridge-poll', { periodInMinutes: 1 });
}

function startDesktopPollLoop() {
  if (desktopPollTimer) return;
  desktopPollTimer = setInterval(() => {
    pollDesktopPendingActions().catch(() => {});
  }, 500);
  pollDesktopPendingActions().catch(() => {});
  ensureDesktopPollAlarm();
}

async function getBridgeSettings() {
  const data = await chrome.storage.local.get({
    showAnswerOverlay: true
  });
  return data;
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('ChatGPT tab load timeout'));
    }, timeoutMs);

    function onUpdated(updatedTabId, info) {
      if (updatedTabId !== tabId || info.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    });
  });
}

async function findOrOpenChatGPTTab() {
  const tabs = await chrome.tabs.query({ url: CHATGPT_URL_PATTERNS });
  if (tabs.length > 0) {
    const preferred = tabs.find((t) => t.active && t.status === 'complete')
      || tabs.find((t) => t.status === 'complete')
      || tabs[0];
    return preferred;
  }

  const tab = await chrome.tabs.create({ url: 'https://chatgpt.com', active: false });
  await waitForTabComplete(tab.id);
  await new Promise((r) => setTimeout(r, 2500));
  return tab;
}

async function pingTab(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' }, { frameId: 0 });
    return !!(response && response.pong);
  } catch {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
      return !!(response && response.pong);
    } catch {
      return false;
    }
  }
}

async function ensureContentScript(tabId) {
  if (await pingTab(tabId)) return true;

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ['content-script.js']
    });
    await new Promise((r) => setTimeout(r, 600));
    return pingTab(tabId);
  } catch (e) {
    console.warn('[Dictate] Failed to inject content script:', e);
    return false;
  }
}

async function deliverToChatGPT(tabId, text) {
  const message = { action: 'receiveFromTeams', text };

  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch (e1) {
    console.warn('[Dictate] frameId 0 failed, retrying default:', e1?.message || e1);
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function sendToChatGPTTab(text, options = {}) {
  const meetingTabId = options.meetingTabId;
  const tab = await findOrOpenChatGPTTab();
  if (!tab?.id) {
    return { success: false, error: 'Could not open ChatGPT tab' };
  }

  const ready = await ensureContentScript(tab.id);
  if (!ready) {
    return { success: false, error: 'ChatGPT page not ready — refresh chatgpt.com' };
  }

  try {
    const response = await deliverToChatGPT(tab.id, text);
    if (response?.duplicate) {
      return { success: false, error: 'Duplicate blocked — wait a moment and try again' };
    }
    return response || { success: false, error: 'No response from ChatGPT tab' };
  } catch (e) {
    await new Promise((r) => setTimeout(r, 1200));
    await ensureContentScript(tab.id);
    try {
      const response = await deliverToChatGPT(tab.id, text);
      if (response?.duplicate) {
        return { success: false, error: 'Duplicate blocked — wait a moment and try again' };
      }
      return response || { success: false, error: 'No response from ChatGPT tab' };
    } catch {
      return {
        success: false,
        error: 'ChatGPT page not ready — refresh chatgpt.com and try again'
      };
    }
  } finally {
    if (meetingTabId) {
      try {
        await chrome.tabs.update(meetingTabId, { active: true });
      } catch {
        /* ignore */
      }
    }
  }
}

async function relayChatGPTResponseToMeetingTabs(payload) {
  if (await isDesktopBridgeAvailable()) {
    try {
      await postToDesktop({
        action: 'relayChatGPTResponse',
        question: payload.question || '',
        answer: payload.answer || '',
        streaming: payload.streaming === true
      });
      return;
    } catch (e) {
      console.warn('[Dictate] Desktop overlay relay failed:', e);
    }
  }

  const settings = await getBridgeSettings();
  if (settings.showAnswerOverlay === false) return;

  const tabs = await findAllMeetingTabs();
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      await chrome.tabs.sendMessage(tab.id, {
        action: 'showChatGPTAnswer',
        question: payload.question || '',
        answer: payload.answer || '',
        streaming: payload.streaming === true
      }, { frameId: 0 });
    } catch {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'showChatGPTAnswer',
          question: payload.question || '',
          answer: payload.answer || '',
          streaming: payload.streaming === true
        });
      } catch {
        /* meeting tab not ready */
      }
    }
  }
}

function normalizeMeetingAction(action) {
  if (action === 'sendTeamsQueue') return 'sendMeetingQueue';
  if (action === 'startTeamsBridge') return 'startMeetingBridge';
  if (action === 'stopTeamsBridge') return 'stopMeetingBridge';
  if (action === 'enableTeamsCaptions') return 'enableMeetingCaptions';
  if (action === 'getTeamsBridgeStatus') return 'getMeetingBridgeStatus';
  return action;
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('Dictate extension installed');
  startDesktopPollLoop();
});

chrome.runtime.onStartup.addListener(() => {
  startDesktopPollLoop();
});

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'desktop-bridge-poll') {
      pollDesktopPendingActions().catch(() => {});
    }
  });
}

startDesktopPollLoop();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'dictate-keepalive') {
    port.onMessage.addListener(() => {});
  }
});

if (chrome.webNavigation?.onCompleted) {
  chrome.webNavigation.onCompleted.addListener((details) => {
    if (details.frameId !== 0) return;
    const platform = detectPlatformFromUrl(details.url || '');
    if (!platform?.bridgeFiles || !details.tabId) return;
    setTimeout(() => {
      ensureMeetingBridge(details.tabId, 0, platform.bridgeFiles).catch(() => {});
    }, 1200);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'relayChatGPTResponse') {
    relayChatGPTResponseToMeetingTabs(message)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: String(err) }));
    return true;
  }

  if (message.action === 'forwardToChatGPT') {
    const key = String(message.text || '');
    const now = Date.now();
    const meetingTabId = sender.tab?.id;
    const fromMeetingTab = !!(meetingTabId && isMeetingUrl(sender.tab?.url || ''));
    const preferredPlatform = fromMeetingTab ? detectPlatformFromUrl(sender.tab?.url || '')?.id : null;

    if (key && key === lastForwardKey && now - lastForwardAt < 2500) {
      sendResponse({ success: false, error: 'Already sending that text' });
      return false;
    }

    if (forwardInFlight && forwardInFlight.key === key) {
      forwardInFlight.promise
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    lastForwardKey = key;
    lastForwardAt = now;

    isDesktopBridgeAvailable().then(async (useDesktop) => {
      const promise = (useDesktop
        ? postToDesktop({ action: 'forwardToChatGPT', text: message.text })
        : sendToChatGPTTab(message.text, { meetingTabId }))
        .finally(() => {
          if (forwardInFlight && forwardInFlight.key === key) forwardInFlight = null;
        });
      forwardInFlight = { key, promise };

      if (fromMeetingTab && meetingTabId) {
        try {
          await chrome.tabs.update(meetingTabId, { active: true });
        } catch {
          /* ignore */
        }
      }

      return promise;
    })
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: String(err) }));
    return true;
  }

  const meetingActions = [
    ...SEND_QUEUE_ACTIONS,
    ...START_BRIDGE_ACTIONS,
    ...STOP_BRIDGE_ACTIONS,
    ...ENABLE_CAPTIONS_ACTIONS,
    ...STATUS_ACTIONS
  ];

  if (meetingActions.includes(message.action)) {
    const normalized = normalizeMeetingAction(message.action);
    const preferredPlatform = sender.tab?.url ? detectPlatformFromUrl(sender.tab.url)?.id : null;
    sendToMeetingTab(normalized, preferredPlatform)
      .then((result) => sendResponse(result || { success: false, error: 'No response from meeting tab' }))
      .catch((err) => sendResponse({ success: false, error: String(err) }));
    return true;
  }
});
