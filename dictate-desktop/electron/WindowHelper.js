const { BrowserWindow, screen } = require('electron');
const path = require('path');
const { applyMacStealth } = require('../native/macos-stealth');
const { applyWindowsExcludeFromCapture } = require('../native/windows-stealth');
const { isAllowedOverlayUrl } = require('./aiProviders');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

/** Re-apply capture exclusion while the overlay stays visible (Teams can drop affinity). */
const stealthTimers = new WeakMap();

function applyContentProtection(win, enable) {
  if (!win || win.isDestroyed()) return;
  try {
    // Layered-window nudge: some Win10/11 builds only honor affinity after opacity touches WS_EX_LAYERED.
    const current = win.getOpacity();
    if (current >= 0.999) win.setOpacity(0.99);
    win.setContentProtection(!!enable);
    if (current >= 0.999) win.setOpacity(1.0);
    else if (Math.abs(current - win.getOpacity()) > 0.001) win.setOpacity(current);
  } catch (e) {
    console.warn('[Dictate] setContentProtection failed:', e?.message || e);
  }
  if (isWin) {
    applyWindowsExcludeFromCapture(win, !!enable);
  }
}

function stopStealthKeepAlive(win) {
  const timer = stealthTimers.get(win);
  if (timer) {
    clearInterval(timer);
    stealthTimers.delete(win);
  }
}

function startStealthKeepAlive(win, appState) {
  if (!isWin || !win || win.isDestroyed()) return;
  stopStealthKeepAlive(win);
  let tick = 0;
  const timer = setInterval(() => {
    if (!win || win.isDestroyed()) {
      stopStealthKeepAlive(win);
      return;
    }
    if (!win.isVisible() || !appState.isUndetectable()) return;
    try {
      win.setContentProtection(true);
      tick += 1;
      // Native affinity is slower; reinforce less often than Electron's API.
      if (tick === 1 || tick % 5 === 0) {
        applyWindowsExcludeFromCapture(win, true);
      }
    } catch {
      /* ignore */
    }
  }, 2000);
  stealthTimers.set(win, timer);
}

function applyUndetectable(win, enable, appState = null) {
  if (!win || win.isDestroyed()) return;
  applyContentProtection(win, enable);
  if (isMac && enable) {
    applyMacStealth(win);
  }
  if (isWin && enable) {
    try {
      win.setAlwaysOnTop(true, 'screen-saver', 1);
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch {
      /* ignore */
    }
  }
  if (appState) {
    if (enable && isWin) startStealthKeepAlive(win, appState);
    else stopStealthKeepAlive(win);
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
    if (src && !isAllowedOverlayUrl(src)) {
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
      try {
        const parsed = new URL(String(url || ''));
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:' || isAllowedOverlayUrl(url)) {
          return { action: 'allow' };
        }
      } catch {
        /* deny */
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
    applyUndetectable(win, appState.isUndetectable(), appState);
    win.show();
    // Affinity can be dropped on first show — re-apply after the HWND is live.
    setTimeout(() => {
      if (!win.isDestroyed()) applyUndetectable(win, appState.isUndetectable(), appState);
    }, 100);
    setTimeout(() => {
      if (!win.isDestroyed()) applyUndetectable(win, appState.isUndetectable(), appState);
    }, 500);
  });

  win.on('show', () => {
    if (appState.isUndetectable()) {
      applyUndetectable(win, true, appState);
    }
  });

  win.on('blur', () => {
    if (appState.isUndetectable() && isWin && !win.isDestroyed()) {
      try { win.setAlwaysOnTop(true, 'screen-saver', 1); } catch { /* ignore */ }
      applyUndetectable(win, true, appState);
    }
  });

  win.on('focus', () => {
    if (appState.isUndetectable() && !win.isDestroyed()) {
      applyUndetectable(win, true, appState);
    }
  });

  win.on('closed', () => {
    stopStealthKeepAlive(win);
    appState.overlayWindow = null;
    appState.chatgptWebContents = null;
  });

  appState.overlayWindow = win;
  return win;
}

function createSettingsWindow(appState) {
  const win = new BrowserWindow({
    width: 460,
    height: 680,
    title: 'Dictate Settings',
    resizable: true,
    alwaysOnTop: true,
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

function showSettingsWindow(appState) {
  if (!appState.settingsWindow || appState.settingsWindow.isDestroyed()) {
    createSettingsWindow(appState);
  }
  const win = appState.settingsWindow;
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  try { win.moveTop(); } catch { /* ignore */ }
  return true;
}

function notifyOverlayUndetectable(appState) {
  const overlay = appState.overlayWindow;
  if (!overlay || overlay.isDestroyed()) return;
  try {
    overlay.webContents.send('overlay-data', {
      undetectable: appState.isUndetectable()
    });
  } catch {
    /* ignore */
  }
}

function showOverlayWindow(appState) {
  const overlay = appState.overlayWindow;
  if (!overlay || overlay.isDestroyed()) return false;
  const enable = appState.isUndetectable();
  if (overlay.isVisible()) {
    try { overlay.moveTop(); } catch { /* ignore */ }
    applyUndetectable(overlay, enable, appState);
    return true;
  }
  // Do not flash opacity here — it clears WDA_EXCLUDEFROMCAPTURE on Windows.
  overlay.show();
  applyUndetectable(overlay, enable, appState);
  setTimeout(() => {
    if (!overlay.isDestroyed()) applyUndetectable(overlay, enable, appState);
  }, 100);
  return true;
}

function refreshUndetectable(appState) {
  const enable = appState.isUndetectable();
  if (appState.overlayWindow && !appState.overlayWindow.isDestroyed()) {
    applyUndetectable(appState.overlayWindow, enable, appState);
  }
  notifyOverlayUndetectable(appState);
}

module.exports = {
  createOverlayWindow,
  createSettingsWindow,
  showSettingsWindow,
  applyUndetectable,
  applyContentProtection,
  refreshUndetectable,
  showOverlayWindow,
  configureChatGPTWebContents
};
