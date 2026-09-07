import 'server-only';
import { Buffer } from 'buffer';
import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { BITCOIN_NETWORK_NAME } from '../../../src/network.js';
import {
  applyPresignedAction, assertPresignedFundingObservation, currentPresignedEpoch,
  newPresignedCeremony, presignedActionDigest, presignedRestartStateDigest, presignedWalletSigningReady,
  validatePresignedAction, type PresignedAction, type PresignedCeremonySettings, type PresignedCeremonyState,
  type PresignedEligibleCredentials, type PresignedFundingInputVerifier,
} from '../../../src/presigned/ceremony.js';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, type ParticipantId } from '../../../src/presigned/types.js';
import { assert, canonicalJson, commitmentDigest, exactKeys, identifier, sameCanonical } from '../../../src/presigned/validation.js';
import { db, transaction } from './db';
import { consumeRateLimit } from './rate-limit';
import type { StoredCredential } from './webauthn-store';

const STATE_DOMAIN = 'vault/presigned-graph-v2/ceremony/state';
const EPOCH_DOMAIN = 'vault/presigned-graph-v2/ceremony/epoch';
interface Membership { vaultId: string; participantId: ParticipantId; vaultStatus: string }
interface CeremonyRow { settings_json: PresignedCeremonySettings; settings_digest: Buffer;
  state_json: PresignedCeremonyState; state_digest: Buffer }

export interface PresignedActionChallenge {
  id: string;
  challenge: string;
  vaultId: string;
  participantId: ParticipantId;
  protocol: typeof PRESIGNED_PROTOCOL;
  action: PresignedAction;
  actionDigest: string;
  credential: StoredCredential;
  expiresAt: string;
}
export interface PresignedActionDependencies {
  /** Required at options and finish for commit-funding-input. It must query the private chain backend. */
  verifyFundingInput?: PresignedFundingInputVerifier;
}

/** Private creation boundary: the caller must first explicitly create vaults.protocol as V2. */
export async function initializePresignedCeremony(input: {
  vaultId: string; settings: PresignedCeremonySettings;
}): Promise<void> {
  identifier(input.vaultId, 'ceremony vault');
  assert(input.settings.network === BITCOIN_NETWORK_NAME, 'ceremony network differs from this deployment');
  const state = newPresignedCeremony(input.vaultId, input.settings);
  await transaction(async sql => {
    const rows = await sql<Array<{ protocol: string; status: string }>>`
      SELECT protocol, status FROM vaults WHERE id = ${input.vaultId}::uuid FOR UPDATE
    `;
    assert(rows[0]?.protocol === PRESIGNED_PROTOCOL, 'presigned ceremony requires an explicitly created V2 vault');
    assert(rows[0].status === 'setup', 'only an unfunded setup vault can initialize settings');
    await sql`
      INSERT INTO presigned_ceremonies (vault_id, settings_json, settings_digest, state_json, state_digest)
      VALUES (${input.vaultId}::uuid, ${sql.json(json(state.settings))}, ${hex(state.settingsDigest)},
        ${sql.json(json(state))}, ${hex(commitmentDigest(STATE_DOMAIN, state))})
      ON CONFLICT (vault_id) DO NOTHING
    `;
    const persisted = await loadState(sql, input.vaultId);
    assert(persisted.settingsDigest === state.settingsDigest, 'another immutable settings commitment already exists');
  });
}

export async function getPresignedCeremonyStatus(userId: string) {
  return transaction(async sql => {
    const membership = await membershipForUser(sql, userId, false);
    const state = await loadState(sql, membership.vaultId);
    const eligibleCredentials = await eligibleCredentialIds(sql, membership.vaultId);
    return statusFor(state, membership, eligibleCredentials);
  });
}

