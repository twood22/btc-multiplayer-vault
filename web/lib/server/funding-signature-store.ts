import 'server-only';
import { Buffer } from 'buffer';
import type { AuthenticatorTransportFuture, Base64URLString } from '@simplewebauthn/server';
import { getRawTransaction, sendRawTransaction, testMempoolAccept } from '../../../src/bitcoin-rpc';
import { assertExactBroadcastTransaction } from '../../../src/broadcast-lifecycle';
import {
  authorizeFundingSignedPsbt,
  authorizeFundingMempoolAcceptance,
  canonicalFundingRestartReason,
  canonicalFundingRestartSnapshot,
  finalizeFundingSignatures,
  fundingRestartApprovalDigest,
  fundingRestartStateDigest,
  fundingSignatureContributionDigest,
  validateFundingSignatureContribution,
  type FinalizedFundingTransaction,
  type FundingRestartSnapshot,
  type FundingSignatureContribution,
} from '../../../src/funding-signing';
import { fundingInputCommitmentDigest } from '../../../src/funding-ceremony';
import { db, transaction } from './db';
import {
  getApprovedFundingPackageForVault,
  getFundingCeremonyStatus,
  type FundingCeremonyStatus,
} from './funding-ceremony-store';
import { consumeRateLimit } from './rate-limit';
import type { StoredCredential } from './webauthn-store';

interface MembershipRow { vault_id: string; participant_id: string }

interface SignatureRow {
  vault_id: string;
  user_id: string;
  participant_id: string;
  roster_digest: Buffer;
  proposal_digest: Buffer;
  input_index: number;
  signature_kind: 'p2wpkh' | 'p2tr';
  signature: Buffer;
  public_key: Buffer | null;
  contribution_digest: Buffer;
}

interface SignatureChallengeRow extends SignatureRow {
  id: string;
  credential_id: Base64URLString;
  challenge: string;
  expires_at: Date;
}

interface FinalizationRow {
  vault_id: string;
  roster_digest: Buffer;
  proposal_digest: Buffer;
  finalization_digest: Buffer;
  final_txid: Buffer;
  transaction_hex: string;
  fee_sats: string;
  vsize: number;
  status: 'awaiting_approvals' | 'approved' | 'submitting' | 'broadcast' | 'confirmed';
}

export interface FundingSigningStatus extends FundingCeremonyStatus {
  signatureContributions: Array<FundingSignatureContribution & { contributionDigest: string }>;
  participantSigned: boolean;
  finalization: (FinalizedFundingTransaction & {
    status: FinalizationRow['status'];
    approvedParticipantIds: string[];
    participantApproved: boolean;
    readyForOperatorBroadcast: boolean;
  }) | null;
  restartStateDigest: string | null;
  restartRequests: FundingRestartRequest[];
}

export interface FundingRestartRequest {
  stateDigest: string;
  restartDigest: string;
  reason: string;
  approvedParticipantIds: string[];
  participantApproved: boolean;
}

export interface FundingSignatureChallenge {
  id: string;
  challenge: string;
  contribution: FundingSignatureContribution;
  contributionDigest: string;
  credential: StoredCredential;
  expiresAt: string;
}

export interface FundingFinalApprovalChallenge {
  id: string;
  challenge: string;
  vaultId: string;
  participantId: string;
  finalizationDigest: string;
  credential: StoredCredential;
  expiresAt: string;
}

export interface FundingRestartChallenge {
  id: string;
  challenge: string;
  snapshot: FundingRestartSnapshot;
  stateDigest: string;
  restartDigest: string;
  reason: string;
  participantId: string;
  credential: StoredCredential;
  expiresAt: string;
}

export interface PasskeyApprovedFinalizedFunding extends FinalizedFundingTransaction {
  status: 'approved' | 'submitting' | 'broadcast' | 'confirmed';
  approvedParticipantIds: string[];
}

export interface FundingBroadcastResult {
  finalTxid: string;
  finalizationDigest: string;
  status: 'broadcast' | 'confirmed';
  alreadySubmitted: boolean;
}

/** Rebuild and verify the exact funding bytes covered by all three final passkey approvals. */
export async function getPasskeyApprovedFinalizedFundingForVault(
  vaultId: string,
): Promise<PasskeyApprovedFinalizedFunding> {
  const packageState = await getApprovedFundingPackageForVault(vaultId);
  const signatureRows = await db()<SignatureRow[]>`
    SELECT vault_id, user_id, participant_id, roster_digest, proposal_digest,
           input_index, signature_kind, signature, public_key, contribution_digest
    FROM participant_funding_signatures
    WHERE vault_id = ${vaultId}::uuid
      AND proposal_digest = ${Buffer.from(packageState.proposal.digest, 'hex')}
    ORDER BY input_index
  `;
  if (signatureRows.length !== 3) {
    throw new Error(`funding activation requires three verified wallet signatures, got ${signatureRows.length}`);
  }
  const contributions = signatureRows.map((row) => {
    const contribution = contributionFromRow(row);
    validateFundingSignatureContribution({
      proposal: packageState.proposal,
      commitments: packageState.commitments,
      contribution,
    });
    if (fundingSignatureContributionDigest(contribution) !== row.contribution_digest.toString('hex')) {
      throw new Error(`stored funding signature for ${row.participant_id} changed after passkey approval`);
    }
    return contribution;
  });
  const rebuilt = finalizeFundingSignatures({
    proposal: packageState.proposal,
    commitments: packageState.commitments,
    contributions,
  });
  const finalRows = await db()<FinalizationRow[]>`
    SELECT vault_id, roster_digest, proposal_digest, finalization_digest, final_txid,
           transaction_hex, fee_sats::text, vsize, status
    FROM funding_finalizations
    WHERE vault_id = ${vaultId}::uuid
  `;
  const finalization = finalRows[0];
  if (!finalization || finalization.status === 'awaiting_approvals') {
    throw new Error('funding transaction does not have unanimous final passkey approval');
  }
  assertStoredFinalization(finalization, rebuilt);
  const approvalRows = await db()<Array<{ participant_id: string }>>`
    SELECT participant_id FROM funding_final_approvals
    WHERE vault_id = ${vaultId}::uuid
      AND finalization_digest = ${Buffer.from(rebuilt.finalizationDigest, 'hex')}
    ORDER BY participant_id
  `;
  const approvedParticipantIds = approvalRows.map((row) => row.participant_id);
  const expectedParticipantIds = packageState.proposal.txTemplate.inputs
    .map((item) => item.participantId)
    .sort();
  if (approvedParticipantIds.length !== 3 ||
      approvedParticipantIds.some((participantId, index) => participantId !== expectedParticipantIds[index])) {
    throw new Error('funding transaction lacks one final passkey approval from each participant');
  }
  return {
    ...rebuilt,
    status: finalization.status,
    approvedParticipantIds,
  };
}

