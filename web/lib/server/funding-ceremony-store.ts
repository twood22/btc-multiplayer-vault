import 'server-only';
import { Buffer } from 'buffer';
import type { AuthenticatorTransportFuture, Base64URLString } from '@simplewebauthn/server';
import { getTxOut } from '../../../src/bitcoin-rpc';
import {
  buildFundingProposal,
  fundingInputCommitmentDigest,
  validateFundingInputCommitment,
  type FundingInputCommitment,
  type FundingProposal,
} from '../../../src/funding-ceremony';
import { db, transaction } from './db';
import { chainObservationOrigins, fundingFeeSats } from './config';
import { consumeRateLimit } from './rate-limit';
import {
  getConfirmedVaultArtifactForVault,
  type ConfirmedVaultArtifact,
} from './roster-store';
import type { StoredCredential } from './webauthn-store';

interface MembershipRow { vault_id: string; participant_id: string }

interface FundingInputRow {
  vault_id: string;
  user_id: string;
  participant_id: string;
  roster_digest: Buffer;
  txid: Buffer;
  vout: string;
  value_sats: string;
  script_pubkey: Buffer;
  change_address: string | null;
  source_origin: string;
  confirmations: number;
  funding_fee_sats: string;
  commitment_digest: Buffer;
}

interface ChallengeRow extends FundingInputRow {
  id: string;
  credential_id: Base64URLString;
  challenge: string;
  expires_at: Date;
  consumed_at: Date | null;
}

export interface FundingCeremonyStatus {
  vaultId: string;
  rosterDigest: string;
  participantId: string;
  available: boolean;
  vaultStatus: string;
  fundingAddress: string;
  depositSatsPerParticipant: number;
  fundingFeeSats: number;
  chainObservationOrigins: string[];
  inputs: Array<FundingInputCommitment & { commitmentDigest: string }>;
  participantApproved: boolean;
  proposal: FundingProposal | null;
}

export interface FundingInputChallenge {
  id: string;
  challenge: string;
  commitment: FundingInputCommitment;
  commitmentDigest: string;
  credential: StoredCredential;
  expiresAt: string;
}

export async function getFundingCeremonyStatus(userId: string): Promise<FundingCeremonyStatus> {
  const membership = await membershipForUser(userId);
  const confirmed = await getConfirmedVaultArtifactForVault(membership.vault_id);
  const vaultRows = await db()<Array<{ status: string }>>`
    SELECT status FROM vaults WHERE id = ${membership.vault_id}::uuid
  `;
  const vaultStatus = vaultRows[0]?.status || 'missing';
  const inputs = await loadApprovedFundingInputs(membership.vault_id, confirmed);
  const feeSats = inputs[0]?.fundingFeeSats ?? fundingFeeSats();
  if (feeSats >= confirmed.artifact.economics.depositSatsPerParticipant) {
    throw new Error('configured funding fee cannot consume one participant deposit');
  }
  if (inputs.some((item) => item.fundingFeeSats !== feeSats)) {
    throw new Error('stored funding inputs approve inconsistent fees');
  }
  const proposal = inputs.length === 3
    ? buildFundingProposal({ artifact: confirmed.artifact, commitments: inputs, fundingFeeSats: feeSats })
    : null;
  return {
    vaultId: membership.vault_id,
    rosterDigest: confirmed.digest,
    participantId: membership.participant_id,
    available: vaultStatus === 'ready',
    vaultStatus,
    fundingAddress: confirmed.artifact.funding.address,
    depositSatsPerParticipant: confirmed.artifact.economics.depositSatsPerParticipant,
    fundingFeeSats: feeSats,
    chainObservationOrigins: chainObservationOrigins(),
    inputs,
    participantApproved: inputs.some((item) => item.participantId === membership.participant_id),
    proposal,
  };
}

/** Exact proposal the activation boundary must match; unavailable before three approvals. */
export async function getApprovedFundingProposalForVault(vaultId: string): Promise<FundingProposal> {
  return (await getApprovedFundingPackageForVault(vaultId)).proposal;
}

export async function getApprovedFundingPackageForVault(vaultId: string): Promise<{
  proposal: FundingProposal;
  commitments: FundingInputCommitment[];
}> {
  const confirmed = await getConfirmedVaultArtifactForVault(vaultId);
  const inputs = await loadApprovedFundingInputs(vaultId, confirmed);
  if (inputs.length !== 3) {
    throw new Error(`vault funding requires three passkey-approved wallet inputs, got ${inputs.length}`);
  }
  const feeSats = inputs[0]!.fundingFeeSats;
  if (inputs.some((item) => item.fundingFeeSats !== feeSats)) {
    throw new Error('stored funding inputs approve inconsistent fees');
  }
  return {
    commitments: inputs,
    proposal: buildFundingProposal({
      artifact: confirmed.artifact,
      commitments: inputs,
      fundingFeeSats: feeSats,
    }),
  };
}

