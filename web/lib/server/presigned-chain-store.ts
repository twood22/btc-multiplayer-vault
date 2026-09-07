import 'server-only';
import { Buffer } from 'buffer';
import type { Sql, TransactionSql } from 'postgres';
import { findPresignedEpochConflicts } from '../../../src/presigned/chain';
import type { PresignedFundingEpoch } from '../../../src/presigned/ceremony';
import { validatePresignedGraph } from '../../../src/presigned/graph';
import { validatePresignedRuntimeProposal, type PresignedRuntimeProposal } from '../../../src/presigned/runtime';
import { collectPresignedEpochWatch, initialPresignedWatchState, type PresignedEpochWatch,
  type PresignedWatchBackend, type PresignedWatchState } from '../../../src/presigned/watch';
import { PRESIGNED_PROTOCOL, type PresignedGraph } from '../../../src/presigned/types';
import { assert, canonicalJson, commitmentDigest, identifier, sameCanonical } from '../../../src/presigned/validation';
import { chainConfirmationsRequired } from './config';
import { db, transaction } from './db';
import { presignedCoreBackend } from './presigned-core';

const STATE_DOMAIN = 'vault/presigned-graph-v2/watch/state';
type Snapshot = Extract<PresignedEpochWatch, { kind: 'snapshot' }>;
interface EpochRow {
  vault_id: string; epoch_id: string; snapshot_json: PresignedFundingEpoch; snapshot_digest: Buffer;
  graph_digest: Buffer; chain_state: PresignedWatchState | null; chain_digest: Buffer | null;
  chain_revision: string | null;
}
interface PreparedEpoch {
  row: EpochRow; graph: PresignedGraph; current: PresignedWatchState;
  proposals: PresignedRuntimeProposal[]; result: PresignedEpochWatch;
}

/** Retained immutable graph authority, not a chain confirmation or broadcast approval. */
export async function loadPresignedFundingEpoch(vaultId: string, epochId: string,
  connection: Sql | TransactionSql = db()): Promise<PresignedFundingEpoch> {
  identifier(vaultId, 'epoch vault'); identifier(epochId, 'funding epoch');
  const rows = await connection<Array<{ snapshot_json: PresignedFundingEpoch; snapshot_digest: Buffer; graph_digest: Buffer | null }>>`
    SELECT snapshot_json, snapshot_digest, graph_digest FROM presigned_funding_epochs
    WHERE vault_id = ${vaultId}::uuid AND epoch_id = ${epochId}::uuid AND protocol = ${PRESIGNED_PROTOCOL}
  `;
  const row = rows[0];
  assert(row && row.snapshot_json.epochId === epochId &&
    commitmentDigest('vault/presigned-graph-v2/ceremony/epoch', row.snapshot_json) === row.snapshot_digest.toString('hex'),
  'retained epoch is missing or changed');
  if (row.snapshot_json.graph) {
    const graph = validatePresignedGraph(row.snapshot_json.graph);
    assert(graph.digest === row.graph_digest?.toString('hex') && graph.roster.vaultId === vaultId &&
      graph.funding.epochId === epochId, 'retained graph changed its vault or epoch');
  }
  return row.snapshot_json;
}

export async function getPresignedChainStatus(userId: string) {
  identifier(userId, 'chain status user');
  const memberships = await db()<Array<{ vault_id: string }>>`
    SELECT m.vault_id FROM vault_members m JOIN vaults v ON v.id = m.vault_id
    WHERE m.user_id = ${userId}::uuid AND v.protocol = ${PRESIGNED_PROTOCOL}
  `;
  assert(memberships.length === 1, 'one V2 vault membership is required');
  const vaultId = memberships[0]!.vault_id;
  const rows = await db()<Array<{ epoch_id: string; snapshot_json: Snapshot | null;
    last_polled_at: Date; last_success_at: Date | null; deferred_reason: string | null }>>`
    SELECT epoch_id, snapshot_json, last_polled_at, last_success_at, deferred_reason
    FROM presigned_chain_states WHERE vault_id = ${vaultId}::uuid ORDER BY epoch_id
  `;
  return { version: 2 as const, protocol: PRESIGNED_PROTOCOL, vaultId,
    epochs: rows.map(row => ({ epochId: row.epoch_id, snapshot: row.snapshot_json,
      lastPolledAt: row.last_polled_at.toISOString(), lastSuccessAt: row.last_success_at?.toISOString() ?? null,
      deferredReason: row.deferred_reason })) };
}
export type PresignedChainStatus = Awaited<ReturnType<typeof getPresignedChainStatus>>;

