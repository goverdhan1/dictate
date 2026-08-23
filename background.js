const CHATGPT_URLS = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];

function waitForTabComplete(tabId, timeoutMs = 15000) {
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
  const tabs = await chrome.tabs.query({ url: CHATGPT_URLS });
  if (tabs.length > 0) return tabs[0];

  const tab = await chrome.tabs.create({ url: 'https://chatgpt.com', active: false });
  await waitForTabComplete(tab.id);
  return tab;
}

async function sendToChatGPTTab(text) {
  const tab = await findOrOpenChatGPTTab();

  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'receiveFromTeams',
      text
    });
    return response || { success: false, error: 'No response from ChatGPT tab' };
  } catch (e) {
    // Content script may not be ready yet on a fresh tab.
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        action: 'receiveFromTeams',
        text
      });
      return response || { success: false, error: 'No response from ChatGPT tab' };
    } catch (retryError) {
      return { success: false, error: String(retryError) };
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('ChatGPT Auto-Dictate + Teams bridge installed');
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'forwardToChatGPT') {
    sendToChatGPTTab(message.text)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: String(err) }));
    return true;
  }
});
