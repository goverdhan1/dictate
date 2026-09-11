const hideBtn = document.getElementById('hide-btn');
const transcriptBtn = document.getElementById('transcript-btn');
const settingsBtn = document.getElementById('settings-btn');
const stealthBadge = document.getElementById('stealth-badge');
const sendBtn = document.getElementById('send-btn');
const resizeHandle = document.getElementById('resize-handle');
const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('status-text');
const joinBtn = document.getElementById('join-btn');
const meetingIdEl = document.getElementById('meeting-id');
const loadingEl = document.getElementById('chatgpt-loading');
const chatgptFrame = document.getElementById('chatgpt-frame');
const agentSelect = document.getElementById('agent-select');

let sendBusy = false;
let resizePointerId = null;
let resizeLastX = 0;
let resizeLastY = 0;
let statusTimer = null;
let joinUrl = 'https://app.zoom.us/wc/join';
let undetectableOn = true;
let currentAgent = { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com' };
let lastMeetingId = '';
let lastMeetingIdDisplay = '';

function applyAgentUi(provider, { loading = false } = {}) {
  if (!provider?.id) return;
  currentAgent = provider;
  if (agentSelect && agentSelect.value !== provider.id) {
    agentSelect.value = provider.id;
  }
  if (sendBtn) {
    sendBtn.title = `Send saved unsent captions to ${provider.name}`;
  }
  if (loading && loadingEl) {
    loadingEl.classList.remove('hidden');
    loadingEl.textContent = `Loading ${provider.name}…`;
  }
  setMeetingIdTitle(lastMeetingId, lastMeetingIdDisplay);
}

function fillAgentSelect(providers, selectedId) {
  if (!agentSelect || !Array.isArray(providers) || !providers.length) return;
  agentSelect.innerHTML = '';
  for (const p of providers) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    agentSelect.appendChild(opt);
  }
  agentSelect.value = selectedId || providers[0].id;
}

async function loadAgent(id, { persist = true } = {}) {
  const nextId = String(id || currentAgent.id || 'chatgpt');
  let provider = currentAgent;
  try {
    if (persist && window.dictateOverlay?.setAgent) {
      loadingEl?.classList.remove('hidden');
      if (loadingEl) loadingEl.textContent = 'Loading…';
      const result = await window.dictateOverlay.setAgent(nextId);
      provider = result?.provider || provider;
      applyAgentUi(provider, { loading: true });
      if (!result?.loaded && chatgptFrame && provider?.url) {
        chatgptFrame.src = provider.url;
      }
      return provider;
    }
  } catch (e) {
    setStatus(String(e?.message || e), true);
  }
  return provider;
}

function setStealthBadge(on) {
  undetectableOn = on !== false;
  if (!stealthBadge) return;
  stealthBadge.textContent = undetectableOn ? 'protected' : 'visible';
  stealthBadge.classList.toggle('off', !undetectableOn);
  stealthBadge.title = undetectableOn
    ? 'Undetectable Mode is ON — click to turn off, or open Settings'
    : 'Undetectable Mode is OFF — overlay may appear on screen share. Click to enable.';
}

function formatMeetingId(id) {
  const digits = String(id || '').replace(/\D/g, '');
  if (digits.length === 10) return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  if (digits.length === 11) return `${digits.slice(0, 3)} ${digits.slice(3, 7)} ${digits.slice(7)}`;
  if (digits.length === 9) return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  return digits;
}

