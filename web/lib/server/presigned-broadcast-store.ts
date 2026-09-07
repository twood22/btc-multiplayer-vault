import 'server-only';
import { Buffer } from 'buffer';
import type { Sql, TransactionSql } from 'postgres';
import * as bitcoin from 'bitcoinjs-lib';
import { BITCOIN_NETWORK_NAME } from '../../../src/network';
import { finalizePresignedFunding } from '../../../src/presigned/funding';
import { authorizePresignedExitTransaction, verifyPreauthorizations } from '../../../src/presigned/signing';
import { authorizePresignedSpendTransaction } from '../../../src/presigned/spends';
import { assertPresignedRuntimeObservation, presignedRuntimeBroadcastReady, presignedRuntimeTransactionDigest,
  validatePresignedRuntimeProposal, type PresignedRuntimeState } from '../../../src/presigned/runtime';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL } from '../../../src/presigned/types';
import { assert, commitmentDigest, identifier, sameCanonical } from '../../../src/presigned/validation';
import { nonWitnessTransactionHex } from '../../../src/presigned/graph';
import { loadPresignedFundingEpoch } from './presigned-chain-store';
import { presignedCoreBackend, presignedCoreRpc } from './presigned-core';
import { chainConfirmationsRequired } from './config';
import { db, transaction } from './db';
import { consumeRateLimit } from './rate-limit';
import { assertPresignedFundingDeploymentRelease, recordPresignedFundingReleaseUse } from './presigned-release-store';

/** In-process injection for real-Core crash/reorg drills; never accepted by a route. */
export interface PresignedBroadcastDependencies {
  assertEnabled: () => void;
  backend: ReturnType<typeof presignedCoreBackend>;
  rpc: typeof presignedCoreRpc;
  requiredConfirmations: number;
}
function broadcastDependencies(): PresignedBroadcastDependencies {
  return { assertEnabled: assertBroadcastEnabled, backend: presignedCoreBackend(), rpc: presignedCoreRpc,
    requiredConfirmations: chainConfirmationsRequired() };
}

interface Intent {
  id: string; vault_id: string; epoch_id: string; proposal_id: string | null;
  kind: 'funding' | 'runtime' | 'fee-package'; authorization_digest: Buffer;
  transaction_json: string[]; txids_json: string[]; status: string; attempt_count: number;
}

/** Deployment opt-in is additional to, never a substitute for, participant authority. */
export function presignedBroadcastEnabled(): boolean {
  return process.env.PRESIGNED_V2_BROADCAST_NETWORK === BITCOIN_NETWORK_NAME &&
    (BITCOIN_NETWORK_NAME !== 'mainnet' || process.env.PRESIGNED_V2_MAINNET_AUTHORIZATION === 'separately-approved-mainnet-spending');
}
function assertBroadcastEnabled(): void {
  assert(presignedBroadcastEnabled(), BITCOIN_NETWORK_NAME === 'mainnet'
    ? 'V2 mainnet broadcasting requires separate explicit operator authorization; this implementation goal did not grant it'
    : 'V2 Signet broadcasting has not been explicitly enabled for this deployment');
}

export async function preparePresignedBroadcast(input: {
  userId: string; epochId: string; proposalId: string | null;
}): Promise<{ intentId: string; txids: string[] }> {
  assertBroadcastEnabled(); identifier(input.userId, 'broadcast user'); identifier(input.epochId, 'broadcast epoch');
  await consumeRateLimit({ action: 'presigned_broadcast', subject: input.userId, limit: 40, windowSeconds: 900 });
  if (input.proposalId) identifier(input.proposalId, 'broadcast proposal');
  const members = await db()<Array<{ vault_id: string }>>`
    SELECT m.vault_id FROM vault_members m JOIN vaults v ON v.id = m.vault_id
    WHERE m.user_id = ${input.userId}::uuid AND v.protocol = ${PRESIGNED_PROTOCOL}
  `;
  assert(members.length === 1, 'one V2 vault membership is required');
  const vaultId = members[0]!.vault_id;
  const authority = await exactAuthority(vaultId, input.epochId, input.proposalId);
  if (!input.proposalId) await assertPresignedFundingDeploymentRelease(vaultId, input.epochId);
  return transaction(async sql => {
    await sql`SELECT id FROM vaults WHERE id = ${vaultId}::uuid AND protocol = ${PRESIGNED_PROTOCOL} FOR UPDATE`;
    // All authority here is append-only; nevertheless re-read it after acquiring
    // the shared vault lock so a changed proposal cannot slip between approval and intent.
    const now = await exactAuthority(vaultId, input.epochId, input.proposalId, sql);
    sameCanonical(authority, now, 'broadcast authority during preparation');
    const rows = await sql<Array<{ id: string; transaction_json: string[]; txids_json: string[] }>>`
      INSERT INTO presigned_broadcast_intents (vault_id, epoch_id, proposal_id, kind,
        authorization_digest, transaction_json, txids_json)
      VALUES (${vaultId}::uuid, ${input.epochId}::uuid, ${input.proposalId}::uuid,
        ${input.proposalId ? 'runtime' : 'funding'}, ${bytes(authority.digest)},
        ${sql.json([authority.transactionHex])}, ${sql.json([authority.txid])})
      ON CONFLICT (vault_id, authorization_digest) DO UPDATE SET updated_at = presigned_broadcast_intents.updated_at
      RETURNING id, transaction_json, txids_json
    `;
    const row = rows[0]!;
    sameCanonical(row.transaction_json, [authority.transactionHex], 'immutable broadcast bytes');
    sameCanonical(row.txids_json, [authority.txid], 'immutable broadcast IDs');
    return { intentId: row.id, txids: row.txids_json };
  });
}

