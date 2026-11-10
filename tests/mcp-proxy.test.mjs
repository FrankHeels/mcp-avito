import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const serverPath = fileURLToPath(new URL('../dist/mcp/server.js', import.meta.url));

async function startServer(t, env) {
  const cwd = await mkdtemp(join(tmpdir(), 'avito-mcp-proxy-'));
  const child = spawn(process.execPath, [serverPath], {
    cwd,
    env: {
      ...process.env,
      PROXY_ENABLED: '', PROXY_URL: '', PROXY_LIST_FILE: '',
      PROXY_ROTATION: '', PROXY_ROTATE_ON_ERROR: '', PROXY_ROTATE_EVERY_N: '',
      AVITO_PROFILE_DIR: join(cwd, 'profile'),
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = once(child, 'close');
  const messages = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  t.after(async () => {
    child.kill('SIGTERM');
    await closed;
    await rm(cwd, { recursive: true, force: true });
  });
  let nextId = 0;
  async function request(method, params) {
    const id = ++nextId;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const { value, done } = await messages.next();
    assert.equal(done, false, stderr);
    const response = JSON.parse(value);
    assert.equal(response.id, id);
    return response;
  }
  async function initialize() {
    const response = await request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'proxy-test', version: '1.0.0' },
    });
    assert.ok(response.result.serverInfo);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }
  return {
    request, initialize, closed, stdout: () => stdout, stderr: () => stderr, cwd,
    stop: async () => { child.kill('SIGTERM'); await closed; },
  };
}

test('MCP reports invalid proxy config before connecting, without leaking secrets to stdio', { timeout: 10000 }, async (t) => {
  const server = await startServer(t, { PROXY_ENABLED: 'true', PROXY_URL: 'http://private-user:secret@proxy.test:99999' });
  const [code] = await server.closed;
  assert.equal(code, 1);
  assert.equal(server.stdout(), '');
  assert.match(server.stderr(), /PROXY_URL/);
  assert.doesNotMatch(server.stderr(), /private-user|secret/);
});

test('all three MCP tools use proxy settings and reject a missing file before browser launch', { timeout: 10000 }, async (t) => {
  const server = await startServer(t, { PROXY_ENABLED: 'true', PROXY_LIST_FILE: join(tmpdir(), 'avito-missing-proxies-test', 'proxies.txt') });
  await server.initialize();
  const listing = await server.request('tools/list', {});
  assert.equal(listing.result.tools.length, 3);
  for (const [name, args] of [
    ['avito_search', { query: 'test' }],
    ['avito_get_details', { url: 'https://www.avito.ru/test/123' }],
    ['avito_search_all', { query: 'test', limit: 1 }],
  ]) {
    const response = await server.request('tools/call', { name, arguments: args });
    assert.equal(response.result.isError, true);
    const body = JSON.parse(response.result.content[0].text);
    assert.equal(body.code, 'PROXY_ERROR');
    assert.match(body.error, /PROXY_LIST_FILE/);
  }
  // Every stdout line must remain a JSON-RPC message, including after .env loading.
  for (const line of server.stdout().trim().split('\n')) assert.equal(JSON.parse(line).jsonrpc, '2.0');
});

test('MCP still starts and lists tools with proxy explicitly disabled', { timeout: 10000 }, async (t) => {
  const server = await startServer(t, { PROXY_ENABLED: 'false', PROXY_URL: 'invalid' });
  await server.initialize();
  const response = await server.request('tools/list', {});
  assert.deepEqual(response.result.tools.map(({ name }) => name), ['avito_search', 'avito_get_details', 'avito_search_all']);
});

