const zlib = require('zlib');
const {
  LIMITS,
  buildPrimeOnlyMessage,
  buildScreenshotPrompt,
  extractDocxBuffer,
  mergeSavedContext,
  prepareAgentMessage,
  xmlToText
} = require('../dictate-desktop/electron/aiContext');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function zipDocx(xml, method) {
  const name = Buffer.from('word/document.xml');
  const data = Buffer.from(xml);
  const payload = method === 8 ? zlib.deflateRawSync(data) : data;
  const local = Buffer.alloc(30 + name.length + payload.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  payload.copy(local, 30 + name.length);

  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  name.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

const resumeXml = `<?xml version="1.0"?>
<w:document>
  <w:p><w:r><w:t>Senior engineer</w:t></w:r></w:p>
  <w:p><w:r><w:t>Built dictate &amp; captions</w:t></w:r></w:p>
</w:document>`;

console.log('\n=== AI context ===\n');

assert(xmlToText('<w:p><w:t>Hello</w:t></w:p><w:p><w:t>There</w:t></w:p>') === 'Hello\nThere', 'splits Word paragraphs');
assert(extractDocxBuffer(zipDocx(resumeXml, 0)).includes('Senior engineer'), 'reads a stored docx entry');
assert(extractDocxBuffer(zipDocx(resumeXml, 8)).includes('dictate & captions'), 'reads a deflated docx entry');

const empty = prepareAgentMessage({ revision: 0, appliedRevision: 0 }, 'What is the deadline?');
assert(empty.text === 'What is the deadline?', 'leaves captions unchanged when no context is saved');
assert(empty.priming === false, 'does not mark an empty context as priming');

const saved = mergeSavedContext({}, {
  instructions: 'Answer as me.',
  resumeText: 'Senior engineer',
  resumeFileName: 'resume.docx',
  jdText: 'Build interview tools',
  jdFileName: 'jd.pdf'
});
assert(saved.context.revision === 1, 'bumps revision when context is first saved');
assert(saved.truncated.resume === false, 'keeps a short resume');

const again = mergeSavedContext(saved.context, saved.context);
assert(again.context.revision === 1, 'keeps revision when nothing changed');

const edited = mergeSavedContext(saved.context, { ...saved.context, instructions: 'Answer briefly.' });
assert(edited.context.revision === 2, 'bumps revision when instructions change');

const caption = prepareAgentMessage({ ...saved.context, appliedRevision: 0 }, 'What is the deadline?');
assert(caption.priming === false, 'caption Send does not prime context');
assert(caption.text === 'What is the deadline?', 'caption Send is only the caption text');
assert(!caption.text.includes('Senior engineer'), 'caption Send does not include the resume');

const shot = buildScreenshotPrompt({ ...saved.context, appliedRevision: 0 });
assert(shot.priming === false, 'Screenshot does not attach the saved context');
assert(shot.prompt === '', 'Screenshot uses the default prompt');

assert(buildPrimeOnlyMessage(saved.context).includes('Reply with a short confirmation only.'), 'send-now message asks the AI to remember the context');
assert(buildPrimeOnlyMessage({}) === '', 'send-now is empty without context');

const longResume = mergeSavedContext({}, { resumeText: 'a'.repeat(LIMITS.resumeText + 50), resumeFileName: 'long.pdf' });
assert(longResume.truncated.resume === true, 'flags a resume that was shortened');
assert(longResume.context.resumeText.length === LIMITS.resumeText, 'stores the resume at the limit');
assert(longResume.context.resumeFileName === 'long.pdf', 'keeps the file name for a shortened resume');

const cleared = mergeSavedContext(longResume.context, { resumeText: '   ', resumeFileName: 'long.pdf' });
assert(cleared.context.resumeText === '', 'clears resume text');
assert(cleared.context.resumeFileName === '', 'clears the file name when the resume is empty');

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
