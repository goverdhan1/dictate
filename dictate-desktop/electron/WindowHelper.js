const { BrowserWindow, screen } = require('electron');
const path = require('path');
const { applyMacStealth } = require('../native/macos-stealth');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const CHATGPT_URL_RE = /^https:\/\/(www\.)?(chatgpt\.com|chat\.openai\.com)(\/|\?|#|$)/i;

function applyContentProtection(win, enable) {
  if (!win || win.isDestroyed()) return;
  try {
    // Opacity shield workaround for Electron setContentProtection regressions.
    win.setOpacity(1.0);
    win.setContentProtection(!!enable);
  } catch (e) {
    console.warn('[Dictate] setContentProtection failed:', e?.message || e);
  }
}

function applyUndetectable(win, enable) {
  applyContentProtection(win, enable);
  if (isMac && enable) {
    applyMacStealth(win);
  }
  if (isWin && enable && win) {
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
}

function chromeUserAgent(ua) {
  return String(ua || '').replace(/Electron\/[^\s]+/, 'Chrome/120.0.0.0');
}

function configureChatGPTWebContents(wc) {
  if (!wc || wc.isDestroyed()) return;
  wc.setBackgroundThrottling(false);
  try {
    wc.setUserAgent(chromeUserAgent(wc.getUserAgent()));
  } catch (e) {
    console.warn('[Dictate] ChatGPT UA failed:', e?.message || e);
  }
}

function attachOverlayChatGPT(win, appState, onGuestReady) {
  const preload = path.join(__dirname, 'preload', 'chatgpt-preload.js');

  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const src = String(params?.src || '');
    if (src && src !== 'about:blank' && !CHATGPT_URL_RE.test(src)) {
      event.preventDefault();
      return;
    }
    webPreferences.preload = preload;
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.sandbox = false;
    webPreferences.backgroundThrottling = false;
    if (params) {
      const ua = chromeUserAgent(params.useragent || params.userAgent || win.webContents.getUserAgent());
      params.useragent = ua;
      params.userAgent = ua;
    }
  });

  win.webContents.on('did-attach-webview', (_event, guest) => {
    appState.chatgptWebContents = guest;
    configureChatGPTWebContents(guest);
    guest.setWindowOpenHandler(({ url }) => {
      if (CHATGPT_URL_RE.test(url) || /openai\.com|accounts\.google\.com|appleid\.apple\.com/i.test(url)) {
        return { action: 'allow' };
      }
      return { action: 'deny' };
    });
    guest.on('destroyed', () => {
      if (appState.chatgptWebContents === guest) {
        appState.chatgptWebContents = null;
      }
    });
    if (typeof onGuestReady === 'function') onGuestReady(guest);
  });
}

function createOverlayWindow(appState, onChatGPTReady) {
  const { width } = screen.getPrimaryDisplay().workAreaSize;

  const win = new BrowserWindow({
    width: 560,
    height: 760,
    minWidth: 420,
    minHeight: 480,
    x: width - 580,
    y: 24,
    frame: false,
    transparent: false,
    backgroundColor: '#141418',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    show: false,
    focusable: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload', 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  });

  attachOverlayChatGPT(win, appState, onChatGPTReady);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay', 'index.html'));

  win.once('ready-to-show', () => {
    win.setOpacity(0);
    applyUndetectable(win, appState.isUndetectable());
    win.show();
    setTimeout(() => win.setOpacity(1), 50);
  });

  win.on('blur', () => {
    if (appState.isUndetectable() && isWin && !win.isDestroyed()) {
      win.setAlwaysOnTop(true, 'screen-saver', 1);
    }
  });

  win.on('closed', () => {
    appState.overlayWindow = null;
    appState.chatgptWebContents = null;
  });

  appState.overlayWindow = win;
  return win;
}

function createSettingsWindow(appState) {
  const win = new BrowserWindow({
    width: 320,
    height: 420,
    title: 'Dictate Settings',
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload', 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'settings', 'index.html'));
  appState.settingsWindow = win;
  win.on('closed', () => { appState.settingsWindow = null; });
  return win;
}

function showOverlayWindow(appState) {
  const overlay = appState.overlayWindow;
  if (!overlay || overlay.isDestroyed()) return false;
  if (overlay.isVisible()) {
    try { overlay.moveTop(); } catch { /* ignore */ }
    return true;
  }
  overlay.setOpacity(0);
  overlay.show();
  setTimeout(() => {
    if (!overlay.isDestroyed()) overlay.setOpacity(1);
  }, 50);
  return true;
}

function refreshUndetectable(appState) {
  const enable = appState.isUndetectable();
  if (appState.overlayWindow && !appState.overlayWindow.isDestroyed()) {
    applyUndetectable(appState.overlayWindow, enable);
  }
}

module.exports = {
  createOverlayWindow,
  createSettingsWindow,
  applyUndetectable,
  applyContentProtection,
  refreshUndetectable,
  showOverlayWindow,
  configureChatGPTWebContents
};
