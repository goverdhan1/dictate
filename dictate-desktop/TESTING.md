# See dictate-desktop/README.md for capture test matrix.

## Automated smoke (no Electron UI)

From repo root:

```bash
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
node test/integration.test.js
```

## Manual (requires meeting account)

1. `cd dictate-desktop && npm install && npm start`
2. Join a meeting in Chrome (Teams, Meet, Zoom web, or Webex), enable captions, click **Send** on overlay
3. Start screen share → **Window** (Dictate main window)
4. Confirm overlay text is **not** visible to remote participants (Windows + Undetectable on)
