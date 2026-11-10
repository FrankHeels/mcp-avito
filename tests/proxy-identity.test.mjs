import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProxyManager } from '../dist/core/proxy-manager.js';
import { SequentialRotation } from '../dist/plugins/proxy/sequential.js';
import { RandomRotation } from '../dist/plugins/proxy/random.js';
import { RoundRobinRotation } from '../dist/plugins/proxy/round-robin.js';

const pool = [
  { type: 'http', host: 'gateway.test', port: 8080, username: 'session-a', password: 'secret-a' },
  { type: 'http', host: 'gateway.test', port: 8080, username: 'session-b', password: 'secret-b' },
  { type: 'http', host: 'gateway.test', port: 8080, username: 'session-b', password: 'different-secret' },
];

for (const Strategy of [SequentialRotation, RandomRotation, RoundRobinRotation]) {
  test(`${Strategy.name}: credentials distinguish sessions at the same endpoint`, () => {
    const strategy = new Strategy([...pool], 1);
    assert.equal(strategy.getAvailableCount(), 3);
    const first = strategy.next();
    strategy.markFailed(first);
    assert.equal(strategy.getAvailableCount(), 2);
    for (let n = 0; n < 10; n++) {
      const next = strategy.next();
      assert.ok(next);
      assert.notEqual(next, first);
    }
    strategy.markSuccess(first);
    assert.equal(strategy.getAvailableCount(), 3);
    strategy.removeProxy(first);
    assert.equal(strategy.getAvailableCount(), 2);
    if ('getStats' in strategy) {
      assert.doesNotMatch(JSON.stringify(strategy.getStats()), /session-a|session-b|secret/);
    }
  });
}

test('changing strategy preserves all authenticated sessions', () => {
  const manager = new ProxyManager([...pool], 'sequential', 1);
  manager.setRotationStrategy('round-robin');
  assert.equal(manager.getStats().active, 3);
  const selected = new Set();
  for (let n = 0; n < 3; n++) { selected.add(manager.getProxy()); manager.recordRequest(); }
  assert.equal(selected.size, 3);
});
