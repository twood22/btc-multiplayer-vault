import 'server-only';
import { Buffer } from 'buffer';
import type { TransactionSql } from 'postgres';
import { BITCOIN_NETWORK_NAME } from '../../../src/network.js';
import { applyPresignedRuntimeAction, buildPresignedRuntimeProposal, buildPresignedRuntimeReanchor, presignedRuntimeActionDigest,
  presignedRuntimeBroadcastReady, validatePresignedRuntimeAction, validatePresignedRuntimeProposal,
  type PresignedRuntimeAction, type PresignedRuntimeCoinObserver, type PresignedRuntimeProposal,
  type PresignedRuntimeState } from '../../../src/presigned/runtime.js';
import { validatePresignedGraph } from '../../../src/presigned/graph.js';
import { verifyPreauthorizations } from '../../../src/presigned/signing.js';
import { PRESIGNED_PROTOCOL, type ParticipantId, type PresignedGraph, type PresignedPublicKit } from '../../../src/presigned/types.js';
import { assert, canonicalJson, commitmentDigest, exactKeys, identifier, safeInteger, sameCanonical } from '../../../src/presigned/validation.js';
import { transaction } from './db';
import { consumeRateLimit } from './rate-limit';
import type { StoredCredential } from './webauthn-store';

const STATE_DOMAIN = 'vault/presigned-graph-v2/runtime/state';
interface Membership { vaultId: string; participantId: ParticipantId; vaultStatus: string }
interface StateRow { id: string; vault_id: string; epoch_id: string; graph_digest: Buffer;
  proposal_digest: Buffer; proposal_json: PresignedRuntimeProposal; state_json: PresignedRuntimeState; state_digest: Buffer }
export interface PresignedRuntimeActionDependencies {
  requiredConfirmations: number;
  /** Must query the private validating Core backend; never accept a browser observation or cached DB truth flag. */
  observeCoin: PresignedRuntimeCoinObserver;
}
export interface PresignedRuntimeActionChallenge {
  id: string;
  challenge: string;
  vaultId: string;
  participantId: ParticipantId;
  protocol: typeof PRESIGNED_PROTOCOL;
  action: PresignedRuntimeAction;
  actionDigest: string;
  proposal: PresignedRuntimeProposal;
  credential: StoredCredential;
  expiresAt: string;
}

/** Stored coordination only. This response does not claim that any source is currently confirmed or unspent. */
export async function getPresignedRuntimeStatus(userId: string) {
  return transaction(async sql => {
    const membership = await membershipForUser(sql, userId, false);
    const epochs = await sql<Array<{ epoch_id: string; status: string; graph_digest: Buffer; snapshot_json: { graph: PresignedGraph | null; preauthorizations: PresignedPublicKit['preauthorizations'] } }>>`
      SELECT epoch_id,status,graph_digest,snapshot_json FROM presigned_funding_epochs
      WHERE vault_id=${membership.vaultId}::uuid AND protocol=${PRESIGNED_PROTOCOL} AND graph_digest IS NOT NULL ORDER BY ordinal
    `;
    const kits = epochs.filter(row => row.snapshot_json.preauthorizations.length === 12).map(row => ({
      epochId: row.epoch_id, epochStatus: row.status,
      publicKit: validatedKit(membership.vaultId, row.epoch_id, row.graph_digest.toString('hex'), row.snapshot_json),
    }));
    const rows = await sql<StateRow[]>`
      SELECT id,vault_id,epoch_id,graph_digest,proposal_digest,proposal_json,state_json,state_digest
      FROM presigned_runtime_proposals WHERE vault_id=${membership.vaultId}::uuid AND protocol=${PRESIGNED_PROTOCOL}
      ORDER BY created_at,id
    `;
    const proposals = rows.map(row => {
      const state = readState(row);
      const kit = kits.find(item => item.epochId === state.proposal.epochId && item.publicKit.graph.digest === state.proposal.graphDigest);
      assert(kit, 'runtime proposal lost its retained graph and public preauthorizations');
      validatePresignedRuntimeProposal(kit.publicKit.graph, state.proposal);
      return { ...state, broadcastReady: presignedRuntimeBroadcastReady(state) };
    });
    return { version: 2 as const, protocol: PRESIGNED_PROTOCOL, ...membership,
      chainAuthority: 'not-checked-in-status' as const, kits, proposals,
      broadcastAvailable: false as const };
  });
}
export type PresignedRuntimeStatus = Awaited<ReturnType<typeof getPresignedRuntimeStatus>>;

