/** Web Locks contract injection only, not a real browser or physical passkey test. */
import assert from 'node:assert/strict';
import { BITCOIN_NETWORK_NAME } from '../../src/network.js';
import { createPresignedFixture } from '../../src/presigned/fixtures.js';
import { presignedLocalBinding, withPresignedLocalCeremonyLock } from '../lib/client/presigned-local-ceremony.js';

const { roster } = createPresignedFixture({ network: BITCOIN_NETWORK_NAME });
const binding = presignedLocalBinding(roster.vaultId, roster.participants[0]!);
const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const held = new Set<string>();
const setNavigator = (value: unknown) => Object.defineProperty(globalThis, 'navigator', { value, configurable: true });
try {
  setNavigator({ locks: { request: async (name: string, options: { mode: string; ifAvailable: boolean }, action: (lock: unknown) => unknown) => {
    assert.equal(options.mode, 'exclusive'); assert.equal(options.ifAvailable, true);
    assert(name.startsWith('presigned-local-v2:'));
    if (held.has(name)) return action(null);
    held.add(name);
    try { return await action({ name }); } finally { held.delete(name); }
  } } });
  let release!: () => void;
  const interrupted = new Promise<void>(resolve => { release = resolve; });
  let actions = 0;
  const first = withPresignedLocalCeremonyLock(binding, async () => { actions += 1; await interrupted; });
  assert.equal(actions, 1);
  await assert.rejects(withPresignedLocalCeremonyLock(binding, async () => { actions += 1; }), /another tab/u);
  assert.equal(actions, 1);
  release(); await first;
  await withPresignedLocalCeremonyLock(binding, async () => { actions += 1; });
  assert.equal(actions, 2);
  await assert.rejects(withPresignedLocalCeremonyLock(binding, async () => { throw new Error('fixture interrupted action'); }), /interrupted action/u);
  assert.equal(held.size, 0);
  setNavigator({});
  await assert.rejects(withPresignedLocalCeremonyLock(binding, async () => { actions += 1; }), /needs Web Locks/u);
  assert.equal(actions, 2);
  console.log(JSON.stringify({ title: 'Presigned local cross-tab lock contract', network: roster.network, passed: true,
    concurrentActionRejected: true, interruptedActionReleasesLock: true, unsupportedBrowserFailsClosed: true,
    realBrowserEvidence: false, networkContacted: false }, null, 2));
} finally {
  if (original) Object.defineProperty(globalThis, 'navigator', original);
  else Reflect.deleteProperty(globalThis, 'navigator');
}
