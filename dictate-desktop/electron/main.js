const { app, BrowserWindow, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const { AppState } = require('./AppState');
const {
  createOverlayWindow,
  createSettingsWindow,
  showOverlayWindow
} = require('./WindowHelper');
const { setupIpc } = require('./ipcHandlers');
const { BridgeRouter } = require('./BridgeRouter');
const { BridgeServer } = require('./BridgeServer');
const { DesktopCaptionWatcher } = require('./DesktopCaptionWatcher');
const { TranscriptStore } = require('./TranscriptStore');

if (process.platform === 'win32') {
  try {
    if (require('electron-squirrel-startup')) app.quit();
  } catch {
    /* optional dev dependency */
  }
}

const appState = new AppState();
const transcriptStore = new TranscriptStore();
const bridgeServer = new BridgeServer(null);
const bridge = new BridgeRouter(appState, bridgeServer, transcriptStore);
bridgeServer.bridgeRouter = bridge;
const desktopWatcher = new DesktopCaptionWatcher({
  appState,
  onStatus: (payload) => {
    if (payload?.status) bridge.relayToOverlay({ status: payload.status });
  },
  onAutoForward: (text) => bridge.forwardToChatGPT(text),
  onTranscript: (line) => transcriptStore.append(line),
  transcriptStore
});
let tray = null;

function openSettings() {
  if (!appState.settingsWindow || appState.settingsWindow.isDestroyed()) {
    createSettingsWindow(appState);
  } else {
    appState.settingsWindow.focus();
  }
}

function showOrCreateOverlay() {
  if (!appState.overlayWindow || appState.overlayWindow.isDestroyed()) {
    createOverlayWindow(appState, wireChatGPTInjection);
    return;
  }
  showOverlayWindow(appState);
}

function createTray() {
  const iconPath = path.join(__dirname, '..', '..', 'icons', 'icon16.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Dictate');
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Show Overlay',
      click: () => showOrCreateOverlay()
    },
    {
      label: 'Settings',
      click: () => openSettings()
    },
    { type: 'separator' },
    { role: 'quit' }
  ]));
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Dictate',
      submenu: [
        {
          label: 'Show Overlay',
          click: () => showOrCreateOverlay()
        },
        {
          label: 'Settings',
          click: () => openSettings()
        },
        {
          label: 'Toggle Undetectable Mode',
          type: 'checkbox',
          checked: appState.isUndetectable(),
          click: (item) => {
            appState.setUndetectable(item.checked);
            const { refreshUndetectable } = require('./WindowHelper');
            refreshUndetectable(appState);
          }
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]);
}

function wireChatGPTInjection(guestWebContents) {
  if (!guestWebContents || guestWebContents.isDestroyed()) return;

  const injectSoon = () => {
    bridge.chatgptInjected = false;
    setTimeout(async () => {
      await bridge.ensureChatGPTReady();
    }, 2000);
  };

  guestWebContents.on('did-finish-load', injectSoon);
  if (!guestWebContents.isLoading()) {
    injectSoon();
  }
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(buildMenu());
  createTray();

  setupIpc(appState, bridge, desktopWatcher, transcriptStore);
  bridgeServer.start();
  desktopWatcher.start();

  createOverlayWindow(appState, wireChatGPTInjection);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createOverlayWindow(appState, wireChatGPTInjection);
    } else {
      showOrCreateOverlay();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    desktopWatcher.stop();
    app.quit();
  }
});

app.on('before-quit', () => {
  desktopWatcher.stop();
  try { transcriptStore.saveNow(); } catch { /* ignore */ }
});

process.on('uncaughtException', (err) => {
  console.error('[Dictate] uncaughtException:', err);
});
