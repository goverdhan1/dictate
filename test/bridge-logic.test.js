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

function buildPayload(settings, author, text) {
  const trimmed = text.trim();
  const body = formatMessage('', author, trimmed);
  return settings.forwardPrefix ? settings.forwardPrefix + body : body;
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

console.log('\n=== shouldAutoForward (from meeting-bridge-core) ===\n');

assert(
  shouldAutoForward('What is the deadline?', { autoForwardMode: 'questions' }),
  'questions mode forwards questions'
);
assert(
  !shouldAutoForward('We ship on Friday.', { autoForwardMode: 'questions' }),
  'questions mode ignores statements'
);
assert(
  shouldAutoForward('We ship on Friday.', { autoForwardMode: 'sentences' }),
  'sentences mode forwards statements with period'
);
assert(
  shouldAutoForward('Is it ready?', { autoForwardMode: 'sentences' }),
  'sentences mode forwards questions with ? (8+ chars)'
);
assert(
  !shouldAutoForward('Hi.', { autoForwardMode: 'sentences' }),
  'sentences mode ignores very short fragments (<8 chars)'
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

console.log('\n=== buildPayload / prefix ===\n');

assert(
  buildPayload(
    { forwardPrefix: 'Answer this meeting question: ' },
    'John',
    'What is the budget?'
  ) === 'Answer this meeting question: John: What is the budget?',
  'custom prefix is prepended with author'
);
assert(
  buildPayload({ forwardPrefix: '' }, 'Jane', 'Hello there.') === 'Jane: Hello there.',
  'empty prefix sends author and text only'
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

  const settings = { autoForwardMode: 'questions', forwardPrefix: '' };
  const toForward = teamsCaptions.filter((c) => shouldAutoForward(c.text, settings));
  assert(toForward.length === 1 && toForward[0].author === 'Alice', 'only questions selected in questions mode');
} else {
  console.log('  (skipped DOM tests — jsdom not installed; logic tests above still ran)');
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
