const {
  parseZoomMeetingId,
  parseZoomPasscode,
  buildZoomJoinUrl,
  formatZoomMeetingId,
  extractZoomInviteUrl
} = require('../caption-utils');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`); }
  else { failed += 1; console.error(`  ✗ ${msg}`); }
}

console.log('\n=== Zoom join URL helpers ===\n');

assert(parseZoomMeetingId('Meeting ID: 123 456 7890') === '1234567890', 'parses spaced Meeting ID label');
assert(parseZoomMeetingId('https://app.zoom.us/wc/join/987654321') === '987654321', 'parses app.zoom.us /wc/join/{id}');
assert(parseZoomPasscode('Passcode: Ab12Cd') === 'Ab12Cd', 'parses passcode label');
assert(parseZoomMeetingId('confno=1234567890&pwd=Ab12') === '1234567890', 'parses confno from process URL');
assert(parseZoomMeetingId('https://zoom.us/j/11122233344?pwd=X') === '11122233344', 'parses zoom.us/j path');
assert(parseZoomPasscode('https://zoom.us/j/1?pwd=Secret99') === 'Secret99', 'parses pwd query');
assert(parseZoomMeetingId('random 8594169856 digits') === '', 'rejects bare digit noise without Meeting ID label');
assert(formatZoomMeetingId('8594169856') === '859 416 9856', 'formats Meeting ID for title');
assert(
  extractZoomInviteUrl('Join: https://zoom.us/j/11122233344?pwd=Ab12 thanks') === 'https://zoom.us/j/11122233344?pwd=Ab12',
  'extracts invite URL from clipboard text'
);
assert(
  buildZoomJoinUrl({ meetingId: '1234567890', passcode: 'Ab12' }) === 'https://app.zoom.us/wc/join/1234567890?pwd=Ab12',
  'builds /wc/join/{id} URL with passcode'
);
assert(buildZoomJoinUrl({}) === 'https://app.zoom.us/wc/join', 'falls back to generic join page');

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
