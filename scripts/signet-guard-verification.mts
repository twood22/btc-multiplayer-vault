// Read-only live validation against the existing protected Signet ceremony.
// Exports/reopens kits only in memory; never creates keys, signs, or broadcasts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertProtectedRegularFile, loadProtectedEnvironmentFile, writeProtectedFile } from '../src/operator-environment.js';

assert.equal(process.env.VAULT_NETWORK, 'signet');
assert.equal(process.env.NEXT_PUBLIC_VAULT_NETWORK, 'signet');
const directory = resolve(process.argv[2] || '');
assert(directory.startsWith(`${resolve('live-run/signet')}/guard-verification-`));
for (const name of Object.keys(process.env)) {
  if (name.startsWith('SIGBASH_') || name === 'VAULT_DEMO_SEED') delete process.env[name];
}
loadProtectedEnvironmentFile('live-run/signet/tiny-participants.env', { required: true });
loadProtectedEnvironmentFile('live-run/signet/tiny-setup.env', { required: true });
assert.equal(process.env.VAULT_NETWORK, 'signet');
assert.equal(process.env.NEXT_PUBLIC_VAULT_NETWORK, 'signet');
assert.equal(process.env.SIGBASH_SERVER_URL, 'https://www.sigbash.com');
const emit = (value: object) => process.stdout.write(`${JSON.stringify(value)}\n`);
for (const name of ['log', 'warn', 'error', 'debug', 'info'] as const) console[name] = () => {};
const secrets = Object.entries(process.env).filter(([name]) =>
  /SIGBASH_(?:API_KEY|USER_KEY|SECRET_KEY)|VAULT_DEMO_SEED/u.test(name)).map(([, value]) => value!).filter(Boolean);
function safeError(error: unknown): string {
  let message = error instanceof Error ? error.message : 'non-Error failure';
  for (const value of secrets) message = message.split(value).join('[redacted]');
  return message.replace(/\b[0-9a-f]{64}\b/giu, '[32-byte value]')
    .replace(/[A-Za-z0-9+/=_-]{80,}/gu, '[long value]').slice(0, 900);
}
function differencePaths(expected: unknown, actual: unknown, path = '$'): string[] {
  if (isDeepStrictEqual(expected, actual)) return [];
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    const a = expected as Record<string, unknown>, b = actual as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .flatMap(name => differencePaths(a[name], b[name], `${path}.${name}`));
  }
  const shape = (value: unknown) => value === null ? 'null' : typeof value === 'string'
    ? `string(${value.length})` : typeof value === 'number' ? `number(${value})` : typeof value;
  return [`${path}: ${shape(expected)} != ${shape(actual)}`];
}
type Registration = { participantId: string; round: string; keyId: string; keyIndex: number;
  policyRoot: string; bip328Xpub: string };
const checkpointPath = 'live-run/signet/tiny-participants-setup-checkpoint.jsonl';
assertProtectedRegularFile(checkpointPath, 'Signet checkpoint');
const registrations = readFileSync(checkpointPath, 'utf8').trim().split('\n')
  .map(line => JSON.parse(line) as Registration);
