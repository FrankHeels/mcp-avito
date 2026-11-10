import { createHash } from 'node:crypto';
import type { ProxyConfig } from './types.js';

/** Distinguish gateway sessions without putting credentials in logs or statistics. */
export function getProxyKey(proxy: ProxyConfig): string {
  const credentials = JSON.stringify([proxy.username ?? null, proxy.password ?? '']);
  const fingerprint = createHash('sha256').update(credentials).digest('hex');
  return `${proxy.type}://${proxy.host}:${proxy.port}#${fingerprint}`;
}
