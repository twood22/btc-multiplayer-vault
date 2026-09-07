'use client';
import { validatePresignedPublicKit } from '../../../src/presigned/backup';
import { presignedRuntimeActionDigest, presignedRuntimeTransactionDigest, validatePresignedRuntimeProposal,
  type PresignedRuntimeAction, type PresignedRuntimeProposal } from '../../../src/presigned/runtime';
import { authorizePresignedExitTransaction } from '../../../src/presigned/signing';
import { authorizePresignedSpendTransaction, validatePresignedCooperativeNonces,
  verifyPresignedCooperativePartial, verifyPresignedRecoveryContribution } from '../../../src/presigned/spends';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL } from '../../../src/presigned/types';
import { assert, sameCanonical } from '../../../src/presigned/validation';
import type { PresignedChainStatus } from '../server/presigned-chain-store';
import type { PresignedRuntimeStatus } from '../server/presigned-runtime-store';
import { presignedPost } from './presigned-ceremony';
import { assertPasskey, stripPrfSecrets } from './webauthn';

export type PresignedBrowserRuntimeStatus = Omit<PresignedRuntimeStatus, 'broadcastAvailable'> & {
  broadcastAvailable: boolean; chain: PresignedChainStatus;
};

/** Public signatures, not presentation phase labels, establish exact transaction content. */
export function verifyPresignedRuntimeView(status: PresignedBrowserRuntimeStatus, expected: {
  vaultId: string; participantId: string;
}): PresignedBrowserRuntimeStatus {
  assert(status.version === 2 && status.protocol === PRESIGNED_PROTOCOL && status.vaultId === expected.vaultId &&
    status.participantId === expected.participantId, 'runtime changed protocol or membership');
  assert(status.chain.protocol === PRESIGNED_PROTOCOL && status.chain.vaultId === expected.vaultId, 'runtime watch changed vault');
  assert(Array.isArray(status.kits) && status.kits.length <= 64 && Array.isArray(status.proposals) && status.proposals.length <= 1024,
    'runtime response exceeds retained-state bounds');
  const kits = status.kits.map(item => {
    const publicKit = validatePresignedPublicKit(item.publicKit);
    assert(publicKit.graph.roster.vaultId === expected.vaultId && publicKit.graph.funding.epochId === item.epochId,
      'runtime kit changed its vault or funding epoch');
    return publicKit;
  });
  assert(new Set(kits.map(kit => kit.graph.digest)).size === kits.length, 'runtime repeats a graph');
  assert(new Set(status.proposals.map(state => state.proposal.proposalId)).size === status.proposals.length, 'runtime repeats a proposal');
  for (const state of status.proposals) {
    const graph = kits.find(kit => kit.graph.digest === state.proposal.graphDigest)?.graph;
    assert(graph && state.version === 2 && state.protocol === PRESIGNED_PROTOCOL, 'runtime proposal lacks its exact retained kit');
    const proposal = validatePresignedRuntimeProposal(graph, state.proposal);
    assert(['collecting', 'finalized', 'abandoned'].includes(state.status), 'unknown runtime proposal status');
    assert(state.publicNonces.length <= proposal.participantIds.length && state.partials.length <= proposal.participantIds.length &&
      state.recoveryContributions.length <= proposal.threshold, 'too many public runtime contributions');
    for (const entries of [state.publicNonces, state.partials, state.recoveryContributions]) {
      assert(new Set(entries.map(item => item.participantId)).size === entries.length &&
        entries.every(item => proposal.participantIds.includes(item.participantId)), 'runtime contribution changed signer set');
    }
    if (state.publicNonces.length === proposal.participantIds.length && state.publicNonces.length) {
      assert(proposal.spend && proposal.kind === 'cooperative', 'nonces appeared on a non-cooperative proposal');
      const nonces = validatePresignedCooperativeNonces({ graph, proposal: proposal.spend, publicNonces: state.publicNonces });
      assert(nonces.nonceSetDigest === state.nonceSetDigest, 'runtime changed the frozen nonce set');
      state.partials.forEach(partial => verifyPresignedCooperativePartial({ graph, proposal: proposal.spend!,
        publicNonces: state.publicNonces, partial }));
    } else assert(!state.partials.length && state.nonceSetDigest === null, 'runtime partials appeared before a complete nonce set');
    if (state.recoveryContributions.length) {
      assert(proposal.kind === 'recovery' && proposal.spend, 'recovery signatures appeared on another spending path');
      state.recoveryContributions.forEach(contribution => verifyPresignedRecoveryContribution({ graph, proposal: proposal.spend!, contribution }));
    }
    assert(new Set(state.broadcastApprovals).size === state.broadcastApprovals.length &&
      state.broadcastApprovals.every(id => PARTICIPANT_IDS.includes(id)), 'runtime has invalid broadcast approvers');
    if (state.finalized) {
      assert(state.status === 'finalized', 'completed bytes have an inconsistent runtime state');
      const completed = proposal.kind === 'solo'
        ? authorizePresignedExitTransaction({ graph, exitId: proposal.exitId!, transactionHex: state.finalized.transactionHex })
        : authorizePresignedSpendTransaction({ graph, proposal: proposal.spend!, transactionHex: state.finalized.transactionHex });
      const approvers = state.finalized.approverParticipantIds;
      assert(approvers.length === proposal.threshold && new Set(approvers).size === approvers.length &&
        approvers.every(id => proposal.participantIds.includes(id)), 'runtime changed exact transaction approval quorum');
      assert(state.finalized.transactionDigest === presignedRuntimeTransactionDigest(proposal, completed, approvers),
        'runtime changed completed bytes or their digest');
      assert(!state.broadcastReady || approvers.every(id => state.broadcastApprovals.includes(id)), 'broadcast appeared before all exact approvals');
    } else assert(state.status !== 'finalized' && !state.broadcastApprovals.length && !state.broadcastReady,
      'broadcast approval appeared before verified completed bytes');
  }
  return status;
}

export async function approvePresignedRuntimeAction(credentialId: string, action: PresignedRuntimeAction,
  expectedProposal: PresignedRuntimeProposal): Promise<void> {
  const digest = presignedRuntimeActionDigest(action);
  const approval = await presignedPost<{ challengeId: string; protocol: string; action: PresignedRuntimeAction;
    actionDigest: string; proposal: PresignedRuntimeProposal; options: Record<string, unknown> }>(
    '/api/vault/presigned/runtime/action/options', { credentialId, action });
  assert(approval.protocol === PRESIGNED_PROTOCOL && approval.actionDigest === digest &&
    presignedRuntimeActionDigest(approval.action) === digest, 'coordinator changed the runtime action before approval');
  sameCanonical(approval.proposal, expectedProposal, 'runtime passkey proposal');
  const credentials = approval.options.allowCredentials as Array<{ id: string; type: string }>;
  assert(approval.options.userVerification === 'required' && credentials?.length === 1 &&
    credentials[0]?.id === credentialId && credentials[0]?.type === 'public-key', 'runtime challenge changed the exact passkey');
  const response = await assertPasskey(approval.options);
  assert(response.id === credentialId, 'runtime approval used another credential');
  stripPrfSecrets(response);
  await presignedPost('/api/vault/presigned/runtime/action/finish', { challengeId: approval.challengeId, actionDigest: digest, response });
}
