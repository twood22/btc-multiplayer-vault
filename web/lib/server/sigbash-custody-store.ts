import 'server-only';
import { createHash } from 'node:crypto';
import { sigbashCustodyAad } from './aad';
import { transaction } from './db';
import { randomToken, tokenHash } from './encoding';
import type { AssertionChallenge } from './webauthn-store';

export interface StoredSigbashCustodyEnvelope {
  version: 1;
  revision: number;
  iv: Buffer;
  ciphertext: Buffer;
  aad: Buffer;
}

export interface SigbashCustodyAuthorization {
  leaseToken: string;
  participantEnvelope: { iv: Buffer; ciphertext: Buffer; aad: Buffer };
  custodyEnvelopes: StoredSigbashCustodyEnvelope[];
  nextRevision: number;
  nextAad: Buffer;
}

export async function completeSigbashCustodyAuthorization(
  challenge: AssertionChallenge,
  newCounter: number,
): Promise<SigbashCustodyAuthorization> {
  const leaseToken = randomToken();
  return transaction(async (sql) => {
    const consumed = await sql<Array<{ id: string }>>`
      UPDATE webauthn_challenges
      SET consumed_at = now()
      WHERE id = ${challenge.id}::uuid
        AND kind = 'sigbash_custody'
        AND credential_id = ${challenge.credential.id}
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING id
    `;
    if (consumed.length !== 1) throw new Error('Sigbash custody authorization was already used or expired');
    const credentials = await sql<Array<{ credential_id: string }>>`
      UPDATE webauthn_credentials
      SET counter = ${newCounter}, last_used_at = now()
      WHERE credential_id = ${challenge.credential.id}
        AND user_id = ${challenge.credential.userId}::uuid
        AND prf_enabled = true
        AND counter = ${challenge.credential.counter}
      RETURNING credential_id
    `;
    if (credentials.length !== 1) throw new Error('passkey counter changed during Sigbash authorization');
    const participantEnvelopes = await sql<Array<{ iv: Buffer; ciphertext: Buffer; aad: Buffer }>>`
      SELECT iv, ciphertext, aad FROM passkey_envelopes
      WHERE credential_id = ${challenge.credential.id}
    `;
    if (participantEnvelopes.length !== 1) throw new Error('encrypted participant key is missing');
    const identities = await sql<Array<{ vault_id: string; participant_id: string }>>`
      SELECT vault_id, participant_id FROM participant_key_material
      WHERE user_id = ${challenge.credential.userId}::uuid
      FOR UPDATE
    `;
    const identity = identities[0];
    if (!identity) throw new Error('participant key material is missing');
    if (identity.vault_id !== challenge.credential.vaultId
      || identity.participant_id !== challenge.credential.participantId) {
      throw new Error('Sigbash custody authorization identity is inconsistent');
    }
    await sql`DELETE FROM sigbash_custody_leases WHERE expires_at <= now()`;
    await sql`
      INSERT INTO sigbash_custody_leases (
        token_hash, user_id, credential_id, writes_remaining, expires_at
      ) VALUES (
        ${tokenHash(leaseToken)}, ${challenge.credential.userId}::uuid,
        ${challenge.credential.id}, 12, now() + interval '15 minutes'
      )
    `;
    const custodyEnvelopes = await sql<Array<StoredSigbashCustodyEnvelope>>`
      SELECT version, revision, iv, ciphertext, aad
      FROM participant_sigbash_custody_versions
      WHERE user_id = ${challenge.credential.userId}::uuid
      ORDER BY revision
    `;
    const nextRevision = (custodyEnvelopes.at(-1)?.revision ?? 0) + 1;
    if (nextRevision > 32) throw new Error('Sigbash custody history is full');
    return {
      leaseToken,
      participantEnvelope: participantEnvelopes[0]!,
      custodyEnvelopes,
      nextRevision,
      nextAad: sigbashCustodyAad({
        userId: challenge.credential.userId,
        credentialId: challenge.credential.id,
        vaultId: identity.vault_id,
        participantId: identity.participant_id,
        revision: nextRevision,
      }),
    };
  });
}

