const fs = require('fs');
const path = require('path');

function extensionScriptPath(name) {
  const candidates = [
    path.join(__dirname, '..', '..', name),
    path.join(process.resourcesPath, 'extension', name),
    path.join(__dirname, '..', 'extension', name)
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`Extension script not found: ${name}`);
}

function readExtensionScript(name) {
  return fs.readFileSync(extensionScriptPath(name), 'utf8');
}

function readInjectScript(name) {
  return fs.readFileSync(path.join(__dirname, 'inject', name), 'utf8');
}

function buildPageInjection() {
  const shim = readInjectScript('chrome-shim.js');
  const flags = `
window.__dictateElectron = true;
window.__DICTATE_USE_NATIVE_OVERLAY__ = true;
`;
  return `${flags}\n${shim}`;
}

function buildChatGPTInjection() {
  const prefix = buildPageInjection();
  const script = readExtensionScript('content-script.js');
  return `${prefix}\n${script}`;
}

async function injectIntoWebContents(webContents, script) {
  await webContents.executeJavaScript(script, true);
}

module.exports = {
  buildChatGPTInjection,
  injectIntoWebContents,
  extensionScriptPath
};
