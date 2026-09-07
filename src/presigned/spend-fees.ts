import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { validatePresignedGraph } from './graph.js';
import { payoutScript } from './roster.js';
import { authorizePresignedSpendTransaction, validatePresignedSpend, type PresignedSpendProposal } from './spends.js';
import { PRESIGNED_PROTOCOL, type ParticipantId, type PresignedGraph, type PresignedParticipantKeys } from './types.js';
import { assert, commitmentDigest, exactKeys, hexBytes, networkParameters, participantId, safeInteger, supportedWalletScript } from './validation.js';
import { nativeWalletWitnessFromPsbt, verifyNativeWalletWitness } from './wallet.js';
import {
  FEE_MONEY_MAX, FEE_CHILD_SEQUENCE, FEE_TRUC_VERSION, FEE_TRUC_MAX_PARENT_VSIZE, FEE_TRUC_MAX_CHILD_VSIZE,
  SPONSORED_PAYOUT_FEE_KIND, validateFeeCoinObservation, assertFeeCoinMatches, assertSponsoredFeePsbt,
  verifySponsoredFeePriorChild, parseSponsoredFeePsbt, parseSponsoredFeeTransaction,
  sponsoredFeeUnsignedTransaction, sponsoredFeeOutputTotal, validateSponsoredFeeRate, sponsoredFeeAtRate, sponsoredFeeDustFloor,
  type FeeCoinObservation, type PresignedFeeApproval, type PresignedFeeChild,
} from './fees.js';

export interface PresignedSpendFeeRequest {
  graph: PresignedGraph;
  parentSpendProposal: PresignedSpendProposal;
  parentTransactionHex: string;
  /** The output index is derived from the approved proposal, never supplied. */
  payoutParticipantId: ParticipantId;
  /** Independently validated active-chain source, before the parent is mined. */
  sourceObservation: FeeCoinObservation;
  sponsorInput: FeeCoinObservation;
  approval: PresignedFeeApproval;
}

export interface PresignedSpendFeeChild extends Omit<PresignedFeeChild, 'exitId'> {
  parentSpendProposalId: string;
  parentSpendProposalDigest: string;
  parentSpendKind: PresignedSpendProposal['kind'];
  payoutParticipantId: ParticipantId;
  payoutVout: number;
}