export async function createPresignedRuntimeActionChallenge(input: {
  userId: string; credentialId: string; challenge: string; action: PresignedRuntimeAction;
}, dependencies: PresignedRuntimeActionDependencies): Promise<PresignedRuntimeActionChallenge> {
  const action = validatePresignedRuntimeAction(input.action);
  validateDependencies(dependencies);
  assert(typeof input.challenge === 'string' && /^[A-Za-z0-9_-]{16,2048}$/u.test(input.challenge), 'invalid runtime WebAuthn challenge');
  await consumeRateLimit({ action: 'presigned_runtime_action', subject: input.userId, limit: 120, windowSeconds: 900 });
  return transaction(async sql => {
    const membership = await membershipForUser(sql, input.userId, true);
    const credential = await selectedCredential(sql, input.userId, input.credentialId, membership);
    const { next } = await evaluate(sql, membership, action, dependencies);
    await sql`UPDATE presigned_runtime_action_challenges SET invalidated_at=now()
      WHERE vault_id=${membership.vaultId}::uuid AND user_id=${input.userId}::uuid AND consumed_at IS NULL AND invalidated_at IS NULL`;
    const actionDigest = presignedRuntimeActionDigest(action);
    const rows = await sql<Array<{ id: string; expires_at: Date }>>`
      INSERT INTO presigned_runtime_action_challenges(vault_id,user_id,participant_id,credential_id,credential_counter,
        proposal_id,proposal_digest,proposal_json,action_json,action_digest,challenge,expires_at)
      VALUES (${membership.vaultId}::uuid,${input.userId}::uuid,${membership.participantId},${credential.id},${credential.counter},
        ${action.proposalId}::uuid,${hex(next.proposal.digest)},${sql.json(json(next.proposal))},${sql.json(json(action))},
        ${hex(actionDigest)},${input.challenge},now()+interval '5 minutes') RETURNING id,expires_at
    `;
    return { id: rows[0]!.id, expiresAt: rows[0]!.expires_at.toISOString(), challenge: input.challenge,
      vaultId: membership.vaultId, participantId: membership.participantId, protocol: PRESIGNED_PROTOCOL,
      action, actionDigest, proposal: next.proposal, credential };
  });
}
export async function getPresignedRuntimeActionChallenge(input: { userId: string; challengeId: string }): Promise<PresignedRuntimeActionChallenge> {
  identifier(input.challengeId, 'runtime action challenge');
  return transaction(sql => loadChallenge(sql, input.userId, input.challengeId, false));
}

/** Route verifies exact assertion credential, UV, RP ID, origin and challenge before entering this transaction. */
export async function completePresignedRuntimeAction(challenge: PresignedRuntimeActionChallenge, newCounter: number,
  dependencies: PresignedRuntimeActionDependencies) {
  validateDependencies(dependencies);
  assert(Number.isSafeInteger(newCounter) && newCounter >= 0, 'invalid runtime passkey counter');
  return transaction(async sql => {
    const membership = await membershipForUser(sql, challenge.credential.userId, true);
    assert(challenge.protocol === PRESIGNED_PROTOCOL && membership.vaultId === challenge.vaultId && membership.participantId === challenge.participantId,
      'runtime action changed its vault membership');
    const current = await loadChallenge(sql, challenge.credential.userId, challenge.id, true);
    assert(current.challenge === challenge.challenge && current.actionDigest === challenge.actionDigest && current.credential.id === challenge.credential.id &&
      current.credential.counter === challenge.credential.counter && Buffer.from(current.credential.publicKey).equals(Buffer.from(challenge.credential.publicKey)),
    'runtime action challenge changed before completion');
    assert((current.credential.counter === 0 && newCounter === 0) || newCounter > current.credential.counter, 'runtime passkey counter must advance unless both counters are zero');
    sameCanonical(current.action, challenge.action, 'approved runtime action');
    sameCanonical(current.proposal, challenge.proposal, 'approved runtime proposal');
    const { next } = await evaluate(sql, membership, current.action, dependencies);
    sameCanonical(next.proposal, current.proposal, 'runtime proposal preview and finish');
    const consumed = await sql<Array<{ id: string }>>`
      UPDATE presigned_runtime_action_challenges SET consumed_at=now()
      WHERE id=${current.id}::uuid AND user_id=${current.credential.userId}::uuid AND credential_id=${current.credential.id}
        AND action_digest=${hex(current.actionDigest)} AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at>now()
      RETURNING id
    `;
    assert(consumed.length === 1, 'runtime challenge was used, superseded or expired');
    const counters = await sql<Array<{ credential_id: string }>>`
      UPDATE webauthn_credentials SET counter=${newCounter},last_used_at=now()
      WHERE credential_id=${current.credential.id} AND user_id=${current.credential.userId}::uuid
        AND counter=${current.credential.counter} AND prf_enabled=true RETURNING credential_id
    `;
    assert(counters.length === 1, 'runtime passkey counter changed during completion');
    await persistState(sql, membership.vaultId, next);
    if (current.action.kind === 'contribute-nonce') {
      await sql`INSERT INTO presigned_runtime_nonce_commitments(proposal_id,vault_id,user_id,participant_id,public_nonce,contribution_json)
        VALUES (${next.proposal.proposalId}::uuid,${membership.vaultId}::uuid,${current.credential.userId}::uuid,
          ${membership.participantId},${hex(current.action.publicNonce.pubnonce)},${sql.json(json(current.action.publicNonce))})`;
    }
    await sql`INSERT INTO presigned_runtime_action_events(challenge_id,vault_id,user_id,participant_id,credential_id,
      proposal_id,action_digest,action_json,resulting_state_digest)
      VALUES (${current.id}::uuid,${membership.vaultId}::uuid,${current.credential.userId}::uuid,${membership.participantId},
        ${current.credential.id},${next.proposal.proposalId}::uuid,${hex(current.actionDigest)},${sql.json(json(current.action))},
        ${hex(commitmentDigest(STATE_DOMAIN,next))})`;
    return { version: 2 as const, protocol: PRESIGNED_PROTOCOL, vaultId: membership.vaultId,
      participantId: membership.participantId, proposal: next, broadcastReady: presignedRuntimeBroadcastReady(next),
      broadcastAvailable: false as const };
  });
}

