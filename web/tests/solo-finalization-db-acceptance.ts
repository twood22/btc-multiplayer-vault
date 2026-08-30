import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as bitcoin from 'bitcoinjs-lib';
import postgres from 'postgres';
import { BITCOIN_NETWORK_NAME } from '../../src/network.js';
import { buildVaultProposal } from '../../src/vault-runtime.js';
import { closeDatabase } from '../lib/server/db.js';
import { finalizeStoredSoloProposal } from '../lib/server/vault-runtime-store.js';
import {
  createIsolatedSoloFixture,
  signPolicyLeafPsbt,
  SOLO_PARTICIPANTS,
  SOLO_ROUND,
} from './solo-signing-fixture.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for solo finalization database acceptance');

const sql = postgres(databaseUrl, { max: 4 });
const vaultId = randomUUID();
const coinId = randomUUID();
const proposalId = randomUUID();
const userIds = Object.fromEntries(SOLO_PARTICIPANTS.map((id) => [id, randomUUID()])) as
  Record<(typeof SOLO_PARTICIPANTS)[number], string>;
const fixture = createIsolatedSoloFixture(vaultId);
const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
const coin = {
  vaultId,
  rosterDigest: fixture.digest,
  kind: 'vault' as const,
  roundId: SOLO_ROUND,
  ownerParticipantId: null,
  txid: '91'.repeat(32),
  vout: 0,
  valueSats: fixture.artifact.funding.valueSats,
  scriptPubKeyHex: fixture.artifact.funding.outputScriptHex,
};
const proposal = buildVaultProposal({
  artifact: fixture.artifact,
  coin,
  kind: 'solo',
  actorParticipantId: 'alice',
  expiresAt,
});
const signed = signPolicyLeafPsbt(
  proposal.psbtBase64,
  fixture.policyPrivateKeys.get(`alice:${SOLO_ROUND}`)!,
);
const checks: Array<{ name: string; ok: true }> = [];

try {
  await seed();

  await check('another participant cannot finalize the stored solo proposal', async () => {
    await assert.rejects(() => finalizeStoredSoloProposal({
      userId: userIds.bob,
      proposalId,
      proposalDigest: proposal.digest,
      transactionHex: signed.txHex,
      signedPsbtBase64: signed.psbtBase64,
    }), /cannot finalize/u);
    assert.equal(await proposalStatus(), 'collecting');
  });

  await check('server reauthorization rejects a signer-mutated transaction without changing state', async () => {
    const transaction = bitcoin.Transaction.fromHex(signed.txHex);
    transaction.outs[0]!.value -= 1n;
    await assert.rejects(() => finalizeStoredSoloProposal({
      userId: userIds.alice,
      proposalId,
      proposalDigest: proposal.digest,
      transactionHex: transaction.toHex(),
      signedPsbtBase64: signed.psbtBase64,
    }), /changed output|transaction differs|signature verification/u);
    assert.equal(await proposalStatus(), 'collecting');
  });

  await check('the exact consensus-valid solo result finalizes one stored proposal', async () => {
    const finalized = await finalizeStoredSoloProposal({
      userId: userIds.alice,
      proposalId,
      proposalDigest: proposal.digest,
      transactionHex: signed.txHex,
      signedPsbtBase64: signed.psbtBase64,
    });
    assert.equal(finalized.txid, proposal.unsignedTxid);
    assert(finalized.consensusChecks.some((item) => item.includes('OP_CHECKSIG satisfied')));
    const rows = await sql<Array<{
      status: string;
      finalized_tx_hex: string;
      final_txid: Buffer;
    }>>`
      SELECT status, finalized_tx_hex, final_txid
      FROM vault_transaction_proposals WHERE id = ${proposalId}::uuid
    `;
    assert.deepEqual(rows[0], {
      status: 'finalized',
      finalized_tx_hex: signed.txHex,
      final_txid: Buffer.from(proposal.unsignedTxid, 'hex'),
    });
  });

  await check('a finalized solo proposal cannot be replayed through the finalization boundary', async () => {
    await assert.rejects(() => finalizeStoredSoloProposal({
      userId: userIds.alice,
      proposalId,
      proposalDigest: proposal.digest,
      transactionHex: signed.txHex,
      signedPsbtBase64: signed.psbtBase64,
    }), /no longer collecting/u);
    assert.equal(await proposalStatus(), 'finalized');
  });
} finally {
  await closeDatabase();
  await sql`DELETE FROM vaults WHERE id = ${vaultId}::uuid`.catch(() => undefined);
  await sql`DELETE FROM users WHERE id = ANY(${Object.values(userIds)}::uuid[])`.catch(() => undefined);
  await sql.end({ timeout: 5 });
}

console.log(JSON.stringify({
  title: 'isolated server-side solo finalization database acceptance',
  passed: true,
  externalSigbashContacted: false,
  liveMainnetEvidence: false,
  checks,
}, null, 2));

async function seed(): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO vaults (id, name, status) VALUES (${vaultId}::uuid, 'Solo finalization acceptance', 'active')`;
    for (const id of SOLO_PARTICIPANTS) {
      await tx`INSERT INTO users (id, display_name) VALUES (${userIds[id]}::uuid, ${`${id} acceptance`})`;
      await tx`
        INSERT INTO vault_members (vault_id, user_id, participant_id)
        VALUES (${vaultId}::uuid, ${userIds[id]}::uuid, ${id})
      `;
    }
    await tx`
      INSERT INTO vault_rosters (
        vault_id, version, network, artifact_json, digest, funding_address,
        status, confirmed_at
      ) VALUES (
        ${vaultId}::uuid, 1, ${BITCOIN_NETWORK_NAME},
        ${tx.json(JSON.parse(JSON.stringify(fixture.artifact)))},
        ${Buffer.from(fixture.digest, 'hex')}, ${fixture.artifact.funding.address},
        'confirmed', now()
      )
    `;
    await tx`
      INSERT INTO vault_coins (
        id, vault_id, roster_digest, kind, round_id, owner_participant_id,
        txid, vout, value_sats, script_pubkey, status, confirmed_height
      ) VALUES (
        ${coinId}::uuid, ${vaultId}::uuid, ${Buffer.from(fixture.digest, 'hex')},
        'vault', ${SOLO_ROUND}, NULL, ${Buffer.from(coin.txid, 'hex')}, ${coin.vout},
        ${coin.valueSats}, ${Buffer.from(coin.scriptPubKeyHex, 'hex')}, 'current', 850000
      )
    `;
    await tx`
      INSERT INTO vault_transaction_proposals (
        id, vault_id, roster_digest, input_coin_id, kind, round_id,
        actor_participant_id, proposer_user_id, psbt_base64, unsigned_txid,
        proposal_digest, expires_at
      ) VALUES (
        ${proposalId}::uuid, ${vaultId}::uuid, ${Buffer.from(fixture.digest, 'hex')},
        ${coinId}::uuid, 'solo', ${SOLO_ROUND}, 'alice', ${userIds.alice}::uuid,
        ${proposal.psbtBase64}, ${Buffer.from(proposal.unsignedTxid, 'hex')},
        ${Buffer.from(proposal.digest, 'hex')}, ${new Date(expiresAt)}
      )
    `;
  });
}

async function proposalStatus(): Promise<string | undefined> {
  const rows = await sql<Array<{ status: string }>>`
    SELECT status FROM vault_transaction_proposals WHERE id = ${proposalId}::uuid
  `;
  return rows[0]?.status;
}

async function check(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  checks.push({ name, ok: true });
}
