import 'server-only';
import { randomBytes } from 'node:crypto';
import { Buffer } from 'buffer';
import { authorizeSoloSigningArtifacts } from '../../../src/psbt';
import { sha256Hex } from '../../../src/crypto';
import type { PublishedRosterArtifact } from '../../../src/roster-ceremony';
import { buildSigbashReadinessFixture } from '../../../src/sigbash-readiness';
import type { VaultCoinSnapshot } from '../../../src/vault-runtime';
import { createRosterState, participantLeaveRounds } from '../../../src/vault';
import { assertSigbashCustodyLease } from './sigbash-custody-store';
import { db, transaction } from './db';
import { getConfirmedVaultArtifactForVault } from './roster-store';

const CHALLENGE_LIFETIME_MINUTES = 15;
const ALL_PARTICIPANTS = ['alice', 'bob', 'carol'];

interface Membership {
  vault_id: string;
  participant_id: string;
}

interface ChallengeRow {
  id: string;
  vault_id: string;
  user_id: string;
  participant_id: string;
  round_id: string;
  roster_digest: Buffer;
  input_txid: Buffer;
  expires_at: Date;
  consumed_at: Date | null;
}

export interface SigbashReadinessStatus {
  participantId: string;
  participantProofRounds: string[];
  participantRequiredRounds: string[];
  totalProofCount: number;
  requiredProofCount: 9;
  nextRound: string | null;
  ready: boolean;
}

export interface SigbashReadinessChallenge {
  id: string;
  rosterDigest: string;
  participantId: string;
  round: string;
  currentIds: string[];
  coin: VaultCoinSnapshot;
  key: { keyId: string; keyIndex: number; policyId: string; policyRoot: string };
  validPsbtBase64: string;
  tamperedPsbts: Record<'wrongAmount' | 'wrongAddress' | 'extraOutput', string>;
  expiresAt: string;
}

export async function getSigbashReadinessStatus(userId: string): Promise<SigbashReadinessStatus> {
  const membership = await membershipForUser(userId);
  const confirmed = await getConfirmedVaultArtifactForVault(membership.vault_id);
  const proofs = await db()<Array<{ participant_id: string; round_id: string }>>`
    SELECT participant_id, round_id FROM participant_sigbash_readiness_proofs
    WHERE vault_id = ${membership.vault_id}::uuid
      AND roster_digest = ${Buffer.from(confirmed.digest, 'hex')}
    ORDER BY participant_id, round_id
  `;
  const vaults = await db()<Array<{ status: string }>>`
    SELECT status FROM vaults WHERE id = ${membership.vault_id}::uuid
  `;
  const required = participantLeaveRounds(membership.participant_id, ALL_PARTICIPANTS);
  const own = proofs.filter((proof) => proof.participant_id === membership.participant_id)
    .map((proof) => proof.round_id);
  return {
    participantId: membership.participant_id,
    participantProofRounds: own,
    participantRequiredRounds: required,
    totalProofCount: proofs.length,
    requiredProofCount: 9,
    nextRound: required.find((round) => !own.includes(round)) ?? null,
    ready: proofs.length === 9 && ['ready', 'active', 'closed'].includes(vaults[0]?.status || ''),
  };
}

export async function createSigbashReadinessChallenge(input: {
  userId: string;
  leaseToken: string;
}): Promise<SigbashReadinessChallenge> {
  await assertSigbashCustodyLease(input.userId, input.leaseToken);
  const membership = await membershipForUser(input.userId);
  const confirmed = await getConfirmedVaultArtifactForVault(membership.vault_id);
  const status = await getSigbashReadinessStatus(input.userId);
  if (!status.nextRound) throw new Error('all of this participant’s live Sigbash keys are already proven');
  const vaults = await db()<Array<{ status: string }>>`
    SELECT status FROM vaults WHERE id = ${membership.vault_id}::uuid
  `;
  if (vaults[0]?.status !== 'roster_confirmed') {
    throw new Error('vault is not in the pre-funding Sigbash readiness phase');
  }
  const round = status.nextRound;
  const challenge = await transaction(async (sql) => {
    await sql`
      DELETE FROM sigbash_readiness_challenges
      WHERE vault_id = ${membership.vault_id}::uuid
        AND participant_id = ${membership.participant_id}
        AND consumed_at IS NULL AND expires_at <= now()
    `;
    const existing = await sql<ChallengeRow[]>`
      SELECT id, vault_id, user_id, participant_id, round_id, roster_digest,
             input_txid, expires_at, consumed_at
      FROM sigbash_readiness_challenges
      WHERE vault_id = ${membership.vault_id}::uuid
        AND user_id = ${input.userId}::uuid
        AND participant_id = ${membership.participant_id}
        AND round_id = ${round} AND consumed_at IS NULL AND expires_at > now()
      FOR UPDATE
    `;
    if (existing[0]) return existing[0];
    const inserted = await sql<ChallengeRow[]>`
      INSERT INTO sigbash_readiness_challenges (
        vault_id, user_id, participant_id, round_id, roster_digest,
        input_txid, expires_at
      ) VALUES (
        ${membership.vault_id}::uuid, ${input.userId}::uuid,
        ${membership.participant_id}, ${round},
        ${Buffer.from(confirmed.digest, 'hex')}, ${randomBytes(32)},
        now() + (${CHALLENGE_LIFETIME_MINUTES} * interval '1 minute')
      )
      RETURNING id, vault_id, user_id, participant_id, round_id, roster_digest,
                input_txid, expires_at, consumed_at
    `;
    return inserted[0]!;
  });
  return materializeChallenge(confirmed.artifact, confirmed.digest, challenge);
}

