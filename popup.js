const checkbox = document.getElementById('enabled');
const openBtn = document.getElementById('open-settings');

async function getEnabled() {
  const data = await chrome.storage.local.get({ enabled: true });
  checkbox.checked = data.enabled;
}

checkbox.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: checkbox.checked });
});

openBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://chatgpt.com' });
});

getEnabled();