/** Private operator boundary. There is deliberately no HTTP route for this mutation. */
export async function submitPasskeyApprovedFunding(input: {
  vaultId: string;
  expectedFinalizationDigest: string;
  expectedFinalTxid: string;
}): Promise<FundingBroadcastResult> {
  if (process.env.BITCOIN_BACKEND === 'esplora') {
    throw new Error('initial funding broadcast requires private Bitcoin Core testmempoolaccept');
  }
  if (!/^[0-9a-f]{64}$/u.test(input.expectedFinalizationDigest)) {
    throw new Error('expected funding finalization digest is invalid');
  }
  if (!/^[0-9a-f]{64}$/u.test(input.expectedFinalTxid)) {
    throw new Error('expected funding transaction id is invalid');
  }
  const finalization = await getPasskeyApprovedFinalizedFundingForVault(input.vaultId);
  if (finalization.finalizationDigest !== input.expectedFinalizationDigest) {
    throw new Error('operator approved a different funding finalization digest');
  }
  if (finalization.finalTxid !== input.expectedFinalTxid) {
    throw new Error('protected release report approved a different funding transaction id');
  }
  if (finalization.status === 'broadcast' || finalization.status === 'confirmed') {
    await assertFundingObservedOnBackend(finalization);
    return {
      finalTxid: finalization.finalTxid,
      finalizationDigest: finalization.finalizationDigest,
      status: finalization.status,
      alreadySubmitted: true,
    };
  }

  const claim = await transaction(async (sql) => {
    const vaults = await sql<Array<{ status: string }>>`
      SELECT status FROM vaults WHERE id = ${input.vaultId}::uuid FOR UPDATE
    `;
    if (vaults[0]?.status !== 'ready') throw new Error('only a ready pre-funding vault can be submitted');
    const rows = await sql<Array<{
      status: string;
      finalization_digest: Buffer;
      transaction_hex: string;
      submission_started_at: Date | null;
    }>>`
      SELECT status, finalization_digest, transaction_hex, submission_started_at
      FROM funding_finalizations WHERE vault_id = ${input.vaultId}::uuid FOR UPDATE
    `;
    const row = rows[0];
    if (!row || row.finalization_digest.toString('hex') !== finalization.finalizationDigest ||
        row.transaction_hex !== finalization.transactionHex) {
      throw new Error('funding finalization changed before operator submission');
    }
    if (row.status === 'approved') {
      const claimed = await sql<Array<{ submission_started_at: Date }>>`
        UPDATE funding_finalizations
        SET status = 'submitting', submission_started_at = now(), broadcast_failure = NULL
        WHERE vault_id = ${input.vaultId}::uuid AND status = 'approved'
        RETURNING submission_started_at
      `;
      if (claimed.length !== 1) throw new Error('funding submission could not be claimed');
      return { resumed: false, startedAt: claimed[0]!.submission_started_at };
    }
    if (row.status === 'submitting' && row.submission_started_at) {
      return { resumed: true, startedAt: row.submission_started_at };
    }
    throw new Error(`funding finalization is not submit-ready (${row.status})`);
  });

  if (claim.resumed) {
    if (await fundingObservedOnBackend(finalization)) {
      await markFundingBroadcast(finalization);
      return {
        finalTxid: finalization.finalTxid,
        finalizationDigest: finalization.finalizationDigest,
        status: 'broadcast',
        alreadySubmitted: true,
      };
    }
    if (Date.now() - claim.startedAt.getTime() < 10 * 60 * 1000) {
      throw new Error('another operator funding submission is still in progress');
    }
    const reclaimed = await db()<Array<{ vault_id: string }>>`
      UPDATE funding_finalizations
      SET submission_started_at = now(), broadcast_failure = NULL
      WHERE vault_id = ${input.vaultId}::uuid
        AND finalization_digest = ${Buffer.from(finalization.finalizationDigest, 'hex')}
        AND status = 'submitting' AND submission_started_at = ${claim.startedAt}
      RETURNING vault_id
    `;
    if (reclaimed.length !== 1) throw new Error('stale funding submission was claimed elsewhere');
  }

  try {
    const mempool = await testMempoolAccept(finalization.transactionHex);
    try {
      authorizeFundingMempoolAcceptance({ results: mempool, finalization });
    } catch (mempoolError) {
      if (await fundingObservedOnBackend(finalization)) {
        await markFundingBroadcast(finalization);
        return {
          finalTxid: finalization.finalTxid,
          finalizationDigest: finalization.finalizationDigest,
          status: 'broadcast',
          alreadySubmitted: true,
        };
      }
      throw mempoolError;
    }
    const returnedTxid = await sendRawTransaction(finalization.transactionHex);
    assertExactBroadcastTransaction({
      finalizedTxHex: finalization.transactionHex,
      finalTxid: finalization.finalTxid,
      observedTxid: returnedTxid,
    });
    await markFundingBroadcast(finalization);
    return {
      finalTxid: finalization.finalTxid,
      finalizationDigest: finalization.finalizationDigest,
      status: 'broadcast',
      alreadySubmitted: false,
    };
  } catch (error) {
    if (await fundingObservedOnBackend(finalization)) {
      await markFundingBroadcast(finalization);
      return {
        finalTxid: finalization.finalTxid,
        finalizationDigest: finalization.finalizationDigest,
        status: 'broadcast',
        alreadySubmitted: true,
      };
    }
    await releaseFundingSubmission(finalization, error);
    throw error;
  }
}

