const path = require('path');

function loadCaptionUtils() {
  const candidates = [
    path.join(__dirname, '..', '..', 'caption-utils.js'),
    path.join(process.resourcesPath || '', 'extension', 'caption-utils.js'),
    path.join(__dirname, '..', 'caption-utils.js')
  ];
  let lastErr;
  for (const file of candidates) {
    try {
      return require(file);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

module.exports = loadCaptionUtils();