/** One-shot private watcher. Caller uses the existing PostgreSQL watcher lease. */
export async function pollPresignedVaultChains(dependencies: {
  backend?: PresignedWatchBackend; requiredConfirmations?: number; vaultId?: string;
} = {}) {
  const backend = dependencies.backend ?? presignedCoreBackend();
  const requiredConfirmations = dependencies.requiredConfirmations ?? chainConfirmationsRequired();
  if (dependencies.vaultId) identifier(dependencies.vaultId, 'watched vault');
  const rows = await db()<EpochRow[]>`
    SELECT e.vault_id, e.epoch_id, e.snapshot_json, e.snapshot_digest, e.graph_digest,
      c.state_json AS chain_state, c.state_digest AS chain_digest, c.poll_revision::text AS chain_revision
    FROM presigned_funding_epochs e LEFT JOIN presigned_chain_states c ON c.epoch_id = e.epoch_id
    WHERE e.protocol = ${PRESIGNED_PROTOCOL} AND e.graph_digest IS NOT NULL
      AND (${dependencies.vaultId ?? null}::uuid IS NULL OR e.vault_id = ${dependencies.vaultId ?? null}::uuid)
    ORDER BY e.vault_id, e.ordinal
  `;
  const grouped = new Map<string, EpochRow[]>();
  for (const row of rows) grouped.set(row.vault_id, [...(grouped.get(row.vault_id) ?? []), row]);
  const results: Array<{ vaultId: string; updatedEpochs: number; deferredReason: string | null;
    conflicts: ReturnType<typeof findPresignedEpochConflicts> }> = [];
  for (const [vaultId, epochs] of grouped) {
    const prepared: PreparedEpoch[] = [];
    let tip: unknown = null;
    try {
      for (const row of epochs) {
        const epoch = row.snapshot_json;
        assert(commitmentDigest('vault/presigned-graph-v2/ceremony/epoch', epoch) === row.snapshot_digest.toString('hex') &&
          epoch.epochId === row.epoch_id && epoch.graph, 'watched epoch snapshot changed');
        const graph = validatePresignedGraph(epoch.graph);
        assert(graph.digest === row.graph_digest.toString('hex') && graph.roster.vaultId === vaultId &&
          graph.funding.epochId === row.epoch_id, 'watched graph changed its owner or epoch');
        const current = row.chain_state ?? initialPresignedWatchState(graph);
        if (row.chain_state) assert(commitmentDigest(STATE_DOMAIN, current) === row.chain_digest?.toString('hex'), 'watched state digest changed');
        const proposalRows = await db()<Array<{ proposal_json: PresignedRuntimeProposal }>>`
          SELECT proposal_json FROM presigned_runtime_proposals
          WHERE vault_id = ${vaultId}::uuid AND epoch_id = ${row.epoch_id}::uuid ORDER BY created_at, id
        `;
        const proposals = proposalRows.map(item => validatePresignedRuntimeProposal(graph, item.proposal_json));
        const result = await collectPresignedEpochWatch({ graph, current, proposals, backend, requiredConfirmations });
        if (result.kind === 'snapshot') {
          if (tip !== null) sameCanonical(tip, result.tip, 'all retained epochs must share one stable tip');
          tip = result.tip;
        }
        prepared.push({ row, graph, current, proposals, result });
      }
      if (tip !== null) sameCanonical(tip, await backend.getTip(), 'watch persistence tip');
      const deferred = prepared.find(item => item.result.kind === 'deferred');
      // A partially reconciled set cannot establish which retained epochs coexist.
      const deferredReason = deferred?.result.kind === 'deferred' ? deferred.result.reason : null;
      const conflicts = deferredReason ? [] : findPresignedEpochConflicts(prepared.map(item => ({ graph: item.graph, state: item.result.state.graph })));
      await transaction(async sql => {
        const locked = await sql<Array<{ id: string }>>`SELECT id FROM vaults
          WHERE id = ${vaultId}::uuid AND protocol = ${PRESIGNED_PROTOCOL} FOR UPDATE`;
        assert(locked.length === 1, 'watched vault protocol changed');
        // A new frozen graph or a changed setup snapshot can appear while RPC
        // observations are in flight. Neither the epoch set nor its status may
        // be inferred from that older read when publishing vault-wide state.
        const currentEpochs = await sql<Array<{ epoch_id: string; snapshot_digest: Buffer; graph_digest: Buffer }>>`
          SELECT epoch_id, snapshot_digest, graph_digest FROM presigned_funding_epochs
          WHERE vault_id = ${vaultId}::uuid AND protocol = ${PRESIGNED_PROTOCOL} AND graph_digest IS NOT NULL
          ORDER BY ordinal
        `;
        sameCanonical(currentEpochs.map(row => ({ epochId: row.epoch_id,
          snapshotDigest: row.snapshot_digest.toString('hex'), graphDigest: row.graph_digest.toString('hex') })),
        epochs.map(row => ({ epochId: row.epoch_id, snapshotDigest: row.snapshot_digest.toString('hex'),
          graphDigest: row.graph_digest.toString('hex') })), 'retained epoch set during watch');
        for (const item of prepared) {
          const previousRows = await sql<Array<{ state_digest: Buffer; poll_revision: string }>>`
            SELECT state_digest, poll_revision::text FROM presigned_chain_states WHERE epoch_id = ${item.row.epoch_id}::uuid
          `;
          // Equal state bytes can hide newer availability/deferred snapshots
          // or a confirm/reorg ABA cycle. The revision fences every publication,
          // even after the caller's separate session lease has been lost.
          assert((previousRows[0]?.state_digest.toString('hex') ?? null) === (item.row.chain_digest?.toString('hex') ?? null) &&
            (previousRows[0]?.poll_revision ?? null) === item.row.chain_revision,
            'another watch result won the persistence race');
          const currentProposalRows = await sql<Array<{ proposal_json: PresignedRuntimeProposal }>>`
            SELECT proposal_json FROM presigned_runtime_proposals
            WHERE vault_id = ${vaultId}::uuid AND epoch_id = ${item.row.epoch_id}::uuid ORDER BY created_at, id
          `;
          sameCanonical(currentProposalRows.map(row => row.proposal_json), item.proposals, 'retained proposals during watch');
          const result = deferredReason ? null : item.result.kind === 'snapshot' ? item.result : null;
          const nextState = result?.state ?? item.current;
          const nextDigest = commitmentDigest(STATE_DOMAIN, nextState);
          await sql`
            INSERT INTO presigned_chain_states (vault_id, epoch_id, graph_digest, state_json, state_digest,
              snapshot_json, last_success_at, deferred_reason)
            VALUES (${vaultId}::uuid, ${item.row.epoch_id}::uuid, ${bytes(item.graph.digest)}, ${sql.json(json(nextState))},
              ${bytes(nextDigest)}, ${result ? sql.json(json(result)) : null}, ${result ? new Date() : null}, ${deferredReason})
            ON CONFLICT (epoch_id) DO UPDATE SET state_json = EXCLUDED.state_json, state_digest = EXCLUDED.state_digest,
              poll_revision = presigned_chain_states.poll_revision + 1,
              snapshot_json = COALESCE(EXCLUDED.snapshot_json, presigned_chain_states.snapshot_json),
              last_polled_at = now(), last_success_at = COALESCE(EXCLUDED.last_success_at, presigned_chain_states.last_success_at),
              deferred_reason = EXCLUDED.deferred_reason
          `;
          if (result && (result.addedTxids.length || result.invalidatedTxids.length || result.reanchoredTxids.length)) {
            await sql`INSERT INTO presigned_chain_events (vault_id, epoch_id, previous_state_digest,
              resulting_state_digest, tip_hash, invalidated_txids, added_txids, reanchored_txids)
              VALUES (${vaultId}::uuid, ${item.row.epoch_id}::uuid, ${bytes(commitmentDigest(STATE_DOMAIN, item.current))},
                ${bytes(nextDigest)}, ${bytes(result.tip.hash)}, ${sql.json(result.invalidatedTxids)},
                ${sql.json(result.addedTxids)}, ${sql.json(result.reanchoredTxids)})`;
          }
        }
        if (!deferredReason) {
          const funded = prepared.filter(item => item.result.state.graph.confirmed.length > 0);
          const everyFundedClosed = funded.length > 0 && funded.every(item => item.result.kind === 'snapshot' &&
            item.result.output?.availability === 'chain-spent' && item.result.output.knownTerminalTxid !== null);
          const currentEpoch = prepared.find(item => item.row.snapshot_json.status !== 'retired');
          const nextStatus = funded.length ? everyFundedClosed && !conflicts.length ? 'closed' : 'active'
            : currentEpoch?.row.snapshot_json.walletSigningStarted.length ? 'ready' : 'roster_confirmed';
          await sql`UPDATE vaults SET status = ${nextStatus} WHERE id = ${vaultId}::uuid AND protocol = ${PRESIGNED_PROTOCOL}`;
        }
      });
      results.push({ vaultId, updatedEpochs: deferredReason ? 0 : prepared.length, deferredReason, conflicts });
    } catch {
      // Do not replace any confirmed state on transport, index, consistency or CAS failure.
      results.push({ vaultId, updatedEpochs: 0, deferredReason: 'private-watch-unavailable-or-state-changed', conflicts: [] });
    }
  }
  return { protocol: PRESIGNED_PROTOCOL, vaults: results, deferredVaults: results.filter(item => item.deferredReason !== null).length };
}

function bytes(value: string): Buffer { return Buffer.from(value, 'hex'); }
function json(value: unknown): any { return JSON.parse(canonicalJson(value)); }
