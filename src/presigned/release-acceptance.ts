import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertPresignedReleaseBindings, PRESIGNED_RELEASE_CHECKS, validatePresignedAcceptanceReceipt,
  validatePresignedFundingRelease, type PresignedAcceptanceReceipt, type PresignedFundingRelease } from './release.js';
import { PRESIGNED_PROTOCOL } from './types.js';
import { commitmentDigest, genesisHash } from './validation.js';

// Synthetic receipts exercise fail-closed validation. They are never saved as
// acceptance/release evidence and cannot prove any execution or live network.
const now = new Date().toISOString();
const digest = (letter: string) => letter.repeat(64);
const evidenceBody: Omit<PresignedAcceptanceReceipt, 'receiptDigest'> = { version: 2, protocol: PRESIGNED_PROTOCOL,
  kind: 'presigned-v2-executable-acceptance', createdAt: now, sourceDigest: digest('1'),
  testedImageManifestDigest: `sha256:${digest('2')}`, offlineUtilityDigest: digest('3'),
  physicalPasskeys: 'deferred-to-friends-onboarding',
  evidence: PRESIGNED_RELEASE_CHECKS.map(check => ({ check, artifactDigest: digest('4') })),
  liveSignetReceiptDigest: digest('5') };
function evidence(body = evidenceBody) {
  return validatePresignedAcceptanceReceipt({ ...body,
    receiptDigest: commitmentDigest('vault/presigned-graph-v2/executable-acceptance', body) });
}
const receipt = evidence();
let negatives = 0;
function denied(action: () => unknown) { assert.throws(action); negatives++; }
for (const check of PRESIGNED_RELEASE_CHECKS) denied(() => evidence({ ...evidenceBody, evidence: evidenceBody.evidence.filter(item => item.check !== check) }));
denied(() => evidence({ ...evidenceBody, evidence: evidenceBody.evidence.map((item, i) => i === 0 ? evidenceBody.evidence[1]! : item) }));
denied(() => evidence({ ...evidenceBody, testedImageManifestDigest: 'latest' }));
denied(() => validatePresignedAcceptanceReceipt({ ...receipt, physicalPasskeys: 'passed' }));
denied(() => validatePresignedAcceptanceReceipt({ ...receipt, liveSignetReceiptDigest: digest('6') }));
denied(() => validatePresignedAcceptanceReceipt({ ...receipt, sigbashCheckDisabled: true }));
for (const network of ['mainnet','signet'] as const) {
  const body: Omit<PresignedFundingRelease, 'reportDigest'> = { version: 2, protocol: PRESIGNED_PROTOCOL,
    kind: 'presigned-v2-funding-release-review', network, genesisHash: genesisHash(network), createdAt: now,
    vaultId: randomUUID(), epochId: randomUUID(), graphDigest: digest('7'), fundingTxid: digest('8'), finalizationDigest: digest('9'),
    acceptanceReceiptDigest: receipt.receiptDigest, sourceDigest: receipt.sourceDigest,
    deployedImageManifestDigest: receipt.testedImageManifestDigest, databaseRestoreReceiptDigest: digest('a'),
    fundingRestoreReceiptDigest: digest('c'),
    physicalPasskeysCheckedForThisVault: true, manualReviewAcknowledged: true, fundingAllowed: false };
  const report = validatePresignedFundingRelease({ ...body, reportDigest: commitmentDigest('vault/presigned-graph-v2/funding-release', body) });
  const expected = { network, vaultId: report.vaultId, epochId: report.epochId, graphDigest: report.graphDigest,
    fundingTxid: report.fundingTxid, finalizationDigest: report.finalizationDigest, reviewedReportDigest: report.reportDigest,
    reviewedAcceptanceDigest: receipt.receiptDigest, buildSourceDigest: receipt.sourceDigest,
    deployedImageManifestDigest: receipt.testedImageManifestDigest, databaseRestoreReceiptDigest: report.databaseRestoreReceiptDigest,
    fundingRestoreReceiptDigest: report.fundingRestoreReceiptDigest,
    now: Date.parse(now) };
  assertPresignedReleaseBindings(report, receipt, expected);
  for (const field of ['graphDigest','fundingTxid','finalizationDigest','reviewedReportDigest','reviewedAcceptanceDigest',
    'buildSourceDigest','databaseRestoreReceiptDigest','fundingRestoreReceiptDigest'] as const)
    denied(() => assertPresignedReleaseBindings(report, receipt, { ...expected, [field]: digest('b') }));
  denied(() => assertPresignedReleaseBindings(report, receipt, { ...expected, network: network === 'signet' ? 'mainnet' : 'signet' }));
  denied(() => assertPresignedReleaseBindings(report, receipt, { ...expected, vaultId: randomUUID() }));
  denied(() => assertPresignedReleaseBindings(report, receipt, { ...expected, epochId: randomUUID() }));
  denied(() => assertPresignedReleaseBindings(report, receipt, { ...expected, now: Date.parse(now) + 30 * 60_000 + 1 }));
  denied(() => assertPresignedReleaseBindings(report, receipt, { ...expected, now: Date.parse(now) - 1 }));
  denied(() => validatePresignedFundingRelease({ ...report, physicalPasskeysCheckedForThisVault: false }));
  denied(() => validatePresignedFundingRelease({ ...report, fundingAllowed: true }));
}
console.log(JSON.stringify({ protocol: PRESIGNED_PROTOCOL, status: 'passed', negativeReleaseBoundaries: negatives,
  realEvidenceProduced: false, realSignetProven: false, physicalPasskeysProven: false, fundingAuthorized: false }));
