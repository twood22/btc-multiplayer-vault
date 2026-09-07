import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { BitcoinNetworkName } from '../types.js';
import { assertProtectedRegularFile } from '../operator-environment.js';
import { PRESIGNED_PROTOCOL } from './types.js';
import { assert, commitmentDigest, exactKeys, genesisHash, hexBytes, identifier, sameCanonical } from './validation.js';

/** Every category needs executable evidence; none is a substitute for another. */
export const PRESIGNED_RELEASE_CHECKS = [
  'exact-graph-and-nine-exits-both-network-formats',
  'core-six-exit-orders-cooperative-recovery-final-sweeps',
  'core-hostile-witnesses-and-transaction-mutations',
  'core-real-rolling-fee-floor-truc-and-child-replacement',
  'core-database-restart-reorganization-and-broadcast-races',
  'optimized-browser-three-participants-two-prf-passkeys',
  'provider-free-offline-recovery-browser',
  'legacy-protocol-boundary-and-funding-intent-restart',
  'real-default-signet-lifecycle',
] as const;
export interface PresignedAcceptanceReceipt {
  version: 2;
  protocol: typeof PRESIGNED_PROTOCOL;
  kind: 'presigned-v2-executable-acceptance';
  createdAt: string;
  sourceDigest: string;
  testedImageManifestDigest: string;
  offlineUtilityDigest: string;
  physicalPasskeys: 'deferred-to-friends-onboarding';
  evidence: Array<{ check: typeof PRESIGNED_RELEASE_CHECKS[number]; artifactDigest: string }>;
  liveSignetReceiptDigest: string;
  receiptDigest: string;
}
export interface PresignedFundingRelease {
  version: 2;
  protocol: typeof PRESIGNED_PROTOCOL;
  kind: 'presigned-v2-funding-release-review';
  network: BitcoinNetworkName;
  genesisHash: string;
  createdAt: string;
  vaultId: string;
  epochId: string;
  graphDigest: string;
  fundingTxid: string;
  finalizationDigest: string;
  acceptanceReceiptDigest: string;
  sourceDigest: string;
  deployedImageManifestDigest: string;
  databaseRestoreReceiptDigest: string;
  fundingRestoreReceiptDigest: string;
  /** Explicit operator/user review; the automated receipt never claims this was tested. */
  physicalPasskeysCheckedForThisVault: true;
  manualReviewAcknowledged: true;
  fundingAllowed: false;
  reportDigest: string;
}

export function validatePresignedAcceptanceReceipt(value: unknown): PresignedAcceptanceReceipt {
  exactKeys(value, ['version','protocol','kind','createdAt','sourceDigest','testedImageManifestDigest','offlineUtilityDigest',
    'physicalPasskeys','evidence','liveSignetReceiptDigest','receiptDigest'], 'v2 executable acceptance receipt');
  const receipt = value as PresignedAcceptanceReceipt;
  assert(receipt.version === 2 && receipt.protocol === PRESIGNED_PROTOCOL && receipt.kind === 'presigned-v2-executable-acceptance' &&
    receipt.physicalPasskeys === 'deferred-to-friends-onboarding', 'wrong v2 acceptance identity or physical-test claim');
  timestamp(receipt.createdAt);
  imageDigest(receipt.testedImageManifestDigest);
  for (const field of ['sourceDigest','offlineUtilityDigest','liveSignetReceiptDigest','receiptDigest'] as const) hexBytes(receipt[field], 32, field);
  assert(Array.isArray(receipt.evidence) && receipt.evidence.length === PRESIGNED_RELEASE_CHECKS.length,
    'v2 release requires every mandatory executable acceptance category');
  receipt.evidence.forEach(item => {
    exactKeys(item, ['check','artifactDigest'], 'v2 acceptance evidence');
    assert(PRESIGNED_RELEASE_CHECKS.includes(item.check), 'unknown acceptance evidence category');
    hexBytes(item.artifactDigest, 32, 'acceptance artifact digest');
  });
  sameCanonical(receipt.evidence.map(item => item.check).sort(), [...PRESIGNED_RELEASE_CHECKS].sort(), 'mandatory v2 acceptance checks');
  const { receiptDigest, ...body } = receipt;
  assert(commitmentDigest('vault/presigned-graph-v2/executable-acceptance', body) === receiptDigest, 'acceptance receipt digest changed');
  return receipt;
}

