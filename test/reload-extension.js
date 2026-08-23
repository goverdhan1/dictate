/**
 * Reload unpacked extension via chrome://extensions (Chrome Default profile).
 * Run: node test/reload-extension.js
 */
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER_DATA = path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data');
const MATCH = /auto-dictate|teams bridge|dictate/i;

async function reloadOnPage(page) {
  await page.goto('chrome://extensions', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500));

  await page.evaluate(() => {
    const toggle = document.querySelector('extensions-manager')
      ?.shadowRoot?.querySelector('extensions-toolbar')
      ?.shadowRoot?.querySelector('#devMode');
    if (toggle && !toggle.checked) toggle.click();
  });

  await new Promise((r) => setTimeout(r, 800));

  return page.evaluate((patternSource) => {
    const pattern = new RegExp(patternSource, 'i');
    const manager = document.querySelector('extensions-manager');
    if (!manager?.shadowRoot) return { ok: false, error: 'extensions-manager not found' };

    const items = manager.shadowRoot.querySelector('extensions-item-list')
      ?.shadowRoot?.querySelectorAll('extensions-item') || [];

    const names = [];
    for (const item of items) {
      const itemName = item.shadowRoot?.querySelector('#name')?.textContent?.trim() || '';
      names.push(itemName);
      if (!pattern.test(itemName)) continue;

      const reloadBtn = item.shadowRoot?.querySelector('#dev-reload-button');
      if (!reloadBtn) return { ok: false, error: 'reload button not found', itemName, names };
      reloadBtn.click();
      return { ok: true, itemName, names };
    }
    return { ok: false, error: 'extension card not found', names };
  }, MATCH.source);
}

(async () => {
  let browser;
  let launched = false;

  try {
    browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
    console.log('Connected to Chrome on port 9222');
  } catch {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: false,
      userDataDir: USER_DATA,
      args: ['--profile-directory=Default', '--remote-debugging-port=9222'],
      defaultViewport: null
    });
    launched = true;
    console.log('Launched Chrome with Default profile');
  }

  const pages = await browser.pages();
  const page = pages.find((p) => p.url().startsWith('chrome://extensions')) || pages[0] || await browser.newPage();
  const result = await reloadOnPage(page);
  console.log(result);

  await new Promise((r) => setTimeout(r, 1500));
  if (launched) await browser.close();
  else await browser.disconnect();

  if (!result.ok) process.exit(1);
})().catch(async (err) => {
  console.error('Reload automation failed:', err.message);
  process.exit(1);
});
