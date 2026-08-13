import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import * as bitcoin from 'bitcoinjs-lib';
import postgres from 'postgres';
import { sha256Hex } from '../../src/crypto.js';
import { verifyVaultTransaction } from '../../src/consensus.js';
import type { PublishedRosterArtifact } from '../../src/roster-ceremony.js';
import { publishedRosterDigest } from '../../src/roster-ceremony.js';
import { vaultCoinSnapshotDigest, type VaultCoinSnapshot } from '../../src/vault-runtime.js';
import {
  createParticipantBrowser,
  participants,
  seedPublicSigbashRegistrations,
  type ParticipantBrowser,
  type ParticipantId,
} from './participant-fixture';

test('three passkey-held participants complete cooperative MuSig2 with Sigbash unavailable', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  if (!baseURL) throw new Error('browser test base URL is required');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for cooperative browser acceptance');
  const sql = postgres(databaseUrl, { max: 4 });
  const vaultId = randomUUID();
  const invitationTokens = Object.fromEntries(participants.map((id) => [
    id,
    randomBytes(32).toString('base64url'),
  ])) as Record<ParticipantId, string>;
  const browsers: ParticipantBrowser[] = [];
  const forbiddenSigbashRequests: string[] = [];
  let userIds: string[] = [];

  try {
    await sql`INSERT INTO vaults (id, name) VALUES (${vaultId}::uuid, 'Three-browser MuSig2 acceptance')`;
    for (const id of participants) {
      await sql`
        INSERT INTO invites (vault_id, participant_id, token_hash, expires_at)
        VALUES (
          ${vaultId}::uuid, ${id},
          ${createHash('sha256').update(invitationTokens[id]).digest()},
          now() + interval '1 hour'
        )
      `;
    }

    for (const id of participants) {
      const participant = await createParticipantBrowser({
        browser,
        baseURL,
        id,
        invitationToken: invitationTokens[id],
        onRequest: (requestUrl) => {
          const url = new URL(requestUrl);
          if (url.hostname.endsWith('sigbash.com') ||
              /^\/api\/sigbash\/(?:runtime|provision|readiness)(?:\/|$)/u.test(url.pathname)) {
            forbiddenSigbashRequests.push(requestUrl);
          }
        },
      });
      browsers.push(participant);
    }

    const members = await sql<Array<{ user_id: string; participant_id: ParticipantId }>>`
      SELECT user_id, participant_id FROM vault_members
      WHERE vault_id = ${vaultId}::uuid ORDER BY participant_id
    `;
    expect(members.map((member) => member.participant_id)).toEqual(participants);
    userIds = members.map((member) => member.user_id);
    const passkeyCustody = await sql<Array<{
      participant_id: ParticipantId;
      credentials: number;
      envelopes: number;
    }>>`
      SELECT m.participant_id,
        count(DISTINCT c.credential_id)::integer AS credentials,
        count(DISTINCT e.credential_id)::integer AS envelopes
      FROM vault_members m
      JOIN webauthn_credentials c ON c.user_id = m.user_id AND c.prf_enabled = true
      JOIN passkey_envelopes e ON e.credential_id = c.credential_id
      WHERE m.vault_id = ${vaultId}::uuid
      GROUP BY m.participant_id
      ORDER BY m.participant_id
    `;
    expect(passkeyCustody).toEqual(participants.map((participantId) => ({
      participant_id: participantId,
      credentials: 2,
      envelopes: 2,
    })));
    await seedPublicSigbashRegistrations(sql, vaultId, members);

    const rosterDigests: string[] = [];
    for (const participant of browsers) {
      await participant.page.goto('/vault');
      await expect(participant.page.getByRole('heading', {
        name: 'Review the same vault together',
      })).toBeVisible();
      const digest = await participant.page.locator('.digest-line code').textContent();
      expect(digest).toMatch(/^[0-9a-f]{64}$/u);
      rosterDigests.push(digest!);
      await participant.page.getByRole('button', { name: 'Confirm this exact roster' }).click();
      await expect(participant.page.getByRole('button', {
        name: 'Confirm this exact roster',
      })).toHaveCount(0);
    }
    expect(new Set(rosterDigests).size).toBe(1);
    for (const participant of browsers) {
      await participant.page.goto('/vault');
      await expect(participant.page.getByRole('heading', {
        name: 'All three friends confirmed',
      })).toBeVisible();
    }

    const rosterRows = await sql<Array<{
      artifact_json: PublishedRosterArtifact;
      digest: Buffer;
      status: string;
    }>>`
      SELECT artifact_json, digest, status FROM vault_rosters
      WHERE vault_id = ${vaultId}::uuid
    `;
    const roster = rosterRows[0]!;
    const artifact = roster.artifact_json;
    const rosterDigest = roster.digest.toString('hex');
    expect(roster.status).toBe('confirmed');
    expect(publishedRosterDigest(artifact)).toBe(rosterDigest);
    expect(artifact.participants).toHaveLength(3);
    expect(artifact.vaults).toHaveLength(4);
    expect(artifact.policies).toHaveLength(9);

    const coinId = randomUUID();
    const coin: VaultCoinSnapshot = {
      vaultId,
      rosterDigest,
      kind: 'vault',
      roundId: artifact.funding.round,
      ownerParticipantId: null,
      txid: sha256Hex(`cooperative-browser-coin:${vaultId}`),
      vout: 0,
      valueSats: artifact.funding.valueSats,
      scriptPubKeyHex: artifact.funding.outputScriptHex,
    };
    await sql.begin(async (tx) => {
      await tx`UPDATE vaults SET status = 'active' WHERE id = ${vaultId}::uuid`;
      await tx`
        INSERT INTO vault_coins (
          id, vault_id, roster_digest, kind, round_id, owner_participant_id,
          txid, vout, value_sats, script_pubkey, status, confirmed_height
        ) VALUES (
          ${coinId}::uuid, ${vaultId}::uuid, ${Buffer.from(rosterDigest, 'hex')},
          'vault', ${coin.roundId}, NULL, ${Buffer.from(coin.txid, 'hex')}, 0,
          ${coin.valueSats}, ${Buffer.from(coin.scriptPubKeyHex, 'hex')}, 'current', 850000
        )
      `;
      const credentials = await tx<Array<{
        user_id: string;
        participant_id: ParticipantId;
        credential_id: string;
      }>>`
        SELECT DISTINCT ON (m.participant_id)
          m.user_id, m.participant_id, c.credential_id
        FROM vault_members m
        JOIN webauthn_credentials c ON c.user_id = m.user_id AND c.prf_enabled = true
        WHERE m.vault_id = ${vaultId}::uuid
        ORDER BY m.participant_id, c.created_at
      `;
      const snapshotDigest = vaultCoinSnapshotDigest(coin);
      for (const credential of credentials) {
        await tx`
          INSERT INTO vault_coin_observations (
            coin_id, vault_id, user_id, participant_id, credential_id,
            snapshot_digest, source_origin, confirmations, observed_unspent
          ) VALUES (
            ${coinId}::uuid, ${vaultId}::uuid, ${credential.user_id}::uuid,
            ${credential.participant_id}, ${credential.credential_id},
            ${Buffer.from(snapshotDigest, 'hex')}, 'https://chain.example', 6, true
          )
        `;
      }
    });

    for (const participant of browsers) {
      await participant.page.goto('/vault');
      await expect(participant.page.getByRole('heading', { name: 'Current Bitcoin coin' })).toBeVisible();
      await expect(participant.page.getByRole('button', {
        name: 'Propose an equal cooperative refund',
      })).toBeVisible();
    }

    const alice = browsers[0]!;
    await alice.page.getByRole('button', { name: 'Propose an equal cooperative refund' }).click();
    await expect(alice.page.getByText(
      'Equal cooperative refund proposed; every current participant signs on their own device',
    )).toBeVisible();
    for (const participant of browsers.slice(1)) await participant.page.reload();

    for (const participant of browsers) {
      await participant.page.getByRole('button', {
        name: 'Join cooperative signing · round 1',
      }).click();
      await expect(participant.page.getByText(
        'Your public nonce is published; its encrypted secret remains only in this browser session',
      )).toBeVisible();
      const storedNonce = await participant.page.evaluate(() => {
        const entry = Object.entries(sessionStorage)
          .find(([key]) => key.startsWith('btc-vault:musig2:'));
        if (!entry) return null;
        return { key: entry[0], value: JSON.parse(entry[1]) as Record<string, unknown> };
      });
      expect(storedNonce).not.toBeNull();
      expect(storedNonce!.key).toContain(`:${participant.id}`);
      expect(Object.keys(storedNonce!.value).sort()).toEqual([
        'ciphertext', 'iv', 'message', 'participantId', 'proposalDigest',
        'proposalId', 'pubnonce', 'round', 'salt', 'version',
      ]);
      expect(storedNonce!.value).not.toHaveProperty('secnonce');
    }

    // Reload all three independent tabs between MuSig2 rounds. The encrypted
    // local nonces must survive interruption, while no server ever receives a
    // secret nonce.
    for (const participant of browsers) {
      await participant.page.reload();
      await expect(participant.page.getByRole('button', {
        name: 'Complete cooperative signing · round 2',
      })).toBeEnabled();
    }

    for (const [index, participant] of browsers.entries()) {
      await participant.page.getByRole('button', {
        name: 'Complete cooperative signing · round 2',
      }).click();
      await expect(participant.page.getByText(index === browsers.length - 1
        ? /All partials verified; cooperative exit finalized as/u
        : /Your partial signature is verified; waiting for/u)).toBeVisible();
      const nonceKeys = await participant.page.evaluate(() =>
        Object.keys(sessionStorage).filter((key) => key.startsWith('btc-vault:musig2:')));
      expect(nonceKeys).toEqual([]);
    }

    for (const participant of browsers) {
      await participant.page.reload();
      await expect(participant.page.getByText(
        'Cooperative exit finalized and held for explicit broadcast approval.',
      )).toBeVisible();
      await expect(participant.page.getByText('Ready for explicit mainnet broadcast')).toBeVisible();
      await expect(participant.page.getByRole('button', {
        name: 'Approve with passkey and broadcast to mainnet',
      })).toBeDisabled();
    }

    const final = await sql<Array<{
      status: string;
      finalized_tx_hex: string;
      final_txid: Buffer;
      pubnonces: number;
      partials: number;
      broadcasts: number;
      current_coins: number;
      contribution_payloads: unknown;
    }>>`
      SELECT p.status, p.finalized_tx_hex, p.final_txid,
        (SELECT count(*)::integer FROM vault_proposal_contributions c
          WHERE c.proposal_id = p.id AND c.kind = 'musig_pubnonce') AS pubnonces,
        (SELECT count(*)::integer FROM vault_proposal_contributions c
          WHERE c.proposal_id = p.id AND c.kind = 'musig_partial') AS partials,
        (SELECT count(*)::integer FROM vault_broadcast_approvals b
          WHERE b.proposal_id = p.id) AS broadcasts,
        (SELECT count(*)::integer FROM vault_coins vc
          WHERE vc.vault_id = p.vault_id AND vc.status = 'current') AS current_coins,
        (SELECT jsonb_agg(c.payload_json ORDER BY c.participant_id, c.kind)
          FROM vault_proposal_contributions c WHERE c.proposal_id = p.id) AS contribution_payloads
      FROM vault_transaction_proposals p
      WHERE p.vault_id = ${vaultId}::uuid AND p.kind = 'cooperative'
    `;
    expect(final).toHaveLength(1);
    const result = final[0]!;
    expect(result.status).toBe('finalized');
    expect(result.pubnonces).toBe(3);
    expect(result.partials).toBe(3);
    expect(result.broadcasts).toBe(0);
    expect(result.current_coins).toBe(1);
    expect(JSON.stringify(result.contribution_payloads)).not.toContain('secnonce');
    const transaction = bitcoin.Transaction.fromHex(result.finalized_tx_hex);
    expect(transaction.getId()).toBe(result.final_txid.toString('hex'));
    const consensus = verifyVaultTransaction({
      txHex: result.finalized_tx_hex,
      prevouts: [{ scriptPubKeyHex: coin.scriptPubKeyHex, valueSats: coin.valueSats }],
    });
    expect(consensus.txid).toBe(transaction.getId());
    expect(consensus.checks.some((item) => item.includes('key-path signature valid'))).toBe(true);
    expect(forbiddenSigbashRequests).toEqual([]);
  } finally {
    for (const participant of browsers) {
      await participant.cdp.send('WebAuthn.removeVirtualAuthenticator', {
        authenticatorId: participant.recoveryAuthenticatorId,
      }).catch(() => undefined);
      await participant.cdp.send('WebAuthn.removeVirtualAuthenticator', {
        authenticatorId: participant.primaryAuthenticatorId,
      }).catch(() => undefined);
      await participant.context.close().catch(() => undefined);
    }
    await sql`DELETE FROM vaults WHERE id = ${vaultId}::uuid`.catch(() => undefined);
    if (userIds.length) await sql`DELETE FROM users WHERE id = ANY(${userIds}::uuid[])`.catch(() => undefined);
    await sql.end();
  }
});
