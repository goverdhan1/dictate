const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const LIMITS = {
  instructions: 8000,
  resumeText: 30000,
  jdText: 30000
};

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.docx', '.txt', '.md', '.markdown', '.text', '.rtf']);

const SCREENSHOT_TASK = 'Look at this screenshot and answer the question or solve the problem shown on screen. Be direct. If code is required, include it.';
const REMINDER = 'Use the resume, job description, and instructions already in this chat.';

function clampField(value, limit) {
  const clean = String(value || '')
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  if (clean.length <= limit) return { text: clean, truncated: false };
  return { text: clean.slice(0, limit).trim(), truncated: true };
}

function fileLabel(value) {
  return String(value || '').replace(/[\r\n\u0000]/g, ' ').trim().slice(0, 180);
}

function normalizeContext(input) {
  const instructions = clampField(input?.instructions, LIMITS.instructions);
  const resume = clampField(input?.resumeText, LIMITS.resumeText);
  const jd = clampField(input?.jdText, LIMITS.jdText);
  return {
    instructions: instructions.text,
    resumeText: resume.text,
    resumeFileName: resume.text ? fileLabel(input?.resumeFileName) : '',
    jdText: jd.text,
    jdFileName: jd.text ? fileLabel(input?.jdFileName) : '',
    revision: Math.max(0, Number(input?.revision) || 0),
    truncated: {
      instructions: instructions.truncated,
      resume: resume.truncated,
      jd: jd.truncated
    }
  };
}

function storableContext(context) {
  const normalized = normalizeContext(context);
  return {
    instructions: normalized.instructions,
    resumeText: normalized.resumeText,
    resumeFileName: normalized.resumeFileName,
    jdText: normalized.jdText,
    jdFileName: normalized.jdFileName,
    revision: normalized.revision
  };
}

function mergeSavedContext(prev, input) {
  const previous = storableContext(prev);
  const normalized = normalizeContext({
    instructions: input?.instructions,
    resumeText: input?.resumeText,
    resumeFileName: input?.resumeFileName,
    jdText: input?.jdText,
    jdFileName: input?.jdFileName,
    revision: previous.revision
  });
  const next = storableContext(normalized);
  if (!sameContext(previous, next)) next.revision = (Number(previous.revision) || 0) + 1;
  return { context: next, truncated: normalized.truncated };
}

function sameContext(a, b) {
  const left = storableContext(a);
  const right = storableContext(b);
  return left.instructions === right.instructions
    && left.resumeText === right.resumeText
    && left.resumeFileName === right.resumeFileName
    && left.jdText === right.jdText
    && left.jdFileName === right.jdFileName;
}

function hasAiContext(context) {
  const ctx = normalizeContext(context);
  return !!(ctx.instructions || ctx.resumeText || ctx.jdText);
}

function buildContextBlock(context) {
  const ctx = normalizeContext(context);
  const parts = [];
  if (ctx.instructions) parts.push(`Instructions:\n${ctx.instructions}`);
  if (ctx.resumeText) {
    const name = ctx.resumeFileName ? ` (${ctx.resumeFileName})` : '';
    parts.push(`Resume${name}:\n${ctx.resumeText}`);
  }
  if (ctx.jdText) {
    const name = ctx.jdFileName ? ` (${ctx.jdFileName})` : '';
    parts.push(`Job description${name}:\n${ctx.jdText}`);
  }
  return parts.join('\n\n');
}

function needsFullContext(state) {
  if (!hasAiContext(state)) return false;
  return Number(state?.appliedRevision) !== Number(state?.revision);
}

function buildPrimeOnlyMessage(context) {
  const block = buildContextBlock(context);
  if (!block) return '';
  return [
    'Remember the following for the rest of this chat. Use it whenever you answer. Do not summarize these documents unless I ask. Reply with a short confirmation only.',
    '',
    block
  ].join('\n');
}

function prepareAgentMessage(_state, userText) {
  return { text: String(userText || ''), priming: false };
}