export async function createPresignedActionChallenge(input: {
  userId: string; credentialId: string; challenge: string; action: PresignedAction;
}, dependencies: PresignedActionDependencies = {}): Promise<PresignedActionChallenge> {
  const action = validatePresignedAction(input.action);
  assert(typeof input.challenge === 'string' && /^[A-Za-z0-9_-]{16,2048}$/u.test(input.challenge), 'invalid WebAuthn challenge');
  await consumeRateLimit({ action: 'presigned_action', subject: input.userId, limit: 80, windowSeconds: 900 });
  return transaction(async sql => {
    const membership = await membershipForUser(sql, input.userId, true);
    assertSetupVault(membership);
    const state = await loadState(sql, membership.vaultId);
    const eligibleCredentials = await eligibleCredentialIds(sql, membership.vaultId);
    const credential = await selectedCredential(sql, input.userId, input.credentialId, membership);
    await validateIdentityRegistration(sql, input.userId, action);
    await verifyInputObservation(action, state, dependencies);
    // Preview invokes precisely the same state and backup gates as finish, while holding the vault lock.
    applyPresignedAction({ state, action, participantId: membership.participantId,
      credentialId: credential.id, eligibleCredentials, nextEpochId: randomUUID() });
    await sql`
      UPDATE presigned_action_challenges SET invalidated_at = now()
      WHERE vault_id = ${membership.vaultId}::uuid AND user_id = ${input.userId}::uuid
        AND consumed_at IS NULL AND invalidated_at IS NULL
    `;
    const actionDigest = presignedActionDigest(action);
    const rows = await sql<Array<{ id: string; expires_at: Date }>>`
      INSERT INTO presigned_action_challenges (vault_id, user_id, participant_id, credential_id,
        credential_counter, kind, action_json, action_digest, challenge, expires_at)
      VALUES (${membership.vaultId}::uuid, ${input.userId}::uuid, ${membership.participantId}, ${credential.id},
        ${credential.counter}, ${action.kind}, ${sql.json(json(action))}, ${hex(actionDigest)},
        ${input.challenge}, now() + interval '5 minutes')
      RETURNING id, expires_at
    `;
    return { id: rows[0]!.id, challenge: input.challenge, vaultId: membership.vaultId,
      participantId: membership.participantId, protocol: PRESIGNED_PROTOCOL, action, actionDigest,
      credential, expiresAt: rows[0]!.expires_at.toISOString() };
  });
}

export async function getPresignedActionChallenge(input: {
  userId: string; challengeId: string;
}): Promise<PresignedActionChallenge> {
  identifier(input.challengeId, 'action challenge');
  return transaction(sql => loadChallenge(sql, input.userId, input.challengeId, false));
}

/** The HTTP route must independently verify UV, RP ID, origin and exact challenge before calling this. */
export async function completePresignedAction(challenge: PresignedActionChallenge, newCounter: number,
  dependencies: PresignedActionDependencies = {}) {
  assert(Number.isSafeInteger(newCounter) && newCounter >= 0, 'invalid passkey counter');
  return transaction(async sql => {
    const membership = await membershipForUser(sql, challenge.credential.userId, true);
    assertSetupVault(membership);
    assert(membership.vaultId === challenge.vaultId && membership.participantId === challenge.participantId,
      'action changed vault membership');
    const current = await loadChallenge(sql, challenge.credential.userId, challenge.id, true);
    assert(challenge.protocol === PRESIGNED_PROTOCOL &&
      ((current.credential.counter === 0 && newCounter === 0) || newCounter > current.credential.counter),
    'passkey counter must advance unless the authenticator uses zero counters');
    assert(current.actionDigest === challenge.actionDigest && current.challenge === challenge.challenge &&
      current.credential.id === challenge.credential.id && current.credential.counter === challenge.credential.counter &&
      Buffer.from(current.credential.publicKey).equals(Buffer.from(challenge.credential.publicKey)), 'action challenge changed before completion');
    sameCanonical(current.action, challenge.action, 'approved action payload');
    assert(current.actionDigest === presignedActionDigest(challenge.action), 'approved action digest changed');
    const state = await loadState(sql, membership.vaultId);
    const eligibleCredentials = await eligibleCredentialIds(sql, membership.vaultId);
    await validateIdentityRegistration(sql, current.credential.userId, current.action);
    await verifyInputObservation(current.action, state, dependencies);
    const next = applyPresignedAction({ state, action: current.action, participantId: membership.participantId,
      credentialId: current.credential.id, eligibleCredentials, nextEpochId: randomUUID() });
    const consumed = await sql<Array<{ id: string }>>`
      UPDATE presigned_action_challenges SET consumed_at = now()
      WHERE id = ${current.id}::uuid AND user_id = ${current.credential.userId}::uuid
        AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > now()
        AND action_digest = ${hex(current.actionDigest)} AND credential_id = ${current.credential.id}
      RETURNING id
    `;
    assert(consumed.length === 1, 'action challenge already used, superseded or expired');
    const changed = await sql<Array<{ credential_id: string }>>`
      UPDATE webauthn_credentials SET counter = ${newCounter}, last_used_at = now()
      WHERE credential_id = ${current.credential.id} AND user_id = ${current.credential.userId}::uuid
        AND prf_enabled = true AND counter = ${current.credential.counter}
      RETURNING credential_id
    `;
    assert(changed.length === 1, 'passkey counter changed before action completion');
    await persistState(sql, next);
    const stateDigest = commitmentDigest(STATE_DOMAIN, next);
    await sql`
      INSERT INTO presigned_action_events (challenge_id, vault_id, user_id, participant_id, credential_id,
        action_digest, action_json, resulting_state_digest)
      VALUES (${current.id}::uuid, ${membership.vaultId}::uuid, ${current.credential.userId}::uuid,
        ${membership.participantId}, ${current.credential.id}, ${hex(current.actionDigest)},
        ${sql.json(json(current.action))}, ${hex(stateDigest)})
    `;
    const ready = presignedWalletSigningReady(next, eligibleCredentials);
    const vaultStatus = ready ? 'ready' : next.rosterApprovals.length === 3 ? 'roster_confirmed' : 'setup';
    await sql`UPDATE vaults SET status = ${vaultStatus} WHERE id = ${membership.vaultId}::uuid AND protocol = ${PRESIGNED_PROTOCOL}`;
    return statusFor(next, { ...membership, vaultStatus }, eligibleCredentials);
  });
}

