import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BrowserManager } from '../dist/core/browser.js';
import { AvitoScraper } from '../dist/core/scraper.js';

test('dedicated profile keeps cookies and reopens after closing the window', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'avito-browser-'));
  const browser = new BrowserManager({ headless: true, userDataDir });
  const origin = 'https://example.test';

  try {
    await browser.initialize();
    const page = await browser.getPage();
    assert.equal(await browser.getPage(), page);
    await page.context().addCookies([{
      name: 'test-session',
      value: 'persisted',
      url: origin,
      expires: Math.floor(Date.now() / 1000) + 3600,
    }]);
    await page.context().close();

    assert.equal(browser.isInitialized(), false);
    const reopened = await browser.getPage();
    const cookies = await reopened.context().cookies(origin);
    assert.equal(cookies.find((cookie) => cookie.name === 'test-session')?.value, 'persisted');
  } finally {
    await browser.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('interactive browser reports access errors and stays usable for the next card', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'avito-browser-'));
  const scraper = new AvitoScraper({ headless: true, userDataDir, delayMs: [0, 0], manualCaptchaFallback: false });
  const pages = new Map([
    ['/denied', [403, '<h1>Forbidden</h1>']],
    ['/rate-limited', [429, '<h1>Too many requests</h1>']],
    ['/restricted', [200, '<title>Доступ ограничен: проблема с IP</title>']],
    ['/captcha', [200, '<div id="captcha">Проверка</div>']],
    ['/missing', [404, '<h1>Not found</h1>']],
    ['/item', [200, '<h1>Intel Core i5-12400F</h1>']],
  ]);
  const server = createServer((request, response) => {
    const [status, html] = pages.get(request.url) ?? [404, ''];
    response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  server.listen(0, '127.0.0.1');

  try {
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    for (const [path, code] of [
      ['/denied', 'AVITO_ACCESS_RESTRICTED'],
      ['/rate-limited', 'AVITO_RATE_LIMITED'],
      ['/restricted', 'AVITO_ACCESS_RESTRICTED'],
      ['/missing', 'AVITO_HTTP_ERROR'],
    ]) {
      await assert.rejects(scraper.getItemDetails(origin + path), { code });
    }
    await assert.rejects(scraper.getItemDetails(origin + '/captcha'), { code: 'CAPTCHA_DETECTED' });
    await assert.rejects(scraper.getItemDetails(origin + '/item'), { code: 'CAPTCHA_DETECTED' });
    await scraper.close();

    const item = await scraper.getItemDetails(origin + '/item');
    assert.equal(item.title, 'Intel Core i5-12400F');
    assert.equal(item.availabilityNote, 'уточнить у продавца');
  } finally {
    await scraper.close();
    await new Promise((done) => server.close(done));
    await rm(userDataDir, { recursive: true, force: true });
  }
});
