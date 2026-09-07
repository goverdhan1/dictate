const {
  isSpokenCaptionText,
  isMeetingActivityNoise
} = require('../caption-utils');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`); }
  else { failed += 1; console.error(`  ✗ ${msg}`); }
}

console.log('\n=== Meeting activity noise filter ===\n');

const noise = [
  'You are unmuted',
  'Goverdhan Koyalkar is the host now.',
  'Low Network Bandwidth video now stopped',
  'You are muted now.',
  'You are host now.',
  'Goverdhan Koyalkar has left the meeting',
  'This meeting is being transcribed.',
  'video now started',
  'Captions are on, alert Hide',
  'You are unmuted Goverdhan Koyalkar is the host now. Low Network Bandwidth video now stopped You are muted now.'
];

for (const line of noise) {
  assert(isMeetingActivityNoise(line), `filters: ${line.slice(0, 48)}`);
  assert(!isSpokenCaptionText(line), `not spoken: ${line.slice(0, 48)}`);
}

assert(isSpokenCaptionText('What is the launch date for the project?'), 'keeps spoken question');
assert(isSpokenCaptionText('We should ship on Friday.'), 'keeps spoken sentence');

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
