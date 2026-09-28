const { CaptionQueue, shouldAutoForward, isSelfAuthor, splitCaptionsForSend, pickSelfDisplayName } = require('../dictate-desktop/electron/CaptionQueue');

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
assert(!shouldAutoForward('What is the deadline?', { autoForwardMode: 'questions' }), 'auto-forward is disabled');
assert(!shouldAutoForward('We ship Friday.', { autoForwardMode: 'sentences' }), 'auto-forward stays off for sentences');
const batch = q.formatBatch(q.getUnsent());
assert(batch === 'Ada: What is the deadline?', 'formats author and text');
q.markSent(q.getUnsent());
assert(q.getUnsent().length === 0, 'markSent clears unsent');

console.log('\n=== Live mode self filter ===\n');
assert(isSelfAuthor('You', []), 'You is always self');
assert(isSelfAuthor('Goverdhan Koyalkar', ['Goverdhan Koyalkar']), 'exact display name is self');
assert(!isSelfAuthor('Interviewer', ['Goverdhan Koyalkar']), 'other speakers are kept');
assert(!isSelfAuthor('', ['Goverdhan Koyalkar']), 'unlabeled lines are kept');
const split = splitCaptionsForSend([
  { author: 'You', text: 'My question' },
  { author: 'Priya', text: 'The deadline is Friday' }
], { mode: 'live', selfNames: ['Goverdhan Koyalkar'] });
assert(split.skip.length === 1 && split.forward.length === 1, 'live mode forwards only other speakers');
const mock = splitCaptionsForSend(split.skip.concat(split.forward), { mode: 'mock', selfNames: ['Goverdhan Koyalkar'] });
assert(mock.skip.length === 0 && mock.forward.length === 2, 'mock mode forwards every speaker');

console.log('\n=== Send chunks ===\n');
const { takeUnsentChunkFrom } = require('../dictate-desktop/electron/CaptionQueue');
const many = [];
for (let i = 0; i < 40; i += 1) {
  many.push({ author: 'Ada', text: 'word '.repeat(40).trim(), sent: false });
}
const first = takeUnsentChunkFrom(many);
assert(first.chars <= 3500, 'first Send stays within 3500 characters');
assert(first.remaining > 0, 'the rest stays queued for the next Send');
assert(first.lines.length < many.length, 'a huge backlog is not sent all at once');
const huge = [{ author: 'Ada', text: 'x'.repeat(8000), sent: false }];
const part = takeUnsentChunkFrom(huge, 1000);
assert(part.chars <= 1000, 'one oversized caption is split');
assert(part.remaining === 1, 'the unread tail stays queued');
assert(huge[0].text.length < 8000, 'the stored line keeps only the tail');

console.log('\n=== Meeting self name ===\n');
assert(pickSelfDisplayName(['Goverdhan Koyalkar (You)']) === 'Goverdhan Koyalkar', 'Teams (You) tile');
assert(pickSelfDisplayName(['Goverdhan Koyalkar (Host, me)']) === 'Goverdhan Koyalkar', 'Zoom (Host, me) tile');
assert(pickSelfDisplayName(['Goverdhan Koyalkar, video off, You']) === 'Goverdhan Koyalkar', 'Teams status suffix');
assert(pickSelfDisplayName(['You are muted now']) === '', 'status lines are not a name');
assert(pickSelfDisplayName(['Ada Lovelace (Guest)']) === '', 'other participants are ignored');
assert(pickSelfDisplayName(['Priya (Host)', 'Goverdhan Koyalkar (Me)']) === 'Goverdhan Koyalkar', 'picks the Me tile');
assert(pickSelfDisplayName(['Goverdhan Koyalkar - You']) === 'Goverdhan Koyalkar', 'Meet dash You label');
assert(pickSelfDisplayName(['Me, Goverdhan Koyalkar']) === 'Goverdhan Koyalkar', 'Webex Me prefix');
assert(pickSelfDisplayName(['You: Goverdhan Koyalkar']) === 'Goverdhan Koyalkar', 'name after You');
assert(pickSelfDisplayName(['Me, leave the meeting']) === '', 'commands after Me are ignored');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
