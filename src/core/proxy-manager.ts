/**
 * Proxy manager for loading and rotating proxies
 */

import { readFile } from 'fs/promises';
import { ProxyError, type ProxyConfig, type ProxyRotationStrategy, type ProxyStats } from './types.js';
import type { IProxyRotationStrategy } from '../plugins/proxy/base.js';
import { SequentialRotation } from '../plugins/proxy/sequential.js';
import { RandomRotation } from '../plugins/proxy/random.js';
import { RoundRobinRotation } from '../plugins/proxy/round-robin.js';
import { getProxyKey } from './proxy-identity.js';

/** Parse a proxy endpoint without ever including credentials in an error. */
export function parseProxyUrl(value: string): ProxyConfig | null {
  try {
    if (!/^(https?|socks[45]):\/\//.test(value) || /\s/.test(value)) return null;
    const url = new URL(value);
    const authority = value.split('://')[1].split('/')[0];
    const portMatch = authority.match(/:(\d+)$/);
    const port = Number(portMatch?.[1]);
    if (!url.hostname || !portMatch || !Number.isInteger(port) || port < 1 || port > 65535 ||
        (url.pathname && url.pathname !== '/') || url.search || url.hash ||
        (url.password && !url.username)) return null;
    return {
      type: url.protocol.slice(0, -1) as ProxyConfig['type'],
      host: url.hostname,
      port,
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.username ? decodeURIComponent(url.password) : undefined,
    };
  } catch {
    return null;
  }
}

export class ProxyManager {
  private strategy: IProxyRotationStrategy;
  private currentProxy: ProxyConfig | null = null;
  private rotationStrategy: ProxyRotationStrategy;
  private rotateEveryN: number;
  private requestCount: number = 0;

  constructor(
    proxies: ProxyConfig[] = [],
    rotationStrategy: ProxyRotationStrategy = 'sequential',
    rotateEveryN: number = 0
  ) {
    this.rotationStrategy = rotationStrategy;
    this.rotateEveryN = rotateEveryN;
    this.strategy = this.createStrategy(rotationStrategy, proxies);
  }

  /**
   * Load proxies from file
   * Format: type://[username:password@]host:port
   * Example: socks5://user:pass@127.0.0.1:1080
   */
  async loadFromFile(filePath: string): Promise<number> {
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      throw new ProxyError('Не удалось прочитать файл прокси. Проверьте PROXY_LIST_FILE и права доступа.');
    }
    const proxies: ProxyConfig[] = [];
    for (const [index, line] of content.split('\n').entries()) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const proxy = parseProxyUrl(trimmed);
      if (!proxy) throw new ProxyError(`Некорректный прокси в строке ${index + 1} файла прокси.`);
      proxies.push(proxy);
    }
    if (!proxies.length) throw new ProxyError('Файл прокси пуст: добавьте хотя бы один прокси.');
    // Commit only after every line has been validated, so retries cannot duplicate the pool.
    proxies.forEach((proxy) => this.strategy.addProxy(proxy));
    console.error(`Загружено ${proxies.length} прокси`);
    return proxies.length;
  }

  /**
   * Get current or next proxy
   */
  getProxy(forceRotate: boolean = false): ProxyConfig | null {
    // Check if rotation needed
    const shouldRotate =
      forceRotate ||
      !this.currentProxy ||
      (this.rotateEveryN > 0 && this.requestCount >= this.rotateEveryN);

    if (shouldRotate) {
      this.currentProxy = this.strategy.next();
      this.requestCount = 0;

      if (this.currentProxy) {
        const proxyStr = this.formatProxyString(this.currentProxy);
        console.error(`Используем прокси: ${proxyStr}`);
      }
    }

    return this.currentProxy;
  }

  /** Count actual navigations, not browser initialization or recovery. */
  recordRequest(): void {
    this.requestCount++;
  }

  /**
   * Mark current proxy as failed and rotate
   */
  markFailed(): void {
    if (this.currentProxy) {
      this.strategy.markFailed(this.currentProxy);
      // Force rotation on next getProxy call
      this.currentProxy = null;
      this.requestCount = 0;
    }
  }

  /**
   * Mark current proxy as successful
   */
  markSuccess(): void {
    if (this.currentProxy) {
      this.strategy.markSuccess(this.currentProxy);
    }
  }

  /**
   * Get statistics
   */
  getStats(): ProxyStats {
    const availableCount = this.strategy.getAvailableCount();

    // Get detailed stats if available (round-robin)
    let successRate: Record<string, number> = {};
    if ('getStats' in this.strategy && typeof this.strategy.getStats === 'function') {
      const detailedStats = (this.strategy as any).getStats();
      successRate = Object.keys(detailedStats).reduce((acc, key) => {
        acc[key] = detailedStats[key].successRate;
        return acc;
      }, {} as Record<string, number>);
    }

    return {
      total: availableCount,
      active: availableCount,
      failed: 0, // Could track this if needed
      successRate,
    };
  }

  /**
   * Reset rotation state
   */
  reset(): void {
    this.strategy.reset();
    this.currentProxy = null;
    this.requestCount = 0;
  }

  /**
   * Change rotation strategy
   */
  setRotationStrategy(strategy: ProxyRotationStrategy, proxies?: ProxyConfig[]): void {
    const currentProxies = proxies || this.getAllProxies();
    this.rotationStrategy = strategy;
    this.strategy = this.createStrategy(strategy, currentProxies);
    this.currentProxy = null;
    this.requestCount = 0;
  }

  /**
   * Get all proxies from current strategy
   */
  private getAllProxies(): ProxyConfig[] {
    // This is a bit hacky, but works for our strategies
    const proxies: ProxyConfig[] = [];
    const tempStrategy = this.strategy;

    // Extract proxies by trying to get next until we cycle through all
    for (let i = 0; i < 1000; i++) {
      // arbitrary limit
      const proxy = tempStrategy.next();
      if (!proxy) break;

      const proxyKey = getProxyKey(proxy);
      if (!proxies.some((p) => getProxyKey(p) === proxyKey)) {
        proxies.push(proxy);
      }

      if (proxies.length > 100) break; // safety limit
    }

    return proxies;
  }

  /**
   * Create rotation strategy instance
   */
  private createStrategy(
    type: ProxyRotationStrategy,
    proxies: ProxyConfig[]
  ): IProxyRotationStrategy {
    switch (type) {
      case 'random':
        return new RandomRotation(proxies);
      case 'round-robin':
        return new RoundRobinRotation(proxies);
      case 'sequential':
      default:
        return new SequentialRotation(proxies);
    }
  }

  /**
   * Format proxy config to string
   */
  private formatProxyString(proxy: ProxyConfig): string {
    return `${proxy.type}://${proxy.host}:${proxy.port}`;
  }
}
