const undetectable = document.getElementById('undetectable');
const bridgeEnabled = document.getElementById('bridgeEnabled');
const preview = document.getElementById('transcript-preview');
const meta = document.getElementById('transcript-meta');
const statusEl = document.getElementById('transcript-status');
const copyBtn = document.getElementById('copy-transcript');
const exportBtn = document.getElementById('export-transcript');
const endBtn = document.getElementById('end-transcript');

function setStatus(message, isError = false) {
  statusEl.textContent = message || '';
  statusEl.classList.toggle('error', !!isError);
}

function renderTranscript(data) {
  const count = data?.count || data?.lines?.length || 0;
  const platform = data?.platform ? String(data.platform) : '';
  const started = data?.startedAt ? new Date(data.startedAt).toLocaleString() : '';
  preview.value = data?.text || '';
  if (!count) {
    meta.textContent = 'No captions stored yet';
    return;
  }
  const bits = [`${count} caption${count === 1 ? '' : 's'}`];
  if (platform) bits.push(platform);
  if (started) bits.push(`since ${started}`);
  meta.textContent = bits.join(' · ');
}

async function refreshTranscript() {
  if (!window.dictateSettings?.getTranscript) return;
  try {
    renderTranscript(await window.dictateSettings.getTranscript());
  } catch {
    /* ignore */
  }
}

async function load() {
  const settings = await window.dictateSettings.getSettings();
  undetectable.checked = settings.undetectable !== false;
  bridgeEnabled.checked = settings.bridgeEnabled !== false;
  await refreshTranscript();
}

undetectable.addEventListener('change', () => {
  window.dictateSettings.setUndetectable(undetectable.checked);
});

bridgeEnabled.addEventListener('change', () => {
  window.dictateSettings.setSetting('bridgeEnabled', bridgeEnabled.checked);
});

copyBtn.addEventListener('click', async () => {
  setStatus('');
  const result = await window.dictateSettings.copyTranscript();
  if (result?.success) {
    const n = result.count || 0;
    setStatus(n ? `Copied ${n} caption${n === 1 ? '' : 's'}` : 'Copied');
  } else {
    setStatus(result?.error || 'Nothing to copy', true);
  }
});

exportBtn.addEventListener('click', async () => {
  setStatus('');
  const result = await window.dictateSettings.exportTranscript();
  if (result?.canceled) return;
  if (result?.success) {
    setStatus('Exported transcript');
  } else {
    setStatus(result?.error || 'Export failed', true);
  }
});

endBtn.addEventListener('click', async () => {
  setStatus('');
  const result = await window.dictateSettings.endTranscript();
  if (result?.success) {
    setStatus(result.fileName ? `Saved ${result.fileName}` : 'Started a new transcript');
    await refreshTranscript();
  } else {
    setStatus(result?.error || 'Could not end call', true);
  }
});

load();
setInterval(refreshTranscript, 2000);