export async function getFundingSigningStatus(userId: string): Promise<FundingSigningStatus> {
  const ceremony = await getFundingCeremonyStatus(userId);
  if (!ceremony.proposal) {
    const restart = await restartStatus({ ceremony, signatureContributions: [], finalization: null });
    return {
      ...ceremony,
      signatureContributions: [],
      participantSigned: false,
      finalization: null,
      ...restart,
    };
  }
  const packageState = await getApprovedFundingPackageForVault(ceremony.vaultId);
  const rows = await db()<SignatureRow[]>`
    SELECT vault_id, user_id, participant_id, roster_digest, proposal_digest,
           input_index, signature_kind, signature, public_key, contribution_digest
    FROM participant_funding_signatures
    WHERE vault_id = ${ceremony.vaultId}::uuid
      AND proposal_digest = ${Buffer.from(packageState.proposal.digest, 'hex')}
    ORDER BY input_index
  `;
  const signatureContributions = rows.map((row) => {
    const contribution = contributionFromRow(row);
    validateFundingSignatureContribution({
      proposal: packageState.proposal,
      commitments: packageState.commitments,
      contribution,
    });
    const contributionDigest = fundingSignatureContributionDigest(contribution);
    if (contributionDigest !== row.contribution_digest.toString('hex')) {
      throw new Error(`stored funding signature for ${row.participant_id} changed after approval`);
    }
    return { ...contribution, contributionDigest };
  });
  const finalRows = await db()<FinalizationRow[]>`
    SELECT vault_id, roster_digest, proposal_digest, finalization_digest, final_txid,
           transaction_hex, fee_sats::text, vsize, status
    FROM funding_finalizations
    WHERE vault_id = ${ceremony.vaultId}::uuid
  `;
  let finalization: FundingSigningStatus['finalization'] = null;
  if (finalRows[0]) {
    if (signatureContributions.length !== 3) {
      throw new Error('funding finalization exists without three verified wallet signatures');
    }
    const rebuilt = finalizeFundingSignatures({
      proposal: packageState.proposal,
      commitments: packageState.commitments,
      contributions: signatureContributions,
    });
    assertStoredFinalization(finalRows[0], rebuilt);
    const approvals = await db()<Array<{ participant_id: string }>>`
      SELECT participant_id FROM funding_final_approvals
      WHERE vault_id = ${ceremony.vaultId}::uuid
        AND finalization_digest = ${Buffer.from(rebuilt.finalizationDigest, 'hex')}
      ORDER BY participant_id
    `;
    const approvedParticipantIds = approvals.map((item) => item.participant_id);
    finalization = {
      ...rebuilt,
      status: finalRows[0].status,
      approvedParticipantIds,
      participantApproved: approvedParticipantIds.includes(ceremony.participantId),
      readyForOperatorBroadcast: finalRows[0].status === 'approved' && approvedParticipantIds.length === 3,
    };
  } else if (signatureContributions.length === 3) {
    throw new Error('three funding signatures exist without their atomic finalization');
  }
  return {
    ...ceremony,
    signatureContributions,
    participantSigned: signatureContributions.some((item) => item.participantId === ceremony.participantId),
    finalization,
    ...await restartStatus({ ceremony, signatureContributions, finalization }),
  };
}

export async function createFundingSignatureChallenge(input: {
  userId: string;
  credentialId: string;
  challenge: string;
  signedPsbtBase64: string;
}): Promise<FundingSignatureChallenge> {
  await consumeRateLimit({
    action: 'funding_signature', subject: input.userId, limit: 10, windowSeconds: 900,
  });
  const membership = await membershipForUser(input.userId);
  await assertVaultReady(membership.vault_id);
  const packageState = await getApprovedFundingPackageForVault(membership.vault_id);
  const normalized = authorizeFundingSignedPsbt({
    proposal: packageState.proposal,
    commitments: packageState.commitments,
    participantId: membership.participant_id,
    signedPsbtBase64: input.signedPsbtBase64,
  });
  const credential = await selectedCredential(input.userId, input.credentialId, membership);
  const inserted = await transaction(async (sql) => {
    const vaults = await sql<Array<{ status: string }>>`
      SELECT status FROM vaults WHERE id = ${membership.vault_id}::uuid FOR UPDATE
    `;
    if (vaults[0]?.status !== 'ready') throw new Error('vault left the ready state before signature challenge');
    const inputRows = await sql<Array<{
      participant_id: string;
      commitment_digest: Buffer;
    }>>`
      SELECT participant_id, commitment_digest FROM participant_funding_inputs
      WHERE vault_id = ${membership.vault_id}::uuid ORDER BY participant_id
    `;
    const expectedCommitments = packageState.commitments
      .map((item) => ({
        participantId: item.participantId,
        commitmentDigest: fundingInputCommitmentDigest(item),
      }))
      .sort((left, right) => left.participantId.localeCompare(right.participantId));
    if (inputRows.length !== 3 || inputRows.some((row, index) =>
      row.participant_id !== expectedCommitments[index]?.participantId ||
      row.commitment_digest.toString('hex') !== expectedCommitments[index]?.commitmentDigest)) {
      throw new Error('funding inputs changed before wallet signature challenge creation');
    }
    const existing = await sql<Array<{ participant_id: string }>>`
      SELECT participant_id FROM participant_funding_signatures
      WHERE vault_id = ${membership.vault_id}::uuid
        AND participant_id = ${membership.participant_id}
      FOR UPDATE
    `;
    if (existing.length) throw new Error('this participant already supplied an immutable wallet signature');
    await sql`
      DELETE FROM funding_signature_challenges
      WHERE vault_id = ${membership.vault_id}::uuid
        AND participant_id = ${membership.participant_id}
        AND consumed_at IS NULL
    `;
    const contribution = normalized.contribution;
    return sql<Array<{ id: string; expires_at: Date }>>`
      INSERT INTO funding_signature_challenges (
        vault_id, user_id, participant_id, roster_digest, proposal_digest,
        input_index, signature_kind, signature, public_key, contribution_digest,
        credential_id, challenge, expires_at
      ) VALUES (
        ${membership.vault_id}::uuid, ${input.userId}::uuid, ${membership.participant_id},
        ${Buffer.from(contribution.rosterDigest, 'hex')},
        ${Buffer.from(contribution.proposalDigest, 'hex')}, ${contribution.inputIndex},
        ${contribution.kind}, ${Buffer.from(contribution.signatureHex, 'hex')},
        ${contribution.publicKeyHex ? Buffer.from(contribution.publicKeyHex, 'hex') : null},
        ${Buffer.from(normalized.contributionDigest, 'hex')}, ${credential.id}, ${input.challenge},
        now() + interval '5 minutes'
      ) RETURNING id, expires_at
    `;
  });
  return {
    id: inserted[0]!.id,
    challenge: input.challenge,
    contribution: normalized.contribution,
    contributionDigest: normalized.contributionDigest,
    credential,
    expiresAt: inserted[0]!.expires_at.toISOString(),
  };
}

