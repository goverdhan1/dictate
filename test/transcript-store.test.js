const fs = require('fs');
const os = require('os');
const path = require('path');
const { TranscriptStore, formatLines, takeUnsentChunkFrom } = require('../dictate-desktop/electron/TranscriptStore');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-transcript-'));
const store = new TranscriptStore({ dir });

console.log('\n=== TranscriptStore ===\n');

assert(!store.append({ text: '' }), 'rejects empty text');
assert(store.append({ author: 'Ada', text: 'What is the deadline?', platform: 'teams' }), 'appends a caption');
assert(!store.append({ author: 'Ada', text: 'What is the deadline?', platform: 'teams' }), 'dedupes identical caption');

const longer = store.append({ author: 'Ada', text: 'What is the deadline? Friday?', platform: 'teams' });
assert(!!longer, 'grows a related caption');
assert(store.getCurrent().lines.length === 1, 'still one line after growth');
assert(store.getCurrent().lines[0].text.includes('Friday'), 'keeps the longer text');

assert(store.append({ author: 'Ben', text: 'Ship on Friday.', platform: 'meet' }), 'keeps a different speaker');
assert(store.getCurrent().lines.length === 2, 'two speakers stay as two lines');
assert(store.getCurrent().platform === 'meet', 'tracks latest platform');

const formatted = store.formatText();
assert(formatted.includes('Ada:'), 'format includes author');
assert(formatted.includes('Ship on Friday.'), 'format includes later line');
assert(formatLines([{ author: 'X', text: 'Hi', at: 0 }]).includes('X: Hi'), 'formatLines helper');

store.saveNow();
const currentPath = path.join(dir, 'current.json');
assert(fs.existsSync(currentPath), 'writes current.json');

const reloaded = new TranscriptStore({ dir });
assert(reloaded.getCurrent().lines.length === 2, 'reloads persisted lines');
assert(reloaded.getCurrent().lines[0].text.includes('Friday'), 'reloaded text is the grown caption');

const ended = reloaded.endCall();
assert(ended.success && ended.count === 2, 'endCall reports line count');
assert(ended.fileName && ended.fileName.endsWith('.txt'), 'endCall names a .txt file');
assert(fs.existsSync(ended.path), 'endCall writes the archive');
assert(reloaded.getCurrent().lines.length === 0, 'endCall starts a new transcript');
assert(fs.readFileSync(ended.path, 'utf8').includes('Ship on Friday.'), 'archive contains captions');

const exportPath = path.join(dir, 'export.txt');
reloaded.append({ author: 'Ada', text: 'New call line' });
const exported = reloaded.exportTo(exportPath);
assert(exported.success && fs.readFileSync(exportPath, 'utf8').includes('New call line'), 'exportTo writes a copy');
assert(reloaded.getCurrent().lines.length === 1, 'export does not reset the current call');

console.log('\n=== TranscriptStore send queue ===\n');

const sendDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-transcript-send-'));
const sendStore = new TranscriptStore({ dir: sendDir });
sendStore.append({ author: 'Ada', text: 'First question?' });
sendStore.append({ author: 'Ben', text: 'Second line.' });
assert(sendStore.getUnsent().length === 2, 'new lines start unsent');
assert(sendStore.formatUnsent().includes('Ada: First question?'), 'formatUnsent has no timestamps');
assert(!sendStore.formatUnsent().includes('['), 'formatUnsent omits clock times');

sendStore.append({ author: 'Ada', text: 'First question? Really?' });
assert(sendStore.getUnsent().length === 2, 'growing an unsent line does not add a row');
assert(sendStore.getUnsent()[0].text.includes('Really'), 'unsent text grows in place');

sendStore.markSent([sendStore.getUnsent()[0]]);
assert(sendStore.getUnsent().length === 1, 'markSent removes only matching unsent lines');
assert(sendStore.getUnsent()[0].author === 'Ben', 'later unsent line remains');
sendStore.append({ author: 'Ada', text: 'First question? Really? Yes.' });
assert(sendStore.getUnsent().length === 1, 'growth after send does not re-queue that line');

sendStore.append({ author: 'Cara', text: 'Third.' });
sendStore.markSent(sendStore.getUnsent());
assert(sendStore.getUnsent().length === 0, 'Send does not re-send marked lines');
assert(sendStore.formatText().includes('First question'), 'full transcript still has sent lines');

const chunkLines = [];
for (let i = 0; i < 6; i++) {
  chunkLines.push({ author: 'P', text: `Line ${i} ${'x'.repeat(40)}`, sent: false });
}
const chunk = takeUnsentChunkFrom(chunkLines, 120);
assert(chunk.lines.length >= 1, 'chunk includes at least one line');
assert(chunk.lines.length < 6, 'oldest-first chunk stops before the size cap');
assert(chunk.lines[0].text.startsWith('Line 0'), 'chunk starts with the oldest unsent line');
assert(chunk.remaining === 6 - chunk.lines.length, 'remaining counts lines left for the next Send');

try {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(sendDir, { recursive: true, force: true });
} catch { /* ignore */ }

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
