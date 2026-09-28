const { clipboard, desktopCapturer, screen } = require('electron');

const MAX_EDGE = 1920;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickSource(sources, display) {
  const usable = (sources || []).filter((source) => source?.thumbnail && !source.thumbnail.isEmpty());
  if (!usable.length) return null;
  const id = String(display?.id ?? '');
  const matched = usable.find((source) => source.display_id && String(source.display_id) === id);
  if (matched) return matched;
  if (usable.length === 1) return usable[0];
  const targetW = Math.round((display?.size?.width || 0) * (display?.scaleFactor || 1));
  usable.sort((a, b) => {
    const da = Math.abs((a.thumbnail.getSize().width || 0) - targetW);
    const db = Math.abs((b.thumbnail.getSize().width || 0) - targetW);
    return da - db;
  });
  return usable[0];
}

function fitScreenshot(image) {
  if (!image || image.isEmpty()) return null;
  const { width, height } = image.getSize();
  if (!width || !height) return null;
  const edge = Math.max(width, height);
  if (edge <= MAX_EDGE) return image;
  const scale = MAX_EDGE / edge;
  return image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: 'good'
  });
}

function toClipboardPayload(image) {
  const fitted = fitScreenshot(image);
  if (!fitted) return null;
  const jpeg = fitted.toJPEG(72);
  if (jpeg?.length) {
    return { image: fitted, base64: jpeg.toString('base64'), mime: 'image/jpeg' };
  }
  const png = fitted.toPNG();
  if (!png?.length) return null;
  return { image: fitted, base64: png.toString('base64'), mime: 'image/png' };
}

async function captureScreenImage() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor) || screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const width = Math.max(1, Math.round(display.size.width * scale));
  const height = Math.max(1, Math.round(display.size.height * scale));
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
    fetchWindowIcons: false
  });
  const source = pickSource(sources, display);
  if (!source) return null;
  return source.thumbnail;
}

/**
 * Hide the overlay so the capture shows the desktop behind it, then restore it.
 */
async function captureScreenForSend(appState) {
  const win = appState?.overlayWindow;
  const canHide = !!(win && !win.isDestroyed() && win.isVisible());
  if (canHide) {
    win.hide();
    await delay(220);
  }
  try {
    const image = await captureScreenImage();
    return toClipboardPayload(image);
  } finally {
    if (canHide && win && !win.isDestroyed()) {
      win.show();
      await delay(120);
    }
  }
}

function readClipboardSnapshot() {
  let image = null;
  try {
    const current = clipboard.readImage();
    if (current && !current.isEmpty()) image = current;
  } catch {
    image = null;
  }
  let text = '';
  let html = '';
  try { text = clipboard.readText() || ''; } catch { text = ''; }
  try { html = clipboard.readHTML() || ''; } catch { html = ''; }
  return { image, text, html };
}

function restoreClipboard(snap) {
  if (!snap) return;
  try {
    if (snap.image) {
      clipboard.writeImage(snap.image);
      return;
    }
    if (snap.html || snap.text) {
      clipboard.write({ text: snap.text || '', html: snap.html || '' });
      return;
    }
    clipboard.clear();
  } catch (e) {
    console.warn('[Dictate] clipboard restore failed:', e?.message || e);
  }
}

module.exports = {
  captureScreenForSend,
  readClipboardSnapshot,
  restoreClipboard
};
