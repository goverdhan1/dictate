const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: false,
    args: ['--profile-directory=Default', 'chrome://extensions'],
    defaultViewport: null
  });
  const page = (await browser.pages())[0];
  await page.goto('chrome://extensions', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500));

  const names = await page.evaluate(() => {
    const manager = document.querySelector('extensions-manager');
    if (!manager?.shadowRoot) return ['no manager'];
    const items = manager.shadowRoot.querySelector('extensions-item-list')
      ?.shadowRoot?.querySelectorAll('extensions-item') || [];
    return [...items].map((item) => item.shadowRoot?.querySelector('#name')?.textContent?.trim()).filter(Boolean);
  });

  console.log('Extensions found:', names);
  await browser.close();
})();
