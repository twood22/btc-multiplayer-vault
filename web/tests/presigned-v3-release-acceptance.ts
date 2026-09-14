import assert from 'node:assert/strict';
import { createDatabaseRestoreReceipt } from '../../src/database-restore-receipt.js';
import { assertPresignedReleaseBindings, presignedReleaseChecks, validatePresignedAcceptanceReceipt,
  validatePresignedFundingRelease, type PresignedAcceptanceReceipt, type PresignedFundingRelease } from '../../src/presigned/release.js';
import { createPresignedFundingRestoreReceipt, validatePresignedFundingRestoreReceipt,
  type PresignedRestoredFundingBinding } from '../../src/presigned/restore.js';
import { PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3 } from '../../src/presigned/types.js';
import { commitmentDigest, genesisHash, presignedDomain, presignedVersion } from '../../src/presigned/validation.js';

// Synthetic validator controls only. Never write these as actual acceptance,
// restore or release artifacts; they prove no device, chain or deployment work.
const at = '2026-09-13T12:00:00.000Z';
const hex = (value: string) => value.repeat(64);
let negatives = 0;
function denied(operation: () => unknown) { assert.throws(operation); negatives++; }
const receipts: PresignedAcceptanceReceipt[] = [];
for (const protocol of [PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3]) {
  const version = presignedVersion(protocol);
  const checks = presignedReleaseChecks(protocol);
  const body: Omit<PresignedAcceptanceReceipt, 'receiptDigest'> = { version, protocol,
    kind: `presigned-v${version}-executable-acceptance`, createdAt: at, sourceDigest: hex('1'),
    testedImageManifestDigest: `sha256:${hex('2')}`, offlineUtilityDigest: hex('3'),
    physicalPasskeys: 'deferred-to-friends-onboarding',
    evidence: checks.map(check => ({ check, artifactDigest: hex('4') })), liveSignetReceiptDigest: hex('5') };
  const sign = (candidate: typeof body) => ({ ...candidate,
    receiptDigest: commitmentDigest(presignedDomain(candidate.protocol, 'executable-acceptance'), candidate) });
  const receipt = validatePresignedAcceptanceReceipt(sign(body)); receipts.push(receipt);
  for (const check of checks) denied(() => validatePresignedAcceptanceReceipt(sign({ ...body,
    evidence: body.evidence.filter(item => item.check !== check) })));
  denied(() => validatePresignedAcceptanceReceipt({ ...receipt, version: version === 2 ? 3 : 2 }));
  denied(() => validatePresignedAcceptanceReceipt({ ...receipt, protocol: 'presigned-graph-v4' }));
  const release: Omit<PresignedFundingRelease, 'reportDigest'> = { version, protocol,
    kind: `presigned-v${version}-funding-release-review`, network: 'mainnet', genesisHash: genesisHash('mainnet'), createdAt: at,
    vaultId: '11111111-1111-4111-8111-111111111111', epochId: '22222222-2222-4222-8222-222222222222',
    graphDigest: hex('6'), fundingTxid: hex('7'), finalizationDigest: hex('8'), acceptanceReceiptDigest: receipt.receiptDigest,
    sourceDigest: receipt.sourceDigest, deployedImageManifestDigest: receipt.testedImageManifestDigest,
    databaseRestoreReceiptDigest: hex('9'), fundingRestoreReceiptDigest: hex('a'),
    physicalPasskeysCheckedForThisVault: true, manualReviewAcknowledged: true, fundingAllowed: false };
  const report = validatePresignedFundingRelease({ ...release,
    reportDigest: commitmentDigest(presignedDomain(protocol, 'funding-release'), release) });
  const expected = { network: release.network, vaultId: release.vaultId, epochId: release.epochId,
    graphDigest: release.graphDigest, fundingTxid: release.fundingTxid, finalizationDigest: release.finalizationDigest,
    reviewedReportDigest: report.reportDigest, reviewedAcceptanceDigest: receipt.receiptDigest,
    buildSourceDigest: receipt.sourceDigest, deployedImageManifestDigest: receipt.testedImageManifestDigest,
    databaseRestoreReceiptDigest: release.databaseRestoreReceiptDigest,
    fundingRestoreReceiptDigest: release.fundingRestoreReceiptDigest, now: Date.parse(at) };
  assertPresignedReleaseBindings(report, receipt, expected);
  denied(() => assertPresignedReleaseBindings(report, receipt, { ...expected, buildSourceDigest: hex('b') }));
  if (version === 3) denied(() => assertPresignedReleaseBindings(report, receipts[0]!, expected));
}

const snapshot = { postgresMajor: 16, migrationVersions: ['022_presigned_v3_fixed_recovery'],
  schemaDigest: hex('1'), tableCount: 1, totalRows: 1, stateDigest: hex('2') };
const databaseRestore = createDatabaseRestoreReceipt({ createdAt: at,
  sourceEndpointFingerprint: hex('3'), restoredEndpointFingerprint: hex('4'),
  sourceDatabaseIdentityFingerprint: hex('5'), restoredDatabaseIdentityFingerprint: hex('6'),
  sourceSnapshot: snapshot, restoredSnapshot: snapshot,
  checks: [
    { name: 'source and restored databases are distinct protected endpoints and server-reported identities', ok: true },
    { name: 'source and restored databases run PostgreSQL 16 or newer', ok: true },
    { name: 'source and restored databases contain the exact reviewed migration set', ok: true },
    { name: 'restored schema exactly matches the source schema', ok: true },
    { name: 'every restored application table exactly matches the source rows', ok: true },
  ] });
const binding: PresignedRestoredFundingBinding = { protocol: PRESIGNED_PROTOCOL_V3, network: 'signet', genesisHash: genesisHash('signet'),
  vaultId: '11111111-1111-4111-8111-111111111111', epochId: '22222222-2222-4222-8222-222222222222',
  graphDigest: hex('7'), fundingTxid: hex('8'), finalizationDigest: hex('9'), ceremonyStateDigest: hex('a'),
  retainedEpochsDigest: hex('b'), custodyMaterialDigest: hex('c') };
const restored = createPresignedFundingRestoreReceipt({ createdAt: at, databaseRestore, sourceFunding: binding, restoredFunding: binding });
assert.equal(restored.protocol, PRESIGNED_PROTOCOL_V3); assert.equal(restored.version, 3);
denied(() => validatePresignedFundingRestoreReceipt({ ...restored, version: 2, protocol: PRESIGNED_PROTOCOL }));
const { protocol: omitted, ...legacyBinding } = binding; void omitted;
denied(() => createPresignedFundingRestoreReceipt({ createdAt: at, databaseRestore, sourceFunding: binding, restoredFunding: legacyBinding }));
const legacy = createPresignedFundingRestoreReceipt({ createdAt: at, databaseRestore, sourceFunding: legacyBinding, restoredFunding: legacyBinding });
assert.equal(legacy.protocol, PRESIGNED_PROTOCOL); assert.equal(legacy.version, 2);
console.log(JSON.stringify({ suite: 'presigned-protocol-release-boundaries', protocols: receipts.map(value => value.protocol),
  passed: true, negativeControls: negatives, actualReleaseEvidenceProduced: false, mainnetAuthorized: false }));
