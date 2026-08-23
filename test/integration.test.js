/**
 * Integration checks for manifest + ChatGPT input handling (run: node test/integration.test.js)
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) { passed++; console.log(`  ✓ ${message}`); }
  else { failed++; console.error(`  ✗ ${message}`); }
}

console.log('\n=== manifest.json ===\n');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
assert(manifest.manifest_version === 3, 'manifest v3');
assert(manifest.host_permissions.includes('https://teams.microsoft.com/*'), 'Teams host permission');
assert(manifest.host_permissions.includes('https://chatgpt.com/*'), 'ChatGPT host permission');
assert(manifest.permissions.includes('tabs'), 'tabs permission for bridge');
const teamsScript = manifest.content_scripts.find((cs) =>
  cs.matches.some((m) => m.includes('teams.microsoft.com'))
);
assert(teamsScript?.js?.includes('teams-bridge.js'), 'teams-bridge.js registered for Teams');
const chatgptScript = manifest.content_scripts.find((cs) =>
  cs.matches.some((m) => m.includes('chatgpt.com'))
);
assert(chatgptScript?.js?.includes('content-script.js'), 'content-script.js registered for ChatGPT');

console.log('\n=== ChatGPT receiveFromTeams (simulated DOM) ===\n');

function setInputText(el, text) {
  if (!el || !text) return false;
  el.focus();
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    el.value = text;
    el.dispatchEvent(new el.ownerDocument.defaultView.InputEvent('input', { bubbles: true }));
    return true;
  }
  el.textContent = '';
  el.ownerDocument.execCommand('insertText', false, text);
  el.dispatchEvent(new el.ownerDocument.defaultView.InputEvent('input', { bubbles: true }));
  return true;
}

const chatgptDom = new JSDOM(`
  <form data-type="unified-composer">
    <textarea id="prompt-textarea" name="prompt-textarea"></textarea>
    <button data-testid="send-button" aria-label="Send prompt">Send</button>
  </form>
`);
const doc = chatgptDom.window.document;
const textarea = doc.querySelector('#prompt-textarea');
const testMessage = 'Answer this meeting question: Alice: What is the deadline?';

assert(!!textarea, 'ChatGPT #prompt-textarea found in simulated DOM');
assert(setInputText(textarea, testMessage), 'setInputText writes to textarea');
assert(textarea.value === testMessage, 'textarea value matches forwarded Teams message');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
