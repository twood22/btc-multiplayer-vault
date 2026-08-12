import 'server-only';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import type { AuthenticatorTransportFuture, Base64URLString } from '@simplewebauthn/server';
import type { TrustedVaultInput } from '../../../src/types';
import { authorizeSoloSigningArtifacts } from '../../../src/psbt';
import {
  aggregateRecoveryShares,
  authorizeFinalSweep,
  validateRecoveryShare,
  type RecoveryShare,
} from '../../../src/custody';
import { verifyVaultTransaction } from '../../../src/consensus';
import {
  ceremonyAggregate,
  ceremonyStart,
  validateCooperativeNonceSet,
  validateCooperativePartial,
  validateCooperativePubnonce,
} from '../../../src/ceremony';
import { sha256Hex } from '../../../src/crypto';
import {
  buildVaultProposal,
  deriveNextVaultCoin,
  assertFreshMatureRecoveryObservation,
  validateVaultCoin,
  vaultCoinSnapshotDigest,
  type BuiltVaultProposal,
  type VaultCoinSnapshot,
  type VaultProposalKind,
} from '../../../src/vault-runtime';
import { db, transaction } from './db';
import { chainObservationOrigins } from './config';
import { getConfirmedVaultArtifactForVault } from './roster-store';
import type { StoredCredential } from './webauthn-store';

const PROPOSAL_LIFETIME_MS = 15 * 60 * 1000;

interface MembershipRow {
  vault_id: string;
  participant_id: string;
}

interface StoredCoinRow {
  id: string;
  vault_id: string;
  roster_digest: Buffer;
  kind: 'vault' | 'final_payout';
  round_id: string | null;
  owner_participant_id: string | null;
  txid: Buffer;
  vout: string;
  value_sats: string;
  script_pubkey: Buffer;
  status: 'current' | 'spent' | 'orphaned';
  confirmed_height: string | null;
}

interface StoredProposalRow {
  id: string;
  kind: VaultProposalKind;
  round_id: string | null;
  actor_participant_id: string | null;
  proposal_digest: Buffer;
  unsigned_txid: Buffer;
  psbt_base64: string;
  final_txid: Buffer | null;
  status: 'collecting' | 'finalized' | 'broadcast' | 'confirmed' | 'rejected' | 'stale';
  expires_at: Date;
}

interface LockedProposalRow extends StoredProposalRow {
  vault_id: string;
  roster_digest: Buffer;
  input_coin_id: string;
}

interface ConfirmableProposalRow extends LockedProposalRow {
  finalized_tx_hex: string;
}

export interface VaultRuntimeStatus {
  vaultId: string;
  participantId: string;
  participantPersonalPublicKeyHex: string;
  recoveryDelayBlocks: number;
  chainObservationOrigins: string[];
  coin: (VaultCoinSnapshot & {
    id: string;
    status: StoredCoinRow['status'];
    confirmedHeight: number | null;
    snapshotDigest: string;
    observedParticipantIds: string[];
    participantObservationConfirmations: number | null;
  }) | null;
  proposal: {
    id: string;
    kind: VaultProposalKind;
    roundId: string | null;
    actorParticipantId: string | null;
    digest: string;
    unsignedTxid: string;
    psbtBase64: string;
    requiredSignerIds: string[];
    status: StoredProposalRow['status'];
    expiresAt: string;
    cooperativeContributions: {
      pubnonces: Record<string, string>;
      partialSigs: Record<string, string>;
    } | null;
    recoveryShares: RecoveryShare[] | null;
  } | null;
}

export interface CoinObservationChallenge {
  id: string;
  challenge: string;
  coinId: string;
  vaultId: string;
  participantId: string;
  snapshotDigest: string;
  sourceOrigin: string;
  confirmations: number;
  observedUnspent: true;
  credential: StoredCredential;
}

export async function getVaultRuntimeStatus(userId: string): Promise<VaultRuntimeStatus> {
  const membership = await membershipForUser(userId);
  const confirmed = await getConfirmedVaultArtifactForVault(membership.vault_id);
  const coins = await db()<StoredCoinRow[]>`
    SELECT id, vault_id, roster_digest, kind, round_id, owner_participant_id,
           txid, vout::text, value_sats::text, script_pubkey, status,
           confirmed_height::text
    FROM vault_coins
    WHERE vault_id = ${membership.vault_id}::uuid AND status = 'current'
  `;
  const coinRow = coins[0];
  const coin = coinRow ? storedCoinSnapshot(coinRow) : null;
  if (coin) validateVaultCoin(confirmed.artifact, coin);
  const snapshotDigest = coin ? vaultCoinSnapshotDigest(coin) : null;
  const observations = coin && snapshotDigest ? await db()<Array<{
    participant_id: string;
    confirmations: number;
  }>>`
    SELECT participant_id, confirmations FROM vault_coin_observations
    WHERE coin_id = ${coin.id}::uuid
      AND snapshot_digest = ${Buffer.from(snapshotDigest, 'hex')}
      AND observed_unspent = true
    ORDER BY participant_id
  ` : [];
  const proposals = coin ? await db()<StoredProposalRow[]>`
    SELECT id, kind, round_id, actor_participant_id, proposal_digest,
           unsigned_txid, psbt_base64, final_txid, status, expires_at
    FROM vault_transaction_proposals
    WHERE input_coin_id = ${coin.id}::uuid
      AND status IN ('collecting', 'finalized', 'broadcast')
      AND (status = 'broadcast' OR expires_at > now())
    ORDER BY created_at DESC
    LIMIT 1
  ` : [];
  const proposal = proposals[0];
  const rebuiltProposal = proposal && coin ? buildVaultProposal({
    artifact: confirmed.artifact,
    coin,
    kind: proposal.kind,
    ...(proposal.actor_participant_id
      ? { actorParticipantId: proposal.actor_participant_id }
      : {}),
    expiresAt: proposal.expires_at.toISOString(),
  }) : null;
  if (
    proposal && rebuiltProposal && (
      rebuiltProposal.digest !== proposal.proposal_digest.toString('hex') ||
      rebuiltProposal.unsignedTxid !== proposal.unsigned_txid.toString('hex') ||
      rebuiltProposal.psbtBase64 !== proposal.psbt_base64
    )
  ) {
    throw new Error('stored transaction proposal does not reproduce from the confirmed vault state');
  }
  const contributionRows = proposal?.kind === 'cooperative'
    ? await db()<Array<{
        participant_id: string;
        kind: 'musig_pubnonce' | 'musig_partial';
        payload_json: { publicKeyHex?: unknown; value?: unknown };
      }>>`
        SELECT participant_id, kind, payload_json
        FROM vault_proposal_contributions
        WHERE proposal_id = ${proposal.id}::uuid
          AND kind IN ('musig_pubnonce', 'musig_partial')
        ORDER BY participant_id, kind
      `
    : [];
  const cooperativeContributions = proposal?.kind === 'cooperative'
    ? contributionMaps(contributionRows)
    : null;
  const recoveryRows = proposal?.kind === 'recovery'
    ? await db()<Array<{ payload_json: unknown }>>`
        SELECT payload_json FROM vault_proposal_contributions
        WHERE proposal_id = ${proposal.id}::uuid AND kind = 'recovery_share'
        ORDER BY participant_id
      `
    : [];
  return {
    vaultId: membership.vault_id,
    participantId: membership.participant_id,
    participantPersonalPublicKeyHex: confirmed.artifact.participants
      .find((item) => item.id === membership.participant_id)!.personalPublicKeyHex,
    recoveryDelayBlocks: confirmed.artifact.economics.recoveryDelayBlocks,
    chainObservationOrigins: chainObservationOrigins(),
    coin: coin && coinRow ? {
      ...coin,
      status: coinRow.status,
      confirmedHeight: coinRow.confirmed_height === null
        ? null
        : exactSafeInteger(coinRow.confirmed_height, 'confirmed height'),
      snapshotDigest: snapshotDigest!,
      observedParticipantIds: observations.map((item) => item.participant_id),
      participantObservationConfirmations: observations
        .find((item) => item.participant_id === membership.participant_id)?.confirmations ?? null,
    } : null,
    proposal: proposal ? {
      id: proposal.id,
      kind: proposal.kind,
      roundId: proposal.round_id,
      actorParticipantId: proposal.actor_participant_id,
      digest: proposal.proposal_digest.toString('hex'),
      unsignedTxid: proposal.unsigned_txid.toString('hex'),
      psbtBase64: proposal.psbt_base64,
      requiredSignerIds: rebuiltProposal!.requiredSignerIds,
      status: proposal.status,
      expiresAt: proposal.expires_at.toISOString(),
      cooperativeContributions,
      recoveryShares: proposal?.kind === 'recovery'
        ? recoveryRows.map((item) => parseStoredRecoveryShare(item.payload_json))
        : null,
    } : null,
  };
}

