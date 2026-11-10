import { configDotenv } from 'dotenv';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProxyUrl } from '../core/proxy-manager.js';
import { ScraperError, type ProxyOptions, type ScraperOptions } from '../core/types.js';

const defaultProjectRoot = fileURLToPath(new URL('../../', import.meta.url));

function configError(message: string): never {
  throw new ScraperError(message, 'MCP_CONFIG_ERROR');
}

function readBoolean(value: string | undefined, name: string, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return configError(`${name}: ожидается true или false.`);
}

function readProxyOptions(env: NodeJS.ProcessEnv, projectRoot: string): ProxyOptions | undefined {
  const url = env.PROXY_URL?.trim();
  const listFile = env.PROXY_LIST_FILE?.trim();
  const enabled = readBoolean(env.PROXY_ENABLED, 'PROXY_ENABLED', Boolean(url || listFile));
  if (!enabled) return undefined;
  if (!url && !listFile) {
    return configError('Укажите PROXY_URL или PROXY_LIST_FILE при включённом прокси.');
  }

  const rotation = env.PROXY_ROTATION?.trim() || 'sequential';
  if (rotation !== 'sequential' && rotation !== 'random' && rotation !== 'round-robin') {
    return configError('PROXY_ROTATION: ожидается sequential, random или round-robin.');
  }
  const interval = env.PROXY_ROTATE_EVERY_N?.trim() || '0';
  const rotateEveryN = Number(interval);
  if (!/^\d+$/.test(interval) || !Number.isSafeInteger(rotateEveryN)) {
    return configError('PROXY_ROTATE_EVERY_N: ожидается целое число >= 0.');
  }

  const proxy = url ? parseProxyUrl(url) : undefined;
  if (url && !proxy) {
    return configError('PROXY_URL: ожидается http(s)://[user:password@]host:port или socks4/5://[user:password@]host:port.');
  }
  return {
    enabled: true,
    // A URL supplied by the MCP client takes precedence over a file from .env.
    proxies: proxy ? [proxy] : undefined,
    listFile: proxy ? undefined : resolve(projectRoot, listFile!),
    rotation,
    rotateOnError: readBoolean(env.PROXY_ROTATE_ON_ERROR, 'PROXY_ROTATE_ON_ERROR', true),
    rotateEveryN,
  };
}

/** Load the project .env regardless of the MCP client's working directory. */
export function loadMcpOptions(
  env: NodeJS.ProcessEnv = process.env,
  projectRoot: string = defaultProjectRoot,
): ScraperOptions {
  const fileEnv: Record<string, string> = {};
  const result = configDotenv({
    path: resolve(projectRoot, '.env'),
    processEnv: fileEnv,
    override: false,
    quiet: true,
    debug: false,
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code !== 'ENOENT') {
    return configError('Не удалось прочитать .env MCP-сервера.');
  }
  for (const [name, value] of Object.entries(fileEnv)) {
    if (env[name] === undefined) env[name] = value;
  }

  return {
    headless: false,
    // MCP awaits close() on shutdown. Playwright's own signal handler would
    // close Chromium a second time, forcing termination before cookies flush.
    handleBrowserSignals: false,
    userDataDir: resolve(env.AVITO_PROFILE_DIR || join(homedir(), '.avito-scraper', 'mcp-profile')),
    proxy: readProxyOptions(env, projectRoot),
  };
}
