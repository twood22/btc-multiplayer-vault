'use client';
import { BITCOIN_GENESIS_HASH, BITCOIN_NETWORK_NAME } from '../../../src/network';
import { validatePresignedFeePackage, type PresignedFeePackage } from '../../../src/presigned/fee-package';
import { authorizePresignedFundingTransaction } from '../../../src/presigned/funding';
import type { FeeCoinObservation } from '../../../src/presigned/fees';
import { PRESIGNED_PROTOCOL } from '../../../src/presigned/types';
import { assert, commitmentDigest, sameCanonical } from '../../../src/presigned/validation';
import type { PresignedFeeStatus } from '../server/presigned-fee-store';
import { observePresignedConfirmedSource, validatedPresignedChainApi } from './presigned-chain';
import { presignedPost } from './presigned-ceremony';
import type { PresignedBrowserRuntimeStatus } from './presigned-runtime';
import { assertPasskey, stripPrfSecrets } from './webauthn';

export function verifyPresignedFeeView(status: PresignedFeeStatus, runtime: PresignedBrowserRuntimeStatus) {
  assert(status.version === 2 && status.protocol === PRESIGNED_PROTOCOL && status.vaultId === runtime.vaultId &&
    status.participantId === runtime.participantId, 'fee status changed vault or identity');
  assert(Array.isArray(status.parents) && status.parents.length <= 1100 && Array.isArray(status.packages) &&
    status.packages.length <= 1024, 'fee status exceeds bounds');
  for (const parent of status.parents) {
    const kit = runtime.kits.find(item => item.epochId === parent.epochId && item.publicKit.graph.digest === parent.graphDigest);
    assert(kit, 'fee parent lost its retained graph');
    if (parent.kind === 'funding') {
      assert(parent.proposalId === null && kit.epochStatus === 'approved', 'fee funding is not an approved epoch');
      const completed = authorizePresignedFundingTransaction({ graph: kit.publicKit.graph, transactionHex: parent.transactionHex });
      const digest = commitmentDigest('vault/presigned-graph-v2/funding-finalization', {
        protocol: PRESIGNED_PROTOCOL, graphDigest: kit.publicKit.graph.digest, ...completed });
      assert(completed.txid === parent.txid && digest === parent.authorityDigest, 'fee funding changed its signed bytes');
    } else {
      const proposal = runtime.proposals.find(item => item.proposal.proposalId === parent.proposalId);
      assert(proposal?.finalized && proposal.broadcastReady && proposal.proposal.kind === parent.kind &&
        proposal.proposal.graphDigest === parent.graphDigest && proposal.proposal.epochId === parent.epochId &&
        proposal.proposal.participantIds.includes(status.participantId), 'fee spend is not fully approved by its exact signers');
      assert(parent.kind !== 'solo' || proposal.proposal.actorParticipantId === status.participantId, 'fee spend has another payout owner');
      assert(proposal.finalized.transactionHex === parent.transactionHex && proposal.finalized.txid === parent.txid &&
        proposal.finalized.transactionDigest === parent.authorityDigest, 'fee spend changed its approved parent');
    }
  }
  for (const row of status.packages) {
    const checked = validatePresignedFeePackage(row.package);
    assert(checked.package.ownerParticipantId === status.participantId && checked.package.request.graph.roster.vaultId === status.vaultId,
      'retained fee package belongs to another participant');
  }
  return status;
}

/** HTTPS source chosen independently of the coordinator; returns no coordinator truth flags. */
export async function observePresignedFeeCoin(input: {
  apiUrl: string; allowedOrigins: string[]; txid: string; vout: number; requiredConfirmations: number;
  allowPendingSpend: boolean; expectedPendingSpendTxid?: string;
}): Promise<FeeCoinObservation> {
  const { pendingSpendTxid, ...coin } = await observePresignedConfirmedSource(input);
  assert(coin.confirmations >= input.requiredConfirmations, 'fee coin lacks required independent confirmations');
  if (pendingSpendTxid) assert(input.allowPendingSpend &&
    (!input.expectedPendingSpendTxid || pendingSpendTxid === input.expectedPendingSpendTxid), 'another pending transaction has spent the fee coin');
  return { ...coin, network: BITCOIN_NETWORK_NAME, genesisHash: BITCOIN_GENESIS_HASH, unspentInActiveChain: true, coinbase: false };
}

/** Selects which exact coin to independently verify next. This hint alone grants no authority. */
export async function presignedFeeParentConfirmationHint(input: { apiUrl: string; allowedOrigins: string[]; txid: string }) {
  assert(/^[0-9a-f]{64}$/u.test(input.txid), 'invalid fee parent txid');
  const base = validatedPresignedChainApi(input.apiUrl, input.allowedOrigins);
  const response = await fetch(`${base}/tx/${input.txid}/status`, { cache: 'no-store', credentials: 'omit',
    redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) return false;
  assert(response.ok, 'independent fee parent status is unavailable');
  const status = await response.json();
  assert(status.confirmed === true || status.confirmed === false, 'independent fee parent status is unknown');
  return status.confirmed as boolean;
}

export async function approvePresignedFeePackage(credentialId: string, value: PresignedFeePackage) {
  const checked = validatePresignedFeePackage(value);
  const approval = await presignedPost<{ challengeId: string; package: PresignedFeePackage; packageDigest: string;
    options: Record<string, unknown> }>('/api/vault/presigned/fees/options', { credentialId, package: value });
  assert(approval.packageDigest === checked.packageDigest &&
    validatePresignedFeePackage(approval.package).packageDigest === checked.packageDigest, 'coordinator changed the fee package before approval');
  sameCanonical(approval.package, value, 'exact fee package approval');
  const allowed = approval.options.allowCredentials as Array<{ id: string; type: string }>;
  assert(approval.options.userVerification === 'required' && allowed?.length === 1 &&
    allowed[0]?.id === credentialId && allowed[0]?.type === 'public-key', 'fee approval changed the exact passkey');
  const response = await assertPasskey(approval.options);
  assert(response.id === credentialId, 'fee approval used another credential');
  stripPrfSecrets(response);
  return presignedPost<{ packageId: string; packageDigest: string; status: string }>('/api/vault/presigned/fees/finish', {
    challengeId: approval.challengeId, packageDigest: checked.packageDigest, response });
}