/** No solo-graph substitution: the exact interactive/CSV/sweep parent is verified. */
export function buildPresignedSpendFeeChild(request: PresignedSpendFeeRequest): PresignedSpendFeeChild {
  exactKeys(request, ['graph', 'parentSpendProposal', 'parentTransactionHex', 'payoutParticipantId', 'sourceObservation', 'sponsorInput', 'approval'], 'spend fee request');
  const graph = validatePresignedGraph(request.graph);
  assert(graph.roster.feePolicy.kind === SPONSORED_PAYOUT_FEE_KIND, 'spend fee request does not commit the TRUC payout policy');
  const proposal = validatePresignedSpend(graph, request.parentSpendProposal);
  participantId(request.payoutParticipantId);
  const payoutVout = proposal.participantIds.indexOf(request.payoutParticipantId);
  assert(payoutVout >= 0, 'fee volunteer does not own a payout of this parent spend');
  validateFeeCoinObservation(request.sourceObservation, graph, 'spend source');
  assertFeeCoinMatches(request.sourceObservation, proposal.source, 'confirmed spend source');
  if (proposal.kind === 'recovery') assert(request.sourceObservation.confirmations >= graph.roster.economics.recoveryDelayBlocks,
    'fee recovery source has not reached the committed CSV age');
  const parent = authorizePresignedSpendTransaction({ graph, proposal, transactionHex: request.parentTransactionHex });
  const parentTx = parseSponsoredFeeTransaction(parent.transactionHex, 'spend fee parent');
  assert(parentTx.version === FEE_TRUC_VERSION && parentTx.ins.length === 1 && parent.vsize <= FEE_TRUC_MAX_PARENT_VSIZE,
    'spend fee parent must be a bounded TRUC transaction with one confirmed source');
  const payout = parentTx.outs[payoutVout]!;
  const ownScript = payoutScript(graph.roster, request.payoutParticipantId);
  assert(payout && Buffer.from(payout.script).equals(ownScript), 'selected parent payout differs from its committed owner');
  const payoutSats = Number(payout.value);
  safeInteger(payoutSats, 330, FEE_MONEY_MAX, 'spend payout amount');

  const sponsor = request.sponsorInput;
  validateFeeCoinObservation(sponsor, graph, 'spend fee sponsor');
  assert(supportedWalletScript(sponsor.scriptPubKeyHex), 'spend fee sponsor must be native P2WPKH or key-path P2TR');
  assert(!graph.rounds.some(round => round.outputScriptHex === sponsor.scriptPubKeyHex), 'a vault cannot sponsor spend fees');
  assert(sponsor.txid !== graph.fundingTxid && !graph.exits.some(exit => exit.txid === sponsor.txid) && sponsor.txid !== parent.txid,
    'sponsor must be outside the funding, exit graph and every payout of the parent spend');
  safeInteger(payoutSats + sponsor.valueSats, 1, FEE_MONEY_MAX, 'spend fee child input total');
  const approval = request.approval;
  exactKeys(approval, ['childFeeSats', 'maxChildFeeSats', 'targetPackageRateMillisatsPerVbyte', 'minRelayRateMillisatsPerVbyte', 'sponsorChangeScriptPubKeyHex', 'approveExactNoChangeFee', 'replacement'], 'spend fee approval');
  safeInteger(approval.maxChildFeeSats, 1, graph.roster.feePolicy.maxChildFeeSats, 'approved spend fee cap');
  safeInteger(approval.childFeeSats, 1, approval.maxChildFeeSats, 'spend child fee');
  validateSponsoredFeeRate(approval.targetPackageRateMillisatsPerVbyte, 'target spend package feerate');
  validateSponsoredFeeRate(approval.minRelayRateMillisatsPerVbyte, 'spend minimum relay feerate');
  assert(typeof approval.approveExactNoChangeFee === 'boolean', 'spend no-change approval is not boolean');
  const sponsorChangeSats = sponsor.valueSats - approval.childFeeSats;
  assert(sponsorChangeSats >= 0, 'sponsor cannot cover the approved spend fee');
  if (!sponsorChangeSats) assert(approval.sponsorChangeScriptPubKeyHex === null && approval.approveExactNoChangeFee,
    'exact no-change spend fee requires explicit approval');
  else {
    assert(!approval.approveExactNoChangeFee && approval.sponsorChangeScriptPubKeyHex !== null, 'sponsor change must be preserved');
    assert(supportedWalletScript(approval.sponsorChangeScriptPubKeyHex), 'spend fee change must be native P2WPKH or key-path P2TR');
    assert(!graph.rounds.some(round => round.outputScriptHex === approval.sponsorChangeScriptPubKeyHex), 'spend fee change cannot recreate a vault');
    assert(sponsorChangeSats >= sponsoredFeeDustFloor(approval.sponsorChangeScriptPubKeyHex), 'spend fee sponsor change is dust');
  }
  if (approval.replacement !== null) {
    exactKeys(approval.replacement, ['previousChildTransactionHex', 'incrementalRelayRateMillisatsPerVbyte'], 'spend fee replacement');
    validateSponsoredFeeRate(approval.replacement.incrementalRelayRateMillisatsPerVbyte, 'spend fee incremental relay rate');
  }
  const owner = graph.roster.participants.find(item => item.id === request.payoutParticipantId)!;
  const psbt = new bitcoin.Psbt({ network: networkParameters(graph.roster.network) });
  psbt.setVersion(FEE_TRUC_VERSION);
  psbt.setLocktime(0);
  psbt.addInput({ hash: parent.txid, index: payoutVout, sequence: FEE_CHILD_SEQUENCE,
    witnessUtxo: { script: ownScript, value: BigInt(payoutSats) }, tapInternalKey: Buffer.from(owner.payoutXonlyPublicKeyHex, 'hex') });
  psbt.addInput({ hash: sponsor.txid, index: sponsor.vout, sequence: FEE_CHILD_SEQUENCE,
    witnessUtxo: { script: Buffer.from(sponsor.scriptPubKeyHex, 'hex'), value: BigInt(sponsor.valueSats) } });
  psbt.addOutput({ script: ownScript, value: BigInt(payoutSats) });
  if (sponsorChangeSats) psbt.addOutput({ script: Buffer.from(approval.sponsorChangeScriptPubKeyHex!, 'hex'), value: BigInt(sponsorChangeSats) });
  const tx = sponsoredFeeUnsignedTransaction(psbt);
  if (approval.replacement) verifySponsoredFeePriorChild(request, tx, ownScript, payoutSats);
  const preview = tx.clone();
  preview.setWitness(0, [Buffer.alloc(64)]);
  preview.setWitness(1, sponsor.scriptPubKeyHex.startsWith('0014') ? [Buffer.alloc(73), Buffer.alloc(33)] : [Buffer.alloc(65)]);
  assert(preview.virtualSize() <= FEE_TRUC_MAX_CHILD_VSIZE, 'spend fee child exceeds the TRUC descendant size limit');
  const approvalDigest = commitmentDigest('btc-multiplayer-vault/presigned-spend-fee-approval/v1', {
    protocol: PRESIGNED_PROTOCOL, kind: SPONSORED_PAYOUT_FEE_KIND, graphDigest: graph.digest,
    parentSpendProposal: proposal, parentTransactionHex: request.parentTransactionHex,
    payoutParticipantId: request.payoutParticipantId, payoutVout, unsignedTxHex: tx.toHex(),
    sourceObservation: request.sourceObservation, sponsorInput: sponsor, approval,
  });
  return { version: 2, protocol: PRESIGNED_PROTOCOL, kind: SPONSORED_PAYOUT_FEE_KIND, graphDigest: graph.digest,
    parentSpendProposalId: proposal.proposalId, parentSpendProposalDigest: proposal.digest, parentSpendKind: proposal.kind,
    payoutParticipantId: request.payoutParticipantId, payoutVout, approvalDigest, psbtBase64: psbt.toBase64(), unsignedTxid: tx.getId(),
    parentTxid: parent.txid, parentFeeSats: parent.feeSats, parentVsize: parent.vsize,
    payoutSats, sponsorChangeSats, childFeeSats: approval.childFeeSats, maximumChildVsize: preview.virtualSize() };
}

