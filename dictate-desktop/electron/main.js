const { app, BrowserWindow, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const { AppState } = require('./AppState');
const {
  createOverlayWindow,
  showSettingsWindow,
  showOverlayWindow
} = require('./WindowHelper');
const { setupIpc } = require('./ipcHandlers');
const { BridgeRouter } = require('./BridgeRouter');
const { BridgeServer } = require('./BridgeServer');
const { DesktopCaptionWatcher } = require('./DesktopCaptionWatcher');
const { TranscriptStore } = require('./TranscriptStore');

const PROTOCOL = 'dictate';

if (process.platform === 'win32') {
  try {
    if (require('electron-squirrel-startup')) app.quit();
  } catch {
    /* optional dev dependency */
  }
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

const appState = new AppState();
const transcriptStore = new TranscriptStore();
const bridgeServer = new BridgeServer(null);
const bridge = new BridgeRouter(appState, bridgeServer, transcriptStore);
bridgeServer.bridgeRouter = bridge;
const desktopWatcher = new DesktopCaptionWatcher({
  appState,
  onStatus: (payload) => {
    if (payload?.status) bridge.relayToOverlay(payload);
  },
  onMeetingDetails: (payload) => {
    bridge.relayToOverlay({
      status: payload.meetingIdDisplay
        ? `Zoom Meeting ID ${payload.meetingIdDisplay}`
        : '',
      meetingId: payload.meetingId,
      meetingIdDisplay: payload.meetingIdDisplay,
      joinUrl: payload.joinUrl,
      joinLabel: payload.meetingId ? `Open Zoom ${payload.meetingId} in Chrome` : 'Open Zoom in Chrome'
    });
  },
  onTranscript: (line) => transcriptStore.append(line),
  transcriptStore
});
let tray = null;

function registerDictateProtocol() {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
        path.resolve(process.argv[1])
      ]);
      return;
    }
  }
  app.setAsDefaultProtocolClient(PROTOCOL);
}

function openSettings() {
  showSettingsWindow(appState);
}

function showOrCreateOverlay() {
  if (!appState.overlayWindow || appState.overlayWindow.isDestroyed()) {
    createOverlayWindow(appState, wireChatGPTInjection);
    return;
  }
  showOverlayWindow(appState);
}

bridge.onShowOverlay = () => showOrCreateOverlay();

if (gotTheLock) {
  app.on('second-instance', () => {
    if (app.isReady()) showOrCreateOverlay();
  });
  app.on('open-url', (event) => {
    event.preventDefault();
    if (app.isReady()) showOrCreateOverlay();
  });
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
          checked: true,
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
  if (!gotTheLock) return;

  registerDictateProtocol();
  Menu.setApplicationMenu(buildMenu());
  createTray();

  try {
    appState.set('lastZoomMeetingId', '');
    appState.set('lastZoomPasscode', '');
  } catch { /* ignore */ }

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
  console.error('[Dictate] uncaughtException:', err?.stack || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Dictate] unhandledRejection:', reason);
});
