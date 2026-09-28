const modeLive = document.getElementById('mode-live');
const modeMock = document.getElementById('mode-mock');
const selfNameInput = document.getElementById('self-name');
const captionModeStatus = document.getElementById('caption-mode-status');
const preview = document.getElementById('transcript-preview');
const meta = document.getElementById('transcript-meta');
const statusEl = document.getElementById('transcript-status');
const copyBtn = document.getElementById('copy-transcript');
const exportBtn = document.getElementById('export-transcript');
const endBtn = document.getElementById('end-transcript');
const aiProvider = document.getElementById('ai-provider');
const aiInstructions = document.getElementById('ai-instructions');
const aiInstructionsCount = document.getElementById('ai-instructions-count');
const resumeText = document.getElementById('resume-text');
const resumeFile = document.getElementById('resume-file');
const resumeCount = document.getElementById('resume-count');
const jdText = document.getElementById('jd-text');
const jdFile = document.getElementById('jd-file');
const jdCount = document.getElementById('jd-count');
const uploadResumeBtn = document.getElementById('upload-resume');
const clearResumeBtn = document.getElementById('clear-resume');
const uploadJdBtn = document.getElementById('upload-jd');
const clearJdBtn = document.getElementById('clear-jd');
const saveAiBtn = document.getElementById('save-ai-context');
const sendAiBtn = document.getElementById('send-ai-context');
const aiStatus = document.getElementById('ai-status');

let resumeFileName = '';
let jdFileName = '';
let aiLimits = { instructions: 8000, resumeText: 30000, jdText: 30000 };
let aiView = null;

function setAiStatus(message, isError = false) {
  if (!aiStatus) return;
  aiStatus.textContent = message || '';
  aiStatus.classList.toggle('error', !!isError);
  if (message) aiStatus.scrollIntoView({ block: 'nearest' });
}

function setButtonLabel(button, label, disabled) {
  if (!button) return;
  button.disabled = !!disabled;
  button.textContent = label;
}

function countLabel(text, limit) {
  const used = String(text || '').trim().length;
  return `${used.toLocaleString()} / ${Number(limit || 0).toLocaleString()}`;
}

function updateCounts() {
  if (aiInstructionsCount) aiInstructionsCount.textContent = countLabel(aiInstructions?.value, aiLimits.instructions);
  if (resumeCount) resumeCount.textContent = countLabel(resumeText?.value, aiLimits.resumeText);
  if (jdCount) jdCount.textContent = countLabel(jdText?.value, aiLimits.jdText);
}

function fileLabel(name, value, emptyLabel) {
  if (name) return name;
  if (String(value || '').trim()) return 'Pasted text';
  return emptyLabel;
}

function truncationNote(truncated) {
  const bits = [];
  if (truncated?.instructions) bits.push('instructions');
  if (truncated?.resume) bits.push('resume');
  if (truncated?.jd) bits.push('job description');
  if (!bits.length) return '';
  if (bits.length === 1) return `${bits[0][0].toUpperCase()}${bits[0].slice(1)} was shortened to fit the limit.`;
  return `${bits.join(', ')} were shortened to fit the limit.`;
}

function contextStatus(ctx) {
  const name = ctx?.providerName || 'the selected AI';
  if (!ctx?.active) return 'Add instructions, a resume, or a job description, then save.';
  if (ctx.applied) {
    return `${name} already received this context. After a new chat, click Send to AI now.`;
  }
  return `Saved. Dictate sends this to ${name} once when the overlay chat is ready, or click Send to AI now.`;
}

function renderAiFiles() {
  if (resumeFile) resumeFile.textContent = fileLabel(resumeFileName, resumeText?.value, 'No resume uploaded');
  if (jdFile) jdFile.textContent = fileLabel(jdFileName, jdText?.value, 'No job description uploaded');
}

function renderAiProvider(ctx) {
  if (!aiProvider) return;
  aiProvider.textContent = ctx?.providerName
    ? `Selected AI: ${ctx.providerName}. Dictate saves this on this computer and sends it to that AI.`
    : 'Dictate saves this on this computer and sends it to the AI selected in the overlay.';
}

function applyAiView(ctx, { fields = false } = {}) {
  if (!ctx) return;
  aiView = ctx;
  if (ctx.limits) aiLimits = ctx.limits;
  resumeFileName = ctx.resumeFileName || '';
  jdFileName = ctx.jdFileName || '';
  if (fields) {
    if (aiInstructions) aiInstructions.value = ctx.instructions || '';
    if (resumeText) resumeText.value = ctx.resumeText || '';
    if (jdText) jdText.value = ctx.jdText || '';
  }
  renderAiFiles();
  renderAiProvider(ctx);
  updateCounts();
}

function readAiForm() {
  const resumeValue = resumeText?.value || '';
  const jdValue = jdText?.value || '';
  return {
    instructions: aiInstructions?.value || '',
    resumeText: resumeValue,
    resumeFileName: resumeValue.trim() ? resumeFileName : '',
    jdText: jdValue,
    jdFileName: jdValue.trim() ? jdFileName : ''
  };
}

