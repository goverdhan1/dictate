# Dictate Desktop

Electron shell for Dictate with **capture-excluded ChatGPT overlay** during virtual meetings (Teams, Google Meet, Zoom web, Webex).

## Architecture

| Component | Role |
|-----------|------|
| **Meeting app (desktop or web)** | Your meeting — use desktop app or Chrome tab |
| **Chrome + Dictate extension** | Meeting web tab for live captions |
| **Dictate Desktop** | Hidden ChatGPT window + capture-protected overlay |
| **Bridge server** | Extension forwards to desktop at `http://127.0.0.1:38473` |

## Quick start

1. Install/reload the **Chrome extension** (parent folder).
2. Open your meeting in **Chrome** (Teams, Meet, Zoom web, or Webex) with live captions.
3. Run the desktop app:

```bash
cd dictate-desktop
npm install
npm start
```

4. Join the meeting in Chrome (or keep desktop app focused while Chrome tab captures captions).
5. Click **Send** on the Dictate Desktop overlay — answers appear in the protected overlay.

If Electron fails to install:

```bash
node scripts/ensure-electron.js
npm start
```

## Supported platforms (Chrome web client)

| Platform | Chrome URL |
|----------|------------|
| Microsoft Teams | `teams.microsoft.com` |
| Google Meet | `meet.google.com` |
| Zoom | `zoom.us/wc` web client |
| Webex | `*.webex.com` |

## Tray / menu

- **Settings** — Undetectable mode, bridge options

## Undetectable Mode

Toggle via **Dictate → Toggle Undetectable Mode** or Settings window.

- **Windows 10 19041+**: `setContentProtection(true)` → DWM `WDA_EXCLUDEFROMCAPTURE`
- **macOS**: `NSWindowSharingNone` via Electron (ScreenCaptureKit on macOS 15+ may still capture)

## Build installers

```bash
npm run dist:win   # NSIS installer in dist/
npm run dist:mac   # DMG (requires macOS + signing for distribution)
```

## Manual capture test matrix

| Test | Expected |
|------|----------|
| Share **window** (Windows) | Overlay visible locally, absent in share |
| Share **entire screen** (Windows) | Overlay absent in share |
| Send from overlay | Meeting tab stays focused; overlay streams answer |
| Undetectable off | Overlay may appear in share |

## Chrome extension

Reload the extension after updating. When Dictate Desktop is running, the extension routes ChatGPT traffic to the desktop app and shows answers in the protected overlay instead of the in-page DOM overlay.
