/**
 * Unit tests for meeting bridge logic (run: node test/bridge-logic.test.js)
 */

const path = require('path');
const fs = require('fs');

global.window = global;
global.self = global;
require(path.join(__dirname, '..', 'meeting-bridge-core.js'));

const {
  shouldAutoForward,
  collapseDuplicatedPayload,
  normalizeCaptionText,
  bareText
} = global.DictateMeetingBridge;

function formatMessage(_source, author, text) {
  return author ? `${author}: ${text}` : text;
}

function scanTeamsCaptionsFromDom(document, seenCaptions) {
  const CAPTION_SELECTORS = {
    text: "[data-tid='closed-caption-text']",
    author: "[data-tid='author']"
  };

  const captured = [];
  const nodes = document.querySelectorAll(CAPTION_SELECTORS.text);
  for (const node of nodes) {
    const text = (node.textContent || '').trim();
    if (!text) continue;

    const row = node.closest('.fui-ChatMessageCompact') || node.parentElement;
    const authorEl = row?.querySelector(CAPTION_SELECTORS.author);
    const author = (authorEl?.textContent || '').trim();
    const key = `${author}::${text}`;

    if (seenCaptions.has(key)) continue;
    seenCaptions.add(key);
    captured.push({ author, text });
  }
  return captured;
}

function scanMeetCaptionsFromDom(document, seenCaptions) {
  const captured = [];
  const rows = document.querySelectorAll('div[jsname="dsyhDe"]');
  for (const row of rows) {
    const author = (row.querySelector('div.KcIKyf')?.textContent || '').trim();
    const text = (row.querySelector('div.bh44bd')?.textContent || '').trim();
    if (!text) continue;
    const key = `${author}::${text}`;
    if (seenCaptions.has(key)) continue;
    seenCaptions.add(key);
    captured.push({ author, text });
  }
  return captured;
}

function scanZoomCaptionsFromDom(document, seenCaptions) {
  const captured = [];
  document.querySelectorAll('.live-transcription-subtitle__item').forEach((el) => {
    const text = (el.textContent || '').trim();
    if (text.length <= 1) return;
    const key = text;
    if (seenCaptions.has(key)) return;
    seenCaptions.add(key);
    captured.push({ author: '', text });
  });
  return captured;
}

function scanWebexCaptionsFromDom(document, seenCaptions) {
  const captured = [];
  document.querySelectorAll('[class*="caption-item"]').forEach((item) => {
    const author = (item.querySelector('[class*="caption-name"]')?.textContent || '').trim();
    const text = (item.querySelector('[class*="caption-text"]')?.textContent || '').trim();
    if (!text) return;
    const key = `${author}::${text}`;
    if (seenCaptions.has(key)) return;
    seenCaptions.add(key);
    captured.push({ author, text });
  });
  return captured;
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

console.log('\n=== shouldAutoForward (manual Send only) ===\n');

assert(
  !shouldAutoForward('What is the deadline?', { autoForwardMode: 'questions' }),
  'never auto-forwards questions'
);
assert(
  !shouldAutoForward('We ship on Friday.', { autoForwardMode: 'sentences' }),
  'never auto-forwards sentences'
);
assert(
  !shouldAutoForward('Anything at all?', { autoForwardMode: 'off' }),
  'off mode forwards nothing'
);

console.log('\n=== collapseDuplicatedPayload ===\n');

assert(
  collapseDuplicatedPayload('Alice: Hello?\nAlice: Hello?') === 'Alice: Hello?',
  'collapses duplicate lines'
);
assert(
  normalizeCaptionText('  hello   world  ') === 'hello world',
  'normalizeCaptionText collapses whitespace'
);
assert(
  bareText('Hello, World!') === 'hello world',
  'bareText strips punctuation'
);

console.log('\n=== formatMessage ===\n');

assert(
  formatMessage('', 'John', 'What is the budget?') === 'John: What is the budget?',
  'formatMessage includes author and text'
);
assert(
  formatMessage('', 'Jane', 'Hello there.') === 'Jane: Hello there.',
  'formatMessage sends author and text only'
);
assert(
  formatMessage('', '', 'Hello there.') === 'Hello there.',
  'formatMessage omits empty author'
);

console.log('\n=== caption DOM scraping (platform fixtures) ===\n');

const { JSDOM } = (() => {
  try {
    return { JSDOM: require('jsdom').JSDOM };
  } catch {
    return { JSDOM: null };
  }
})();

if (JSDOM) {
  const teamsDom = new JSDOM(`
    <div class="fui-ChatMessageCompact">
      <span data-tid="author">Alice</span>
      <span data-tid="closed-caption-text">What is the timeline?</span>
    </div>
    <div class="fui-ChatMessageCompact">
      <span data-tid="author">Bob</span>
      <span data-tid="closed-caption-text">We need to finalize specs.</span>
    </div>
  `);
  const teamsSeen = new Set();
  const teamsCaptions = scanTeamsCaptionsFromDom(teamsDom.window.document, teamsSeen);
  assert(teamsCaptions.length === 2, 'Teams: captures two caption lines');
  assert(teamsCaptions[0].author === 'Alice', 'Teams: reads caption author');

  const meetDom = new JSDOM(`
    <div jsname="dsyhDe">
      <div class="KcIKyf">Carol</div>
      <div class="bh44bd">When is the demo?</div>
    </div>
  `);
  const meetSeen = new Set();
  const meetCaptions = scanMeetCaptionsFromDom(meetDom.window.document, meetSeen);
  assert(meetCaptions.length === 1 && meetCaptions[0].text === 'When is the demo?', 'Meet: parses caption row');

  const zoomDom = new JSDOM(`
    <div class="captions-box">
      <span class="live-transcription-subtitle__item">Thanks everyone for joining.</span>
    </div>
  `);
  const zoomSeen = new Set();
  const zoomCaptions = scanZoomCaptionsFromDom(zoomDom.window.document, zoomSeen);
  assert(zoomCaptions.length === 1, 'Zoom: captures subtitle line');

  const webexDom = new JSDOM(`
    <div class="caption-item-abc">
      <div class="caption-name-xyz">Dave</div>
      <div class="caption-text-xyz">Any blockers?</div>
    </div>
  `);
  const webexSeen = new Set();
  const webexCaptions = scanWebexCaptionsFromDom(webexDom.window.document, webexSeen);
  assert(webexCaptions.length === 1 && webexCaptions[0].author === 'Dave', 'Webex: parses caption item');

  const toForward = teamsCaptions.filter((c) => shouldAutoForward(c.text, { autoForwardMode: 'questions' }));
  assert(toForward.length === 0, 'auto-forward is disabled — nothing selected without Send');
} else {
  console.log('  (skipped DOM tests — jsdom not installed; logic tests above still ran)');
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