async function saveAiContext({ announce = true } = {}) {
  if (!window.dictateSettings?.saveAiContext) {
    setAiStatus('Settings API unavailable — restart Dictate Desktop.', true);
    return null;
  }
  if (announce) setButtonLabel(saveAiBtn, 'Saving…', true);
  try {
    const result = await window.dictateSettings.saveAiContext(readAiForm());
    if (!result?.success) {
      setAiStatus(result?.error || 'Could not save context', true);
      return null;
    }
    applyAiView(result.context, { fields: true });
    const note = truncationNote(result.truncated);
    if (announce) {
      setButtonLabel(saveAiBtn, 'Saved', false);
      setAiStatus([note, 'Context saved.', contextStatus(result.context)].filter(Boolean).join(' '));
      setTimeout(() => setButtonLabel(saveAiBtn, 'Save context', false), 1500);
    }
    return result;
  } catch (e) {
    setAiStatus(e?.message || 'Could not save context', true);
    return null;
  } finally {
    if (announce && saveAiBtn?.textContent === 'Saving…') setButtonLabel(saveAiBtn, 'Save context', false);
  }
}

async function uploadDocument(kind) {
  const button = kind === 'jd' ? uploadJdBtn : uploadResumeBtn;
  const idle = kind === 'jd' ? 'Upload JD' : 'Upload resume';
  setAiStatus(kind === 'jd' ? 'Choose a job description file…' : 'Choose a resume file…');
  if (!window.dictateSettings?.pickAiDocument) {
    setAiStatus('Settings API unavailable — restart Dictate Desktop.', true);
    return;
  }
  setButtonLabel(button, 'Opening…', true);
  try {
    const picked = await window.dictateSettings.pickAiDocument(kind);
    if (!picked || picked.canceled) {
      setAiStatus('');
      return;
    }
    if (!picked.success) {
      setAiStatus(picked.error || 'Could not read that file', true);
      return;
    }
    if (kind === 'jd') {
      jdText.value = picked.text || '';
      jdFileName = picked.fileName || '';
    } else {
      resumeText.value = picked.text || '';
      resumeFileName = picked.fileName || '';
    }
    renderAiFiles();
    updateCounts();
    await saveAiContext({ announce: true });
  } catch (e) {
    setAiStatus(e?.message || 'Could not read that file', true);
  } finally {
    setButtonLabel(button, idle, false);
  }
}

async function refreshAiProvider() {
  if (!window.dictateSettings?.getAiContext) return;
  try {
    const ctx = await window.dictateSettings.getAiContext();
    if (!ctx) return;
    const previousName = aiView?.providerName;
    aiView = { ...aiView, ...ctx };
    renderAiProvider(ctx);
    if (previousName && ctx.providerName && previousName !== ctx.providerName && aiStatus && !aiStatus.classList.contains('error')) {
      setAiStatus(contextStatus(ctx));
    }
  } catch {
    /* ignore */
  }
}

function setStatus(message, isError = false) {
  statusEl.textContent = message || '';
  statusEl.classList.toggle('error', !!isError);
}

let savedSelfName = '';
let savedSelfSource = '';
let savedSelfPlatform = '';

function meetingLabel(platform) {
  if (platform === 'zoom') return 'Zoom';
  if (platform === 'teams') return 'Teams';
  if (platform === 'webex') return 'Webex';
  if (platform === 'meet') return 'Google Meet';
  return 'the meeting';
}

function captionModeStatusText(live, name, source, platform) {
  if (!live) return 'Mock: Send includes your captions along with everyone else.';
  if (!name) {
    return 'Live: Send skips captions labeled You. Your name fills in from Teams, Zoom, Webex, or Google Meet.';
  }
  if (source === 'meeting') {
    return `Live: Send skips captions from “${name}”, found in ${meetingLabel(platform)}.`;
  }
  if (source === 'windows') {
    return `Live: Send skips captions from “${name}” until Teams, Zoom, Webex, or Google Meet shows your name.`;
  }
  return `Live: Send skips captions from you and from “${name}”. They stay in the transcript.`;
}

function applyCaptionMode(settings) {
  const live = settings?.captionMode !== 'mock';
  if (modeLive) modeLive.checked = live;
  if (modeMock) modeMock.checked = !live;
  savedSelfName = String(settings?.selfName || '');
  savedSelfSource = settings?.selfNameSource || '';
  savedSelfPlatform = settings?.selfNamePlatform || '';
  if (selfNameInput && document.activeElement !== selfNameInput) {
    selfNameInput.value = savedSelfName;
  }
  if (!captionModeStatus) return;
  const name = String(selfNameInput?.value || savedSelfName).trim();
  captionModeStatus.textContent = captionModeStatusText(live, name, savedSelfSource, savedSelfPlatform);
}

