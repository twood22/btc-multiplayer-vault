import { readFileSync } from 'node:fs';
import { BITCOIN_GENESIS_HASH } from '../../src/network.js';
import { writeProtectedFile } from '../../src/operator-environment.js';
import { validatePresignedFundingRelease,
  type PresignedFundingRelease } from '../../src/presigned/release.js';
import { PRESIGNED_PROTOCOL } from '../../src/presigned/types.js';
import { assert, commitmentDigest, identifier } from '../../src/presigned/validation.js';
import { inspectPresignedFundingPrerequisites, inspectPresignedSoftwareEvidence } from '../lib/server/presigned-release-store.js';
import { closeDatabase } from '../lib/server/db.js';

const flags = new Map<string, string>();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const name = args[i]!; const value = args[i + 1];
  assert(['--vault-id','--epoch-id','--write-protected-report','--acknowledge-manual-review','--physical-passkeys-checked'].includes(name) &&
    value && !value.startsWith('--') && !flags.has(name), 'invalid or duplicate v2 release argument');
  flags.set(name, value);
}
const vaultId = flags.get('--vault-id')!; const epochId = flags.get('--epoch-id')!;
identifier(vaultId, 'release vault'); identifier(epochId, 'release epoch');
try {
  // Share the exact deployed utility/source/image checks used by readiness and
  // actual funding. A descriptive CLI report must not omit a send prerequisite.
  const receipt = inspectPresignedSoftwareEvidence();
  const prerequisites = await inspectPresignedFundingPrerequisites(vaultId, epochId);
  assert(receipt.receiptDigest === process.env.PRESIGNED_V2_ACCEPTANCE_RECEIPT_DIGEST &&
    receipt.sourceDigest === prerequisites.sourceDigest && receipt.testedImageManifestDigest === prerequisites.imageDigest,
    'reviewed v2 acceptance does not cover this exact deployed source/image');
  const outputPath = flags.get('--write-protected-report');
  if (!outputPath) {
    console.log(JSON.stringify({ passed: true, ...prerequisites, acceptanceReceiptDigest: receipt.receiptDigest,
      manualReviewAcknowledged: false, physicalPasskeysProven: false, reportWritten: false, fundingAllowed: false }, null, 2));
  } else {
    assert(flags.get('--acknowledge-manual-review') === 'true' && flags.get('--physical-passkeys-checked') === 'true',
      'writing a release requires explicit manual review and real passkey checks for this vault; virtual tests do not satisfy them');
    const body: Omit<PresignedFundingRelease, 'reportDigest'> = { version: 2, protocol: PRESIGNED_PROTOCOL,
      kind: 'presigned-v2-funding-release-review', network: prerequisites.network, genesisHash: BITCOIN_GENESIS_HASH,
      createdAt: new Date().toISOString(), vaultId, epochId, graphDigest: prerequisites.graphDigest,
      fundingTxid: prerequisites.fundingTxid, finalizationDigest: prerequisites.finalizationDigest,
      acceptanceReceiptDigest: receipt.receiptDigest, sourceDigest: prerequisites.sourceDigest,
      deployedImageManifestDigest: prerequisites.imageDigest, databaseRestoreReceiptDigest: prerequisites.restoreReceiptDigest,
      fundingRestoreReceiptDigest: prerequisites.fundingRestoreReceiptDigest,
      physicalPasskeysCheckedForThisVault: true, manualReviewAcknowledged: true, fundingAllowed: false };
    const report = validatePresignedFundingRelease({ ...body, reportDigest: commitmentDigest('vault/presigned-graph-v2/funding-release', body) });
    const written = writeProtectedFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    assert(JSON.parse(readFileSync(written.path, 'utf8')).reportDigest === report.reportDigest, 'written release report could not be reread');
    console.log(JSON.stringify({ passed: true, reportDigest: report.reportDigest, acceptanceReceiptDigest: receipt.receiptDigest,
      reportWritten: true, reused: written.reused, fundingAllowed: false }, null, 2));
  }
} catch (error) {
  const detail = error instanceof Error && error.message.startsWith('presigned-v2:')
    ? error.message : 'A protected artifact, runtime, database, or private Core prerequisite is unavailable; no report was issued.';
  console.log(JSON.stringify({ passed: false, fundingAllowed: false, reportWritten: false, detail }));
  process.exitCode = 1;
} finally { await closeDatabase(); }