export async function createFundingInputChallenge(input: {
  userId: string;
  credentialId: string;
  challenge: string;
  txid: string;
  vout: number;
  valueSats: number;
  scriptPubKeyHex: string;
  changeAddress: string | null;
  sourceOrigin: string;
  confirmations: number;
  observedUnspent: true;
}): Promise<FundingInputChallenge> {
  await consumeRateLimit({
    action: 'funding_input', subject: input.userId, limit: 10, windowSeconds: 900,
  });
  const membership = await membershipForUser(input.userId);
  const confirmed = await getConfirmedVaultArtifactForVault(membership.vault_id);
  const vaultRows = await db()<Array<{ status: string }>>`
    SELECT status FROM vaults WHERE id = ${membership.vault_id}::uuid
  `;
  if (vaultRows[0]?.status !== 'ready') {
    throw new Error('funding inputs stay closed until all nine live Sigbash proofs pass');
  }
  if (!chainObservationOrigins().includes(input.sourceOrigin)) {
    throw new Error('funding input used an unapproved independent chain source');
  }
  const existingFees = await db()<Array<{ funding_fee_sats: string }>>`
    SELECT funding_fee_sats::text FROM participant_funding_inputs
    WHERE vault_id = ${membership.vault_id}::uuid
      AND roster_digest = ${Buffer.from(confirmed.digest, 'hex')}
    ORDER BY approved_at LIMIT 1
  `;
  const ceremonyFeeSats = existingFees[0]
    ? exactInteger(existingFees[0].funding_fee_sats, 'funding fee')
    : fundingFeeSats();
  const commitment = validateFundingInputCommitment(confirmed.artifact, {
    version: 1,
    network: 'mainnet',
    vaultId: membership.vault_id,
    rosterDigest: confirmed.digest,
    participantId: membership.participant_id,
    txid: input.txid,
    vout: input.vout,
    valueSats: input.valueSats,
    scriptPubKeyHex: input.scriptPubKeyHex,
    changeAddress: input.changeAddress,
    sourceOrigin: input.sourceOrigin,
    confirmations: input.confirmations,
    observedUnspent: true,
    fundingFeeSats: ceremonyFeeSats,
  });
  await assertServerFundingObservation(commitment);
  const credential = await selectedCredential(input.userId, input.credentialId, membership);
  const commitmentDigest = fundingInputCommitmentDigest(commitment);
  const inserted = await transaction(async (sql) => {
    const approved = await sql<Array<{ participant_id: string }>>`
      SELECT participant_id FROM participant_funding_inputs
      WHERE vault_id = ${membership.vault_id}::uuid
        AND participant_id = ${membership.participant_id}
      FOR UPDATE
    `;
    if (approved.length) throw new Error('this participant already approved an immutable funding input');
    await sql`
      DELETE FROM funding_input_challenges
      WHERE vault_id = ${membership.vault_id}::uuid
        AND participant_id = ${membership.participant_id}
        AND consumed_at IS NULL
    `;
    return sql<Array<{ id: string; expires_at: Date }>>`
      INSERT INTO funding_input_challenges (
        vault_id, user_id, participant_id, roster_digest, credential_id, challenge,
        txid, vout, value_sats, script_pubkey, change_address, source_origin,
        confirmations, funding_fee_sats, commitment_digest, expires_at
      ) VALUES (
        ${membership.vault_id}::uuid, ${input.userId}::uuid, ${membership.participant_id},
        ${Buffer.from(confirmed.digest, 'hex')}, ${credential.id}, ${input.challenge},
        ${Buffer.from(commitment.txid, 'hex')}, ${commitment.vout}, ${commitment.valueSats},
        ${Buffer.from(commitment.scriptPubKeyHex, 'hex')}, ${commitment.changeAddress},
        ${commitment.sourceOrigin}, ${commitment.confirmations}, ${commitment.fundingFeeSats},
        ${Buffer.from(commitmentDigest, 'hex')}, now() + interval '5 minutes'
      ) RETURNING id, expires_at
    `;
  });
  return {
    id: inserted[0]!.id,
    challenge: input.challenge,
    commitment,
    commitmentDigest,
    credential,
    expiresAt: inserted[0]!.expires_at.toISOString(),
  };
}

