// Explicitly authorized live Signet diagnostic. Never broadcasts and never
// loads a mainnet environment. SDK logs are allowlisted to avoid secret output.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadProtectedEnvironmentFile, writeProtectedFile } from '../src/operator-environment.js';

assert.equal(process.env.VAULT_NETWORK, 'signet');
assert.equal(process.env.NEXT_PUBLIC_VAULT_NETWORK, 'signet');
const transport = process.argv[2];
assert(transport === 'native' || transport === 'hex');
const directory = resolve(process.argv[3] || '');
assert(directory.startsWith(resolve('live-run/signet/live-diagnostic-') ));
const runLabel = process.argv[4] || transport;
assert(/^[a-z0-9-]+$/u.test(runLabel));
const fixture = process.argv[5] || 'saved';
assert(fixture === 'saved' || fixture === 'pair');
const emit = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
for (const name of Object.keys(process.env)) {
  if (name.startsWith('SIGBASH_') || name === 'VAULT_DEMO_SEED') delete process.env[name];
}
loadProtectedEnvironmentFile('live-run/signet/tiny-participants.env', { required: true });
loadProtectedEnvironmentFile('live-run/signet/tiny-setup.env', { required: true });
assert.equal(process.env.SIGBASH_SERVER_URL, 'https://www.sigbash.com');
const source = JSON.parse(readFileSync('live-run/signet/evidence/2026-08-31-sigbash-signing-failure/solo-psbts.json', 'utf8'));
assert.equal(source.network, 'signet');
assert.equal(source.leaverId, 'alice');
assert.equal(source.round, 'alicebobcarol');
if (fixture === 'pair') {
  source.round = 'bobcarol';
  source.leaverId = 'bob';
  source.outpoint = `${randomBytes(32).toString('hex')}:0`;
  source.inputValueSats = 20_200;
}
const keyId = process.env[`SIGBASH_KEY_ID_${source.leaverId.toUpperCase()}_${source.round.toUpperCase()}`]!;
assert(keyId);
const registrations = readFileSync('live-run/signet/tiny-participants-setup-checkpoint.jsonl', 'utf8')
  .trim().split('\n').map(line => JSON.parse(line));
const registration = registrations.find(item => item.participantId === source.leaverId && item.round === source.round);
assert(registration && registration.keyId === keyId, 'Signet checkpoint does not match the configured round key');
assert(Number.isSafeInteger(registration.keyIndex) && registration.keyIndex >= 0);
const secretValues = Object.entries(process.env)
  .filter(([name]) => /SIGBASH_(?:API_KEY|USER_KEY|SECRET_KEY)|VAULT_DEMO_SEED/u.test(name))
  .map(([, value]) => value!).filter(Boolean);
