// Credential-free pinned-WASM characterization. Downloads the reviewed runtime
// only; never instantiates a client, provisions a key, signs, or broadcasts.
import assert from 'node:assert/strict';
import { SDK_VERSION, loadWasm, conditionConfigToPoetPolicy } from '@sigbash/sdk';
import { assertCompiledSigbashPolicy } from '../src/sigbash-policy.js';

assert.equal(process.env.VAULT_NETWORK, 'signet');
assert.equal(process.env.NEXT_PUBLIC_VAULT_NETWORK, 'signet');
assert.equal(SDK_VERSION, '0.8.0');
const hash = 'a57fa4c7172fb06dce6133832778247fb22c586d1e2ee70282ff8efa1f0e5b58a81b02dbd1d6b69e474254bc35c6945d';
await loadWasm({ wasmUrl: 'https://www.sigbash.com/sigbash.wasm', expectedHash: hash });
const compiler = (globalThis as Record<string, unknown>).SigbashWASM_CompilePOETPolicy as (input: string) => string;
assert.equal(typeof compiler, 'function');
const requested = conditionConfigToPoetPolicy({ logic: 'AND', conditions: [
  { type: 'OUTPUT_DEST_IS_IN_SETS', selector: { type: 'INDEX', index: 0 }, network: 'signet',
    addresses: ['tb1p00trq2g670hfewvktx9amxc9s7m98lm2arevl5ktxertxesn8g0q52s5ts'] },
  { type: 'OUTPUT_DEST_IS_IN_SETS', selector: { type: 'INDEX', index: 1 }, network: 'signet',
    addresses: ['tb1pehyvtmejh59zjqadqc0c5dz98pqshsxvsy76xgtepf6k2cnmaqhscg7gy8'] },
  { type: 'TX_OUTPUT_COUNT', operator: 'EQ', value: 2 },
] } as never);
const compile = (policy: unknown, seed: string) => {
  const result = JSON.parse(compiler(JSON.stringify({ policy: JSON.stringify(policy), network: 'signet', seed_hex: seed })));
  assert(!result.error, 'pinned compiler rejected the characterization fixture');
  return { policy: JSON.parse(result.compiled_policy_json), root: result.policy_root };
};
// Run identical serialized inputs before any other fixture or SDK operation.
// These public test seeds are not participant credentials. Report intermittent
// root variation without treating an unobserved variation as proof of absence.
const repeatedInput = JSON.stringify({ policy: JSON.stringify(requested), network: 'signet', seed_hex: '99'.repeat(32) });
const repeated = Array.from({ length: 64 }, () => JSON.parse(compiler(repeatedInput)));
assert(repeated.every(result => !result.error && typeof result.policy_root === 'string'));
const rootCounts = new Map<string, number>();
for (const result of repeated) rootCounts.set(result.policy_root, (rootCounts.get(result.policy_root) ?? 0) + 1);
assert(repeated.every(result => result.compiled_policy_json === repeated[0].compiled_policy_json),
  'compiled JSON varied for the exact same input');
const a = compile(requested, '99'.repeat(32)), b = compile(requested, '11'.repeat(32));
assert.deepEqual(a.policy, b.policy);
assert.notEqual(a.root, b.root, 'public-seed comparison must not be treated as a policy-root attestation');
assertCompiledSigbashPolicy(requested, a.policy);
assert.deepEqual(compile(requested, 'ab'.repeat(32)).policy, a.policy);
assert.deepEqual(compile(a.policy, '99'.repeat(32)).policy, a.policy);
const compiledPolicyRootMatchesRaw = compile(a.policy, '99'.repeat(32)).root === a.root;

const preset = structuredClone(requested) as typeof a.policy;
preset.policy.children[0].conditionParams.list_id = 'totally_external_list';
const foreign = compile(preset, '99'.repeat(32));
assert.equal(foreign.policy.policy.children[0].conditionParams.list_id, 'totally_external_list');
assert.throws(() => assertCompiledSigbashPolicy(requested, foreign.policy), /unsupported/u);
const collision = structuredClone(requested) as typeof a.policy;
collision.policy.children[0].conditionParams.list_id = a.policy.policy.children[1].conditionParams.list_id;
const collided = compile(collision, '99'.repeat(32));
assert.equal(collided.policy.policy.children[0].conditionParams.list_id,
  collided.policy.policy.children[1].conditionParams.list_id);
assert.throws(() => assertCompiledSigbashPolicy(requested, collided.policy), /collide/u);
console.log(JSON.stringify({ passed: true, network: 'signet', sdkVersion: SDK_VERSION,
  wasmSha384: hash, credentialsUsed: false, keysCreated: 0, signatures: 0, broadcasts: 0,
  compiledPolicySeedIndependent: true, policyRootSeedIndependent: false,
  compiledPolicyRootMatchesRaw,
  identicalInputCompilations: repeated.length,
  identicalCompiledPolicyJson: true,
  distinctPolicyRoots: rootCounts.size,
  policyRootNondeterminismObserved: rootCounts.size > 1,
  publicFixtureRootCounts: Object.fromEntries(rootCounts),
  compilerPreservesExternalListIds: true, compilerAcceptsDuplicateListIds: true,
  applicationRejectsBoth: true, actualCollisionSigningBehaviorTested: false }, null, 2));
process.exit(0);
