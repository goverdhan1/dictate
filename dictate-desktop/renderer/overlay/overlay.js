const hideBtn = document.getElementById('hide-btn');
const settingsBtn = document.getElementById('settings-btn');
const sendBtn = document.getElementById('send-btn');
const shotBtn = document.getElementById('shot-btn');
const contextBtn = document.getElementById('context-btn');
const resizeHandle = document.getElementById('resize-handle');
const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('status-text');
const joinBtn = document.getElementById('join-btn');
const meetingIdEl = document.getElementById('meeting-id');
const loadingEl = document.getElementById('chatgpt-loading');
const agentSelect = document.getElementById('agent-select');

let sendBusy = false;
let shotBusy = false;
let contextBusy = false;
let resizePointerId = null;
let resizeLastX = 0;
let resizeLastY = 0;
let statusTimer = null;
let joinUrl = 'https://app.zoom.us/wc/join';
let currentAgent = { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com' };
let lastMeetingId = '';
let lastMeetingIdDisplay = '';
let loadingWatchdog = null;

function clearLoadingWatchdog() {
  if (loadingWatchdog) {
    clearTimeout(loadingWatchdog);
    loadingWatchdog = null;
  }
}

function showAgentLoading(provider = currentAgent) {
  if (!loadingEl) return;
  loadingEl.classList.remove('hidden');
  loadingEl.textContent = `Loading ${provider?.name || 'agent'}…`;
  clearLoadingWatchdog();
  loadingWatchdog = setTimeout(() => {
    if (!loadingEl || loadingEl.classList.contains('hidden')) return;
    loadingEl.textContent =
      `${provider?.name || 'Agent'} is taking too long. Check your network, pick the agent again, or restart Dictate Desktop.`;
    setStatus(`${provider?.name || 'Agent'} page did not finish loading`, true);
  }, 60000);
}

function hideAgentLoading() {
  clearLoadingWatchdog();
  loadingEl?.classList.add('hidden');
}

function applyAgentUi(provider, { loading = false } = {}) {
  if (!provider?.id) return;
  currentAgent = provider;
  if (agentSelect && agentSelect.value !== provider.id) {
    agentSelect.value = provider.id;
  }
  if (sendBtn) {
    sendBtn.title = `Send saved unsent captions to ${provider.name}`;
  }
  if (shotBtn) {
    shotBtn.title = `Capture the screen and ask ${provider.name} for an answer`;
  }
  if (contextBtn) {
    contextBtn.title = `Send the saved resume, job description, and instructions to ${provider.name}`;
  }
  if (loading) showAgentLoading(provider);
  setMeetingIdTitle(lastMeetingId, lastMeetingIdDisplay);
}

async function loadAgent(id) {
  const nextId = String(id || currentAgent.id || 'chatgpt');
  let provider = currentAgent;
  try {
    if (!window.dictateOverlay?.setAgent) {
      setStatus('Overlay bridge unavailable — restart Dictate Desktop', true);
      return provider;
    }
    showAgentLoading(provider);
    const result = await window.dictateOverlay.setAgent(nextId);
    provider = result?.provider || provider;
    applyAgentUi(provider, { loading: !result?.loaded });
    if (result?.loaded) hideAgentLoading();
    if (result?.error && !result?.loaded) {
      setStatus(result.error, true);
    }
    return provider;
  } catch (e) {
    setStatus(String(e?.message || e), true);
    hideAgentLoading();
  }
  return provider;
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

function applyCaptionMode(mode) {
  const live = mode !== 'mock';
  if (!hideBtn) return;
  hideBtn.hidden = live;
}

function render(data) {
  if (!data) return;
  if (data.captionMode) applyCaptionMode(data.captionMode);
  if (data.agent?.id) {
    applyAgentUi(data.agent);
  }
  if (typeof data.agentLoading === 'boolean') {
    if (data.agentLoading) showAgentLoading(data.agent || currentAgent);
    else hideAgentLoading();
  }
  if (data.meetingId || data.meetingIdDisplay) {
    setMeetingIdTitle(data.meetingId, data.meetingIdDisplay);
  }
  const error = data.error || (data.success === false ? data.answer || data.status : '');
  if (error) {
    hideAgentLoading();
    setStatus(error, true, data);
    return;
  }
  if (data.status) {
    setStatus(data.status, false, data.joinUrl ? data : null);
  }
}

function syncActionButtons() {
  const busy = sendBusy || shotBusy || contextBusy;
  if (sendBtn) {
    sendBtn.disabled = busy;
    sendBtn.textContent = sendBusy ? 'Sending…' : 'Send';
  }
  if (shotBtn) {
    shotBtn.disabled = busy;
    shotBtn.textContent = shotBusy ? 'Sending…' : 'Screenshot';
  }
  if (contextBtn) {
    contextBtn.disabled = busy;
    contextBtn.textContent = contextBusy ? 'Sending…' : 'Context';
  }
}

function setSendBusy(busy) {
  sendBusy = busy;
  syncActionButtons();
}

function setShotBusy(busy) {
  shotBusy = busy;
  syncActionButtons();
}

function setContextBusy(busy) {
  contextBusy = busy;
  syncActionButtons();
}

async function handleSendContext() {
  if (sendBusy || shotBusy || contextBusy || !window.dictateOverlay?.sendContext) return;
  if (loadingEl && !loadingEl.classList.contains('hidden')) {
    setStatus(`${currentAgent.name} is still loading — wait for the chat UI, then send context again`, true);
    return;
  }
  setContextBusy(true);
  setStatus(`Sending context to ${currentAgent.name}…`);
  try {
    const result = await window.dictateOverlay.sendContext();
    if (result?.success) {
      setStatus(result.status || `Sent context to ${currentAgent.name}`);
    } else {
      setStatus(result?.error || 'Could not send context', true);
    }
  } catch (e) {
    setStatus(String(e?.message || e), true);
  } finally {
    setContextBusy(false);
  }
}

async function handleSendScreenshot() {
  if (sendBusy || shotBusy || contextBusy || !window.dictateOverlay?.sendScreenshot) return;
  if (loadingEl && !loadingEl.classList.contains('hidden')) {
    setStatus(`${currentAgent.name} is still loading — wait for the chat UI, then try Screenshot again`, true);
    return;
  }
  setShotBusy(true);
  setStatus('Capturing the screen…');
  try {
    const result = await window.dictateOverlay.sendScreenshot();
    if (result?.sent || result?.success) {
      setStatus(result.status || `Sent screenshot to ${currentAgent.name}`);
    } else {
      setStatus(result?.error || result?.status || 'Screenshot send failed', true);
    }
  } catch (e) {
    setStatus(String(e?.message || e), true);
  } finally {
    setShotBusy(false);
  }
}

async function handleSend() {
  if (sendBusy || shotBusy || contextBusy || !window.dictateOverlay?.send) return;
  if (loadingEl && !loadingEl.classList.contains('hidden')) {
    setStatus(`${currentAgent.name} is still loading — wait for the chat UI, then Send again`, true);
    return;
  }
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
  hideBtn?.addEventListener('click', () => {
    if (hideBtn.hidden) return;
    window.dictateOverlay.hide();
  });
  window.dictateOverlay.getCaptionMode?.().then((res) => {
    applyCaptionMode(res?.captionMode);
  }).catch(() => applyCaptionMode('live'));
  settingsBtn?.addEventListener('click', () => {
    window.dictateOverlay.openSettings?.().catch(() => {});
  });
  contextBtn?.addEventListener('click', handleSendContext);
  shotBtn?.addEventListener('click', handleSendScreenshot);
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
  window.dictateOverlay.getAgent?.().then((res) => {
    if (Array.isArray(res?.providers)) {
      fillAgentSelect(res.providers, res.provider?.id);
    }
    if (res?.provider) applyAgentUi(res.provider, { loading: true });
  }).catch(() => {
    applyAgentUi(currentAgent, { loading: true });
  });
  window.dictateOverlay.resolveJoin?.().then((resolved) => {
    if (resolved?.meetingId) {
      setMeetingIdTitle(resolved.meetingId, resolved.meetingIdDisplay);
      setJoinAction(resolved.joinUrl, resolved.joinLabel);
    }
  }).catch(() => {});
} else {
  applyAgentUi(currentAgent, { loading: true });
  setStatus('Overlay bridge unavailable — restart Dictate Desktop', true);
}