/**
 * Create the exact deterministic spend for the current coin. The participant
 * must be one of that proposal's required signers; the browser will rebuild
 * and compare the same commitment before releasing any signature material.
 */
export async function createStoredVaultProposal(
  userId: string,
  input: { kind: VaultProposalKind; actorParticipantId?: string },
): Promise<BuiltVaultProposal & { id: string }> {
  const membership = await membershipForUser(userId);
  const confirmed = await getConfirmedVaultArtifactForVault(membership.vault_id);
  return transaction(async (sql) => {
    const rows = await sql<StoredCoinRow[]>`
      SELECT id, vault_id, roster_digest, kind, round_id, owner_participant_id,
             txid, vout::text, value_sats::text, script_pubkey, status,
             confirmed_height::text
      FROM vault_coins
      WHERE vault_id = ${membership.vault_id}::uuid AND status = 'current'
      FOR UPDATE
    `;
    if (rows.length !== 1) throw new Error('vault has no single confirmed current coin');
    const coin = storedCoinSnapshot(rows[0]!);
    const snapshotDigest = vaultCoinSnapshotDigest(coin);
    const observation = await sql<Array<{
      participant_id: string;
      confirmations: number;
      observed_at: Date;
    }>>`
      SELECT participant_id, confirmations, observed_at FROM vault_coin_observations
      WHERE coin_id = ${coin.id}::uuid
        AND user_id = ${userId}::uuid
        AND participant_id = ${membership.participant_id}
        AND snapshot_digest = ${Buffer.from(snapshotDigest, 'hex')}
        AND observed_unspent = true
    `;
    if (observation.length !== 1) {
      throw new Error('verify the exact current coin against an independent chain source before proposing a spend');
    }
    if (input.kind === 'recovery') {
      assertFreshMatureRecoveryObservation({
        confirmations: observation[0]!.confirmations,
        recoveryDelayBlocks: confirmed.artifact.economics.recoveryDelayBlocks,
        observedAtMs: observation[0]!.observed_at.getTime(),
        nowMs: Date.now(),
      });
    }
    await sql`
      UPDATE vault_transaction_proposals
      SET status = 'stale', rejection_reason = 'proposal expired before broadcast', updated_at = now()
      WHERE input_coin_id = ${coin.id}::uuid
        AND status IN ('collecting', 'finalized')
        AND expires_at <= now()
    `;
    const live = await sql<Array<{ id: string }>>`
      SELECT id FROM vault_transaction_proposals
      WHERE input_coin_id = ${coin.id}::uuid
        AND status IN ('collecting', 'finalized', 'broadcast')
      LIMIT 1
    `;
    if (live.length) throw new Error('this coin already has a live transaction proposal');
    const built = buildVaultProposal({
      artifact: confirmed.artifact,
      coin,
      kind: input.kind,
      ...(input.actorParticipantId ? { actorParticipantId: input.actorParticipantId } : {}),
      expiresAt: new Date(Date.now() + PROPOSAL_LIFETIME_MS).toISOString(),
    });
    if (!built.requiredSignerIds.includes(membership.participant_id)) {
      throw new Error('this participant is not an authorized signer for the requested proposal');
    }
    const inserted = await sql<Array<{ id: string }>>`
      INSERT INTO vault_transaction_proposals (
        vault_id, roster_digest, input_coin_id, kind, round_id,
        actor_participant_id, proposer_user_id, psbt_base64, unsigned_txid,
        proposal_digest, expires_at
      ) VALUES (
        ${membership.vault_id}::uuid,
        ${Buffer.from(confirmed.digest, 'hex')},
        ${coin.id}::uuid,
        ${built.commitment.kind},
        ${built.commitment.roundId},
        ${built.commitment.actorParticipantId},
        ${userId}::uuid,
        ${built.psbtBase64},
        ${Buffer.from(built.unsignedTxid, 'hex')},
        ${Buffer.from(built.digest, 'hex')},
        ${new Date(built.commitment.expiresAt)}
      )
      RETURNING id
    `;
    return { ...built, id: inserted[0]!.id };
  });
}

