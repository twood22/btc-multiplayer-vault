import 'server-only';
import { Buffer } from 'buffer';
import type { TransactionSql } from 'postgres';
import { transaction } from './db';

const DIGEST = /^[0-9a-f]{64}$/u;
const REORG_REASON = 'ancestor confirmation removed by Bitcoin mainnet reorganization';

interface AnchorInput {
  vaultId: string;
  txid: string;
  priorBlockHash: string;
  replacementBlockHash?: string;
  replacementConfirmedHeight?: number;
}

/** Move a still-confirmed funding transaction to the block that now contains it. */
export async function reanchorConfirmedFunding(input: AnchorInput): Promise<void> {
  assertAnchorInput(input, true);
  await transaction(async (sql) => {
    const rows = await sql<Array<{
      confirmed_height: string;
      confirmed_block_hash: Buffer;
    }>>`
      SELECT confirmed_height::text, confirmed_block_hash
      FROM funding_finalizations
      WHERE vault_id = ${input.vaultId}::uuid
        AND final_txid = ${Buffer.from(input.txid, 'hex')}
        AND status = 'confirmed'
      FOR UPDATE
    `;
    const row = rows[0];
    assertPriorAnchor(row, input.priorBlockHash, 'funding');
    const updated = await sql<Array<{ vault_id: string }>>`
      UPDATE funding_finalizations
      SET confirmed_height = ${input.replacementConfirmedHeight!},
          confirmed_block_hash = ${Buffer.from(input.replacementBlockHash!, 'hex')}
      WHERE vault_id = ${input.vaultId}::uuid
        AND status = 'confirmed'
        AND confirmed_block_hash = ${Buffer.from(input.priorBlockHash, 'hex')}
      RETURNING vault_id
    `;
    if (updated.length !== 1) throw new Error('funding confirmation anchor changed during reorganization review');
    const coins = await sql<Array<{ id: string }>>`
      UPDATE vault_coins SET confirmed_height = ${input.replacementConfirmedHeight!}, updated_at = now()
      WHERE vault_id = ${input.vaultId}::uuid
        AND txid = ${Buffer.from(input.txid, 'hex')}
        AND status IN ('current', 'spent')
      RETURNING id
    `;
    if (coins.length !== 1) throw new Error('reanchored funding transaction has no exact recorded coin');
    await insertEvent(sql, {
      ...input,
      scope: 'funding',
      action: 'reanchored',
      proposalId: null,
      priorConfirmedHeight: exactPositive(row!.confirmed_height, 'prior funding height'),
    });
  });
}