/** Only exact persisted intents are retryable; no HTTP caller can supply replacement bytes. */
export async function submitPresignedBroadcast(intentId: string, dependencies: PresignedBroadcastDependencies = broadcastDependencies()) {
  dependencies.assertEnabled(); identifier(intentId, 'broadcast intent');
  const claimed = await transaction(async sql => {
    const rows = await sql<Intent[]>`SELECT * FROM presigned_broadcast_intents WHERE id = ${intentId}::uuid FOR UPDATE`;
    const row = rows[0]; assert(row, 'broadcast intent not found');
    const update = await sql<Array<{ id: string; attempt_count: number }>>`
      UPDATE presigned_broadcast_intents SET status = 'submitting', attempt_count = attempt_count + 1,
        last_error_code = NULL, updated_at = now()
      WHERE id = ${intentId}::uuid AND (status <> 'submitting' OR updated_at < now() - interval '45 seconds') RETURNING id, attempt_count
    `;
    return update.length ? { ...row, attempt_count: update[0]!.attempt_count } : null;
  });
  if (!claimed) return { intentId, status: 'submitting' as const, txids: [] as string[], reason: 'another submission is in progress' };
  try {
    assert(claimed.kind !== 'fee-package', 'fee packages require their dedicated exact-authority submission boundary');
    const authority = await exactAuthority(claimed.vault_id, claimed.epoch_id, claimed.proposal_id);
    assert(authority.digest === claimed.authorization_digest.toString('hex'), 'persisted broadcast authority changed');
    sameCanonical(claimed.transaction_json, [authority.transactionHex], 'retained send bytes');
    sameCanonical(claimed.txids_json, [authority.txid], 'retained send IDs');
    const core = dependencies.backend;
    await core.getTip(); // Authentication, exact network/genesis, full validation and txindex readiness.
    const existing = await core.getTransaction(authority.txid);
    assert(existing.kind !== 'unknown', 'broadcast lookup is unavailable; no send attempted');
    if (existing.kind === 'present') {
      // Core has validated these bytes. A legitimate different witness is the
      // same exact payment, not a reason to resubmit or reject its descendants.
      const observed = bitcoin.Transaction.fromHex(existing.transactionHex);
      assert(nonWitnessTransactionHex(observed) === nonWitnessTransactionHex(bitcoin.Transaction.fromHex(authority.transactionHex)),
        'existing transaction changed its exact non-witness bytes');
      if (existing.blockHash) {
        const anchor = await core.getBlock(existing.blockHash);
        // txindex can retain transactions from inactive blocks. Those are NOT
        // accepted-now evidence; allow exact authorized resubmission below.
        if (anchor.kind === 'active') return await accepted(claimed);
        assert(anchor.kind === 'inactive', 'existing transaction block is unknown');
      } else return await accepted(claimed);
    }
    const epoch = await loadPresignedFundingEpoch(claimed.vault_id, claimed.epoch_id);
    assert(epoch.graph, 'broadcast lost its frozen graph');
    if (claimed.proposal_id) {
      const state = await runtimeState(claimed.vault_id, claimed.proposal_id);
      const observed = await core.observeConfirmedCoin(state.proposal.source);
      assertPresignedRuntimeObservation({ graph: epoch.graph, proposal: state.proposal, observed,
        requiredConfirmations: dependencies.requiredConfirmations });
    } else {
      for (const input of epoch.graph.funding.inputs) {
        const observed = await core.observeCoin(input);
        assert(observed.valueSats === input.valueSats && observed.scriptPubKeyHex === input.scriptPubKeyHex &&
          observed.confirmations >= Math.max(input.confirmations, dependencies.requiredConfirmations),
        'funding input changed or is no longer independently confirmed and unspent');
      }
      const evidence = await assertPresignedFundingDeploymentRelease(claimed.vault_id, claimed.epoch_id);
      await recordPresignedFundingReleaseUse({ vaultId: claimed.vault_id, epochId: claimed.epoch_id,
        broadcastIntentId: claimed.id, feePackageId: null, evidence });
    }
    const policy = await dependencies.rpc<Array<{ txid: string; allowed: boolean }>>('testmempoolaccept', [[authority.transactionHex]]);
    assert(policy.length === 1 && policy[0]!.txid === authority.txid && policy[0]!.allowed === true,
      'Core policy deferred this exact transaction; use an approved sponsored fee child if needed');
    const returned = await dependencies.rpc<string>('sendrawtransaction', [authority.transactionHex]);
    assert(returned === authority.txid, 'Core returned another broadcast transaction ID');
    return await accepted(claimed);
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    const updated = await db()<Array<{ id: string }>>`UPDATE presigned_broadcast_intents SET status = 'deferred', updated_at = now(),
      last_error_code = ${typeof code === 'number' && Number.isSafeInteger(code) ? code : null}
      WHERE id = ${intentId}::uuid AND attempt_count = ${claimed.attempt_count} AND status = 'submitting' RETURNING id`;
    if (!updated.length) return superseded(claimed);
    // Never store RPC error strings, URLs, credentials or raw server responses.
    return { intentId, status: 'deferred' as const, txids: claimed.txids_json,
      reason: 'Exact authorized transaction was not confirmed accepted. State is retained; inspect current chain, source anchor and fee readiness before retry.' };
  }
}