function statusFor(state: PresignedCeremonyState, membership: Membership, eligible: PresignedEligibleCredentials) {
  const epoch = currentPresignedEpoch(state);
  const walletSigningReady = !['active', 'closed'].includes(membership.vaultStatus) && presignedWalletSigningReady(state, eligible);
  const participantWalletSigningStarted = epoch?.walletSigningStarted.includes(membership.participantId) ?? false;
  const fundingPsbtReleased = walletSigningReady && participantWalletSigningStarted;
  const phase = epoch?.status === 'approved' ? 'funding-approved'
    : epoch?.finalization ? 'funding-approvals'
    : walletSigningReady ? 'wallet-signing'
    : epoch?.preauthorizations.length === 12 ? 'backup-verification'
    : epoch?.graph ? 'preauthorizations'
    : epoch ? 'funding-inputs'
    : state.roster ? 'roster-confirmation' : 'identity-registration';
  return { version: 2 as const, protocol: PRESIGNED_PROTOCOL, vaultId: state.vaultId,
    participantId: membership.participantId, vaultStatus: membership.vaultStatus, phase,
    settings: state.settings, settingsDigest: state.settingsDigest, identities: state.identities,
    roster: state.roster, rosterDigest: state.rosterDigest, rosterApprovals: state.rosterApprovals,
    epoch, walletSigningReady, participantWalletSigningStarted, fundingPsbtReleased,
    // This is an application gate. Public graph commitments independently reproduce the unsigned PSBT.
    fundingPsbtBase64: fundingPsbtReleased ? epoch!.graph!.fundingPsbtBase64 : null,
    restartStateDigest: presignedRestartStateDigest(state),
    epochHistory: state.epochs.map(item => ({ epochId: item.epochId, status: item.status,
      graphDigest: item.graph?.digest ?? null, fundingTxid: item.graph?.fundingTxid ?? null })),
  };
}
export type PresignedCeremonyStatus = Awaited<ReturnType<typeof getPresignedCeremonyStatus>>;

