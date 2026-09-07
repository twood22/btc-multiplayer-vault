import type { Sql, TransactionSql } from 'postgres';
import { newPresignedCeremony, presignedWalletSigningReady, validatePresignedRestorationReceipt,
  type PresignedCeremonyState, type PresignedEligibleCredentials, type PresignedFundingEpoch } from '../../src/presigned/ceremony.js';
import { finalizePresignedFunding } from '../../src/presigned/funding.js';
import { validatePresignedGraph } from '../../src/presigned/graph.js';
import { createPresignedFundingRestoreReceipt, validatePresignedRestoredFundingBinding, type PresignedRestoredFundingBinding } from '../../src/presigned/restore.js';
import { createDatabaseRestoreReceipt } from '../../src/database-restore-receipt.js';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, type ParticipantId } from '../../src/presigned/types.js';
import { assert, commitmentDigest, identifier, sameCanonical } from '../../src/presigned/validation.js';
import { captureDatabaseRuntimeIdentity, captureDatabaseSnapshotInTransaction, compareDatabaseSnapshots } from './database-snapshot.js';

/** Capture from the supplied connection, never a hidden environment-selected DB. */
export async function capturePresignedFundingRestoreBinding(connection: Sql, vaultId: string, epochId: string) {
  identifier(vaultId, 'restore vault'); identifier(epochId, 'restore epoch');
  return connection.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', sql => readPresignedFundingRestoreBinding(sql, vaultId, epochId)) as Promise<PresignedRestoredFundingBinding>;
}
export async function readPresignedFundingRestoreBinding(sql: TransactionSql, vaultId: string, epochId: string): Promise<PresignedRestoredFundingBinding> {
  identifier(vaultId, 'restore vault'); identifier(epochId, 'restore epoch');
  const rows = await sql<Array<{ state_json: PresignedCeremonyState; state_digest: Buffer; settings_digest: Buffer; settings_json: unknown }>>`
    SELECT c.state_json, c.state_digest, c.settings_digest, c.settings_json FROM presigned_ceremonies c
    JOIN vaults v ON v.id = c.vault_id AND v.protocol = c.protocol
    WHERE c.vault_id = ${vaultId}::uuid AND c.protocol = ${PRESIGNED_PROTOCOL}`;
  assert(rows.length === 1, 'restore database does not contain the exact V2 ceremony');
  const row = rows[0]!; const state = row.state_json;
  assert(state.version === 2 && state.protocol === PRESIGNED_PROTOCOL && state.vaultId === vaultId &&
    commitmentDigest('vault/presigned-graph-v2/ceremony/state', state) === row.state_digest.toString('hex'), 'restored ceremony identity or digest changed');
  sameCanonical(state.settings, row.settings_json, 'restored settings');
  assert(state.settingsDigest === row.settings_digest.toString('hex') &&
    newPresignedCeremony(vaultId, state.settings).settingsDigest === state.settingsDigest, 'restored settings digest changed');
  const epochs = await sql<Array<{ epoch_id: string; ordinal: number; status: string; snapshot_json: PresignedFundingEpoch;
    snapshot_digest: Buffer; graph_digest: Buffer | null; funding_txid: Buffer | null }>>`
    SELECT epoch_id, ordinal, status, snapshot_json, snapshot_digest, graph_digest, funding_txid FROM presigned_funding_epochs
    WHERE vault_id = ${vaultId}::uuid AND protocol = ${PRESIGNED_PROTOCOL} ORDER BY ordinal`;
  assert(epochs.length >= 1 && epochs.length <= 64 && epochs.length === state.epochs.length, 'restore lost a retained funding epoch');
  for (const [index, epoch] of epochs.entries()) {
    assert(epoch.ordinal === index + 1 && epoch.epoch_id === epoch.snapshot_json.epochId && epoch.status === epoch.snapshot_json.status &&
      commitmentDigest('vault/presigned-graph-v2/ceremony/epoch', epoch.snapshot_json) === epoch.snapshot_digest.toString('hex'), 'restored epoch order or digest changed');
    sameCanonical(epoch.snapshot_json, state.epochs[index], 'restored immutable epoch history');
    if (epoch.snapshot_json.graph) {
      const graph = validatePresignedGraph(epoch.snapshot_json.graph);
      assert(graph.digest === epoch.graph_digest?.toString('hex') && graph.fundingTxid === epoch.funding_txid?.toString('hex') &&
        graph.roster.vaultId === vaultId && graph.funding.epochId === epoch.epoch_id, 'restored retained graph binding changed');
    } else assert(epoch.graph_digest === null && epoch.funding_txid === null, 'restored collecting epoch has unexplained graph commitments');
  }
  const epoch = state.epochs.at(-1)!;
  assert(epoch.epochId === epochId && epoch.status === 'approved' && epoch.graph && epoch.finalization,
    'restore must contain the exact active, completely approved funding epoch');
  const graph = validatePresignedGraph(epoch.graph);
  sameCanonical(state.roster, graph.roster, 'restored roster and funding graph');
  assert(state.rosterDigest === graph.rosterDigest, 'restored roster digest changed');
  sameCanonical([...state.identities].sort((a, b) => a.id.localeCompare(b.id)), graph.roster.participants, 'restored participant identities');
  const custody = await sql<Array<{ participant_id: ParticipantId; user_id: string; credential_id: string; public_key: string;
    personal_public_key: string; payout_xonly_public_key: string; envelope: unknown }>>`
    SELECT m.participant_id, m.user_id, c.credential_id, encode(c.public_key,'hex') AS public_key,
      encode(k.personal_public_key,'hex') AS personal_public_key, encode(k.payout_xonly_public_key,'hex') AS payout_xonly_public_key,
      jsonb_build_object('version',e.version,'prf_salt',encode(e.prf_salt,'hex'),'iv',encode(e.iv,'hex'),
        'ciphertext',encode(e.ciphertext,'hex'),'aad',encode(e.aad,'hex')) AS envelope
    FROM vault_members m JOIN participant_key_material k ON k.user_id = m.user_id AND k.vault_id = m.vault_id AND k.participant_id = m.participant_id
    JOIN webauthn_credentials c ON c.user_id = m.user_id JOIN passkey_envelopes e ON e.credential_id = c.credential_id
    WHERE m.vault_id = ${vaultId}::uuid AND c.prf_enabled = true ORDER BY m.participant_id, c.credential_id`;
  assert(custody.length >= 6 && custody.length <= 96, 'restore needs bounded current PRF custody for all three participants');
  for (const item of custody) {
    const own = graph.roster.participants.find(participant => participant.id === item.participant_id);
    assert(own && own.personalPublicKeyHex === item.personal_public_key && own.payoutXonlyPublicKeyHex === item.payout_xonly_public_key,
      'restored passkey identity differs from the funded graph');
  }
  const eligible = Object.fromEntries(PARTICIPANT_IDS.map(id => [id,
    custody.filter(item => item.participant_id === id).map(item => item.credential_id)])) as PresignedEligibleCredentials;
  assert(presignedWalletSigningReady(state, eligible), 'restored funding lacks every offline and two-passkey restoration prerequisite');
  for (const receipt of epoch.backups) validatePresignedRestorationReceipt({ graph, preauthorizations: epoch.preauthorizations,
    participantId: receipt.participantId, proof: receipt.proof });
  sameCanonical([...state.rosterApprovals].sort(), [...PARTICIPANT_IDS], 'restored roster approvals');
  sameCanonical([...epoch.walletSigningStarted].sort(), [...PARTICIPANT_IDS], 'restored wallet signing intents');
  sameCanonical([...epoch.fundingApprovals].sort(), [...PARTICIPANT_IDS], 'restored exact final approvals');
  sameCanonical(finalizePresignedFunding({ graph, signatures: epoch.signatures }), epoch.finalization, 'restored funding signatures and final bytes');
  return validatePresignedRestoredFundingBinding({ network: graph.roster.network, genesisHash: graph.roster.genesisHash,
    vaultId, epochId, graphDigest: graph.digest, fundingTxid: graph.fundingTxid, finalizationDigest: epoch.finalization.finalizationDigest,
    ceremonyStateDigest: row.state_digest.toString('hex'),
    retainedEpochsDigest: commitmentDigest('vault/presigned-graph-v2/restored-epochs', epochs.map(item => ({ epochId: item.epoch_id,
      ordinal: item.ordinal, snapshotDigest: item.snapshot_digest.toString('hex') }))),
    // Authentication counters and last-used timestamps legitimately advance
    // after a restore drill. The actual key/ciphertext and ownership cannot.
    custodyMaterialDigest: commitmentDigest('vault/presigned-graph-v2/restored-custody', custody) });
}