export function validatePresignedFundingRelease(value: unknown): PresignedFundingRelease {
  exactKeys(value, ['version','protocol','kind','network','genesisHash','createdAt','vaultId','epochId','graphDigest','fundingTxid',
    'finalizationDigest','acceptanceReceiptDigest','sourceDigest','deployedImageManifestDigest','databaseRestoreReceiptDigest','fundingRestoreReceiptDigest',
    'physicalPasskeysCheckedForThisVault','manualReviewAcknowledged','fundingAllowed','reportDigest'], 'v2 funding release');
  const report = value as PresignedFundingRelease;
  assert(report.version === 2 && report.protocol === PRESIGNED_PROTOCOL && report.kind === 'presigned-v2-funding-release-review' &&
    report.genesisHash === genesisHash(report.network) && report.physicalPasskeysCheckedForThisVault === true &&
    report.manualReviewAcknowledged === true && report.fundingAllowed === false, 'v2 release lacks exact network or manual/physical review');
  timestamp(report.createdAt); identifier(report.vaultId, 'release vault'); identifier(report.epochId, 'release epoch');
  for (const field of ['graphDigest','fundingTxid','finalizationDigest','acceptanceReceiptDigest','sourceDigest','databaseRestoreReceiptDigest','fundingRestoreReceiptDigest','reportDigest'] as const)
    hexBytes(report[field], 32, field);
  imageDigest(report.deployedImageManifestDigest);
  const { reportDigest, ...body } = report;
  assert(commitmentDigest('vault/presigned-graph-v2/funding-release', body) === reportDigest, 'v2 release digest changed');
  return report;
}

export function readPresignedProtectedJson(path: string): unknown {
  assert(typeof path === 'string' && path.length > 0, 'protected v2 evidence path is required');
  const resolved = resolve(path);
  assertProtectedRegularFile(resolved, 'v2 protected evidence');
  const parent = lstatSync(dirname(resolved));
  assert(parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o077) === 0, 'v2 evidence directory must be private');
  assert(lstatSync(resolved).size <= 512 * 1024, 'v2 evidence file exceeds its bound');
  try { return JSON.parse(readFileSync(resolved, 'utf8')); }
  catch { throw new Error('presigned-v2: protected evidence is not valid JSON'); }
}

export function assertPresignedReleaseBindings(report: PresignedFundingRelease, receipt: PresignedAcceptanceReceipt, expected: {
  network: BitcoinNetworkName; vaultId: string; epochId: string; graphDigest: string; fundingTxid: string;
  finalizationDigest: string; reviewedReportDigest: string; reviewedAcceptanceDigest: string;
  buildSourceDigest: string; deployedImageManifestDigest: string; databaseRestoreReceiptDigest: string; fundingRestoreReceiptDigest: string; now?: number;
}) {
  validatePresignedFundingRelease(report); validatePresignedAcceptanceReceipt(receipt);
  assert(report.reportDigest === expected.reviewedReportDigest && receipt.receiptDigest === expected.reviewedAcceptanceDigest &&
    report.acceptanceReceiptDigest === receipt.receiptDigest, 'v2 release evidence differs from independently reviewed digests');
  assert(report.network === expected.network && report.vaultId === expected.vaultId && report.epochId === expected.epochId &&
    report.graphDigest === expected.graphDigest && report.fundingTxid === expected.fundingTxid &&
    report.finalizationDigest === expected.finalizationDigest, 'v2 release is bound to a different exact funding transaction');
  assert(report.sourceDigest === expected.buildSourceDigest && receipt.sourceDigest === expected.buildSourceDigest &&
    report.deployedImageManifestDigest === expected.deployedImageManifestDigest &&
    receipt.testedImageManifestDigest === expected.deployedImageManifestDigest, 'v2 release is not for this exact tested build/image');
  assert(report.databaseRestoreReceiptDigest === expected.databaseRestoreReceiptDigest, 'v2 release database restore proof changed');
  assert(report.fundingRestoreReceiptDigest === expected.fundingRestoreReceiptDigest, 'v2 release exact funding restore proof changed');
  const age = (expected.now ?? Date.now()) - Date.parse(report.createdAt);
  assert(age >= 0 && age <= 30 * 60_000, 'v2 funding release is stale or in the future');
}
function timestamp(value: string) {
  assert(typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'invalid v2 evidence timestamp');
}
function imageDigest(value: string) { assert(/^sha256:[0-9a-f]{64}$/u.test(value), 'an exact tested immutable image digest is required'); }