async function membershipForUser(sql: TransactionSql, userId: string, lock: boolean): Promise<Membership> {
  identifier(userId, 'ceremony user');
  const rows = lock ? await sql<Array<{ vault_id: string; participant_id: ParticipantId; status: string; protocol: string }>>`
    SELECT m.vault_id, m.participant_id, v.status, v.protocol FROM vault_members m
    JOIN vaults v ON v.id = m.vault_id WHERE m.user_id = ${userId}::uuid FOR UPDATE OF v
  ` : await sql<Array<{ vault_id: string; participant_id: ParticipantId; status: string; protocol: string }>>`
    SELECT m.vault_id, m.participant_id, v.status, v.protocol FROM vault_members m
    JOIN vaults v ON v.id = m.vault_id WHERE m.user_id = ${userId}::uuid
  `;
  assert(rows.length === 1 && rows[0]!.protocol === PRESIGNED_PROTOCOL, 'exactly one V2 vault membership is required');
  return { vaultId: rows[0]!.vault_id, participantId: rows[0]!.participant_id, vaultStatus: rows[0]!.status };
}
function assertSetupVault(membership: Membership): void {
  assert(['setup', 'roster_confirmed', 'ready'].includes(membership.vaultStatus), 'funded or closed vault cannot change its setup ceremony');
}
async function loadState(sql: TransactionSql, vaultId: string): Promise<PresignedCeremonyState> {
  const rows = await sql<CeremonyRow[]>`
    SELECT settings_json, settings_digest, state_json, state_digest FROM presigned_ceremonies
    WHERE vault_id = ${vaultId}::uuid AND protocol = ${PRESIGNED_PROTOCOL}
  `;
  const row = rows[0];
  assert(row, 'V2 immutable ceremony settings have not been initialized');
  const state = row.state_json;
  exactKeys(state, ['version', 'protocol', 'vaultId', 'settings', 'settingsDigest', 'identities', 'roster', 'rosterDigest', 'rosterApprovals', 'epochs'], 'persisted ceremony state');
  assert(state.version === 2 && state.protocol === PRESIGNED_PROTOCOL && state.vaultId === vaultId,
    'persisted ceremony protocol differs from its vault');
  sameCanonical(state.settings, row.settings_json, 'persisted ceremony settings');
  const rebuilt = newPresignedCeremony(vaultId, row.settings_json);
  assert(state.settingsDigest === row.settings_digest.toString('hex') && state.settingsDigest === rebuilt.settingsDigest,
    'persisted ceremony settings digest changed');
  assert(commitmentDigest(STATE_DOMAIN, state) === row.state_digest.toString('hex'), 'persisted ceremony state digest changed');
  assert(state.settings.network === BITCOIN_NETWORK_NAME, 'stored ceremony belongs to another deployment network');
  assert(Array.isArray(state.epochs) && state.epochs.length <= 64 &&
    state.epochs.filter(epoch => epoch.status !== 'retired').length <= 1, 'persisted ceremony has inconsistent epoch history');
  for (const epoch of state.epochs) {
    assert(Array.isArray(epoch.walletSigningStarted) && epoch.walletSigningStarted.length <= 3 &&
      new Set(epoch.walletSigningStarted).size === epoch.walletSigningStarted.length &&
      epoch.walletSigningStarted.every(id => PARTICIPANT_IDS.includes(id)) &&
      (epoch.status !== 'retired' || epoch.walletSigningStarted.length === 0), 'persisted wallet-signing intent is inconsistent');
  }
  return state;
}
async function persistState(sql: TransactionSql, state: PresignedCeremonyState): Promise<void> {
  await sql`
    UPDATE presigned_ceremonies SET state_json = ${sql.json(json(state))},
      state_digest = ${hex(commitmentDigest(STATE_DOMAIN, state))}, updated_at = now()
    WHERE vault_id = ${state.vaultId}::uuid AND protocol = ${PRESIGNED_PROTOCOL}
  `;
  for (const [index, epoch] of state.epochs.entries()) {
    await sql`
      INSERT INTO presigned_funding_epochs (epoch_id, vault_id, ordinal, status, graph_digest,
        funding_txid, snapshot_json, snapshot_digest)
      VALUES (${epoch.epochId}::uuid, ${state.vaultId}::uuid, ${index + 1}, ${epoch.status},
        ${epoch.graph ? hex(epoch.graph.digest) : null}, ${epoch.graph ? hex(epoch.graph.fundingTxid) : null},
        ${sql.json(json(epoch))}, ${hex(commitmentDigest(EPOCH_DOMAIN, epoch))})
      ON CONFLICT (epoch_id) DO UPDATE SET status = EXCLUDED.status, graph_digest = EXCLUDED.graph_digest,
        funding_txid = EXCLUDED.funding_txid, snapshot_json = EXCLUDED.snapshot_json,
        snapshot_digest = EXCLUDED.snapshot_digest, updated_at = now()
    `;
  }
}
async function eligibleCredentialIds(sql: TransactionSql, vaultId: string): Promise<PresignedEligibleCredentials> {
  const rows = await sql<Array<{ participant_id: ParticipantId; credential_id: string }>>`
    SELECT m.participant_id, c.credential_id FROM vault_members m
    JOIN webauthn_credentials c ON c.user_id = m.user_id AND c.prf_enabled = true
    JOIN passkey_envelopes e ON e.credential_id = c.credential_id
    WHERE m.vault_id = ${vaultId}::uuid ORDER BY m.participant_id, c.created_at, c.credential_id
  `;
  return Object.fromEntries(PARTICIPANT_IDS.map(id => [id, rows.filter(row => row.participant_id === id)
    .map(row => row.credential_id)])) as PresignedEligibleCredentials;
}
async function selectedCredential(sql: TransactionSql, userId: string, credentialId: string, membership: Membership): Promise<StoredCredential> {
  const rows = await sql<Array<{ credential_id: string; credential_name: string; public_key: Buffer; counter: string; transports: StoredCredential['transports'] }>>`
    SELECT c.credential_id, c.credential_name, c.public_key, c.counter::text, c.transports
    FROM webauthn_credentials c JOIN passkey_envelopes e ON e.credential_id = c.credential_id
    WHERE c.user_id = ${userId}::uuid AND c.credential_id = ${credentialId} AND c.prf_enabled = true
  `;
  const row = rows[0]; assert(row, 'selected passkey lacks a stored PRF envelope');
  const counter = Number(row.counter); assert(Number.isSafeInteger(counter) && counter >= 0, 'stored passkey counter is invalid');
  return { id: row.credential_id, name: row.credential_name, userId, publicKey: Uint8Array.from(row.public_key),
    counter, transports: row.transports, vaultId: membership.vaultId, participantId: membership.participantId };
}
async function loadChallenge(sql: TransactionSql, userId: string, challengeId: string, lock: boolean): Promise<PresignedActionChallenge> {
  const select = lock ? sql`FOR UPDATE OF a` : sql``;
  const rows = await sql<Array<{ id: string; vault_id: string; participant_id: ParticipantId; credential_id: string;
    credential_counter: string; action_json: PresignedAction; action_digest: Buffer; challenge: string; expires_at: Date }>>`
    SELECT a.id, a.vault_id, a.participant_id, a.credential_id, a.credential_counter::text,
      a.action_json, a.action_digest, a.challenge, a.expires_at
    FROM presigned_action_challenges a JOIN vaults v ON v.id = a.vault_id AND v.protocol = a.protocol
    JOIN vault_members m ON m.vault_id = a.vault_id AND m.user_id = a.user_id AND m.participant_id = a.participant_id
    WHERE a.id = ${challengeId}::uuid AND a.user_id = ${userId}::uuid AND a.protocol = ${PRESIGNED_PROTOCOL}
      AND a.consumed_at IS NULL AND a.invalidated_at IS NULL AND a.expires_at > now()
    ${select}
  `;
  const row = rows[0]; assert(row, 'action challenge is unavailable, expired, used or superseded');
  const action = validatePresignedAction(row.action_json);
  const actionDigest = presignedActionDigest(action);
  assert(actionDigest === row.action_digest.toString('hex'), 'stored action payload digest changed');
  const credential = await selectedCredential(sql, userId, row.credential_id,
    { vaultId: row.vault_id, participantId: row.participant_id, vaultStatus: 'setup' });
  assert(credential.counter === Number(row.credential_counter), 'passkey counter changed after action challenge');
  return { id: row.id, challenge: row.challenge, vaultId: row.vault_id, participantId: row.participant_id,
    protocol: PRESIGNED_PROTOCOL, action, actionDigest, credential, expiresAt: row.expires_at.toISOString() };
}
async function validateIdentityRegistration(sql: TransactionSql, userId: string, action: PresignedAction): Promise<void> {
  if (action.kind !== 'register-identity') return;
  const rows = await sql<Array<{ personal_public_key: Buffer; payout_xonly_public_key: Buffer }>>`
    SELECT personal_public_key, payout_xonly_public_key FROM participant_key_material WHERE user_id = ${userId}::uuid
  `;
  assert(rows.length === 1 && rows[0]!.personal_public_key.toString('hex') === action.identity.personalPublicKeyHex &&
    rows[0]!.payout_xonly_public_key.toString('hex') === action.identity.payoutXonlyPublicKeyHex,
  'V2 registration does not match the existing passkey-held public identity');
}
async function verifyInputObservation(action: PresignedAction, state: PresignedCeremonyState,
  dependencies: PresignedActionDependencies): Promise<void> {
  if (action.kind !== 'commit-funding-input') return;
  assert(typeof dependencies.verifyFundingInput === 'function', 'independent private-chain input verifier is required');
  const observed = await dependencies.verifyFundingInput({ network: state.settings.network,
    genesisHash: state.settings.genesisHash, input: structuredClone(action.input) });
  assertPresignedFundingObservation(action.input, state.settings, observed);
}
function hex(value: string): Buffer { return Buffer.from(value, 'hex'); }
function json(value: unknown): Record<string, never> { return JSON.parse(canonicalJson(value)) as Record<string, never>; }
