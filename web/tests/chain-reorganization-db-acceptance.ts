import assert from 'node:assert/strict';
import postgres from 'postgres';
import { BITCOIN_NETWORK_CONFIG, BITCOIN_NETWORK_NAME } from '../../src/network.js';
import {
  reanchorConfirmedVaultTransition,
  rollbackConfirmedFunding,
  rollbackConfirmedVaultTransition,
} from '../lib/server/chain-reorganization-store.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for chain-reorganization acceptance');
const sql = postgres(databaseUrl, { max: 4 });
const checks: Array<{ name: string; ok: true }> = [];

const transitionVault = '82111111-1111-4111-8111-111111111111';
const reanchorVault = '82111111-1111-4111-8111-111111111112';
const fundingVault = '82111111-1111-4111-8111-111111111113';
const alice = '82222222-2222-4222-8222-222222222221';
const bob = '82222222-2222-4222-8222-222222222222';
const rosterDigest = Buffer.alloc(32, 0x82);
const reanchorRosterDigest = Buffer.alloc(32, 0xa2);
const fundingRosterDigest = Buffer.alloc(32, 0xb2);
const parentTxid = '83'.repeat(32);
const parentBlock = '84'.repeat(32);
const replacementBlock = '85'.repeat(32);
const parentProposal = '82333333-3333-4333-8333-333333333331';
const childProposal = '82333333-3333-4333-8333-333333333332';
const inputCoin = '82444444-4444-4444-8444-444444444441';
const successorCoin = '82444444-4444-4444-8444-444444444442';

