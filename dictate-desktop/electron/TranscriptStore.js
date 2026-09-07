/**
 * Full-call caption log on disk (Electron userData/transcripts).
 * Separate from the ~300-line live send queue. Send reads unsent lines here.
 * See docs/ARCHITECTURE.md.
 */
const fs = require('fs');
const path = require('path');
const {
  captionKey,
  similarityKey,
  normalizeAuthor,
  normalizeCaptionText,
  isSpokenCaptionText,
  formatSendLine,
  formatLines,
  linesRelated,
  emptyTranscript,
  trimTranscriptLines,
  getUnsentLines,
  countUnsent,
  takeUnsentChunkFrom,
  markLinesSent,
  SEND_CHUNK_CHARS
} = require('./CaptionQueue');

function pad(n) {
  return String(n).padStart(2, '0');
}

function stamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

class TranscriptStore {
  constructor(options = {}) {
    this.dir = null;
    this.forcedDir = options.dir || null;
    this.currentPath = null;
    this.current = emptyTranscript();
    this.unsentCount = 0;
    this.writeTimer = null;
  }

  ensure() {
    if (this.dir) return;
    if (this.forcedDir) {
      this.dir = this.forcedDir;
    } else {
      const { app } = require('electron');
      this.dir = path.join(app.getPath('userData'), 'transcripts');
    }
    fs.mkdirSync(this.dir, { recursive: true });
    this.currentPath = path.join(this.dir, 'current.json');
    this.load();
  }

  recountUnsent() {
    this.unsentCount = countUnsent(this.current.lines);
  }

  load() {
    try {
      if (this.currentPath && fs.existsSync(this.currentPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.currentPath, 'utf8'));
        if (parsed && Array.isArray(parsed.lines)) {
          this.current = parsed;
          for (const line of this.current.lines) {
            if (line.sent == null) line.sent = false;
          }
          this.recountUnsent();
          return;
        }
      }
    } catch (e) {
      console.warn('[Dictate] transcript load failed:', e?.message || e);
    }
    this.current = emptyTranscript();
    this.unsentCount = 0;
  }

  scheduleSave() {
    clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => this.saveNow(), 400);
  }

  saveNow() {
    this.ensure();
    try {
      fs.writeFileSync(this.currentPath, JSON.stringify(this.current, null, 2), 'utf8');
    } catch (e) {
      console.warn('[Dictate] transcript save failed:', e?.message || e);
    }
  }

  append(line) {
    this.ensure();
    const author = normalizeAuthor(line?.author);
    const text = normalizeCaptionText(line?.text);
    if (!isSpokenCaptionText(text)) return null;

    const last = this.current.lines[this.current.lines.length - 1];
    if (last && last.author === author && last.text === text) return null;

    const key = captionKey(author, text);
    const sim = similarityKey(author, text);
    const platform = String(line?.platform || this.current.platform || '');
    if (platform) this.current.platform = platform;

    for (let i = this.current.lines.length - 1; i >= Math.max(0, this.current.lines.length - 8); i--) {
      const existing = this.current.lines[i];
      if (!linesRelated(existing, author, text)) continue;
      if (text.length > existing.text.length) {
        existing.text = text;
        existing.key = key;
        existing.sim = sim;
        existing.at = line?.at || Date.now();
        existing.platform = platform || existing.platform;
        existing.source = line?.source || existing.source;
        this.scheduleSave();
        return existing;
      }
      return null;
    }

    this.current.lines.push({
      at: line?.at || Date.now(),
      author,
      text,
      platform,
      source: line?.source || '',
      key,
      sim,
      sent: false
    });
    this.unsentCount += 1;
    const before = this.current.lines.length;
    trimTranscriptLines(this.current);
    if (this.current.lines.length !== before) this.recountUnsent();
    this.scheduleSave();
    return this.current.lines[this.current.lines.length - 1];
  }

  getCurrent() {
    this.ensure();
    return this.current;
  }

  getUnsent() {
    this.ensure();
    return getUnsentLines(this.current.lines);
  }

  hasUnsent() {
    this.ensure();
    return this.unsentCount > 0;
  }

  takeUnsentChunk(maxChars = SEND_CHUNK_CHARS) {
    this.ensure();
    return takeUnsentChunkFrom(this.current.lines, maxChars);
  }

  formatUnsent(lines) {
    return (lines || this.getUnsent())
      .map((c) => formatSendLine(c))
      .filter(Boolean)
      .join('\n');
  }

  markSent(entries) {
    this.ensure();
    const marked = markLinesSent(this.current.lines, entries);
    if (marked) {
      this.recountUnsent();
      this.scheduleSave();
    }
    return marked;
  }

  formatText() {
    this.ensure();
    return formatLines(this.current.lines);
  }

  endCall() {
    this.ensure();
    this.saveNow();
    const count = this.current.lines.length;
    const text = this.formatText();
    const started = this.current.startedAt ? new Date(this.current.startedAt) : new Date();
    const fileName = `${stamp(started)}.txt`;
    const outPath = path.join(this.dir, fileName);
    const header = `Dictate transcript\nStarted: ${started.toLocaleString()}\nPlatform: ${this.current.platform || 'meeting'}\nLines: ${count}\n\n`;
    fs.writeFileSync(outPath, header + (text || '(no captions)') + '\n', 'utf8');
    this.current = emptyTranscript();
    this.unsentCount = 0;
    this.saveNow();
    return { success: true, path: outPath, fileName, count };
  }

  exportTo(filePath) {
    this.ensure();
    this.saveNow();
    const text = this.formatText();
    fs.writeFileSync(filePath, text ? `${text}\n` : '(no captions)\n', 'utf8');
    return { success: true, path: filePath };
  }
}

module.exports = {
  TranscriptStore,
  formatLines,
  formatSendLine,
  getUnsentLines,
  takeUnsentChunkFrom,
  markLinesSent,
  SEND_CHUNK_CHARS,
  captionKey,
  similarityKey
};
