/**
 * Random proxy rotation strategy
 * Selects a random proxy from available pool
 */

import type { ProxyConfig } from '../../core/types.js';
import type { IProxyRotationStrategy } from './base.js';
import { getProxyKey } from '../../core/proxy-identity.js';

export class RandomRotation implements IProxyRotationStrategy {
  private proxies: ProxyConfig[] = [];
  private failedProxies: Set<string> = new Set();

  constructor(proxies: ProxyConfig[] = []) {
    this.proxies = proxies;
  }

  next(): ProxyConfig | null {
    const available = this.getAvailableProxies();

    if (available.length === 0) {
      return null;
    }

    // Select random proxy
    const randomIndex = Math.floor(Math.random() * available.length);
    return available[randomIndex];
  }

  markFailed(proxy: ProxyConfig): void {
    const key = getProxyKey(proxy);
    this.failedProxies.add(key);
    console.error(`Прокси помечен как нерабочий: ${key}`);
  }

  markSuccess(proxy: ProxyConfig): void {
    const key = getProxyKey(proxy);
    this.failedProxies.delete(key);
  }

  reset(): void {
    this.failedProxies.clear();
  }

  getAvailableCount(): number {
    return this.getAvailableProxies().length;
  }

  addProxy(proxy: ProxyConfig): void {
    this.proxies.push(proxy);
  }

  removeProxy(proxy: ProxyConfig): void {
    const key = getProxyKey(proxy);
    this.proxies = this.proxies.filter((p) => getProxyKey(p) !== key);
  }

  private getAvailableProxies(): ProxyConfig[] {
    return this.proxies.filter((p) => !this.failedProxies.has(getProxyKey(p)));
  }

}
