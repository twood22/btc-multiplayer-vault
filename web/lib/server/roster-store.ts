import 'server-only';
import type { AuthenticatorTransportFuture, Base64URLString } from '@simplewebauthn/server';
import { AMOUNTS, RECOVERY_DELAY_BLOCKS } from '@/src/config';
import { deriveXpubChildPubkey, taprootAddress, xpubRootXonly } from '@/src/crypto';
import {
  canonicalRosterJson,
  createPublishedRosterArtifact,
  publishedRosterDigest,
  rosterReview,
  type PublishedRosterArtifact,
  type RosterReview,
} from '@/src/roster-ceremony';
import { participantLeaveRounds, type RosterEntry, type SigbashRosterRegistration } from '@/src/vault';
import { db, transaction } from './db';
import type { StoredCredential } from './webauthn-store';

export interface RosterCeremonyStatus {
  participantId: string;
  available: boolean;
  missing: string[];
  review: RosterReview | null;
  participantConfirmed: boolean;
}

export interface RosterConfirmationChallenge {
  id: string;
  challenge: string;
  digest: string;
  vaultId: string;
  participantId: string;
  credential: StoredCredential;
}

interface MembershipRow {
  vault_id: string;
  participant_id: string;
}

interface StoredRosterRow {
  vault_id: string;
  artifact_json: unknown;
  digest: Buffer;
  funding_address: string;
  status: 'confirming' | 'confirmed';
}

export async function getRosterCeremonyStatus(userId: string): Promise<RosterCeremonyStatus> {
  const membership = await membershipForUser(userId);
  const built = await getOrCreateRoster(membership.vault_id);
  if (!built.artifact) {
    return {
      participantId: membership.participant_id,
      available: false,
      missing: built.missing,
      review: null,
      participantConfirmed: false,
    };
  }
  const confirmations = await db()<Array<{ participant_id: string }>>`
    SELECT participant_id FROM roster_confirmations
    WHERE vault_id = ${membership.vault_id}::uuid
    ORDER BY participant_id
  `;
  const confirmedIds = confirmations.map((row) => row.participant_id);
  return {
    participantId: membership.participant_id,
    available: true,
    missing: [],
    review: rosterReview(built.artifact, confirmedIds),
    participantConfirmed: confirmedIds.includes(membership.participant_id),
  };
}

/**
 * Persistence boundary for the future passkey-authorized live Sigbash setup.
 * This is intentionally not exposed as a browser endpoint: callers must first
 * create the key against Sigbash and supply the exact public response.
 */
export async function recordLiveSigbashRegistration(input: {
  userId: string;
  round: string;
  registration: SigbashRosterRegistration;
}): Promise<void> {
  const membership = await membershipForUser(input.userId);
  const expectedRounds = participantLeaveRounds(membership.participant_id, ['alice', 'bob', 'carol']);
  if (!expectedRounds.includes(input.round)) {
    throw new Error(`${membership.participant_id} cannot leave in round ${input.round}`);
  }
  const registration = validateLiveRegistration(membership.participant_id, input.round, input.registration);
  await db()`
    INSERT INTO participant_sigbash_keys (
      vault_id, user_id, participant_id, round_id, network, key_id, key_index,
      bip328_xpub, policy_leaf_xonly, identification_leaf_xonly, policy_root, policy_id
    ) VALUES (
      ${membership.vault_id}::uuid, ${input.userId}::uuid, ${membership.participant_id},
      ${input.round}, 'mainnet', ${registration.keyId}, ${registration.keyIndex},
      ${registration.bip328Xpub}, ${Buffer.from(registration.policyLeafXonlyPubkey, 'hex')},
      ${Buffer.from(registration.identificationLeafXonlyPubkey, 'hex')},
      ${Buffer.from(registration.policyRoot, 'hex')}, ${registration.policyId}
    )
  `;
}

