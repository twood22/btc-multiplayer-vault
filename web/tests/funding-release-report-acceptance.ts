import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFundingReleaseReport,
  readProtectedFundingReleaseReport,
  validateFundingReleaseReport,
  type FundingReleaseCheck,
} from '../../src/funding-release-report.js';
import { writeProtectedFile } from '../../src/operator-environment.js';

const checks: Array<{ name: string; ok: true }> = [];
const directory = mkdtempSync(join(tmpdir(), 'btc-vault-funding-release-'));
const createdAt = '2026-08-12T12:00:00.000Z';
const vaultId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const finalizationDigest = '11'.repeat(32);
const finalTxid = '22'.repeat(32);
const liveSigbashProofDigest = '33'.repeat(32);

try {
  const reportChecks: FundingReleaseCheck[] = [
    { name: 'protected live Sigbash mainnet proof receipt is present and matches its reviewed digest', ok: true },
    { name: 'reviewed Node runtime is active', ok: true },
    { name: 'production WebAuthn origin and RP ID are explicit HTTPS values', ok: true },
    { name: 'at least one independent HTTPS chain-observation origin is explicit', ok: true },
    { name: 'tiny-mainnet amount is explicit and within the private-beta cap', ok: true },
    { name: 'mainnet recovery delay is explicit and positive', ok: true },
    { name: 'confirmation depth for funding and transitions is explicit', ok: true },
    { name: 'three-wallet funding fee is explicit and cannot consume one deposit', ok: true },
    { name: 'Sigbash service origin is an explicit credential-free HTTPS origin', ok: true },
    { name: 'Sigbash WASM matches the pinned SHA-384', ok: true },
    { name: 'Sigbash Go loader matches the pinned SHA-384', ok: true },
    { name: 'production database uses a non-local TLS endpoint', ok: true },
    {
      name: 'protected production database restore receipt is present, fresh, and bound to this endpoint',
      ok: true,
    },
    { name: 'production database is PostgreSQL 16 or newer', ok: true },
    { name: 'all required database migrations are applied', ok: true },
    { name: 'exactly one three-person private-beta vault exists', ok: true },
    { name: 'all three participants have two completed PRF passkey envelopes', ok: true },
    { name: 'the immutable roster has nine live Sigbash keys and three confirmations', ok: true },
    { name: 'all nine server-verified Sigbash readiness proofs are recorded', ok: true },
    { name: 'the pre-funding database contains no current Bitcoin coin', ok: true },
    {
      name: 'funding ceremony is either untouched or unanimously approved and still unbroadcast',
      ok: true,
      detail: `approved finalization ${finalizationDigest}`,
    },
    { name: 'configured Bitcoin backend identifies as mainnet', ok: true },
  ];
  const manualGates = [
    'Independently review the protected predeployment live-Sigbash receipt and its consensus-authorized mainnet signature.',
    'Sigbash must explicitly enable mainnet for all three independent participant organization hashes.',
    'Each friend must complete setup and recovery with two real, distinct PRF-capable passkeys.',
    'Each friend must independently review the unanimous roster and tiny-mainnet economics.',
    'The deployed private service must use the independently reviewed immutable image digest and narrow private access control.',
    'Before initial wallet signing, all three friends must review the same funding PSBT fingerprint, inputs, change outputs, vault output, and fee.',
    'Three independent real wallets must sign only their own P2WPKH or P2TR funding inputs and all three final passkey approvals must be completed.',
    'The private Bitcoin Core path must complete rejection, retry, duplicate, interruption, mempool, confirmation, and reorganization drills.',
    'The operator has documented that this report does not authorize funding and a separate explicit broadcast decision is still required.',
  ];
  const report = createFundingReleaseReport({
    createdAt,
    vaultId,
    finalizationDigest,
    finalTxid,
    liveSigbashProofDigest,
    checks: reportChecks,
    manualGates,
    manualReviewAcknowledged: true,
  });
  assert.deepEqual(validateFundingReleaseReport(report), report);
  checks.push({ name: 'a canonical release report binds the exact vault, final transaction, live proof, and passing gates', ok: true });

  assert.throws(
    () => createFundingReleaseReport({
      createdAt,
      vaultId,
      finalizationDigest,
      finalTxid,
      liveSigbashProofDigest,
      checks: reportChecks,
      manualGates,
      manualReviewAcknowledged: false,
    }),
    /explicit acknowledgement/u,
  );
  assert.throws(
    () => createFundingReleaseReport({
      createdAt,
      vaultId,
      finalizationDigest,
      finalTxid,
      liveSigbashProofDigest,
      checks: reportChecks.map((item, index) => index === 0 ? { ...item, ok: false } : item),
      manualGates,
      manualReviewAcknowledged: true,
    }),
    /every automated preflight check/u,
  );
  assert.throws(
    () => createFundingReleaseReport({
      createdAt,
      vaultId,
      finalizationDigest,
      finalTxid,
      liveSigbashProofDigest,
      checks: reportChecks.slice(1),
      manualGates,
      manualReviewAcknowledged: true,
    }),
    /missing a mandatory automated gate/u,
  );
  assert.throws(
    () => createFundingReleaseReport({
      createdAt,
      vaultId,
      finalizationDigest,
      finalTxid,
      liveSigbashProofDigest,
      checks: reportChecks.filter((item) =>
        !item.name.startsWith('protected production database restore receipt')),
      manualGates,
      manualReviewAcknowledged: true,
    }),
    /missing a mandatory automated gate/u,
  );
  assert.throws(
    () => createFundingReleaseReport({
      createdAt,
      vaultId,
      finalizationDigest,
      finalTxid,
      liveSigbashProofDigest,
      checks: reportChecks,
      manualGates: manualGates.slice(1),
      manualReviewAcknowledged: true,
    }),
    /missing a mandatory acknowledged manual gate/u,
  );
  checks.push({
    name: 'missing acknowledgement, a failed check, or any omitted mandatory gate prevents report creation',
    ok: true,
  });

  assert.throws(
    () => validateFundingReleaseReport({
      ...report,
      fundingFinalization: { ...report.fundingFinalization, finalTxid: '44'.repeat(32) },
    }),
    /digest does not match/u,
  );
  assert.throws(
    () => validateFundingReleaseReport({ ...report, unexpected: true }),
    /unexpected or missing fields/u,
  );
  checks.push({ name: 'tampered canonical fields and schema additions are rejected', ok: true });

  const protectedDirectory = join(directory, 'protected');
  mkdirSync(protectedDirectory, { mode: 0o700 });
  const reportPath = join(protectedDirectory, 'funding-release-report.json');
  writeProtectedFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const expected = {
    reportDigest: report.reportDigest,
    vaultId,
    finalizationDigest,
    liveSigbashProofDigest,
    now: Date.parse(createdAt) + 60_000,
  };
  assert.deepEqual(readProtectedFundingReleaseReport(reportPath, expected), report);
  for (const changed of [
    { ...expected, reportDigest: '55'.repeat(32) },
    { ...expected, vaultId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    { ...expected, finalizationDigest: '66'.repeat(32) },
    { ...expected, liveSigbashProofDigest: '77'.repeat(32) },
  ]) {
    assert.throws(
      () => readProtectedFundingReleaseReport(reportPath, changed),
      /reviewed report digest|different vault, finalization, or live proof/u,
    );
  }
  checks.push({ name: 'the protected reader binds independently reviewed report, vault, finalization, and proof digests', ok: true });

  assert.throws(
    () => readProtectedFundingReleaseReport(reportPath, {
      ...expected,
      now: Date.parse(createdAt) + 31 * 60_000,
    }),
    /stale or dated in the future/u,
  );
  assert.throws(
    () => readProtectedFundingReleaseReport(reportPath, {
      ...expected,
      now: Date.parse(createdAt) - 1,
    }),
    /stale or dated in the future/u,
  );
  assert.throws(
    () => readProtectedFundingReleaseReport(reportPath, {
      ...expected,
      maxAgeMs: Number.POSITIVE_INFINITY,
    }),
    /freshness policy is invalid/u,
  );
  assert.throws(
    () => readProtectedFundingReleaseReport(reportPath, {
      ...expected,
      maxAgeMs: 0,
    }),
    /freshness policy is invalid/u,
  );
  checks.push({ name: 'stale and future-dated reports cannot authorize broadcast', ok: true });

  const permissivePath = join(protectedDirectory, 'permissive.json');
  writeFileSync(permissivePath, readFileSync(reportPath), { mode: 0o600 });
  chmodSync(permissivePath, 0o640);
  assert.throws(
    () => readProtectedFundingReleaseReport(permissivePath, expected),
    /must not be accessible by group or other users/u,
  );
  const linkedPath = join(protectedDirectory, 'linked.json');
  symlinkSync(reportPath, linkedPath);
  assert.throws(
    () => readProtectedFundingReleaseReport(linkedPath, expected),
    /regular file, not a link/u,
  );
  chmodSync(protectedDirectory, 0o750);
  assert.throws(
    () => readProtectedFundingReleaseReport(reportPath, expected),
    /parent must be a private real directory/u,
  );
  checks.push({ name: 'linked, over-permissive, and replaceable report paths are rejected', ok: true });

  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
