import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BrowserManager } from '../dist/core/browser.js';
import { AvitoParser } from '../dist/core/parser.js';
import { AvitoScraper } from '../dist/core/scraper.js';

// Run these on Linux with xvfb-run when a desktop is not available.
const noDisplay = process.platform === 'linux' && !process.env.DISPLAY;
const headed = { skip: noDisplay ? 'Requires a display (use xvfb-run)' : false };

async function fixture(t, options, handler) {
  const root = await mkdtemp(join(tmpdir(), 'avito-regression-'));
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { persistent, ...rest } = options;
  const scraper = new AvitoScraper({
    headless: true, timeout: 2000, delayMs: [0, 0],
    captchaTimeoutMs: 1500, captchaPollMs: 25,
    ...(persistent ? { userDataDir: join(root, 'profile') } : {}),
    ...rest,
  });
  t.after(async () => {
    await scraper.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  });
  return { scraper, origin: `http://127.0.0.1:${server.address().port}` };
}

for (const persistent of [false, true]) {
  const mode = persistent ? 'persistent profile' : 'ordinary context';
  for (const headless of [true, false]) {
    test(`${mode}, headless=${headless}: native browser identity and shared settings`, headless ? {} : headed, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'avito-identity-'));
      const browser = new BrowserManager({ headless, ...(persistent ? { userDataDir: root } : {}) });
      t.after(async () => { await browser.close(); await rm(root, { recursive: true, force: true }); });
      await browser.initialize();
      const page = await browser.getPage();
      await page.route('https://identity.test/**', (route) => route.fulfill({ body: '<h1>Local fixture</h1>' }));
      await page.goto('https://identity.test/');
      const actual = await page.evaluate(() => ({
        ua: navigator.userAgent, platform: navigator.platform,
        brands: navigator.userAgentData?.brands,
        webdriver: navigator.webdriver,
        pluginsType: Object.prototype.toString.call(navigator.plugins),
        pluginsItem: typeof navigator.plugins.item,
        pluginType: navigator.plugins.length ? Object.prototype.toString.call(navigator.plugins[0]) : null,
        locale: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        viewport: [innerWidth, innerHeight],
      }));
      assert.equal(actual.webdriver, false);
      assert.equal(actual.pluginsType, '[object PluginArray]');
      assert.equal(actual.pluginsItem, 'function');
      if (actual.pluginType) assert.equal(actual.pluginType, '[object Plugin]');
      assert.equal(actual.locale, 'ru-RU');
      assert.equal(actual.timezone, 'Europe/Moscow');
      assert.deepEqual(actual.viewport, [1920, 1080]);
      assert.doesNotMatch(actual.ua, /Firefox|Edg\//);
      const version = actual.ua.match(/(?:Headless)?Chrome\/(\d+)/)?.[1];
      assert.ok(version);
      assert.equal(actual.brands.find(({ brand }) => brand === 'Chromium').version, version);
      if (actual.platform === 'MacIntel') assert.match(actual.ua, /Macintosh/);
      if (actual.platform === 'Win32') assert.match(actual.ua, /Windows/);
      if (actual.platform.startsWith('Linux')) assert.match(actual.ua, /Linux/);
    });
  }

  test(`${mode}: explicit userAgent is applied`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'avito-custom-ua-'));
    const browser = new BrowserManager({ headless: true, userAgent: 'LocalAudit/1.0', ...(persistent ? { userDataDir: root } : {}) });
    t.after(async () => { await browser.close(); await rm(root, { recursive: true, force: true }); });
    await browser.initialize();
    const page = await browser.getPage();
    await page.goto('data:text/html,<h1>Local</h1>');
    assert.equal(await page.evaluate(() => navigator.userAgent), 'LocalAudit/1.0');
  });

  test(`${mode}: fallback must reject a subsequent HTTP error`, headed, async (t) => {
    for (const [status, code] of [[403, 'AVITO_ACCESS_RESTRICTED'], [429, 'AVITO_RATE_LIMITED'], [500, 'AVITO_HTTP_ERROR']]) {
      await t.test(String(status), async (t) => {
        let visits = 0;
        const { scraper, origin } = await fixture(t, { persistent }, (req, res) => {
          if (req.url !== '/item') return res.end();
          visits++;
          res.writeHead(visits === 1 ? 200 : status, { 'Content-Type': 'text/html' });
          res.end(visits === 1 ? '<div id="captcha">Solve</div>' : '<h1>Forbidden</h1>');
        });
        await assert.rejects(scraper.getItemDetails(origin + '/item'), { code });
        assert.equal(visits, 2);
      });
    }
  });

  test(`${mode}: HTTP 403 challenge can be solved; hidden leftover is ignored`, headed, async (t) => {
    let visits = 0;
    const { scraper, origin } = await fixture(t, { persistent, headless: false }, (req, res) => {
      if (req.url !== '/item') return res.end();
      visits++;
      const solved = req.headers.cookie?.includes('solved=yes');
      res.writeHead(solved ? 200 : 403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(solved ? '<h1>Actual item</h1><div class="captcha-container" hidden>Old challenge</div>' : `
        <title>Доступ ограничен: проблема с IP</title>
        <div id="captcha"><button onclick="document.cookie='solved=yes;path=/';document.querySelector('#captcha').hidden=true">Solve local fixture</button></div>`);
    });
    await scraper.initialize();
    const page = await scraper.browser.getPage();
    const request = scraper.getItemDetails(origin + '/item');
    // Attach immediately so the unfixed implementation fails without an unhandled rejection.
    const result = request.then((value) => ({ value }), (error) => ({ error }));
    await page.locator('#__avito_captcha_popup__').waitFor({ timeout: 2000 });
    await page.getByRole('button', { name: 'Solve local fixture' }).click();
    const outcome = await result;
    assert.ifError(outcome.error);
    assert.equal(outcome.value.title, 'Actual item');
    assert.ok(visits >= 2, 'A successful server response must be verified after the in-place solution');
    assert.equal(await page.locator('#__avito_captcha_popup__').count(), 0);
  });

  test(`${mode}: fallback opens a visible browser and completes manual verification`, headed, async (t) => {
    let visits = 0;
    const { scraper, origin } = await fixture(t, { persistent }, (req, res) => {
      if (req.url !== '/item') return res.end();
      visits++;
      res.setHeader('Content-Type', 'text/html');
      // This simulates a human solving only the local test fixture, after the popup appears.
      res.end(req.headers.cookie?.includes('solved=yes') ? '<h1>Verified item</h1>' : `
        <div id="captcha">Local verification</div>
        <script>new MutationObserver(() => {
          if (document.querySelector('#__avito_captcha_popup__')) {
            document.cookie='solved=yes;path=/'; document.querySelector('#captcha').hidden=true;
          }
        }).observe(document.body,{childList:true});</script>`);
    });
    assert.equal((await scraper.getItemDetails(origin + '/item')).title, 'Verified item');
    assert.ok(visits >= 3);
    const page = await scraper.browser.getPage();
    assert.doesNotMatch(await page.evaluate(() => navigator.userAgent), /HeadlessChrome/);
    assert.equal(await page.evaluate(() => navigator.webdriver), false);
  });

  test(`${mode}: timeout preserves the challenge; retry does not overwrite it`, headed, async (t) => {
    const visits = [];
    const { scraper, origin } = await fixture(t, {
      persistent, headless: false, captchaTimeoutMs: 100,
    }, (req, res) => {
      visits.push(req.url);
      res.end('<div id="captcha"><button>Unsolved challenge</button></div>');
    });
    await assert.rejects(scraper.getItemDetails(origin + '/item'), { code: 'CAPTCHA_DETECTED' });
    const page = await scraper.browser.getPage();
    assert.equal(await page.locator('#__avito_captcha_popup__').count(), 0);
    await assert.rejects(scraper.getItemDetails(origin + '/another'), { code: 'CAPTCHA_DETECTED' });
    assert.equal(await scraper.browser.getPage(), page);
    assert.ok(!visits.includes('/another'));
  });

  test(`${mode}: fallback disabled returns CAPTCHA without reopening`, async (t) => {
    let visits = 0;
    const { scraper, origin } = await fixture(t, { persistent, manualCaptchaFallback: false }, (req, res) => {
      if (req.url === '/item') visits++;
      res.end('<div id="captcha">Challenge</div>');
    });
    await assert.rejects(scraper.getItemDetails(origin + '/item'), { code: 'CAPTCHA_DETECTED' });
    assert.equal(visits, 1);
    const page = await scraper.browser.getPage();
    assert.match(await page.evaluate(() => navigator.userAgent), /HeadlessChrome/);
  });

  test(`${mode}: navigation during manual solution is checked before parsing`, headed, async (t) => {
    const { scraper, origin } = await fixture(t, { persistent, headless: false }, (req, res) => {
      if (req.url !== '/item') return res.end();
      const solved = req.headers.cookie?.includes('solved=yes');
      res.writeHead(solved ? 500 : 200, { 'Content-Type': 'text/html' });
      res.end(solved ? '<h1>Server error</h1>' : `
        <div id="captcha"><button onclick="document.cookie='solved=yes;path=/';location.reload()">Solve local fixture</button></div>`);
    });
    await scraper.initialize();
    const page = await scraper.browser.getPage();
    const result = assert.rejects(scraper.getItemDetails(origin + '/item'), { code: 'AVITO_HTTP_ERROR' });
    await page.locator('#__avito_captcha_popup__').waitFor({ timeout: 2000 });
    await page.getByRole('button', { name: 'Solve local fixture' }).click();
    await result;
  });
}