function setMeetingIdTitle(meetingId, meetingIdDisplay) {
  lastMeetingId = meetingId || lastMeetingId;
  lastMeetingIdDisplay = meetingIdDisplay || lastMeetingIdDisplay;
  if (!meetingIdEl) return;
  const display = meetingIdDisplay || formatMeetingId(meetingId) || formatMeetingId(lastMeetingId);
  const agentName = currentAgent?.name || 'ChatGPT';
  if (!display) {
    meetingIdEl.textContent = '';
    meetingIdEl.classList.remove('visible');
    document.title = `${agentName} · Dictate`;
    return;
  }
  meetingIdEl.textContent = `· Zoom ${display}`;
  meetingIdEl.classList.add('visible');
  meetingIdEl.title = `Zoom Meeting ID ${display}`;
  document.title = `${agentName} · Zoom ${display}`;
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
  if (typeof data.undetectable === 'boolean') {
    setStealthBadge(data.undetectable);
  }
  if (data.agent?.id) {
    applyAgentUi(data.agent);
  }
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
      setStatus(result.status || `Sent captions to ${currentAgent.name}`);
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

  chatgptFrame.addEventListener('did-start-loading', () => {
    if (loadingEl) {
      loadingEl.classList.remove('hidden');
      loadingEl.textContent = `Loading ${currentAgent.name}…`;
    }
  });

  chatgptFrame.addEventListener('did-finish-load', () => {
    loadingEl?.classList.add('hidden');
  });

  chatgptFrame.addEventListener('did-fail-load', (event) => {
    const code = event.errorCode;
    if (code === -3) return;
    if (loadingEl) {
      loadingEl.classList.remove('hidden');
      loadingEl.textContent = `Could not load ${currentAgent.name} — check your network, then try another agent or restart Dictate.`;
    }
  });

  chatgptFrame.addEventListener('console-message', (event) => {
    const level = event.level;
    const message = String(event.message || '');
    if (level < 2) return;
    if (/ResizeObserver|Non-Error promise rejection|favicon/i.test(message)) return;
    console.warn(`[${currentAgent.name} webview]`, message);
    if (/Dictate|bridge|receiveFromTeams|__dictate/i.test(message)) {
      setStatus(message.slice(0, 180), true);
    }
  });

  chatgptFrame.addEventListener('render-process-gone', (event) => {
    const reason = event.reason || 'unknown';
    setStatus(`${currentAgent.name} view crashed (${reason}) — restart Dictate Desktop`, true);
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
  settingsBtn?.addEventListener('click', () => {
    window.dictateOverlay.openSettings?.().catch(() => {});
  });
  stealthBadge?.addEventListener('click', async () => {
    try {
      const next = !undetectableOn;
      const result = await window.dictateOverlay.setUndetectable?.(next);
      setStealthBadge(result?.undetectable ?? next);
      setStatus(next
        ? 'Undetectable Mode on — hidden from screen share'
        : 'Undetectable Mode off — visible on screen share', !next);
    } catch (e) {
      setStatus(String(e?.message || e), true);
    }
  });
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
  agentSelect?.addEventListener('mousedown', (e) => e.stopPropagation());
  agentSelect?.addEventListener('change', () => {
    loadAgent(agentSelect.value).catch((e) => setStatus(String(e?.message || e), true));
  });
  window.dictateOverlay.getUndetectable?.().then((res) => {
    setStealthBadge(res?.undetectable !== false);
  }).catch(() => setStealthBadge(true));
  window.dictateOverlay.getAgent?.().then((res) => {
    if (Array.isArray(res?.providers)) {
      fillAgentSelect(res.providers, res.provider?.id);
    }
    if (res?.provider) applyAgentUi(res.provider, { loading: true });
    const url = res?.provider?.url || currentAgent.url;
    if (chatgptFrame && url) chatgptFrame.src = url;
  }).catch(() => {
    applyAgentUi(currentAgent, { loading: true });
    if (chatgptFrame) chatgptFrame.src = currentAgent.url;
  });
  window.dictateOverlay.resolveJoin?.().then((resolved) => {
    if (resolved?.meetingId) {
      setMeetingIdTitle(resolved.meetingId, resolved.meetingIdDisplay);
      setJoinAction(resolved.joinUrl, resolved.joinLabel);
    }
  }).catch(() => {});
}

setupChatGPTFrame();
