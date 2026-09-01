/**
 * Reads on-screen captions from Teams / Zoom / Webex / Meet desktop windows.
 * Windows: PowerShell UI Automation. macOS: System Events / Accessibility.
 * Appends every unique line to TranscriptStore; CaptionQueue is only for auto-forward.
 */
const { spawn } = require('child_process');
const path = require('path');
const { CaptionQueue, shouldAutoForward, normalizeCaptionText } = require('./CaptionQueue');

const POLL_MS = 900;
const STATUS_THROTTLE_MS = 4000;

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}

function nativeScriptPath(name) {
  const packed = path.join(process.resourcesPath || '', 'native', name);
  const local = path.join(__dirname, '..', 'native', name);
  const fs = require('fs');
  if (fs.existsSync(local)) return local;
  if (packed && fs.existsSync(packed)) return packed;
  return local;
}

class DesktopCaptionWatcher {
  constructor({ appState, onStatus, onAutoForward, onTranscript, transcriptStore } = {}) {
    this.appState = appState;
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this.onAutoForward = typeof onAutoForward === 'function' ? onAutoForward : async () => {};
    this.onTranscript = typeof onTranscript === 'function' ? onTranscript : () => {};
    this.transcriptStore = transcriptStore || null;
    this.queue = new CaptionQueue();
    this.child = null;
    this.buffer = '';
    this.running = false;
    this.lastStatus = '';
    this.lastStatusAt = 0;
    this.detected = [];
    this.activePlatform = '';
    this.lastCaptionAt = 0;
    this.lastCaptionFp = '';
  }

  start() {
    if (this.running) return;
    this.running = true;
    if (process.platform === 'win32') this.startWindows();
    else if (process.platform === 'darwin') this.startMac();
    else this.emitStatus('Desktop meeting captions are supported on Windows and macOS');
  }

  stop() {
    this.running = false;
    if (this.child) {
      try { this.child.kill(); } catch { /* ignore */ }
      this.child = null;
    }
  }

  isMeetingActive() {
    return this.detected.some((p) => p === 'teams' || p === 'zoom' || p === 'webex' || p === 'meet' || p === 'livecaptions')
      || (Date.now() - this.lastCaptionAt < 15000);
  }

  hasUnsent() {
    return this.queue.getUnsent().length > 0;
  }

  getUnsent() {
    return this.queue.getUnsent();
  }

  async flushToChatGPT(bridge) {
    const unsent = this.queue.getUnsent();
    if (!unsent.length) return null;

    const settings = this.appState?.getAll?.() || {};
    const prefix = settings.forwardPrefix || '';
    const batch = this.queue.formatBatch(unsent);
    const payload = prefix ? prefix + batch : batch;
    const result = await bridge.forwardToChatGPT(payload);
    if (result?.success) this.queue.markSent(unsent);
    return {
      sent: !!result?.success,
      success: !!result?.success,
      error: result?.error,
      status: result?.success ? 'Sent desktop captions to ChatGPT' : result?.error,
      source: this.activePlatform || 'desktop'
    };
  }

  emitStatus(message, force = false) {
    const text = String(message || '').trim();
    if (!text) return;
    const now = Date.now();
    if (!force && text === this.lastStatus && now - this.lastStatusAt < STATUS_THROTTLE_MS) return;
    this.lastStatus = text;
    this.lastStatusAt = now;
    this.onStatus({ status: text, platform: this.activePlatform, detected: this.detected });
  }

  ingest(payload) {
    const detected = asArray(payload?.detected).map((p) => String(p || '').toLowerCase()).filter(Boolean);
    if (detected.length) this.detected = detected;

    this.transcriptStore?.ensure?.();
    const platform = String(payload?.platform || '').toLowerCase();
    const captions = asArray(payload?.captions);
    let fp = `${platform}|${this.detected.join(',')}|${this.transcriptStore ? this.transcriptStore.unsentCount : ''}|`;
    for (const item of captions) {
      fp += `${item?.author || ''}:${item?.text || item || ''}\n`;
    }
    if (fp === this.lastCaptionFp) {
      if (captions.length) this.lastCaptionAt = Date.now();
      return;
    }
    this.lastCaptionFp = fp;

    let added = 0;
    const newly = [];
    for (const item of captions) {
      const author = item?.author || '';
      const text = item?.text || item || '';
      this.onTranscript({
        at: Date.now(),
        author,
        text,
        platform,
        source: 'desktop'
      });
      if (normalizeCaptionText(text).length >= 2) {
        this.lastCaptionAt = Date.now();
        this.activePlatform = platform || this.activePlatform;
      }
      const entry = this.queue.remember({
        author,
        text,
        platform,
        source: 'desktop'
      });
      if (entry) {
        added += 1;
        newly.push(entry);
        this.lastCaptionAt = Date.now();
        this.activePlatform = platform || this.activePlatform;
      }
    }

    if (this.detected.length) {
      const label = this.detected
        .filter((p) => p !== 'livecaptions')
        .map((p) => (p === 'teams' ? 'Teams' : p === 'zoom' ? 'Zoom' : p === 'webex' ? 'Webex' : p === 'meet' ? 'Meet' : p))
        .join(', ') || (this.detected.includes('livecaptions') ? 'Windows Live Captions' : 'desktop');
      const pending = this.transcriptStore
        ? this.transcriptStore.unsentCount
        : this.queue.getUnsent().length;
      if (pending) {
        this.emitStatus(`${label} desktop · ${pending} new caption${pending === 1 ? '' : 's'}`);
      } else {
        this.emitStatus(`${label} desktop · turn on live captions (or Win+Ctrl+L)`);
      }
    }

    if (!added) return;

    const settings = this.appState?.getAll?.() || {};
    if (settings.bridgeEnabled === false) return;
    for (const entry of newly) {
      if (!shouldAutoForward(entry.text, settings)) continue;
      const prefix = settings.forwardPrefix || '';
      const line = entry.author ? `${entry.author}: ${entry.text}` : entry.text;
      this.onAutoForward(prefix ? prefix + line : line).then((result) => {
        if (result?.success) {
          this.queue.markSent([entry]);
          this.transcriptStore?.markSent([entry]);
        }
      }).catch(() => {});
    }
  }

  handleLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed.startsWith('{')) return;
    try {
      this.ingest(JSON.parse(trimmed));
    } catch (e) {
      console.warn('[Dictate] desktop caption JSON failed:', e?.message || e);
    }
  }

  attachStdout(stream) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      this.buffer += chunk;
      const parts = this.buffer.split(/\r?\n/);
      this.buffer = parts.pop() || '';
      for (const line of parts) this.handleLine(line);
    });
  }

  startWindows() {
    const script = nativeScriptPath('windows-captions.ps1');
    this.child = spawn('powershell.exe', [
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy', 'Bypass',
      '-File', script
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.attachStdout(this.child.stdout);
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (text) console.warn('[Dictate] caption watcher:', text.slice(0, 300));
    });
    this.child.on('exit', (code) => {
      this.child = null;
      if (!this.running) return;
      console.warn('[Dictate] caption watcher exited', code);
      setTimeout(() => {
        if (this.running && !this.child) this.startWindows();
      }, 2500);
    });
    this.emitStatus('Watching Teams / Zoom / Webex / Meet desktop captions', true);
  }

  startMac() {
    const osa = `
on run
  set noise to "mute unmute chat participants share record leave more view settings captions transcript"
  set names to {"Microsoft Teams", "Teams", "zoom.us", "Zoom", "Webex", "Cisco Webex Meetings", "Webex Meetings"}
  set browsers to {"Google Chrome", "Microsoft Edge", "Chrome", "Arc", "Brave Browser", "Opera", "Comet", "Google Meet"}
  set detected to {}
  set linesOut to {}
  tell application "System Events"
    repeat with procName in names
      if exists process procName then
        set end of detected to procName as string
        try
          tell process procName
            set winCount to count of windows
            repeat with i from 1 to winCount
              try
                set texts to value of static texts of window i
                repeat with t in texts
                  set s to t as string
                  if (length of s) > 7 and noise does not contain s then
                    set end of linesOut to s
                  end if
                end repeat
              end try
            end repeat
          end tell
        end try
      end if
    end repeat
    repeat with procName in browsers
      if exists process procName then
        try
          tell process procName
            set winCount to count of windows
            repeat with i from 1 to winCount
              try
                set winName to name of window i as string
                if winName contains "Meet" or winName contains "meet.google.com" then
                  set end of detected to "Meet"
                  set texts to value of static texts of window i
                  repeat with t in texts
                    set s to t as string
                    if (length of s) > 7 and noise does not contain s then
                      set end of linesOut to s
                    end if
                  end repeat
                end if
              end try
            end repeat
          end tell
        end try
      end if
    end repeat
  end tell
  set AppleScript's text item delimiters to linefeed
  return (detected as string) & "|||" & (linesOut as string)
end run
`;
    const tick = () => {
      if (!this.running) return;
      const child = spawn('osascript', ['-e', osa], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.on('close', () => {
        const [detectedRaw, textRaw] = String(out || '').split('|||');
        const detectedNames = String(detectedRaw || '').split(/\s+/).filter(Boolean);
        const detected = [];
        for (const name of detectedNames) {
          const n = name.toLowerCase();
          if (n.includes('team')) detected.push('teams');
          else if (n.includes('zoom')) detected.push('zoom');
          else if (n.includes('webex')) detected.push('webex');
          else if (n.includes('meet')) detected.push('meet');
        }
        const captions = String(textRaw || '')
          .split(/\n+/)
          .map((t) => ({ author: '', text: normalizeCaptionText(t) }))
          .filter((c) => c.text.length >= 8);
        this.ingest({
          platform: detected[0] || '',
          detected: [...new Set(detected)],
          captions
        });
        if (this.running) setTimeout(tick, POLL_MS + 400);
      });
    };
    tick();
    this.emitStatus('Watching Teams / Zoom / Webex / Meet desktop captions', true);
  }
}

module.exports = { DesktopCaptionWatcher };
