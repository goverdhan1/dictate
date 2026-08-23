/**
 * Unit tests for Teams→ChatGPT bridge logic (run: node test/bridge-logic.test.js)
 */

function formatMessage(_source, author, text) {
  return author ? `${author}: ${text}` : text;
}

function shouldAutoForward(text, settings) {
  const trimmed = text.trim();
  if (!trimmed || settings.autoForwardMode === 'off') return false;

  if (settings.autoForwardMode === 'questions') {
    return /\?\s*$/.test(trimmed);
  }

  if (settings.autoForwardMode === 'sentences') {
    return /[.!?]\s*$/.test(trimmed) && trimmed.length >= 8;
  }

  return false;
}

function buildPayload(settings, author, text) {
  const trimmed = text.trim();
  const body = formatMessage('', author, trimmed);
  return settings.forwardPrefix ? settings.forwardPrefix + body : body;
}

function scanCaptionsFromDom(document, seenCaptions) {
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

console.log('\n=== shouldAutoForward ===\n');

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

console.log('\n=== caption DOM scraping (simulated Teams) ===\n');

const { JSDOM } = (() => {
  try {
    return { JSDOM: require('jsdom').JSDOM };
  } catch {
    return { JSDOM: null };
  }
})();

if (JSDOM) {
  const dom = new JSDOM(`
    <div class="fui-ChatMessageCompact">
      <span data-tid="author">Alice</span>
      <span data-tid="closed-caption-text">What is the timeline?</span>
    </div>
    <div class="fui-ChatMessageCompact">
      <span data-tid="author">Bob</span>
      <span data-tid="closed-caption-text">We need to finalize specs.</span>
    </div>
  `);
  const seen = new Set();
  const first = scanCaptionsFromDom(dom.window.document, seen);
  assert(first.length === 2, 'captures two caption lines from simulated DOM');
  assert(first[0].author === 'Alice', 'reads caption author');
  assert(first[0].text === 'What is the timeline?', 'reads caption text');

  const second = scanCaptionsFromDom(dom.window.document, seen);
  assert(second.length === 0, 'deduplicates already-seen captions');

  const settings = { autoForwardMode: 'questions', forwardPrefix: 'Answer this meeting question: ' };
  const toForward = first.filter((c) => shouldAutoForward(c.text, settings));
  assert(toForward.length === 1 && toForward[0].author === 'Alice', 'only questions selected in questions mode');
} else {
  console.log('  (skipped DOM tests — jsdom not installed; logic tests above still ran)');
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