export async function appendSigbashCustodyEnvelope(input: {
  userId: string;
  leaseToken: string;
  version: number;
  revision: number;
  iv: Buffer;
  ciphertext: Buffer;
  aad: Buffer;
}): Promise<{ nextRevision: number; nextAad: Buffer | null }> {
  if (input.version !== 1) throw new Error('unsupported Sigbash custody envelope version');
  if (!Number.isSafeInteger(input.revision) || input.revision < 1 || input.revision > 32) {
    throw new Error('Sigbash custody revision is invalid');
  }
  if (input.iv.length !== 12) throw new Error('Sigbash custody IV must be 12 bytes');
  if (input.ciphertext.length < 128 || input.ciphertext.length > 65_552) {
    throw new Error('Sigbash custody ciphertext has an invalid size');
  }
  return transaction(async (sql) => {
    const leases = await sql<Array<{
      user_id: string;
      credential_id: string;
      writes_remaining: number;
    }>>`
      SELECT user_id, credential_id, writes_remaining
      FROM sigbash_custody_leases
      WHERE token_hash = ${tokenHash(input.leaseToken)}
        AND user_id = ${input.userId}::uuid
        AND expires_at > now()
        AND writes_remaining > 0
      FOR UPDATE
    `;
    const lease = leases[0];
    if (!lease) throw new Error('Sigbash custody write authorization is invalid or expired');
    const identities = await sql<Array<{ vault_id: string; participant_id: string }>>`
      SELECT vault_id, participant_id FROM participant_key_material
      WHERE user_id = ${input.userId}::uuid
      FOR UPDATE
    `;
    const identity = identities[0];
    if (!identity) throw new Error('participant key material is missing');
    const revisions = await sql<Array<{ revision: number }>>`
      SELECT revision FROM participant_sigbash_custody_versions
      WHERE user_id = ${input.userId}::uuid
      ORDER BY revision DESC LIMIT 1
    `;
    const expectedRevision = (revisions[0]?.revision ?? 0) + 1;
    if (input.revision !== expectedRevision) {
      throw new Error(`Sigbash custody revision must be ${expectedRevision}`);
    }
    const expectedAad = sigbashCustodyAad({
      userId: input.userId,
      credentialId: lease.credential_id,
      vaultId: identity.vault_id,
      participantId: identity.participant_id,
      revision: input.revision,
    });
    if (!input.aad.equals(expectedAad)) throw new Error('Sigbash custody envelope is bound to the wrong identity or revision');
    const digest = createHash('sha256')
      .update(Buffer.from([input.version]))
      .update(input.iv)
      .update(input.ciphertext)
      .update(input.aad)
      .digest();
    await sql`
      INSERT INTO participant_sigbash_custody_versions (
        user_id, vault_id, participant_id, revision, version, iv, ciphertext, aad, envelope_hash
      ) VALUES (
        ${input.userId}::uuid, ${identity.vault_id}::uuid, ${identity.participant_id},
        ${input.revision}, 1, ${input.iv}, ${input.ciphertext}, ${input.aad}, ${digest}
      )
    `;
    await sql`
      UPDATE sigbash_custody_leases
      SET writes_remaining = writes_remaining - 1, last_used_at = now()
      WHERE token_hash = ${tokenHash(input.leaseToken)}
    `;
    const nextRevision = input.revision + 1;
    return {
      nextRevision,
      nextAad: nextRevision > 32 ? null : sigbashCustodyAad({
        userId: input.userId,
        credentialId: lease.credential_id,
        vaultId: identity.vault_id,
        participantId: identity.participant_id,
        revision: nextRevision,
      }),
    };
  });
}

export async function assertSigbashCustodyLease(userId: string, leaseToken: string): Promise<void> {
  const rows = await transaction(async (sql) => {
    const leases = await sql<Array<{ token_hash: Buffer }>>`
      UPDATE sigbash_custody_leases
      SET last_used_at = now()
      WHERE token_hash = ${tokenHash(leaseToken)}
        AND user_id = ${userId}::uuid
        AND expires_at > now()
        AND writes_remaining > 0
      RETURNING token_hash
    `;
    return leases;
  });
  if (rows.length !== 1) throw new Error('Sigbash custody authorization is invalid or expired');
}