export async function getFundingSignatureChallenge(input: {
  userId: string;
  challengeId: string;
}): Promise<FundingSignatureChallenge> {
  const rows = await db()<Array<SignatureChallengeRow & {
    credential_name: string;
    public_key_credential: Buffer;
    counter: string;
    transports: AuthenticatorTransportFuture[];
  }>>`
    SELECT ch.id, ch.vault_id, ch.user_id, ch.participant_id, ch.roster_digest,
           ch.proposal_digest, ch.input_index, ch.signature_kind, ch.signature,
           ch.public_key, ch.contribution_digest, ch.credential_id, ch.challenge,
           ch.expires_at, c.credential_name, c.public_key AS public_key_credential,
           c.counter::text, c.transports
    FROM funding_signature_challenges ch
    JOIN webauthn_credentials c
      ON c.credential_id = ch.credential_id AND c.user_id = ch.user_id
    WHERE ch.id = ${input.challengeId}::uuid AND ch.user_id = ${input.userId}::uuid
      AND ch.consumed_at IS NULL AND ch.expires_at > now()
  `;
  const row = rows[0];
  if (!row) throw new Error('funding signature challenge is invalid or expired');
  const contribution = contributionFromRow(row);
  const contributionDigest = fundingSignatureContributionDigest(contribution);
  if (contributionDigest !== row.contribution_digest.toString('hex')) {
    throw new Error('funding signature challenge changed after wallet verification');
  }
  return {
    id: row.id,
    challenge: row.challenge,
    contribution,
    contributionDigest,
    expiresAt: row.expires_at.toISOString(),
    credential: materializeCredential(row, row.public_key_credential),
  };
}

export async function completeFundingSignatureChallenge(
  challenge: FundingSignatureChallenge,
  newCounter: number,
): Promise<FundingSigningStatus> {
  const packageState = await getApprovedFundingPackageForVault(challenge.contribution.vaultId);
  validateFundingSignatureContribution({
    proposal: packageState.proposal,
    commitments: packageState.commitments,
    contribution: challenge.contribution,
  });
  if (fundingSignatureContributionDigest(challenge.contribution) !== challenge.contributionDigest) {
    throw new Error('funding signature approval digest changed before completion');
  }
  await transaction(async (sql) => {
    const vaults = await sql<Array<{ status: string }>>`
      SELECT status FROM vaults WHERE id = ${challenge.contribution.vaultId}::uuid FOR UPDATE
    `;
    if (vaults[0]?.status !== 'ready') throw new Error('vault left the ready state before signature approval');
    const consumed = await sql<Array<{ id: string }>>`
      UPDATE funding_signature_challenges SET consumed_at = now()
      WHERE id = ${challenge.id}::uuid
        AND user_id = ${challenge.credential.userId}::uuid
        AND credential_id = ${challenge.credential.id}
        AND contribution_digest = ${Buffer.from(challenge.contributionDigest, 'hex')}
        AND consumed_at IS NULL AND expires_at > now()
      RETURNING id
    `;
    if (consumed.length !== 1) throw new Error('funding signature challenge was already used or expired');
    await updateCredentialCounter(sql, challenge.credential, newCounter);
    const contribution = challenge.contribution;
    await sql`
      INSERT INTO participant_funding_signatures (
        vault_id, user_id, participant_id, roster_digest, proposal_digest,
        input_index, signature_kind, signature, public_key, contribution_digest,
        credential_id, challenge_id
      ) VALUES (
        ${contribution.vaultId}::uuid, ${challenge.credential.userId}::uuid,
        ${contribution.participantId}, ${Buffer.from(contribution.rosterDigest, 'hex')},
        ${Buffer.from(contribution.proposalDigest, 'hex')}, ${contribution.inputIndex},
        ${contribution.kind}, ${Buffer.from(contribution.signatureHex, 'hex')},
        ${contribution.publicKeyHex ? Buffer.from(contribution.publicKeyHex, 'hex') : null},
        ${Buffer.from(challenge.contributionDigest, 'hex')}, ${challenge.credential.id},
        ${challenge.id}::uuid
      )
    `;
    const signatureRows = await sql<SignatureRow[]>`
      SELECT vault_id, user_id, participant_id, roster_digest, proposal_digest,
             input_index, signature_kind, signature, public_key, contribution_digest
      FROM participant_funding_signatures
      WHERE vault_id = ${contribution.vaultId}::uuid
        AND proposal_digest = ${Buffer.from(packageState.proposal.digest, 'hex')}
      ORDER BY input_index
    `;
    if (signatureRows.length === 3) {
      const contributions = signatureRows.map((row) => contributionFromRow(row));
      const finalized = finalizeFundingSignatures({
        proposal: packageState.proposal,
        commitments: packageState.commitments,
        contributions,
      });
      await sql`
        INSERT INTO funding_finalizations (
          vault_id, roster_digest, proposal_digest, finalization_digest, final_txid,
          transaction_hex, fee_sats, vsize
        ) VALUES (
          ${finalized.vaultId}::uuid, ${Buffer.from(finalized.rosterDigest, 'hex')},
          ${Buffer.from(finalized.proposalDigest, 'hex')},
          ${Buffer.from(finalized.finalizationDigest, 'hex')},
          ${Buffer.from(finalized.finalTxid, 'hex')}, ${finalized.transactionHex},
          ${finalized.feeSats}, ${finalized.vsize}
        )
      `;
    }
  });
  return getFundingSigningStatus(challenge.credential.userId);
}

export async function createFundingFinalApprovalChallenge(input: {
  userId: string;
  credentialId: string;
  challenge: string;
}): Promise<FundingFinalApprovalChallenge> {
  await consumeRateLimit({
    action: 'funding_final_approval', subject: input.userId, limit: 10, windowSeconds: 900,
  });
  const membership = await membershipForUser(input.userId);
  await assertVaultReady(membership.vault_id);
  const status = await getFundingSigningStatus(input.userId);
  if (!status.finalization) throw new Error('funding transaction is not finalized by three wallets');
  if (status.finalization.participantApproved) {
    throw new Error('this participant already approved the exact finalized funding transaction');
  }
  if (status.finalization.status !== 'awaiting_approvals') {
    throw new Error('finalized funding transaction is not accepting approvals');
  }
  const credential = await selectedCredential(input.userId, input.credentialId, membership);
  const inserted = await transaction(async (sql) => {
    const vaults = await sql<Array<{ status: string }>>`
      SELECT status FROM vaults WHERE id = ${membership.vault_id}::uuid FOR UPDATE
    `;
    if (vaults[0]?.status !== 'ready') throw new Error('vault left the ready state before final approval challenge');
    const finalRows = await sql<Array<{ status: string; finalization_digest: Buffer }>>`
      SELECT status, finalization_digest FROM funding_finalizations
      WHERE vault_id = ${membership.vault_id}::uuid FOR UPDATE
    `;
    if (finalRows[0]?.status !== 'awaiting_approvals' ||
        finalRows[0]?.finalization_digest.toString('hex') !== status.finalization!.finalizationDigest) {
      throw new Error('finalized funding transaction changed before approval challenge creation');
    }
    await sql`
      DELETE FROM funding_final_approval_challenges
      WHERE vault_id = ${membership.vault_id}::uuid
        AND participant_id = ${membership.participant_id}
        AND consumed_at IS NULL
    `;
    return sql<Array<{ id: string; expires_at: Date }>>`
      INSERT INTO funding_final_approval_challenges (
        vault_id, user_id, participant_id, finalization_digest,
        credential_id, challenge, expires_at
      ) VALUES (
        ${membership.vault_id}::uuid, ${input.userId}::uuid, ${membership.participant_id},
        ${Buffer.from(status.finalization!.finalizationDigest, 'hex')},
        ${credential.id}, ${input.challenge}, now() + interval '5 minutes'
      ) RETURNING id, expires_at
    `;
  });
  return {
    id: inserted[0]!.id,
    challenge: input.challenge,
    vaultId: membership.vault_id,
    participantId: membership.participant_id,
    finalizationDigest: status.finalization.finalizationDigest,
    credential,
    expiresAt: inserted[0]!.expires_at.toISOString(),
  };
}

