# See dictate-desktop/README.md for capture test matrix.

## Automated smoke (no Electron UI)

From repo root:

```bash
node --check dictate-desktop/electron/main.js
node --check dictate-desktop/electron/WindowHelper.js
node --check dictate-desktop/electron/BridgeRouter.js
node --check dictate-desktop/electron/injectScripts.js
```

## Manual (requires Windows/macOS + Teams account)

1. `cd dictate-desktop && npm install && npm start`
2. Join Teams meeting, enable captions, click **Send**
3. Start Teams screen share → **Window** (Dictate main window)
4. Confirm overlay text is **not** visible to remote participants (Windows + Undetectable on)
