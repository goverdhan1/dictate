/**
 * Ensures the Electron binary is present after npm install.
 * Falls back to PowerShell Expand-Archive on Windows when extract-zip fails.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const distDir = path.join(electronDir, 'dist');
const pathFile = path.join(electronDir, 'path.txt');
const platformPath =
  process.platform === 'win32'
    ? 'electron.exe'
    : process.platform === 'darwin'
      ? path.join('Electron.app', 'Contents', 'MacOS', 'Electron')
      : 'electron';
const exePath = path.join(distDir, platformPath);

function electronReady() {
  try {
    if (!fs.existsSync(exePath)) return false;
    const recorded = fs.readFileSync(pathFile, 'utf8').trim().replace(/\\/g, '/');
    const expected = platformPath.replace(/\\/g, '/');
    // Accept either a matching path.txt or a present platform binary.
    return !recorded || recorded === expected || recorded.endsWith('Electron') || recorded.endsWith('electron') || recorded.endsWith('electron.exe');
  } catch {
    return fs.existsSync(exePath);
  }
}

async function downloadAndExtract() {
  const { downloadArtifact } = require('@electron/get');
  const extract = require('extract-zip');
  const version = require(path.join(electronDir, 'package.json')).version;

  const zipPath = await downloadArtifact({
    version,
    artifactName: 'electron',
    platform: process.platform === 'win32' ? 'win32' : process.platform,
    arch: process.arch,
    force: true
  });

  // Re-extract into a clean folder to avoid EEXIST symlink errors on macOS.
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  if (process.platform === 'win32') {
    const absDist = path.resolve(distDir);
    const absZip = path.resolve(zipPath);
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${absZip.replace(/'/g, "''")}' -DestinationPath '${absDist.replace(/'/g, "''")}' -Force"`,
      { stdio: 'inherit' }
    );
  } else {
    await extract(zipPath, { dir: path.resolve(distDir) });
  }

  fs.writeFileSync(pathFile, platformPath, { encoding: 'utf8' });
}

(async () => {
  if (electronReady()) {
    console.log('[dictate-desktop] Electron binary OK');
    return;
  }

  console.log('[dictate-desktop] Electron binary missing — downloading…');
  try {
    await downloadAndExtract();
  } catch (e) {
    console.error('[dictate-desktop] Electron install failed:', e.message || e);
    process.exit(1);
  }

  if (!fs.existsSync(exePath)) {
    console.error('[dictate-desktop] electron executable still missing at', exePath);
    process.exit(1);
  }

  console.log('[dictate-desktop] Electron installed:', exePath);
})();
