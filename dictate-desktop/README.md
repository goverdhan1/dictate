# Dictate Desktop

Electron shell: a **capture-excluded ChatGPT overlay** plus on-screen caption reading for desktop meeting apps.

For the product overview and browser extension, see the [root README](../README.md). For internals, see [Architecture](../docs/ARCHITECTURE.md).

## Meeting sources

| Source | How captions are read |
|--------|------------------------|
| **Teams / Zoom / Webex desktop apps** | On-screen live captions (Windows UI Automation; macOS Accessibility). Turn captions on in the app, or press **Win+Ctrl+L** on Windows. |
| **Google Meet app / PWA / window** | Same watcher. The window title must contain Meet or `meet.google.com` so other Chrome/Edge windows are ignored. |
| **Browser meetings** | Dictate extension. While this app is running, the extension posts captions into the same local transcript. |

## Overlay

The overlay is ChatGPT in a `<webview>`. Header actions:

| Control | Behavior |
|---------|----------|
| **Send** | Inject saved **unsent** captions into the ChatGPT composer. Older lines stay in the transcript until they are sent. Large batches: click Send again. |
| **Transcript** | Copy the full current call (sent and unsent) to the clipboard. |
| **×** | Hide the overlay (tray **Show Overlay** brings it back). |
| Resize handle | Drag the bottom-right corner. |

Replies stay in the ChatGPT UI. Status messages (sent count, errors) appear in the thin banner under the header.

## Settings

Tray or **Dictate → Settings**:

- **Undetectable Mode** — exclude the overlay from screen capture when the OS allows it.
- **Enable meeting→ChatGPT bridge** — stop forwarding if you only want the overlay.
- **Meeting transcript** — live preview, **Copy**, **Export…**, **End call**.

**End call** writes `transcripts/YYYY-MM-DD-HHmm.txt` and starts a new `current.json`. It does not quit the meeting app.

### Transcript files

| OS | Folder |
|----|--------|
| Windows | `%APPDATA%\Dictate\transcripts` |
| macOS | `~/Library/Application Support/Dictate/transcripts` |

## Quick start

```bash
cd dictate-desktop
npm install
npm start
```

Join a supported meeting, enable live captions, click **Send**.

If Electron fails to install:

```bash
node scripts/ensure-electron.js
npm start
```

On macOS, grant **Accessibility** to Dictate (or to Terminal / Electron when running from source) so the caption watcher can read meeting windows.

## Tray / menu

- **Show Overlay** — ChatGPT view, Send, Transcript
- **Settings** — undetectable, bridge, transcript
- **Toggle Undetectable Mode** (app menu)

## Undetectable Mode

- **Windows 10 19041+:** `setContentProtection(true)` → DWM `WDA_EXCLUDEFROMCAPTURE`
- **macOS:** `NSWindowSharingNone` (ScreenCaptureKit on macOS 15+ may still capture the overlay)

## Build installers

```bash
npm run dist:win   # NSIS installer in dist/
npm run dist:mac   # DMG (macOS + signing for distribution)
```