function safeError(error: unknown): string {
  let message = error instanceof Error ? error.message : 'non-Error diagnostic failure';
  for (const value of secretValues) message = message.split(value).join('[secret redacted]');
  return message
    .replace(/\b[0-9a-f]{64}\b/giu, '[32-byte value redacted]')
    .replace(/[A-Za-z0-9+/=_-]{80,}/gu, '[long value redacted]').slice(0, 1600);
}
type NullifierStatus = { inputIndex: number; available: boolean; message?: string };
const stagePatterns: Array<[RegExp, string]> = [
  [/Policy satisfied/u, 'local-policy-satisfied'],
  [/request_server_nonces/u, 'server-nonce-request'],
  [/compute_server_ub/u, 'server-ub-request'],
  [/witness prep complete/u, 'proof-witness-prepared'],
  [/blind_signing_request/u, 'blind-signing-request'],
  [/\[sigbash-compat\] rewrote/u, 'proof-hex-wrapper-applied'],
  [/companion header fetch failed/u, 'circuit-header-fallback'],
];
const stages = new Set<string>();
let suppressedLogs = 0;
for (const name of ['log', 'warn', 'error', 'debug', 'info'] as const) {
  console[name] = (...args: unknown[]) => {
    suppressedLogs += 1;
    const message = args.filter(item => typeof item === 'string').join(' ');
    for (const [pattern, stage] of stagePatterns) {
      if (pattern.test(message) && !stages.has(stage)) {
        stages.add(stage);
        emit({ stage });
      }
    }
  };
}
let client: import('@sigbash/sdk').SigbashClient | undefined;
const summary: Record<string, unknown> = {
  network: 'signet', transport, source: fixture === 'saved' ? 'saved-2026-08-31-vault-psbt' : 'fresh-unfunded-second-round-vault-psbt',
  broadcastAttempted: false, sourceOutpointPreviouslySpent: fixture === 'saved',
  intentionallyUnfunded: fixture === 'pair',
};
const timeout = setTimeout(() => {
  emit({ status: 'timeout', transport });
  process.exit(124);
}, 180_000);
try {
  const sdk = await import('@sigbash/sdk');
  const compatibility = await import('../src/sigbash.js');
  assert.equal(sdk.SDK_VERSION, '0.8.0');
  summary.sdkVersion = sdk.SDK_VERSION;
  summary.wasmSha384 = process.env.SIGBASH_WASM_SHA384;
  emit({ stage: 'load-pinned-runtime', transport });
  await sdk.loadWasm({
    wasmUrl: process.env.SIGBASH_WASM_URL!,
    expectedHash: process.env.SIGBASH_WASM_SHA384!,
  });
  client = new sdk.SigbashClient({
    serverUrl: 'https://www.sigbash.com',
    apiKey: process.env[`SIGBASH_API_KEY_${source.leaverId.toUpperCase()}`]!,
    userKey: process.env[`SIGBASH_USER_KEY_${source.leaverId.toUpperCase()}`]!,
    userSecretKey: process.env[`SIGBASH_SECRET_KEY_${source.leaverId.toUpperCase()}`]!,
    privateLogs: true,
  });
  // Do not call SDK 0.8.0 listKeys() on the signing client: it concurrently
  // retrieves KMCs over a response-event socket without request correlation.
  // Bind this fresh client directly to one independently checkpointed key.
  // Key IDs alone do not select the SDK credential's key-index slot. Never
  // silently fall back to slot zero for a later vault round.
  const fetched = await client.getKey(keyId, { verbose: true, keyIndex: registration.keyIndex });
  assert('kmcJSON' in fetched);
  const { kmcJSON } = fetched;
  const kmc = JSON.parse(kmcJSON);
  summary.requestedKeyIndex = registration.keyIndex;
  summary.returnedKeyIndex = fetched.keyIndex;
  summary.returnedKmcMatchesCheckpoint = kmc.bip328_xpub === registration.bip328Xpub;
  summary.returnedKmcMatchingRounds = registrations
    .filter(item => item.bip328Xpub === kmc.bip328_xpub)
    .map(item => `${item.participantId}:${item.round}`);
  summary.returnedPolicyRootMatchesCheckpoint = fetched.policyRoot === registration.policyRoot;
  assert.equal(fetched.network, 'signet');
  summary.keyNetworkConfirmed = true;
  assert.equal(fetched.keyIndex, registration.keyIndex);
  assert.equal(kmc.bip328_xpub, registration.bip328Xpub, 'retrieved KMC belongs to a different round key');
  assert.equal(fetched.policyRoot, registration.policyRoot, 'retrieved policy root differs from the checkpoint');
  summary.keyIndex = registration.keyIndex;
  summary.checkpointKeyBindingPassed = true;
  const { createDemoState } = await import('../src/vault.js');
  const { buildSoloWithdrawalTamperPsbts } = await import('../src/psbt.js');
  const state = createDemoState({
    sigbashLeafOverrides: JSON.parse(process.env.SIGBASH_LEAF_KEYS_JSON!),
    economics: source.economics,
  });
  const [txid, vout] = source.outpoint.split(':');
  if (fixture === 'pair') source.policy = state.policies.get(`${source.round}:${source.leaverId}`);
  const rebuilt = buildSoloWithdrawalTamperPsbts({
    state, currentIds: source.policy.roundIds, leaverId: source.leaverId,
    txid, vout: Number(vout), valueSats: source.inputValueSats,
  });
  if (fixture === 'pair') {
    source.psbts = rebuilt;
    writeProtectedFile(`${directory}/${runLabel}-public-fixture.json`, JSON.stringify({
      network: 'signet', intentionallyUnfunded: true, round: source.round,
      leaverId: source.leaverId, outpoint: source.outpoint,
      inputValueSats: source.inputValueSats, economics: source.economics,
      policy: source.policy, psbts: rebuilt,
    }, null, 2));
  }
  summary.savedPsbtMatchesCurrentBuilder = rebuilt.valid.psbtBase64 === source.psbts.valid.psbtBase64;
  summary.savedPolicyMatchesCurrentBuilder = isDeepStrictEqual(
    state.policies.get(source.policy.id), source.policy,
  );
  assert.equal(summary.savedPsbtMatchesCurrentBuilder, true, 'saved PSBT differs from current vault construction');
  assert.equal(summary.savedPolicyMatchesCurrentBuilder, true, 'saved policy differs from current vault construction');
  const psbtBase64 = source.psbts.valid.psbtBase64 as string;
  summary.psbtSha256 = createHash('sha256').update(psbtBase64).digest('hex');
  const verified = await client.verifyPSBT({ psbtBase64, kmcJSON, network: 'signet' });
  summary.verification = {
    passed: verified.passed,
    error: verified.error ? safeError(new Error(verified.error)) : null,
    nullifierStatus: verified.nullifierStatus?.map((item: NullifierStatus) => ({
      inputIndex: item.inputIndex, available: item.available,
      message: item.message ? safeError(new Error(item.message)) : null,
    })),
  };
  assert.equal(verified.passed, true, 'current local WASM did not accept the saved vault PSBT');
  summary.localVerificationPassed = true;
  summary.nullifiersAvailable = verified.nullifierStatus?.every((item: NullifierStatus) => item.available === true) ?? null;
  assert.notEqual(summary.nullifiersAvailable, false, 'saved input signing session is unavailable');
  const tampered: Record<string, boolean> = {};
  for (const [name, input] of Object.entries(source.psbts.tampered)) {
    const result = await client.verifyPSBT({ psbtBase64: (input as { psbtBase64: string }).psbtBase64, kmcJSON, network: 'signet' });
    tampered[name] = result.passed === false;
    assert.equal(result.passed, false, `local WASM unexpectedly accepted ${name}`);
  }
  summary.localTamperRejections = tampered;
  emit({ stage: 'live-signing', transport, localVerificationPassed: true, localTamperRejections: tampered });
  const sign = () => client!.signPSBT({ keyId, psbtBase64, kmcJSON, network: 'signet' });
  const result = transport === 'hex' ? await compatibility.withSigbashHexProofTransport(sign) : await sign();
  const normalized = compatibility.normalizeSigbashSigningResult(result);
  summary.hostedSignatureReturned = normalized.success;
  summary.hasSignedPsbt = Boolean(normalized.signedPsbtBase64);
  summary.hasTransaction = Boolean(normalized.txHex);
  if (!normalized.success) throw new Error(normalized.error || 'hosted signer returned no success');
  // Retain only returned public signing artifacts, never decrypted KMC or keys.
  writeProtectedFile(`${directory}/${runLabel}-signed-artifacts.json`, JSON.stringify(normalized, null, 2));
  summary.status = 'signature-returned-needs-independent-validation';
} catch (error) {
  summary.status = 'failed';
  summary.error = safeError(error);
  summary.stack = error instanceof Error && error.stack ? safeError(new Error(error.stack)) : null;
  summary.errorCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : null;
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  client?.disconnect();
  client?.dispose();
  summary.stages = [...stages];
  summary.suppressedSdkLogMessages = suppressedLogs;
  writeProtectedFile(`${directory}/${runLabel}-summary.json`, JSON.stringify(summary, null, 2));
  emit(summary);
}
process.exit(process.exitCode || 0);