function buildScreenshotPrompt() {
  return { prompt: '', priming: false };
}

function readContextState(appState) {
  const stored = storableContext(appState?.get?.('aiContext'));
  const appliedMap = appState?.get?.('aiContextApplied') || {};
  const providerId = appState?.getAgentProvider?.() || 'chatgpt';
  return {
    ...stored,
    providerId,
    appliedRevision: Number(appliedMap[providerId] || 0)
  };
}

function contextNeedsPrime(state) {
  return needsFullContext(state);
}

function findEndOfCentralDirectory(buffer) {
  const sig = 0x06054b50;
  const min = Math.max(0, buffer.length - (22 + 65535));
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === sig) return i;
  }
  return -1;
}

function inflateZipEntry(buffer, method, dataStart, compSize) {
  const slice = buffer.subarray(dataStart, dataStart + compSize);
  if (method === 0) return slice.toString('utf8');
  if (method === 8) return zlib.inflateRawSync(slice).toString('utf8');
  throw new Error('This Word file uses compression Dictate cannot read. Save it as .docx or paste the text.');
}

function readZipEntry(buffer, entryName) {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error('Could not read that Word file');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff) {
    throw new Error('This Word file is too large to read. Paste the text instead.');
  }
  for (let n = 0; n < count; n += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    if (name === entryName) {
      if (flags & 0x1) throw new Error('This file is password protected. Paste the text instead.');
      if (compSize === 0xffffffff || localOffset === 0xffffffff) {
        throw new Error('This Word file is too large to read. Paste the text instead.');
      }
      const localNameLen = buffer.readUInt16LE(localOffset + 26);
      const localExtraLen = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      return inflateZipEntry(buffer, method, dataStart, compSize);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('This Word file has no document text');
}

function xmlToText(xml) {
  return String(xml || '')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractDocxBuffer(buffer) {
  return xmlToText(readZipEntry(buffer, 'word/document.xml'));
}

function stripRtf(raw) {
  return String(raw || '')
    .replace(/\\par[d]?/g, '\n')
    .replace(/\\'[0-9a-fA-F]{2}/g, (match) => Buffer.from(match.slice(2), 'hex').toString('latin1'))
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function readTextBuffer(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le').replace(/^\uFEFF/, '');
  }
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

async function extractPdfBuffer(buffer) {
  let pdfParse;
  try {
    pdfParse = require('pdf-parse');
  } catch {
    throw new Error('PDF reading is unavailable. Upload a .docx or .txt file, or paste the text.');
  }
  const data = await pdfParse(buffer);
  return String(data?.text || '');
}

async function extractDocument(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  const ext = path.extname(resolved).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error('Upload a .pdf, .docx, .txt, or .md file');
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error('Choose a file');
  if (stat.size > MAX_FILE_BYTES) throw new Error('File is larger than 10 MB');
  if (stat.size === 0) throw new Error('That file is empty');

  const buffer = fs.readFileSync(resolved);
  let text = '';
  if (ext === '.docx') text = extractDocxBuffer(buffer);
  else if (ext === '.pdf') text = await extractPdfBuffer(buffer);
  else if (ext === '.rtf') text = stripRtf(readTextBuffer(buffer));
  else text = readTextBuffer(buffer);

  const cleaned = String(text || '').replace(/\u0000/g, '').trim();
  if (!cleaned) {
    throw new Error('No text found in that file. If it is a scanned PDF, paste the text instead.');
  }
  return { text: cleaned, fileName: path.basename(resolved) };
}

module.exports = {
  LIMITS,
  ALLOWED_EXTENSIONS,
  REMINDER,
  SCREENSHOT_TASK,
  clampField,
  normalizeContext,
  storableContext,
  sameContext,
  mergeSavedContext,
  hasAiContext,
  buildContextBlock,
  needsFullContext,
  buildPrimeOnlyMessage,
  prepareAgentMessage,
  buildScreenshotPrompt,
  contextNeedsPrime,
  readContextState,
  xmlToText,
  extractDocxBuffer,
  extractDocument
};
