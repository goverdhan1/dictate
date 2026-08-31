const { ipcMain, BrowserWindow } = require('electron');
const { refreshUndetectable } = require('./WindowHelper');

function setupIpc(appState, bridge) {
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

    return {
      sent: false,
      success: false,
      error: 'Send timed out — open Chrome Teams in your meeting with live captions enabled'
    };
  });

  ipcMain.handle('overlay-resize-by', (event, { dx, dy }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { success: false };
    const bounds = win.getBounds();
    win.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: Math.max(280, bounds.width + Math.round(dx || 0)),
      height: Math.max(160, bounds.height + Math.round(dy || 0))
    });
    return { success: true };
  });
}

module.exports = { setupIpc };
