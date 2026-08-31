const questionEl = document.getElementById('question');
const answerEl = document.getElementById('answer');
const hideBtn = document.getElementById('hide-btn');
const sendBtn = document.getElementById('send-btn');
const resizeHandle = document.getElementById('resize-handle');

let sendBusy = false;
let resizePointerId = null;
let resizeLastX = 0;
let resizeLastY = 0;

function render(data) {
  if (data.question) {
    const q = data.question.length > 400 ? `${data.question.slice(0, 400)}…` : data.question;
    questionEl.textContent = q;
  }
  answerEl.textContent = data.answer || '';
  answerEl.classList.toggle('streaming', !!data.streaming);
}

function setSendBusy(busy) {
  sendBusy = busy;
  sendBtn.disabled = busy;
  sendBtn.textContent = busy ? 'Sending…' : 'Send';
}

async function handleSend() {
  if (sendBusy || !window.dictateOverlay?.send) return;
  setSendBusy(true);
  try {
    const result = await window.dictateOverlay.send();
    if (result?.sent || result?.success) {
      render({ answer: 'Waiting for ChatGPT…', streaming: true });
    } else {
      render({
        answer: result?.error || result?.status || 'Send failed',
        streaming: false
      });
    }
  } catch (e) {
    render({ answer: String(e?.message || e), streaming: false });
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

if (window.dictateOverlay) {
  window.dictateOverlay.onData(render);
  hideBtn.addEventListener('click', () => window.dictateOverlay.hide());
  sendBtn.addEventListener('click', handleSend);
  setupResize();
}

render({ answer: 'Overlay ready — click Send after captions appear.', streaming: false });
