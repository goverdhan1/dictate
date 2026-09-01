# Testing

Automated and manual checks for Dictate Desktop and the extension. Developer workflow: [`docs/DEVELOPMENT.md`](../docs/DEVELOPMENT.md). Overlay and caption sources: [`README.md`](README.md).

## Automated smoke (no Electron UI)

From **repo root**:

```bash
node --check caption-utils.js
node --check dictate-desktop/electron/main.js
node --check dictate-desktop/electron/WindowHelper.js
node --check dictate-desktop/electron/BridgeRouter.js
node --check dictate-desktop/electron/injectScripts.js
node --check meeting-bridge-core.js
node --check teams-bridge.js
node --check meet-bridge.js
node --check zoom-bridge.js
node --check webex-bridge.js
node test/bridge-logic.test.js
node test/caption-queue.test.js
node test/transcript-store.test.js
node test/integration.test.js
```

## Manual (requires a meeting account)

1. `cd dictate-desktop && npm install && npm start`
2. Join a meeting (Teams / Zoom / Webex / Meet desktop, Meet PWA, or browser tab), enable captions, click **Send** on the overlay
3. Confirm **Transcript** copies the full call; Settings **End call** writes a `.txt`
4. Click **Send** again after more talk — only new unsent lines should go to ChatGPT
5. Start screen share → **Window** (Dictate overlay)
6. Confirm the overlay is **not** visible to remote participants (Windows + Undetectable on)
