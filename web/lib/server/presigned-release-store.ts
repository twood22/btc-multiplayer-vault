import 'server-only';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BITCOIN_GENESIS_HASH, BITCOIN_NETWORK_NAME } from '../../../src/network';
import { databaseEndpointFingerprint, readProtectedDatabaseRestoreReceipt } from '../../../src/database-restore-receipt';
import { reviewedNodeRuntimeCheck } from '../../../src/runtime-version';
import { presignedWalletSigningReady, validatePresignedRestorationReceipt,
  type PresignedCeremonyState, type PresignedEligibleCredentials } from '../../../src/presigned/ceremony';
import { finalizePresignedFunding } from '../../../src/presigned/funding';
import { assertPresignedReleaseBindings, readPresignedProtectedJson, validatePresignedAcceptanceReceipt,
  validatePresignedFundingRelease } from '../../../src/presigned/release';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, type ParticipantId } from '../../../src/presigned/types';
import { assertPresignedFundingRestoreBinding, validatePresignedFundingRestoreReceipt } from '../../../src/presigned/restore';
import { assert, commitmentDigest, exactKeys, hexBytes, identifier, sameCanonical } from '../../../src/presigned/validation';
import { databaseEndpointCheck } from '../database-config';
import { captureDatabaseRuntimeIdentity, captureDatabaseSnapshot } from '../database-snapshot';
import { EXPECTED_MIGRATION_VERSIONS } from '../migrations';
import { capturePresignedFundingRestoreBinding } from '../presigned-funding-restore';
import { db, transaction } from './db';
import { loadPresignedFundingEpoch } from './presigned-chain-store';
import { presignedCoreBackend, presignedCoreRpc } from './presigned-core';
import { chainConfirmationsRequired, chainObservationOrigins, webConfig } from './config';
import { getPresignedCeremonyStatus } from './presigned-store';

/** Before any mainnet wallet-signature workflow: actual tested software, not a label. */
export function assertPresignedSoftwareRelease() {
  assert(process.env.PRESIGNED_V2_MAINNET_AUTHORIZATION === 'separately-approved-mainnet-spending' &&
    process.env.PRESIGNED_V2_BROADCAST_NETWORK === BITCOIN_NETWORK_NAME,
    'V2 mainnet funding requires separate explicit authorization; the implementation goal did not grant it');
  return inspectPresignedSoftwareEvidence();
}
export function inspectPresignedSoftwareEvidence() {
  assert(reviewedNodeRuntimeCheck().ok, 'release needs the reviewed Node runtime');
  const build = JSON.parse(readFileSync('vault-presigned-build.json', 'utf8')) as {
    version: number; protocol: string; network: string; sourceDigest: string;
  };
  exactKeys(build, ['version','protocol','network','sourceDigest'], 'presigned build identity');
  assert(build.version === 2 && build.protocol === PRESIGNED_PROTOCOL && build.network === BITCOIN_NETWORK_NAME, 'release build protocol/network differs');
  hexBytes(build.sourceDigest, 32, 'build source digest');
  sameCanonical(JSON.parse(readFileSync('vault-build-network.json', 'utf8')),
    { version: 1, network: BITCOIN_NETWORK_NAME }, 'release browser network profile');
  const receipt = validatePresignedAcceptanceReceipt(readPresignedProtectedJson(required('PRESIGNED_V2_ACCEPTANCE_RECEIPT')));
  assert(receipt.receiptDigest === required('PRESIGNED_V2_ACCEPTANCE_RECEIPT_DIGEST') && receipt.sourceDigest === build.sourceDigest &&
    receipt.testedImageManifestDigest === required('DEPLOYED_IMAGE_MANIFEST_DIGEST'), 'software acceptance is not for the reviewed exact deployed build/image');
  const utility = readFileSync('public/offline/presigned-recovery.html');
  assert(utility.length <= 5 * 1024 * 1024 && createHash('sha256').update(utility).digest('hex') === receipt.offlineUtilityDigest,
    'deployed offline recovery utility differs from the actually tested artifact');
  return receipt;
}

