import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, type Browser, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import postgres from 'postgres';
import {
  base58CheckEncode,
  deriveXpubChildPubkey,
  deterministicKeypair,
  sha256Hex,
  xpubRootXonly,
} from '../../src/crypto.js';
import {
  publishedRosterDigest,
  type PublishedRosterArtifact,
} from '../../src/roster-ceremony.js';
import { BITCOIN_NETWORK_CONFIG, BITCOIN_NETWORK_NAME } from '../../src/network.js';
import { participantLeaveRounds } from '../../src/vault.js';

export type ParticipantId = 'alice' | 'bob' | 'carol';

export interface ParticipantBrowser {
  id: ParticipantId;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  primaryAuthenticatorId: string;
  recoveryAuthenticatorId: string;
}

export interface ConfirmedParticipantFixture {
  vaultId: string;
  browsers: ParticipantBrowser[];
  userIds: string[];
  artifact: PublishedRosterArtifact;
  rosterDigest: string;
}

export const participants: ParticipantId[] = ['alice', 'bob', 'carol'];

export async function createConfirmedParticipantFixture(input: {
  browser: Browser;
  baseURL: string;
  sql: ReturnType<typeof postgres>;
  name: string;
  onRequest: (requestUrl: string) => void;
}): Promise<ConfirmedParticipantFixture> {
  const vaultId = randomUUID();
  const invitationTokens = Object.fromEntries(participants.map((id) => [
    id,
    randomBytes(32).toString('base64url'),
  ])) as Record<ParticipantId, string>;
  const browsers: ParticipantBrowser[] = [];
  let userIds: string[] = [];
  try {
    await input.sql`INSERT INTO vaults (id, name) VALUES (${vaultId}::uuid, ${input.name})`;
    for (const id of participants) {
      await input.sql`
        INSERT INTO invites (vault_id, participant_id, token_hash, expires_at)
        VALUES (
          ${vaultId}::uuid, ${id},
          ${createHash('sha256').update(invitationTokens[id]).digest()},
          now() + interval '1 hour'
        )
      `;
      browsers.push(await createParticipantBrowser({
        browser: input.browser,
        baseURL: input.baseURL,
        id,
        invitationToken: invitationTokens[id],
        onRequest: input.onRequest,
      }));
    }
    const members = await input.sql<Array<{
      user_id: string;
      participant_id: ParticipantId;
    }>>`
      SELECT user_id, participant_id FROM vault_members
      WHERE vault_id = ${vaultId}::uuid ORDER BY participant_id
    `;
    expect(members.map((member) => member.participant_id)).toEqual(participants);
    userIds = members.map((member) => member.user_id);
    const custody = await input.sql<Array<{
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
      GROUP BY m.participant_id ORDER BY m.participant_id
    `;
    expect(custody).toEqual(participants.map((participantId) => ({
      participant_id: participantId,
      credentials: 2,
      envelopes: 2,
    })));
    await seedPublicSigbashRegistrations(input.sql, vaultId, members);

    const digests: string[] = [];
    for (const participant of browsers) {
      await participant.page.goto('/vault');
      await expect(participant.page.getByRole('heading', {
        name: 'Review the same vault together',
      })).toBeVisible();
      const digest = await participant.page.locator('.digest-line code').textContent();
      expect(digest).toMatch(/^[0-9a-f]{64}$/u);
      digests.push(digest!);
      await participant.page.getByRole('button', { name: 'Confirm this exact roster' }).click();
      await expect(participant.page.getByRole('button', {
        name: 'Confirm this exact roster',
      })).toHaveCount(0);
    }
    expect(new Set(digests).size).toBe(1);
    for (const participant of browsers) {
      await participant.page.goto('/vault');
      await expect(participant.page.getByRole('heading', {
        name: 'All three friends confirmed',
      })).toBeVisible();
    }
    const rosterRows = await input.sql<Array<{
      artifact_json: PublishedRosterArtifact;
      digest: Buffer;
      status: string;
    }>>`
      SELECT artifact_json, digest, status FROM vault_rosters
      WHERE vault_id = ${vaultId}::uuid
    `;
    const roster = rosterRows[0]!;
    const rosterDigest = roster.digest.toString('hex');
    expect(roster.status).toBe('confirmed');
    expect(publishedRosterDigest(roster.artifact_json)).toBe(rosterDigest);
    return {
      vaultId,
      browsers,
      userIds,
      artifact: roster.artifact_json,
      rosterDigest,
    };
  } catch (error) {
    await disposeParticipantFixture(input.sql, {
      vaultId,
      browsers,
      userIds,
      artifact: {} as PublishedRosterArtifact,
      rosterDigest: '',
    });
    throw error;
  }
}

export async function createParticipantBrowser(input: {
  browser: Browser;
  baseURL: string;
  id: ParticipantId;
  invitationToken: string;
  onRequest: (requestUrl: string) => void;
}): Promise<ParticipantBrowser> {
  const context = await input.browser.newContext({ baseURL: input.baseURL });
  const page = await context.newPage();
  page.on('request', (request) => input.onRequest(request.url()));
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId: primaryAuthenticatorId } = await cdp.send(
    'WebAuthn.addVirtualAuthenticator',
    { options: virtualAuthenticator('internal', true) },
  );
  await page.goto(`/join/${input.invitationToken}`);
  await page.getByLabel('Your name').fill(`${capitalize(input.id)} Browser Acceptance`);
  await page.getByRole('button', { name: 'Create my passkey' }).click();
  await expect(page.getByRole('heading', { name: 'Your seat is secured' })).toBeVisible();

  await page.goto('/vault');
  await expect(page.getByRole('heading', { name: 'Add a recovery passkey' })).toBeVisible();
  const { authenticatorId: recoveryAuthenticatorId } = await cdp.send(
    'WebAuthn.addVirtualAuthenticator',
    { options: virtualAuthenticator('usb', false) },
  );
  let switchedToRecovery = false;
  const switched = new Promise<void>((resolve, reject) => {
    cdp.on('WebAuthn.credentialAsserted', (event) => {
      if (switchedToRecovery || event.authenticatorId !== primaryAuthenticatorId) return;
      switchedToRecovery = true;
      void Promise.all([
        cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
          authenticatorId: primaryAuthenticatorId,
          enabled: false,
        }),
        cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
          authenticatorId: recoveryAuthenticatorId,
          enabled: true,
        }),
      ]).then(() => resolve(), reject);
    });
  });
  await page.getByLabel('Recovery passkey name').fill(`${capitalize(input.id)} recovery key`);
  await page.getByRole('button', { name: 'Add recovery passkey' }).click();
  await switched;
  await expect(page.getByRole('heading', { name: 'Add a recovery passkey' })).toHaveCount(0);
  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
    authenticatorId: recoveryAuthenticatorId,
    enabled: false,
  });
  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
    authenticatorId: primaryAuthenticatorId,
    enabled: true,
  });

  await expect(page.getByRole('heading', { name: 'Create your Sigbash identity' })).toBeVisible();
  await page.getByRole('button', { name: 'Create protected identity' }).click();
  await expect(page.getByRole('heading', { name: 'Sigbash identity protected' })).toBeVisible();
  return {
    id: input.id,
    context,
    page,
    cdp,
    primaryAuthenticatorId,
    recoveryAuthenticatorId,
  };
}

export async function seedPublicSigbashRegistrations(
  sql: ReturnType<typeof postgres>,
  vaultId: string,
  members: Array<{ user_id: string; participant_id: ParticipantId }>,
): Promise<void> {
  for (const member of members) {
    const rounds = participantLeaveRounds(member.participant_id, participants);
    for (const [keyIndex, round] of rounds.entries()) {
      const xpub = syntheticConfiguredXpub(`${vaultId}:${member.participant_id}:${round}`);
      await sql`
        INSERT INTO participant_sigbash_keys (
          vault_id, user_id, participant_id, round_id, network, key_id, key_index,
          bip328_xpub, policy_leaf_xonly, identification_leaf_xonly, policy_root, policy_id
        ) VALUES (
          ${vaultId}::uuid, ${member.user_id}::uuid, ${member.participant_id}, ${round},
          ${BITCOIN_NETWORK_NAME}, ${`browser-public-fixture:${member.participant_id}:${round}`}, ${keyIndex},
          ${xpub}, ${Buffer.from(deriveXpubChildPubkey(xpub, [0, 0]).xonlyPubKeyHex, 'hex')},
          ${Buffer.from(xpubRootXonly(xpub), 'hex')},
          ${Buffer.from(sha256Hex(`browser-policy-root:${vaultId}:${member.participant_id}:${round}`), 'hex')},
          ${`${round}:${member.participant_id}`}
        )
      `;
    }
  }
}

/**
 * Local browser-acceptance prerequisite only. These rows are shaped like the
 * public result of nine successful proofs, but no Sigbash signer is contacted
 * and they must never be described as live-service evidence.
 */
export async function seedSyntheticSigbashReadinessPrerequisite(
  sql: ReturnType<typeof postgres>,
  fixture: ConfirmedParticipantFixture,
): Promise<void> {
  const members = await sql<Array<{
    user_id: string;
    participant_id: ParticipantId;
  }>>`
    SELECT user_id, participant_id FROM vault_members
    WHERE vault_id = ${fixture.vaultId}::uuid ORDER BY participant_id
  `;
  for (const member of members) {
    const rounds = participantLeaveRounds(member.participant_id, participants);
    for (const round of rounds) {
      const keys = await sql<Array<{ key_id: string; key_index: number }>>`
        SELECT key_id, key_index FROM participant_sigbash_keys
        WHERE vault_id = ${fixture.vaultId}::uuid
          AND participant_id = ${member.participant_id} AND round_id = ${round}
      `;
      expect(keys).toHaveLength(1);
      const challengeId = randomUUID();
      await sql`
        INSERT INTO sigbash_readiness_challenges (
          id, vault_id, user_id, participant_id, round_id, roster_digest,
          input_txid, expires_at, consumed_at
        ) VALUES (
          ${challengeId}::uuid, ${fixture.vaultId}::uuid, ${member.user_id}::uuid,
          ${member.participant_id}, ${round}, ${Buffer.from(fixture.rosterDigest, 'hex')},
          ${Buffer.from(sha256Hex(`browser-synthetic-readiness-input:${fixture.vaultId}:${member.participant_id}:${round}`), 'hex')},
          now() + interval '1 hour', now()
        )
      `;
      await sql`
        INSERT INTO participant_sigbash_readiness_proofs (
          vault_id, user_id, participant_id, round_id, roster_digest,
          key_id, key_index, challenge_id, proof_txid, evidence_hash
        ) VALUES (
          ${fixture.vaultId}::uuid, ${member.user_id}::uuid, ${member.participant_id},
          ${round}, ${Buffer.from(fixture.rosterDigest, 'hex')}, ${keys[0]!.key_id},
          ${keys[0]!.key_index}, ${challengeId}::uuid,
          ${Buffer.from(sha256Hex(`browser-synthetic-readiness-proof:${fixture.vaultId}:${member.participant_id}:${round}`), 'hex')},
          ${Buffer.from(sha256Hex(`browser-synthetic-readiness-evidence:${fixture.vaultId}:${member.participant_id}:${round}`), 'hex')}
        )
      `;
    }
  }
  const counts = await sql<Array<{ count: number }>>`
    SELECT count(*)::integer AS count FROM participant_sigbash_readiness_proofs
    WHERE vault_id = ${fixture.vaultId}::uuid
      AND roster_digest = ${Buffer.from(fixture.rosterDigest, 'hex')}
  `;
  expect(counts[0]?.count).toBe(9);
  const ready = await sql<Array<{ id: string }>>`
    UPDATE vaults SET status = 'ready'
    WHERE id = ${fixture.vaultId}::uuid AND status = 'roster_confirmed'
    RETURNING id
  `;
  expect(ready).toHaveLength(1);
}

export async function disposeParticipantFixture(
  sql: ReturnType<typeof postgres>,
  fixture: ConfirmedParticipantFixture,
): Promise<void> {
  for (const participant of fixture.browsers) {
    await participant.cdp.send('WebAuthn.removeVirtualAuthenticator', {
      authenticatorId: participant.recoveryAuthenticatorId,
    }).catch(() => undefined);
    await participant.cdp.send('WebAuthn.removeVirtualAuthenticator', {
      authenticatorId: participant.primaryAuthenticatorId,
    }).catch(() => undefined);
    await participant.context.close().catch(() => undefined);
  }
  const linkedUsers = await sql<Array<{ user_id: string }>>`
    SELECT user_id FROM vault_members WHERE vault_id = ${fixture.vaultId}::uuid
  `.catch(() => []);
  const userIds = [...new Set([
    ...fixture.userIds,
    ...linkedUsers.map((item) => item.user_id),
  ])];
  await sql`DELETE FROM vaults WHERE id = ${fixture.vaultId}::uuid`.catch(() => undefined);
  if (userIds.length) {
    await sql`DELETE FROM users WHERE id = ANY(${userIds}::uuid[])`.catch(() => undefined);
  }
  await sql.end();
}

function virtualAuthenticator(
  transport: 'internal' | 'usb',
  automaticPresenceSimulation: boolean,
) {
  return {
    protocol: 'ctap2',
    ctap2Version: 'ctap2_1',
    transport,
    hasResidentKey: true,
    hasUserVerification: true,
    automaticPresenceSimulation,
    isUserVerified: true,
    hasPrf: true,
  } as const;
}

function syntheticConfiguredXpub(label: string): string {
  const root = deterministicKeypair('browser-vault-acceptance', `${label}:root`);
  return base58CheckEncode(Buffer.concat([
    Buffer.from(BITCOIN_NETWORK_CONFIG.bip32PublicPrefix === 'xpub' ? '0488b21e' : '043587cf', 'hex'),
    Buffer.from([0]),
    Buffer.alloc(4),
    Buffer.alloc(4),
    Buffer.from(sha256Hex(`${label}:chain-code`), 'hex'),
    Buffer.from(root.publicKeyHex, 'hex'),
  ]));
}

function capitalize(value: string): string {
  return value[0]!.toUpperCase() + value.slice(1);
}
