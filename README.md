# ChatGPT Auto-Dictate & Auto-Send (Chrome Extension)

Automatically clicks **Send** after speech-to-text/dictation populates the input on chatgpt.com, and restarts dictation for a continuous conversational flow.

## Features

- **Auto-Send**: Automatically sends messages after dictation ends with punctuation or significant input growth.
- **Continuous Dictate Mode**: Start / Submit / Stop buttons injected into the ChatGPT page. Submit sends the current dictation without stopping the mic cycle.
- **Popup Controls**: Enable/disable auto-send and open ChatGPT settings.

## Dictate Desktop (Electron)

For capture-excluded ChatGPT overlay during Teams meetings, see [`dictate-desktop/README.md`](dictate-desktop/README.md).

```bash
cd dictate-desktop && npm install && npm start
```


1. Open `chrome://extensions`
2. Click **Reload** on ChatGPT Auto-Dictate
3. Refresh the ChatGPT tab
4. Click **Start Dictate** (top-right). Status should show **Listening…** when the mic is active.
