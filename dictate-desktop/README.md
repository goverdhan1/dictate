# Dictate Desktop

Electron shell for Dictate with **capture-excluded ChatGPT overlay** during Teams meetings.

## Architecture

| Component | Role |
|-----------|------|
| **Microsoft Teams desktop app** | Your meeting (focused on launch — not duplicated in Electron) |
| **Chrome + Dictate extension** | Teams web tab for live captions + **Send** on meeting bar |
| **Dictate Desktop** | Hidden ChatGPT window + capture-protected overlay |
| **Bridge server** | Extension forwards to desktop at `http://127.0.0.1:38473` |

## Quick start

1. Install/reload the **Chrome extension** (parent folder).
2. Open **Teams in Chrome** (`teams.microsoft.com`) for captions and Send.
3. Run the desktop app:

```bash
cd dictate-desktop
npm install
npm start
```

Dictate **focuses your existing Microsoft Teams desktop app** — it does not open a second Teams window in Electron.

4. Join the meeting in Teams desktop (or Chrome).
5. Click **Send** on the Chrome Teams meeting bar — answers appear in the protected desktop overlay.

If Electron fails to install:

```bash
node scripts/ensure-electron.js
npm start
```

## Tray / menu

- **Focus Teams** — brings Microsoft Teams desktop to front
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
| Teams share **window** (Windows) | Overlay visible locally, absent in share |
| Teams share **entire screen** (Windows) | Overlay absent in share |
| Send from meeting bar | Teams desktop stays focused; overlay streams answer |
| Undetectable off | Overlay may appear in share |

## Chrome extension

Reload the extension after updating. When Dictate Desktop is running, the extension routes ChatGPT traffic to the desktop app and shows answers in the protected overlay instead of the in-page DOM overlay.
