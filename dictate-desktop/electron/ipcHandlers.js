const { ipcMain, BrowserWindow, clipboard, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const { refreshUndetectable } = require('./WindowHelper');
const {
  parseZoomMeetingId,
  parseZoomPasscode,
  buildZoomJoinUrl,
  extractZoomInviteUrl,
  formatZoomMeetingId
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

function setupIpc(appState, bridge, desktopWatcher = null, transcriptStore = null) {
  ipcMain.handle('dictate', async (event, { channel, payload }) => {
    switch (channel) {
      case 'runtime-message':
        return bridge.handleRuntimeMessage(payload);
      case 'storage-get':
        return bridge.handleStorageGet(payload?.keys);
      case 'storage-set':
        return bridge.handleStorageSet(payload?.data);
      case 'get-settings':
        return appState.getAll();
      case 'set-undetectable':
        appState.setUndetectable(!!payload?.value);
        refreshUndetectable(appState);
        return { success: true, undetectable: appState.isUndetectable() };
      case 'set-setting':
        if (payload?.key) appState.set(payload.key, payload.value);
        return { success: true };
      default:
        return { success: false, error: 'Unknown channel' };
    }
  });

  ipcMain.handle('overlay-update', async (_event, payload) => {
    bridge.relayToOverlay(payload);
    return { success: true };
  });

  ipcMain.handle('overlay-hide', async () => {
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
      const chunk = transcriptStore.takeUnsentChunk();
      if (!chunk.lines.length) return null;
      const settings = appState.getAll?.() || {};
      const prefix = settings.forwardPrefix || '';
      const batch = transcriptStore.formatUnsent(chunk.lines);
      if (!batch.trim()) return null;
      const payload = prefix ? prefix + batch : batch;
      const result = await bridge.forwardToChatGPT(payload);
      if (result?.success) {
        transcriptStore.markSent(chunk.lines);
        desktopWatcher?.queue?.markSent(chunk.lines);
      }
      const remaining = transcriptStore.getUnsent().length;
      const n = chunk.lines.length;
      return {
        sent: !!result?.success,
        success: !!result?.success,
        error: result?.error,
        status: result?.success
          ? (remaining
            ? `Sent ${n} captions from transcript · ${remaining} still queued, click Send again`
            : `Sent ${n} caption${n === 1 ? '' : 's'} from transcript`)
          : result?.error,
        source: 'transcript',
        lineCount: n,
        remaining
      };
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
    const choice = await dialog.showSaveDialog(win || undefined, {
      title: 'Export meeting transcript',
      defaultPath: `dictate-transcript-${stamp}.txt`,
      filters: [{ name: 'Text', extensions: ['txt'] }]
    });
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
