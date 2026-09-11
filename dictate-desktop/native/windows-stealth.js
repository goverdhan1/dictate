/**
 * Force WDA_EXCLUDEFROMCAPTURE on the overlay HWND.
 * Electron setContentProtection can be cleared by opacity/show cycles; Teams
 * screen share then captures the window. Re-applying affinity via user32 fixes it.
 */
const { spawn } = require('child_process');
const path = require('path');

const WDA_NONE = 0;
const WDA_EXCLUDEFROMCAPTURE = 0x11;
const SCRIPT = path.join(__dirname, 'windows-stealth.ps1');

function hwndString(win) {
  const buf = win.getNativeWindowHandle();
  if (!buf || !buf.length) return '';
  if (buf.length >= 8) return buf.readBigUInt64LE(0).toString();
  return String(buf.readUInt32LE(0));
}

function applyWindowsExcludeFromCapture(win, enable) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return false;
  let hwnd;
  try {
    hwnd = hwndString(win);
  } catch (e) {
    console.warn('[Dictate] HWND read failed:', e?.message || e);
    return false;
  }
  if (!hwnd || hwnd === '0') return false;

  const affinity = enable ? WDA_EXCLUDEFROMCAPTURE : WDA_NONE;
  try {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-File', SCRIPT,
        '-Hwnd', hwnd,
        '-Affinity', String(affinity)
      ],
      {
        windowsHide: true,
        stdio: 'ignore'
      }
    );
    child.unref?.();
    return true;
  } catch (e) {
    console.warn('[Dictate] SetWindowDisplayAffinity spawn failed:', e?.message || e);
    return false;
  }
}

module.exports = {
  applyWindowsExcludeFromCapture,
  WDA_EXCLUDEFROMCAPTURE,
  WDA_NONE
};