export async function createRosterConfirmationChallenge(input: {
  userId: string;
  credentialId: string;
  challenge: string;
}): Promise<RosterConfirmationChallenge> {
  const membership = await membershipForUser(input.userId);
  const built = await getOrCreateRoster(membership.vault_id);
  if (!built.artifact) throw new Error(`roster is not ready: ${built.missing.join('; ')}`);
  const digest = publishedRosterDigest(built.artifact);
  const credentials = await db()<Array<{
    credential_id: Base64URLString;
    credential_name: string;
    public_key: Buffer;
    counter: string;
    transports: AuthenticatorTransportFuture[];
  }>>`
    SELECT credential_id, credential_name, public_key, counter, transports
    FROM webauthn_credentials
    WHERE user_id = ${input.userId}::uuid
      AND credential_id = ${input.credentialId}
      AND prf_enabled = true
      AND NOT EXISTS (
        SELECT 1 FROM roster_confirmations
        WHERE vault_id = ${membership.vault_id}::uuid
          AND participant_id = ${membership.participant_id}
      )
  `;
  const credential = credentials[0];
  if (!credential) throw new Error('selected passkey is unavailable or this participant already confirmed');
  const challenges = await db()<Array<{ id: string }>>`
    INSERT INTO webauthn_challenges (
      kind, challenge, user_id, credential_id, roster_digest, expires_at
    ) VALUES (
      'roster_confirm', ${input.challenge}, ${input.userId}::uuid,
      ${credential.credential_id}, ${Buffer.from(digest, 'hex')}, now() + interval '5 minutes'
    )
    RETURNING id
  `;
  return {
    id: challenges[0]!.id,
    challenge: input.challenge,
    digest,
    vaultId: membership.vault_id,
    participantId: membership.participant_id,
    credential: {
      id: credential.credential_id,
      name: credential.credential_name,
      userId: input.userId,
      publicKey: Uint8Array.from(credential.public_key),
      counter: Number(credential.counter),
      transports: credential.transports,
      vaultId: membership.vault_id,
      participantId: membership.participant_id,
    },
  };
}

export async function getRosterConfirmationChallenge(input: {
  challengeId: string;
  userId: string;
}): Promise<RosterConfirmationChallenge> {
  const rows = await db()<Array<{
    id: string;
    challenge: string;
    roster_digest: Buffer;
    credential_id: Base64URLString;
    credential_name: string;
    public_key: Buffer;
    counter: string;
    transports: AuthenticatorTransportFuture[];
    vault_id: string;
    participant_id: string;
  }>>`
    SELECT ch.id, ch.challenge, ch.roster_digest, c.credential_id, c.credential_name,
           c.public_key, c.counter, c.transports, r.vault_id, m.participant_id
    FROM webauthn_challenges ch
    JOIN webauthn_credentials c ON c.credential_id = ch.credential_id
    JOIN vault_rosters r ON r.digest = ch.roster_digest
    JOIN vault_members m ON m.user_id = ch.user_id AND m.vault_id = r.vault_id
    WHERE ch.id = ${input.challengeId}::uuid
      AND ch.user_id = ${input.userId}::uuid
      AND ch.kind = 'roster_confirm'
      AND ch.consumed_at IS NULL AND ch.expires_at > now()
  `;
  const row = rows[0];
  if (!row) throw new Error('roster confirmation challenge is invalid or expired');
  return {
    id: row.id,
    challenge: row.challenge,
    digest: row.roster_digest.toString('hex'),
    vaultId: row.vault_id,
    participantId: row.participant_id,
    credential: {
      id: row.credential_id,
      name: row.credential_name,
      userId: input.userId,
      publicKey: Uint8Array.from(row.public_key),
      counter: Number(row.counter),
      transports: row.transports,
      vaultId: row.vault_id,
      participantId: row.participant_id,
    },
  };
}

