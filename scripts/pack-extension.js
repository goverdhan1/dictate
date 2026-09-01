const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'background.js',
  'content-script.js',
  'popup.html',
  'popup.js',
  'caption-utils.js',
  'meeting-bridge-core.js',
  'teams-bridge.js',
  'meet-bridge.js',
  'zoom-bridge.js',
  'webex-bridge.js'
];
const ICONS = ['icon16.png', 'icon48.png', 'icon128.png'];

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function packVariant(name, manifestSrc) {
  const dest = path.join(ROOT, 'dist-extension', name);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.join(dest, 'icons'), { recursive: true });
  copyFile(manifestSrc, path.join(dest, 'manifest.json'));
  for (const file of FILES) {
    copyFile(path.join(ROOT, file), path.join(dest, file));
  }
  for (const icon of ICONS) {
    copyFile(path.join(ROOT, 'icons', icon), path.join(dest, 'icons', icon));
  }
  console.log(`Packed ${name} → ${dest}`);
}

packVariant('chromium', path.join(ROOT, 'manifest.json'));
packVariant('firefox', path.join(ROOT, 'manifest.firefox.json'));

console.log(`
Load unpacked:
  Chrome / Edge / Brave / Opera / Comet / Arc / Vivaldi
    ${path.join(ROOT, 'dist-extension', 'chromium')}
  Firefox
    ${path.join(ROOT, 'dist-extension', 'firefox')}
`);
