if (typeof globalThis.chrome === 'undefined' && typeof globalThis.browser !== 'undefined') {
  globalThis.chrome = globalThis.browser;
}

const checkbox = document.getElementById('enabled');
const bridgeCheckbox = document.getElementById('bridgeEnabled');
const autoEnableCaptionsCheckbox = document.getElementById('autoEnableCaptions');
const autoForwardMode = document.getElementById('autoForwardMode');
const forwardPrefix = document.getElementById('forwardPrefix');
const showAnswerOverlayCheckbox = document.getElementById('showAnswerOverlay');
const openChatGptBtn = document.getElementById('open-chatgpt');
const openTeamsBtn = document.getElementById('open-teams');
const openMeetBtn = document.getElementById('open-meet');
const openZoomBtn = document.getElementById('open-zoom');
const openWebexBtn = document.getElementById('open-webex');
const reloadBtn = document.getElementById('reload-extension');
const copyTranscriptBtn = document.getElementById('copy-transcript');
const endTranscriptBtn = document.getElementById('end-transcript');
const transcriptStatus = document.getElementById('transcript-status');
const DESKTOP_BRIDGE = 'http://127.0.0.1:38473/bridge';

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

openMeetBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://meet.google.com' });
});

openZoomBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://zoom.us/wc/join' });
});

openWebexBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://signin.webex.com/join' });
});

reloadBtn.addEventListener('click', () => {
  chrome.runtime.reload();
});

function formatStoredTranscript(t) {
  if (!t?.lines?.length) return '';
  return t.lines.map((c) => {
    const when = c.at ? new Date(c.at).toLocaleTimeString() : '';
    const body = c.author ? `${c.author}: ${c.text}` : c.text;
    return when ? `[${when}] ${body}` : body;
  }).join('\n');
}

function setTranscriptStatus(message) {
  if (transcriptStatus) transcriptStatus.textContent = message || '';
}

async function postDesktop(action) {
  try {
    const res = await fetch(DESKTOP_BRIDGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

async function localTranscriptText() {
  const data = await chrome.storage.local.get({
    meetingTranscript: { startedAt: Date.now(), lines: [] }
  });
  return formatStoredTranscript(data.meetingTranscript);
}

copyTranscriptBtn?.addEventListener('click', async () => {
  setTranscriptStatus('');
  const desktop = await postDesktop('getTranscript');
  const text = (desktop?.text && String(desktop.text).trim())
    ? desktop.text
    : await localTranscriptText();
  if (!text) {
    setTranscriptStatus('No captions stored yet');
    return;
  }
  const ok = await copyText(text);
  const n = desktop?.count || text.split('\n').filter(Boolean).length;
  setTranscriptStatus(ok ? `Copied ${n} caption${n === 1 ? '' : 's'}` : 'Could not copy');
});

endTranscriptBtn?.addEventListener('click', async () => {
  setTranscriptStatus('');
  const desktop = await postDesktop('endTranscript');
  await chrome.storage.local.set({
    meetingTranscript: { startedAt: Date.now(), lines: [] }
  });
  if (desktop?.success) {
    setTranscriptStatus(desktop.fileName ? `Saved ${desktop.fileName}` : 'Started a new transcript');
  } else if (desktop?.error && desktop.error !== 'No captions to save') {
    setTranscriptStatus(desktop.error);
  } else {
    setTranscriptStatus('Started a new transcript');
  }
});

loadSettings();