export async function completeSigbashReadinessProof(input: {
  userId: string;
  leaseToken: string;
  challengeId: string;
  transactionHex: string;
  signedPsbtBase64?: string;
}): Promise<SigbashReadinessStatus> {
  if (!/^[0-9a-f]+$/u.test(input.transactionHex) || input.transactionHex.length > 400_000) {
    throw new Error('readiness transaction hex is invalid');
  }
  await assertSigbashCustodyLease(input.userId, input.leaseToken);
  const membership = await membershipForUser(input.userId);
  const confirmed = await getConfirmedVaultArtifactForVault(membership.vault_id);
  await transaction(async (sql) => {
    const rows = await sql<ChallengeRow[]>`
      SELECT id, vault_id, user_id, participant_id, round_id, roster_digest,
             input_txid, expires_at, consumed_at
      FROM sigbash_readiness_challenges
      WHERE id = ${input.challengeId}::uuid
        AND vault_id = ${membership.vault_id}::uuid
        AND user_id = ${input.userId}::uuid
        AND participant_id = ${membership.participant_id}
      FOR UPDATE
    `;
    const challenge = rows[0];
    if (!challenge || challenge.expires_at.getTime() <= Date.now()) {
      throw new Error('Sigbash readiness challenge is invalid or expired');
    }
    if (challenge.roster_digest.toString('hex') !== confirmed.digest) {
      throw new Error('Sigbash readiness challenge belongs to a different roster');
    }
    const materialized = materializeChallenge(confirmed.artifact, confirmed.digest, challenge);
    const state = createRosterState(
      confirmed.artifact.participants,
      undefined,
      confirmed.artifact.economics,
    );
    const authorization = authorizeSoloSigningArtifacts(
      state,
      materialized.currentIds,
      membership.participant_id,
      materialized.validPsbtBase64,
      {
        txHex: input.transactionHex,
        signedPsbtBase64: input.signedPsbtBase64 ?? null,
      },
    );
    if (!authorization.finalTxid || !authorization.consensus) {
      throw new Error('readiness proof is not a finalized consensus-valid Sigbash transaction');
    }
    const evidenceHash = sha256Hex(JSON.stringify({
      challengeId: challenge.id,
      round: challenge.round_id,
      finalTxid: authorization.finalTxid,
      transactionHex: input.transactionHex,
    }));
    if (challenge.consumed_at) {
      const existing = await sql<Array<{ proof_txid: Buffer; evidence_hash: Buffer }>>`
        SELECT proof_txid, evidence_hash FROM participant_sigbash_readiness_proofs
        WHERE challenge_id = ${challenge.id}::uuid
      `;
      if (existing[0]?.proof_txid.toString('hex') !== authorization.finalTxid ||
          existing[0]?.evidence_hash.toString('hex') !== evidenceHash) {
        throw new Error('readiness challenge was already consumed by different proof data');
      }
      return;
    }
    const consumed = await sql<Array<{ id: string }>>`
      UPDATE sigbash_readiness_challenges SET consumed_at = now()
      WHERE id = ${challenge.id}::uuid AND consumed_at IS NULL AND expires_at > now()
      RETURNING id
    `;
    if (consumed.length !== 1) throw new Error('readiness challenge changed during completion');
    const key = materialized.key;
    await sql`
      INSERT INTO participant_sigbash_readiness_proofs (
        vault_id, user_id, participant_id, round_id, roster_digest,
        key_id, key_index, challenge_id, proof_txid, evidence_hash
      ) VALUES (
        ${membership.vault_id}::uuid, ${input.userId}::uuid,
        ${membership.participant_id}, ${challenge.round_id},
        ${Buffer.from(confirmed.digest, 'hex')}, ${key.keyId}, ${key.keyIndex},
        ${challenge.id}::uuid, ${Buffer.from(authorization.finalTxid, 'hex')},
        ${Buffer.from(evidenceHash, 'hex')}
      )
    `;
    const counts = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM participant_sigbash_readiness_proofs
      WHERE vault_id = ${membership.vault_id}::uuid
        AND roster_digest = ${Buffer.from(confirmed.digest, 'hex')}
    `;
    if (Number(counts[0]?.count || 0) === 9) {
      const ready = await sql<Array<{ id: string }>>`
        UPDATE vaults SET status = 'ready'
        WHERE id = ${membership.vault_id}::uuid AND status = 'roster_confirmed'
        RETURNING id
      `;
      if (ready.length !== 1) throw new Error('vault could not enter live Sigbash ready state');
    }
  });
  return getSigbashReadinessStatus(input.userId);
}

function materializeChallenge(
  artifact: PublishedRosterArtifact,
  digest: string,
  challenge: ChallengeRow,
): SigbashReadinessChallenge {
  if (challenge.vault_id !== artifact.vaultId || challenge.roster_digest.toString('hex') !== digest) {
    throw new Error('Sigbash readiness challenge is bound to a different vault artifact');
  }
  const fixture = buildSigbashReadinessFixture({
    artifact,
    rosterDigest: digest,
    participantId: challenge.participant_id,
    round: challenge.round_id,
    inputTxid: challenge.input_txid.toString('hex'),
  });
  return {
    ...fixture,
    id: challenge.id,
    rosterDigest: digest,
    expiresAt: challenge.expires_at.toISOString(),
  };
}

async function membershipForUser(userId: string): Promise<Membership> {
  const rows = await db()<Membership[]>`
    SELECT vault_id, participant_id FROM vault_members WHERE user_id = ${userId}::uuid
  `;
  if (rows.length !== 1) throw new Error('Sigbash readiness requires exactly one vault membership');
  return rows[0]!;
}
