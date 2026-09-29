const { ipcMain, BrowserWindow, clipboard, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const { refreshUndetectable, showSettingsWindow, loadAgentInOverlay, notifyOverlay } = require('./WindowHelper');
const { captureScreenForSend } = require('./screenCapture');
const { listProviders, publicProvider } = require('./aiProviders');
const {
  LIMITS,
  buildPrimeOnlyMessage,
  clampField,
  extractDocument
} = require('./aiContext');
const {
  parseZoomMeetingId,
  parseZoomPasscode,
  buildZoomJoinUrl,
  extractZoomInviteUrl,
  formatZoomMeetingId,
  splitCaptionsForSend
} = require('./CaptionQueue');

const JOIN_PAGES = {
  zoom: { joinUrl: 'https://app.zoom.us/wc/join', joinLabel: 'Open Zoom in Chrome' },
  teams: { joinUrl: 'https://teams.microsoft.com', joinLabel: 'Open Teams in Chrome' },
  meet: { joinUrl: 'https://meet.google.com', joinLabel: 'Open Meet in Chrome' },
  webex: { joinUrl: 'https://signin.webex.com/join', joinLabel: 'Open Webex in Chrome' }
};

function zoomDetailsFromClipboard() {
  try {
    const text = clipboard.readText() || '';
    const inviteUrl = extractZoomInviteUrl(text);
    if (!inviteUrl && !/(?:meeting\s*id|confno)/i.test(text)) {
      return { inviteUrl: '', meetingId: '', passcode: '' };
    }
    return {
      inviteUrl,
      meetingId: parseZoomMeetingId(inviteUrl || text),
      passcode: parseZoomPasscode(inviteUrl || text),
      source: inviteUrl ? 'invite' : 'labeled'
    };
  } catch {
    return { inviteUrl: '', meetingId: '', passcode: '' };
  }
}

function joinPageFor(desktopWatcher, preferred = '') {
  const platform = String(
    preferred
    || desktopWatcher?.activePlatform
    || desktopWatcher?.detected?.[0]
    || 'zoom'
  ).toLowerCase();
  if (platform === 'zoom') {
    const clip = zoomDetailsFromClipboard();
    // Prefer live Zoom process ID over clipboard unless clipboard has a full invite URL.
    const meetingId = (clip.inviteUrl && clip.meetingId)
      ? clip.meetingId
      : (desktopWatcher?.meetingId || clip.meetingId || '');
    const passcode = (clip.inviteUrl && clip.passcode)
      ? clip.passcode
      : (desktopWatcher?.meetingPasscode || clip.passcode || '');
    const source = (clip.inviteUrl && clip.meetingId)
      ? 'invite'
      : (desktopWatcher?.meetingIdSource || clip.source || '');
    if (meetingId) desktopWatcher?.rememberMeetingDetails?.(meetingId, passcode, source);
    return {
      joinUrl: buildZoomJoinUrl({ inviteUrl: clip.inviteUrl, meetingId, passcode }),
      joinLabel: meetingId ? `Open Zoom ${meetingId} in Chrome` : 'Open Zoom in Chrome',
      meetingId: meetingId || '',
      meetingIdDisplay: meetingId ? formatZoomMeetingId(meetingId) : '',
      passcode: passcode || ''
    };
  }
  return JOIN_PAGES[platform] || JOIN_PAGES.zoom;
}

async function resolveZoomJoinPage(desktopWatcher) {
  if (desktopWatcher?.probeZoomMeetingDetails) {
    await desktopWatcher.probeZoomMeetingDetails();
  }
  return joinPageFor(desktopWatcher, 'zoom');
}

function needsBrowserJoin(result) {
  const err = `${result?.error || ''} ${result?.status || ''} ${result?.joinUrl || ''}`;
  return /chrome|browser tab|zoom\.us\/wc|app\.zoom\.us|cannot be bridged|open your meeting|join the meeting in chrome/i.test(err);
}

function openInChrome(url) {
  const target = String(url || '').trim();
  if (!target) return { success: false, error: 'Missing URL' };
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '', 'chrome', target], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      }).unref();
      return { success: true, url: target };
    }
    shell.openExternal(target);
    return { success: true, url: target };
  } catch (e) {
    try {
      shell.openExternal(target);
      return { success: true, url: target };
    } catch (err) {
      return { success: false, error: err?.message || String(e) };
    }
  }
}