export async function getFundingFinalApprovalChallenge(input: {
  userId: string;
  challengeId: string;
}): Promise<FundingFinalApprovalChallenge> {
  const rows = await db()<Array<{
    id: string;
    vault_id: string;
    user_id: string;
    participant_id: string;
    finalization_digest: Buffer;
    credential_id: Base64URLString;
    challenge: string;
    expires_at: Date;
    credential_name: string;
    public_key: Buffer;
    counter: string;
    transports: AuthenticatorTransportFuture[];
  }>>`
    SELECT ch.id, ch.vault_id, ch.user_id, ch.participant_id,
           ch.finalization_digest, ch.credential_id, ch.challenge, ch.expires_at,
           c.credential_name, c.public_key, c.counter::text, c.transports
    FROM funding_final_approval_challenges ch
    JOIN webauthn_credentials c
      ON c.credential_id = ch.credential_id AND c.user_id = ch.user_id
    WHERE ch.id = ${input.challengeId}::uuid AND ch.user_id = ${input.userId}::uuid
      AND ch.consumed_at IS NULL AND ch.expires_at > now()
  `;
  const row = rows[0];
  if (!row) throw new Error('funding final-approval challenge is invalid or expired');
  return {
    id: row.id,
    challenge: row.challenge,
    vaultId: row.vault_id,
    participantId: row.participant_id,
    finalizationDigest: row.finalization_digest.toString('hex'),
    credential: materializeCredential(row, row.public_key),
    expiresAt: row.expires_at.toISOString(),
  };
}