export async function retryPresignedBroadcasts(dependencies?: PresignedBroadcastDependencies) {
  if (!presignedBroadcastEnabled()) return { enabled: false, results: [] };
  const rows = await db()<Array<{ id: string }>>`
    SELECT id FROM presigned_broadcast_intents WHERE kind IN ('funding', 'runtime')
      AND (status IN ('prepared', 'deferred', 'accepted') OR (status = 'submitting' AND updated_at < now() - interval '45 seconds'))
    ORDER BY updated_at, id LIMIT 100
  `;
  const results = [];
  for (const row of rows) results.push(await submitPresignedBroadcast(row.id, dependencies));
  return { enabled: true, results };
}

export async function exactAuthority(vaultId: string, epochId: string, proposalId: string | null,
  connection: Sql | TransactionSql = db()) {
  const epoch = await loadPresignedFundingEpoch(vaultId, epochId, connection);
  assert(epoch.graph, 'broadcast requires a complete retained graph');
  verifyPreauthorizations(epoch.graph, epoch.preauthorizations, true);
  if (!proposalId) {
    assert(epoch.status === 'approved' && epoch.finalization && epoch.fundingApprovals.length === 3 &&
      new Set(epoch.fundingApprovals).size === 3 && PARTICIPANT_IDS.every(id => epoch.fundingApprovals.includes(id)),
    'funding broadcast requires all three exact completed-transaction approvals');
    const completed = finalizePresignedFunding({ graph: epoch.graph, signatures: epoch.signatures });
    sameCanonical(completed, epoch.finalization, 'approved funding finalization');
    return { transactionHex: completed.transactionHex, txid: completed.txid, digest: completed.finalizationDigest };
  }
  const state = await runtimeState(vaultId, proposalId, connection);
  assert(state.proposal.epochId === epochId && state.proposal.graphDigest === epoch.graph.digest,
    'runtime broadcast changed its retained funding epoch');
  validatePresignedRuntimeProposal(epoch.graph, state.proposal);
  assert(presignedRuntimeBroadcastReady(state) && state.finalized, 'runtime broadcast requires its exact transaction signer quorum');
  const completed = state.proposal.kind === 'solo'
    ? authorizePresignedExitTransaction({ graph: epoch.graph, exitId: state.proposal.exitId!, transactionHex: state.finalized.transactionHex })
    : authorizePresignedSpendTransaction({ graph: epoch.graph, proposal: state.proposal.spend!, transactionHex: state.finalized.transactionHex });
  const digest = presignedRuntimeTransactionDigest(state.proposal, completed, state.finalized.approverParticipantIds);
  assert(digest === state.finalized.transactionDigest, 'runtime completed-transaction digest changed');
  return { transactionHex: completed.transactionHex, txid: completed.txid, digest };
}
async function runtimeState(vaultId: string, proposalId: string, connection: Sql | TransactionSql = db()): Promise<PresignedRuntimeState> {
  const rows = await connection<Array<{ state_json: PresignedRuntimeState; state_digest: Buffer }>>`
    SELECT state_json, state_digest FROM presigned_runtime_proposals
    WHERE id = ${proposalId}::uuid AND vault_id = ${vaultId}::uuid AND protocol = ${PRESIGNED_PROTOCOL}
  `;
  const row = rows[0];
  assert(row && commitmentDigest('vault/presigned-graph-v2/runtime/state', row.state_json) === row.state_digest.toString('hex'),
    'runtime broadcast state is missing or changed');
  return row.state_json;
}
async function accepted(intent: Intent) {
  const updated = await db()<Array<{ id: string }>>`UPDATE presigned_broadcast_intents SET status = 'accepted', accepted_at = COALESCE(accepted_at, now()),
    last_error_code = NULL, updated_at = now() WHERE id = ${intent.id}::uuid
      AND attempt_count = ${intent.attempt_count} AND status = 'submitting' RETURNING id`;
  if (!updated.length) return superseded(intent);
  return { intentId: intent.id, status: 'accepted' as const, txids: intent.txids_json, reason: null };
}
function superseded(intent: Intent) {
  return { intentId: intent.id, status: 'superseded' as const, txids: intent.txids_json,
    reason: 'A newer submission attempt owns the result; this attempt did not overwrite its status.' };
}
function bytes(value: string): Buffer { return Buffer.from(value, 'hex'); }