export async function createCoinObservationChallenge(input: {
  userId: string;
  credentialId: string;
  challenge: string;
  snapshotDigest: string;
  sourceOrigin: string;
  confirmations: number;
  observedUnspent: boolean;
}): Promise<CoinObservationChallenge> {
  if (!/^[0-9a-f]{64}$/u.test(input.snapshotDigest)) {
    throw new Error('coin observation snapshot digest is invalid');
  }
  const source = new URL(input.sourceOrigin);
  if (source.origin !== input.sourceOrigin || source.protocol !== 'https:') {
    throw new Error('independent chain source must be an HTTPS origin');
  }
  if (!chainObservationOrigins().includes(input.sourceOrigin)) {
    throw new Error('independent chain source is not in the deployment allowlist');
  }
  if (!Number.isSafeInteger(input.confirmations) || input.confirmations <= 0) {
    throw new Error('coin observation requires at least one confirmation');
  }
  if (input.observedUnspent !== true) throw new Error('coin observation must report the output unspent');
  const membership = await membershipForUser(input.userId);
  const coins = await db()<StoredCoinRow[]>`
    SELECT id, vault_id, roster_digest, kind, round_id, owner_participant_id,
           txid, vout::text, value_sats::text, script_pubkey, status,
           confirmed_height::text
    FROM vault_coins
    WHERE vault_id = ${membership.vault_id}::uuid AND status = 'current'
  `;
  if (coins.length !== 1) throw new Error('vault has no single confirmed current coin');
  const coin = storedCoinSnapshot(coins[0]!);
  if (vaultCoinSnapshotDigest(coin) !== input.snapshotDigest) {
    throw new Error('independent chain observation differs from the current coin snapshot');
  }
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
  `;
  const credential = credentials[0];
  if (!credential) throw new Error('selected passkey is unavailable');
  const inserted = await db()<Array<{ id: string }>>`
    INSERT INTO vault_coin_observation_challenges (
      coin_id, vault_id, user_id, participant_id, credential_id, challenge,
      snapshot_digest, source_origin, confirmations, observed_unspent,
      expires_at
    ) VALUES (
      ${coin.id}::uuid, ${membership.vault_id}::uuid, ${input.userId}::uuid,
      ${membership.participant_id}, ${credential.credential_id}, ${input.challenge},
      ${Buffer.from(input.snapshotDigest, 'hex')}, ${input.sourceOrigin},
      ${input.confirmations}, true, now() + interval '5 minutes'
    )
    RETURNING id
  `;
  return {
    id: inserted[0]!.id,
    challenge: input.challenge,
    coinId: coin.id,
    vaultId: membership.vault_id,
    participantId: membership.participant_id,
    snapshotDigest: input.snapshotDigest,
    sourceOrigin: input.sourceOrigin,
    confirmations: input.confirmations,
    observedUnspent: true,
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

export async function finalizeStoredSoloProposal(input: {
  userId: string;
  proposalId: string;
  proposalDigest: string;
  transactionHex: string;
  signedPsbtBase64?: string;
}): Promise<{ txid: string; consensusChecks: string[] }> {
  if (!/^[0-9a-f]{64}$/u.test(input.proposalDigest)) throw new Error('proposal digest is invalid');
  if (!/^[0-9a-f]+$/u.test(input.transactionHex) || input.transactionHex.length > 400_000) {
    throw new Error('final transaction hex is invalid');
  }
  if (input.signedPsbtBase64 && input.signedPsbtBase64.length > 100_000) {
    throw new Error('signed PSBT is too large');
  }
  const membership = await membershipForUser(input.userId);
  const confirmed = await getConfirmedVaultArtifactForVault(membership.vault_id);
  return transaction(async (sql) => {
    const proposals = await sql<LockedProposalRow[]>`
      SELECT id, vault_id, roster_digest, input_coin_id, kind, round_id,
             actor_participant_id, proposal_digest, unsigned_txid,
             psbt_base64, final_txid, status, expires_at
      FROM vault_transaction_proposals
      WHERE id = ${input.proposalId}::uuid
        AND vault_id = ${membership.vault_id}::uuid
        AND status = 'collecting'
        AND expires_at > now()
      FOR UPDATE
    `;
    const proposal = proposals[0];
    if (!proposal) throw new Error('solo proposal is missing, expired, or no longer collecting');
    if (proposal.kind !== 'solo' || proposal.actor_participant_id !== membership.participant_id) {
      throw new Error('this participant cannot finalize the requested solo proposal');
    }
    if (
      proposal.proposal_digest.toString('hex') !== input.proposalDigest ||
      proposal.roster_digest.toString('hex') !== confirmed.digest
    ) {
      throw new Error('solo proposal digest differs from the confirmed vault commitment');
    }
    const coins = await sql<StoredCoinRow[]>`
      SELECT id, vault_id, roster_digest, kind, round_id, owner_participant_id,
             txid, vout::text, value_sats::text, script_pubkey, status,
             confirmed_height::text
      FROM vault_coins
      WHERE id = ${proposal.input_coin_id}::uuid
        AND vault_id = ${membership.vault_id}::uuid
        AND status = 'current'
      FOR UPDATE
    `;
    if (coins.length !== 1) throw new Error('proposal input is no longer the current vault coin');
    const coin = storedCoinSnapshot(coins[0]!);
    const validated = validateVaultCoin(confirmed.artifact, coin);
    const rebuilt = buildVaultProposal({
      artifact: confirmed.artifact,
      coin,
      kind: 'solo',
      actorParticipantId: membership.participant_id,
      expiresAt: proposal.expires_at.toISOString(),
    });
    if (
      rebuilt.digest !== input.proposalDigest ||
      rebuilt.psbtBase64 !== proposal.psbt_base64 ||
      rebuilt.unsignedTxid !== proposal.unsigned_txid.toString('hex')
    ) {
      throw new Error('stored solo proposal no longer reproduces from the current vault coin');
    }
    const authorization = authorizeSoloSigningArtifacts(
      validated.state,
      validated.currentParticipantIds,
      membership.participant_id,
      proposal.psbt_base64,
      {
        txHex: input.transactionHex,
        signedPsbtBase64: input.signedPsbtBase64 ?? null,
      },
    );
    if (!authorization.finalTxid || !authorization.consensus) {
      throw new Error('solo result is not a finalized consensus-valid transaction');
    }
    if (authorization.finalTxid !== proposal.unsigned_txid.toString('hex')) {
      throw new Error('solo signature changed the committed unsigned transaction');
    }
    const updated = await sql<Array<{ id: string }>>`
      UPDATE vault_transaction_proposals
      SET status = 'finalized', finalized_tx_hex = ${input.transactionHex},
          final_txid = ${Buffer.from(authorization.finalTxid, 'hex')}, updated_at = now()
      WHERE id = ${proposal.id}::uuid AND status = 'collecting'
      RETURNING id
    `;
    if (updated.length !== 1) throw new Error('solo proposal status changed during finalization');
    return {
      txid: authorization.finalTxid,
      consensusChecks: authorization.consensus.checks,
    };
  });
}

export async function recordCooperativeContribution(input: {
  userId: string;
  proposalId: string;
  proposalDigest: string;
  kind: 'musig_pubnonce' | 'musig_partial';
  value: string;
}): Promise<{
  pubnonceCount: number;
  partialCount: number;
  requiredCount: number;
  finalizedTxid: string | null;
}> {
  if (!/^[0-9a-f]{64}$/u.test(input.proposalDigest)) throw new Error('proposal digest is invalid');
  const shape = input.kind === 'musig_pubnonce' ? /^[0-9a-f]{132}$/u : /^[0-9a-f]{64}$/u;
  if (!shape.test(input.value)) throw new Error(`${input.kind} has an invalid shape`);
  const membership = await membershipForUser(input.userId);
  const confirmed = await getConfirmedVaultArtifactForVault(membership.vault_id);
  return transaction(async (sql) => {
    const proposals = await sql<LockedProposalRow[]>`
      SELECT id, vault_id, roster_digest, input_coin_id, kind, round_id,
             actor_participant_id, proposal_digest, unsigned_txid,
             psbt_base64, final_txid, status, expires_at
      FROM vault_transaction_proposals
      WHERE id = ${input.proposalId}::uuid
        AND vault_id = ${membership.vault_id}::uuid
        AND status IN ('collecting', 'finalized') AND expires_at > now()
      FOR UPDATE
    `;
    const proposal = proposals[0];
    if (!proposal || proposal.kind !== 'cooperative') {
      throw new Error('cooperative proposal is missing, expired, or no longer collecting');
    }
    if (
      proposal.proposal_digest.toString('hex') !== input.proposalDigest ||
      proposal.roster_digest.toString('hex') !== confirmed.digest
    ) {
      throw new Error('cooperative proposal differs from the confirmed vault commitment');
    }
    if (proposal.status === 'finalized') {
      const existing = await sql<Array<{ payload_json: { publicKeyHex?: unknown; value?: unknown } }>>`
        SELECT payload_json FROM vault_proposal_contributions
        WHERE proposal_id = ${proposal.id}::uuid
          AND participant_id = ${membership.participant_id}
          AND kind = ${input.kind}
      `;
      const participantPublicKey = confirmed.artifact.participants
        .find((item) => item.id === membership.participant_id)!.personalPublicKeyHex;
      const prior = existing[0]?.payload_json;
      if (prior?.publicKeyHex !== participantPublicKey || prior?.value !== input.value) {
        throw new Error('cooperative proposal is already finalized with different contribution data');
      }
      const counts = await sql<Array<{ pubnonces: string; partials: string }>>`
        SELECT
          count(*) FILTER (WHERE kind = 'musig_pubnonce')::text AS pubnonces,
          count(*) FILTER (WHERE kind = 'musig_partial')::text AS partials
        FROM vault_proposal_contributions WHERE proposal_id = ${proposal.id}::uuid
      `;
      const requiredCount = validatedRequiredSignerCount(confirmed.artifact, proposal.round_id);
      return {
        pubnonceCount: Number(counts[0]?.pubnonces || 0),
        partialCount: Number(counts[0]?.partials || 0),
        requiredCount,
        finalizedTxid: proposal.final_txid?.toString('hex') || null,
      };
    }
    const coins = await sql<StoredCoinRow[]>`
      SELECT id, vault_id, roster_digest, kind, round_id, owner_participant_id,
             txid, vout::text, value_sats::text, script_pubkey, status,
             confirmed_height::text
      FROM vault_coins
      WHERE id = ${proposal.input_coin_id}::uuid
        AND vault_id = ${membership.vault_id}::uuid AND status = 'current'
      FOR UPDATE
    `;
    if (coins.length !== 1) throw new Error('proposal input is no longer the current vault coin');
    const coin = storedCoinSnapshot(coins[0]!);
    const validated = validateVaultCoin(confirmed.artifact, coin);
    if (!validated.currentParticipantIds.includes(membership.participant_id)) {
      throw new Error('this participant is not a signer in the current cooperative round');
    }
    const snapshotDigest = vaultCoinSnapshotDigest(coin);
    const observations = await sql<Array<{ participant_id: string }>>`
      SELECT participant_id FROM vault_coin_observations
      WHERE coin_id = ${coin.id}::uuid AND user_id = ${input.userId}::uuid
        AND participant_id = ${membership.participant_id}
        AND snapshot_digest = ${Buffer.from(snapshotDigest, 'hex')}
        AND observed_unspent = true
    `;
    if (observations.length !== 1) {
      throw new Error('verify the exact current coin before contributing to MuSig2');
    }
    const rebuilt = buildVaultProposal({
      artifact: confirmed.artifact,
      coin,
      kind: 'cooperative',
      expiresAt: proposal.expires_at.toISOString(),
    });
    if (
      rebuilt.digest !== input.proposalDigest ||
      rebuilt.psbtBase64 !== proposal.psbt_base64 ||
      rebuilt.unsignedTxid !== proposal.unsigned_txid.toString('hex')
    ) {
      throw new Error('stored cooperative proposal does not reproduce from the current vault coin');
    }
    const participant = validated.state.participants.find((item) => item.id === membership.participant_id)!;
    const payload = { publicKeyHex: participant.personal.publicKeyHex, value: input.value };
    if (input.kind === 'musig_pubnonce') validateCooperativePubnonce(input.value);
    if (input.kind === 'musig_partial') {
      const nonceRows = await sql<Array<{
        participant_id: string;
        kind: 'musig_pubnonce';
        payload_json: { publicKeyHex?: unknown; value?: unknown };
      }>>`
        SELECT participant_id, kind, payload_json FROM vault_proposal_contributions
        WHERE proposal_id = ${proposal.id}::uuid AND kind = 'musig_pubnonce'
      `;
      if (nonceRows.length !== rebuilt.requiredSignerIds.length) {
        throw new Error('all public nonces must be present before partial signatures');
      }
      const nonceMaps = contributionMaps(nonceRows);
      validateCooperativePartial({
        state: validated.state,
        participantId: membership.participant_id,
        context: ceremonyStart({
          state: validated.state,
          currentIds: validated.currentParticipantIds,
          trustedInput: coin,
        }),
        pubnonces: nonceMaps.pubnonces,
        partialSig: input.value,
        trustedInput: coin,
      });
    }
    const inserted = await sql<Array<{ participant_id: string }>>`
      INSERT INTO vault_proposal_contributions (
        proposal_id, vault_id, proposal_digest, user_id, participant_id,
        kind, payload_json, payload_hash
      ) VALUES (
        ${proposal.id}::uuid, ${membership.vault_id}::uuid,
        ${Buffer.from(input.proposalDigest, 'hex')}, ${input.userId}::uuid,
        ${membership.participant_id}, ${input.kind}, ${sql.json(payload)},
        ${Buffer.from(sha256Hex(JSON.stringify(payload)), 'hex')}
      )
      ON CONFLICT DO NOTHING
      RETURNING participant_id
    `;
    if (inserted.length !== 1) {
      const existing = await sql<Array<{ payload_json: { publicKeyHex?: unknown; value?: unknown } }>>`
        SELECT payload_json FROM vault_proposal_contributions
        WHERE proposal_id = ${proposal.id}::uuid
          AND participant_id = ${membership.participant_id}
          AND kind = ${input.kind}
      `;
      const prior = existing[0]?.payload_json;
      if (prior?.publicKeyHex !== payload.publicKeyHex || prior?.value !== payload.value) {
        throw new Error(`participant already submitted a different ${input.kind}`);
      }
    }
    const rows = await sql<Array<{
      participant_id: string;
      kind: 'musig_pubnonce' | 'musig_partial';
      payload_json: { publicKeyHex?: unknown; value?: unknown };
    }>>`
      SELECT participant_id, kind, payload_json
      FROM vault_proposal_contributions
      WHERE proposal_id = ${proposal.id}::uuid
        AND kind IN ('musig_pubnonce', 'musig_partial')
      ORDER BY participant_id, kind
    `;
    const maps = contributionMaps(rows);
    const context = ceremonyStart({
      state: validated.state,
      currentIds: validated.currentParticipantIds,
      trustedInput: coin,
    });
    const requiredCount = rebuilt.requiredSignerIds.length;
    if (Object.keys(maps.pubnonces).length === requiredCount) {
      validateCooperativeNonceSet({
        state: validated.state,
        context,
        pubnonces: maps.pubnonces,
        trustedInput: coin,
      });
    }
    let finalizedTxid: string | null = null;
    if (Object.keys(maps.partialSigs).length === requiredCount) {
      const aggregated = ceremonyAggregate({
        state: validated.state,
        context,
        pubnonces: maps.pubnonces,
        partialSigs: maps.partialSigs,
        trustedInput: coin,
      });
      const updated = await sql<Array<{ id: string }>>`
        UPDATE vault_transaction_proposals
        SET status = 'finalized', finalized_tx_hex = ${aggregated.transactionHex},
            final_txid = ${Buffer.from(aggregated.txid, 'hex')}, updated_at = now()
        WHERE id = ${proposal.id}::uuid AND status = 'collecting'
        RETURNING id
      `;
      if (updated.length !== 1) throw new Error('cooperative proposal changed during aggregation');
      finalizedTxid = aggregated.txid;
    }
    return {
      pubnonceCount: Object.keys(maps.pubnonces).length,
      partialCount: Object.keys(maps.partialSigs).length,
      requiredCount,
      finalizedTxid,
    };
  });
}

export async function finalizeStoredFinalSweep(input: {
  userId: string;
  proposalId: string;
  proposalDigest: string;
  transactionHex: string;
}): Promise<{ txid: string; consensusChecks: string[] }> {
  if (!/^[0-9a-f]{64}$/u.test(input.proposalDigest)) throw new Error('proposal digest is invalid');
  if (!/^[0-9a-f]+$/u.test(input.transactionHex) || input.transactionHex.length > 400_000) {
    throw new Error('final transaction hex is invalid');
  }
  const membership = await membershipForUser(input.userId);
  const confirmed = await getConfirmedVaultArtifactForVault(membership.vault_id);
  return transaction(async (sql) => {
    const proposals = await sql<LockedProposalRow[]>`
      SELECT id, vault_id, roster_digest, input_coin_id, kind, round_id,
             actor_participant_id, proposal_digest, unsigned_txid,
             psbt_base64, final_txid, status, expires_at
      FROM vault_transaction_proposals
      WHERE id = ${input.proposalId}::uuid AND vault_id = ${membership.vault_id}::uuid
        AND status = 'collecting' AND expires_at > now()
      FOR UPDATE
    `;
    const proposal = proposals[0];
    if (!proposal || proposal.kind !== 'final_sweep') {
      throw new Error('final-sweep proposal is missing, expired, or no longer collecting');
    }
    if (proposal.actor_participant_id !== membership.participant_id) {
      throw new Error('only the final payout owner can finalize this sweep');
    }
    if (
      proposal.proposal_digest.toString('hex') !== input.proposalDigest ||
      proposal.roster_digest.toString('hex') !== confirmed.digest
    ) throw new Error('final-sweep proposal differs from the confirmed vault commitment');
    const coins = await sql<StoredCoinRow[]>`
      SELECT id, vault_id, roster_digest, kind, round_id, owner_participant_id,
             txid, vout::text, value_sats::text, script_pubkey, status,
             confirmed_height::text
      FROM vault_coins
      WHERE id = ${proposal.input_coin_id}::uuid AND vault_id = ${membership.vault_id}::uuid
        AND status = 'current'
      FOR UPDATE
    `;
    if (coins.length !== 1) throw new Error('proposal input is no longer the current payout coin');
    const coin = storedCoinSnapshot(coins[0]!);
    const validated = validateVaultCoin(confirmed.artifact, coin);
    const rebuilt = buildVaultProposal({
      artifact: confirmed.artifact,
      coin,
      kind: 'final_sweep',
      actorParticipantId: membership.participant_id,
      expiresAt: proposal.expires_at.toISOString(),
    });
    if (
      rebuilt.digest !== input.proposalDigest || rebuilt.psbtBase64 !== proposal.psbt_base64 ||
      rebuilt.unsignedTxid !== proposal.unsigned_txid.toString('hex')
    ) throw new Error('stored final sweep does not reproduce from the current payout coin');
    const authorization = authorizeFinalSweep({
      state: validated.state,
      participantId: membership.participant_id,
      psbtBase64: proposal.psbt_base64,
      trustedInput: coin,
      feeSats: validated.state.economics.finalSweepFeeSats,
    });
    const signed = bitcoin.Transaction.fromHex(input.transactionHex);
    if (signed.getId() !== authorization.unsignedTxid || signed.getId() !== rebuilt.unsignedTxid) {
      throw new Error('final sweep signature changed the committed transaction');
    }
    const consensus = verifyVaultTransaction({
      txHex: input.transactionHex,
      prevouts: [{ scriptPubKeyHex: coin.scriptPubKeyHex, valueSats: coin.valueSats }],
    });
    const updated = await sql<Array<{ id: string }>>`
      UPDATE vault_transaction_proposals
      SET status = 'finalized', finalized_tx_hex = ${input.transactionHex},
          final_txid = ${Buffer.from(signed.getId(), 'hex')}, updated_at = now()
      WHERE id = ${proposal.id}::uuid AND status = 'collecting'
      RETURNING id
    `;
    if (updated.length !== 1) throw new Error('final-sweep proposal changed during finalization');
    return { txid: signed.getId(), consensusChecks: consensus.checks };
  });
}

export async function recordRecoveryContribution(input: {
  userId: string;
  proposalId: string;
  proposalDigest: string;
  share: RecoveryShare;
}): Promise<{ shareCount: number; requiredCount: number; finalizedTxid: string | null }> {
  if (!/^[0-9a-f]{64}$/u.test(input.proposalDigest)) throw new Error('proposal digest is invalid');
  const membership = await membershipForUser(input.userId);
  const confirmed = await getConfirmedVaultArtifactForVault(membership.vault_id);
  return transaction(async (sql) => {
    const proposals = await sql<LockedProposalRow[]>`
      SELECT id, vault_id, roster_digest, input_coin_id, kind, round_id,
             actor_participant_id, proposal_digest, unsigned_txid,
             psbt_base64, final_txid, status, expires_at
      FROM vault_transaction_proposals
      WHERE id = ${input.proposalId}::uuid AND vault_id = ${membership.vault_id}::uuid
        AND status IN ('collecting', 'finalized') AND expires_at > now()
      FOR UPDATE
    `;
    const proposal = proposals[0];
    if (!proposal || proposal.kind !== 'recovery' || !proposal.actor_participant_id) {
      throw new Error('recovery proposal is missing, expired, or unavailable');
    }
    if (
      proposal.proposal_digest.toString('hex') !== input.proposalDigest ||
      proposal.roster_digest.toString('hex') !== confirmed.digest
    ) throw new Error('recovery proposal differs from the confirmed vault commitment');
    const coins = await sql<StoredCoinRow[]>`
      SELECT id, vault_id, roster_digest, kind, round_id, owner_participant_id,
             txid, vout::text, value_sats::text, script_pubkey, status,
             confirmed_height::text
      FROM vault_coins
      WHERE id = ${proposal.input_coin_id}::uuid AND vault_id = ${membership.vault_id}::uuid
        AND status = 'current'
      FOR UPDATE
    `;
    if (coins.length !== 1) throw new Error('recovery input is no longer the current vault coin');
    const coin = storedCoinSnapshot(coins[0]!);
    const validated = validateVaultCoin(confirmed.artifact, coin);
    const rebuilt = buildVaultProposal({
      artifact: confirmed.artifact,
      coin,
      kind: 'recovery',
      actorParticipantId: proposal.actor_participant_id,
      expiresAt: proposal.expires_at.toISOString(),
    });
    if (
      rebuilt.digest !== input.proposalDigest || rebuilt.psbtBase64 !== proposal.psbt_base64 ||
      rebuilt.unsignedTxid !== proposal.unsigned_txid.toString('hex')
    ) throw new Error('stored recovery proposal does not reproduce from the current vault coin');
    if (!rebuilt.requiredSignerIds.includes(membership.participant_id)) {
      throw new Error('vanished or unrelated participant cannot contribute a recovery share');
    }
    const observation = await sql<Array<{ confirmations: number; observed_at: Date }>>`
      SELECT confirmations, observed_at FROM vault_coin_observations
      WHERE coin_id = ${coin.id}::uuid AND user_id = ${input.userId}::uuid
        AND participant_id = ${membership.participant_id}
        AND snapshot_digest = ${Buffer.from(vaultCoinSnapshotDigest(coin), 'hex')}
        AND observed_unspent = true
    `;
    if (observation.length !== 1) {
      throw new Error('recovery signer has no independent observation of the exact current coin');
    }
    assertFreshMatureRecoveryObservation({
      confirmations: observation[0]!.confirmations,
      recoveryDelayBlocks: confirmed.artifact.economics.recoveryDelayBlocks,
      observedAtMs: observation[0]!.observed_at.getTime(),
      nowMs: Date.now(),
    });
    if (input.share.participantId !== membership.participant_id) {
      throw new Error('recovery share claims a different participant');
    }
    const authorization = validateRecoveryShare({
      state: validated.state,
      currentIds: validated.currentParticipantIds,
      vanishedId: proposal.actor_participant_id,
      psbtBase64: proposal.psbt_base64,
      trustedInput: coin,
      share: input.share,
    });
    const payload = {
      round: input.share.round,
      vanishedId: input.share.vanishedId,
      participantId: input.share.participantId,
      xonlyPubkey: input.share.xonlyPubkey,
      leafHashHex: input.share.leafHashHex,
      unsignedTxid: input.share.unsignedTxid,
      signatureHex: input.share.signatureHex,
    };
    if (proposal.status === 'finalized') {
      const existing = await sql<Array<{ payload_json: unknown }>>`
        SELECT payload_json FROM vault_proposal_contributions
        WHERE proposal_id = ${proposal.id}::uuid
          AND participant_id = ${membership.participant_id}
          AND kind = 'recovery_share'
      `;
      if (!sameRecoveryShare(existing[0]?.payload_json, payload)) {
        throw new Error('recovery proposal is already finalized with different contribution data');
      }
      const counts = await sql<Array<{ shares: string }>>`
        SELECT count(*)::text AS shares FROM vault_proposal_contributions
        WHERE proposal_id = ${proposal.id}::uuid AND kind = 'recovery_share'
      `;
      return {
        shareCount: Number(counts[0]?.shares || 0),
        requiredCount: authorization.leaf.threshold,
        finalizedTxid: proposal.final_txid?.toString('hex') || null,
      };
    }
    const inserted = await sql<Array<{ participant_id: string }>>`
      INSERT INTO vault_proposal_contributions (
        proposal_id, vault_id, proposal_digest, user_id, participant_id,
        kind, payload_json, payload_hash
      ) VALUES (
        ${proposal.id}::uuid, ${membership.vault_id}::uuid,
        ${Buffer.from(input.proposalDigest, 'hex')}, ${input.userId}::uuid,
        ${membership.participant_id}, 'recovery_share', ${sql.json(payload)},
        ${Buffer.from(sha256Hex(JSON.stringify(payload)), 'hex')}
      )
      ON CONFLICT DO NOTHING RETURNING participant_id
    `;
    if (inserted.length !== 1) {
      const existing = await sql<Array<{ payload_json: unknown }>>`
        SELECT payload_json FROM vault_proposal_contributions
        WHERE proposal_id = ${proposal.id}::uuid
          AND participant_id = ${membership.participant_id}
          AND kind = 'recovery_share'
      `;
      if (!sameRecoveryShare(existing[0]?.payload_json, payload)) {
        throw new Error('participant already submitted a different recovery share');
      }
    }
    const rows = await sql<Array<{ payload_json: unknown }>>`
      SELECT payload_json FROM vault_proposal_contributions
      WHERE proposal_id = ${proposal.id}::uuid AND kind = 'recovery_share'
      ORDER BY participant_id
    `;
    let finalizedTxid: string | null = null;
    if (rows.length === authorization.leaf.threshold) {
      const aggregated = aggregateRecoveryShares({
        state: validated.state,
        currentIds: validated.currentParticipantIds,
        vanishedId: proposal.actor_participant_id,
        psbtBase64: proposal.psbt_base64,
        trustedInput: coin,
        shares: rows.map((item) => parseStoredRecoveryShare(item.payload_json)),
      });
      const updated = await sql<Array<{ id: string }>>`
        UPDATE vault_transaction_proposals
        SET status = 'finalized', finalized_tx_hex = ${aggregated.transactionHex},
            final_txid = ${Buffer.from(aggregated.txid, 'hex')}, updated_at = now()
        WHERE id = ${proposal.id}::uuid AND status = 'collecting'
        RETURNING id
      `;
      if (updated.length !== 1) throw new Error('recovery proposal changed during aggregation');
      finalizedTxid = aggregated.txid;
    }
    return {
      shareCount: rows.length,
      requiredCount: authorization.leaf.threshold,
      finalizedTxid,
    };
  });
}

export async function getCoinObservationChallenge(input: {
  challengeId: string;
  userId: string;
}): Promise<CoinObservationChallenge> {
  const rows = await db()<Array<{
    id: string;
    challenge: string;
    coin_id: string;
    vault_id: string;
    participant_id: string;
    snapshot_digest: Buffer;
    source_origin: string;
    confirmations: number;
    observed_unspent: true;
    credential_id: Base64URLString;
    credential_name: string;
    public_key: Buffer;
    counter: string;
    transports: AuthenticatorTransportFuture[];
  }>>`
    SELECT ch.id, ch.challenge, ch.coin_id, ch.vault_id, ch.participant_id,
           ch.snapshot_digest, ch.source_origin, ch.confirmations,
           ch.observed_unspent, c.credential_id, c.credential_name,
           c.public_key, c.counter, c.transports
    FROM vault_coin_observation_challenges ch
    JOIN webauthn_credentials c
      ON c.credential_id = ch.credential_id AND c.user_id = ch.user_id
    JOIN vault_coins coin
      ON coin.id = ch.coin_id AND coin.vault_id = ch.vault_id AND coin.status = 'current'
    WHERE ch.id = ${input.challengeId}::uuid
      AND ch.user_id = ${input.userId}::uuid
      AND ch.consumed_at IS NULL AND ch.expires_at > now()
  `;
  const row = rows[0];
  if (!row) throw new Error('coin observation challenge is invalid or expired');
  return {
    id: row.id,
    challenge: row.challenge,
    coinId: row.coin_id,
    vaultId: row.vault_id,
    participantId: row.participant_id,
    snapshotDigest: row.snapshot_digest.toString('hex'),
    sourceOrigin: row.source_origin,
    confirmations: row.confirmations,
    observedUnspent: true,
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

export async function completeCoinObservation(
  challenge: CoinObservationChallenge,
  newCounter: number,
): Promise<void> {
  await transaction(async (sql) => {
    const consumed = await sql<Array<{ id: string }>>`
      UPDATE vault_coin_observation_challenges
      SET consumed_at = now()
      WHERE id = ${challenge.id}::uuid
        AND coin_id = ${challenge.coinId}::uuid
        AND user_id = ${challenge.credential.userId}::uuid
        AND credential_id = ${challenge.credential.id}
        AND snapshot_digest = ${Buffer.from(challenge.snapshotDigest, 'hex')}
        AND consumed_at IS NULL AND expires_at > now()
      RETURNING id
    `;
    if (consumed.length !== 1) throw new Error('coin observation challenge was already used or expired');
    const coins = await sql<StoredCoinRow[]>`
      SELECT id, vault_id, roster_digest, kind, round_id, owner_participant_id,
             txid, vout::text, value_sats::text, script_pubkey, status,
             confirmed_height::text
      FROM vault_coins
      WHERE id = ${challenge.coinId}::uuid AND vault_id = ${challenge.vaultId}::uuid
        AND status = 'current'
      FOR UPDATE
    `;
    const coin = coins[0] ? storedCoinSnapshot(coins[0]) : null;
    if (!coin || vaultCoinSnapshotDigest(coin) !== challenge.snapshotDigest) {
      throw new Error('current coin changed after the independent observation');
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
    if (credentials.length !== 1) throw new Error('passkey counter changed during coin observation');
    await sql`
      INSERT INTO vault_coin_observations (
        coin_id, vault_id, user_id, participant_id, credential_id,
        snapshot_digest, source_origin, confirmations, observed_unspent
      ) VALUES (
        ${challenge.coinId}::uuid, ${challenge.vaultId}::uuid,
        ${challenge.credential.userId}::uuid, ${challenge.participantId},
        ${challenge.credential.id}, ${Buffer.from(challenge.snapshotDigest, 'hex')},
        ${challenge.sourceOrigin}, ${challenge.confirmations}, true
      )
      ON CONFLICT (coin_id, participant_id) DO UPDATE SET
        credential_id = EXCLUDED.credential_id,
        snapshot_digest = EXCLUDED.snapshot_digest,
        source_origin = EXCLUDED.source_origin,
        confirmations = EXCLUDED.confirmations,
        observed_unspent = EXCLUDED.observed_unspent,
        observed_at = now()
    `;
  });
}

/**
 * Chain-watcher boundary for the initial funding UTXO. It is intentionally not
 * an HTTP route: deployment wiring must feed it a confirmed mainnet result.
 */
export async function recordConfirmedFundingCoin(input: {
  vaultId: string;
  trustedInput: TrustedVaultInput;
  confirmedHeight: number;
}): Promise<{ id: string; snapshotDigest: string }> {
  if (!Number.isSafeInteger(input.confirmedHeight) || input.confirmedHeight <= 0) {
    throw new Error('confirmed funding height must be a positive integer');
  }
  const confirmed = await getConfirmedVaultArtifactForVault(input.vaultId);
  const coin: VaultCoinSnapshot = {
    vaultId: input.vaultId,
    rosterDigest: confirmed.digest,
    kind: 'vault',
    roundId: confirmed.artifact.funding.round,
    ownerParticipantId: null,
    ...input.trustedInput,
  };
  validateVaultCoin(confirmed.artifact, coin);
  const snapshotDigest = vaultCoinSnapshotDigest(coin);
  return transaction(async (sql) => {
    const existing = await sql<Array<{ id: string }>>`
      SELECT id FROM vault_coins WHERE vault_id = ${input.vaultId}::uuid FOR UPDATE
    `;
    if (existing.length) throw new Error('vault already has recorded chain state');
    const inserted = await sql<Array<{ id: string }>>`
      INSERT INTO vault_coins (
        vault_id, roster_digest, kind, round_id, owner_participant_id,
        txid, vout, value_sats, script_pubkey, confirmed_height
      ) VALUES (
        ${input.vaultId}::uuid,
        ${Buffer.from(confirmed.digest, 'hex')},
        'vault',
        ${coin.roundId},
        NULL,
        ${Buffer.from(coin.txid, 'hex')},
        ${coin.vout},
        ${coin.valueSats},
        ${Buffer.from(coin.scriptPubKeyHex, 'hex')},
        ${input.confirmedHeight}
      )
      RETURNING id
    `;
    const activated = await sql<Array<{ id: string }>>`
      UPDATE vaults SET status = 'active'
      WHERE id = ${input.vaultId}::uuid AND status = 'ready'
      RETURNING id
    `;
    if (activated.length !== 1) {
      throw new Error('vault has not passed the live Sigbash mainnet readiness gate');
    }
    return { id: inserted[0]!.id, snapshotDigest };
  });
}

/**
 * Chain-watcher boundary for a confirmed transaction previously marked as
 * broadcast. It re-verifies the stored transaction before atomically spending
 * the old coin and deriving the only possible next coin from the confirmed
 * roster. Terminal exits close the vault instead.
 */
export async function recordConfirmedVaultProposal(input: {
  vaultId: string;
  txid: string;
  confirmedHeight: number;
}): Promise<{ nextCoin: VaultCoinSnapshot | null; closed: boolean }> {
  if (!/^[0-9a-f]{64}$/u.test(input.txid)) throw new Error('confirmed transaction id is invalid');
  if (!Number.isSafeInteger(input.confirmedHeight) || input.confirmedHeight <= 0) {
    throw new Error('confirmed transaction height must be a positive integer');
  }
  const confirmed = await getConfirmedVaultArtifactForVault(input.vaultId);
  return transaction(async (sql) => {
    const proposals = await sql<ConfirmableProposalRow[]>`
      SELECT id, vault_id, roster_digest, input_coin_id, kind, round_id,
             actor_participant_id, proposal_digest, unsigned_txid,
             psbt_base64, finalized_tx_hex, final_txid, status, expires_at
      FROM vault_transaction_proposals
      WHERE vault_id = ${input.vaultId}::uuid
        AND final_txid = ${Buffer.from(input.txid, 'hex')}
        AND status = 'broadcast'
      FOR UPDATE
    `;
    if (proposals.length !== 1) {
      throw new Error('confirmed transaction is not the vault’s single broadcast proposal');
    }
    const proposal = proposals[0]!;
    if (proposal.roster_digest.toString('hex') !== confirmed.digest) {
      throw new Error('broadcast proposal belongs to a different confirmed roster');
    }
    const coinRows = await sql<StoredCoinRow[]>`
      SELECT id, vault_id, roster_digest, kind, round_id, owner_participant_id,
             txid, vout::text, value_sats::text, script_pubkey, status,
             confirmed_height::text
      FROM vault_coins
      WHERE id = ${proposal.input_coin_id}::uuid
        AND vault_id = ${input.vaultId}::uuid AND status = 'current'
      FOR UPDATE
    `;
    if (coinRows.length !== 1) throw new Error('broadcast proposal no longer spends the current vault coin');
    const coin = storedCoinSnapshot(coinRows[0]!);
    const validated = validateVaultCoin(confirmed.artifact, coin);
    const transactionResult = bitcoin.Transaction.fromHex(proposal.finalized_tx_hex);
    if (transactionResult.getId() !== input.txid ||
        proposal.final_txid?.toString('hex') !== input.txid) {
      throw new Error('confirmed txid differs from the finalized vault transaction');
    }
    verifyVaultTransaction({
      txHex: proposal.finalized_tx_hex,
      prevouts: [{ scriptPubKeyHex: coin.scriptPubKeyHex, valueSats: coin.valueSats }],
    });
    const built = buildVaultProposal({
      artifact: confirmed.artifact,
      coin,
      kind: proposal.kind,
      ...(proposal.actor_participant_id
        ? { actorParticipantId: proposal.actor_participant_id }
        : {}),
      expiresAt: proposal.expires_at.toISOString(),
    });
    if (built.digest !== proposal.proposal_digest.toString('hex') ||
        built.psbtBase64 !== proposal.psbt_base64 ||
        built.unsignedTxid !== proposal.unsigned_txid.toString('hex')) {
      throw new Error('broadcast proposal does not reproduce from the current vault coin');
    }
    const nextCoin = deriveNextVaultCoin({
      artifact: confirmed.artifact,
      coin: validated.coin,
      proposal: built,
      confirmedTxid: input.txid,
    });
    const spent = await sql<Array<{ id: string }>>`
      UPDATE vault_coins
      SET status = 'spent', spent_by_txid = ${Buffer.from(input.txid, 'hex')}, updated_at = now()
      WHERE id = ${coin.id}::uuid AND status = 'current'
      RETURNING id
    `;
    if (spent.length !== 1) throw new Error('current vault coin changed during confirmation');
    if (nextCoin) {
      await sql`
        INSERT INTO vault_coins (
          vault_id, roster_digest, kind, round_id, owner_participant_id,
          txid, vout, value_sats, script_pubkey, confirmed_height
        ) VALUES (
          ${input.vaultId}::uuid, ${Buffer.from(confirmed.digest, 'hex')},
          ${nextCoin.kind}, ${nextCoin.roundId}, ${nextCoin.ownerParticipantId},
          ${Buffer.from(nextCoin.txid, 'hex')}, ${nextCoin.vout}, ${nextCoin.valueSats},
          ${Buffer.from(nextCoin.scriptPubKeyHex, 'hex')}, ${input.confirmedHeight}
        )
      `;
    } else {
      const closed = await sql<Array<{ id: string }>>`
        UPDATE vaults SET status = 'closed'
        WHERE id = ${input.vaultId}::uuid AND status = 'active'
        RETURNING id
      `;
      if (closed.length !== 1) throw new Error('active vault status changed during terminal confirmation');
    }
    const advanced = await sql<Array<{ id: string }>>`
      UPDATE vault_transaction_proposals SET status = 'confirmed', updated_at = now()
      WHERE id = ${proposal.id}::uuid AND status = 'broadcast'
      RETURNING id
    `;
    if (advanced.length !== 1) throw new Error('broadcast proposal changed during confirmation');
    return { nextCoin, closed: nextCoin === null };
  });
}

async function membershipForUser(userId: string): Promise<MembershipRow> {
  const rows = await db()<MembershipRow[]>`
    SELECT vault_id, participant_id FROM vault_members WHERE user_id = ${userId}::uuid
  `;
  if (rows.length !== 1) throw new Error('user does not have exactly one vault membership');
  return rows[0]!;
}

function storedCoinSnapshot(row: StoredCoinRow): VaultCoinSnapshot & { id: string } {
  return {
    id: row.id,
    vaultId: row.vault_id,
    rosterDigest: row.roster_digest.toString('hex'),
    kind: row.kind,
    roundId: row.round_id,
    ownerParticipantId: row.owner_participant_id,
    txid: row.txid.toString('hex'),
    vout: exactSafeInteger(row.vout, 'coin vout'),
    valueSats: exactSafeInteger(row.value_sats, 'coin value'),
    scriptPubKeyHex: row.script_pubkey.toString('hex'),
  };
}

function exactSafeInteger(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${label} is outside JavaScript's safe integer range`);
  return value;
}