async function saveCaptionMode() {
  const mode = modeMock?.checked ? 'mock' : 'live';
  const selfName = selfNameInput?.value || '';
  const changed = selfName.trim() !== savedSelfName.trim();
  const source = changed ? (selfName.trim() ? 'manual' : '') : savedSelfSource;
  try {
    await window.dictateSettings.setSetting('captionMode', mode);
    await window.dictateSettings.setSetting('selfName', selfName);
    if (changed) {
      await window.dictateSettings.setSetting('selfNameSource', source);
      if (!selfName.trim()) await window.dictateSettings.setSetting('selfNamePlatform', '');
    }
  } catch {
    /* ignore */
  }
  applyCaptionMode({
    captionMode: mode,
    selfName,
    selfNameSource: source,
    selfNamePlatform: selfName.trim() ? savedSelfPlatform : ''
  });
}

async function refreshCaptionName() {
  if (!window.dictateSettings?.getSettings) return;
  if (selfNameInput && document.activeElement === selfNameInput) return;
  try {
    const settings = await window.dictateSettings.getSettings();
    const name = String(settings?.selfName || '');
    const source = settings?.selfNameSource || '';
    const platform = settings?.selfNamePlatform || '';
    if (name === savedSelfName && source === savedSelfSource && platform === savedSelfPlatform) return;
    applyCaptionMode(settings);
  } catch {
    /* ignore */
  }
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
  updateCounts();
  if (!window.dictateSettings?.getSettings) {
    if (aiProvider) {
      aiProvider.textContent = 'Open Settings from Dictate Desktop to save context for the selected AI.';
    }
    return;
  }
  try {
    const settings = await window.dictateSettings.getSettings();
    applyCaptionMode(settings);
  } catch {
    /* caption mode stays at the last saved values */
  }
  await refreshTranscript();
  if (window.dictateSettings?.getAiContext) {
    try {
      applyAiView(await window.dictateSettings.getAiContext(), { fields: true });
      if (aiView) setAiStatus(contextStatus(aiView));
    } catch (e) {
      setAiStatus(e?.message || 'Could not load AI context', true);
    }
  }
}

modeLive?.addEventListener('change', () => { saveCaptionMode(); });
modeMock?.addEventListener('change', () => { saveCaptionMode(); });
selfNameInput?.addEventListener('change', () => { saveCaptionMode(); });

copyBtn?.addEventListener('click', async () => {
  setStatus('');
  const result = await window.dictateSettings.copyTranscript();
  if (result?.success) {
    const n = result.count || 0;
    setStatus(n ? `Copied ${n} caption${n === 1 ? '' : 's'}` : 'Copied');
  } else {
    setStatus(result?.error || 'Nothing to copy', true);
  }
});

exportBtn?.addEventListener('click', async () => {
  setStatus('');
  const result = await window.dictateSettings.exportTranscript();
  if (result?.canceled) return;
  if (result?.success) {
    setStatus('Exported transcript');
  } else {
    setStatus(result?.error || 'Export failed', true);
  }
});

endBtn?.addEventListener('click', async () => {
  setStatus('');
  const result = await window.dictateSettings.endTranscript();
  if (result?.success) {
    setStatus(result.fileName ? `Saved ${result.fileName}` : 'Started a new transcript');
    await refreshTranscript();
  } else {
    setStatus(result?.error || 'Could not end call', true);
  }
});

aiInstructions?.addEventListener('input', updateCounts);
resumeText?.addEventListener('input', () => {
  if (!resumeText.value.trim()) resumeFileName = '';
  renderAiFiles();
  updateCounts();
});
jdText?.addEventListener('input', () => {
  if (!jdText.value.trim()) jdFileName = '';
  renderAiFiles();
  updateCounts();
});
uploadResumeBtn?.addEventListener('click', () => uploadDocument('resume'));
uploadJdBtn?.addEventListener('click', () => uploadDocument('jd'));
clearResumeBtn?.addEventListener('click', async () => {
  resumeText.value = '';
  resumeFileName = '';
  renderAiFiles();
  updateCounts();
  await saveAiContext({ announce: true });
});
clearJdBtn?.addEventListener('click', async () => {
  jdText.value = '';
  jdFileName = '';
  renderAiFiles();
  updateCounts();
  await saveAiContext({ announce: true });
});
saveAiBtn?.addEventListener('click', () => saveAiContext({ announce: true }));
sendAiBtn?.addEventListener('click', async () => {
  setAiStatus('Sending context…');
  const saved = await saveAiContext({ announce: false });
  if (!saved) return;
  try {
    const result = await window.dictateSettings.sendAiContext();
    if (result?.success) {
      if (result.context) applyAiView(result.context, { fields: false });
      setAiStatus(result.status || contextStatus(result.context));
    } else {
      setAiStatus(result?.error || 'Could not send context', true);
    }
  } catch (e) {
    setAiStatus(e?.message || 'Could not send context', true);
  }
});

load();
setInterval(() => {
  refreshTranscript();
  refreshAiProvider();
  refreshCaptionName();
}, 2000);
