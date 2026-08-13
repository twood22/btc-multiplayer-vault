import assert from 'node:assert/strict';
import * as bitcoin from 'bitcoinjs-lib';
import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for funding database acceptance');

const sql = postgres(databaseUrl, { max: 4 });
const checks: Array<{ name: string; ok: true }> = [];
const vaultId = '71111111-1111-4111-8111-111111111111';
const rosterDigest = Buffer.alloc(32, 0x71);
const proposalDigest = Buffer.alloc(32, 0x72);
const finalizationDigest = Buffer.alloc(32, 0x73);
const participants = [
  { id: 'alice', userId: '72222222-2222-4222-8222-222222222221', credentialId: 'funding-db-alice' },
  { id: 'bob', userId: '72222222-2222-4222-8222-222222222222', credentialId: 'funding-db-bob' },
  { id: 'carol', userId: '72222222-2222-4222-8222-222222222223', credentialId: 'funding-db-carol' },
] as const;
const transaction = new bitcoin.Transaction();
transaction.version = 2;
for (let index = 0; index < 3; index += 1) {
  transaction.addInput(Buffer.alloc(32, 0x80 + index), index, 0xfffffffd);
  transaction.ins[index]!.witness = [Buffer.alloc(64, 0x90 + index)];
}
transaction.addOutput(Buffer.from(`5120${'aa'.repeat(32)}`, 'hex'), 30_000n);
const transactionHex = transaction.toHex();
const finalTxid = Buffer.from(transaction.getId(), 'hex');

