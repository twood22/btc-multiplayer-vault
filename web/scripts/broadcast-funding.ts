import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { assertReviewedNodeRuntime } from '../../src/runtime-version';
import { readProtectedFundingReleaseReport } from '../../src/funding-release-report';
import { readProtectedLiveSigbashProofReceipt } from '../../src/live-proof-receipt';
import { submitPasskeyApprovedFunding } from '../lib/server/funding-signature-store';

if (existsSync('.env.local')) loadEnvFile('.env.local');
assertReviewedNodeRuntime();

const args = parseArgs(process.argv.slice(2));
const vaultId = required(args, 'vault-id');
const finalizationDigest = digestArg(args, 'finalization-digest');
const liveProofDigest = digestArg(args, 'live-sigbash-proof-digest');
const releaseReportDigest = digestArg(args, 'release-report-digest');
const deployedImageManifestDigest = process.env.DEPLOYED_IMAGE_MANIFEST_DIGEST || '';
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(vaultId)) {
  throw new Error('--vault-id must be a UUID');
}
if (liveProofDigest !== process.env.LIVE_SIGBASH_MAINNET_PROOF_DIGEST) {
  throw new Error('live Sigbash proof digest does not match the protected operator environment');
}
readProtectedLiveSigbashProofReceipt(
  process.env.LIVE_SIGBASH_MAINNET_PROOF_RECEIPT || 'live-run/predeployment-proof-receipt.json',
  liveProofDigest,
);
if (releaseReportDigest !== process.env.FUNDING_RELEASE_REPORT_DIGEST) {
  throw new Error('funding release report digest does not match the protected operator environment');
}
const releaseReport = readProtectedFundingReleaseReport(
  process.env.FUNDING_RELEASE_REPORT_PATH || 'live-run/funding-release-report.json',
  {
    reportDigest: releaseReportDigest,
    vaultId,
    finalizationDigest,
    liveSigbashProofDigest: liveProofDigest,
    deployedImageManifestDigest,
  },
);
if (args['confirm-mainnet-broadcast'] !== 'BROADCAST_EXACT_APPROVED_FUNDING_TRANSACTION') {
  throw new Error(
    '--confirm-mainnet-broadcast must equal BROADCAST_EXACT_APPROVED_FUNDING_TRANSACTION',
  );
}

const result = await submitPasskeyApprovedFunding({
  vaultId,
  expectedFinalizationDigest: finalizationDigest,
  expectedFinalTxid: releaseReport.fundingFinalization.finalTxid,
});
console.log(JSON.stringify({
  ok: true,
  network: 'mainnet',
  vaultId,
  ...result,
}, null, 2));

function parseArgs(values: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  const supported = new Set([
    'vault-id',
    'finalization-digest',
    'live-sigbash-proof-digest',
    'release-report-digest',
    'confirm-mainnet-broadcast',
  ]);
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(
        'usage: --vault-id <uuid> --finalization-digest <hex> ' +
        '--live-sigbash-proof-digest <hex> --release-report-digest <hex> ' +
        '--confirm-mainnet-broadcast BROADCAST_EXACT_APPROVED_FUNDING_TRANSACTION',
      );
    }
    const key = name.slice(2);
    if (!supported.has(key) || parsed[key]) {
      throw new Error(`unsupported or repeated funding-broadcast argument: --${key}`);
    }
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function required(values: Record<string, string>, name: string): string {
  const value = values[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function digestArg(values: Record<string, string>, name: string): string {
  const value = required(values, name).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`--${name} must be 64 lowercase hex characters`);
  return value;
}
