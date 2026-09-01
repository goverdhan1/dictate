# Dictate

Dictate is a **ChatGPT dictation helper** plus a **meeting-caption bridge**. Live captions from Teams, Zoom, Webex, and Google Meet are stored on your machine and can be sent into the ChatGPT overlay without dropping older lines as new ones arrive.

There are two parts that work together:

| Piece | What it does |
|-------|----------------|
| **Browser extension** | ChatGPT auto-send, captions from meeting **tabs**, popup settings |
| **Dictate Desktop** | Capture-excluded ChatGPT overlay, captions from **desktop apps / Meet PWA**, local transcript files |

Use the desktop app for Teams / Zoom / Webex / Meet **apps**. Use the extension for meetings that run in the browser. You can run both at once; captions land in one local transcript.

---

## Contents

- [What you get](#what-you-get)
- [Dictate Desktop](#dictate-desktop)
- [Browser extension](#browser-extension)
- [Local transcript and Send](#local-transcript-and-send)
- [Popup settings](#popup-settings)
- [Privacy](#privacy)
- [Troubleshooting](#troubleshooting)
- [Docs for developers](#docs-for-developers)

---

## What you get

- **Auto-send** on ChatGPT after dictation ends.
- **Meeting captions** from Teams, Google Meet, Zoom, and Webex → ChatGPT.
- **Full-call transcript** stored locally (not only the last few hundred live lines).
- **Send** forwards *unsent saved captions*. Older lines stay queued as new ones arrive.
- **Undetectable overlay** (Windows exclude-from-capture; macOS window sharing off).

---

## Dictate Desktop

Run this while you are in **Teams**, **Zoom Workplace / Zoom**, **Webex**, or **Google Meet** (desktop app, installed PWA, or a Meet-titled window).

1. Start the app:

   ```bash
   cd dictate-desktop
   npm install
   npm start
   ```

2. Join the meeting in the desktop app (or Meet window).
3. Turn on **live captions**. On Windows you can also press **Win+Ctrl+L**.
4. Click **Send** on the overlay. ChatGPT gets saved unsent captions. If the batch is large, click Send again for the next chunk.
5. Click **Transcript** to copy the full call, or open **Settings** to export / **End call**.

Meet in a normal browser **tab** still uses the extension. Meet as a window or installed app is read by Dictate Desktop.

If Electron fails to install:

```bash
cd dictate-desktop
node scripts/ensure-electron.js
npm start
```

More detail: [`dictate-desktop/README.md`](dictate-desktop/README.md).

---

## Browser extension

Manifest V3. Chromium browsers share one pack; Firefox uses `manifest.firefox.json`.

Pack both variants:

```bash
node scripts/pack-extension.js
```

### Chromium (Chrome, Edge, Opera, Brave, Comet, Arc, Vivaldi)

1. Open the extensions page (`chrome://extensions`, `edge://extensions`, or `opera://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** and choose this repo folder, or `dist-extension/chromium` after packing.

### Firefox

1. Run `node scripts/pack-extension.js`.
2. Open `about:debugging#/runtime/this-firefox`.
3. **Load Temporary Add-on** → `dist-extension/firefox/manifest.json`.

Temporary add-ons disappear when Firefox quits until you load them again.

### Safari (macOS only)

```bash
xcrun safari-web-extension-converter dist-extension/chromium --project-location dist-extension/safari --app-name Dictate
```

Open the Xcode project, enable the unsigned extension in Safari settings, and run it. There is no Safari for Windows.

### Internet Explorer

Not supported.

After you change extension files: reload the extension, then refresh ChatGPT and meeting tabs. Restart Dictate Desktop if you changed the overlay.

---

## Local transcript and Send

Captions are written to a **transcript** (full history) and a small **live queue** (auto-forward / “new caption” hints).

| Action | What happens |
|--------|----------------|
| **Send** | Forwards captions that are saved and not yet sent to ChatGPT. Does not drop old lines when new ones appear. Large calls are split at ~20k characters; click Send again for the rest. |
| **Transcript** (overlay) | Copies the entire current call, including lines already sent. |
| **Copy / Export** (Settings or popup) | Same full log, without ending the call. |
| **End call / New transcript** | Archives a dated `.txt` (desktop) and starts a fresh log. Send will then only pick up new captions. |

Desktop files live under the Electron user-data folder, in `transcripts/`:

- Windows: `%APPDATA%\Dictate\transcripts`
- macOS: `~/Library/Application Support/Dictate/transcripts`

`current.json` is the active call. **End call** writes `YYYY-MM-DD-HHmm.txt`.

Without the desktop app, the extension keeps the same data in `chrome.storage.local` (`meetingTranscript`). If Dictate Desktop is running, the extension also posts captions to it so one file holds both desktop and browser lines.

---

## Popup settings

| Setting | Meaning |
|---------|---------|
| Enable ChatGPT auto-send | After dictation, send the ChatGPT composer. |
| Enable meeting→ChatGPT bridge | Capture meeting captions and allow Send / auto-forward. |
| Auto-enable live captions | Try to turn captions on in the meeting UI. |
| Auto-forward | Off, questions (`?`), or complete sentences. |
| Custom prefix | Optional text prepended to each ChatGPT payload. |
| Copy transcript / New transcript | Clipboard or start a new log (archives via desktop if it is running). |

---

## Privacy

- Captions stay **on this computer** (Electron user data and/or extension storage).
- The only local network call is `http://127.0.0.1:38473` between the extension and Dictate Desktop.
- ChatGPT sees only what you **Send** or what auto-forward sends. Copy/Export never uploads the file.

---

## Troubleshooting

| Symptom | What to try |
|---------|-------------|
| Overlay: ChatGPT input not found | Open a chat (not the login wall), wait for ChatGPT to finish loading, click Send again. |
| No unsent captions | Turn on live captions. Windows: **Win+Ctrl+L**. Confirm the meeting window is focused enough for captions to render. |
| Meet desktop not detected | Window title must contain **Meet**, **Google Meet**, or **meet.google.com**. Other Chrome windows are ignored on purpose. |
| Browser Send does nothing | Load the extension on the meeting tab, enable the bridge in the popup, reload the tab. |
| Overlay visible in screen share | Turn **Undetectable Mode** on (Settings or Dictate menu). macOS 15+ ScreenCaptureKit may still capture. |
| Extension out of date | Reload the extension; for a packed copy run `node scripts/pack-extension.js` again. |

---

## Docs for developers

| Doc | Contents |
|-----|----------|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Components, data flow, local bridge protocol |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | Layout, tests, packing, adding a meeting platform |
| [`dictate-desktop/README.md`](dictate-desktop/README.md) | Overlay, undetectable mode, installers |
| [`dictate-desktop/TESTING.md`](dictate-desktop/TESTING.md) | Smoke-test commands |
