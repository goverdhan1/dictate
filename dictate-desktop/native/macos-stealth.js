/**
 * macOS stealth helpers for capture-excluded overlay windows.
 * Electron setContentProtection(true) maps to NSWindowSharingNone.
 * This module re-applies sharing type when available via Electron internals.
 *
 * Limit: macOS 15+ ScreenCaptureKit may ignore per-window sharing type.
 */

function applyMacStealth(win) {
  if (process.platform !== 'darwin' || !win || win.isDestroyed()) return;

  try {
    win.setContentProtection(true);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Non-activating: do not steal focus from Teams on blur (macOS pattern).
    win.setAlwaysOnTop(true, 'floating', 1);
  } catch (e) {
    console.warn('[Dictate] macOS stealth apply failed:', e?.message || e);
  }
}

module.exports = { applyMacStealth };