function contributionMaps(rows: Array<{
  participant_id: string;
  kind: 'musig_pubnonce' | 'musig_partial';
  payload_json: { publicKeyHex?: unknown; value?: unknown };
}>): { pubnonces: Record<string, string>; partialSigs: Record<string, string> } {
  const pubnonces: Record<string, string> = {};
  const partialSigs: Record<string, string> = {};
  for (const row of rows) {
    const publicKeyHex = String(row.payload_json?.publicKeyHex || '');
    const value = String(row.payload_json?.value || '');
    if (!/^(02|03)[0-9a-f]{64}$/u.test(publicKeyHex)) {
      throw new Error(`stored MuSig2 public key for ${row.participant_id} is invalid`);
    }
    const target = row.kind === 'musig_pubnonce' ? pubnonces : partialSigs;
    const shape = row.kind === 'musig_pubnonce' ? /^[0-9a-f]{132}$/u : /^[0-9a-f]{64}$/u;
    if (!shape.test(value) || target[publicKeyHex]) {
      throw new Error(`stored ${row.kind} for ${row.participant_id} is invalid or duplicated`);
    }
    target[publicKeyHex] = value;
  }
  return { pubnonces, partialSigs };
}

function parseStoredRecoveryShare(value: unknown): RecoveryShare {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('stored recovery share is not an object');
  }
  const row = value as Record<string, unknown>;
  const round = String(row.round || '');
  const vanishedId = String(row.vanishedId || '');
  const participantId = String(row.participantId || '');
  const xonlyPubkey = String(row.xonlyPubkey || '');
  const leafHashHex = String(row.leafHashHex || '');
  const unsignedTxid = String(row.unsignedTxid || '');
  const signatureHex = String(row.signatureHex || '');
  if (!['alicebobcarol', 'alicebob', 'alicecarol', 'bobcarol'].includes(round)) {
    throw new Error('stored recovery share round is invalid');
  }
  if (!['alice', 'bob', 'carol'].includes(vanishedId) ||
      !['alice', 'bob', 'carol'].includes(participantId)) {
    throw new Error('stored recovery share participant is invalid');
  }
  if (!/^[0-9a-f]{64}$/u.test(xonlyPubkey) || !/^[0-9a-f]{64}$/u.test(leafHashHex) ||
      !/^[0-9a-f]{64}$/u.test(unsignedTxid) || !/^[0-9a-f]{128}$/u.test(signatureHex)) {
    throw new Error('stored recovery share cryptographic material is invalid');
  }
  return { round, vanishedId, participantId, xonlyPubkey, leafHashHex, unsignedTxid, signatureHex };
}

function sameRecoveryShare(value: unknown, expected: RecoveryShare): boolean {
  try {
    const actual = parseStoredRecoveryShare(value);
    return actual.round === expected.round && actual.vanishedId === expected.vanishedId &&
      actual.participantId === expected.participantId && actual.xonlyPubkey === expected.xonlyPubkey &&
      actual.leafHashHex === expected.leafHashHex && actual.unsignedTxid === expected.unsignedTxid &&
      actual.signatureHex === expected.signatureHex;
  } catch {
    return false;
  }
}

function validatedRequiredSignerCount(
  artifact: { vaults: Array<{ round: string; participantIds: string[] }> },
  round: string | null,
): number {
  const count = artifact.vaults.find((item) => item.round === round)?.participantIds.length;
  if (count !== 2 && count !== 3) throw new Error('cooperative proposal has an invalid signer round');
  return count;
}
