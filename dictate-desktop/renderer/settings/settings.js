const undetectable = document.getElementById('undetectable');
const undetectableStatus = document.getElementById('undetectable-status');
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

function setUndetectableStatus(on) {
  if (!undetectableStatus) return;
  undetectableStatus.textContent = on
    ? 'On — the ChatGPT overlay should stay hidden from screen share. Restart Dictate Desktop if attendees still see it.'
    : 'Off — the overlay is visible on screen share. Check this box to hide it.';
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
  if (!window.dictateSettings?.getSettings) {
    if (undetectableStatus) {
      undetectableStatus.textContent = 'Settings API unavailable — restart Dictate Desktop.';
    }
    return;
  }
  try {
    const settings = await window.dictateSettings.getSettings();
    undetectable.checked = true;
    if (settings?.undetectable === false) {
      try {
        await window.dictateSettings.setUndetectable(true);
      } catch {
        /* still show checked — capture exclusion is the default */
      }
    }
    setUndetectableStatus(true);
  } catch (e) {
    if (undetectableStatus) {
      undetectableStatus.textContent = `Could not load settings: ${e?.message || e}`;
    }
  }
  await refreshTranscript();
}

undetectable.addEventListener('change', async () => {
  const on = undetectable.checked;
  setUndetectableStatus(on);
  try {
    await window.dictateSettings.setUndetectable(on);
  } catch {
    /* ignore */
  }
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
