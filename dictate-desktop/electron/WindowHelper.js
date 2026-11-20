const { BrowserWindow, BrowserView, session, screen } = require('electron');
const path = require('path');
const { applyMacStealth } = require('../native/macos-stealth');
const { applyWindowsExcludeFromCapture } = require('../native/windows-stealth');
const { isAllowedOverlayUrl } = require('./aiProviders');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

/** Header chrome height in the overlay renderer (matches index.html). */
const OVERLAY_TOP_CHROME = 48;
const OVERLAY_MIN_WIDTH = 420;
const OVERLAY_MIN_HEIGHT = 480;
const OVERLAY_COMPACT_SIZE = 52;
const OVERLAY_OPACITY_MIN = 0.3;
const OVERLAY_OPACITY_MAX = 1;
const AGENT_PARTITION = 'persist:dictate-agent';

function clampOverlayOpacity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return OVERLAY_OPACITY_MAX;
  return Math.min(OVERLAY_OPACITY_MAX, Math.max(OVERLAY_OPACITY_MIN, n));
}

function getOverlayOpacity(appState) {
  return clampOverlayOpacity(appState?.get?.('overlayOpacity') ?? OVERLAY_OPACITY_MAX);
}

function applyOverlayOpacity(win, opacity) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setOpacity(clampOverlayOpacity(opacity));
  } catch (e) {
    console.warn('[Dictate] setOpacity failed:', e?.message || e);
  }
}

function setOverlayOpacity(appState, opacity) {
  const next = clampOverlayOpacity(opacity);
  appState?.set?.('overlayOpacity', next);
  const win = appState?.overlayWindow;
  if (win && !win.isDestroyed()) applyOverlayOpacity(win, next);
  notifyOverlay(appState, { opacity: next });
  return next;
}

function isOverlayCompact(appState) {
  return !!appState?.overlayCompact;
}

async function setOverlayCompact(appState, compact) {
  const win = appState?.overlayWindow;
  if (!win || win.isDestroyed()) return { success: false, compact: isOverlayCompact(appState) };
  const next = !!compact;
  if (next === isOverlayCompact(appState)) {
    return { success: true, compact: next };
  }

  // Switch renderer chrome first so the full UI is not briefly squashed into the icon size.
  appState.overlayCompact = next;
  notifyOverlay(appState, { compact: next });
  try {
    await win.webContents.executeJavaScript(
      `(() => {
        document.documentElement.classList.toggle('compact', ${next});
        document.body.classList.toggle('compact', ${next});
        const handle = document.getElementById('resize-handle');
        if (handle) handle.hidden = ${next};
      })()`,
      true
    );
  } catch {
    /* ignore */
  }

  if (next) {
    appState.overlayRestoredBounds = win.getBounds();
    try {
      win.setMinimumSize(OVERLAY_COMPACT_SIZE, OVERLAY_COMPACT_SIZE);
      win.setResizable(false);
      win.setHasShadow(false);
      win.setBackgroundColor('#00000000');
    } catch {
      /* ignore */
    }
    try {
      if (appState.agentView) win.removeBrowserView(appState.agentView);
    } catch {
      /* ignore */
    }
    const bounds = win.getBounds();
    win.setBounds({
      x: bounds.x + Math.max(0, bounds.width - OVERLAY_COMPACT_SIZE),
      y: bounds.y,
      width: OVERLAY_COMPACT_SIZE,
      height: OVERLAY_COMPACT_SIZE
    });
  } else {
    const restored = appState.overlayRestoredBounds;
    appState.overlayRestoredBounds = null;
    try {
      win.setMinimumSize(OVERLAY_MIN_WIDTH, OVERLAY_MIN_HEIGHT);
      win.setResizable(true);
      win.setHasShadow(true);
      win.setBackgroundColor('#00000000');
    } catch {
      /* ignore */
    }
    if (restored && Number.isFinite(restored.width) && Number.isFinite(restored.height)) {
      win.setBounds({
        x: restored.x,
        y: restored.y,
        width: Math.max(OVERLAY_MIN_WIDTH, restored.width),
        height: Math.max(OVERLAY_MIN_HEIGHT, restored.height)
      });
    } else {
      const { width } = screen.getPrimaryDisplay().workAreaSize;
      win.setBounds({
        width: 720,
        height: 760,
        x: width - 740,
        y: 24
      });
    }
    try {
      if (appState.agentView) win.setBrowserView(appState.agentView);
    } catch {
      /* ignore */
    }
  }

  layoutAgentView(appState);
  return { success: true, compact: next };
}

async function toggleOverlayCompact(appState) {
  return setOverlayCompact(appState, !isOverlayCompact(appState));
}

/** Re-apply capture exclusion while the overlay stays visible (Teams can drop affinity). */
const stealthTimers = new WeakMap();

