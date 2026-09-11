if (typeof globalThis.chrome === 'undefined' && typeof globalThis.browser !== 'undefined') {
  globalThis.chrome = globalThis.browser;
}

const checkbox = document.getElementById('enabled');
const autoEnableCaptionsCheckbox = document.getElementById('autoEnableCaptions');
const showAnswerOverlayCheckbox = document.getElementById('showAnswerOverlay');
const openChatGptBtn = document.getElementById('open-chatgpt');
const startDesktopBtn = document.getElementById('start-desktop');
const desktopStatus = document.getElementById('desktop-status');
const openTeamsBtn = document.getElementById('open-teams');
const openMeetBtn = document.getElementById('open-meet');
const openZoomBtn = document.getElementById('open-zoom');
const openWebexBtn = document.getElementById('open-webex');
const reloadBtn = document.getElementById('reload-extension');
const copyTranscriptBtn = document.getElementById('copy-transcript');
const endTranscriptBtn = document.getElementById('end-transcript');
const transcriptStatus = document.getElementById('transcript-status');
const DESKTOP_BRIDGE = 'http://127.0.0.1:38473/bridge';
const DESKTOP_HEALTH = 'http://127.0.0.1:38473/health';
const DESKTOP_PROTOCOL = 'dictate://start';

async function loadSettings() {
  const data = await chrome.storage.local.get({
    enabled: true,
    autoEnableCaptions: true,
    showAnswerOverlay: true
  });

  checkbox.checked = data.enabled;
  autoEnableCaptionsCheckbox.checked = data.autoEnableCaptions !== false;
  showAnswerOverlayCheckbox.checked = data.showAnswerOverlay !== false;

  // Captions only go to ChatGPT via Send — clear any legacy auto-forward settings.
  // Meeting→ChatGPT bridge is always on.
  chrome.storage.local.set({
    bridgeEnabled: true,
    autoForwardMode: 'off',
    autoForwardQuestions: false
  });
  chrome.storage.local.remove('forwardPrefix');
}

checkbox.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: checkbox.checked });
});

autoEnableCaptionsCheckbox.addEventListener('change', () => {
  chrome.storage.local.set({ autoEnableCaptions: autoEnableCaptionsCheckbox.checked });
});

showAnswerOverlayCheckbox.addEventListener('change', () => {
  chrome.storage.local.set({ showAnswerOverlay: showAnswerOverlayCheckbox.checked });
});

openChatGptBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://chatgpt.com' });
});

function setDesktopStatus(message) {
  if (desktopStatus) desktopStatus.textContent = message || '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isDesktopRunning() {
  try {
    const res = await fetch(DESKTOP_HEALTH, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

function launchDesktopViaProtocol() {
  try {
    const anchor = document.createElement('a');
    anchor.href = DESKTOP_PROTOCOL;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } catch {
    /* fall through */
  }
  try {
    chrome.tabs.create({ url: DESKTOP_PROTOCOL, active: false }, (tab) => {
      if (chrome.runtime.lastError) return;
      if (tab?.id) {
        setTimeout(() => {
          try {
            chrome.tabs.remove(tab.id, () => {
              void chrome.runtime.lastError;
            });
          } catch {
            /* ignore */
          }
        }, 1200);
      }
    });
  } catch {
    /* ignore */
  }
}

startDesktopBtn?.addEventListener('click', async () => {
  startDesktopBtn.disabled = true;
  setDesktopStatus('Checking…');
  try {
    if (await isDesktopRunning()) {
      await postDesktop('showOverlay');
      setDesktopStatus('Dictate Desktop is already running');
      return;
    }

    setDesktopStatus('Starting Dictate Desktop…');
    launchDesktopViaProtocol();

    for (let i = 0; i < 24; i++) {
      await sleep(500);
      if (await isDesktopRunning()) {
        await postDesktop('showOverlay');
        setDesktopStatus('Dictate Desktop started');
        return;
      }
    }

    setDesktopStatus(
      'Could not start. Run once from a terminal: cd dictate-desktop && npm start — then try this button again.'
    );
  } finally {
    startDesktopBtn.disabled = false;
  }
});

openTeamsBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://teams.microsoft.com' });
});

openMeetBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://meet.google.com' });
});

openZoomBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://app.zoom.us/wc/join' });
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

(async () => {
  if (await isDesktopRunning()) {
    setDesktopStatus('Dictate Desktop is running');
  }
})();
