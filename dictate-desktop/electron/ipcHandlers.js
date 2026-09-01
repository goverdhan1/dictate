const { ipcMain, BrowserWindow, clipboard, dialog } = require('electron');
const { refreshUndetectable } = require('./WindowHelper');

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

    if (transcriptStore?.getCurrent()?.lines?.length && !transcriptStore.hasUnsent()) {
      return {
        sent: false,
        success: false,
        error: 'No unsent captions — new lines will queue here'
      };
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
        return {
          sent: !!result.sent,
          success: !!result.success,
          error: result.error,
          status: result.status
        };
      }
    }

    if (desktopWatcher?.isMeetingActive()) {
      return {
        sent: false,
        success: false,
        error: 'No unsent captions — turn on live captions in Teams, Zoom, Webex, or Meet (Windows: Win+Ctrl+L also works)'
      };
    }

    return {
      sent: false,
      success: false,
      error: 'Send timed out — join a desktop meeting with live captions, or open the meeting in your browser with the Dictate extension'
    };
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
