const { CaptionQueue, shouldAutoForward } = require('../dictate-desktop/electron/CaptionQueue');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log('\n=== CaptionQueue ===\n');
const q = new CaptionQueue();
assert(q.remember({ author: 'Ada', text: 'What is the deadline?' }), 'queues a caption');
assert(!q.remember({ author: 'Ada', text: 'What is the deadline?' }), 'dedupes identical caption');
assert(q.getUnsent().length === 1, 'one unsent caption');
assert(shouldAutoForward('What is the deadline?', { autoForwardMode: 'questions' }), 'questions mode matches ?');
assert(!shouldAutoForward('We ship Friday.', { autoForwardMode: 'questions' }), 'questions mode ignores statements');
const batch = q.formatBatch(q.getUnsent());
assert(batch === 'Ada: What is the deadline?', 'formats author and text');
q.markSent(q.getUnsent());
assert(q.getUnsent().length === 0, 'markSent clears unsent');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