try {
  await seedTransitionRollback();
  await check('migration 012 records paired confirmation anchors and immutable reorganization evidence', async () => {
    const migrations = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM schema_migrations
      WHERE version = '012_chain_reorganization'
    `;
    assert.equal(migrations[0]?.count, '1');
    await assert.rejects(() => sql`
      UPDATE vault_transaction_proposals SET confirmed_block_hash = NULL
      WHERE id = ${parentProposal}::uuid
    `, /confirmation_anchor_check/u);
  });

  await rollbackConfirmedVaultTransition({
    proposalId: parentProposal,
    vaultId: transitionVault,
    txid: parentTxid,
    priorBlockHash: parentBlock,
  });
  await check('transition rollback restores only the exact input and orphans its successor atomically', async () => {
    const state = await sql<Array<{
      vault_status: string;
      input_status: string;
      input_spender: Buffer | null;
      successor_status: string;
      successor_height: string | null;
      parent_status: string;
      parent_height: string | null;
      parent_block: Buffer | null;
    }>>`
      SELECT
        (SELECT status FROM vaults WHERE id = ${transitionVault}::uuid) AS vault_status,
        (SELECT status FROM vault_coins WHERE id = ${inputCoin}::uuid) AS input_status,
        (SELECT spent_by_txid FROM vault_coins WHERE id = ${inputCoin}::uuid) AS input_spender,
        (SELECT status FROM vault_coins WHERE id = ${successorCoin}::uuid) AS successor_status,
        (SELECT confirmed_height::text FROM vault_coins WHERE id = ${successorCoin}::uuid)
          AS successor_height,
        (SELECT status FROM vault_transaction_proposals WHERE id = ${parentProposal}::uuid)
          AS parent_status,
        (SELECT confirmed_height::text FROM vault_transaction_proposals
          WHERE id = ${parentProposal}::uuid) AS parent_height,
        (SELECT confirmed_block_hash FROM vault_transaction_proposals
          WHERE id = ${parentProposal}::uuid) AS parent_block
    `;
    assert.deepEqual(state[0], {
      vault_status: 'active',
      input_status: 'current',
      input_spender: null,
      successor_status: 'orphaned',
      successor_height: null,
      parent_status: 'broadcast',
      parent_height: null,
      parent_block: null,
    });
  });

  await check('unsigned descendant state is invalidated and participant observations cannot survive rollback', async () => {
    const rows = await sql<Array<{
      child_status: string;
      child_reason: string | null;
      approval_status: string;
      approval_reason: string | null;
      observations: string;
      challenges: string;
      events: string;
    }>>`
      SELECT
        (SELECT status FROM vault_transaction_proposals WHERE id = ${childProposal}::uuid)
          AS child_status,
        (SELECT rejection_reason FROM vault_transaction_proposals WHERE id = ${childProposal}::uuid)
          AS child_reason,
        (SELECT status FROM vault_broadcast_approvals WHERE proposal_id = ${childProposal}::uuid)
          AS approval_status,
        (SELECT failure_reason FROM vault_broadcast_approvals WHERE proposal_id = ${childProposal}::uuid)
          AS approval_reason,
        (SELECT count(*)::text FROM vault_coin_observations WHERE coin_id = ${successorCoin}::uuid)
          AS observations,
        (SELECT count(*)::text FROM vault_coin_observation_challenges
          WHERE coin_id = ${successorCoin}::uuid) AS challenges,
        (SELECT count(*)::text FROM chain_reorganization_events
          WHERE proposal_id = ${parentProposal}::uuid AND action = 'rolled_back') AS events
    `;
    assert.equal(rows[0]?.child_status, 'stale');
    assert.match(rows[0]?.child_reason || '', new RegExp(`${BITCOIN_NETWORK_CONFIG.addressLabel} reorganization`, 'u'));
    assert.equal(rows[0]?.approval_status, 'failed');
    assert.match(rows[0]?.approval_reason || '', new RegExp(`${BITCOIN_NETWORK_CONFIG.addressLabel} reorganization`, 'u'));
    assert.equal(rows[0]?.observations, '0');
    assert.equal(rows[0]?.challenges, '0');
    assert.equal(rows[0]?.events, '1');
    await assert.rejects(() => rollbackConfirmedVaultTransition({
      proposalId: parentProposal,
      vaultId: transitionVault,
      txid: parentTxid,
      priorBlockHash: parentBlock,
    }), /reviewed confirmation anchor/u);
  });

  await seedReanchor();
  await reanchorConfirmedVaultTransition({
    proposalId: '82333333-3333-4333-8333-333333333341',
    vaultId: reanchorVault,
    txid: '86'.repeat(32),
    priorBlockHash: '87'.repeat(32),
    replacementBlockHash: replacementBlock,
    replacementConfirmedHeight: 900_010,
  });
  await check('a transaction re-included deeply enough is reanchored without rolling product state back', async () => {
    const rows = await sql<Array<{
      status: string;
      confirmed_height: string;
      confirmed_block_hash: Buffer;
      vault_status: string;
      events: string;
    }>>`
      SELECT p.status, p.confirmed_height::text, p.confirmed_block_hash,
             v.status AS vault_status,
             (SELECT count(*)::text FROM chain_reorganization_events e
              WHERE e.proposal_id = p.id AND e.action = 'reanchored') AS events
      FROM vault_transaction_proposals p JOIN vaults v ON v.id = p.vault_id
      WHERE p.id = '82333333-3333-4333-8333-333333333341'::uuid
    `;
    assert.equal(rows[0]?.status, 'confirmed');
    assert.equal(rows[0]?.confirmed_height, '900010');
    assert.equal(rows[0]?.confirmed_block_hash.toString('hex'), replacementBlock);
    assert.equal(rows[0]?.vault_status, 'closed');
    assert.equal(rows[0]?.events, '1');
  });

  await seedFundingRollback();
  await rollbackConfirmedFunding({
    vaultId: fundingVault,
    txid: '91'.repeat(32),
    priorBlockHash: '92'.repeat(32),
  });
  await check('funding rollback returns the vault to ready while preserving an already-broadcast child', async () => {
    const rows = await sql<Array<{
      vault_status: string;
      funding_status: string;
      funding_height: string | null;
      coin_status: string;
      child_status: string;
      events: string;
    }>>`
      SELECT
        (SELECT status FROM vaults WHERE id = ${fundingVault}::uuid) AS vault_status,
        (SELECT status FROM funding_finalizations WHERE vault_id = ${fundingVault}::uuid)
          AS funding_status,
        (SELECT confirmed_height::text FROM funding_finalizations
          WHERE vault_id = ${fundingVault}::uuid) AS funding_height,
        (SELECT status FROM vault_coins WHERE vault_id = ${fundingVault}::uuid) AS coin_status,
        (SELECT status FROM vault_transaction_proposals
          WHERE vault_id = ${fundingVault}::uuid) AS child_status,
        (SELECT count(*)::text FROM chain_reorganization_events
          WHERE vault_id = ${fundingVault}::uuid AND event_scope = 'funding'
            AND action = 'rolled_back') AS events
    `;
    assert.deepEqual(rows[0], {
      vault_status: 'ready',
      funding_status: 'broadcast',
      funding_height: null,
      coin_status: 'orphaned',
      child_status: 'broadcast',
      events: '1',
    });
  });
} finally {
  await sql.end();
}

console.log(JSON.stringify({ passed: true, checks }, null, 2));

async function seedTransitionRollback(): Promise<void> {
  await seedBase(transitionVault, 'active', rosterDigest);
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO vault_coins (
        id, vault_id, roster_digest, kind, round_id, owner_participant_id,
        txid, vout, value_sats, script_pubkey, status, confirmed_height, spent_by_txid
      ) VALUES
      (
        ${inputCoin}::uuid, ${transitionVault}::uuid, ${rosterDigest}, 'vault',
        'alicebobcarol', NULL, ${Buffer.alloc(32, 0x81)}, 0, 30000,
        ${taproot(0x81)}, 'spent', 899990, ${Buffer.from(parentTxid, 'hex')}
      ),
      (
        ${successorCoin}::uuid, ${transitionVault}::uuid, ${rosterDigest}, 'vault',
        'bobcarol', NULL, ${Buffer.from(parentTxid, 'hex')}, 1, 20000,
        ${taproot(0x83)}, 'current', 900000, NULL
      )
    `;
    await tx`
      INSERT INTO vault_transaction_proposals (
        id, vault_id, roster_digest, input_coin_id, kind, round_id,
        actor_participant_id, proposer_user_id, psbt_base64, unsigned_txid,
        proposal_digest, status, finalized_tx_hex, final_txid, expires_at,
        confirmed_height, confirmed_block_hash
      ) VALUES (
        ${parentProposal}::uuid, ${transitionVault}::uuid, ${rosterDigest},
        ${inputCoin}::uuid, 'solo', 'alicebobcarol', 'alice', ${alice}::uuid,
        'cHNidP8BAAAAAAAAAAAAAA==', ${Buffer.alloc(32, 0x82)}, ${Buffer.alloc(32, 0x83)},
        'confirmed', ${'00'.repeat(10)}, ${Buffer.from(parentTxid, 'hex')},
        now() + interval '15 minutes', 900000, ${Buffer.from(parentBlock, 'hex')}
      )
    `;
    await tx`
      INSERT INTO vault_transaction_proposals (
        id, vault_id, roster_digest, input_coin_id, kind, round_id,
        actor_participant_id, proposer_user_id, psbt_base64, unsigned_txid,
        proposal_digest, status, finalized_tx_hex, final_txid, expires_at
      ) VALUES (
        ${childProposal}::uuid, ${transitionVault}::uuid, ${rosterDigest},
        ${successorCoin}::uuid, 'cooperative', 'bobcarol', NULL, ${bob}::uuid,
        'cHNidP8BAAAAAAAAAAAAAA==', ${Buffer.alloc(32, 0x88)}, ${Buffer.alloc(32, 0x89)},
        'finalized', ${'11'.repeat(10)}, ${Buffer.alloc(32, 0x8a)},
        now() + interval '15 minutes'
      )
    `;
    await tx`
      INSERT INTO vault_broadcast_approvals (
        id, proposal_id, vault_id, proposal_digest, final_txid, user_id,
        participant_id, credential_id, challenge, status, expires_at,
        consumed_at, approved_at
      ) VALUES (
        '82555555-5555-4555-8555-555555555551'::uuid, ${childProposal}::uuid,
        ${transitionVault}::uuid, ${Buffer.alloc(32, 0x89)}, ${Buffer.alloc(32, 0x8a)},
        ${bob}::uuid, 'bob', 'reorg-bob', 'approved-child', 'approved',
        now() + interval '5 minutes', now(), now()
      )
    `;
    await tx`
      INSERT INTO vault_coin_observations (
        coin_id, vault_id, user_id, participant_id, credential_id,
        snapshot_digest, source_origin, confirmations, observed_unspent
      ) VALUES (
        ${successorCoin}::uuid, ${transitionVault}::uuid, ${bob}::uuid, 'bob',
        'reorg-bob', ${Buffer.alloc(32, 0x8b)}, 'https://chain.example', 3, true
      )
    `;
    await tx`
      INSERT INTO vault_coin_observation_challenges (
        coin_id, vault_id, user_id, participant_id, credential_id, challenge,
        snapshot_digest, source_origin, confirmations, observed_unspent, expires_at
      ) VALUES (
        ${successorCoin}::uuid, ${transitionVault}::uuid, ${bob}::uuid, 'bob',
        'reorg-bob', 'observe-child', ${Buffer.alloc(32, 0x8b)},
        'https://chain.example', 3, true, now() + interval '5 minutes'
      )
    `;
  });
}