async function evaluate(sql: TransactionSql, membership: Membership, action: PresignedRuntimeAction,
  dependencies: PresignedRuntimeActionDependencies): Promise<{ next: PresignedRuntimeState }> {
  let state: PresignedRuntimeState | null; let graph: PresignedGraph; let proposal: PresignedRuntimeProposal;
  if (action.kind === 'create-proposal' || action.kind === 'reanchor-transaction') {
    const existing = await sql`SELECT id FROM presigned_runtime_proposals WHERE id=${action.proposalId}::uuid`;
    assert(existing.length === 0, 'runtime proposal IDs cannot be reused, including abandoned proposals');
  }
  if (action.kind === 'create-proposal') {
    graph = (await loadKit(sql, membership.vaultId, action.epochId, action.graphDigest)).graph;
    proposal = buildPresignedRuntimeProposal({ graph, action, participantId: membership.participantId });
    const slot = await sql`SELECT id FROM presigned_runtime_proposals WHERE vault_id=${membership.vaultId}::uuid
      AND source_txid=${hex(proposal.source.txid)} AND source_vout=${proposal.source.vout}
      AND slot=${proposal.slot} AND status='collecting'`;
    assert(slot.length === 0, 'this source coordination slot already has an unfinished proposal; choose or abandon it explicitly');
    state = null;
  } else {
    const lookupId = action.kind === 'reanchor-transaction' ? action.predecessorProposalId : action.proposalId;
    const rows = await sql<StateRow[]>`SELECT id,vault_id,epoch_id,graph_digest,proposal_digest,proposal_json,state_json,state_digest
      FROM presigned_runtime_proposals WHERE id=${lookupId}::uuid AND vault_id=${membership.vaultId}::uuid AND protocol=${PRESIGNED_PROTOCOL}`;
    assert(rows.length === 1, 'runtime proposal is missing from this vault');
    state = readState(rows[0]!); proposal = state.proposal;
    graph = (await loadKit(sql, membership.vaultId, proposal.epochId, proposal.graphDigest)).graph;
    if (action.kind === 'reanchor-transaction') proposal = buildPresignedRuntimeReanchor({
      graph,predecessor: state,action,participantId: membership.participantId });
    if (action.kind === 'contribute-nonce') {
      const reused = await sql`SELECT proposal_id FROM presigned_runtime_nonce_commitments WHERE public_nonce=${hex(action.publicNonce.pubnonce)}`;
      assert(reused.length === 0, 'public nonce was already committed; a fresh proposal requires fresh client nonces');
    }
  }
  const observation = action.kind === 'abandon-proposal' ? null : await dependencies.observeCoin({
    network: graph.roster.network, genesisHash: graph.roster.genesisHash, source: structuredClone(proposal.source) });
  return { next: applyPresignedRuntimeAction({ graph, state, action, participantId: membership.participantId,
    observation, requiredConfirmations: dependencies.requiredConfirmations }) };
}

