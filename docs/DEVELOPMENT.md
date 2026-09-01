# Development

## Repository layout

```
caption-utils.js          Shared caption/transcript helpers (extension + Electron)
meeting-bridge-core.js    Meeting bridge runtime
teams-bridge.js           Teams DOM adapter
meet-bridge.js            Google Meet tab adapter
zoom-bridge.js
webex-bridge.js
content-script.js         ChatGPT page (dictation + composer)
background.js             Service worker / Firefox background
popup.html / popup.js
manifest.json             Chromium MV3
manifest.firefox.json
scripts/pack-extension.js Builds dist-extension/chromium and dist-extension/firefox
test/                     Node smoke tests (no browser required)
dictate-desktop/          Electron overlay + desktop caption watcher
docs/                     Architecture and this file
```

`caption-utils.js` is a UMD bundle: `require()` in Node, `globalThis.DictateCaptionUtils` in content scripts. Meeting content scripts must list it **before** `meeting-bridge-core.js`.

## Prerequisites

- Node.js 18+
- For the overlay: from `dictate-desktop`, `npm install` (pulls Electron)
- Windows caption scrape: PowerShell + UI Automation (built in)
- macOS caption scrape: Accessibility permission for Dictate / Terminal / Electron when running from source

## Extension

```bash
node scripts/pack-extension.js
```

Load unpacked:

- Chromium: `dist-extension/chromium`
- Firefox: `dist-extension/firefox/manifest.json` via `about:debugging`

For day-to-day Chromium work you can also load the **repo root** unpacked (`manifest.json`). After core/adapter edits, reload the extension and refresh meeting tabs.

## Desktop app

```bash
cd dictate-desktop
npm install
npm start
```

Installers:

```bash
npm run dist:win
npm run dist:mac
```

Packaged builds copy `caption-utils.js` into extra resources (`extension/caption-utils.js`). Dev `npm start` resolves it from the repo root.

## Tests

From the **repo root**:

```bash
node --check caption-utils.js
node --check meeting-bridge-core.js
node --check dictate-desktop/electron/main.js
node test/bridge-logic.test.js
node test/caption-queue.test.js
node test/transcript-store.test.js
node test/integration.test.js
```

Full command list: [`dictate-desktop/TESTING.md`](../dictate-desktop/TESTING.md).

Manual checks (need a real meeting):

1. `cd dictate-desktop && npm start`
2. Join Teams / Zoom / Webex / Meet (app, PWA, or browser tab), enable captions
3. Overlay **Send** — ChatGPT should get saved unsent captions; a second Send should only send newer lines
4. Overlay **Transcript** copies the full call
5. Settings **End call** writes `transcripts/YYYY-MM-DD-HHmm.txt`
6. With Undetectable on, share the overlay window and confirm remote participants do not see it (Windows)

## Adding a meeting platform

1. Host permissions + `content_scripts` in `manifest.json` and `manifest.firefox.json` (include `caption-utils.js`, then `meeting-bridge-core.js`, then your adapter).
2. Register in `background.js` `MEETING_PLATFORMS` (`bridgeFiles` order same as above).
3. Implement `*-bridge.js` with `createPlatformBridge({ ... })` — see the comment in `meeting-bridge-core.js`.
4. Add the file to `scripts/pack-extension.js` `FILES` and, if needed, `dictate-desktop/package.json` extraResources.
5. Manual Send test in that product.

Do not put Node-only APIs in `caption-utils.js` (no `fs`, `electron`, or DOM).