export async function completeRosterConfirmation(
  challenge: RosterConfirmationChallenge,
  newCounter: number,
): Promise<{ unanimous: boolean }> {
  return transaction(async (sql) => {
    const consumed = await sql<Array<{ id: string }>>`
      UPDATE webauthn_challenges
      SET consumed_at = now()
      WHERE id = ${challenge.id}::uuid
        AND kind = 'roster_confirm'
        AND user_id = ${challenge.credential.userId}::uuid
        AND credential_id = ${challenge.credential.id}
        AND roster_digest = ${Buffer.from(challenge.digest, 'hex')}
        AND consumed_at IS NULL AND expires_at > now()
      RETURNING id
    `;
    if (consumed.length !== 1) throw new Error('roster confirmation challenge was already used or expired');
    const rosters = await sql<Array<{ digest: Buffer; status: string }>>`
      SELECT digest, status FROM vault_rosters
      WHERE vault_id = ${challenge.vaultId}::uuid
      FOR UPDATE
    `;
    const roster = rosters[0];
    if (!roster || roster.digest.toString('hex') !== challenge.digest) {
      throw new Error('the roster changed after this confirmation challenge was issued');
    }
    const credentials = await sql<Array<{ credential_id: string }>>`
      UPDATE webauthn_credentials
      SET counter = ${newCounter}, last_used_at = now()
      WHERE credential_id = ${challenge.credential.id}
        AND user_id = ${challenge.credential.userId}::uuid
        AND prf_enabled = true
        AND counter = ${challenge.credential.counter}
      RETURNING credential_id
    `;
    if (credentials.length !== 1) throw new Error('passkey counter changed during roster confirmation');
    const inserted = await sql<Array<{ participant_id: string }>>`
      INSERT INTO roster_confirmations (
        vault_id, user_id, participant_id, roster_digest, credential_id
      )
      SELECT ${challenge.vaultId}::uuid, ${challenge.credential.userId}::uuid,
             ${challenge.participantId}, ${Buffer.from(challenge.digest, 'hex')},
             ${challenge.credential.id}
      FROM vault_members
      WHERE vault_id = ${challenge.vaultId}::uuid
        AND user_id = ${challenge.credential.userId}::uuid
        AND participant_id = ${challenge.participantId}
      ON CONFLICT DO NOTHING
      RETURNING participant_id
    `;
    if (inserted.length !== 1) throw new Error('participant already confirmed or membership changed');
    const counts = await sql<Array<{ confirmations: string; members: string }>>`
      SELECT
        (SELECT count(*)::text FROM roster_confirmations WHERE vault_id = ${challenge.vaultId}::uuid) AS confirmations,
        (SELECT count(*)::text FROM vault_members WHERE vault_id = ${challenge.vaultId}::uuid) AS members
    `;
    const unanimous = Number(counts[0]?.confirmations) === 3 && Number(counts[0]?.members) === 3;
    if (unanimous) {
      await sql`
        UPDATE vault_rosters SET status = 'confirmed', confirmed_at = now()
        WHERE vault_id = ${challenge.vaultId}::uuid AND digest = ${Buffer.from(challenge.digest, 'hex')}
      `;
      await sql`
        UPDATE vaults SET status = 'roster_confirmed'
        WHERE id = ${challenge.vaultId}::uuid AND status = 'setup'
      `;
    }
    return { unanimous };
  });
}

async function membershipForUser(userId: string): Promise<MembershipRow> {
  const rows = await db()<MembershipRow[]>`
    SELECT vault_id, participant_id FROM vault_members WHERE user_id = ${userId}::uuid
  `;
  if (rows.length !== 1) {
    throw new Error(rows.length === 0 ? 'vault membership is missing' : 'user belongs to more than one vault');
  }
  return rows[0]!;
}