/** Authenticated, read-only readiness. Results are descriptive, never send authority. */
export async function getPresignedFundingReadiness(userId: string) {
  const status = await getPresignedCeremonyStatus(userId);
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];
  const check = async (id: string, detail: string, action: () => unknown | Promise<unknown>) => {
    try { await action(); checks.push({ id, passed: true, detail }); }
    catch { checks.push({ id, passed: false, detail }); }
  };
  await check('reviewed-runtime', 'Reviewed Node runtime', () => assert(reviewedNodeRuntimeCheck().ok, 'runtime not verified'));
  await check('tested-software', 'Exact source, OCI image, offline utility, reviewed automated acceptance and real default-Signet evidence', inspectPresignedSoftwareEvidence);
  await check('private-core', 'Synchronized private Core, exact network/genesis, active tip and transaction index', () => presignedCoreBackend().getTip());
  await check('ceremony', 'Complete graph, twelve preauthorizations and every participant’s offline plus two-passkey restoration receipts', () =>
    assert(status.walletSigningReady, 'ceremony incomplete'));
  await check('final-funding', 'All three wallet signatures and exact final funding approvals', () =>
    assert(status.epoch?.status === 'approved' && status.epoch.finalization && status.epoch.fundingApprovals.length === 3, 'funding not finalized'));
  if (BITCOIN_NETWORK_NAME === 'mainnet') {
    await check('separate-mainnet-authorization', 'Separate explicit mainnet activation, not granted by the implementation goal', () =>
      assert(process.env.PRESIGNED_V2_MAINNET_AUTHORIZATION === 'separately-approved-mainnet-spending' &&
        process.env.PRESIGNED_V2_BROADCAST_NETWORK === 'mainnet', 'mainnet not authorized'));
    await check('current-funding-release', 'Fresh reviewed release report, exact funding epoch, production restore evidence and current funding coins', async () => {
      assert(status.epoch, 'no exact funding epoch'); await assertPresignedFundingRelease(status.vaultId, status.epoch.epochId);
    });
  } else await check('signet-broadcast-opt-in', 'Explicit Signet test-network broadcast opt-in', () =>
    assert(process.env.PRESIGNED_V2_BROADCAST_NETWORK === 'signet', 'Signet broadcast not enabled'));
  return { version: 2, protocol: PRESIGNED_PROTOCOL, network: BITCOIN_NETWORK_NAME,
    vaultId: status.vaultId, epochId: status.epoch?.epochId ?? null, graphDigest: status.epoch?.graph?.digest ?? null,
    checks, fundingAuthorized: false, physicalPasskeys: 'deferred-to-friends-onboarding',
    note: 'Read-only results do not authorize any signature or broadcast. Signet is used to produce live acceptance evidence. Already-funded exits do not require a new funding release report.' };
}

/** Signet is the acceptance network that PRODUCES the required live evidence.
 * It still needs explicit broadcast opt-in, exact signatures, real source
 * checks and backup gates. Mainnet additionally needs the completed release.
 */
export function assertPresignedFundingSignatureRelease(kind: string) {
  if (BITCOIN_NETWORK_NAME === 'mainnet' && ['begin-wallet-signing','submit-funding-signature','approve-funding'].includes(kind))
    assertPresignedSoftwareRelease();
}
export async function assertPresignedFundingDeploymentRelease(vaultId: string, epochId: string) {
  if (BITCOIN_NETWORK_NAME !== 'mainnet') return null;
  return assertPresignedFundingRelease(vaultId, epochId);
}

/** Append only immediately before an authorized INITIAL funding send/package.
 * Recovery of already-accepted funding and exits never needs a new funding release.
 */
export async function recordPresignedFundingReleaseUse(input: {
  vaultId: string; epochId: string; broadcastIntentId: string | null; feePackageId: string | null;
  evidence: Awaited<ReturnType<typeof assertPresignedFundingDeploymentRelease>>;
}) {
  if (!input.evidence) return;
  const evidence = input.evidence;
  await db()`INSERT INTO presigned_funding_release_uses(vault_id,epoch_id,broadcast_intent_id,fee_package_id,
    release_report_digest,acceptance_receipt_digest,finalization_digest)
    VALUES (${input.vaultId}::uuid,${input.epochId}::uuid,${input.broadcastIntentId}::uuid,${input.feePackageId}::uuid,
      ${Buffer.from(evidence.reportDigest,'hex')},${Buffer.from(evidence.acceptanceReceiptDigest,'hex')},${Buffer.from(evidence.finalizationDigest,'hex')})`;
}

