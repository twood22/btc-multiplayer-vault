import assert from 'node:assert/strict';
import { decideConfirmationReconciliation } from '../../src/chain-reorganization.js';

const stored = { blockHash: '11'.repeat(32), height: 900_000 };
const stableStatus = {
  hash: stored.blockHash,
  height: stored.height,
  confirmations: 3,
  inBestChain: true,
};
const replacement = { blockHash: '22'.repeat(32), height: 900_001 };
const checks: Array<{ name: string; ok: true }> = [];

assert.deepEqual(decideConfirmationReconciliation({
  stored,
  status: stableStatus,
  replacement: null,
  requiredConfirmations: 3,
}), { action: 'stable' });
checks.push({ name: 'an active block at the required depth leaves product state stable', ok: true });

assert.deepEqual(decideConfirmationReconciliation({
  stored,
  status: { ...stableStatus, confirmations: -1, inBestChain: false },
  replacement,
  requiredConfirmations: 3,
}), { action: 'reanchor', replacement });
checks.push({ name: 'the exact transaction re-included deeply enough moves to its replacement block', ok: true });

assert.deepEqual(decideConfirmationReconciliation({
  stored,
  status: { ...stableStatus, confirmations: -1, inBestChain: false },
  replacement: null,
  requiredConfirmations: 3,
}), { action: 'rollback' });
assert.deepEqual(decideConfirmationReconciliation({
  stored,
  status: { ...stableStatus, confirmations: 2 },
  replacement: null,
  requiredConfirmations: 3,
}), { action: 'rollback' });
checks.push({ name: 'an orphaned or insufficiently deep anchor requires rollback', ok: true });

for (const status of [
  null,
  { ...stableStatus, hash: '33'.repeat(32) },
  { ...stableStatus, height: stored.height + 1 },
  { ...stableStatus, confirmations: 0 },
] as unknown[]) {
  assert.throws(() => decideConfirmationReconciliation({
    stored,
    status: status as typeof stableStatus,
    replacement: null,
    requiredConfirmations: 3,
  }), /missing or inconsistent/u);
}
assert.throws(() => decideConfirmationReconciliation({
  stored,
  status: { ...stableStatus, confirmations: -1, inBestChain: false },
  replacement: stored,
  requiredConfirmations: 3,
}), /both the removed and replacement/u);
checks.push({ name: 'missing or contradictory backend evidence fails without a rollback decision', ok: true });

console.log(JSON.stringify({ passed: true, checks }, null, 2));
