import { buildPresignedFeeChild, finalizePresignedFeeChild, type PresignedFeeRequest } from './fees.js';
import { buildPresignedFundingFeeChild, finalizePresignedFundingFeeChild,
  type PresignedFundingFeeRequest, type PresignedFundingFeeSignature } from './funding-fees.js';
import { buildPresignedSpendFeeChild, finalizePresignedSpendFeeChild, type PresignedSpendFeeRequest } from './spend-fees.js';
import { PRESIGNED_PROTOCOL, type ParticipantId } from './types.js';
import { assert, commitmentDigest, exactKeys, hexBytes, identifier, participantId } from './validation.js';

interface PackageBinding {
  version: 2;
  protocol: typeof PRESIGNED_PROTOCOL;
  epochId: string;
  proposalId: string | null;
  ownerParticipantId: ParticipantId;
  parentAuthorityDigest: string;
}
export type PresignedFeeDraft = PackageBinding & (
  { mode: 'funding'; request: PresignedFundingFeeRequest } |
  { mode: 'solo'; request: PresignedFeeRequest } |
  { mode: 'spend'; request: PresignedSpendFeeRequest }
);
export type PresignedFeePackage = PackageBinding & (
  { mode: 'funding'; request: PresignedFundingFeeRequest; signatures: PresignedFundingFeeSignature[] } |
  { mode: 'solo'; request: PresignedFeeRequest; signatures: { payoutSignatureHex: string; sponsorSignedPsbtBase64: string } } |
  { mode: 'spend'; request: PresignedSpendFeeRequest; signatures: { payoutSignatureHex: string; sponsorSignedPsbtBase64: string } }
);

/** Public-only package. The selected payout/refund is preserved exactly. */
export function buildPresignedFeeDraft(draft: PresignedFeeDraft) {
  validateBinding(draft);
  if (draft.mode === 'funding') {
    assert(draft.proposalId === null && draft.request.changeParticipantId === draft.ownerParticipantId,
      'funding fee owner or authority differs');
    return buildPresignedFundingFeeChild(draft.request);
  }
  assert(draft.proposalId !== null, 'runtime fee needs its exact proposal');
  if (draft.mode === 'solo') {
    const built = buildPresignedFeeChild(draft.request);
    assert(draft.request.graph.exits.find(exit => exit.id === draft.request.exitId)?.leaver === draft.ownerParticipantId,
      'only the exact leaver can authorize its payout fee');
    return built;
  }
  assert(draft.mode === 'spend' && draft.request.payoutParticipantId === draft.ownerParticipantId &&
    draft.request.parentSpendProposal.proposalId === draft.proposalId, 'spend fee owner or proposal differs');
  return buildPresignedSpendFeeChild(draft.request);
}

export function validatePresignedFeePackage(value: unknown) {
  exactKeys(value, ['version', 'protocol', 'epochId', 'proposalId', 'ownerParticipantId', 'parentAuthorityDigest',
    'mode', 'request', 'signatures'], 'approved fee package');
  const packageValue = value as PresignedFeePackage;
  const built = buildPresignedFeeDraft(packageValue);
  let completed;
  if (packageValue.mode === 'funding') completed = finalizePresignedFundingFeeChild({
    request: packageValue.request, approvalDigest: built.approvalDigest, signatures: packageValue.signatures });
  else {
    exactKeys(packageValue.signatures, ['payoutSignatureHex', 'sponsorSignedPsbtBase64'], 'fee package signatures');
    completed = packageValue.mode === 'solo'
      ? finalizePresignedFeeChild({ request: packageValue.request, approvalDigest: built.approvalDigest, ...packageValue.signatures })
      : finalizePresignedSpendFeeChild({ request: packageValue.request, approvalDigest: built.approvalDigest, ...packageValue.signatures });
  }
  return { package: packageValue, completed,
    packageDigest: commitmentDigest('vault/presigned-graph-v2/fee-package', packageValue),
    parentTransactionHex: packageValue.mode === 'funding' ? packageValue.request.fundingTransactionHex : packageValue.request.parentTransactionHex };
}

function validateBinding(draft: PresignedFeeDraft): void {
  exactKeys(draft, ['version', 'protocol', 'epochId', 'proposalId', 'ownerParticipantId', 'parentAuthorityDigest', 'mode', 'request',
    ...('signatures' in draft ? ['signatures'] : [])], 'fee draft');
  assert(draft && draft.version === 2 && draft.protocol === PRESIGNED_PROTOCOL, 'wrong fee package protocol');
  identifier(draft.epochId, 'fee package epoch');
  if (draft.proposalId !== null) identifier(draft.proposalId, 'fee package proposal');
  participantId(draft.ownerParticipantId);
  hexBytes(draft.parentAuthorityDigest, 32, 'fee parent authority');
  assert(draft.mode === 'funding' || draft.mode === 'solo' || draft.mode === 'spend', 'unknown fee package mode');
  assert(draft.request?.graph?.funding.epochId === draft.epochId, 'fee package changed epoch');
}
