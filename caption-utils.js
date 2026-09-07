/**
 * Shared caption/transcript helpers for Dictate Desktop and the browser extension.
 * No Node or DOM APIs — safe as a content script and as require().
 *
 * Content scripts: load this file before meeting-bridge-core.js
 *   (sets globalThis.DictateCaptionUtils).
 * Electron: require via dictate-desktop/electron/CaptionQueue.js.
 *
 * Exports: normalizeCaptionText, captionKey, similarityKey, shouldAutoForward,
 * formatSendLine, formatLines, linesRelated, emptyTranscript, mergeTranscriptLine,
 * getUnsentLines, takeUnsentChunkFrom, markLinesSent, CaptionQueue,
 * SEND_CHUNK_CHARS (20000).
 *
 * See docs/ARCHITECTURE.md.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.DictateCaptionUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  const SEND_CHUNK_CHARS = 20000;
  const TRANSCRIPT_MAX_LINES = 20000;
  const TRANSCRIPT_KEEP_LINES = 18000;
  const LIVE_QUEUE_MAX = 400;
  const LIVE_QUEUE_KEEP = 300;

  function normalizeCaptionText(text) {
    return String(text || '')
      .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Zoom / Teams / Meet system toasts — not spoken captions. */
  const MEETING_ACTIVITY_NOISE_RE = new RegExp(
    [
      '^you are (un)?muted( now)?\\.?$',
      '^you are (the )?host now\\.?$',
      '^you are viewing .+\'s screen',
      '.+\\bis the host now\\.?$',
      '.+\\bhas (joined|left|entered|exited)( the meeting)?\\.?$',
      '.+\\bstarted screen share',
      '.+\\bstopped screen share',
      '^this meeting is being (recorded|transcribed)\\.?$',
      '^recording (has )?(started|stopped|paused|resumed)\\.?$',
      '^live transcript(ion)? (has )?(started|stopped)\\.?$',
      '^captions? are (on|off)\\b',
      '^captions? (enabled|disabled|started|stopped)\\b',
      '^(show|hide)( captions?| live transcript)?\\.?$',
      '^alert\\.?$',
      '^low network bandwidth\\b',
      '^unstable (network|connection)\\b',
      '^video now (started|stopped)\\.?$',
      '^audio (connected|disconnected)\\.?$',
      '^waiting for the host',
      '^host has (joined|left|ended)',
      '^the host (has )?(ended|removed)',
      '^please wait(,| for)',
      '^connecting(\\.{0,3}|…)?$',
      '^reconnecting(\\.{0,3}|…)?$',
      '^(mute|unmute|start video|stop video|participants|chat|share|record|leave|end|more|view|settings|reactions|apps|security|invite|copy|search|send|reply)$'
    ].join('|'),
    'i'
  );

  function isMeetingActivityNoise(text) {
    const t = normalizeCaptionText(text);
    if (!t) return true;
    if (MEETING_ACTIVITY_NOISE_RE.test(t)) return true;
    // Multi-clause Zoom toast blobs: "You are unmuted … Captions are on, alert Hide"
    if (/(?:^|[.!?]\s+)you are (un)?muted\b/i.test(t)
      && /\b(host now|left the meeting|captions? are|video now|being transcribed|low network)\b/i.test(t)) {
      return true;
    }
    return false;
  }

  /** True only for likely spoken caption lines (voices), not meeting chrome. */
  function isSpokenCaptionText(text) {
    const t = normalizeCaptionText(text);
    if (t.length < 2) return false;
    if (isMeetingActivityNoise(t)) return false;
    return true;
  }

  function normalizeAuthor(author) {
    return normalizeCaptionText(author);
  }

  function bareText(text) {
    return normalizeCaptionText(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function captionKey(author, text) {
    return `${normalizeAuthor(author)}::${normalizeCaptionText(text)}`.toLowerCase();
  }

  function similarityKey(author, text) {
    return `${normalizeAuthor(author).toLowerCase()}::${bareText(text)}`;
  }

  function shouldAutoForward(text, settings) {
    const trimmed = String(text || '').trim();
    if (!trimmed || settings?.autoForwardMode === 'off') return false;
    if (settings?.autoForwardMode === 'questions') return /\?\s*$/.test(trimmed);
    if (settings?.autoForwardMode === 'sentences') {
      return /[.!?]\s*$/.test(trimmed) && trimmed.length >= 8;
    }
    return false;
  }

  function formatMessage(_source, author, text) {
    const body = normalizeCaptionText(text);
    if (!body) return '';
    const who = normalizeAuthor(author);
    return who ? `${who}: ${body}` : body;
  }

  function formatSendLine(c) {
    return formatMessage('', c?.author, c?.text);
  }

  function formatLines(lines) {
    return (lines || [])
      .map((c) => {
        const when = c.at ? new Date(c.at).toLocaleTimeString() : '';
        const body = formatSendLine(c);
        return when ? `[${when}] ${body}` : body;
      })
      .join('\n');
  }

  function linesRelated(existing, author, text) {
    if (!existing) return false;
    if (normalizeAuthor(existing.author) !== author) return false;
    const key = captionKey(author, text);
    const sim = similarityKey(author, text);
    if (existing.key === key || existing.sim === sim) return true;
    const nextBare = bareText(text);
    const existingBare = bareText(existing.text);
    return existingBare === nextBare
      || existingBare.startsWith(nextBare)
      || nextBare.startsWith(existingBare);
  }

  function emptyTranscript() {
    return { startedAt: Date.now(), platform: '', lines: [] };
  }

  function trimTranscriptLines(t, max = TRANSCRIPT_MAX_LINES, keep = TRANSCRIPT_KEEP_LINES) {
    if (t?.lines?.length > max) t.lines = t.lines.slice(-keep);
    return t;
  }

  function mergeTranscriptLine(t, next, extras = {}) {
    if (!t || !next?.text) return null;
    const text = normalizeCaptionText(next.text);
    if (!isSpokenCaptionText(text)) return null;
    const author = normalizeAuthor(next.author);
    const platform = next.platform || extras.platform || t.platform || '';
    const source = next.source || extras.source || '';
    const last = t.lines[t.lines.length - 1];
    if (last && linesRelated(last, author, text)) {
      if (text.length > last.text.length) {
        last.text = text;
        last.at = next.at || Date.now();
        last.platform = platform || last.platform;
        last.source = source || last.source;
        last.key = captionKey(author, text);
        last.sim = similarityKey(author, text);
        return last;
      }
      return null;
    }
    const entry = {
      at: next.at || Date.now(),
      author,
      text,
      platform,
      source,
      key: captionKey(author, text),
      sim: similarityKey(author, text),
      sent: next.sent === true
    };
    t.lines.push(entry);
    trimTranscriptLines(t);
    return entry;
  }

  function getUnsentLines(lines) {
    return (lines || []).filter((c) => !c.sent && normalizeCaptionText(c.text));
  }

  function countUnsent(lines) {
    let n = 0;
    for (const c of lines || []) {
      if (!c.sent && c.text) n += 1;
    }
    return n;
  }

  function takeUnsentChunkFrom(lines, maxChars = SEND_CHUNK_CHARS) {
    const chunk = [];
    let size = 0;
    let unsentTotal = 0;
    let capped = false;
    for (const line of lines || []) {
      if (line.sent || !normalizeCaptionText(line.text)) continue;
      unsentTotal += 1;
      if (capped) continue;
      const piece = formatSendLine(line);
      if (!piece) continue;
      const add = chunk.length ? 1 + piece.length : piece.length;
      if (chunk.length && size + add > maxChars) {
        capped = true;
        continue;
      }
      chunk.push(line);
      size += add;
    }
    return {
      lines: chunk,
      remaining: unsentTotal - chunk.length,
      chars: size
    };
  }

  function markLinesSent(lines, entries) {
    if (!lines?.length || !entries?.length) return 0;
    let marked = 0;
    const identity = new Set(lines);
    for (const sent of entries) {
      if (!sent) continue;
      if (identity.has(sent)) {
        if (!sent.sent) {
          sent.sent = true;
          marked += 1;
        }
        continue;
      }
      const author = normalizeAuthor(sent.author);
      const text = normalizeCaptionText(sent.text);
      if (!text) continue;
      for (let i = lines.length - 1; i >= 0; i--) {
        const entry = lines[i];
        if (entry.sent) continue;
        if (!linesRelated(entry, author, text)) continue;
        entry.sent = true;
        marked += 1;
        break;
      }
    }
    return marked;
  }

  class CaptionQueue {
    constructor() {
      this.seen = new Set();
      this.entries = [];
    }

    remember(caption) {
      const author = normalizeAuthor(caption?.author);
      const text = normalizeCaptionText(caption?.text);
      if (!isSpokenCaptionText(text)) return null;

      const key = captionKey(author, text);
      const sim = similarityKey(author, text);
      if (this.seen.has(key) || this.seen.has(sim)) return null;

      for (let i = this.entries.length - 1; i >= 0; i--) {
        const existing = this.entries[i];
        if (!linesRelated(existing, author, text)) continue;
        if (text.length > existing.text.length && !existing.sent) {
          existing.text = text;
          existing.key = key;
          existing.sim = sim;
          this.seen.add(key);
          this.seen.add(sim);
          return existing;
        }
        return null;
      }

      const entry = {
        author,
        text,
        key,
        sim,
        sent: false,
        at: Date.now(),
        platform: caption?.platform || '',
        source: caption?.source || ''
      };
      this.entries.push(entry);
      this.seen.add(key);
      this.seen.add(sim);
      if (this.entries.length > LIVE_QUEUE_MAX) {
        this.entries = this.entries.slice(-LIVE_QUEUE_KEEP);
      }
      return entry;
    }

    getUnsent() {
      return getUnsentLines(this.entries);
    }

    markSent(entries) {
      for (const sent of entries || []) {
        this.seen.add(captionKey(sent.author, sent.text));
        this.seen.add(sent.sim || similarityKey(sent.author, sent.text));
      }
      return markLinesSent(this.entries, entries);
    }

    formatBatch(entries) {
      return (entries || this.getUnsent())
        .map((c) => formatSendLine(c))
        .filter(Boolean)
        .join('\n');
    }
  }

  function parseZoomMeetingId(text, options = {}) {
    const raw = String(text || '');
    const allowLoose = options.allowLoose === true;

    const fromPath = raw.match(/zoom\.us\/(?:j|s)\/(\d{9,11})/i)
      || raw.match(/zoom\.us\/wc\/join\/(\d{9,11})/i)
      || raw.match(/app\.zoom\.us\/wc\/join\/(\d{9,11})/i)
      || raw.match(/app\.zoom\.us\/wc\/(\d{9,11})\/join/i)
      || raw.match(/[?&]confno=(\d{9,11})/i);
    if (fromPath) return fromPath[1];

    const labeled = raw.match(/(?:confno|meeting[_-\s]?id|meeting\s*id|meeting\s*number)\s*[=:#]?\s*([\d\s-]{9,20})/i);
    if (labeled) {
      const digits = labeled[1].replace(/\D/g, '');
      if (digits.length >= 9 && digits.length <= 11) return digits;
    }

    const spaced = raw.match(/\bMeeting\s*ID\s*[:=]?\s*(\d{3})\s+(\d{3})\s+(\d{3,4})\b/i)
      || raw.match(/\b(\d{3})\s+(\d{3})\s+(\d{3,4})\b/);
    if (spaced && /meeting\s*id|confno/i.test(raw)) {
      const digits = `${spaced[1]}${spaced[2]}${spaced[3]}`;
      if (digits.length >= 9 && digits.length <= 11) return digits;
    }

    // Bare digit runs are often UI noise (timestamps, phone fragments) — only when allowed.
    if (allowLoose) {
      const compact = raw.match(/\b(\d{9,11})\b/);
      return compact ? compact[1] : '';
    }
    return '';
  }

  function parseZoomPasscode(text) {
    const raw = String(text || '');
    const fromQuery = raw.match(/[?&]pwd=([^&\s#]+)/i);
    if (fromQuery) {
      try { return decodeURIComponent(fromQuery[1]); } catch { return fromQuery[1]; }
    }
    const labeled = raw.match(/(?:passcode|password)\s*[=:]?\s*([A-Za-z0-9._-]{4,32})/i);
    return labeled ? labeled[1] : '';
  }

  function extractZoomInviteUrl(text) {
    const raw = String(text || '');
    const m = raw.match(/https?:\/\/(?:[\w.-]+\.)?zoom\.us\/j\/\d{9,11}[^\s]*/i)
      || raw.match(/https?:\/\/app\.zoom\.us\/wc\/join\/\d{9,11}[^\s]*/i)
      || raw.match(/https?:\/\/(?:[\w.-]+\.)?zoom\.us\/wc\/join\/\d{9,11}[^\s]*/i);
    if (!m) return '';
    return m[0].replace(/[),.;]+$/, '');
  }

  function formatZoomMeetingId(meetingId) {
    const digits = String(meetingId || '').replace(/\D/g, '');
    if (digits.length === 10) return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
    if (digits.length === 11) return `${digits.slice(0, 3)} ${digits.slice(3, 7)} ${digits.slice(7)}`;
    if (digits.length === 9) return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
    return digits;
  }

  function buildZoomJoinUrl(options = {}) {
    const inviteUrl = String(options.inviteUrl || '').trim();
    if (inviteUrl) return inviteUrl;

    const meetingId = String(options.meetingId || '').replace(/\D/g, '');
    const passcode = String(options.passcode || '').trim();
    if (meetingId) {
      // Prefer /wc/join/{id} — /wc/{id}/join often returns Zoom error 3001 without a valid pwd.
      let url = `https://app.zoom.us/wc/join/${meetingId}`;
      if (passcode) url += `?pwd=${encodeURIComponent(passcode)}`;
      return url;
    }
    return 'https://app.zoom.us/wc/join';
  }

  return {
    SEND_CHUNK_CHARS,
    TRANSCRIPT_MAX_LINES,
    TRANSCRIPT_KEEP_LINES,
    normalizeCaptionText,
    normalizeAuthor,
    bareText,
    isMeetingActivityNoise,
    isSpokenCaptionText,
    captionKey,
    similarityKey,
    shouldAutoForward,
    formatMessage,
    formatSendLine,
    formatLines,
    linesRelated,
    emptyTranscript,
    trimTranscriptLines,
    mergeTranscriptLine,
    getUnsentLines,
    countUnsent,
    takeUnsentChunkFrom,
    markLinesSent,
    CaptionQueue,
    parseZoomMeetingId,
    parseZoomPasscode,
    extractZoomInviteUrl,
    formatZoomMeetingId,
    buildZoomJoinUrl
  };
});
