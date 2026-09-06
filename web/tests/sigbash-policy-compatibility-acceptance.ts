import assert from 'node:assert/strict';
import { conditionConfigToPoetPolicy } from '@sigbash/sdk';
import { assertCompiledSigbashPolicy, sigbashConditionConfig } from '../../src/sigbash-policy.js';
import { findMatchingSigbashKey } from '../../src/sigbash-recovery-journal.js';
import { createDemoState } from '../../src/vault.js';
import { BITCOIN_NETWORK_NAME } from '../../src/network.js';

// Real product policy shape with public offline fixture addresses. The IDs here
// test the pure server comparator; exact pinned-WASM output is a separate gate.
const requested = conditionConfigToPoetPolicy(sigbashConditionConfig(
  createDemoState().policies.get('alicebob:alice')!,
) as never);
type TestPolicy = { policy: { children: Array<{ conditionType: string; conditionParams: Record<string, unknown> }> } };
const destinations = (policy: unknown) => (policy as TestPolicy).policy.children
  .filter(node => node.conditionType === 'OUTPUT_DEST_IS_IN_SETS');
const compiled = structuredClone(requested);
destinations(compiled).forEach((node, index) => { node.conditionParams.list_id = `policy_embedded_00${index}`; });
const checks: string[] = [];
assertCompiledSigbashPolicy(requested, requested);
assertCompiledSigbashPolicy(requested, compiled);
checks.push('only compiler-shaped IDs may be added to the exact unchanged inline destination conditions');

for (const badId of ['external-list', 'policy_embedded_12', 'policy_embedded_1234', 'POLICY_EMBEDDED_123', '', 123]) {
  const bad = structuredClone(compiled);
  destinations(bad)[0]!.conditionParams.list_id = badId;
  assert.throws(() => assertCompiledSigbashPolicy(requested, bad));
}
const preset = structuredClone(compiled);
assert.throws(() => assertCompiledSigbashPolicy(preset, preset), /preselect/u);
checks.push('preselected, external, malformed, and non-string list references are rejected');

for (const mutate of [
  (p: TestPolicy) => { destinations(p)[1]!.conditionParams.list_id = 'policy_embedded_000'; },
  (p: TestPolicy) => { delete destinations(p)[0]!.conditionParams.addresses; },
  (p: TestPolicy) => { destinations(p)[0]!.conditionParams.addresses = ['substituted-address']; },
  (p: TestPolicy) => { destinations(p)[0]!.conditionParams.unexpected = true; },
  (p: TestPolicy) => { p.policy.children[0]!.conditionParams.list_id = 'policy_embedded_005'; },
  (p: TestPolicy) => { destinations(p)[0]!.conditionParams.use_descriptor = true; },
  (p: TestPolicy) => { delete destinations(p)[0]!.conditionParams.list_id; },
]) {
  const bad = structuredClone(compiled);
  mutate(bad as TestPolicy);
  assert.throws(() => assertCompiledSigbashPolicy(requested, bad));
}
checks.push('collisions, destination substitutions, missing sets, descriptor references, partial IDs, and other policy changes fail closed');

const sameSetRequested = structuredClone(requested);
destinations(sameSetRequested)[1]!.conditionParams.addresses = structuredClone(destinations(sameSetRequested)[0]!.conditionParams.addresses);
const sameSetCompiled = structuredClone(sameSetRequested);
destinations(sameSetCompiled).forEach(node => { node.conditionParams.list_id = 'policy_embedded_005'; });
assertCompiledSigbashPolicy(sameSetRequested, sameSetCompiled);
destinations(sameSetCompiled)[1]!.conditionParams.list_id = 'policy_embedded_006';
assert.throws(() => assertCompiledSigbashPolicy(sameSetRequested, sameSetCompiled), /collide or disagree/u);
checks.push('identical ordered address sets must share an identifier; distinct sets must not');

const key = { keyId: '2', network: BITCOIN_NETWORK_NAME, policyRoot: '11'.repeat(32),
  require2FA: false, createdAt: null, bip328Xpub: 'synthetic-public-xpub', poetJSON: compiled };
const operatorPolicy = requested as unknown as Parameters<typeof findMatchingSigbashKey>[1];
assert.equal(findMatchingSigbashKey([key], operatorPolicy, BITCOIN_NETWORK_NAME)?.keyIndex, 2);
assert.throws(() => findMatchingSigbashKey([key, { ...key, keyId: '3' }], operatorPolicy, BITCOIN_NETWORK_NAME), /ambiguous/u);
assert.equal(findMatchingSigbashKey([{ ...key, network: 'different-network' }], operatorPolicy, BITCOIN_NETWORK_NAME), null);
checks.push('compiled-policy resume preserves exact-key matching, network rejection, and ambiguity rejection');
console.log(JSON.stringify({ passed: true, network: BITCOIN_NETWORK_NAME, liveProviderCalls: 0, checks }, null, 2));