test('MCP stdio: manual CAPTCHA, browser settings, access errors and persisted verification', {
  timeout: 30000,
  skip: process.platform === 'linux' && !process.env.DISPLAY ? 'Requires a display (use xvfb-run)' : false,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'avito-mcp-interactive-'));
  const probes = [];
  let challenges = 0;
  let verifiedVisits = 0;
  const navigations = [];
  const proxy = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!req.url.startsWith('http://www.avito.ru/audit/')) {
      res.writeHead(502); return res.end();
    }
    const path = new URL(req.url).pathname;
    navigations.push({ path, verified: Boolean(req.headers.cookie?.includes('verified=yes')), method: req.method });
    if (path === '/audit/probe') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => { probes.push(JSON.parse(body)); res.end('ok'); });
      return;
    }
    if (path === '/audit/denied') { res.writeHead(403); return res.end('<h1>Forbidden</h1>'); }
    if (path === '/audit/hidden') return res.end('<h1>Normal item</h1><div id="captcha" hidden>Inactive</div>');
    if (req.headers.cookie?.includes('verified=yes')) {
      verifiedVisits++;
      return res.end('<h1>Verified MCP item</h1>');
    }
    challenges++;
    res.writeHead(403);
    res.end(`
      <title>Доступ ограничен: проблема с IP</title>
      <div id="captcha">Local test challenge</div>
      <script>
        const observer = new MutationObserver(async () => {
          if (!document.querySelector('#__avito_captcha_popup__')) return;
          observer.disconnect();
          await fetch('/audit/probe', {method:'POST', body:JSON.stringify({
            webdriver:navigator.webdriver, ua:navigator.userAgent,
            plugins:Object.prototype.toString.call(navigator.plugins),
            locale:navigator.language, timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,
            viewport:[innerWidth,innerHeight]
          })});
          document.cookie='verified=yes;Max-Age=3600;path=/';
          document.querySelector('#captcha').hidden=true;
        });
        observer.observe(document.body,{childList:true});
      </script>`);
  });
  // This proxy only serves fixtures. It never forwards requests to Avito or other hosts.
  proxy.on('connect', (_req, socket) => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const env = {
    PROXY_ENABLED: 'true', PROXY_URL: `http://127.0.0.1:${proxy.address().port}`,
    AVITO_PROFILE_DIR: join(root, 'profile'),
  };
  const first = await startServer(t, env);
  let second;
  try {
    await first.initialize();
    const request = (server, path) => server.request('tools/call', {
      name: 'avito_get_details', arguments: { url: `http://www.avito.ru/audit/${path}` },
    });
    const solved = await request(first, 'item');
    assert.notEqual(solved.result.isError, true);
    assert.equal(JSON.parse(solved.result.content[0].text).details.title, 'Verified MCP item');
    assert.equal(challenges, 1);
    assert.equal(probes.length, 1, 'The challenge must display a popup before the fixture solves itself');
    assert.deepEqual({ ...probes[0], ua: undefined }, {
      webdriver: false, ua: undefined, plugins: '[object PluginArray]',
      locale: 'ru-RU', timezone: 'Europe/Moscow', viewport: [1920, 1080],
    });
    assert.doesNotMatch(probes[0].ua, /HeadlessChrome|Firefox|Edg\//);
    const denied = await request(first, 'denied');
    assert.equal(denied.result.isError, true);
    assert.equal(JSON.parse(denied.result.content[0].text).code, 'AVITO_ACCESS_RESTRICTED');
    assert.equal(JSON.parse((await request(first, 'hidden')).result.content[0].text).details.title, 'Normal item');

    await first.stop();
    second = await startServer(t, env);
    await second.initialize();
    assert.equal(JSON.parse((await request(second, 'item')).result.content[0].text).details.title, 'Verified MCP item');
    assert.equal(challenges, 1, `Verification cookie must survive a full MCP/browser restart: ${JSON.stringify(navigations)}`);
    assert.ok(verifiedVisits >= 2);
    for (const server of [first, second]) {
      for (const line of server.stdout().trim().split('\n')) assert.equal(JSON.parse(line).jsonrpc, '2.0');
    }
  } finally {
    await first.stop();
    await second?.stop();
    proxy.closeAllConnections();
    await new Promise((done) => proxy.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