assert.equal(registrations.length, 9);
const saved = JSON.parse(readFileSync('live-run/signet/evidence/2026-08-31-sigbash-signing-failure/solo-psbts.json', 'utf8'));
assert.equal(saved.network, 'signet');
const checks: object[] = [];
const failures: object[] = [];
const timeout = setTimeout(() => { emit({ status: 'timeout', network: 'signet' }); process.exit(124); }, 600_000);
try {
  const sdk = await import('@sigbash/sdk');
  const { createGuardedSigbashClient, assertSigbashKeyBinding } = await import('../src/sigbash-client-guard.js');
  const { withSigbashHexProofTransport, toPoetPolicy } = await import('../src/sigbash.js');
  const { createDemoState, sigbashRoundKey } = await import('../src/vault.js');
  const state = createDemoState({ sigbashLeafOverrides: JSON.parse(process.env.SIGBASH_LEAF_KEYS_JSON!),
    economics: saved.economics });
  await sdk.loadWasm({ wasmUrl: process.env.SIGBASH_WASM_URL!, expectedHash: process.env.SIGBASH_WASM_SHA384! });
  for (const participantId of ['alice', 'bob', 'carol']) {
    const options = { serverUrl: 'https://www.sigbash.com', privateLogs: true,
      apiKey: process.env[`SIGBASH_API_KEY_${participantId.toUpperCase()}`]!,
      userKey: process.env[`SIGBASH_USER_KEY_${participantId.toUpperCase()}`]!,
      userSecretKey: process.env[`SIGBASH_SECRET_KEY_${participantId.toUpperCase()}`]! };
    const roster = registrations.filter(item => item.participantId === participantId);
    const client = createGuardedSigbashClient(sdk, options, withSigbashHexProofTransport);
    try {
      const listed = await client.listKeys();
      assert.equal(listed.length, 3);
      assert.equal(new Set(listed.map(item => item.bip328Xpub)).size, 3);
      for (const entry of roster) {
        const actual = listed.find(item => item.keyId === entry.keyId);
        assert(actual && actual.network === 'signet' && actual.bip328Xpub === entry.bip328Xpub &&
          actual.policyRoot === entry.policyRoot, 'enumerated key differs from protected checkpoint');
      }
      const result = { participantId, stage: 'independent-three-key-enumeration', passed: true };
      checks.push(result); emit(result);
    } finally { client.dispose(); }
    for (const entry of roster) {
      const participant = state.participants.find(item => item.id === participantId)!;
      const share = Buffer.from(sigbashRoundKey(participant, entry.round).privateKeyHex, 'hex');
      const roundClient = createGuardedSigbashClient(sdk, { ...options, musig2PrivateKey: share }, withSigbashHexProofTransport);
      share.fill(0);
      try {
        const key = await roundClient.getKey(entry.keyId, { keyIndex: entry.keyIndex, verbose: true });
        const policy = state.policies.get(`${entry.round}:${participantId}`)!;
        assert(policy);
        const expectedPolicy = toPoetPolicy(sdk, policy);
        const kmc = JSON.parse(key.kmcJSON);
        const actualPolicy = typeof kmc.poet_policy_json === 'string' ? JSON.parse(kmc.poet_policy_json) : kmc.poet_policy_json;
        await roundClient.assertCompiledPolicy(expectedPolicy, actualPolicy);
        emit({ participantId, round: entry.round, stage: 'binding-comparison',
          id: key.keyId === entry.keyId, index: key.keyIndex === entry.keyIndex,
          root: key.policyRoot === entry.policyRoot, xpub: kmc.bip328_xpub === entry.bip328Xpub,
          rawPolicyEqualsCompiled: isDeepStrictEqual(actualPolicy, expectedPolicy),
          policyDifferences: differencePaths(expectedPolicy, actualPolicy).slice(0, 16),
          locallyCompiledPolicyMatches: true });
        assertSigbashKeyBinding(key, { ...entry, network: 'signet', poetJSON: actualPolicy });
        // This includes a separately fetched recovery-envelope round-trip,
        // checked against the expected round's public material AND BYO share.
        await roundClient.exportRecoveryKit(entry.keyId, { keyIndex: entry.keyIndex });
        const result = { participantId, round: entry.round, keyIndex: entry.keyIndex,
          stage: 'checkpoint-byo-policy-and-current-envelope-recovery', passed: true };
        checks.push(result); emit(result);
        if (participantId === saved.leaverId && entry.round === saved.round) {
          const valid = await roundClient.verifyPSBT({ psbtBase64: saved.psbts.valid.psbtBase64,
            kmcJSON: key.kmcJSON, network: 'signet' });
          assert.equal(valid.passed, true);
          for (const psbt of Object.values(saved.psbts.tampered) as Array<{ psbtBase64: string }>) {
            const invalid = await roundClient.verifyPSBT({ psbtBase64: psbt.psbtBase64,
              kmcJSON: key.kmcJSON, network: 'signet' });
            assert.equal(invalid.passed, false);
          }
          checks.push({ stage: 'guarded-local-wasm-verification', validAccepted: true, hostileCasesRejected: 3 });
        }
      } catch (error) {
        const failure = { participantId, round: entry.round, keyIndex: entry.keyIndex, error: safeError(error) };
        failures.push(failure); emit(failure);
      } finally { roundClient.dispose(); }
    }
  }
} catch (error) { failures.push({ error: safeError(error) }); }
finally {
  clearTimeout(timeout);
  const result = { createdAt: new Date().toISOString(), network: 'signet', sdkVersion: '0.8.0',
    passed: failures.length === 0, keysCreated: 0, signaturesAttempted: 0, broadcastsAttempted: 0,
    recoverySnapshotFallbackTested: false, checks, failures };
  writeProtectedFile(`${directory}/summary.json`, JSON.stringify(result, null, 2));
  emit(result);
  process.exit(failures.length ? 1 : 0);
}