/** This is a pre-funding release check, not an online policy signer or a gate on already-funded exits. */
export async function assertPresignedFundingRelease(vaultId: string, epochId: string) {
  const receipt = assertPresignedSoftwareRelease();
  const prerequisites = await inspectPresignedFundingPrerequisites(vaultId, epochId);
  const report = validatePresignedFundingRelease(readPresignedProtectedJson(required('PRESIGNED_V2_RELEASE_REPORT')));
  assertPresignedReleaseBindings(report, receipt, {
    network: BITCOIN_NETWORK_NAME, vaultId, epochId, graphDigest: prerequisites.graphDigest,
    fundingTxid: prerequisites.fundingTxid, finalizationDigest: prerequisites.finalizationDigest,
    reviewedReportDigest: required('PRESIGNED_V2_RELEASE_REPORT_DIGEST'),
    reviewedAcceptanceDigest: required('PRESIGNED_V2_ACCEPTANCE_RECEIPT_DIGEST'),
    buildSourceDigest: prerequisites.sourceDigest, deployedImageManifestDigest: prerequisites.imageDigest,
    databaseRestoreReceiptDigest: prerequisites.restoreReceiptDigest,
    fundingRestoreReceiptDigest: prerequisites.fundingRestoreReceiptDigest,
  });
  return { reportDigest: report.reportDigest, acceptanceReceiptDigest: receipt.receiptDigest,
    finalizationDigest: prerequisites.finalizationDigest };
}