export function authorizePresignedSpendFeeChild(input: {
  request: PresignedSpendFeeRequest; psbtBase64: string; approvalDigest: string;
}): PresignedSpendFeeChild {
  const built = buildPresignedSpendFeeChild(input.request);
  hexBytes(input.approvalDigest, 32, 'spend fee approval digest');
  assert(input.approvalDigest === built.approvalDigest, 'spend fee approval digest changed');
  assertSponsoredFeePsbt(input.psbtBase64, built.psbtBase64, -1);
  return built;
}

/** Client-only selected payout key. No cooperative nonce or personal key needed. */
export function signPresignedSpendFeePayout(input: {
  request: PresignedSpendFeeRequest; psbtBase64: string; approvalDigest: string; keys: PresignedParticipantKeys;
}): { approvalDigest: string; payoutSignatureHex: string; payoutSignedPsbtBase64: string } {
  const built = authorizePresignedSpendFeeChild(input);
  assert(input.keys.participantId === built.payoutParticipantId, 'only the selected payout owner can authorize its spend fee child');
  const owner = input.request.graph.roster.participants.find(item => item.id === built.payoutParticipantId)!;
  const secret = Buffer.from(input.keys.payoutPrivateKey);
  let adjusted: Buffer | undefined;
  let tweaked: Buffer | undefined;
  try {
    assert(secret.length === 32 && ecc.isPrivate(secret), 'invalid spend fee payout private key');
    const point = Buffer.from(ecc.pointFromScalar(secret, true)!);
    assert(point.subarray(1).toString('hex') === owner.payoutXonlyPublicKeyHex, 'spend fee payout key differs from the approved owner');
    adjusted = Buffer.from(point[0] === 3 ? ecc.privateNegate(secret) : secret);
    const derived = ecc.privateAdd(adjusted, bitcoin.crypto.taggedHash('TapTweak', point.subarray(1)));
    assert(derived, 'invalid spend fee payout tweak');
    tweaked = Buffer.from(derived);
    const psbt = parseSponsoredFeePsbt(built.psbtBase64);
    const tx = sponsoredFeeUnsignedTransaction(psbt);
    const prevouts = spendFeePrevouts(input.request, built);
    const hash = tx.hashForWitnessV1(0, prevouts.map(coin => Buffer.from(coin.scriptPubKeyHex, 'hex')),
      prevouts.map(coin => BigInt(coin.valueSats)), bitcoin.Transaction.SIGHASH_DEFAULT);
    const signature = Buffer.from(ecc.signSchnorr(hash, tweaked));
    verifyNativeWalletWitness(tx, 0, prevouts, [signature]);
    psbt.updateInput(0, { tapKeySig: signature });
    return { approvalDigest: built.approvalDigest, payoutSignatureHex: signature.toString('hex'), payoutSignedPsbtBase64: psbt.toBase64() };
  } finally { secret.fill(0); adjusted?.fill(0); tweaked?.fill(0); }
}