try {
  await seed();

  await check('migrations 010 and 011 are recorded exactly once', async () => {
    const rows = await sql<Array<{ version: string; count: string }>>`
      SELECT version, count(*)::text AS count FROM schema_migrations
      WHERE version IN ('010_funding_signatures', '011_funding_restart')
      GROUP BY version ORDER BY version
    `;
    assert.deepEqual(Array.from(rows), [
      { version: '010_funding_signatures', count: '1' },
      { version: '011_funding_restart', count: '1' },
    ]);
  });

  await check('one passkey-bound normalized signature is stored for each distinct funding input', async () => {
    for (const [index, participant] of participants.entries()) {
      const challengeId = restartableUuid(0x30 + index);
      await sql`
        INSERT INTO funding_signature_challenges (
          id, vault_id, user_id, participant_id, roster_digest, proposal_digest,
          input_index, signature_kind, signature, public_key, contribution_digest,
          credential_id, challenge, expires_at, consumed_at
        ) VALUES (
          ${challengeId}::uuid, ${vaultId}::uuid, ${participant.userId}::uuid,
          ${participant.id}, ${rosterDigest}, ${proposalDigest}, ${index}, 'p2tr',
          ${Buffer.alloc(64, 0x40 + index)}, NULL, ${Buffer.alloc(32, 0x50 + index)},
          ${participant.credentialId}, ${`signature-${participant.id}`},
          now() + interval '5 minutes', now()
        )
      `;
      await sql`
        INSERT INTO participant_funding_signatures (
          vault_id, user_id, participant_id, roster_digest, proposal_digest,
          input_index, signature_kind, signature, public_key, contribution_digest,
          credential_id, challenge_id
        ) VALUES (
          ${vaultId}::uuid, ${participant.userId}::uuid, ${participant.id},
          ${rosterDigest}, ${proposalDigest}, ${index}, 'p2tr',
          ${Buffer.alloc(64, 0x40 + index)}, NULL, ${Buffer.alloc(32, 0x50 + index)},
          ${participant.credentialId}, ${challengeId}::uuid
        )
      `;
    }
    const count = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM participant_funding_signatures
      WHERE vault_id = ${vaultId}::uuid
    `;
    assert.equal(count[0]?.count, '3');
  });

  await check('finalization state timestamps and operator submission claim remain internally consistent', async () => {
    await sql`
      INSERT INTO funding_finalizations (
        vault_id, roster_digest, proposal_digest, finalization_digest,
        final_txid, transaction_hex, fee_sats, vsize
      ) VALUES (
        ${vaultId}::uuid, ${rosterDigest}, ${proposalDigest}, ${finalizationDigest},
        ${finalTxid}, ${transactionHex}, 600, ${transaction.virtualSize()}
      )
    `;
    await assert.rejects(() => sql`
      UPDATE funding_finalizations SET status = 'approved'
      WHERE vault_id = ${vaultId}::uuid
    `, /funding_finalizations_check/u);
    for (const [index, participant] of participants.entries()) {
      const challengeId = restartableUuid(0x40 + index);
      await sql`
        INSERT INTO funding_final_approval_challenges (
          id, vault_id, user_id, participant_id, finalization_digest,
          credential_id, challenge, expires_at, consumed_at
        ) VALUES (
          ${challengeId}::uuid, ${vaultId}::uuid, ${participant.userId}::uuid,
          ${participant.id}, ${finalizationDigest}, ${participant.credentialId},
          ${`final-${participant.id}`}, now() + interval '5 minutes', now()
        )
      `;
      await sql`
        INSERT INTO funding_final_approvals (
          vault_id, user_id, participant_id, finalization_digest, credential_id, challenge_id
        ) VALUES (
          ${vaultId}::uuid, ${participant.userId}::uuid, ${participant.id},
          ${finalizationDigest}, ${participant.credentialId}, ${challengeId}::uuid
        )
      `;
    }
    const updated = await sql<Array<{ status: string }>>`
      UPDATE funding_finalizations SET status = 'approved', approved_at = now()
      WHERE vault_id = ${vaultId}::uuid AND status = 'awaiting_approvals'
      RETURNING status
    `;
    assert.equal(updated[0]?.status, 'approved');
    await assert.rejects(() => sql`
      UPDATE funding_finalizations SET status = 'broadcast', broadcast_at = now()
      WHERE vault_id = ${vaultId}::uuid
    `, /funding_finalizations_check/u);
    const claimed = await sql<Array<{ status: string }>>`
      UPDATE funding_finalizations
      SET status = 'submitting', submission_started_at = now()
      WHERE vault_id = ${vaultId}::uuid AND status = 'approved'
      RETURNING status
    `;
    assert.equal(claimed[0]?.status, 'submitting');
    await sql`
      UPDATE funding_finalizations
      SET status = 'approved', submission_started_at = NULL
      WHERE vault_id = ${vaultId}::uuid AND status = 'submitting'
    `;
  });

  await check('three matching restart approvals archive an audit event before atomically clearing ceremony state', async () => {
    const stateDigest = Buffer.alloc(32, 0xb1);
    const restartDigest = Buffer.alloc(32, 0xb2);
    const reason = 'Alice selected an input that was spent before broadcast.';
    const snapshot = {
      version: 1,
      network: 'mainnet',
      vaultId,
      rosterDigest: rosterDigest.toString('hex'),
      inputs: participants.map((participant, index) => ({
        participantId: participant.id,
        commitmentDigest: Buffer.alloc(32, 0x20 + index).toString('hex'),
      })),
      signatures: participants.map((participant, index) => ({
        participantId: participant.id,
        contributionDigest: Buffer.alloc(32, 0x50 + index).toString('hex'),
      })),
      finalization: { finalizationDigest: finalizationDigest.toString('hex'), status: 'approved' },
    };
    for (const [index, participant] of participants.entries()) {
      const challengeId = restartableUuid(0x50 + index);
      await sql`
        INSERT INTO funding_restart_challenges (
          id, vault_id, user_id, participant_id, roster_digest, state_digest,
          restart_digest, snapshot_json, reason, credential_id, challenge,
          expires_at, consumed_at
        ) VALUES (
          ${challengeId}::uuid, ${vaultId}::uuid, ${participant.userId}::uuid,
          ${participant.id}, ${rosterDigest}, ${stateDigest}, ${restartDigest},
          ${sql.json(snapshot)}, ${reason}, ${participant.credentialId},
          ${`restart-${participant.id}`}, now() + interval '5 minutes', now()
        )
      `;
      await sql`
        INSERT INTO funding_restart_approvals (
          vault_id, user_id, participant_id, roster_digest, state_digest,
          restart_digest, reason, credential_id, challenge_id
        ) VALUES (
          ${vaultId}::uuid, ${participant.userId}::uuid, ${participant.id},
          ${rosterDigest}, ${stateDigest}, ${restartDigest}, ${reason},
          ${participant.credentialId}, ${challengeId}::uuid
        )
      `;
    }
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO funding_restart_events (
          vault_id, roster_digest, state_digest, restart_digest,
          snapshot_json, reason, approved_participant_ids
        ) VALUES (
          ${vaultId}::uuid, ${rosterDigest}, ${stateDigest}, ${restartDigest},
          ${tx.json(snapshot)}, ${reason}, ${tx.json(['alice', 'bob', 'carol'])}
        )
      `;
      await tx`DELETE FROM funding_final_approvals WHERE vault_id = ${vaultId}::uuid`;
      await tx`DELETE FROM funding_final_approval_challenges WHERE vault_id = ${vaultId}::uuid`;
      await tx`DELETE FROM funding_finalizations WHERE vault_id = ${vaultId}::uuid`;
      await tx`DELETE FROM participant_funding_signatures WHERE vault_id = ${vaultId}::uuid`;
      await tx`DELETE FROM funding_signature_challenges WHERE vault_id = ${vaultId}::uuid`;
      await tx`DELETE FROM participant_funding_inputs WHERE vault_id = ${vaultId}::uuid`;
      await tx`DELETE FROM funding_input_challenges WHERE vault_id = ${vaultId}::uuid`;
      await tx`DELETE FROM funding_restart_approvals WHERE vault_id = ${vaultId}::uuid`;
      await tx`DELETE FROM funding_restart_challenges WHERE vault_id = ${vaultId}::uuid`;
    });
    const counts = await sql<Array<{ events: string; inputs: string; signatures: string; finalizations: string }>>`
      SELECT
        (SELECT count(*)::text FROM funding_restart_events WHERE vault_id = ${vaultId}::uuid) AS events,
        (SELECT count(*)::text FROM participant_funding_inputs WHERE vault_id = ${vaultId}::uuid) AS inputs,
        (SELECT count(*)::text FROM participant_funding_signatures WHERE vault_id = ${vaultId}::uuid) AS signatures,
        (SELECT count(*)::text FROM funding_finalizations WHERE vault_id = ${vaultId}::uuid) AS finalizations
    `;
    assert.deepEqual(counts[0], { events: '1', inputs: '0', signatures: '0', finalizations: '0' });
  });
} finally {
  await sql.end();
}

