import * as bitcoin from 'bitcoinjs-lib';

export type BroadcastProposalKind = 'solo' | 'cooperative' | 'recovery' | 'final_sweep';
export type BroadcastContributionKind = 'musig_partial' | 'recovery_share';

export function assertAuthorizedBroadcaster(input: {
  kind: BroadcastProposalKind;
  actorParticipantId: string | null;
  requiredSignerIds: string[];
  participantId: string;
  contributionKinds: BroadcastContributionKind[];
}): void {
  if (!input.requiredSignerIds.includes(input.participantId)) {
    throw new Error('participant is not a required signer for this transaction');
  }
  if (input.kind === 'solo' || input.kind === 'final_sweep') {
    if (input.actorParticipantId !== input.participantId) {
      throw new Error('only the payout owner can approve this broadcast');
    }
    return;
  }
  const requiredContribution = input.kind === 'cooperative' ? 'musig_partial' : 'recovery_share';
  if (!input.contributionKinds.includes(requiredContribution)) {
    throw new Error('participant must contribute their verified signature before approving broadcast');
  }
}

export function assertExactBroadcastTransaction(input: {
  finalizedTxHex: string;
  finalTxid: string;
  observedTxid: string;
  observedTxHex?: string;
}): void {
  if (!/^[0-9a-f]{64}$/u.test(input.finalTxid) || input.observedTxid !== input.finalTxid) {
    throw new Error('Bitcoin backend returned a different transaction id');
  }
  const parsed = bitcoin.Transaction.fromHex(input.finalizedTxHex);
  if (parsed.getId() !== input.finalTxid) {
    throw new Error('stored finalized transaction does not match its transaction id');
  }
  if (input.observedTxHex !== undefined && input.observedTxHex !== input.finalizedTxHex) {
    throw new Error('Bitcoin backend returned different transaction bytes for the approved id');
  }
}

export function confirmedBlockHeight(input: {
  confirmations?: number;
  blockheight?: number;
}): number | null {
  if (!input.confirmations || input.confirmations <= 0) return null;
  if (!Number.isSafeInteger(input.blockheight) || input.blockheight! <= 0) {
    throw new Error('confirmed transaction is missing a valid block height');
  }
  return input.blockheight!;
}