export function finalizePresignedSpendFeeChild(input: {
  request: PresignedSpendFeeRequest; approvalDigest: string; payoutSignatureHex: string; sponsorSignedPsbtBase64: string;
}): PresignedSpendFeeChild & { transactionHex: string; txid: string; vsize: number; finalizationDigest: string } {
  const built = buildPresignedSpendFeeChild(input.request);
  assert(input.approvalDigest === built.approvalDigest, 'spend fee approval digest changed');
  const submitted = assertSponsoredFeePsbt(input.sponsorSignedPsbtBase64, built.psbtBase64, 1);
  const tx = sponsoredFeeUnsignedTransaction(parseSponsoredFeePsbt(built.psbtBase64));
  const prevouts = spendFeePrevouts(input.request, built);
  const payout = hexBytes(input.payoutSignatureHex, 64, 'SIGHASH_DEFAULT spend fee payout signature');
  verifyNativeWalletWitness(tx, 0, prevouts, [payout]);
  const sponsor = nativeWalletWitnessFromPsbt(submitted.data.inputs[1]!);
  verifyNativeWalletWitness(tx, 1, prevouts, sponsor);
  tx.setWitness(0, [payout]);
  tx.setWitness(1, sponsor);
  const vsize = tx.virtualSize();
  assert(tx.getId() === built.unsignedTxid && tx.version === FEE_TRUC_VERSION && vsize <= FEE_TRUC_MAX_CHILD_VSIZE,
    'spend fee witness changed the approved TRUC child');
  const approval = input.request.approval;
  assert(built.childFeeSats >= sponsoredFeeAtRate(vsize, approval.minRelayRateMillisatsPerVbyte), 'spend fee child is below the approved relay floor');
  assert(built.parentFeeSats + built.childFeeSats >= sponsoredFeeAtRate(built.parentVsize + vsize, approval.minRelayRateMillisatsPerVbyte), 'spend fee package is below the approved relay floor');
  assert(built.parentFeeSats + built.childFeeSats >= sponsoredFeeAtRate(built.parentVsize + vsize, approval.targetPackageRateMillisatsPerVbyte), 'spend fee child misses the approved package feerate');
  if (approval.replacement) {
    const previous = parseSponsoredFeeTransaction(approval.replacement.previousChildTransactionHex, 'previous spend fee child');
    const previousFee = input.request.sponsorInput.valueSats + built.payoutSats - sponsoredFeeOutputTotal(previous);
    assert(built.childFeeSats >= previousFee + sponsoredFeeAtRate(vsize, approval.replacement.incrementalRelayRateMillisatsPerVbyte),
      'spend fee replacement does not cover the approved incremental relay requirement');
    assert(BigInt(built.childFeeSats) * BigInt(previous.virtualSize()) > BigInt(previousFee) * BigInt(vsize), 'spend fee replacement feerate must strictly increase');
  }
  const transactionHex = tx.toHex();
  return { ...built, transactionHex, txid: tx.getId(), vsize,
    finalizationDigest: commitmentDigest('btc-multiplayer-vault/presigned-spend-fee-finalization/v1', { approvalDigest: built.approvalDigest, transactionHex }) };
}

function spendFeePrevouts(request: PresignedSpendFeeRequest, built: PresignedSpendFeeChild) {
  return [{ scriptPubKeyHex: payoutScript(request.graph.roster, built.payoutParticipantId).toString('hex'), valueSats: built.payoutSats },
    { scriptPubKeyHex: request.sponsorInput.scriptPubKeyHex, valueSats: request.sponsorInput.valueSats }];
}
