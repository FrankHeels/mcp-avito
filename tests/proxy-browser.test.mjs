import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BrowserManager } from '../dist/core/browser.js';
import { AvitoScraper } from '../dist/core/scraper.js';
import { parseProxyUrl } from '../dist/core/proxy-manager.js';
import { loadMcpOptions } from '../dist/mcp/config.js';

async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    sockets.forEach((socket) => socket.destroy());
    await new Promise((done) => server.close(done));
  });
  return server.address().port;
}

async function profile(t) {
  const root = await mkdtemp(join(tmpdir(), 'avito-proxy-browser-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function httpProxy(t, name, { credentials, fail = false, status = 200, html } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    if (fail) return request.socket.destroy();
    if (credentials && request.headers['proxy-authorization'] !==
      `Basic ${Buffer.from(credentials).toString('base64')}`) {
      response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="test"' });
      return response.end();
    }
    if (!request.url.startsWith('http://proxy-test.invalid/')) {
      response.writeHead(502);
      return response.end();
    }
    requests.push({ url: request.url, auth: request.headers['proxy-authorization'] });
    response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Connection': 'close' });
    response.end(html ?? `<h1>${name}</h1>`);
  });
  // No traffic from these fixtures is ever forwarded to external hosts.
  server.on('connect', (_request, socket) => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
  const port = await listen(t, server);
  return { url: `http://127.0.0.1:${port}`, requests };
}

test('environment HTTP proxy carries browser traffic and authentication after window recovery', async (t) => {
  const root = await profile(t);
  const proxy = await httpProxy(t, 'authenticated', { credentials: 'user@realm:p:@/%' });
  const options = loadMcpOptions({
    PROXY_URL: proxy.url.replace('http://', 'http://user%40realm:p%3A%40%2F%25@'),
    AVITO_PROFILE_DIR: join(root, 'profile'),
  }, root);
  const browser = new BrowserManager({ ...options, headless: true });
  try {
    await browser.initialize(options.proxy.proxies[0]);
    let page = await browser.getPage();
    await page.goto('http://proxy-test.invalid/first');
    assert.equal(await page.locator('h1').innerText(), 'authenticated');
    await page.context().close();
    page = await browser.getPage();
    await page.goto('http://proxy-test.invalid/after-recovery');
    assert.equal(await page.locator('h1').innerText(), 'authenticated');
    assert.ok(proxy.requests.some(({ url }) => url.endsWith('/after-recovery')));
    assert.ok(proxy.requests.every(({ auth }) => auth === `Basic ${Buffer.from('user@realm:p:@/%').toString('base64')}`));
  } finally {
    await browser.close();
  }
});

test('file proxies rotate after N navigations, including browser reopen', async (t) => {
  const root = await profile(t);
  const first = await httpProxy(t, 'first');
  const second = await httpProxy(t, 'second');
  const listFile = join(root, 'proxies.txt');
  await writeFile(listFile, `${first.url}\n${second.url}\n`);
  const options = loadMcpOptions({
    PROXY_LIST_FILE: listFile, PROXY_ROTATE_EVERY_N: '2',
    PROXY_ROTATE_ON_ERROR: 'false', AVITO_PROFILE_DIR: join(root, 'profile'),
  }, root);
  const scraper = new AvitoScraper({ ...options, headless: true, delayMs: [0, 0] });
  try {
    const titles = [];
    titles.push((await scraper.getItemDetails('http://proxy-test.invalid/1')).title);
    await scraper.close();
    titles.push((await scraper.getItemDetails('http://proxy-test.invalid/2')).title);
    titles.push((await scraper.getItemDetails('http://proxy-test.invalid/3')).title);
    titles.push((await scraper.getItemDetails('http://proxy-test.invalid/4')).title);
    titles.push((await scraper.getItemDetails('http://proxy-test.invalid/5')).title);
    assert.deepEqual(titles, ['first', 'first', 'second', 'second', 'first']);
    assert.equal(first.requests.filter(({ url }) => /\/[1-5]$/.test(url)).length, 3);
    assert.equal(second.requests.filter(({ url }) => /\/[1-5]$/.test(url)).length, 2);
  } finally {
    await scraper.close();
  }
});

for (const persistent of [false, true]) {
  test(`same gateway rotates distinct credentials in Chromium (persistent=${persistent})`, async (t) => {
    const root = await profile(t);
    const sessions = ['session-a:password-a', 'session-b:password-b', 'session-b:password-c'];
    const seen = [];
    const server = createServer((req, res) => {
      const header = req.headers['proxy-authorization'];
      const credentials = header?.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString() : '';
      const index = sessions.indexOf(credentials);
      if (index < 0) {
        res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="gateway"' });
        return res.end();
      }
      if (!req.url.startsWith('http://proxy-test.invalid/')) { res.writeHead(502); return res.end(); }
      seen.push(index);
      res.end(`<h1>Session ${index}</h1>`);
    });
    server.on('connect', (_req, socket) => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    const port = await listen(t, server);
    const scraper = new AvitoScraper({
      headless: true, delayMs: [0, 0],
      ...(persistent ? { userDataDir: join(root, 'profile') } : {}),
      proxy: {
        enabled: true, rotation: 'round-robin', rotateEveryN: 1,
        proxies: sessions.map((credentials) => parseProxyUrl(`http://${credentials}@127.0.0.1:${port}`)),
      },
    });
    try {
      const titles = [];
      for (let n = 0; n < 4; n++) titles.push((await scraper.getItemDetails(`http://proxy-test.invalid/${n}`)).title);
      assert.deepEqual(titles, ['Session 0', 'Session 1', 'Session 2', 'Session 0']);
      assert.deepEqual([...new Set(seen)], [0, 1, 2]);
    } finally {
      await scraper.close();
    }
  });
}

test('transport failures rotate on the next call; an exhausted pool never goes direct', async (t) => {
  const root = await profile(t);
  const broken = await httpProxy(t, 'broken', { fail: true });
  const healthy = await httpProxy(t, 'healthy');
  const scraper = new AvitoScraper({
    headless: true, userDataDir: join(root, 'profile'), timeout: 1500, delayMs: [0, 0],
    proxy: {
      enabled: true, rotateOnError: true,
      proxies: [parseProxyUrl(broken.url), parseProxyUrl(healthy.url)],
    },
  });
  try {
    await assert.rejects(scraper.getItemDetails('http://proxy-test.invalid/failed'), { code: 'PROXY_ERROR' });
    const result = await scraper.getItemDetails('http://proxy-test.invalid/retry');
    assert.equal(result.title, 'healthy');
  } finally {
    await scraper.close();
  }

  const exhausted = new AvitoScraper({
    headless: true, timeout: 1500, delayMs: [0, 0],
    proxy: { enabled: true, rotateOnError: true, proxies: [parseProxyUrl(broken.url)] },
  });
  try {
    await assert.rejects(exhausted.getItemDetails('http://proxy-test.invalid/failed'), { code: 'PROXY_ERROR' });
    await assert.rejects(exhausted.getItemDetails('http://proxy-test.invalid/retry'), /Нет доступных прокси/);
    assert.equal(exhausted.isInitialized(), false);
  } finally {
    await exhausted.close();
  }
});

test('disabled error rotation keeps the current proxy after a transport failure', async (t) => {
  const root = await profile(t);
  const broken = await httpProxy(t, 'broken', { fail: true });
  const healthy = await httpProxy(t, 'healthy');
  const scraper = new AvitoScraper({
    headless: true, userDataDir: join(root, 'profile'), timeout: 1000, delayMs: [0, 0],
    proxy: { enabled: true, rotateOnError: false, proxies: [parseProxyUrl(broken.url), parseProxyUrl(healthy.url)] },
  });
  try {
    for (let n = 0; n < 2; n++) {
      await assert.rejects(scraper.getItemDetails('http://proxy-test.invalid/retry'), { code: 'PROXY_ERROR' });
    }
    assert.equal(healthy.requests.length, 0);
  } finally {
    await scraper.close();
  }
});

test('CAPTCHA stays in the same window even when rotation is due', async (t) => {
  const root = await profile(t);
  const blocked = await httpProxy(t, 'captcha', { html: '<div id="captcha">Verification</div>' });
  const next = await httpProxy(t, 'next');
  const scraper = new AvitoScraper({
    headless: true, userDataDir: join(root, 'profile'), delayMs: [0, 0], manualCaptchaFallback: false,
    proxy: { enabled: true, rotateEveryN: 1, rotateOnError: true, proxies: [parseProxyUrl(blocked.url), parseProxyUrl(next.url)] },
  });
  try {
    await assert.rejects(scraper.getItemDetails('http://proxy-test.invalid/captcha'), { code: 'CAPTCHA_DETECTED' });
    await assert.rejects(scraper.getItemDetails('http://proxy-test.invalid/another'), { code: 'CAPTCHA_DETECTED' });
    assert.equal(next.requests.length, 0);
    assert.equal(scraper.isInitialized(), true);
  } finally {
    await scraper.close();
  }
});

test('SOCKS5 bridge authenticates with encoded credentials and survives reopening', async (t) => {
  const root = await profile(t);
  const credentials = [];
  const targets = [];
  const server = createTcpServer((socket) => {
    let buffered = Buffer.alloc(0);
    let stage = 'hello';
    socket.on('data', (data) => {
      buffered = Buffer.concat([buffered, data]);
      while (buffered.length) {
        if (stage === 'hello') {
          if (buffered.length < 2 || buffered.length < 2 + buffered[1]) return;
          buffered = buffered.subarray(2 + buffered[1]);
          socket.write(Buffer.from([5, 2]));
          stage = 'auth';
        } else if (stage === 'auth') {
          if (buffered.length < 2) return;
          const userLength = buffered[1];
          if (buffered.length < 3 + userLength) return;
          const passwordLength = buffered[2 + userLength];
          if (buffered.length < 3 + userLength + passwordLength) return;
          credentials.push([
            buffered.subarray(2, 2 + userLength).toString(),
            buffered.subarray(3 + userLength, 3 + userLength + passwordLength).toString(),
          ]);
          buffered = buffered.subarray(3 + userLength + passwordLength);
          socket.write(Buffer.from([1, 0]));
          stage = 'connect';
        } else if (stage === 'connect') {
          if (buffered.length < 5) return;
          const addressLength = buffered[3] === 3 ? 1 + buffered[4] : buffered[3] === 1 ? 4 : 16;
          const length = 4 + addressLength + 2;
          if (buffered.length < length) return;
          const hostname = buffered[3] === 3 ? buffered.subarray(5, 4 + addressLength).toString() :
            buffered[3] === 1 ? [...buffered.subarray(4, 8)].join('.') : '';
          const port = buffered.readUInt16BE(length - 2);
          targets.push(hostname);
          buffered = buffered.subarray(length);
          if (hostname !== '192.0.2.1' || port !== 80) {
            socket.end(Buffer.from([5, 5, 0, 1, 127, 0, 0, 1, 0, 0]));
            return;
          }
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
          stage = 'http';
        } else {
          if (!buffered.includes('\r\n\r\n')) return;
          const html = '<h1>SOCKS authenticated</h1>';
          socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(html)}\r\nConnection: close\r\n\r\n${html}`);
          return;
        }
      }
    });
  });
  const port = await listen(t, server);
  const options = loadMcpOptions({
    PROXY_URL: `socks5://user%40realm:p%3A%40%2F%25@127.0.0.1:${port}`,
    AVITO_PROFILE_DIR: join(root, 'profile'),
  }, root);
  const browser = new BrowserManager({ ...options, headless: true });
  try {
    await browser.initialize(options.proxy.proxies[0]);
    for (let n = 0; n < 2; n++) {
      const page = await browser.getPage();
      await page.goto(`http://192.0.2.1/socks-${n}`);
      assert.equal(await page.locator('h1').innerText(), 'SOCKS authenticated');
      await page.context().close();
    }
    assert.ok(targets.filter((host) => host === '192.0.2.1').length >= 2);
    assert.ok(credentials.length >= 2);
    assert.ok(credentials.every(([user, password]) => user === 'user@realm' && password === 'p:@/%'));
  } finally {
    await browser.close();
  }
});
