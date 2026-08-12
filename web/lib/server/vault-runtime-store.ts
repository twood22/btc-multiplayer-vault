import 'server-only';
import { Buffer } from 'buffer';
import type { AuthenticatorTransportFuture, Base64URLString } from '@simplewebauthn/server';
import type { TrustedVaultInput } from '../../../src/types';
import {
  buildVaultProposal,
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
  status: 'collecting' | 'finalized' | 'broadcast' | 'confirmed' | 'rejected' | 'stale';
  expires_at: Date;
}

export interface VaultRuntimeStatus {
  vaultId: string;
  participantId: string;
  chainObservationOrigins: string[];
  coin: (VaultCoinSnapshot & {
    id: string;
    status: StoredCoinRow['status'];
    confirmedHeight: number | null;
    snapshotDigest: string;
    observedParticipantIds: string[];
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
  const observations = coin && snapshotDigest ? await db()<Array<{ participant_id: string }>>`
    SELECT participant_id FROM vault_coin_observations
    WHERE coin_id = ${coin.id}::uuid
      AND snapshot_digest = ${Buffer.from(snapshotDigest, 'hex')}
      AND observed_unspent = true
    ORDER BY participant_id
  ` : [];
  const proposals = coin ? await db()<StoredProposalRow[]>`
    SELECT id, kind, round_id, actor_participant_id, proposal_digest,
           unsigned_txid, psbt_base64, status, expires_at
    FROM vault_transaction_proposals
    WHERE input_coin_id = ${coin.id}::uuid
      AND status IN ('collecting', 'finalized', 'broadcast')
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
  return {
    vaultId: membership.vault_id,
    participantId: membership.participant_id,
    chainObservationOrigins: chainObservationOrigins(),
    coin: coin && coinRow ? {
      ...coin,
      status: coinRow.status,
      confirmedHeight: coinRow.confirmed_height === null
        ? null
        : exactSafeInteger(coinRow.confirmed_height, 'confirmed height'),
      snapshotDigest: snapshotDigest!,
      observedParticipantIds: observations.map((item) => item.participant_id),
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
    const observation = await sql<Array<{ participant_id: string }>>`
      SELECT participant_id FROM vault_coin_observations
      WHERE coin_id = ${coin.id}::uuid
        AND user_id = ${userId}::uuid
        AND participant_id = ${membership.participant_id}
        AND snapshot_digest = ${Buffer.from(snapshotDigest, 'hex')}
        AND observed_unspent = true
    `;
    if (observation.length !== 1) {
      throw new Error('verify the exact current coin against an independent chain source before proposing a spend');
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