async function withNativeDialog(appState, parent, open) {
  const overlay = appState.overlayWindow;
  const overlayVisible = !!(overlay && !overlay.isDestroyed() && overlay.isVisible());
  const parentOnTop = !!(parent && !parent.isDestroyed() && parent.isAlwaysOnTop());
  try {
    if (overlayVisible) {
      try { overlay.hide(); } catch { /* ignore */ }
    }
    if (parent && !parent.isDestroyed()) {
      try { parent.setAlwaysOnTop(false); } catch { /* ignore */ }
      try { parent.show(); parent.focus(); } catch { /* ignore */ }
    }
    return await open(parent && !parent.isDestroyed() ? parent : undefined);
  } finally {
    if (parent && !parent.isDestroyed() && parentOnTop) {
      try {
        parent.setAlwaysOnTop(true);
        parent.show();
        parent.focus();
      } catch { /* ignore */ }
    }
    if (overlay && !overlay.isDestroyed() && overlayVisible) {
      try { overlay.show(); } catch { /* ignore */ }
    }
    refreshUndetectable(appState);
  }
}

const aiContextIpcBound = new WeakSet();

function bindAiContextIpc(ipc, appState, bridge) {
  if (!ipc || aiContextIpcBound.has(ipc)) return;
  aiContextIpcBound.add(ipc);

  ipc.handle('ai-context-get', async () => {
    try {
      return appState.getAiContextView();
    } catch (e) {
      return { success: false, error: e?.message || 'Could not load AI context' };
    }
  });

  ipc.handle('ai-context-save', async (_event, payload) => {
    try {
      const saved = appState.saveAiContext(payload || {});
      return { success: true, ...saved };
    } catch (e) {
      return { success: false, error: e?.message || 'Could not save context' };
    }
  });

  ipc.handle('ai-context-pick', async (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const kind = payload?.kind === 'jd' ? 'jd' : 'resume';
    const choice = await withNativeDialog(appState, win, (parent) => dialog.showOpenDialog(parent, {
      title: kind === 'jd' ? 'Upload job description' : 'Upload resume',
      filters: [
        { name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md', 'markdown', 'text', 'rtf'] }
      ],
      properties: ['openFile']
    }));
    if (choice.canceled || !choice.filePaths?.[0]) return { success: false, canceled: true };
    try {
      const extracted = await extractDocument(choice.filePaths[0]);
      const limit = kind === 'jd' ? LIMITS.jdText : LIMITS.resumeText;
      const clamped = clampField(extracted.text, limit);
      return {
        success: true,
        kind,
        fileName: extracted.fileName,
        text: clamped.text,
        truncated: clamped.truncated
      };
    } catch (e) {
      return { success: false, error: e?.message || 'Could not read that file' };
    }
  });

  ipc.handle('ai-context-send', async () => sendAiContextNow(appState, bridge));

  ipc.handle('overlay-send-context', async () => sendAiContextNow(appState, bridge));
}

async function sendAiContextNow(appState, bridge) {
  const message = buildPrimeOnlyMessage(appState.get('aiContext'));
  if (!message) {
    return { success: false, error: 'Add instructions, a resume, or a job description in Settings first' };
  }
  const result = await bridge.forwardToChatGPT(message, { raw: true, markApplied: true });
  if (!result?.success) {
    return { success: false, error: result?.error || 'Could not send context to the AI' };
  }
  const name = appState.getAgent()?.name || 'the AI';
  return {
    success: true,
    context: appState.getAiContextView(),
    status: `Sent context to ${name}`
  };
}

function setupIpc(appState, bridge, desktopWatcher = null, transcriptStore = null) {
  bindAiContextIpc(ipcMain, appState, bridge);
  const { app } = require('electron');
  app.on('web-contents-created', (_event, contents) => {
    bindAiContextIpc(contents.ipc, appState, bridge);
    const bindFrame = () => {
      try { bindAiContextIpc(contents.mainFrame?.ipc, appState, bridge); } catch { /* ignore */ }
    };
    contents.on('did-finish-load', bindFrame);
    bindFrame();
  });

  ipcMain.handle('dictate', async (event, { channel, payload }) => {
    switch (channel) {
      case 'runtime-message':
        return bridge.handleRuntimeMessage(payload);
      case 'storage-get':
        return bridge.handleStorageGet(payload?.keys);
      case 'storage-set':
        return bridge.handleStorageSet(payload?.data);
      case 'get-settings':
        appState.ensureSelfName?.();
        return appState.getAll();
      case 'set-undetectable':
        appState.setUndetectable(true);
        refreshUndetectable(appState);
        return { success: true, undetectable: true };
      case 'set-setting':
        if (payload?.key) appState.set(payload.key, payload.value);
        if (payload?.key === 'captionMode') {
          notifyOverlay(appState, {
            captionMode: payload.value === 'mock' ? 'mock' : 'live'
          });
        }
        return { success: true };
      default:
        return { success: false, error: 'Unknown channel' };
    }
  });

  ipcMain.handle('overlay-get-undetectable', async () => ({
    success: true,
    undetectable: appState.isUndetectable()
  }));

  ipcMain.handle('overlay-set-undetectable', async () => {
    appState.setUndetectable(true);
    refreshUndetectable(appState);
    return { success: true, undetectable: true };
  });

  ipcMain.handle('overlay-open-settings', async () => {
    showSettingsWindow(appState);
    return { success: true };
  });

  ipcMain.handle('overlay-get-agent', async () => {
    const provider = publicProvider(appState.getAgent());
    return {
      success: true,
      provider,
      providers: listProviders()
    };
  });

  ipcMain.handle('overlay-set-agent', async (_event, payload) => {
    const provider = publicProvider(appState.setAgentProvider(payload?.id));
    bridge.chatgptInjected = false;
    const result = await loadAgentInOverlay(appState, provider);
    return {
      success: true,
      provider,
      loaded: !!result.loaded,
      error: result.error || undefined
    };
  });

  ipcMain.handle('overlay-update', async (_event, payload) => {
    bridge.relayToOverlay(payload);
    return { success: true };
  });

  ipcMain.handle('overlay-get-caption-mode', async () => ({
    success: true,
    captionMode: appState.get('captionMode') === 'mock' ? 'mock' : 'live'
  }));

  ipcMain.handle('overlay-hide', async () => {
    if (appState.get('captionMode') !== 'mock') {
      return { success: false, error: 'Close is unavailable in Live mode' };
    }
    if (appState.overlayWindow && !appState.overlayWindow.isDestroyed()) {
      appState.overlayWindow.hide();
    }
    return { success: true };
  });

  ipcMain.handle('overlay-send', async () => {
    const startedAt = Date.now();
    appState.lastSendResult = null;

    async function flushTranscript() {
      if (!transcriptStore) return null;
      const mode = appState.get('captionMode') === 'mock' ? 'mock' : 'live';
      const selfNames = [appState.get('selfName')];
      let skipped = 0;

      while (transcriptStore.hasUnsent()) {
        const chunk = transcriptStore.takeUnsentChunk();
        if (!chunk.lines.length) break;
        const split = splitCaptionsForSend(chunk.lines, { mode, selfNames });
        if (split.skip.length) {
          transcriptStore.markSent(split.skip);
          desktopWatcher?.queue?.markSent(split.skip);
          skipped += split.skip.length;
        }
        if (!split.forward.length) continue;

        const batch = transcriptStore.formatUnsent(split.forward);
        if (!batch.trim()) {
          transcriptStore.markSent(split.forward);
          continue;
        }
        const result = await bridge.forwardToChatGPT(batch);
        if (result?.success) {
          transcriptStore.markSent(split.forward);
          desktopWatcher?.queue?.markSent(split.forward);
          bridge.bridgeServer?.enqueuePayload?.('markMeetingTranscriptSent', {
            lines: split.forward.map((line) => ({
              author: line.author || '',
              text: line.text || ''
            }))
          });
        }
        const remaining = transcriptStore.getUnsent().length;
        const n = split.forward.length;
        const skippedNote = skipped ? ` · skipped ${skipped} of yours` : '';
        return {
          sent: !!result?.success,
          success: !!result?.success,
          error: result?.error,
          status: result?.success
            ? (remaining
              ? `Sent ${n} captions${skippedNote} · ${remaining} still queued — click Send for the next part`
              : `Sent ${n} caption${n === 1 ? '' : 's'} from transcript${skippedNote}`)
            : result?.error,
          source: 'transcript',
          lineCount: n,
          remaining,
          skipped
        };
      }

      if (skipped) {
        return {
          sent: false,
          success: true,
          status: `Live mode — skipped ${skipped} of your caption${skipped === 1 ? '' : 's'}. Only other speakers are sent.`,
          skipped
        };
      }
      return null;
    }

    const first = await flushTranscript();
    if (first) return first;

    if (desktopWatcher?.isMeetingActive() && transcriptStore && !transcriptStore.hasUnsent()) {
      const waitUntil = Date.now() + 2500;
      while (Date.now() < waitUntil && !transcriptStore.hasUnsent()) {
        await new Promise((r) => setTimeout(r, 200));
      }
      const afterWait = await flushTranscript();
      if (afterWait) return afterWait;
    }

    // Desktop already has the call log and nothing left unsent — do not fall back to the
    // extension transcript (it may still list the same lines as unsent and re-send everything).
    if (transcriptStore) {
      const current = transcriptStore.getCurrent();
      if (current.lines.length > 0 && !transcriptStore.hasUnsent()) {
        return {
          sent: false,
          success: false,
          error: 'No new captions — all saved captions were already sent. Wait for more speech, then click Send.'
        };
      }
    }

    const queued = bridge.requestSendFromOverlay();
    if (!queued?.success) {
      return {
        sent: false,
        success: false,
        error: queued?.error || 'Start Dictate Desktop and reload the extension'
      };
    }

    while (Date.now() - startedAt < 30000) {
      await new Promise((r) => setTimeout(r, 200));
      const result = appState.lastSendResult;
      if (result?.at && result.at >= startedAt) {
        const payload = {
          sent: !!result.sent,
          success: !!result.success,
          error: result.error,
          status: result.status,
          joinUrl: result.joinUrl,
          joinLabel: result.joinLabel
        };
        if (!payload.sent && needsBrowserJoin(payload)) {
          const probed = await resolveZoomJoinPage(desktopWatcher);
          const withJoin = {
            ...payload,
            ...probed,
            joinUrl: probed.meetingId ? probed.joinUrl : (payload.joinUrl || probed.joinUrl),
            joinLabel: probed.joinLabel
          };
          openInChrome(withJoin.joinUrl);
          return withJoin;
        }
        if (!payload.sent && /no unsent captions/i.test(`${payload.error || ''} ${payload.status || ''}`)) {
          return {
            ...payload,
            error: 'No new captions yet — in the Chrome Zoom tab, turn on Captions / Live Transcript, wait for speech, then click Send'
          };
        }
        return payload;
      }
    }

    if (desktopWatcher?.isMeetingActive()) {
      return {
        sent: false,
        success: false,
        error: 'No unsent captions — turn on live captions in Teams, Zoom, Webex, or Meet (Windows: Win+Ctrl+L also works)'
      };
    }

    const timeoutJoin = {
      sent: false,
      success: false,
      error: 'Send timed out — join the meeting in Chrome, enable live captions, then click Send.',
      ...(await resolveZoomJoinPage(desktopWatcher))
    };
    openInChrome(timeoutJoin.joinUrl);
    return timeoutJoin;
  });

  ipcMain.handle('overlay-send-screenshot', async () => {
    const name = appState.getAgent?.()?.name || 'ChatGPT';
    try {
      const payload = await captureScreenForSend(appState);
      if (!payload?.base64) {
        return { success: false, sent: false, error: 'Could not capture the screen' };
      }
      const result = await bridge.forwardScreenshot(payload);
      if (result?.success) {
        return {
          success: true,
          sent: true,
          status: result.status || `Sent screenshot to ${name}`
        };
      }
      return {
        success: false,
        sent: false,
        error: result?.error || `Could not send the screenshot to ${name}`
      };
    } catch (e) {
      return { success: false, sent: false, error: e?.message || 'Screenshot send failed' };
    }
  });

  ipcMain.handle('transcript-get', async () => {
    if (!transcriptStore) return { startedAt: Date.now(), platform: '', lines: [], text: '', count: 0 };
    const current = transcriptStore.getCurrent();
    return {
      startedAt: current.startedAt,
      platform: current.platform,
      lines: current.lines,
      text: transcriptStore.formatText(),
      count: current.lines.length
    };
  });

  ipcMain.handle('transcript-copy', async () => {
    if (!transcriptStore) return { success: false, error: 'Transcript unavailable' };
    const text = transcriptStore.formatText();
    if (!text) return { success: false, error: 'No captions stored yet' };
    clipboard.writeText(text);
    return { success: true, count: transcriptStore.getCurrent().lines.length };
  });

  ipcMain.handle('transcript-export', async (event) => {
    if (!transcriptStore) return { success: false, error: 'Transcript unavailable' };
    const win = BrowserWindow.fromWebContents(event.sender);
    const started = transcriptStore.getCurrent().startedAt;
    const stamp = new Date(started || Date.now()).toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const choice = await withNativeDialog(appState, win, (parent) => dialog.showSaveDialog(parent, {
      title: 'Export meeting transcript',
      defaultPath: `dictate-transcript-${stamp}.txt`,
      filters: [{ name: 'Text', extensions: ['txt'] }]
    }));
    if (choice.canceled || !choice.filePath) return { success: false, canceled: true };
    return transcriptStore.exportTo(choice.filePath);
  });

  ipcMain.handle('transcript-end', async () => {
    if (!transcriptStore) return { success: false, error: 'Transcript unavailable' };
    const current = transcriptStore.getCurrent();
    if (!current.lines.length) return { success: false, error: 'No captions to save' };
    return transcriptStore.endCall();
  });

  ipcMain.handle('overlay-open-url', async (_event, payload) => {
    const requested = String(payload?.url || '').trim();
    const hasMeetingId = /\/wc\/\d{9,11}\//.test(requested);
    if (requested && hasMeetingId) {
      return openInChrome(requested);
    }
    const join = await resolveZoomJoinPage(desktopWatcher);
    const opened = openInChrome(join.joinUrl);
    return { ...opened, ...join };
  });

  ipcMain.handle('overlay-resolve-join', async () => {
    return resolveZoomJoinPage(desktopWatcher);
  });

  ipcMain.handle('overlay-resize-by', (event, { dx, dy }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { success: false };
    const bounds = win.getBounds();
    win.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: Math.max(420, bounds.width + Math.round(dx || 0)),
      height: Math.max(480, bounds.height + Math.round(dy || 0))
    });
    return { success: true };
  });
}

module.exports = { setupIpc };