async function seedReanchor(): Promise<void> {
  await seedBase(reanchorVault, 'closed', reanchorRosterDigest);
  await sql.begin(async (tx) => {
    const coinId = '82444444-4444-4444-8444-444444444451';
    await tx`
      INSERT INTO vault_coins (
        id, vault_id, roster_digest, kind, round_id, owner_participant_id,
        txid, vout, value_sats, script_pubkey, status, confirmed_height, spent_by_txid
      ) VALUES (
        ${coinId}::uuid, ${reanchorVault}::uuid, ${reanchorRosterDigest}, 'final_payout',
        NULL, 'alice', ${Buffer.alloc(32, 0x86)}, 0, 10000,
        ${taproot(0x86)}, 'spent', 899999, ${Buffer.alloc(32, 0x86)}
      )
    `;
    await tx`
      INSERT INTO vault_transaction_proposals (
        id, vault_id, roster_digest, input_coin_id, kind, round_id,
        actor_participant_id, proposer_user_id, psbt_base64, unsigned_txid,
        proposal_digest, status, finalized_tx_hex, final_txid, expires_at,
        confirmed_height, confirmed_block_hash
      ) VALUES (
        '82333333-3333-4333-8333-333333333341'::uuid, ${reanchorVault}::uuid,
        ${reanchorRosterDigest}, ${coinId}::uuid, 'final_sweep', NULL, 'alice', ${alice}::uuid,
        'cHNidP8BAAAAAAAAAAAAAA==', ${Buffer.alloc(32, 0x86)}, ${Buffer.alloc(32, 0x87)},
        'confirmed', ${'22'.repeat(10)}, ${Buffer.alloc(32, 0x86)},
        now() + interval '15 minutes', 900001, ${Buffer.alloc(32, 0x87)}
      )
    `;
  });
}

