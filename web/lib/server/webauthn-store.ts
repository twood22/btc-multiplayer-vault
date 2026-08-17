import 'server-only';
import type { AuthenticatorTransportFuture, Base64URLString, WebAuthnCredential } from '@simplewebauthn/server';
import { db, transaction } from './db';
import { tokenHash } from './encoding';
import { consumeRateLimit } from './rate-limit';

export interface RegistrationChallenge {
  id: string;
  challenge: string;
  inviteId: string;
  vaultId: string;
  participantId: string;
  userId: string;
  displayName: string;
}

export interface StoredCredential {
  id: Base64URLString;
  name: string;
  userId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports: AuthenticatorTransportFuture[];
  vaultId: string;
  participantId: string;
}

export interface AssertionChallenge {
  id: string;
  challenge: string;
  prfSalt: Buffer;
  credential: StoredCredential;
  recoveryEnrollmentId?: string;
}

export interface RecoveryRegistrationChallenge {
  id: string;
  challenge: string;
  userId: string;
  displayName: string;
  enrollmentId: string;
  existingCredentials: Array<{ id: Base64URLString; transports: AuthenticatorTransportFuture[] }>;
}

export interface LoginChallenge {
  id: string;
  challenge: string;
  credential: StoredCredential;
}

export interface ParticipantSummary {
  userId: string;
  displayName: string;
  vaultId: string;
  vaultName: string;
  vaultStatus: string;
  participantId: string;
  personalPublicKeyHex: string;
  payoutXonlyPublicKeyHex: string;
}

export interface MemberStatus {
  userId: string;
  displayName: string;
  vaultId: string;
  vaultName: string;
  vaultStatus: string;
  participantId: string;
  setupComplete: boolean;
  recoveryComplete: boolean;
  sigbashCustodyStarted: boolean;
  sigbashKeyCount: number;
  passkeys: Array<{ id: string; name: string }>;
}

export async function getMemberStatus(userId: string): Promise<MemberStatus> {
  const rows = await db()<Array<{
    user_id: string;
    display_name: string;
    vault_id: string;
    vault_name: string;
    vault_status: string;
    participant_id: string;
    setup_complete: boolean;
    recovery_complete: boolean;
    sigbash_custody_started: boolean;
    sigbash_key_count: string;
  }>>`
    SELECT u.id AS user_id, u.display_name, v.id AS vault_id,
           v.name AS vault_name, v.status AS vault_status, m.participant_id,
           (k.user_id IS NOT NULL) AS setup_complete,
           (SELECT count(*) >= 2 FROM webauthn_credentials c
             JOIN passkey_envelopes e ON e.credential_id = c.credential_id
             WHERE c.user_id = u.id AND c.prf_enabled = true) AS recovery_complete,
           EXISTS (
             SELECT 1 FROM participant_sigbash_custody_versions s
             WHERE s.user_id = u.id
           ) AS sigbash_custody_started,
           (SELECT count(*) FROM participant_sigbash_keys s
             WHERE s.user_id = u.id) AS sigbash_key_count
    FROM users u
    JOIN vault_members m ON m.user_id = u.id
    JOIN vaults v ON v.id = m.vault_id
    LEFT JOIN participant_key_material k ON k.user_id = u.id
    WHERE u.id = ${userId}::uuid
  `;
  const row = rows[0];
  if (!row) throw new Error('vault membership is missing');
  const credentials = await db()<Array<{ credential_id: string; credential_name: string }>>`
    SELECT c.credential_id, c.credential_name
    FROM webauthn_credentials c
    JOIN passkey_envelopes e ON e.credential_id = c.credential_id
    WHERE c.user_id = ${userId}::uuid AND c.prf_enabled = true
    ORDER BY c.created_at
  `;
  return {
    userId: row.user_id,
    displayName: row.display_name,
    vaultId: row.vault_id,
    vaultName: row.vault_name,
    vaultStatus: row.vault_status,
    participantId: row.participant_id,
    setupComplete: row.setup_complete,
    recoveryComplete: row.recovery_complete,
    sigbashCustodyStarted: row.sigbash_custody_started,
    sigbashKeyCount: Number(row.sigbash_key_count),
    passkeys: credentials.map((credential) => ({
      id: credential.credential_id,
      name: credential.credential_name,
    })),
  };
}

