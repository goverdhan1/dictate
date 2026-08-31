const checkbox = document.getElementById('enabled');
const bridgeCheckbox = document.getElementById('bridgeEnabled');
const autoEnableCaptionsCheckbox = document.getElementById('autoEnableCaptions');
const autoForwardMode = document.getElementById('autoForwardMode');
const forwardPrefix = document.getElementById('forwardPrefix');
const showAnswerOverlayCheckbox = document.getElementById('showAnswerOverlay');
const openChatGptBtn = document.getElementById('open-chatgpt');
const openTeamsBtn = document.getElementById('open-teams');
const reloadBtn = document.getElementById('reload-extension');

async function loadSettings() {
  const data = await chrome.storage.local.get({
    enabled: true,
    bridgeEnabled: true,
    autoEnableCaptions: true,
    autoForwardMode: 'questions',
    autoForwardQuestions: true,
    forwardPrefix: '',
    showAnswerOverlay: true
  });

  checkbox.checked = data.enabled;
  bridgeCheckbox.checked = data.bridgeEnabled;
  autoEnableCaptionsCheckbox.checked = data.autoEnableCaptions !== false;
  showAnswerOverlayCheckbox.checked = data.showAnswerOverlay !== false;

  let prefix = data.forwardPrefix || '';
  if (prefix === 'Answer this meeting question: ' || prefix === 'Answer this meeting question:') {
    prefix = '';
    chrome.storage.local.set({ forwardPrefix: '' });
  }
  forwardPrefix.value = prefix;

  if (data.autoForwardMode) {
    autoForwardMode.value = data.autoForwardMode;
  } else {
    autoForwardMode.value = data.autoForwardQuestions === false ? 'off' : 'questions';
  }
}

checkbox.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: checkbox.checked });
});

bridgeCheckbox.addEventListener('change', () => {
  chrome.storage.local.set({ bridgeEnabled: bridgeCheckbox.checked });
});

autoEnableCaptionsCheckbox.addEventListener('change', () => {
  chrome.storage.local.set({ autoEnableCaptions: autoEnableCaptionsCheckbox.checked });
});

autoForwardMode.addEventListener('change', () => {
  chrome.storage.local.set({ autoForwardMode: autoForwardMode.value });
});

forwardPrefix.addEventListener('change', () => {
  chrome.storage.local.set({ forwardPrefix: forwardPrefix.value });
});

forwardPrefix.addEventListener('blur', () => {
  chrome.storage.local.set({ forwardPrefix: forwardPrefix.value });
});

showAnswerOverlayCheckbox.addEventListener('change', () => {
  chrome.storage.local.set({ showAnswerOverlay: showAnswerOverlayCheckbox.checked });
});

openChatGptBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://chatgpt.com' });
});

openTeamsBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://teams.microsoft.com' });
});

reloadBtn.addEventListener('click', () => {
  chrome.runtime.reload();
});

loadSettings();