async function loadKit(sql: TransactionSql, vaultId: string, epochId: string, graphDigest: string): Promise<PresignedPublicKit> {
  const rows = await sql<Array<{ snapshot_json: { graph: PresignedGraph | null; preauthorizations: PresignedPublicKit['preauthorizations'] } }>>`
    SELECT snapshot_json FROM presigned_funding_epochs WHERE vault_id=${vaultId}::uuid AND epoch_id=${epochId}::uuid
      AND protocol=${PRESIGNED_PROTOCOL} AND graph_digest=${hex(graphDigest)}
  `;
  assert(rows.length === 1, 'runtime requires an exact retained frozen graph');
  // A graph confirmed outside the application may belong to an unapproved or retired epoch.
  return validatedKit(vaultId, epochId, graphDigest, rows[0]!.snapshot_json);
}
function validatedKit(vaultId: string, epochId: string, graphDigest: string,
  snapshot: { graph: PresignedGraph | null; preauthorizations: PresignedPublicKit['preauthorizations'] }): PresignedPublicKit {
  assert(snapshot.graph, 'runtime graph is missing');
  const graph = validatePresignedGraph(snapshot.graph);
  assert(graph.roster.vaultId === vaultId && graph.funding.epochId === epochId && graph.digest === graphDigest &&
    graph.roster.network === BITCOIN_NETWORK_NAME, 'runtime graph changed vault, epoch, digest or deployment network');
  return { version: 2, protocol: PRESIGNED_PROTOCOL, graph, preauthorizations: verifyPreauthorizations(graph, snapshot.preauthorizations, true) };
}
function readState(row: StateRow): PresignedRuntimeState {
  const state = row.state_json;
  exactKeys(state, ['version','protocol','proposal','status','publicNonces','nonceSetDigest','partials','recoveryContributions',
    'finalized','broadcastApprovals','abandonedByParticipantId','abandonReason'], 'persisted runtime state');
  assert(state.version === 2 && state.protocol === PRESIGNED_PROTOCOL && state.proposal.proposalId === row.id &&
    state.proposal.epochId === row.epoch_id && state.proposal.graphDigest === row.graph_digest.toString('hex') &&
    state.proposal.digest === row.proposal_digest.toString('hex'), 'persisted runtime identity changed');
  sameCanonical(state.proposal, row.proposal_json, 'persisted runtime proposal');
  assert(commitmentDigest(STATE_DOMAIN,state) === row.state_digest.toString('hex'), 'persisted runtime state digest changed');
  assert(['collecting','finalized','abandoned'].includes(state.status) &&
    [state.publicNonces,state.partials,state.recoveryContributions,state.broadcastApprovals].every(items => Array.isArray(items) && items.length <= 3),
  'persisted runtime collections are invalid');
  return state;
}
async function persistState(sql: TransactionSql, vaultId: string, state: PresignedRuntimeState): Promise<void> {
  const p = state.proposal; const completed = state.finalized;
  await sql`INSERT INTO presigned_runtime_proposals(id,vault_id,epoch_id,graph_digest,proposal_digest,source_txid,source_vout,
    slot,kind,status,proposal_json,state_json,state_digest,transaction_digest,final_txid,transaction_hex)
    VALUES (${p.proposalId}::uuid,${vaultId}::uuid,${p.epochId}::uuid,${hex(p.graphDigest)},${hex(p.digest)},${hex(p.source.txid)},
      ${p.source.vout},${p.slot},${p.kind},${state.status},${sql.json(json(p))},${sql.json(json(state))},
      ${hex(commitmentDigest(STATE_DOMAIN,state))},${completed ? hex(completed.transactionDigest) : null},
      ${completed ? hex(completed.txid) : null},${completed?.transactionHex ?? null})
    ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,state_json=EXCLUDED.state_json,state_digest=EXCLUDED.state_digest,
      transaction_digest=EXCLUDED.transaction_digest,final_txid=EXCLUDED.final_txid,transaction_hex=EXCLUDED.transaction_hex,updated_at=now()`;
}
async function membershipForUser(sql: TransactionSql, userId: string, lock: boolean): Promise<Membership> {
  identifier(userId, 'runtime user');
  const suffix = lock ? sql`FOR UPDATE OF v` : sql``;
  const rows = await sql<Array<{ vault_id: string; participant_id: ParticipantId; protocol: string; status: string }>>`
    SELECT m.vault_id,m.participant_id,v.protocol,v.status FROM vault_members m JOIN vaults v ON v.id=m.vault_id
    WHERE m.user_id=${userId}::uuid ${suffix}
  `;
  assert(rows.length === 1 && rows[0]!.protocol === PRESIGNED_PROTOCOL, 'exactly one V2 runtime vault membership is required');
  return { vaultId: rows[0]!.vault_id, participantId: rows[0]!.participant_id, vaultStatus: rows[0]!.status };
}
async function selectedCredential(sql: TransactionSql, userId: string, credentialId: string, membership: Membership): Promise<StoredCredential> {
  const rows = await sql<Array<{ credential_id: string; credential_name: string; public_key: Buffer; counter: string; transports: StoredCredential['transports'] }>>`
    SELECT c.credential_id,c.credential_name,c.public_key,c.counter::text,c.transports FROM webauthn_credentials c
    JOIN passkey_envelopes e ON e.credential_id=c.credential_id
    WHERE c.user_id=${userId}::uuid AND c.credential_id=${credentialId} AND c.prf_enabled=true
  `;
  const row = rows[0]; assert(row, 'runtime selected passkey has no stored PRF envelope');
  const counter = Number(row.counter); safeInteger(counter, 0, Number.MAX_SAFE_INTEGER, 'runtime stored counter');
  return { id: row.credential_id, name: row.credential_name, userId, publicKey: Uint8Array.from(row.public_key), counter,
    transports: row.transports, vaultId: membership.vaultId, participantId: membership.participantId };
}
async function loadChallenge(sql: TransactionSql, userId: string, id: string, lock: boolean): Promise<PresignedRuntimeActionChallenge> {
  const suffix = lock ? sql`FOR UPDATE OF a` : sql``;
  const rows = await sql<Array<{ id: string; vault_id: string; participant_id: ParticipantId; credential_id: string; credential_counter: string;
    action_json: PresignedRuntimeAction; action_digest: Buffer; proposal_json: PresignedRuntimeProposal; proposal_digest: Buffer;
    challenge: string; expires_at: Date }>>`
    SELECT a.id,a.vault_id,a.participant_id,a.credential_id,a.credential_counter::text,a.action_json,a.action_digest,
      a.proposal_json,a.proposal_digest,a.challenge,a.expires_at FROM presigned_runtime_action_challenges a
    JOIN vaults v ON v.id=a.vault_id AND v.protocol=a.protocol
    JOIN vault_members m ON m.vault_id=a.vault_id AND m.user_id=a.user_id AND m.participant_id=a.participant_id
    WHERE a.id=${id}::uuid AND a.user_id=${userId}::uuid AND a.protocol=${PRESIGNED_PROTOCOL}
      AND a.consumed_at IS NULL AND a.invalidated_at IS NULL AND a.expires_at>now() ${suffix}
  `;
  const row = rows[0]; assert(row, 'runtime action challenge is unavailable, used, superseded or expired');
  const action = validatePresignedRuntimeAction(row.action_json); const actionDigest = presignedRuntimeActionDigest(action);
  assert(actionDigest === row.action_digest.toString('hex') && row.proposal_json.proposalId === action.proposalId &&
    row.proposal_json.digest === row.proposal_digest.toString('hex'), 'runtime challenge changed action or proposal digest');
  const credential = await selectedCredential(sql,userId,row.credential_id,{ vaultId: row.vault_id, participantId: row.participant_id, vaultStatus: 'unknown' });
  assert(credential.counter === Number(row.credential_counter), 'runtime passkey counter changed after challenge');
  return { id: row.id, vaultId: row.vault_id, participantId: row.participant_id, protocol: PRESIGNED_PROTOCOL,
    action, actionDigest, proposal: row.proposal_json, challenge: row.challenge, credential, expiresAt: row.expires_at.toISOString() };
}
function validateDependencies(input: PresignedRuntimeActionDependencies): void {
  assert(input && typeof input.observeCoin === 'function', 'trusted private-Core runtime observer is required');
  safeInteger(input.requiredConfirmations, 1, 2_000_000, 'runtime required confirmations');
}
function hex(value: string): Buffer { return Buffer.from(value,'hex'); }
function json(value: unknown): Record<string, never> { return JSON.parse(canonicalJson(value)) as Record<string, never>; }