export async function getParticipantSummary(userId: string): Promise<ParticipantSummary> {
  const rows = await db()<Array<{
    user_id: string;
    display_name: string;
    vault_id: string;
    vault_name: string;
    vault_status: string;
    participant_id: string;
    personal_public_key: Buffer;
    payout_xonly_public_key: Buffer;
  }>>`
    SELECT u.id AS user_id, u.display_name, v.id AS vault_id,
           v.name AS vault_name, v.status AS vault_status, m.participant_id,
           k.personal_public_key, k.payout_xonly_public_key
    FROM users u
    JOIN vault_members m ON m.user_id = u.id
    JOIN vaults v ON v.id = m.vault_id
    JOIN participant_key_material k ON k.user_id = u.id
    WHERE u.id = ${userId}::uuid
  `;
  const row = rows[0];
  if (!row) throw new Error('participant setup is incomplete');
  return {
    userId: row.user_id,
    displayName: row.display_name,
    vaultId: row.vault_id,
    vaultName: row.vault_name,
    vaultStatus: row.vault_status,
    participantId: row.participant_id,
    personalPublicKeyHex: row.personal_public_key.toString('hex'),
    payoutXonlyPublicKeyHex: row.payout_xonly_public_key.toString('hex'),
  };
}

export async function createRegistrationChallenge(input: {
  inviteToken: string;
  displayName: string;
  challenge: string;
  prospectiveUserId: string;
}): Promise<RegistrationChallenge> {
  return transaction(async (sql) => {
    const invites = await sql<Array<{
      id: string;
      vault_id: string;
      participant_id: string;
    }>>`
      SELECT id, vault_id, participant_id
      FROM invites
      WHERE token_hash = ${tokenHash(input.inviteToken)}
        AND consumed_at IS NULL
        AND expires_at > now()
      FOR UPDATE
    `;
    const invite = invites[0];
    if (!invite) throw new Error('invite is invalid, expired, or already used');
    const existing = await sql`
      SELECT 1 FROM vault_members
      WHERE vault_id = ${invite.vault_id}::uuid AND participant_id = ${invite.participant_id}
    `;
    if (existing.length) throw new Error('that vault seat is already occupied');
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO webauthn_challenges (
        kind, challenge, invite_id, prospective_user_id, display_name, expires_at
      ) VALUES (
        'registration', ${input.challenge}, ${invite.id}::uuid,
        ${input.prospectiveUserId}::uuid, ${input.displayName}, now() + interval '5 minutes'
      )
      RETURNING id
    `;
    return {
      id: rows[0]!.id,
      challenge: input.challenge,
      inviteId: invite.id,
      vaultId: invite.vault_id,
      participantId: invite.participant_id,
      userId: input.prospectiveUserId,
      displayName: input.displayName,
    };
  });
}

export async function getRegistrationChallenge(
  challengeId: string,
  inviteToken: string,
): Promise<RegistrationChallenge> {
  const rows = await db()<Array<{
    id: string;
    challenge: string;
    invite_id: string;
    vault_id: string;
    participant_id: string;
    prospective_user_id: string;
    display_name: string;
  }>>`
    SELECT c.id, c.challenge, c.invite_id, i.vault_id, i.participant_id,
           c.prospective_user_id, c.display_name
    FROM webauthn_challenges c
    JOIN invites i ON i.id = c.invite_id
    WHERE c.id = ${challengeId}::uuid
      AND c.kind = 'registration'
      AND c.consumed_at IS NULL
      AND c.expires_at > now()
      AND i.token_hash = ${tokenHash(inviteToken)}
      AND i.consumed_at IS NULL
      AND i.expires_at > now()
  `;
  const row = rows[0];
  if (!row) throw new Error('registration challenge is invalid or expired');
  return {
    id: row.id,
    challenge: row.challenge,
    inviteId: row.invite_id,
    vaultId: row.vault_id,
    participantId: row.participant_id,
    userId: row.prospective_user_id,
    displayName: row.display_name,
  };
}

export async function completeRegistration(input: {
  challenge: RegistrationChallenge;
  credential: WebAuthnCredential;
  transports: AuthenticatorTransportFuture[];
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
}): Promise<void> {
  await transaction(async (sql) => {
    const locked = await sql`
      SELECT 1 FROM webauthn_challenges
      WHERE id = ${input.challenge.id}::uuid
        AND consumed_at IS NULL AND expires_at > now()
      FOR UPDATE
    `;
    if (!locked.length) throw new Error('registration challenge was already used or expired');
    const invite = await sql`
      SELECT 1 FROM invites
      WHERE id = ${input.challenge.inviteId}::uuid
        AND consumed_at IS NULL AND expires_at > now()
      FOR UPDATE
    `;
    if (!invite.length) throw new Error('invite was already used or expired');
    await sql`
      INSERT INTO users (id, display_name)
      VALUES (${input.challenge.userId}::uuid, ${input.challenge.displayName})
    `;
    await sql`
      INSERT INTO vault_members (vault_id, user_id, participant_id)
      VALUES (
        ${input.challenge.vaultId}::uuid,
        ${input.challenge.userId}::uuid,
        ${input.challenge.participantId}
      )
    `;
    await sql`
      INSERT INTO webauthn_credentials (
        credential_id, user_id, public_key, counter, transports,
        device_type, backed_up, prf_enabled
      ) VALUES (
        ${input.credential.id}, ${input.challenge.userId}::uuid,
        ${Buffer.from(input.credential.publicKey)}, ${input.credential.counter},
        ${input.transports}, ${input.deviceType}, ${input.backedUp}, false
      )
    `;
    await sql`
      UPDATE webauthn_challenges SET consumed_at = now()
      WHERE id = ${input.challenge.id}::uuid
    `;
    await sql`
      UPDATE invites SET consumed_at = now()
      WHERE id = ${input.challenge.inviteId}::uuid
    `;
  });
}

export async function createAssertionChallenge(input: {
  userId: string;
  kind: 'envelope' | 'unlock' | 'recovery_authorize';
  challenge: string;
  prfSalt: Buffer;
  credentialId?: string;
}): Promise<AssertionChallenge> {
  await consumeRateLimit({
    action: 'passkey_envelope_setup',
    subject: input.userId,
    limit: 10,
    windowSeconds: 900,
  });
  const credentials = await db()<Array<{
    credential_id: string;
    credential_name: string;
    public_key: Buffer;
    counter: string;
    transports: AuthenticatorTransportFuture[];
    vault_id: string;
    participant_id: string;
  }>>`
    SELECT c.credential_id, c.credential_name, c.public_key, c.counter, c.transports,
           m.vault_id, m.participant_id
    FROM webauthn_credentials c
    JOIN vault_members m ON m.user_id = c.user_id
    WHERE c.user_id = ${input.userId}::uuid
      AND (${input.credentialId ?? null}::text IS NULL OR c.credential_id = ${input.credentialId ?? null})
      AND (${input.kind} = 'envelope' OR c.prf_enabled = true)
    ORDER BY c.created_at
  `;
  if (credentials.length !== 1) {
    throw new Error(input.credentialId ? 'selected passkey is unavailable' : 'exactly one setup passkey is required');
  }
  const row = credentials[0]!;
  const challenges = await db()<Array<{ id: string }>>`
    INSERT INTO webauthn_challenges (
      kind, challenge, user_id, credential_id, prf_salt, expires_at
    )
    VALUES (
      ${input.kind}, ${input.challenge}, ${input.userId}::uuid, ${row.credential_id},
      ${input.prfSalt}, now() + interval '5 minutes'
    )
    RETURNING id
  `;
  return {
    id: challenges[0]!.id,
    challenge: input.challenge,
    prfSalt: input.prfSalt,
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

export async function createLoginChallenge(challenge: string): Promise<string> {
  await db()`
    DELETE FROM webauthn_challenges
    WHERE kind = 'login' AND expires_at <= now()
  `;
  const rows = await db()<Array<{ id: string }>>`
    INSERT INTO webauthn_challenges (kind, challenge, expires_at)
    VALUES ('login', ${challenge}, now() + interval '5 minutes')
    RETURNING id
  `;
  return rows[0]!.id;
}

export async function getLoginChallenge(
  challengeId: string,
  credentialId: string,
): Promise<LoginChallenge> {
  const rows = await db()<Array<{
    id: string;
    challenge: string;
    user_id: string;
    credential_id: string;
    credential_name: string;
    public_key: Buffer;
    counter: string;
    transports: AuthenticatorTransportFuture[];
    vault_id: string;
    participant_id: string;
  }>>`
    SELECT ch.id, ch.challenge, c.user_id, c.credential_id, c.credential_name, c.public_key,
           c.counter, c.transports, m.vault_id, m.participant_id
    FROM webauthn_challenges ch
    CROSS JOIN webauthn_credentials c
    JOIN vault_members m ON m.user_id = c.user_id
    WHERE ch.id = ${challengeId}::uuid
      AND ch.kind = 'login'
      AND ch.consumed_at IS NULL
      AND ch.expires_at > now()
      AND c.credential_id = ${credentialId}
      AND NOT EXISTS (
        SELECT 1 FROM recovery_enrollments r
        WHERE r.new_credential_id = c.credential_id AND r.completed_at IS NULL
      )
  `;
  const row = rows[0];
  if (!row) throw new Error('sign-in challenge is invalid or expired');
  return {
    id: row.id,
    challenge: row.challenge,
    credential: {
      id: row.credential_id,
      name: row.credential_name,
      userId: row.user_id,
      publicKey: Uint8Array.from(row.public_key),
      counter: Number(row.counter),
      transports: row.transports,
      vaultId: row.vault_id,
      participantId: row.participant_id,
    },
  };
}

export async function completeLogin(challenge: LoginChallenge, newCounter: number): Promise<void> {
  await transaction(async (sql) => {
    const consumed = await sql<Array<{ id: string }>>`
      UPDATE webauthn_challenges
      SET consumed_at = now()
      WHERE id = ${challenge.id}::uuid
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING id
    `;
    if (consumed.length !== 1) throw new Error('sign-in challenge was already used or expired');
    const credentials = await sql<Array<{ credential_id: string }>>`
      UPDATE webauthn_credentials
      SET counter = ${newCounter}, last_used_at = now()
      WHERE credential_id = ${challenge.credential.id}
        AND counter = ${challenge.credential.counter}
      RETURNING credential_id
    `;
    if (credentials.length !== 1) throw new Error('passkey counter changed during sign-in');
  });
}

export async function createUnlockChallenge(input: {
  userId: string;
  challenge: string;
  credentialId: string;
  kind?: 'unlock' | 'recovery_authorize' | 'sigbash_custody';
}): Promise<AssertionChallenge> {
  const kind = input.kind ?? 'unlock';
  await consumeRateLimit({
    action: `passkey_${kind}`,
    subject: input.userId,
    limit: 20,
    windowSeconds: 900,
  });
  const rows = await db()<Array<{
    credential_id: string;
    credential_name: string;
    public_key: Buffer;
    counter: string;
    transports: AuthenticatorTransportFuture[];
    prf_salt: Buffer;
    vault_id: string;
    participant_id: string;
  }>>`
    SELECT c.credential_id, c.credential_name, c.public_key, c.counter, c.transports,
           e.prf_salt, m.vault_id, m.participant_id
    FROM webauthn_credentials c
    JOIN passkey_envelopes e ON e.credential_id = c.credential_id
    JOIN vault_members m ON m.user_id = c.user_id
    WHERE c.user_id = ${input.userId}::uuid
      AND c.credential_id = ${input.credentialId}
      AND c.prf_enabled = true
  `;
  if (rows.length !== 1) throw new Error('selected passkey does not have a completed key envelope');
  const row = rows[0]!;
  const challenges = await db()<Array<{ id: string }>>`
    INSERT INTO webauthn_challenges (
      kind, challenge, user_id, credential_id, prf_salt, expires_at
    )
    VALUES (
      ${kind}, ${input.challenge}, ${input.userId}::uuid, ${row.credential_id},
      ${row.prf_salt}, now() + interval '5 minutes'
    )
    RETURNING id
  `;
  return {
    id: challenges[0]!.id,
    challenge: input.challenge,
    prfSalt: row.prf_salt,
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

export async function completeUnlock(
  challenge: AssertionChallenge,
  newCounter: number,
): Promise<{ iv: Buffer; ciphertext: Buffer; aad: Buffer }> {
  return transaction(async (sql) => {
    const consumed = await sql<Array<{ id: string }>>`
      UPDATE webauthn_challenges
      SET consumed_at = now()
      WHERE id = ${challenge.id}::uuid
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING id
    `;
    if (consumed.length !== 1) throw new Error('unlock challenge was already used or expired');
    const credentials = await sql<Array<{ credential_id: string }>>`
      UPDATE webauthn_credentials
      SET counter = ${newCounter}, last_used_at = now()
      WHERE credential_id = ${challenge.credential.id}
        AND counter = ${challenge.credential.counter}
      RETURNING credential_id
    `;
    if (credentials.length !== 1) throw new Error('passkey counter changed during unlock');
    const envelopes = await sql<Array<{ iv: Buffer; ciphertext: Buffer; aad: Buffer }>>`
      SELECT iv, ciphertext, aad
      FROM passkey_envelopes
      WHERE credential_id = ${challenge.credential.id}
    `;
    if (envelopes.length !== 1) throw new Error('encrypted participant key is missing');
    return envelopes[0]!;
  });
}

export async function getAssertionChallenge(
  challengeId: string,
  userId: string,
  kind: 'envelope' | 'unlock' | 'recovery_authorize' | 'recovery_envelope' | 'sigbash_custody',
): Promise<AssertionChallenge> {
  const rows = await db()<Array<{
    id: string;
    challenge: string;
    prf_salt: Buffer;
    credential_id: string;
    credential_name: string;
    public_key: Buffer;
    counter: string;
    transports: AuthenticatorTransportFuture[];
    vault_id: string;
    participant_id: string;
    recovery_enrollment_id: string | null;
  }>>`
    SELECT ch.id, ch.challenge, ch.prf_salt, ch.recovery_enrollment_id,
           c.credential_id, c.credential_name,
           c.public_key, c.counter, c.transports, m.vault_id, m.participant_id
    FROM webauthn_challenges ch
    JOIN webauthn_credentials c ON c.credential_id = ch.credential_id
    JOIN vault_members m ON m.user_id = ch.user_id
    WHERE ch.id = ${challengeId}::uuid
      AND ch.user_id = ${userId}::uuid
      AND ch.kind = ${kind}
      AND ch.consumed_at IS NULL
      AND ch.expires_at > now()
  `;
  const row = rows[0];
  if (!row) throw new Error('passkey challenge is invalid or expired');
  return {
    id: row.id,
    challenge: row.challenge,
    prfSalt: row.prf_salt,
    ...(row.recovery_enrollment_id ? { recoveryEnrollmentId: row.recovery_enrollment_id } : {}),
    credential: {
      id: row.credential_id,
      name: row.credential_name,
      userId,
      publicKey: Uint8Array.from(row.public_key),
      counter: Number(row.counter),
      transports: row.transports,
      vaultId: row.vault_id,
      participantId: row.participant_id,
    },
  };
}

export async function completeRecoveryAuthorization(
  challenge: AssertionChallenge,
  newCounter: number,
): Promise<{ enrollmentId: string; iv: Buffer; ciphertext: Buffer; aad: Buffer }> {
  return transaction(async (sql) => {
    const consumed = await sql<Array<{ id: string }>>`
      UPDATE webauthn_challenges
      SET consumed_at = now()
      WHERE id = ${challenge.id}::uuid
        AND kind = 'recovery_authorize'
        AND credential_id = ${challenge.credential.id}
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING id
    `;
    if (consumed.length !== 1) throw new Error('recovery authorization was already used or expired');
    const credentials = await sql<Array<{ credential_id: string }>>`
      UPDATE webauthn_credentials
      SET counter = ${newCounter}, last_used_at = now()
      WHERE credential_id = ${challenge.credential.id}
        AND user_id = ${challenge.credential.userId}::uuid
        AND prf_enabled = true
        AND counter = ${challenge.credential.counter}
      RETURNING credential_id
    `;
    if (credentials.length !== 1) throw new Error('passkey counter changed during recovery authorization');

    await sql`
      DELETE FROM webauthn_credentials c
      USING recovery_enrollments r
      WHERE r.new_credential_id = c.credential_id
        AND r.user_id = ${challenge.credential.userId}::uuid
        AND r.completed_at IS NULL
        AND r.expires_at <= now()
        AND c.prf_enabled = false
    `;
    await sql`
      DELETE FROM recovery_enrollments
      WHERE user_id = ${challenge.credential.userId}::uuid
        AND completed_at IS NULL AND expires_at <= now()
    `;

    const envelopes = await sql<Array<{ iv: Buffer; ciphertext: Buffer; aad: Buffer }>>`
      SELECT iv, ciphertext, aad
      FROM passkey_envelopes
      WHERE credential_id = ${challenge.credential.id}
    `;
    if (envelopes.length !== 1) throw new Error('source passkey envelope is missing');
    const enrollments = await sql<Array<{ id: string }>>`
      INSERT INTO recovery_enrollments (
        user_id, source_credential_id, expires_at
      ) VALUES (
        ${challenge.credential.userId}::uuid, ${challenge.credential.id},
        now() + interval '10 minutes'
      )
      RETURNING id
    `;
    return { enrollmentId: enrollments[0]!.id, ...envelopes[0]! };
  });
}

export async function createRecoveryRegistrationChallenge(input: {
  userId: string;
  enrollmentId: string;
  challenge: string;
}): Promise<RecoveryRegistrationChallenge> {
  await consumeRateLimit({
    action: 'passkey_recovery_registration',
    subject: input.userId,
    limit: 10,
    windowSeconds: 900,
  });
  return transaction(async (sql) => {
    const enrollments = await sql<Array<{ display_name: string }>>`
      SELECT u.display_name
      FROM recovery_enrollments r
      JOIN users u ON u.id = r.user_id
      WHERE r.id = ${input.enrollmentId}::uuid
        AND r.user_id = ${input.userId}::uuid
        AND r.new_credential_id IS NULL
        AND r.completed_at IS NULL
        AND r.expires_at > now()
      FOR UPDATE OF r
    `;
    const enrollment = enrollments[0];
    if (!enrollment) throw new Error('recovery enrollment is invalid or expired');
    const existingCredentials = await sql<Array<{
      credential_id: Base64URLString;
      transports: AuthenticatorTransportFuture[];
    }>>`
      SELECT credential_id, transports
      FROM webauthn_credentials
      WHERE user_id = ${input.userId}::uuid
      ORDER BY created_at
    `;
    const challenges = await sql<Array<{ id: string }>>`
      INSERT INTO webauthn_challenges (
        kind, challenge, user_id, recovery_enrollment_id, expires_at
      ) VALUES (
        'recovery_registration', ${input.challenge}, ${input.userId}::uuid,
        ${input.enrollmentId}::uuid, now() + interval '5 minutes'
      )
      RETURNING id
    `;
    return {
      id: challenges[0]!.id,
      challenge: input.challenge,
      userId: input.userId,
      displayName: enrollment.display_name,
      enrollmentId: input.enrollmentId,
      existingCredentials: existingCredentials.map((credential) => ({
        id: credential.credential_id,
        transports: credential.transports,
      })),
    };
  });
}

export async function getRecoveryRegistrationChallenge(input: {
  challengeId: string;
  enrollmentId: string;
  userId: string;
}): Promise<RecoveryRegistrationChallenge> {
  const rows = await db()<Array<{
    id: string;
    challenge: string;
    display_name: string;
  }>>`
    SELECT ch.id, ch.challenge, u.display_name
    FROM webauthn_challenges ch
    JOIN recovery_enrollments r ON r.id = ch.recovery_enrollment_id
    JOIN users u ON u.id = ch.user_id
    WHERE ch.id = ${input.challengeId}::uuid
      AND ch.kind = 'recovery_registration'
      AND ch.recovery_enrollment_id = ${input.enrollmentId}::uuid
      AND ch.user_id = ${input.userId}::uuid
      AND ch.consumed_at IS NULL AND ch.expires_at > now()
      AND r.new_credential_id IS NULL
      AND r.completed_at IS NULL AND r.expires_at > now()
  `;
  const row = rows[0];
  if (!row) throw new Error('recovery registration challenge is invalid or expired');
  return {
    id: row.id,
    challenge: row.challenge,
    userId: input.userId,
    displayName: row.display_name,
    enrollmentId: input.enrollmentId,
    existingCredentials: [],
  };
}

export async function completeRecoveryRegistration(input: {
  challenge: RecoveryRegistrationChallenge;
  credential: WebAuthnCredential;
  credentialName: string;
  transports: AuthenticatorTransportFuture[];
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
}): Promise<void> {
  await transaction(async (sql) => {
    const locked = await sql`
      SELECT 1 FROM webauthn_challenges
      WHERE id = ${input.challenge.id}::uuid
        AND kind = 'recovery_registration'
        AND recovery_enrollment_id = ${input.challenge.enrollmentId}::uuid
        AND consumed_at IS NULL AND expires_at > now()
      FOR UPDATE
    `;
    if (!locked.length) throw new Error('recovery registration challenge was already used or expired');
    const enrollment = await sql`
      SELECT 1 FROM recovery_enrollments
      WHERE id = ${input.challenge.enrollmentId}::uuid
        AND user_id = ${input.challenge.userId}::uuid
        AND new_credential_id IS NULL
        AND completed_at IS NULL AND expires_at > now()
      FOR UPDATE
    `;
    if (!enrollment.length) throw new Error('recovery enrollment is invalid or expired');
    await sql`
      INSERT INTO webauthn_credentials (
        credential_id, user_id, credential_name, public_key, counter, transports,
        device_type, backed_up, prf_enabled
      ) VALUES (
        ${input.credential.id}, ${input.challenge.userId}::uuid, ${input.credentialName},
        ${Buffer.from(input.credential.publicKey)}, ${input.credential.counter},
        ${input.transports}, ${input.deviceType}, ${input.backedUp}, false
      )
    `;
    const updated = await sql<Array<{ id: string }>>`
      UPDATE recovery_enrollments
      SET new_credential_id = ${input.credential.id}
      WHERE id = ${input.challenge.enrollmentId}::uuid
        AND new_credential_id IS NULL
      RETURNING id
    `;
    if (updated.length !== 1) throw new Error('recovery enrollment changed during registration');
    await sql`
      UPDATE webauthn_challenges SET consumed_at = now()
      WHERE id = ${input.challenge.id}::uuid
    `;
  });
}

export async function createRecoveryEnvelopeChallenge(input: {
  userId: string;
  enrollmentId: string;
  challenge: string;
  prfSalt: Buffer;
}): Promise<AssertionChallenge> {
  await consumeRateLimit({
    action: 'passkey_recovery_envelope',
    subject: input.userId,
    limit: 10,
    windowSeconds: 900,
  });
  const rows = await db()<Array<{
    credential_id: Base64URLString;
    credential_name: string;
    public_key: Buffer;
    counter: string;
    transports: AuthenticatorTransportFuture[];
    vault_id: string;
    participant_id: string;
  }>>`
    SELECT c.credential_id, c.credential_name, c.public_key, c.counter, c.transports,
           m.vault_id, m.participant_id
    FROM recovery_enrollments r
    JOIN webauthn_credentials c ON c.credential_id = r.new_credential_id
    JOIN vault_members m ON m.user_id = r.user_id
    WHERE r.id = ${input.enrollmentId}::uuid
      AND r.user_id = ${input.userId}::uuid
      AND r.completed_at IS NULL AND r.expires_at > now()
      AND c.prf_enabled = false
  `;
  const row = rows[0];
  if (!row) throw new Error('new recovery passkey is unavailable or enrollment expired');
  const challenges = await db()<Array<{ id: string }>>`
    INSERT INTO webauthn_challenges (
      kind, challenge, user_id, credential_id, recovery_enrollment_id, prf_salt, expires_at
    ) VALUES (
      'recovery_envelope', ${input.challenge}, ${input.userId}::uuid,
      ${row.credential_id}, ${input.enrollmentId}::uuid, ${input.prfSalt},
      now() + interval '5 minutes'
    )
    RETURNING id
  `;
  return {
    id: challenges[0]!.id,
    challenge: input.challenge,
    prfSalt: input.prfSalt,
    recoveryEnrollmentId: input.enrollmentId,
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

export async function completeRecoveryEnvelope(input: {
  challenge: AssertionChallenge;
  newCounter: number;
  iv: Buffer;
  ciphertext: Buffer;
  aad: Buffer;
  personalPublicKey: Buffer;
  payoutXonlyPublicKey: Buffer;
}): Promise<void> {
  if (!input.challenge.recoveryEnrollmentId) throw new Error('recovery enrollment binding is missing');
  const enrollmentId = input.challenge.recoveryEnrollmentId;
  await transaction(async (sql) => {
    const locked = await sql`
      SELECT 1 FROM webauthn_challenges
      WHERE id = ${input.challenge.id}::uuid
        AND kind = 'recovery_envelope'
        AND credential_id = ${input.challenge.credential.id}
        AND recovery_enrollment_id = ${enrollmentId}::uuid
        AND consumed_at IS NULL AND expires_at > now()
      FOR UPDATE
    `;
    if (!locked.length) throw new Error('recovery envelope challenge was already used or expired');
    const enrollments = await sql`
      SELECT 1 FROM recovery_enrollments
      WHERE id = ${enrollmentId}::uuid
        AND user_id = ${input.challenge.credential.userId}::uuid
        AND new_credential_id = ${input.challenge.credential.id}
        AND completed_at IS NULL AND expires_at > now()
      FOR UPDATE
    `;
    if (!enrollments.length) throw new Error('recovery enrollment is invalid or expired');
    const identities = await sql<Array<{
      personal_public_key: Buffer;
      payout_xonly_public_key: Buffer;
    }>>`
      SELECT personal_public_key, payout_xonly_public_key
      FROM participant_key_material
      WHERE user_id = ${input.challenge.credential.userId}::uuid
      FOR UPDATE
    `;
    const identity = identities[0];
    if (!identity || !identity.personal_public_key.equals(input.personalPublicKey)
      || !identity.payout_xonly_public_key.equals(input.payoutXonlyPublicKey)) {
      throw new Error('recovery envelope does not match the existing participant identity');
    }
    await sql`
      INSERT INTO passkey_envelopes (
        credential_id, version, prf_salt, iv, ciphertext, aad
      ) VALUES (
        ${input.challenge.credential.id}, 1, ${input.challenge.prfSalt},
        ${input.iv}, ${input.ciphertext}, ${input.aad}
      )
    `;
    const credentials = await sql<Array<{ credential_id: string }>>`
      UPDATE webauthn_credentials
      SET counter = ${input.newCounter}, prf_enabled = true, last_used_at = now()
      WHERE credential_id = ${input.challenge.credential.id}
        AND user_id = ${input.challenge.credential.userId}::uuid
        AND prf_enabled = false
        AND counter = ${input.challenge.credential.counter}
      RETURNING credential_id
    `;
    if (credentials.length !== 1) throw new Error('new passkey changed during recovery setup');
    await sql`
      UPDATE recovery_enrollments SET completed_at = now()
      WHERE id = ${enrollmentId}::uuid
    `;
    await sql`
      UPDATE webauthn_challenges SET consumed_at = now()
      WHERE id = ${input.challenge.id}::uuid
    `;
  });
}

export async function completeEnvelope(input: {
  challenge: AssertionChallenge;
  newCounter: number;
  iv: Buffer;
  ciphertext: Buffer;
  aad: Buffer;
  personalPublicKey: Buffer;
  payoutXonlyPublicKey: Buffer;
}): Promise<void> {
  await transaction(async (sql) => {
    const locked = await sql`
      SELECT 1 FROM webauthn_challenges
      WHERE id = ${input.challenge.id}::uuid
        AND consumed_at IS NULL AND expires_at > now()
      FOR UPDATE
    `;
    if (!locked.length) throw new Error('passkey challenge was already used or expired');
    const envelopeRows = await sql<Array<{ credential_id: string }>>`
      INSERT INTO passkey_envelopes (
        credential_id, version, prf_salt, iv, ciphertext, aad
      ) VALUES (
        ${input.challenge.credential.id}, 1, ${input.challenge.prfSalt},
        ${input.iv}, ${input.ciphertext}, ${input.aad}
      )
      ON CONFLICT (credential_id) DO NOTHING
      RETURNING credential_id
    `;
    if (envelopeRows.length !== 1) throw new Error('a key envelope already exists for this passkey');
    const credentialRows = await sql<Array<{ credential_id: string }>>`
      UPDATE webauthn_credentials
      SET counter = ${input.newCounter}, prf_enabled = true, last_used_at = now()
      WHERE credential_id = ${input.challenge.credential.id}
        AND counter = ${input.challenge.credential.counter}
      RETURNING credential_id
    `;
    if (credentialRows.length !== 1) {
      throw new Error('passkey counter changed during setup; start a fresh assertion');
    }
    await sql`
      INSERT INTO participant_key_material (
        user_id, vault_id, participant_id, personal_public_key, payout_xonly_public_key
      ) VALUES (
        ${input.challenge.credential.userId}::uuid,
        ${input.challenge.credential.vaultId}::uuid,
        ${input.challenge.credential.participantId},
        ${input.personalPublicKey}, ${input.payoutXonlyPublicKey}
      )
    `;
    await sql`
      UPDATE webauthn_challenges SET consumed_at = now()
      WHERE id = ${input.challenge.id}::uuid
    `;
  });
}

export function asWebAuthnCredential(credential: StoredCredential): WebAuthnCredential {
  return {
    id: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports: credential.transports,
  };
}