export async function completeFundingFinalApprovalChallenge(
  challenge: FundingFinalApprovalChallenge,
  newCounter: number,
): Promise<FundingSigningStatus> {
  await transaction(async (sql) => {
    const vaults = await sql<Array<{ status: string }>>`
      SELECT status FROM vaults WHERE id = ${challenge.vaultId}::uuid FOR UPDATE
    `;
    if (vaults[0]?.status !== 'ready') {
      throw new Error('vault left the ready state before final funding approval');
    }
    const finalRows = await sql<Array<{ status: string; finalization_digest: Buffer }>>`
      SELECT status, finalization_digest FROM funding_finalizations
      WHERE vault_id = ${challenge.vaultId}::uuid FOR UPDATE
    `;
    const finalization = finalRows[0];
    if (!finalization || finalization.status !== 'awaiting_approvals' ||
        finalization.finalization_digest.toString('hex') !== challenge.finalizationDigest) {
      throw new Error('finalized funding transaction changed before passkey approval');
    }
    const consumed = await sql<Array<{ id: string }>>`
      UPDATE funding_final_approval_challenges SET consumed_at = now()
      WHERE id = ${challenge.id}::uuid
        AND user_id = ${challenge.credential.userId}::uuid
        AND credential_id = ${challenge.credential.id}
        AND finalization_digest = ${Buffer.from(challenge.finalizationDigest, 'hex')}
        AND consumed_at IS NULL AND expires_at > now()
      RETURNING id
    `;
    if (consumed.length !== 1) throw new Error('funding final-approval challenge was already used or expired');
    await updateCredentialCounter(sql, challenge.credential, newCounter);
    await sql`
      INSERT INTO funding_final_approvals (
        vault_id, user_id, participant_id, finalization_digest, credential_id, challenge_id
      ) VALUES (
        ${challenge.vaultId}::uuid, ${challenge.credential.userId}::uuid,
        ${challenge.participantId}, ${Buffer.from(challenge.finalizationDigest, 'hex')},
        ${challenge.credential.id}, ${challenge.id}::uuid
      )
    `;
    const counts = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM funding_final_approvals
      WHERE vault_id = ${challenge.vaultId}::uuid
        AND finalization_digest = ${Buffer.from(challenge.finalizationDigest, 'hex')}
    `;
    if (Number(counts[0]?.count || 0) === 3) {
      const approved = await sql<Array<{ vault_id: string }>>`
        UPDATE funding_finalizations SET status = 'approved', approved_at = now()
        WHERE vault_id = ${challenge.vaultId}::uuid
          AND finalization_digest = ${Buffer.from(challenge.finalizationDigest, 'hex')}
          AND status = 'awaiting_approvals'
        RETURNING vault_id
      `;
      if (approved.length !== 1) throw new Error('funding finalization could not enter approved state');
    }
  });
  return getFundingSigningStatus(challenge.credential.userId);
}

export async function createFundingRestartChallenge(input: {
  userId: string;
  credentialId: string;
  challenge: string;
  reason: string;
}): Promise<FundingRestartChallenge> {
  await consumeRateLimit({
    action: 'funding_restart', subject: input.userId, limit: 10, windowSeconds: 900,
  });
  const membership = await membershipForUser(input.userId);
  await assertVaultReady(membership.vault_id);
  const status = await getFundingSigningStatus(input.userId);
  const snapshot = restartSnapshotFromParts({
    ceremony: status,
    signatureContributions: status.signatureContributions,
    finalization: status.finalization,
  });
  if (!snapshot || snapshot.inputs.length === 0) {
    throw new Error('there is no funding ceremony state to restart');
  }
  const reason = canonicalFundingRestartReason(input.reason);
  const stateDigest = fundingRestartStateDigest(snapshot);
  const restartDigest = fundingRestartApprovalDigest({ snapshot, reason });
  if (status.restartRequests.some((request) =>
    request.restartDigest === restartDigest && request.participantApproved)) {
    throw new Error('this participant already approved that exact funding restart');
  }
  const credential = await selectedCredential(input.userId, input.credentialId, membership);
  const inserted = await transaction(async (sql) => {
    const vaults = await sql<Array<{ status: string }>>`
      SELECT status FROM vaults WHERE id = ${membership.vault_id}::uuid FOR UPDATE
    `;
    if (vaults[0]?.status !== 'ready') throw new Error('vault left the pre-funding ready state');
    const lockedSnapshot = await loadLockedFundingRestartSnapshot(
      sql, membership.vault_id, snapshot.rosterDigest,
    );
    if (fundingRestartStateDigest(lockedSnapshot) !== stateDigest) {
      throw new Error('funding ceremony changed before restart approval began');
    }
    await sql`
      DELETE FROM funding_restart_challenges
      WHERE vault_id = ${membership.vault_id}::uuid
        AND participant_id = ${membership.participant_id}
        AND consumed_at IS NULL
    `;
    return sql<Array<{ id: string; expires_at: Date }>>`
      INSERT INTO funding_restart_challenges (
        vault_id, user_id, participant_id, roster_digest, state_digest, restart_digest,
        snapshot_json, reason, credential_id, challenge, expires_at
      ) VALUES (
        ${membership.vault_id}::uuid, ${input.userId}::uuid, ${membership.participant_id},
        ${Buffer.from(snapshot.rosterDigest, 'hex')}, ${Buffer.from(stateDigest, 'hex')},
        ${Buffer.from(restartDigest, 'hex')}, ${sql.json(JSON.parse(JSON.stringify(snapshot)))}, ${reason},
        ${credential.id}, ${input.challenge}, now() + interval '5 minutes'
      ) RETURNING id, expires_at
    `;
  });
  return {
    id: inserted[0]!.id,
    challenge: input.challenge,
    snapshot,
    stateDigest,
    restartDigest,
    reason,
    participantId: membership.participant_id,
    credential,
    expiresAt: inserted[0]!.expires_at.toISOString(),
  };
}

export async function getFundingRestartChallenge(input: {
  userId: string;
  challengeId: string;
}): Promise<FundingRestartChallenge> {
  const rows = await db()<Array<{
    id: string;
    vault_id: string;
    user_id: string;
    participant_id: string;
    state_digest: Buffer;
    restart_digest: Buffer;
    snapshot_json: FundingRestartSnapshot;
    reason: string;
    credential_id: Base64URLString;
    challenge: string;
    expires_at: Date;
    credential_name: string;
    public_key: Buffer;
    counter: string;
    transports: AuthenticatorTransportFuture[];
  }>>`
    SELECT ch.id, ch.vault_id, ch.user_id, ch.participant_id, ch.state_digest,
           ch.restart_digest, ch.snapshot_json, ch.reason, ch.credential_id,
           ch.challenge, ch.expires_at, c.credential_name, c.public_key,
           c.counter::text, c.transports
    FROM funding_restart_challenges ch
    JOIN webauthn_credentials c
      ON c.credential_id = ch.credential_id AND c.user_id = ch.user_id
    WHERE ch.id = ${input.challengeId}::uuid AND ch.user_id = ${input.userId}::uuid
      AND ch.consumed_at IS NULL AND ch.expires_at > now()
  `;
  const row = rows[0];
  if (!row) throw new Error('funding restart challenge is invalid or expired');
  const snapshot = canonicalFundingRestartSnapshot(row.snapshot_json);
  const reason = canonicalFundingRestartReason(row.reason);
  const stateDigest = fundingRestartStateDigest(snapshot);
  const restartDigest = fundingRestartApprovalDigest({ snapshot, reason });
  if (stateDigest !== row.state_digest.toString('hex') ||
      restartDigest !== row.restart_digest.toString('hex')) {
    throw new Error('funding restart challenge changed after creation');
  }
  return {
    id: row.id,
    challenge: row.challenge,
    snapshot,
    stateDigest,
    restartDigest,
    reason,
    participantId: row.participant_id,
    credential: materializeCredential(row, row.public_key),
    expiresAt: row.expires_at.toISOString(),
  };
}

export async function completeFundingRestartChallenge(
  challenge: FundingRestartChallenge,
  newCounter: number,
): Promise<FundingSigningStatus> {
  await transaction(async (sql) => {
    const vaults = await sql<Array<{ status: string }>>`
      SELECT status FROM vaults WHERE id = ${challenge.snapshot.vaultId}::uuid FOR UPDATE
    `;
    if (vaults[0]?.status !== 'ready') {
      throw new Error('broadcast or active funding cannot be restarted');
    }
    const currentSnapshot = await loadLockedFundingRestartSnapshot(
      sql, challenge.snapshot.vaultId, challenge.snapshot.rosterDigest,
    );
    if (fundingRestartStateDigest(currentSnapshot) !== challenge.stateDigest ||
        fundingRestartApprovalDigest({ snapshot: currentSnapshot, reason: challenge.reason }) !==
          challenge.restartDigest) {
      throw new Error('funding ceremony changed before restart passkey approval completed');
    }
    const consumed = await sql<Array<{ id: string }>>`
      UPDATE funding_restart_challenges SET consumed_at = now()
      WHERE id = ${challenge.id}::uuid
        AND user_id = ${challenge.credential.userId}::uuid
        AND credential_id = ${challenge.credential.id}
        AND state_digest = ${Buffer.from(challenge.stateDigest, 'hex')}
        AND restart_digest = ${Buffer.from(challenge.restartDigest, 'hex')}
        AND consumed_at IS NULL AND expires_at > now()
      RETURNING id
    `;
    if (consumed.length !== 1) throw new Error('funding restart challenge was already used or expired');
    await updateCredentialCounter(sql, challenge.credential, newCounter);
    await sql`
      INSERT INTO funding_restart_approvals (
        vault_id, user_id, participant_id, roster_digest, state_digest,
        restart_digest, reason, credential_id, challenge_id
      ) VALUES (
        ${challenge.snapshot.vaultId}::uuid, ${challenge.credential.userId}::uuid,
        ${challenge.participantId}, ${Buffer.from(challenge.snapshot.rosterDigest, 'hex')},
        ${Buffer.from(challenge.stateDigest, 'hex')}, ${Buffer.from(challenge.restartDigest, 'hex')},
        ${challenge.reason}, ${challenge.credential.id}, ${challenge.id}::uuid
      )
    `;
    const approvals = await sql<Array<{ participant_id: string }>>`
      SELECT participant_id FROM funding_restart_approvals
      WHERE vault_id = ${challenge.snapshot.vaultId}::uuid
        AND state_digest = ${Buffer.from(challenge.stateDigest, 'hex')}
        AND restart_digest = ${Buffer.from(challenge.restartDigest, 'hex')}
      ORDER BY participant_id
    `;
    if (approvals.length === 3) {
      const approvedParticipantIds = approvals.map((row) => row.participant_id);
      if (approvedParticipantIds.join(',') !== 'alice,bob,carol') {
        throw new Error('funding restart approvals are not one from each participant');
      }
      await sql`
        INSERT INTO funding_restart_events (
          vault_id, roster_digest, state_digest, restart_digest,
          snapshot_json, reason, approved_participant_ids
        ) VALUES (
          ${challenge.snapshot.vaultId}::uuid,
          ${Buffer.from(challenge.snapshot.rosterDigest, 'hex')},
          ${Buffer.from(challenge.stateDigest, 'hex')},
          ${Buffer.from(challenge.restartDigest, 'hex')},
          ${sql.json(JSON.parse(JSON.stringify(currentSnapshot)))},
          ${challenge.reason}, ${sql.json(approvedParticipantIds)}
        )
      `;
      await clearFundingCeremonyForRestart(sql, challenge.snapshot.vaultId);
    }
  });
  return getFundingSigningStatus(challenge.credential.userId);
}

async function restartStatus(input: {
  ceremony: FundingCeremonyStatus;
  signatureContributions: Array<FundingSignatureContribution & { contributionDigest: string }>;
  finalization: FundingSigningStatus['finalization'];
}): Promise<Pick<FundingSigningStatus, 'restartStateDigest' | 'restartRequests'>> {
  const snapshot = restartSnapshotFromParts(input);
  if (!snapshot || snapshot.inputs.length === 0) {
    return { restartStateDigest: null, restartRequests: [] };
  }
  const stateDigest = fundingRestartStateDigest(snapshot);
  const rows = await db()<Array<{
    restart_digest: Buffer;
    reason: string;
    participant_id: string;
  }>>`
    SELECT restart_digest, reason, participant_id
    FROM funding_restart_approvals
    WHERE vault_id = ${snapshot.vaultId}::uuid
      AND state_digest = ${Buffer.from(stateDigest, 'hex')}
    ORDER BY restart_digest, participant_id
  `;
  const grouped = new Map<string, FundingRestartRequest>();
  for (const row of rows) {
    const restartDigest = row.restart_digest.toString('hex');
    if (fundingRestartApprovalDigest({ snapshot, reason: row.reason }) !== restartDigest) {
      throw new Error('stored funding restart approval changed after passkey approval');
    }
    const request = grouped.get(restartDigest) || {
      stateDigest,
      restartDigest,
      reason: canonicalFundingRestartReason(row.reason),
      approvedParticipantIds: [],
      participantApproved: false,
    };
    request.approvedParticipantIds.push(row.participant_id);
    request.participantApproved ||= row.participant_id === input.ceremony.participantId;
    grouped.set(restartDigest, request);
  }
  return { restartStateDigest: stateDigest, restartRequests: [...grouped.values()] };
}

function restartSnapshotFromParts(input: {
  ceremony: FundingCeremonyStatus;
  signatureContributions: Array<FundingSignatureContribution & { contributionDigest: string }>;
  finalization: FundingSigningStatus['finalization'];
}): FundingRestartSnapshot | null {
  if (input.finalization && !['awaiting_approvals', 'approved'].includes(input.finalization.status)) return null;
  return canonicalFundingRestartSnapshot({
    version: 1,
    network: 'mainnet',
    vaultId: input.ceremony.vaultId,
    rosterDigest: input.ceremony.rosterDigest,
    inputs: input.ceremony.inputs.map((item) => ({
      participantId: item.participantId,
      commitmentDigest: item.commitmentDigest,
    })),
    signatures: input.signatureContributions.map((item) => ({
      participantId: item.participantId,
      contributionDigest: item.contributionDigest,
    })),
    finalization: input.finalization ? {
      finalizationDigest: input.finalization.finalizationDigest,
      status: input.finalization.status as 'awaiting_approvals' | 'approved',
    } : null,
  });
}

async function loadLockedFundingRestartSnapshot(
  sql: Parameters<Parameters<typeof transaction>[0]>[0],
  vaultId: string,
  rosterDigest: string,
): Promise<FundingRestartSnapshot> {
  const [inputs, signatures, finalizations] = await Promise.all([
    sql<Array<{ participant_id: string; commitment_digest: Buffer }>>`
      SELECT participant_id, commitment_digest FROM participant_funding_inputs
      WHERE vault_id = ${vaultId}::uuid ORDER BY participant_id
    `,
    sql<Array<{ participant_id: string; contribution_digest: Buffer }>>`
      SELECT participant_id, contribution_digest FROM participant_funding_signatures
      WHERE vault_id = ${vaultId}::uuid ORDER BY participant_id
    `,
    sql<Array<{ finalization_digest: Buffer; status: string }>>`
      SELECT finalization_digest, status FROM funding_finalizations
      WHERE vault_id = ${vaultId}::uuid
    `,
  ]);
  const finalization = finalizations[0];
  return canonicalFundingRestartSnapshot({
    version: 1,
    network: 'mainnet',
    vaultId,
    rosterDigest,
    inputs: inputs.map((row) => ({
      participantId: row.participant_id,
      commitmentDigest: row.commitment_digest.toString('hex'),
    })),
    signatures: signatures.map((row) => ({
      participantId: row.participant_id,
      contributionDigest: row.contribution_digest.toString('hex'),
    })),
    finalization: finalization ? {
      finalizationDigest: finalization.finalization_digest.toString('hex'),
      status: finalization.status as 'awaiting_approvals' | 'approved',
    } : null,
  });
}

async function clearFundingCeremonyForRestart(
  sql: Parameters<Parameters<typeof transaction>[0]>[0],
  vaultId: string,
): Promise<void> {
  await sql`DELETE FROM funding_final_approvals WHERE vault_id = ${vaultId}::uuid`;
  await sql`DELETE FROM funding_final_approval_challenges WHERE vault_id = ${vaultId}::uuid`;
  await sql`DELETE FROM funding_finalizations WHERE vault_id = ${vaultId}::uuid`;
  await sql`DELETE FROM participant_funding_signatures WHERE vault_id = ${vaultId}::uuid`;
  await sql`DELETE FROM funding_signature_challenges WHERE vault_id = ${vaultId}::uuid`;
  await sql`DELETE FROM participant_funding_inputs WHERE vault_id = ${vaultId}::uuid`;
  await sql`DELETE FROM funding_input_challenges WHERE vault_id = ${vaultId}::uuid`;
  await sql`DELETE FROM funding_restart_approvals WHERE vault_id = ${vaultId}::uuid`;
  await sql`DELETE FROM funding_restart_challenges WHERE vault_id = ${vaultId}::uuid`;
}

function contributionFromRow(row: SignatureRow): FundingSignatureContribution {
  const binding = {
    version: 1 as const,
    network: 'mainnet' as const,
    vaultId: row.vault_id,
    rosterDigest: row.roster_digest.toString('hex'),
    proposalDigest: row.proposal_digest.toString('hex'),
    participantId: row.participant_id,
    inputIndex: row.input_index,
    signatureHex: row.signature.toString('hex'),
  };
  return row.signature_kind === 'p2wpkh'
    ? { ...binding, kind: 'p2wpkh', publicKeyHex: row.public_key?.toString('hex') || '' }
    : { ...binding, kind: 'p2tr', publicKeyHex: null };
}

function assertStoredFinalization(row: FinalizationRow, rebuilt: FinalizedFundingTransaction): void {
  if (row.vault_id !== rebuilt.vaultId || row.roster_digest.toString('hex') !== rebuilt.rosterDigest ||
      row.proposal_digest.toString('hex') !== rebuilt.proposalDigest ||
      row.finalization_digest.toString('hex') !== rebuilt.finalizationDigest ||
      row.final_txid.toString('hex') !== rebuilt.finalTxid || row.transaction_hex !== rebuilt.transactionHex ||
      exactInteger(row.fee_sats, 'funding finalization fee') !== rebuilt.feeSats || row.vsize !== rebuilt.vsize) {
    throw new Error('stored funding finalization does not reproduce from the three wallet signatures');
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
  if (!row) throw new Error('selected passkey is unavailable for funding signature approval');
  return materializeCredential({
    ...row,
    user_id: userId,
    vault_id: membership.vault_id,
    participant_id: membership.participant_id,
  }, row.public_key);
}

function materializeCredential(row: {
  credential_id: Base64URLString;
  credential_name: string;
  counter: string;
  transports: AuthenticatorTransportFuture[];
  user_id: string;
  vault_id: string;
  participant_id: string;
}, publicKey: Buffer): StoredCredential {
  return {
    id: row.credential_id,
    name: row.credential_name,
    userId: row.user_id,
    publicKey: Uint8Array.from(publicKey),
    counter: Number(row.counter),
    transports: row.transports,
    vaultId: row.vault_id,
    participantId: row.participant_id,
  };
}

async function updateCredentialCounter(
  sql: Parameters<Parameters<typeof transaction>[0]>[0],
  credential: StoredCredential,
  newCounter: number,
): Promise<void> {
  const updated = await sql<Array<{ credential_id: string }>>`
    UPDATE webauthn_credentials SET counter = ${newCounter}, last_used_at = now()
    WHERE credential_id = ${credential.id} AND user_id = ${credential.userId}::uuid
      AND counter = ${credential.counter}
    RETURNING credential_id
  `;
  if (updated.length !== 1) throw new Error('passkey counter changed during funding approval');
}

async function assertVaultReady(vaultId: string): Promise<void> {
  const rows = await db()<Array<{ status: string }>>`
    SELECT status FROM vaults WHERE id = ${vaultId}::uuid
  `;
  if (rows[0]?.status !== 'ready') throw new Error('funding signature exchange requires a ready pre-funding vault');
}

async function membershipForUser(userId: string): Promise<MembershipRow> {
  const rows = await db()<MembershipRow[]>`
    SELECT vault_id, participant_id FROM vault_members WHERE user_id = ${userId}::uuid
  `;
  if (rows.length !== 1) throw new Error('funding signing requires exactly one vault membership');
  return rows[0]!;
}

async function fundingObservedOnBackend(
  finalization: FinalizedFundingTransaction,
): Promise<boolean> {
  let observed;
  try {
    observed = await getRawTransaction(finalization.finalTxid, true);
  } catch {
    return false;
  }
  assertExactBroadcastTransaction({
    finalizedTxHex: finalization.transactionHex,
    finalTxid: finalization.finalTxid,
    observedTxid: observed.txid,
    observedTxHex: observed.hex,
  });
  return true;
}

async function assertFundingObservedOnBackend(
  finalization: FinalizedFundingTransaction,
): Promise<void> {
  if (!await fundingObservedOnBackend(finalization)) {
    throw new Error('database says funding was submitted but Bitcoin Core cannot return the exact transaction');
  }
}

async function markFundingBroadcast(finalization: FinalizedFundingTransaction): Promise<void> {
  const updated = await db()<Array<{ vault_id: string }>>`
    UPDATE funding_finalizations
    SET status = 'broadcast', broadcast_at = now(), broadcast_failure = NULL
    WHERE vault_id = ${finalization.vaultId}::uuid
      AND finalization_digest = ${Buffer.from(finalization.finalizationDigest, 'hex')}
      AND transaction_hex = ${finalization.transactionHex}
      AND status = 'submitting'
    RETURNING vault_id
  `;
  if (updated.length === 1) return;
  const rows = await db()<Array<{ status: string; transaction_hex: string }>>`
    SELECT status, transaction_hex FROM funding_finalizations
    WHERE vault_id = ${finalization.vaultId}::uuid
      AND finalization_digest = ${Buffer.from(finalization.finalizationDigest, 'hex')}
  `;
  if (!rows[0] || !['broadcast', 'confirmed'].includes(rows[0].status) ||
      rows[0].transaction_hex !== finalization.transactionHex) {
    throw new Error('funding submission state changed after Bitcoin Core accepted the transaction');
  }
}

async function releaseFundingSubmission(
  finalization: FinalizedFundingTransaction,
  error: unknown,
): Promise<void> {
  await db()`
    UPDATE funding_finalizations
    SET status = 'approved', submission_started_at = NULL,
        broadcast_failure = ${boundedFundingFailure(error)}
    WHERE vault_id = ${finalization.vaultId}::uuid
      AND finalization_digest = ${Buffer.from(finalization.finalizationDigest, 'hex')}
      AND transaction_hex = ${finalization.transactionHex}
      AND status = 'submitting'
  `;
}

function boundedFundingFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : 'funding submission failed';
  return message.replace(/https?:\/\/[^\s]+/giu, '[endpoint redacted]').slice(0, 500);
}

function exactInteger(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is invalid`);
  return number;
}
