import { readProtectedFundingReleaseReport } from './funding-release-report.js';
import { readProtectedLiveSigbashProofReceipt } from './live-proof-receipt.js';
import { RELEASE_NETWORK, assertExplicitOperatorNetwork } from './release-network.js';

/** Operator authorization boundary: it reads evidence, never sends coins. */
export function authorizeFundingBroadcastCommand(
  values: string[], env: Record<string, string | undefined>,
): { network: typeof RELEASE_NETWORK.network; vaultId: string; finalizationDigest: string; finalTxid: string } {
  assertExplicitOperatorNetwork(env);
  const args = parseArgs(values);
  const vaultId = required(args, 'vault-id');
  const finalizationDigest = digestArg(args, 'finalization-digest');
  const liveProofDigest = digestArg(args, 'live-sigbash-proof-digest');
  const reportDigest = digestArg(args, 'release-report-digest');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(vaultId)) {
    throw new Error('--vault-id must be a UUID');
  }
  if (args[RELEASE_NETWORK.broadcastFlag] !== RELEASE_NETWORK.broadcastAcknowledgement) {
    throw new Error(`--${RELEASE_NETWORK.broadcastFlag} must equal ${RELEASE_NETWORK.broadcastAcknowledgement}`);
  }
  if (liveProofDigest !== env[RELEASE_NETWORK.proofDigestEnv]) {
    throw new Error('live Sigbash proof digest does not match the protected operator environment');
  }
  readProtectedLiveSigbashProofReceipt(
    env[RELEASE_NETWORK.proofReceiptEnv] || RELEASE_NETWORK.proofReceiptPath,
    liveProofDigest,
  );
  if (reportDigest !== env[RELEASE_NETWORK.reportDigestEnv]) {
    throw new Error('funding release report digest does not match the protected operator environment');
  }
  const report = readProtectedFundingReleaseReport(
    env[RELEASE_NETWORK.reportPathEnv] || RELEASE_NETWORK.reportPath,
    {
      reportDigest, vaultId, finalizationDigest, liveSigbashProofDigest: liveProofDigest,
      deployedImageManifestDigest: env.DEPLOYED_IMAGE_MANIFEST_DIGEST || '',
    },
  );
  return { network: RELEASE_NETWORK.network, vaultId, finalizationDigest, finalTxid: report.fundingFinalization.finalTxid };
}

function parseArgs(values: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  const supported = new Set([
    'vault-id', 'finalization-digest', 'live-sigbash-proof-digest',
    'release-report-digest', RELEASE_NETWORK.broadcastFlag,
  ]);
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`funding-broadcast arguments require --name value pairs and --${RELEASE_NETWORK.broadcastFlag}`);
    }
    const key = name.slice(2);
    if (!supported.has(key) || parsed[key]) throw new Error(`unsupported or repeated funding-broadcast argument: --${key}`);
    parsed[key] = value;
  }
  return parsed;
}

function required(values: Record<string, string>, name: string): string {
  const value = values[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function digestArg(values: Record<string, string>, name: string): string {
  const value = required(values, name);
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`--${name} must be 64 lowercase hex characters`);
  return value;
}