/** Read-only proof producer. The CLI separately enforces protected TLS endpoints. */
export async function verifyPresignedFundingDatabaseRestore(input: {
  source: Sql; restored: Sql; vaultId: string; epochId: string;
  sourceEndpointFingerprint: string; restoredEndpointFingerprint: string;
}) {
  async function capture(connection: Sql) {
    return connection.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async sql => ({
      identity: await captureDatabaseRuntimeIdentity(sql),
      snapshot: await captureDatabaseSnapshotInTransaction(sql),
      funding: await readPresignedFundingRestoreBinding(sql, input.vaultId, input.epochId),
    }));
  }
  const source = await capture(input.source); const restored = await capture(input.restored);
  assert(source.identity.databaseName !== restored.identity.databaseName && source.identity.fingerprint !== restored.identity.fingerprint &&
    input.sourceEndpointFingerprint !== input.restoredEndpointFingerprint, 'V2 funding restore needs distinct actual source and restored databases');
  const checks = [{ name: 'source and restored databases are distinct protected endpoints and server-reported identities', ok: true },
    ...compareDatabaseSnapshots(source.snapshot, restored.snapshot)];
  assert(checks.every(check => check.ok), 'V2 restore did not reproduce the exact complete schema and application rows');
  const createdAt = new Date().toISOString();
  const databaseRestore = createDatabaseRestoreReceipt({ createdAt,
    sourceEndpointFingerprint: input.sourceEndpointFingerprint, restoredEndpointFingerprint: input.restoredEndpointFingerprint,
    sourceDatabaseIdentityFingerprint: source.identity.fingerprint, restoredDatabaseIdentityFingerprint: restored.identity.fingerprint,
    sourceSnapshot: source.snapshot, restoredSnapshot: restored.snapshot, checks });
  return createPresignedFundingRestoreReceipt({ createdAt, databaseRestore, sourceFunding: source.funding, restoredFunding: restored.funding });
}
