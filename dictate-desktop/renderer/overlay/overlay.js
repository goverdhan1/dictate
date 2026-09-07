const hideBtn = document.getElementById('hide-btn');
const transcriptBtn = document.getElementById('transcript-btn');
const sendBtn = document.getElementById('send-btn');
const resizeHandle = document.getElementById('resize-handle');
const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('status-text');
const joinBtn = document.getElementById('join-btn');
const meetingIdEl = document.getElementById('meeting-id');
const loadingEl = document.getElementById('chatgpt-loading');
const chatgptFrame = document.getElementById('chatgpt-frame');

let sendBusy = false;
let resizePointerId = null;
let resizeLastX = 0;
let resizeLastY = 0;
let statusTimer = null;
let joinUrl = 'https://app.zoom.us/wc/join';

function formatMeetingId(id) {
  const digits = String(id || '').replace(/\D/g, '');
  if (digits.length === 10) return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  if (digits.length === 11) return `${digits.slice(0, 3)} ${digits.slice(3, 7)} ${digits.slice(7)}`;
  if (digits.length === 9) return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  return digits;
}

function setMeetingIdTitle(meetingId, meetingIdDisplay) {
  if (!meetingIdEl) return;
  const display = meetingIdDisplay || formatMeetingId(meetingId);
  if (!display) {
    meetingIdEl.textContent = '';
    meetingIdEl.classList.remove('visible');
    document.title = 'Dictate Overlay';
    return;
  }
  meetingIdEl.textContent = `· Zoom ${display}`;
  meetingIdEl.classList.add('visible');
  meetingIdEl.title = `Zoom Meeting ID ${display}`;
  document.title = `ChatGPT · Zoom ${display}`;
}

function setJoinAction(url, label) {
  joinUrl = url || 'https://app.zoom.us/wc/join';
  if (joinBtn) {
    joinBtn.textContent = label || 'Open Zoom in Chrome';
  }
  statusEl?.classList.toggle('has-join', !!url);
}

function setStatus(message, isError = false, join = null) {
  clearTimeout(statusTimer);
  const text = String(message || '').trim();
  const target = statusTextEl || statusEl;
  if (!text) {
    if (target) target.textContent = '';
    statusEl.classList.remove('visible', 'error', 'has-join');
    return;
  }
  if (target) target.textContent = text;
  statusEl.classList.add('visible');
  statusEl.classList.toggle('error', !!isError);
  if (join?.joinUrl) setJoinAction(join.joinUrl, join.joinLabel);
  else if (isError && /chrome|browser|zoom\.us/i.test(text)) setJoinAction(joinUrl, 'Open Zoom in Chrome');
  else statusEl.classList.remove('has-join');
  if (!isError) {
    statusTimer = setTimeout(() => setStatus(''), 4000);
  }
}

function render(data) {
  if (!data) return;
  if (data.meetingId || data.meetingIdDisplay) {
    setMeetingIdTitle(data.meetingId, data.meetingIdDisplay);
  }
  const error = data.error || (data.success === false ? data.answer || data.status : '');
  if (error) {
    setStatus(error, true, data);
    return;
  }
  if (data.status) {
    setStatus(data.status, false, data.joinUrl ? data : null);
  }
}

function setSendBusy(busy) {
  sendBusy = busy;
  sendBtn.disabled = busy;
  sendBtn.textContent = busy ? 'Sending…' : 'Send';
}

async function handleCopyTranscript() {
  if (!window.dictateOverlay?.copyTranscript) return;
  try {
    const result = await window.dictateOverlay.copyTranscript();
    if (result?.success) {
      const n = result.count || 0;
      setStatus(n ? `Copied ${n} caption${n === 1 ? '' : 's'}` : 'Copied transcript');
    } else {
      setStatus(result?.error || 'No captions stored yet', true);
    }
  } catch (e) {
    setStatus(String(e?.message || e), true);
  }
}

async function handleSend() {
  if (sendBusy || !window.dictateOverlay?.send) return;
  setSendBusy(true);
  try {
    const result = await window.dictateOverlay.send();
    if (result?.sent || result?.success) {
      setStatus(result.status || 'Sent captions to ChatGPT');
    } else {
      setStatus(result?.error || result?.status || 'Send failed', true, result);
    }
  } catch (e) {
    setStatus(String(e?.message || e), true);
  } finally {
    setSendBusy(false);
  }
}