async function seedFundingRollback(): Promise<void> {
  await seedBase(fundingVault, 'active', fundingRosterDigest);
  await sql.begin(async (tx) => {
    const coinId = '82444444-4444-4444-8444-444444444461';
    const proposalId = '82333333-3333-4333-8333-333333333361';
    await tx`
      INSERT INTO funding_finalizations (
        vault_id, roster_digest, proposal_digest, finalization_digest,
        final_txid, transaction_hex, fee_sats, vsize, status,
        approved_at, submission_started_at, broadcast_at, confirmed_at,
        confirmed_height, confirmed_block_hash
      ) VALUES (
        ${fundingVault}::uuid, ${fundingRosterDigest}, ${Buffer.alloc(32, 0x90)},
        ${Buffer.alloc(32, 0x91)}, ${Buffer.alloc(32, 0x91)}, ${'33'.repeat(10)},
        600, 100, 'confirmed', now(), now(), now(), now(), 900002,
        ${Buffer.alloc(32, 0x92)}
      )
    `;
    await tx`
      INSERT INTO vault_coins (
        id, vault_id, roster_digest, kind, round_id, owner_participant_id,
        txid, vout, value_sats, script_pubkey, status, confirmed_height
      ) VALUES (
        ${coinId}::uuid, ${fundingVault}::uuid, ${fundingRosterDigest}, 'vault',
        'alicebobcarol', NULL, ${Buffer.alloc(32, 0x91)}, 0, 30000,
        ${taproot(0x91)}, 'current', 900002
      )
    `;
    await tx`
      INSERT INTO vault_transaction_proposals (
        id, vault_id, roster_digest, input_coin_id, kind, round_id,
        actor_participant_id, proposer_user_id, psbt_base64, unsigned_txid,
        proposal_digest, status, finalized_tx_hex, final_txid, expires_at
      ) VALUES (
        ${proposalId}::uuid, ${fundingVault}::uuid, ${fundingRosterDigest}, ${coinId}::uuid,
        'cooperative', 'alicebobcarol', NULL, ${alice}::uuid,
        'cHNidP8BAAAAAAAAAAAAAA==', ${Buffer.alloc(32, 0x93)}, ${Buffer.alloc(32, 0x94)},
        'broadcast', ${'44'.repeat(10)}, ${Buffer.alloc(32, 0x95)},
        now() + interval '15 minutes'
      )
    `;
  });
}

