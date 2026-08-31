const { BrowserWindow, screen } = require('electron');
const path = require('path');
const { applyMacStealth } = require('../native/macos-stealth');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

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

function createChatGPTWindow(appState) {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    title: 'Dictate — ChatGPT',
    webPreferences: {
      preload: path.join(__dirname, 'preload', 'chatgpt-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadURL('https://chatgpt.com');
  win.webContents.setBackgroundThrottling(false);
  win.webContents.setUserAgent(win.webContents.getUserAgent().replace(/Electron\/[^\s]+/, 'Chrome/120.0.0.0'));

  if (appState.isUndetectable()) {
    applyUndetectable(win, true);
  }

  appState.chatgptWindow = win;
  return win;
}

function createOverlayWindow(appState) {
  const { width } = screen.getPrimaryDisplay().workAreaSize;

  const win = new BrowserWindow({
    width: 400,
    height: 320,
    minWidth: 280,
    minHeight: 160,
    x: width - 420,
    y: 24,
    frame: false,
    transparent: true,
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
      sandbox: false
    }
  });

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

function refreshUndetectable(appState) {
  const enable = appState.isUndetectable();
  if (appState.overlayWindow && !appState.overlayWindow.isDestroyed()) {
    applyUndetectable(appState.overlayWindow, enable);
  }
  if (appState.chatgptWindow && !appState.chatgptWindow.isDestroyed()) {
    applyUndetectable(appState.chatgptWindow, enable);
  }
}

module.exports = {
  createChatGPTWindow,
  createOverlayWindow,
  createSettingsWindow,
  applyUndetectable,
  applyContentProtection,
  refreshUndetectable
};