function setupResize() {
  if (!resizeHandle || !window.dictateOverlay?.resizeBy) return;

  resizeHandle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    resizePointerId = e.pointerId;
    resizeLastX = e.screenX;
    resizeLastY = e.screenY;
    resizeHandle.setPointerCapture(e.pointerId);
  });

  resizeHandle.addEventListener('pointermove', (e) => {
    if (resizePointerId !== e.pointerId) return;
    const dx = e.screenX - resizeLastX;
    const dy = e.screenY - resizeLastY;
    if (dx || dy) {
      window.dictateOverlay.resizeBy(dx, dy);
      resizeLastX = e.screenX;
      resizeLastY = e.screenY;
    }
  });

  const endResize = (e) => {
    if (resizePointerId !== e.pointerId) return;
    resizePointerId = null;
    try { resizeHandle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  resizeHandle.addEventListener('pointerup', endResize);
  resizeHandle.addEventListener('pointercancel', endResize);
}

function setupChatGPTFrame() {
  if (!chatgptFrame) return;

  chatgptFrame.addEventListener('did-finish-load', () => {
    loadingEl?.classList.add('hidden');
  });

  chatgptFrame.addEventListener('did-fail-load', (event) => {
    const code = event.errorCode;
    if (code === -3) return;
    if (loadingEl) {
      loadingEl.classList.remove('hidden');
      loadingEl.textContent = 'Could not load ChatGPT — check your network, then restart Dictate.';
    }
  });

  chatgptFrame.addEventListener('console-message', (event) => {
    const level = event.level;
    const message = String(event.message || '');
    if (level < 2) return;
    if (/ResizeObserver|Non-Error promise rejection|favicon/i.test(message)) return;
    console.warn('[ChatGPT webview]', message);
    if (/Dictate|bridge|receiveFromTeams|__dictate/i.test(message)) {
      setStatus(message.slice(0, 180), true);
    }
  });

  chatgptFrame.addEventListener('render-process-gone', (event) => {
    const reason = event.reason || 'unknown';
    setStatus(`ChatGPT view crashed (${reason}) — restart Dictate Desktop`, true);
  });
}

window.addEventListener('error', (event) => {
  const msg = event?.error?.message || event?.message || 'Unknown overlay error';
  console.error('[Dictate overlay]', event?.error || event);
  setStatus(String(msg).slice(0, 180), true);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event?.reason;
  const msg = reason?.message || String(reason || 'Unhandled promise rejection');
  console.error('[Dictate overlay]', reason);
  setStatus(String(msg).slice(0, 180), true);
});

if (window.dictateOverlay) {
  window.dictateOverlay.onData(render);
  hideBtn.addEventListener('click', () => window.dictateOverlay.hide());
  transcriptBtn?.addEventListener('click', handleCopyTranscript);
  sendBtn.addEventListener('click', handleSend);
  joinBtn?.addEventListener('click', async () => {
    try {
      const resolved = await window.dictateOverlay.resolveJoin?.();
      if (resolved?.joinUrl) {
        setJoinAction(resolved.joinUrl, resolved.joinLabel);
        joinUrl = resolved.joinUrl;
      }
      if (resolved?.meetingId) {
        setMeetingIdTitle(resolved.meetingId, resolved.meetingIdDisplay);
      }
      const opened = await window.dictateOverlay.openUrl?.(joinUrl);
      if (opened?.meetingId) {
        setMeetingIdTitle(opened.meetingId, opened.meetingIdDisplay);
        setJoinAction(opened.joinUrl || joinUrl, opened.joinLabel || `Open Zoom ${opened.meetingId} in Chrome`);
        setStatus(`Opening Zoom meeting ${opened.meetingId} in Chrome`);
      } else if (!/\/wc\/join\/\d{9,11}/.test(joinUrl) && !/\/j\/\d{9,11}/.test(joinUrl)) {
        setStatus('Meeting ID not found — copy your Zoom invite, then click Open Zoom again', true, {
          joinUrl: 'https://app.zoom.us/wc/join',
          joinLabel: 'Open Zoom in Chrome'
        });
      }
    } catch (e) {
      setStatus(String(e?.message || e), true);
    }
  });
  setupResize();
  window.dictateOverlay.resolveJoin?.().then((resolved) => {
    if (resolved?.meetingId) {
      setMeetingIdTitle(resolved.meetingId, resolved.meetingIdDisplay);
      setJoinAction(resolved.joinUrl, resolved.joinLabel);
    }
  }).catch(() => {});
}

setupChatGPTFrame();
