// Operator command/receipt boundary, with explicitly synthetic evidence.
// No database, provider call, physical authenticator, or transaction broadcast.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createFundingReleaseReport, validateFundingReleaseReport } from '../../src/funding-release-report.js';
import { createLiveSigbashProofReceipt, validateLiveSigbashProofReceipt } from '../../src/live-proof-receipt.js';
import { authorizeFundingBroadcastCommand } from '../../src/funding-broadcast-command.js';
import { RELEASE_NETWORK, RELEASE_CHECK_PREFIXES, RELEASE_MANUAL_GATES } from '../../src/release-network.js';
import { writeProtectedFile } from '../../src/operator-environment.js';
import { sha256Hex } from '../../src/crypto.js';

const directory = mkdtempSync(join(tmpdir(), 'vault-funding-operator-'));
const vaultId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const finalizationDigest = '11'.repeat(32);
const finalTxid = '22'.repeat(32);
const imageDigest = `sha256:${'33'.repeat(32)}`;
const otherNetwork = RELEASE_NETWORK.network === 'mainnet' ? 'signet' : 'mainnet';
const checks: string[] = [];
try {
  const receipt = createLiveSigbashProofReceipt({
    createdAt: new Date().toISOString(), round: 'alicebob', leaverId: 'alice', keyId: '0',
    placeholderOutpoint: true, psbtBase64: 'cHNidP8BAA==',
    signedArtifacts: { success: true, txHex: '0200', signedPsbtBase64: null,
      pathId: null, policyRootHex: null, satisfiedClause: null, error: null },
    authorization: { finalTxid, consensus: { txid: finalTxid, checks: ['synthetic receipt boundary fixture'] } },
    checks: [
      'Sigbash verifyPSBT accepts the valid solo PSBT',
      'Sigbash verifyPSBT explicitly rejects tampered wrongAmount PSBT',
      'Sigbash verifyPSBT explicitly rejects tampered wrongAddress PSBT',
      'Sigbash verifyPSBT explicitly rejects tampered extraOutput PSBT',
      'Sigbash live signPSBT returns a transaction or signed PSBT artifact',
      'live Sigbash artifact is the exact consensus-valid policy-leaf transaction',
    ].map(name => ({ name, ok: true })),
  });
  assert.equal(receipt.kind, `live-sigbash-${RELEASE_NETWORK.network}-signing-proof`);
  assert.equal(receipt.genesisHash, RELEASE_NETWORK.genesisHash);
  const proofPath = join(directory, 'proof.json');
  writeProtectedFile(proofPath, JSON.stringify(receipt));
  const report = createFundingReleaseReport({
    createdAt: new Date().toISOString(), vaultId, finalizationDigest, finalTxid,
    liveSigbashProofDigest: receipt.proofDigest, deployedImageManifestDigest: imageDigest,
    checks: RELEASE_CHECK_PREFIXES.map(name => ({ name, ok: true })),
    manualGates: RELEASE_MANUAL_GATES, manualReviewAcknowledged: true,
  });
  const reportPath = join(directory, 'release.json');
  writeProtectedFile(reportPath, JSON.stringify(report));
  const args = ['--vault-id', vaultId, '--finalization-digest', finalizationDigest,
    '--live-sigbash-proof-digest', receipt.proofDigest, '--release-report-digest', report.reportDigest,
    `--${RELEASE_NETWORK.broadcastFlag}`, RELEASE_NETWORK.broadcastAcknowledgement];
  const env: Record<string, string | undefined> = {
    VAULT_NETWORK: RELEASE_NETWORK.network, NEXT_PUBLIC_VAULT_NETWORK: RELEASE_NETWORK.network,
    [RELEASE_NETWORK.proofReceiptEnv]: proofPath, [RELEASE_NETWORK.proofDigestEnv]: receipt.proofDigest,
    [RELEASE_NETWORK.reportPathEnv]: reportPath, [RELEASE_NETWORK.reportDigestEnv]: report.reportDigest,
    DEPLOYED_IMAGE_MANIFEST_DIGEST: imageDigest,
  };
  assert.deepEqual(authorizeFundingBroadcastCommand(args, env), {
    network: RELEASE_NETWORK.network, vaultId, finalizationDigest, finalTxid,
  });
  checks.push('exact protected proof, release, network, image, and finalization bindings authorize only the expected transaction');

  for (const bad of [
    { ...env, VAULT_NETWORK: undefined }, { ...env, NEXT_PUBLIC_VAULT_NETWORK: otherNetwork },
    { ...env, [RELEASE_NETWORK.proofDigestEnv]: undefined },
    { ...env, [RELEASE_NETWORK.reportDigestEnv]: undefined },
    { ...env, DEPLOYED_IMAGE_MANIFEST_DIGEST: `sha256:${'44'.repeat(32)}` },
  ]) assert.throws(() => authorizeFundingBroadcastCommand(args, bad));
  for (const badArgs of [
    args.slice(0, -2), [...args, '--vault-id', vaultId], [...args, '--unexpected', 'yes'],
    args.map(value => value === `--${RELEASE_NETWORK.broadcastFlag}` ? `--confirm-${otherNetwork}-broadcast` : value),
    args.map(value => value === RELEASE_NETWORK.broadcastAcknowledgement ? 'WRONG_APPROVAL' : value),
    args.map(value => value === finalizationDigest ? '55'.repeat(32) : value),
  ]) assert.throws(() => authorizeFundingBroadcastCommand(badArgs, env));
  checks.push('missing/mixed network, wrong-network approval, missing evidence, and substituted transaction/image fail closed');

  const { reportDigest: _reportDigest, ...reportBody } = report;
  for (const altered of [
    { ...reportBody, network: otherNetwork, kind: `${otherNetwork}-funding-release` },
    { ...reportBody, genesisHash: 'ff'.repeat(32) },
    { ...reportBody, version: 2 },
  ]) assert.throws(() => validateFundingReleaseReport({ ...altered, reportDigest: sha256Hex(JSON.stringify(altered)) }));
  const { proofDigest: _proofDigest, ...proofBody } = receipt;
  for (const altered of [
    { ...proofBody, network: otherNetwork, kind: `live-sigbash-${otherNetwork}-signing-proof` },
    { ...proofBody, genesisHash: 'ff'.repeat(32) }, { ...proofBody, version: 1 },
  ]) assert.throws(() => validateLiveSigbashProofReceipt({ ...altered, proofDigest: sha256Hex(JSON.stringify(altered)) }));
  checks.push('cross-network, wrong-genesis, and legacy artifacts are rejected even with recomputed content digests');

  const bootEnvironment = { ...process.env, VAULT_NETWORK: '', NEXT_PUBLIC_VAULT_NETWORK: '',
    BTC_VAULT_OPERATOR_ENV_FILE: join(directory, 'operator.env') };
  writeProtectedFile(bootEnvironment.BTC_VAULT_OPERATOR_ENV_FILE,
    `VAULT_NETWORK=${RELEASE_NETWORK.network}\nNEXT_PUBLIC_VAULT_NETWORK=${RELEASE_NETWORK.network}\n`);
  // Empty inherited strings are not overwritten by loadEnvFile; remove them so
  // this case tests loading the protected profile before config module import.
  delete (bootEnvironment as Record<string, unknown>).VAULT_NETWORK;
  delete (bootEnvironment as Record<string, unknown>).NEXT_PUBLIC_VAULT_NETWORK;
  const code = "const {loadOperatorEnvironment}=await import('./web/scripts/operator-environment.ts');loadOperatorEnvironment();const {RELEASE_NETWORK}=await import('./src/release-network.ts');console.log(JSON.stringify(RELEASE_NETWORK.network));";
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code],
    { env: bootEnvironment, encoding: 'utf8', timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout), RELEASE_NETWORK.network);
  const bootstrap = readFileSync('web/scripts/broadcast-funding.ts', 'utf8');
  assert(bootstrap.indexOf('loadOperatorEnvironment();') < bootstrap.indexOf("await import('./broadcast-funding-main')"));
  checks.push('protected operator configuration loads before modules snapshot the network');
} finally { rmSync(directory, { recursive: true, force: true }); }
console.log(JSON.stringify({ network: RELEASE_NETWORK.network, passed: true,
  liveProviderCalls: 0, broadcasts: 0, syntheticReceiptFixtures: true, checks }, null, 2));
