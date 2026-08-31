const undetectable = document.getElementById('undetectable');
const bridgeEnabled = document.getElementById('bridgeEnabled');

async function load() {
  const settings = await window.dictateSettings.getSettings();
  undetectable.checked = settings.undetectable !== false;
  bridgeEnabled.checked = settings.bridgeEnabled !== false;
}

undetectable.addEventListener('change', () => {
  window.dictateSettings.setUndetectable(undetectable.checked);
});

bridgeEnabled.addEventListener('change', () => {
  window.dictateSettings.setSetting('bridgeEnabled', bridgeEnabled.checked);
});

load();