function applyContentProtection(win, enable, intendedOpacity = null) {
  if (!win || win.isDestroyed()) return;
  try {
    // Layered-window nudge: some Win10/11 builds only honor affinity after opacity touches WS_EX_LAYERED.
    const target = clampOverlayOpacity(
      intendedOpacity == null ? win.getOpacity() : intendedOpacity
    );
    if (target >= 0.999) win.setOpacity(0.99);
    win.setContentProtection(!!enable);
    applyOverlayOpacity(win, target);
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
  const intendedOpacity = appState && win === appState.overlayWindow
    ? getOverlayOpacity(appState)
    : null;
  applyContentProtection(win, enable, intendedOpacity);
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
  // Keep the real Chromium version; only drop the Electron token so sites
  // (Cloudflare / ChatGPT) are less likely to treat the view as a bot.
  return String(ua || '')
    .replace(/\sElectron\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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

function notifyOverlay(appState, payload) {
  try {
    if (appState.overlayWindow && !appState.overlayWindow.isDestroyed()) {
      appState.overlayWindow.webContents.send('overlay-data', payload);
    }
  } catch {
    /* ignore */
  }
}

function layoutAgentView(appState, { loading = null, statusExtra = 0 } = {}) {
  const win = appState.overlayWindow;
  const view = appState.agentView;
  if (!win || win.isDestroyed() || !view) return;
  if (typeof loading === 'boolean') {
    appState.agentLoading = loading;
  }
  const isLoading = appState.agentLoading === true;
  const [cw, ch] = win.getContentSize();
  const top = OVERLAY_TOP_CHROME + (statusExtra || 0);
  if (isOverlayCompact(appState) || isLoading) {
    // Compact icon mode and loading cover both collapse the BrowserView.
    view.setBounds({ x: 0, y: top, width: Math.max(0, cw), height: 0 });
    return;
  }
  view.setBounds({
    x: 0,
    y: top,
    width: Math.max(0, cw),
    height: Math.max(0, ch - top)
  });
}

function attachAgentBrowserView(win, appState, onGuestReady) {
  const preload = path.join(__dirname, 'preload', 'chatgpt-preload.js');
  const ses = session.fromPartition(AGENT_PARTITION);
  const view = new BrowserView({
    webPreferences: {
      session: ses,
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  appState.agentView = view;
  win.setBrowserView(view);
  layoutAgentView(appState, { loading: true });

  const wc = view.webContents;
  appState.chatgptWebContents = wc;
  configureChatGPTWebContents(wc);

  wc.setWindowOpenHandler(({ url }) => {
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

  wc.on('will-navigate', (event, url) => {
    if (!isAllowedOverlayUrl(url)) {
      event.preventDefault();
      console.warn('[Dictate] blocked agent navigation:', url);
    }
  });

  wc.on('did-start-loading', () => {
    const agent = appState.getAgent?.() || { name: 'ChatGPT' };
    layoutAgentView(appState, { loading: true });
    notifyOverlay(appState, {
      agentLoading: true,
      status: `Loading ${agent.name}…`
    });
  });

  const markLoaded = () => {
    layoutAgentView(appState, { loading: false });
    notifyOverlay(appState, { agentLoading: false });
  };

  wc.on('dom-ready', markLoaded);
  wc.on('did-finish-load', markLoaded);
  wc.on('did-stop-loading', markLoaded);

  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    const agent = appState.getAgent?.() || { name: 'ChatGPT' };
    layoutAgentView(appState, { loading: false });
    notifyOverlay(appState, {
      agentLoading: false,
      error: `Could not load ${agent.name} (${errorDescription || errorCode}). Check network, then pick the agent again.`
    });
    console.warn('[Dictate] agent did-fail-load:', errorCode, errorDescription, validatedURL);
  });

  wc.on('destroyed', () => {
    if (appState.chatgptWebContents === wc) {
      appState.chatgptWebContents = null;
    }
  });

  win.on('resize', () => layoutAgentView(appState));

  const provider = appState.getAgent?.() || { url: 'https://chatgpt.com', name: 'ChatGPT' };
  const startUrl = provider.url || 'https://chatgpt.com';
  notifyOverlay(appState, {
    agentLoading: true,
    agent: provider.id ? { id: provider.id, name: provider.name, url: provider.url } : undefined,
    status: `Loading ${provider.name || 'ChatGPT'}…`
  });
  wc.loadURL(startUrl).catch((e) => {
    console.warn('[Dictate] initial agent load failed:', e?.message || e);
    notifyOverlay(appState, {
      agentLoading: false,
      error: `Could not load ${provider.name || 'ChatGPT'}: ${e?.message || e}`
    });
    layoutAgentView(appState, { loading: false });
  });

  if (typeof onGuestReady === 'function') onGuestReady(wc);
  return view;
}

function createOverlayWindow(appState, onChatGPTReady) {
  const { width } = screen.getPrimaryDisplay().workAreaSize;

  const win = new BrowserWindow({
    width: 720,
    height: 760,
    minWidth: OVERLAY_MIN_WIDTH,
    minHeight: OVERLAY_MIN_HEIGHT,
    x: width - 740,
    y: 24,
    frame: false,
    // Transparent so compact mode can show only the floating icon (no solid square).
    transparent: true,
    backgroundColor: '#00000000',
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

  appState.overlayWindow = win;
  appState.overlayCompact = false;
  appState.overlayRestoredBounds = null;
  attachAgentBrowserView(win, appState, onChatGPTReady);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay', 'index.html'));

  win.once('ready-to-show', () => {
    applyOverlayOpacity(win, getOverlayOpacity(appState));
    applyUndetectable(win, appState.isUndetectable(), appState);
    win.show();
    layoutAgentView(appState);
    notifyOverlay(appState, {
      compact: false,
      opacity: getOverlayOpacity(appState)
    });
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
    layoutAgentView(appState);
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
    try {
      if (appState.agentView) {
        win.removeBrowserView?.(appState.agentView);
      }
    } catch {
      /* ignore */
    }
    appState.agentView = null;
    appState.overlayWindow = null;
    appState.chatgptWebContents = null;
  });

  return win;
}

function createSettingsWindow(appState) {
  const win = new BrowserWindow({
    width: 520,
    height: 860,
    minWidth: 420,
    minHeight: 560,
    title: 'Dictate Settings',
    resizable: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload', 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'settings', 'index.html'));
  appState.settingsWindow = win;

  const protect = () => {
    if (!win.isDestroyed()) applyUndetectable(win, appState.isUndetectable(), appState);
  };
  win.once('ready-to-show', () => {
    protect();
    setTimeout(protect, 100);
    setTimeout(protect, 500);
  });
  win.on('show', protect);
  win.on('focus', protect);
  win.on('blur', () => {
    if (appState.isUndetectable() && isWin && !win.isDestroyed()) {
      try { win.setAlwaysOnTop(true, 'screen-saver', 1); } catch { /* ignore */ }
      protect();
    }
  });
  win.on('closed', () => {
    stopStealthKeepAlive(win);
    appState.settingsWindow = null;
  });
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
  applyUndetectable(win, appState.isUndetectable(), appState);
  setTimeout(() => {
    if (!win.isDestroyed()) applyUndetectable(win, appState.isUndetectable(), appState);
  }, 100);
  return true;
}

function notifyOverlayUndetectable(appState) {
  notifyOverlay(appState, { undetectable: appState.isUndetectable() });
}

function showOverlayWindow(appState) {
  const overlay = appState.overlayWindow;
  if (!overlay || overlay.isDestroyed()) return false;
  const enable = appState.isUndetectable();
  if (overlay.isVisible()) {
    try { overlay.moveTop(); } catch { /* ignore */ }
    applyUndetectable(overlay, enable, appState);
    layoutAgentView(appState);
    return true;
  }
  overlay.show();
  applyUndetectable(overlay, enable, appState);
  layoutAgentView(appState);
  setTimeout(() => {
    if (!overlay.isDestroyed()) applyUndetectable(overlay, enable, appState);
  }, 100);
  return true;
}

function refreshUndetectable(appState) {
  const enable = appState.isUndetectable();
  for (const win of [appState.overlayWindow, appState.settingsWindow]) {
    if (win && !win.isDestroyed()) applyUndetectable(win, enable, appState);
  }
  notifyOverlayUndetectable(appState);
}

async function loadAgentInOverlay(appState, provider) {
  const wc = appState.getChatGPTWebContents?.() || appState.chatgptWebContents;
  if (!wc || wc.isDestroyed()) {
    return { loaded: false, error: 'Agent view unavailable — restart Dictate Desktop' };
  }
  layoutAgentView(appState, { loading: true });
  notifyOverlay(appState, {
    agent: provider,
    agentLoading: true,
    status: `Loading ${provider.name}…`
  });
  try {
    try {
      wc.stop();
    } catch {
      /* ignore */
    }
    await Promise.race([
      wc.loadURL(provider.url),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Timed out loading agent page')), 60000);
      })
    ]);
    layoutAgentView(appState, { loading: false });
    notifyOverlay(appState, { agent: provider, agentLoading: false });
    return { loaded: true };
  } catch (e) {
    const loadError = e?.message || String(e);
    console.warn('[Dictate] agent load failed:', loadError);
    try {
      wc.stop();
    } catch {
      /* ignore */
    }
    layoutAgentView(appState, { loading: false });
    notifyOverlay(appState, {
      agent: provider,
      agentLoading: false,
      error: `Could not load ${provider.name}: ${loadError}`
    });
    return { loaded: false, error: loadError };
  }
}

module.exports = {
  createOverlayWindow,
  createSettingsWindow,
  showSettingsWindow,
  applyUndetectable,
  applyContentProtection,
  refreshUndetectable,
  showOverlayWindow,
  configureChatGPTWebContents,
  layoutAgentView,
  loadAgentInOverlay,
  notifyOverlay,
  getOverlayOpacity,
  setOverlayOpacity,
  isOverlayCompact,
  setOverlayCompact,
  toggleOverlayCompact,
  OVERLAY_TOP_CHROME,
  OVERLAY_OPACITY_MIN,
  OVERLAY_OPACITY_MAX
};
