const CHATGPT_URL_PATTERNS = [
  'https://chatgpt.com/*',
  'https://www.chatgpt.com/*',
  'https://chat.openai.com/*'
];

let forwardInFlight = null;
let lastForwardKey = '';
let lastForwardAt = 0;

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

  const tab = await chrome.tabs.create({ url: 'https://chatgpt.com', active: true });
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

async function sendToChatGPTTab(text) {
  const tab = await findOrOpenChatGPTTab();
  if (!tab?.id) {
    return { success: false, error: 'Could not open ChatGPT tab' };
  }

  // Focus ChatGPT so the user can see the result.
  try {
    await chrome.tabs.update(tab.id, { active: true });
  } catch {
    /* ignore */
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
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('Dictate extension installed');
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'forwardToChatGPT') {
    const key = String(message.text || '');
    const now = Date.now();

    // Ignore rapid identical forwards (double click / double listener).
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

    const promise = sendToChatGPTTab(message.text)
      .finally(() => {
        if (forwardInFlight && forwardInFlight.key === key) forwardInFlight = null;
      });
    forwardInFlight = { key, promise };

    promise
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: String(err) }));
    return true;
  }
});
