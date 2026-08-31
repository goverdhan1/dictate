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
  'https://*.teams.cloud.microsoft/*'
];

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

async function findAllTeamsTabs() {
  let tabs = await chrome.tabs.query({ url: TEAMS_URL_PATTERNS });
  if (tabs.length) return tabs;
  const allTabs = await chrome.tabs.query({});
  return allTabs.filter((tab) => isTeamsUrl(tab.url || ''));
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

async function getTeamsTabFrames(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (frames?.length) return frames;
  } catch {
    /* ignore */
  }
  return [{ frameId: 0 }];
}

async function messageTeamsTab(tabId, message) {
  const frames = await getTeamsTabFrames(tabId);
  const sorted = [...frames].sort((a, b) => {
    const score = (url) => {
      const u = String(url || '');
      if (/meet|calling|light-meetings|\/v2\//i.test(u)) return 0;
      if (/teams\.(microsoft|live)\.com/i.test(u)) return 1;
      return 2;
    };
    return score(a.url) - score(b.url);
  });

  let lastResult = null;
  let lastSendResult = null;
  for (const frame of sorted) {
    try {
      await ensureTeamsBridge(tabId, frame.frameId);
      const res = await chrome.tabs.sendMessage(tabId, message, { frameId: frame.frameId });
      if (!res) continue;
      if (message.action === 'sendTeamsQueue') {
        if (res.sent) return res;
        lastSendResult = res;
        continue;
      }
      if (message.action === 'getTeamsBridgeStatus' && res.inMeeting) return res;
      if (res.success) lastResult = res;
    } catch {
      /* frame without bridge */
    }
  }
  if (message.action === 'sendTeamsQueue') return lastSendResult;
  return lastResult;
}

async function ensureTeamsBridge(tabId, frameId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { action: 'ping' }, { frameId });
    if (res?.pong) return true;
  } catch {
    /* not injected yet */
  }
  try {
    await chrome.scripting.executeScript({
      target: frameId === 0
        ? { tabId, allFrames: true }
        : { tabId, frameIds: [frameId] },
      files: ['teams-bridge.js']
    });
    await new Promise((r) => setTimeout(r, 700));
    const res = await chrome.tabs.sendMessage(tabId, { action: 'ping' }, { frameId });
    return !!res?.pong;
  } catch {
    return false;
  }
}

async function pollDesktopPendingActions() {
  if (!(await isDesktopBridgeAvailable())) return;
  try {
    const res = await fetch(`${DESKTOP_BRIDGE}/pending`);
    if (!res.ok) return;
    const data = await res.json();
    const actions = Array.isArray(data.actions) ? data.actions : [];
    if (!actions.includes('sendTeamsQueue')) return;

    await sendToTeamsTab('startTeamsBridge');
    await sendToTeamsTab('enableTeamsCaptions');
    const result = await sendToTeamsTab('sendTeamsQueue');
    try {
      await postToDesktop({ action: 'reportSendResult', ...(result || { success: false }) });
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore poll errors */
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

async function findTeamsTab() {
  const tabs = await findAllTeamsTabs();
  if (!tabs.length) return null;
  return tabs.find((t) => t.active) || tabs.find((t) => t.status === 'complete') || tabs[0];
}

async function sendToTeamsTab(action) {
  const tab = await findTeamsTab();
  if (!tab?.id) {
    return {
      success: false,
      sent: false,
      error: 'Open your meeting in Chrome (teams.microsoft.com or teams.cloud.microsoft.com)',
      status: 'Open meeting in Chrome'
    };
  }
  const result = await messageTeamsTab(tab.id, { action });
  return result || {
    success: false,
    sent: false,
    error: 'Teams meeting not ready in Chrome — join the meeting in your browser tab',
    status: 'Join meeting in Chrome'
  };
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

  // Prefer top frame; fall back if frameId targeting fails.
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch (e1) {
    console.warn('[Dictate] frameId 0 failed, retrying default:', e1?.message || e1);
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function sendToChatGPTTab(text, options = {}) {
  const teamsTabId = options.teamsTabId;
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
    } catch (retryError) {
      return {
        success: false,
        error: 'ChatGPT page not ready — refresh chatgpt.com and try again'
      };
    }
  } finally {
    if (teamsTabId) {
      try {
        await chrome.tabs.update(teamsTabId, { active: true });
      } catch {
        /* ignore */
      }
    }
  }
}

async function relayChatGPTResponseToTeams(payload) {
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

  const tabs = await chrome.tabs.query({ url: TEAMS_URL_PATTERNS });
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
        /* Teams tab not ready */
      }
    }
  }
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'relayChatGPTResponse') {
    relayChatGPTResponseToTeams(message)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: String(err) }));
    return true;
  }

  if (message.action === 'forwardToChatGPT') {
    const key = String(message.text || '');
    const now = Date.now();
    const teamsTabId = sender.tab?.id;
    const fromChromeTeams = !!(teamsTabId && isTeamsUrl(sender.tab?.url || ''));

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
        : sendToChatGPTTab(message.text, { teamsTabId }))
        .finally(() => {
          if (forwardInFlight && forwardInFlight.key === key) forwardInFlight = null;
        });
      forwardInFlight = { key, promise };

      if (fromChromeTeams && teamsTabId) {
        try {
          await chrome.tabs.update(teamsTabId, { active: true });
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

  if (message.action === 'sendTeamsQueue' || message.action === 'startTeamsBridge'
      || message.action === 'stopTeamsBridge' || message.action === 'enableTeamsCaptions'
      || message.action === 'getTeamsBridgeStatus') {
    sendToTeamsTab(message.action)
      .then((result) => sendResponse(result || { success: false, error: 'No response from Teams' }))
      .catch((err) => sendResponse({ success: false, error: String(err) }));
    return true;
  }
});