console.log(JSON.stringify({ passed: true, checks }, null, 2));

async function seed(): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO vaults (id, name, status) VALUES (${vaultId}::uuid, 'Funding DB acceptance', 'ready')`;
    for (const participant of participants) {
      await tx`
        INSERT INTO users (id, display_name) VALUES (${participant.userId}::uuid, ${participant.id})
      `;
      await tx`
        INSERT INTO vault_members (vault_id, user_id, participant_id)
        VALUES (${vaultId}::uuid, ${participant.userId}::uuid, ${participant.id})
      `;
      await tx`
        INSERT INTO webauthn_credentials (
          credential_id, user_id, public_key, counter, transports,
          device_type, backed_up, prf_enabled
        ) VALUES (
          ${participant.credentialId}, ${participant.userId}::uuid, ${Buffer.alloc(65, 0x61)},
          0, ARRAY['internal'], 'multiDevice', true, true
        )
      `;
    }
    await tx`
      INSERT INTO vault_rosters (
        vault_id, version, network, artifact_json, digest, funding_address, status, confirmed_at
      ) VALUES (
        ${vaultId}::uuid, 1, 'mainnet', '{}'::jsonb, ${rosterDigest},
        'bc1pfundingdbacceptance', 'confirmed', now()
      )
    `;
    for (const [index, participant] of participants.entries()) {
      const challengeId = restartableUuid(0x20 + index);
      const txid = Buffer.alloc(32, 0x80 + index);
      const commitmentDigest = Buffer.alloc(32, 0x20 + index);
      await tx`
        INSERT INTO funding_input_challenges (
          id, vault_id, user_id, participant_id, roster_digest, credential_id, challenge,
          txid, vout, value_sats, script_pubkey, change_address, source_origin,
          confirmations, funding_fee_sats, commitment_digest, expires_at, consumed_at
        ) VALUES (
          ${challengeId}::uuid, ${vaultId}::uuid, ${participant.userId}::uuid,
          ${participant.id}, ${rosterDigest}, ${participant.credentialId},
          ${`input-${participant.id}`}, ${txid}, ${index}, 10530,
          ${Buffer.from(`5120${(0x80 + index).toString(16).repeat(32)}`, 'hex')},
          'bc1pfundingdbchange', 'https://chain.example', 2, 600,
          ${commitmentDigest}, now() + interval '5 minutes', now()
        )
      `;
      await tx`
        INSERT INTO participant_funding_inputs (
          vault_id, user_id, participant_id, roster_digest, txid, vout, value_sats,
          script_pubkey, change_address, source_origin, confirmations, funding_fee_sats,
          commitment_digest, credential_id, challenge_id
        ) VALUES (
          ${vaultId}::uuid, ${participant.userId}::uuid, ${participant.id}, ${rosterDigest},
          ${txid}, ${index}, 10530,
          ${Buffer.from(`5120${(0x80 + index).toString(16).repeat(32)}`, 'hex')},
          'bc1pfundingdbchange', 'https://chain.example', 2, 600,
          ${commitmentDigest}, ${participant.credentialId}, ${challengeId}::uuid
        )
      `;
    }
  });
}

function restartableUuid(byte: number): string {
  const hex = byte.toString(16).padStart(2, '0');
  return `${hex.repeat(4)}-${hex.repeat(2)}-4${hex.repeat(1).slice(1)}${hex}-${`8${hex.repeat(2).slice(1)}`}-${hex.repeat(6)}`;
}

async function check(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  checks.push({ name, ok: true });
}