test('CAPTCHA detection ignores hidden/empty containers and distinguishes a plain firewall', async (t) => {
  const browser = new BrowserManager({ headless: true });
  t.after(() => browser.close());
  await browser.initialize();
  const page = await browser.getPage();
  const parser = new AvitoParser();
  for (const html of [
    '<h1>Item</h1><div class="captcha-container" style="display:none">Challenge</div>',
    '<h1>Item</h1><div id="captcha" style="visibility:hidden">Challenge</div>',
    '<h1>Item</h1><div class="captcha-container" style="width:300px;height:100px"></div>',
    '<title>Доступ ограничен: проблема с IP</title><h1>Access denied</h1>',
  ]) {
    await page.setContent(html);
    assert.equal(await parser.detectCaptcha(page), false, html);
  }
  assert.equal(await parser.isBlocked(page), true);
  await page.setContent('<div id="captcha"><button>Solve</button></div>');
  assert.equal(await parser.detectCaptcha(page), true);
  await page.setContent('<iframe srcdoc="<div id=captcha>Challenge</div>"></iframe>');
  await page.frames()[1].waitForSelector('#captcha');
  assert.equal(await parser.detectCaptcha(page), true);
  await page.locator('iframe').evaluate((el) => { el.hidden = true; });
  assert.equal(await parser.detectCaptcha(page), false);
});