export async function getFundingInputChallenge(input: {
  userId: string;
  challengeId: string;
}): Promise<FundingInputChallenge> {
  const rows = await db()<Array<ChallengeRow & {
    credential_name: string;
    public_key: Buffer;
    counter: string;
    transports: AuthenticatorTransportFuture[];
  }>>`
    SELECT ch.id, ch.vault_id, ch.user_id, ch.participant_id, ch.roster_digest,
           ch.credential_id, ch.challenge, ch.txid, ch.vout::text, ch.value_sats::text,
           ch.script_pubkey, ch.change_address, ch.source_origin, ch.confirmations,
           ch.funding_fee_sats::text, ch.commitment_digest, ch.expires_at, ch.consumed_at,
           c.credential_name, c.public_key, c.counter::text, c.transports
    FROM funding_input_challenges ch
    JOIN webauthn_credentials c
      ON c.credential_id = ch.credential_id AND c.user_id = ch.user_id
    WHERE ch.id = ${input.challengeId}::uuid AND ch.user_id = ${input.userId}::uuid
      AND ch.consumed_at IS NULL AND ch.expires_at > now()
  `;
  const row = rows[0];
  if (!row) throw new Error('funding input challenge is invalid or expired');
  const commitment = commitmentFromRow(row);
  const commitmentDigest = fundingInputCommitmentDigest(commitment);
  if (commitmentDigest !== row.commitment_digest.toString('hex')) {
    throw new Error('funding input challenge no longer reproduces its approval digest');
  }
  return {
    id: row.id,
    challenge: row.challenge,
    commitment,
    commitmentDigest,
    expiresAt: row.expires_at.toISOString(),
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

export async function completeFundingInputChallenge(
  challenge: FundingInputChallenge,
  newCounter: number,
): Promise<FundingCeremonyStatus> {
  const confirmed = await getConfirmedVaultArtifactForVault(challenge.commitment.vaultId);
  const validated = validateFundingInputCommitment(confirmed.artifact, challenge.commitment);
  if (fundingInputCommitmentDigest(validated) !== challenge.commitmentDigest) {
    throw new Error('funding input approval no longer matches the confirmed roster');
  }
  await assertServerFundingObservation(challenge.commitment);
  await transaction(async (sql) => {
    const vaults = await sql<Array<{ status: string }>>`
      SELECT status FROM vaults WHERE id = ${challenge.commitment.vaultId}::uuid FOR UPDATE
    `;
    if (vaults[0]?.status !== 'ready') {
      throw new Error('vault left the pre-funding ready state before input approval completed');
    }
    const consumed = await sql<Array<{ id: string }>>`
      UPDATE funding_input_challenges SET consumed_at = now()
      WHERE id = ${challenge.id}::uuid
        AND user_id = ${challenge.credential.userId}::uuid
        AND credential_id = ${challenge.credential.id}
        AND commitment_digest = ${Buffer.from(challenge.commitmentDigest, 'hex')}
        AND consumed_at IS NULL AND expires_at > now()
      RETURNING id
    `;
    if (consumed.length !== 1) throw new Error('funding input challenge was already used or expired');
    const updated = await sql<Array<{ credential_id: string }>>`
      UPDATE webauthn_credentials SET counter = ${newCounter}, last_used_at = now()
      WHERE credential_id = ${challenge.credential.id}
        AND user_id = ${challenge.credential.userId}::uuid
        AND counter = ${challenge.credential.counter}
      RETURNING credential_id
    `;
    if (updated.length !== 1) throw new Error('passkey counter changed during funding approval');
    const item = challenge.commitment;
    await sql`
      INSERT INTO participant_funding_inputs (
        vault_id, user_id, participant_id, roster_digest, txid, vout, value_sats,
        script_pubkey, change_address, source_origin, confirmations, funding_fee_sats,
        commitment_digest, credential_id, challenge_id
      ) VALUES (
        ${item.vaultId}::uuid, ${challenge.credential.userId}::uuid, ${item.participantId},
        ${Buffer.from(item.rosterDigest, 'hex')}, ${Buffer.from(item.txid, 'hex')},
        ${item.vout}, ${item.valueSats}, ${Buffer.from(item.scriptPubKeyHex, 'hex')},
        ${item.changeAddress}, ${item.sourceOrigin}, ${item.confirmations},
        ${item.fundingFeeSats}, ${Buffer.from(challenge.commitmentDigest, 'hex')},
        ${challenge.credential.id}, ${challenge.id}::uuid
      )
    `;
  });
  return getFundingCeremonyStatus(challenge.credential.userId);
}

async function assertServerFundingObservation(commitment: FundingInputCommitment): Promise<void> {
  const observed = await getTxOut(commitment.txid, commitment.vout);
  if (!observed || observed.coinbase || !observed.scriptPubKey?.hex) {
    throw new Error('Bitcoin backend does not report the funding input as an unspent normal output');
  }
  const valueSats = btcToSats(observed.value);
  if (valueSats !== commitment.valueSats ||
      observed.scriptPubKey.hex.toLowerCase() !== commitment.scriptPubKeyHex) {
    throw new Error('Bitcoin backend funding output differs from the participant observation');
  }
  if (!Number.isSafeInteger(observed.confirmations) || observed.confirmations < 1) {
    throw new Error('Bitcoin backend does not report the funding input confirmed');
  }
}

async function selectedCredential(
  userId: string,
  credentialId: string,
  membership: MembershipRow,
): Promise<StoredCredential> {
  const rows = await db()<Array<{
    credential_id: Base64URLString;
    credential_name: string;
    public_key: Buffer;
    counter: string;
    transports: AuthenticatorTransportFuture[];
  }>>`
    SELECT credential_id, credential_name, public_key, counter::text, transports
    FROM webauthn_credentials
    WHERE user_id = ${userId}::uuid AND credential_id = ${credentialId}
      AND prf_enabled = true
  `;
  const row = rows[0];
  if (!row) throw new Error('selected passkey is unavailable for funding approval');
  return {
    id: row.credential_id,
    name: row.credential_name,
    userId,
    publicKey: Uint8Array.from(row.public_key),
    counter: Number(row.counter),
    transports: row.transports,
    vaultId: membership.vault_id,
    participantId: membership.participant_id,
  };
}

function commitmentFromRow(row: FundingInputRow): FundingInputCommitment {
  return {
    version: 1,
    network: 'mainnet',
    vaultId: row.vault_id,
    rosterDigest: row.roster_digest.toString('hex'),
    participantId: row.participant_id,
    txid: row.txid.toString('hex'),
    vout: exactInteger(row.vout, 'funding output number'),
    valueSats: exactInteger(row.value_sats, 'funding input value'),
    scriptPubKeyHex: row.script_pubkey.toString('hex'),
    changeAddress: row.change_address,
    sourceOrigin: row.source_origin,
    confirmations: row.confirmations,
    observedUnspent: true,
    fundingFeeSats: exactInteger(row.funding_fee_sats, 'funding fee'),
  };
}

async function loadApprovedFundingInputs(
  vaultId: string,
  confirmed: ConfirmedVaultArtifact,
): Promise<Array<FundingInputCommitment & { commitmentDigest: string }>> {
  const rows = await db()<FundingInputRow[]>`
    SELECT vault_id, user_id, participant_id, roster_digest, txid, vout::text,
           value_sats::text, script_pubkey, change_address, source_origin,
           confirmations, funding_fee_sats::text, commitment_digest
    FROM participant_funding_inputs
    WHERE vault_id = ${vaultId}::uuid
      AND roster_digest = ${Buffer.from(confirmed.digest, 'hex')}
    ORDER BY participant_id
  `;
  return rows.map((row) => {
    const commitment = validateFundingInputCommitment(confirmed.artifact, commitmentFromRow(row));
    const digest = fundingInputCommitmentDigest(commitment);
    if (digest !== row.commitment_digest.toString('hex')) {
      throw new Error(`stored funding input for ${row.participant_id} does not reproduce its approval digest`);
    }
    return { ...commitment, commitmentDigest: digest };
  });
}

async function membershipForUser(userId: string): Promise<MembershipRow> {
  const rows = await db()<MembershipRow[]>`
    SELECT vault_id, participant_id FROM vault_members WHERE user_id = ${userId}::uuid
  `;
  if (rows.length !== 1) throw new Error('funding ceremony requires exactly one vault membership');
  return rows[0]!;
}

function exactInteger(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is invalid`);
  return number;
}

function btcToSats(value: number): number {
  const sats = Math.round(value * 100_000_000);
  if (!Number.isSafeInteger(sats) || sats < 0 || Math.abs(value - sats / 100_000_000) > 1e-12) {
    throw new Error('Bitcoin backend returned an invalid funding value');
  }
  return sats;
}