async function getOrCreateRoster(vaultId: string): Promise<{
  artifact: PublishedRosterArtifact | null;
  missing: string[];
}> {
  const existing = await readStoredRoster(vaultId);
  if (existing) return { artifact: existing, missing: [] };

  const members = await db()<Array<{
    user_id: string;
    participant_id: string;
    display_name: string;
    personal_public_key: Buffer | null;
    payout_xonly_public_key: Buffer | null;
    recovery_ready: boolean;
  }>>`
    SELECT m.user_id, m.participant_id, u.display_name,
           k.personal_public_key, k.payout_xonly_public_key,
           (SELECT count(*) >= 2 FROM webauthn_credentials c
             JOIN passkey_envelopes e ON e.credential_id = c.credential_id
             WHERE c.user_id = m.user_id AND c.prf_enabled = true) AS recovery_ready
    FROM vault_members m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN participant_key_material k ON k.user_id = m.user_id AND k.vault_id = m.vault_id
    WHERE m.vault_id = ${vaultId}::uuid
    ORDER BY m.participant_id
  `;
  const registrations = await db()<Array<{
    user_id: string;
    participant_id: string;
    round_id: string;
    network: 'mainnet';
    key_id: string;
    key_index: number;
    bip328_xpub: string;
    policy_leaf_xonly: Buffer;
    identification_leaf_xonly: Buffer;
    policy_root: Buffer;
    policy_id: string;
  }>>`
    SELECT user_id, participant_id, round_id, network, key_id, key_index, bip328_xpub,
           policy_leaf_xonly, identification_leaf_xonly, policy_root, policy_id
    FROM participant_sigbash_keys
    WHERE vault_id = ${vaultId}::uuid
    ORDER BY participant_id, round_id
  `;
  const missing: string[] = releaseEconomicsMissing();
  if (members.length !== 3) missing.push(`${3 - members.length} participant seat(s) are not joined`);
  for (const expectedId of ['alice', 'bob', 'carol']) {
    const member = members.find((item) => item.participant_id === expectedId);
    if (!member) continue;
    if (!member.personal_public_key || !member.payout_xonly_public_key) {
      missing.push(`${expectedId} has not completed passkey-protected key setup`);
    }
    if (!member.recovery_ready) missing.push(`${expectedId} has not completed a second recovery passkey`);
    const expectedRounds = participantLeaveRounds(expectedId, ['alice', 'bob', 'carol']);
    const actualRounds = registrations
      .filter((item) => item.participant_id === expectedId && item.user_id === member.user_id)
      .map((item) => item.round_id);
    for (const round of expectedRounds) {
      if (!actualRounds.includes(round)) missing.push(`${expectedId} is missing live Sigbash mainnet key ${round}`);
    }
  }
  if (missing.length) return { artifact: null, missing };

  const roster: RosterEntry[] = members.map((member) => {
    const byRound = registrations.filter((item) => item.participant_id === member.participant_id);
    const registrationMap = Object.fromEntries(byRound.map((row) => [row.round_id, {
      network: row.network,
      keyId: row.key_id,
      keyIndex: row.key_index,
      bip328Xpub: row.bip328_xpub,
      policyLeafXonlyPubkey: row.policy_leaf_xonly.toString('hex'),
      identificationLeafXonlyPubkey: row.identification_leaf_xonly.toString('hex'),
      policyRoot: row.policy_root.toString('hex'),
      policyId: row.policy_id,
    } satisfies SigbashRosterRegistration]));
    return {
      id: member.participant_id,
      label: member.participant_id[0]!.toUpperCase() + member.participant_id.slice(1),
      personalPublicKeyHex: member.personal_public_key!.toString('hex'),
      payoutXonlyPubkeyHex: member.payout_xonly_public_key!.toString('hex'),
      payoutAddress: taprootAddress(member.payout_xonly_public_key!.toString('hex')),
      sigbashLeafByRound: Object.fromEntries(byRound.map((row) => [row.round_id, row.policy_leaf_xonly.toString('hex')])),
      sigbashIdentificationLeafByRound: Object.fromEntries(byRound.map((row) => [row.round_id, row.identification_leaf_xonly.toString('hex')])),
      sigbashRegistrationByRound: registrationMap,
    };
  });
  const artifact = createPublishedRosterArtifact(vaultId, roster);
  const digest = publishedRosterDigest(artifact);
  await db()`
    INSERT INTO vault_rosters (
      vault_id, version, network, artifact_json, digest, funding_address
    ) VALUES (
      ${vaultId}::uuid, 1, 'mainnet', ${db().json(JSON.parse(canonicalRosterJson(artifact)))},
      ${Buffer.from(digest, 'hex')}, ${artifact.funding.address}
    )
    ON CONFLICT (vault_id) DO NOTHING
  `;
  const stored = await readStoredRoster(vaultId);
  if (!stored || publishedRosterDigest(stored) !== digest) {
    throw new Error('a different immutable roster was published concurrently');
  }
  return { artifact: stored, missing: [] };
}

