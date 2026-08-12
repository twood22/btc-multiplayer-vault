import assert from 'node:assert/strict';
import * as bitcoin from 'bitcoinjs-lib';
import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for broadcast database acceptance');

const sql = postgres(databaseUrl, { max: 8 });
const checks: Array<{ name: string; ok: boolean }> = [];
const vaultId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const coinId = '33333333-3333-4333-8333-333333333333';
const proposalId = '44444444-4444-4444-8444-444444444444';
const rosterDigest = Buffer.alloc(32, 0x11);
const proposalDigest = Buffer.alloc(32, 0x22);
const transaction = new bitcoin.Transaction();
transaction.version = 2;
transaction.addInput(Buffer.alloc(32, 0x33), 0, 0xfffffffd);
transaction.addOutput(Buffer.from(`5120${'44'.repeat(32)}`, 'hex'), 9_000n);
const finalizedTxHex = transaction.toHex();
const finalTxid = Buffer.from(transaction.getId(), 'hex');

try {
  await seed();

  await check('migration 007 records exactly once with expected constraints and indexes', async () => {
    const versions = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM schema_migrations
      WHERE version = '007_broadcast_approval'
    `;
    assert.equal(versions[0]?.count, '1');
    const constraints = await sql<Array<{ name: string }>>`
      SELECT conname AS name FROM pg_constraint
      WHERE conrelid = 'vault_broadcast_approvals'::regclass
      ORDER BY conname
    `;
    assert(constraints.length >= 8);
    const indexes = await sql<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'vault_broadcast_approvals'
    `;
    assert(indexes.some((row) => row.indexname === 'vault_broadcast_approvals_one_live_idx'));
  });

  await check('only one concurrent live approval can exist for a finalized proposal', async () => {
    const attempts = await Promise.allSettled([
      insertPending('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'challenge-a'),
      insertPending('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'challenge-b'),
    ]);
    assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((item) => item.status === 'rejected').length, 1);
    const live = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM vault_broadcast_approvals
      WHERE proposal_id = ${proposalId}::uuid
        AND status IN ('pending', 'approved', 'submitting', 'broadcast')
    `;
    assert.equal(live[0]?.count, '1');
  });

  await check('approval shape rejects status advancement without a consumed passkey ceremony', async () => {
    await assert.rejects(() => sql`
      UPDATE vault_broadcast_approvals SET status = 'approved'
      WHERE proposal_id = ${proposalId}::uuid AND status = 'pending'
    `, /vault_broadcast_approvals_check/);
  });

  await check('one consumed approval is claimed by exactly one concurrent submitter', async () => {
    const approved = await sql<Array<{ id: string }>>`
      UPDATE vault_broadcast_approvals
      SET status = 'approved', consumed_at = now(), approved_at = now(), updated_at = now()
      WHERE proposal_id = ${proposalId}::uuid AND status = 'pending'
      RETURNING id
    `;
    assert.equal(approved.length, 1);
    const claim = () => sql<Array<{ id: string }>>`
      UPDATE vault_broadcast_approvals SET status = 'submitting', updated_at = now()
      WHERE id = ${approved[0]!.id}::uuid AND status = 'approved'
      RETURNING id
    `;
    const claims = await Promise.all([claim(), claim()]);
    assert.deepEqual(claims.map((rows) => rows.length).sort(), [0, 1]);
  });

  await check('a failed submission is auditable and permits one fresh passkey challenge', async () => {
    const failed = await sql<Array<{ id: string }>>`
      UPDATE vault_broadcast_approvals
      SET status = 'failed', failure_reason = 'controlled acceptance failure', updated_at = now()
      WHERE proposal_id = ${proposalId}::uuid AND status = 'submitting'
      RETURNING id
    `;
    assert.equal(failed.length, 1);
    await insertPending('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'challenge-c');
    await assert.rejects(
      () => insertPending('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'challenge-d'),
      /vault_broadcast_approvals_one_live_idx/,
    );
    const audit = await sql<Array<{ status: string; failure_reason: string | null }>>`
      SELECT status, failure_reason FROM vault_broadcast_approvals
      WHERE proposal_id = ${proposalId}::uuid ORDER BY created_at, id
    `;
    assert(audit.some((row) => row.status === 'failed' && row.failure_reason === 'controlled acceptance failure'));
    assert(audit.some((row) => row.status === 'pending' && row.failure_reason === null));
  });

  await check('approval foreign keys reject a digest not committed by the proposal', async () => {
    await sql`DELETE FROM vault_broadcast_approvals WHERE status = 'pending'`;
    await assert.rejects(
      () => sql`
        INSERT INTO vault_broadcast_approvals (
          id, proposal_id, vault_id, proposal_digest, final_txid, user_id,
          participant_id, credential_id, challenge, expires_at
        ) VALUES (
          'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid,
          ${proposalId}::uuid, ${vaultId}::uuid, ${Buffer.alloc(32, 0xff)},
          ${finalTxid}, ${userId}::uuid, 'alice', 'credential-alice',
          'wrong-digest', now() + interval '5 minutes'
        )
      `,
      (error: unknown) => Boolean(
        error && typeof error === 'object' &&
        (error as { code?: string }).code === '23503' &&
        (error as { constraint_name?: string }).constraint_name
          ?.startsWith('vault_broadcast_approvals_proposal_id_vault_id_proposal_di'),
      ),
    );
  });
} finally {
  await sql.end();
}

console.log(JSON.stringify({ passed: checks.every((item) => item.ok), checks }, null, 2));

async function seed(): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO vaults (id, name, status)
      VALUES (${vaultId}::uuid, 'Broadcast acceptance vault', 'active')
    `;
    await tx`
      INSERT INTO users (id, display_name) VALUES (${userId}::uuid, 'Alice')
    `;
    await tx`
      INSERT INTO vault_members (vault_id, user_id, participant_id)
      VALUES (${vaultId}::uuid, ${userId}::uuid, 'alice')
    `;
    await tx`
      INSERT INTO webauthn_credentials (
        credential_id, user_id, public_key, counter, transports,
        device_type, backed_up, prf_enabled
      ) VALUES (
        'credential-alice', ${userId}::uuid, ${Buffer.alloc(65, 0x55)}, 0,
        ARRAY['internal'], 'multiDevice', true, true
      )
    `;
    await tx`
      INSERT INTO vault_rosters (
        vault_id, version, network, artifact_json, digest, funding_address, status, confirmed_at
      ) VALUES (
        ${vaultId}::uuid, 1, 'mainnet', '{}'::jsonb, ${rosterDigest},
        'bc1pacceptance', 'confirmed', now()
      )
    `;
    await tx`
      INSERT INTO vault_coins (
        id, vault_id, roster_digest, kind, round_id, owner_participant_id,
        txid, vout, value_sats, script_pubkey, status, confirmed_height
      ) VALUES (
        ${coinId}::uuid, ${vaultId}::uuid, ${rosterDigest}, 'final_payout', NULL,
        'alice', ${Buffer.alloc(32, 0x33)}, 0, 10000,
        ${Buffer.from(`5120${'44'.repeat(32)}`, 'hex')}, 'current', 850000
      )
    `;
    await tx`
      INSERT INTO vault_transaction_proposals (
        id, vault_id, roster_digest, input_coin_id, kind, round_id,
        actor_participant_id, proposer_user_id, psbt_base64, unsigned_txid,
        proposal_digest, status, finalized_tx_hex, final_txid, expires_at
      ) VALUES (
        ${proposalId}::uuid, ${vaultId}::uuid, ${rosterDigest}, ${coinId}::uuid,
        'final_sweep', NULL, 'alice', ${userId}::uuid, 'cHNidP8BAAAAAAAAAAAAAA==',
        ${finalTxid}, ${proposalDigest}, 'finalized', ${finalizedTxHex},
        ${finalTxid}, now() + interval '15 minutes'
      )
    `;
  });
}

async function insertPending(id: string, challenge: string): Promise<void> {
  await sql`
    INSERT INTO vault_broadcast_approvals (
      id, proposal_id, vault_id, proposal_digest, final_txid, user_id,
      participant_id, credential_id, challenge, expires_at
    ) VALUES (
      ${id}::uuid, ${proposalId}::uuid, ${vaultId}::uuid, ${proposalDigest},
      ${finalTxid}, ${userId}::uuid, 'alice', 'credential-alice', ${challenge},
      now() + interval '5 minutes'
    )
  `;
}

async function check(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  checks.push({ name, ok: true });
}
