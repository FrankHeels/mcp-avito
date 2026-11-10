import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadMcpOptions } from '../dist/mcp/config.js';
import { ProxyManager, parseProxyUrl } from '../dist/core/proxy-manager.js';
import { AvitoScraper } from '../dist/core/scraper.js';

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), 'avito-proxy-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('MCP proxy is optional and false explicitly disables configured sources', async (t) => {
  const root = await project(t);
  assert.equal(loadMcpOptions({}, root).proxy, undefined);
  assert.equal(loadMcpOptions({
    PROXY_ENABLED: ' FALSE ', PROXY_URL: 'invalid', PROXY_ROTATION: 'invalid',
  }, root).proxy, undefined);
});

test('project .env loads independently of cwd; environment wins and URL overrides file', async (t) => {
  const root = await project(t);
  await writeFile(join(root, '.env'), [
    'PROXY_ENABLED=true', 'PROXY_LIST_FILE=./config/proxies.txt',
    'PROXY_ROTATION=random', 'PROXY_ROTATE_EVERY_N=10',
    'PROXY_ROTATE_ON_ERROR=true',
  ].join('\n'));
  const fromFile = loadMcpOptions({}, root);
  assert.equal(fromFile.proxy.listFile, join(root, 'config/proxies.txt'));
  assert.equal(fromFile.proxy.rotation, 'random');
  assert.equal(fromFile.proxy.rotateEveryN, 10);
  assert.equal(fromFile.headless, false);
  const env = {
    PROXY_URL: 'http://client:password@proxy.test:80',
    PROXY_ROTATION: 'round-robin', PROXY_ROTATE_ON_ERROR: 'false',
    PROXY_ROTATE_EVERY_N: '0',
  };
  const options = loadMcpOptions(env, root).proxy;
  assert.equal(options.listFile, undefined);
  assert.equal(options.proxies[0].host, 'proxy.test');
  assert.equal(options.proxies[0].port, 80);
  assert.equal(options.rotation, 'round-robin');
  assert.equal(options.rotateOnError, false);
  assert.equal(options.rotateEveryN, 0);
  assert.equal(loadMcpOptions({ PROXY_ENABLED: 'false' }, root).proxy, undefined);
});

test('source alone enables proxy with defaults; missing .env is optional', async (t) => {
  const root = await project(t);
  const options = loadMcpOptions({ PROXY_URL: 'socks5://proxy.test:1080' }, root).proxy;
  assert.equal(options.enabled, true);
  assert.equal(options.rotation, 'sequential');
  assert.equal(options.rotateOnError, true);
  assert.equal(options.rotateEveryN, 0);
  assert.equal(loadMcpOptions({ PROXY_LIST_FILE: '/tmp/proxies.txt' }, root).proxy.listFile, '/tmp/proxies.txt');
});

test('invalid environment settings fail with safe, actionable errors', async (t) => {
  const root = await project(t);
  const cases = [
    [{ PROXY_ENABLED: 'yes' }, 'PROXY_ENABLED'],
    [{ PROXY_ENABLED: 'true', PROXY_LIST_FILE: '' }, 'PROXY_URL'],
    [{ PROXY_URL: 'http://private-user:secret@proxy.test:0' }, 'PROXY_URL'],
    [{ PROXY_ROTATION: 'private-user:secret' }, 'PROXY_ROTATION'],
    [{ PROXY_ROTATE_ON_ERROR: 'private-user:secret' }, 'PROXY_ROTATE_ON_ERROR'],
    ...['-1', '1.5', 'NaN', 'Infinity', '2garbage', '9007199254740992'].map(
      (value) => [{ PROXY_ROTATE_EVERY_N: value }, 'PROXY_ROTATE_EVERY_N'],
    ),
  ];
  for (const [env, field] of cases) {
    assert.throws(() => loadMcpOptions({ PROXY_LIST_FILE: 'proxies.txt', ...env }, root), (error) => {
      assert.equal(error.code, 'MCP_CONFIG_ERROR');
      assert.ok(error.message.includes(field));
      assert.doesNotMatch(error.stack, /private-user|secret/);
      return true;
    });
  }
  await mkdir(join(root, '.env'));
  assert.throws(() => loadMcpOptions({}, root), { code: 'MCP_CONFIG_ERROR' });
});

test('proxy URLs support all protocols, IPv6 and percent-encoded credentials', () => {
  for (const type of ['http', 'https', 'socks4', 'socks5']) {
    assert.deepEqual(parseProxyUrl(`${type}://user%40realm:p%3A%40%2F%25@[::1]:1080`), {
      type, host: '[::1]', port: 1080, username: 'user@realm', password: 'p:@/%',
    });
  }
  assert.equal(parseProxyUrl('https://proxy.test:443').port, 443);
  assert.equal(parseProxyUrl('http://user@proxy.test:8080').password, '');
  for (const url of [
    'proxy.test:8080', 'ftp://proxy.test:21', 'http://proxy.test',
    'http://proxy.test:0', 'http://proxy.test:65536', 'http://proxy.test:1.5',
    'http://proxy.test:80/path', 'http://proxy.test:80/?q=1', 'http://proxy.test:80/#hash',
    'http://bad host:80', 'http://user:%zz@proxy.test:80', 'http://:secret@proxy.test:80',
  ]) assert.equal(parseProxyUrl(url), null, url);
});

test('bad or empty proxy files never permit a direct browser connection', async (t) => {
  const root = await project(t);
  const listFile = join(root, 'proxies.txt');
  for (const content of [null, '', '# comments only\n', 'http://private-user:secret@proxy.test:99999']) {
    if (content !== null) await writeFile(listFile, content);
    const scraper = new AvitoScraper({ proxy: { enabled: true, listFile } });
    try {
      await assert.rejects(scraper.initialize(), (error) => {
        assert.equal(error.code, 'PROXY_ERROR');
        assert.doesNotMatch(error.stack, /private-user|secret/);
        return true;
      });
      assert.equal(scraper.isInitialized(), false);
    } finally {
      await scraper.close();
    }
  }
  const emptyPool = new AvitoScraper({ proxy: { enabled: true } });
  await assert.rejects(emptyPool.initialize(), { code: 'PROXY_ERROR' });
  assert.equal(emptyPool.isInitialized(), false);
});

test('file loading is atomic, skips comments and decodes credentials', async (t) => {
  const root = await project(t);
  const listFile = join(root, 'proxies.txt');
  const manager = new ProxyManager();
  await writeFile(listFile, 'http://first.test:80\ninvalid\n');
  await assert.rejects(manager.loadFromFile(listFile), /строке 2/);
  assert.equal(manager.getProxy(), null);
  await writeFile(listFile, '# example\r\n\r\n socks5://user:p%40ss@proxy.test:1080 \r\n');
  assert.equal(await manager.loadFromFile(listFile), 1);
  assert.equal(manager.getProxy().password, 'p@ss');
});