/** Remove an initial funding confirmation without treating backend failure as chain evidence. */
export async function rollbackConfirmedFunding(input: AnchorInput): Promise<void> {
  assertAnchorInput(input, false);
  await transaction(async (sql) => {
    const rows = await sql<Array<{
      confirmed_height: string;
      confirmed_block_hash: Buffer;
    }>>`
      SELECT confirmed_height::text, confirmed_block_hash
      FROM funding_finalizations
      WHERE vault_id = ${input.vaultId}::uuid
        AND final_txid = ${Buffer.from(input.txid, 'hex')}
        AND status = 'confirmed'
      FOR UPDATE
    `;
    const row = rows[0];
    assertPriorAnchor(row, input.priorBlockHash, 'funding');
    const confirmedChildren = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM vault_transaction_proposals
      WHERE vault_id = ${input.vaultId}::uuid AND status = 'confirmed'
    `;
    if (confirmedChildren[0]?.count !== '0') {
      throw new Error('cannot roll back funding before confirmed descendant transitions');
    }
    const coins = await sql<Array<{ id: string; txid: Buffer }>>`
      SELECT id, txid FROM vault_coins
      WHERE vault_id = ${input.vaultId}::uuid AND status = 'current'
      FOR UPDATE
    `;
    const coin = coins[0];
    if (coins.length !== 1 || coin!.txid.toString('hex') !== input.txid) {
      throw new Error('funding rollback did not find its exact current vault coin');
    }
    await staleUnsignedChildren(sql, coin.id);
    await clearCoinObservations(sql, coin.id);
    const orphaned = await sql<Array<{ id: string }>>`
      UPDATE vault_coins
      SET status = 'orphaned', confirmed_height = NULL, updated_at = now()
      WHERE id = ${coin.id}::uuid AND status = 'current'
      RETURNING id
    `;
    if (orphaned.length !== 1) throw new Error('funding coin changed during reorganization rollback');
    const demoted = await sql<Array<{ vault_id: string }>>`
      UPDATE funding_finalizations
      SET status = 'broadcast', confirmed_at = NULL,
          confirmed_height = NULL, confirmed_block_hash = NULL
      WHERE vault_id = ${input.vaultId}::uuid
        AND status = 'confirmed'
        AND confirmed_block_hash = ${Buffer.from(input.priorBlockHash, 'hex')}
      RETURNING vault_id
    `;
    if (demoted.length !== 1) throw new Error('funding finalization changed during reorganization rollback');
    const reopened = await sql<Array<{ id: string }>>`
      UPDATE vaults SET status = 'ready'
      WHERE id = ${input.vaultId}::uuid AND status = 'active'
      RETURNING id
    `;
    if (reopened.length !== 1) throw new Error('funded vault was not active during reorganization rollback');
    await insertEvent(sql, {
      ...input,
      scope: 'funding',
      action: 'rolled_back',
      proposalId: null,
      priorConfirmedHeight: exactPositive(row!.confirmed_height, 'prior funding height'),
    });
  });
}

/** Move an exact confirmed spend to its replacement active-chain block. */
export async function reanchorConfirmedVaultTransition(
  input: AnchorInput & { proposalId: string },
): Promise<void> {
  assertAnchorInput(input, true);
  await transaction(async (sql) => {
    const rows = await sql<Array<{
      confirmed_height: string;
      confirmed_block_hash: Buffer;
    }>>`
      SELECT confirmed_height::text, confirmed_block_hash
      FROM vault_transaction_proposals
      WHERE id = ${input.proposalId}::uuid
        AND vault_id = ${input.vaultId}::uuid
        AND final_txid = ${Buffer.from(input.txid, 'hex')}
        AND status = 'confirmed'
      FOR UPDATE
    `;
    const row = rows[0];
    assertPriorAnchor(row, input.priorBlockHash, 'vault transition');
    const updated = await sql<Array<{ id: string }>>`
      UPDATE vault_transaction_proposals
      SET confirmed_height = ${input.replacementConfirmedHeight!},
          confirmed_block_hash = ${Buffer.from(input.replacementBlockHash!, 'hex')},
          updated_at = now()
      WHERE id = ${input.proposalId}::uuid
        AND status = 'confirmed'
        AND confirmed_block_hash = ${Buffer.from(input.priorBlockHash, 'hex')}
      RETURNING id
    `;
    if (updated.length !== 1) throw new Error('vault confirmation anchor changed during reorganization review');
    await sql`
      UPDATE vault_coins SET confirmed_height = ${input.replacementConfirmedHeight!}, updated_at = now()
      WHERE vault_id = ${input.vaultId}::uuid
        AND txid = ${Buffer.from(input.txid, 'hex')}
        AND status IN ('current', 'spent')
    `;
    await insertEvent(sql, {
      ...input,
      scope: 'vault_transition',
      action: 'reanchored',
      priorConfirmedHeight: exactPositive(row!.confirmed_height, 'prior transition height'),
    });
  });
}

/** Atomically restore the exact input coin and orphan only this transition's successor. */
export async function rollbackConfirmedVaultTransition(
  input: AnchorInput & { proposalId: string },
): Promise<void> {
  assertAnchorInput(input, false);
  await transaction(async (sql) => {
    const rows = await sql<Array<{
      input_coin_id: string;
      confirmed_height: string;
      confirmed_block_hash: Buffer;
    }>>`
      SELECT input_coin_id, confirmed_height::text, confirmed_block_hash
      FROM vault_transaction_proposals
      WHERE id = ${input.proposalId}::uuid
        AND vault_id = ${input.vaultId}::uuid
        AND final_txid = ${Buffer.from(input.txid, 'hex')}
        AND status = 'confirmed'
      FOR UPDATE
    `;
    const row = rows[0];
    assertPriorAnchor(row, input.priorBlockHash, 'vault transition');
    const successors = await sql<Array<{ id: string; status: string }>>`
      SELECT id, status FROM vault_coins
      WHERE vault_id = ${input.vaultId}::uuid
        AND txid = ${Buffer.from(input.txid, 'hex')}
      FOR UPDATE
    `;
    if (successors.length > 1 || successors[0]?.status === 'spent') {
      throw new Error('cannot roll back a vault transition before its confirmed descendant');
    }
    const successor = successors[0];
    if (successor) {
      if (successor.status !== 'current') {
        throw new Error('vault transition successor is not the exact current coin');
      }
      await staleUnsignedChildren(sql, successor.id);
      await clearCoinObservations(sql, successor.id);
      const orphaned = await sql<Array<{ id: string }>>`
        UPDATE vault_coins
        SET status = 'orphaned', confirmed_height = NULL, updated_at = now()
        WHERE id = ${successor.id}::uuid AND status = 'current'
        RETURNING id
      `;
      if (orphaned.length !== 1) throw new Error('successor coin changed during reorganization rollback');
    }
    const restored = await sql<Array<{ id: string }>>`
      UPDATE vault_coins
      SET status = 'current', spent_by_txid = NULL, updated_at = now()
      WHERE id = ${row!.input_coin_id}::uuid
        AND vault_id = ${input.vaultId}::uuid
        AND status = 'spent'
        AND spent_by_txid = ${Buffer.from(input.txid, 'hex')}
      RETURNING id
    `;
    if (restored.length !== 1) throw new Error('vault transition input coin could not be restored');
    const demoted = await sql<Array<{ id: string }>>`
      UPDATE vault_transaction_proposals
      SET status = 'broadcast', confirmed_height = NULL,
          confirmed_block_hash = NULL, updated_at = now()
      WHERE id = ${input.proposalId}::uuid
        AND status = 'confirmed'
        AND confirmed_block_hash = ${Buffer.from(input.priorBlockHash, 'hex')}
      RETURNING id
    `;
    if (demoted.length !== 1) throw new Error('vault proposal changed during reorganization rollback');
    const vaults = await sql<Array<{ status: string }>>`
      SELECT status FROM vaults WHERE id = ${input.vaultId}::uuid FOR UPDATE
    `;
    if (vaults[0]?.status === 'closed') {
      await sql`UPDATE vaults SET status = 'active' WHERE id = ${input.vaultId}::uuid`;
    } else if (vaults[0]?.status !== 'active') {
      throw new Error('vault is neither active nor closed during transition rollback');
    }
    await insertEvent(sql, {
      ...input,
      scope: 'vault_transition',
      action: 'rolled_back',
      priorConfirmedHeight: exactPositive(row!.confirmed_height, 'prior transition height'),
    });
  });
}

function assertAnchorInput(input: AnchorInput, replacementRequired: boolean): void {
  if (!DIGEST.test(input.txid) || !DIGEST.test(input.priorBlockHash)) {
    throw new Error('reorganization transaction or block identity is invalid');
  }
  const hasReplacement = input.replacementBlockHash !== undefined ||
    input.replacementConfirmedHeight !== undefined;
  if (replacementRequired !== hasReplacement ||
      (replacementRequired && (!DIGEST.test(input.replacementBlockHash || '') ||
        !Number.isSafeInteger(input.replacementConfirmedHeight) ||
        input.replacementConfirmedHeight! <= 0 ||
        input.replacementBlockHash === input.priorBlockHash))) {
    throw new Error('replacement confirmation anchor is invalid');
  }
}

function assertPriorAnchor(
  row: { confirmed_height: string; confirmed_block_hash: Buffer } | undefined,
  expectedBlockHash: string,
  label: string,
): asserts row is { confirmed_height: string; confirmed_block_hash: Buffer } {
  if (!row?.confirmed_block_hash || row.confirmed_block_hash.toString('hex') !== expectedBlockHash ||
      exactPositive(row.confirmed_height, `${label} confirmed height`) <= 0) {
    throw new Error(`${label} does not have the reviewed confirmation anchor`);
  }
}

async function staleUnsignedChildren(sql: TransactionSql, inputCoinId: string): Promise<void> {
  const proposals = await sql<Array<{ id: string }>>`
    SELECT id FROM vault_transaction_proposals
    WHERE input_coin_id = ${inputCoinId}::uuid
      AND status IN ('collecting', 'finalized')
    FOR UPDATE
  `;
  if (!proposals.length) return;
  const proposalIds = proposals.map((item) => item.id);
  await sql`
    DELETE FROM vault_broadcast_approvals
    WHERE proposal_id = ANY(${proposalIds}::uuid[]) AND status = 'pending'
  `;
  await sql`
    UPDATE vault_broadcast_approvals
    SET status = 'failed', failure_reason = ${REORG_REASON}, updated_at = now()
    WHERE proposal_id = ANY(${proposalIds}::uuid[])
      AND status IN ('approved', 'submitting')
  `;
  await sql`
    UPDATE vault_transaction_proposals
    SET status = 'stale', rejection_reason = ${REORG_REASON}, updated_at = now()
    WHERE id = ANY(${proposalIds}::uuid[])
      AND status IN ('collecting', 'finalized')
  `;
}

async function clearCoinObservations(sql: TransactionSql, coinId: string): Promise<void> {
  await sql`DELETE FROM vault_coin_observation_challenges WHERE coin_id = ${coinId}::uuid`;
  await sql`DELETE FROM vault_coin_observations WHERE coin_id = ${coinId}::uuid`;
}

async function insertEvent(sql: TransactionSql, input: AnchorInput & {
  scope: 'funding' | 'vault_transition';
  action: 'reanchored' | 'rolled_back';
  proposalId?: string | null;
  priorConfirmedHeight: number;
}): Promise<void> {
  await sql`
    INSERT INTO chain_reorganization_events (
      vault_id, event_scope, action, proposal_id, txid,
      prior_confirmed_height, prior_block_hash,
      replacement_confirmed_height, replacement_block_hash
    ) VALUES (
      ${input.vaultId}::uuid, ${input.scope}, ${input.action},
      ${input.proposalId ?? null}::uuid, ${Buffer.from(input.txid, 'hex')},
      ${input.priorConfirmedHeight}, ${Buffer.from(input.priorBlockHash, 'hex')},
      ${input.replacementConfirmedHeight ?? null},
      ${input.replacementBlockHash ? Buffer.from(input.replacementBlockHash, 'hex') : null}
    )
  `;
}

function exactPositive(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} is invalid`);
  return value;
}