function releaseEconomicsMissing(): string[] {
  const missing: string[] = [];
  const deposit = process.env.VAULT_DEPOSIT_SATS;
  if (!deposit || Number(deposit) !== AMOUNTS.deposit) {
    missing.push('an explicit VAULT_DEPOSIT_SATS private-beta amount has not been set');
  }
  const delay = process.env.RECOVERY_DELAY_BLOCKS;
  if (!delay || Number(delay) !== RECOVERY_DELAY_BLOCKS) {
    missing.push('an explicit reviewed RECOVERY_DELAY_BLOCKS value has not been set');
  }
  const cap = Number(process.env.PRIVATE_BETA_MAX_DEPOSIT_SATS);
  if (!Number.isSafeInteger(cap) || cap <= 0) {
    missing.push('an explicit PRIVATE_BETA_MAX_DEPOSIT_SATS operator cap has not been set');
  } else if (AMOUNTS.deposit > cap) {
    missing.push(`the configured deposit exceeds the private-beta operator cap of ${cap} sats`);
  }
  return missing;
}

async function readStoredRoster(vaultId: string): Promise<PublishedRosterArtifact | null> {
  const rows = await db()<StoredRosterRow[]>`
    SELECT vault_id, artifact_json, digest, funding_address, status
    FROM vault_rosters WHERE vault_id = ${vaultId}::uuid
  `;
  const row = rows[0];
  if (!row) return null;
  const raw = row.artifact_json as Partial<PublishedRosterArtifact>;
  const rebuilt = createPublishedRosterArtifact(row.vault_id, raw.participants);
  const digest = publishedRosterDigest(rebuilt);
  if (digest !== row.digest.toString('hex') || rebuilt.funding.address !== row.funding_address) {
    throw new Error('stored roster artifact does not reproduce its committed digest and funding address');
  }
  return rebuilt;
}

function validateLiveRegistration(
  participantId: string,
  round: string,
  registration: SigbashRosterRegistration,
): SigbashRosterRegistration {
  if (registration.network !== 'mainnet') throw new Error('Sigbash registration is not mainnet');
  const stripped = registration.bip328Xpub.replace(/^\[[0-9a-fA-F/h']*\]/u, '');
  if (!stripped.startsWith('xpub')) throw new Error('Sigbash registration does not carry a mainnet xpub');
  const policyLeaf = deriveXpubChildPubkey(registration.bip328Xpub, [0, 0]).xonlyPubKeyHex;
  const identificationLeaf = xpubRootXonly(registration.bip328Xpub);
  if (registration.policyLeafXonlyPubkey !== policyLeaf) {
    throw new Error('Sigbash policy leaf is not xpub child 0/0');
  }
  if (registration.identificationLeafXonlyPubkey !== identificationLeaf) {
    throw new Error('Sigbash identification leaf is not the xpub root');
  }
  if (registration.policyId !== `${round}:${participantId}`) throw new Error('Sigbash policyId is wrong');
  if (!/^[0-9a-f]{64}$/u.test(registration.policyRoot)) throw new Error('Sigbash policyRoot is invalid');
  if (!Number.isSafeInteger(registration.keyIndex) || registration.keyIndex < 0) {
    throw new Error('Sigbash keyIndex is invalid');
  }
  if (!registration.keyId || registration.keyId.length > 256) throw new Error('Sigbash keyId is invalid');
  return { ...registration, policyLeafXonlyPubkey: policyLeaf, identificationLeafXonlyPubkey: identificationLeaf };
}
