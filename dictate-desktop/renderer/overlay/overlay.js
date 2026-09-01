const hideBtn = document.getElementById('hide-btn');
const transcriptBtn = document.getElementById('transcript-btn');
const sendBtn = document.getElementById('send-btn');
const resizeHandle = document.getElementById('resize-handle');
const statusEl = document.getElementById('status');
const loadingEl = document.getElementById('chatgpt-loading');
const chatgptFrame = document.getElementById('chatgpt-frame');

let sendBusy = false;
let resizePointerId = null;
let resizeLastX = 0;
let resizeLastY = 0;
let statusTimer = null;

function setStatus(message, isError = false) {
  clearTimeout(statusTimer);
  const text = String(message || '').trim();
  if (!text) {
    statusEl.textContent = '';
    statusEl.classList.remove('visible', 'error');
    return;
  }
  statusEl.textContent = text;
  statusEl.classList.add('visible');
  statusEl.classList.toggle('error', !!isError);
  if (!isError) {
    statusTimer = setTimeout(() => setStatus(''), 4000);
  }
}

function render(data) {
  if (!data) return;
  const error = data.error || (data.success === false ? data.answer || data.status : '');
  if (error) {
    setStatus(error, true);
    return;
  }
  if (data.status) {
    setStatus(data.status, false);
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
      setStatus(result?.error || result?.status || 'Send failed', true);
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
}

if (window.dictateOverlay) {
  window.dictateOverlay.onData(render);
  hideBtn.addEventListener('click', () => window.dictateOverlay.hide());
  transcriptBtn?.addEventListener('click', handleCopyTranscript);
  sendBtn.addEventListener('click', handleSend);
  setupResize();
}

setupChatGPTFrame();