async function seedBase(
  vaultId: string,
  status: 'active' | 'closed',
  digest: Buffer,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO vaults (id, name, status) VALUES (${vaultId}::uuid, 'Reorg acceptance', ${status})`;
    for (const [userId, participantId, credentialId] of [
      [alice, 'alice', 'reorg-alice'],
      [bob, 'bob', 'reorg-bob'],
    ] as const) {
      await tx`
        INSERT INTO users (id, display_name) VALUES (${userId}::uuid, ${participantId})
        ON CONFLICT (id) DO NOTHING
      `;
      await tx`
        INSERT INTO vault_members (vault_id, user_id, participant_id)
        VALUES (${vaultId}::uuid, ${userId}::uuid, ${participantId})
      `;
      await tx`
        INSERT INTO webauthn_credentials (
          credential_id, user_id, public_key, counter, transports,
          device_type, backed_up, prf_enabled
        ) VALUES (
          ${credentialId}, ${userId}::uuid, ${Buffer.alloc(65, 0x55)}, 0,
          ARRAY['internal'], 'multiDevice', true, true
        ) ON CONFLICT (credential_id) DO NOTHING
      `;
    }
    await tx`
      INSERT INTO vault_rosters (
        vault_id, version, network, artifact_json, digest, funding_address, status, confirmed_at
      ) VALUES (
        ${vaultId}::uuid, 1, ${BITCOIN_NETWORK_NAME}, '{}'::jsonb, ${digest},
        ${BITCOIN_NETWORK_NAME === 'mainnet' ? 'bc1preorgacceptance' : 'tb1preorgacceptance'}, 'confirmed', now()
      )
    `;
  });
}

function taproot(byte: number): Buffer {
  return Buffer.from(`5120${byte.toString(16).padStart(2, '0').repeat(32)}`, 'hex');
}

async function check(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  checks.push({ name, ok: true });
}