/** Read-only substantive checks used by the private report generator and the actual send preparation gate. */
export async function inspectPresignedFundingPrerequisites(vaultId: string, epochId: string) {
  identifier(vaultId, 'release vault'); identifier(epochId, 'release epoch');
  assert(reviewedNodeRuntimeCheck().ok, 'release needs the reviewed Node runtime');
  const profile = JSON.parse(readFileSync('vault-build-network.json', 'utf8'));
  sameCanonical(profile, { version: 1, network: BITCOIN_NETWORK_NAME }, 'release browser network profile');
  const build = JSON.parse(readFileSync('vault-presigned-build.json', 'utf8')) as {
    version: number; protocol: string; network: string; sourceDigest: string;
  };
  exactKeys(build, ['version','protocol','network','sourceDigest'], 'presigned build identity');
  assert(build.version === 2 && build.protocol === PRESIGNED_PROTOCOL && build.network === BITCOIN_NETWORK_NAME, 'release build protocol/network differs');
  hexBytes(build.sourceDigest, 32, 'build source digest');
  const imageDigest = required('DEPLOYED_IMAGE_MANIFEST_DIGEST');
  assert(/^sha256:[0-9a-f]{64}$/u.test(imageDigest), 'release needs the immutable deployed image digest');
  const config = webConfig();
  assert(new URL(config.origin).protocol === 'https:' && config.origin === config.appOrigin, 'release passkey/app origins must be identical HTTPS origins');
  chainObservationOrigins();
  const databaseUrl = required('DATABASE_URL');
  assert(databaseEndpointCheck(databaseUrl).ok, 'production release database requires a non-local verified TLS endpoint');
  const restore = readProtectedDatabaseRestoreReceipt(required('DATABASE_RESTORE_RECEIPT'), {
    receiptDigest: required('DATABASE_RESTORE_RECEIPT_DIGEST'), sourceEndpointFingerprint: databaseEndpointFingerprint(databaseUrl) });
  const identity = await captureDatabaseRuntimeIdentity(db());
  assert(identity.fingerprint === restore.sourceDatabaseIdentityFingerprint, 'release database server identity changed since its restore drill');
  const snapshot = await captureDatabaseSnapshot(db());
  sameCanonical(snapshot.migrationVersions, [...EXPECTED_MIGRATION_VERSIONS], 'release migration set');
  assert(snapshot.schemaDigest === restore.sourceSnapshot.schemaDigest && snapshot.tableCount === restore.sourceSnapshot.tableCount,
    'release schema changed since the successful restore drill');
  const frozen = await transaction(async sql => {
    await sql`SELECT id FROM vaults WHERE id = ${vaultId}::uuid AND protocol = ${PRESIGNED_PROTOCOL} FOR UPDATE`;
    const rows = await sql<Array<{ state_json: PresignedCeremonyState; state_digest: Buffer }>>`
      SELECT state_json, state_digest FROM presigned_ceremonies WHERE vault_id = ${vaultId}::uuid AND protocol = ${PRESIGNED_PROTOCOL}`;
    const state = rows[0]?.state_json;
    assert(state && commitmentDigest('vault/presigned-graph-v2/ceremony/state', state) === rows[0]!.state_digest.toString('hex'),
      'release ceremony snapshot changed');
    const epoch = await loadPresignedFundingEpoch(vaultId, epochId, sql);
    assert(state.epochs.at(-1)?.epochId === epochId && epoch.status === 'approved' && epoch.graph && epoch.finalization,
      'release requires the exact active, unanimously approved funding epoch');
    sameCanonical(state.epochs.at(-1), epoch, 'release retained epoch');
    const credentialRows = await sql<Array<{ participant_id: ParticipantId; credential_id: string }>>`
      SELECT m.participant_id, c.credential_id FROM vault_members m
      JOIN webauthn_credentials c ON c.user_id = m.user_id JOIN passkey_envelopes e ON e.credential_id = c.credential_id
      WHERE m.vault_id = ${vaultId}::uuid AND c.prf_enabled = true`;
    const eligible = Object.fromEntries(PARTICIPANT_IDS.map(id => [id,
      credentialRows.filter(row => row.participant_id === id).map(row => row.credential_id)])) as PresignedEligibleCredentials;
    assert(presignedWalletSigningReady(state, eligible), 'release requires complete preauthorizations, offline restore and two current restored passkeys for everyone');
    for (const receipt of epoch.backups) validatePresignedRestorationReceipt({ graph: epoch.graph,
      preauthorizations: epoch.preauthorizations, participantId: receipt.participantId, proof: receipt.proof });
    sameCanonical([...epoch.walletSigningStarted].sort(), [...PARTICIPANT_IDS], 'release durable wallet-start intents');
    sameCanonical([...epoch.fundingApprovals].sort(), [...PARTICIPANT_IDS], 'release exact funding approvals');
    sameCanonical(finalizePresignedFunding({ graph: epoch.graph, signatures: epoch.signatures }), epoch.finalization, 'release final funding bytes');
    return { graph: epoch.graph, finalization: epoch.finalization };
  });
  const restoredFunding = validatePresignedFundingRestoreReceipt(readPresignedProtectedJson(required('PRESIGNED_V2_FUNDING_RESTORE_RECEIPT')));
  const currentFunding = await capturePresignedFundingRestoreBinding(db(), vaultId, epochId);
  assertPresignedFundingRestoreBinding(restoredFunding, {
    reviewedReceiptDigest: required('PRESIGNED_V2_FUNDING_RESTORE_RECEIPT_DIGEST'), databaseRestoreReceiptDigest: restore.receiptDigest,
    sourceEndpointFingerprint: databaseEndpointFingerprint(databaseUrl), sourceDatabaseIdentityFingerprint: identity.fingerprint, currentFunding });
  assert(currentFunding.graphDigest === frozen.graph.digest && currentFunding.fundingTxid === frozen.graph.fundingTxid &&
    currentFunding.finalizationDigest === frozen.finalization.finalizationDigest, 'funding state changed during restored-state verification');
  const maximumDeposit = Number(required('PRIVATE_BETA_MAX_DEPOSIT_SATS'));
  assert(Number.isSafeInteger(maximumDeposit) && maximumDeposit >= 10_000 &&
    frozen.graph.roster.economics.depositSatsPerParticipant <= maximumDeposit, 'release deposit exceeds the explicitly reviewed beta cap');
  assert(frozen.graph.roster.network === BITCOIN_NETWORK_NAME && frozen.graph.roster.genesisHash === BITCOIN_GENESIS_HASH,
    'release graph has another network');
  const core = presignedCoreBackend();
  const tip = await core.getTip();
  const networkInfo = await presignedCoreRpc<{ version: number }>('getnetworkinfo');
  assert(networkInfo.version === 310100, 'release needs the actually reviewed Bitcoin Core31.1 TRUC/package runtime');
  for (const coin of frozen.graph.funding.inputs) {
    const observed = await core.observeCoin(coin);
    assert(observed.valueSats === coin.valueSats && observed.scriptPubKeyHex === coin.scriptPubKeyHex &&
      observed.confirmations >= Math.max(coin.confirmations, chainConfirmationsRequired()), 'release funding input is unavailable or changed');
  }
  sameCanonical(tip, await core.getTip(), 'release funding-source stable tip');
  return { graphDigest: frozen.graph.digest, fundingTxid: frozen.graph.fundingTxid,
    finalizationDigest: frozen.finalization.finalizationDigest, sourceDigest: build.sourceDigest,
    imageDigest, restoreReceiptDigest: restore.receiptDigest, fundingRestoreReceiptDigest: restoredFunding.receiptDigest, snapshotSchemaDigest: snapshot.schemaDigest,
    coreVersion: networkInfo.version, network: BITCOIN_NETWORK_NAME, fundingAllowed: false as const };
}
function required(name: string) { const value = process.env[name]; assert(value, `${name} is required for v2 funding release`); return value; }
