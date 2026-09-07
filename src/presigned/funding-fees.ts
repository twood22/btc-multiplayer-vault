import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { authorizePresignedFundingTransaction } from './funding.js';
import { fundingFeeShare, validatePresignedGraph } from './graph.js';
import { PRESIGNED_PROTOCOL, type ParticipantId, type PresignedGraph } from './types.js';
import { assert, commitmentDigest, exactKeys, hexBytes, networkParameters, participantId, safeInteger, supportedWalletScript } from './validation.js';
import { nativeWalletWitnessFromPsbt, verifyNativeWalletWitness } from './wallet.js';
import {
  FEE_MONEY_MAX, FEE_CHILD_SEQUENCE, FEE_TRUC_VERSION, FEE_TRUC_MAX_PARENT_VSIZE, FEE_TRUC_MAX_CHILD_VSIZE,
  SPONSORED_PAYOUT_FEE_KIND, validateFeeCoinObservation, assertFeeCoinMatches,
  parseSponsoredFeePsbt, parseSponsoredFeeTransaction, sponsoredFeeUnsignedTransaction,
  sponsoredFeeOutputTotal, validateSponsoredFeeRate, sponsoredFeeAtRate, sponsoredFeeDustFloor,
  type FeeCoinObservation, type PresignedFeeApproval, type PresignedFeeChild,
} from './fees.js';

export type PresignedFundingFeeRole = 'change' | 'sponsor';

export interface PresignedFundingFeeRequest {
  graph: PresignedGraph;
  fundingTransactionHex: string;
  changeParticipantId: ParticipantId;
  /** Canonical funding-input order; independently checked active-chain observations. */
  fundingInputObservations: FeeCoinObservation[];
  sponsorInput: FeeCoinObservation;
  approval: PresignedFeeApproval;
}

export interface PresignedFundingFeeChild extends Omit<PresignedFeeChild, 'exitId' | 'payoutSats'> {
  changeParticipantId: ParticipantId;
  changeVout: number;
  changeSats: number;
  changeScriptPubKeyHex: string;
}

/** Public verified witness contribution, never a wallet private key or participant root. */
export interface PresignedFundingFeeSignature {
  version: 2;
  protocol: typeof PRESIGNED_PROTOCOL;
  graphDigest: string;
  approvalDigest: string;
  changeParticipantId: ParticipantId;
  role: PresignedFundingFeeRole;
  inputIndex: 0 | 1;
  witness: string[];
}

/**
 * The funding parent has three confirmed inputs and three mandatory owner
 * refunds. A volunteer spends only its own refund; a separately confirmed
 * external sponsor pays the entire child fee. The vault output is untouched.
 * Observation truth, freshness and actual package/replacement policy remain
 * the runtime caller's obligation, not something a JSON assertion can prove.
 */
export function buildPresignedFundingFeeChild(request: PresignedFundingFeeRequest): PresignedFundingFeeChild {
  exactKeys(request, ['graph', 'fundingTransactionHex', 'changeParticipantId', 'fundingInputObservations', 'sponsorInput', 'approval'], 'funding fee request');
  const graph = validatePresignedGraph(request.graph);
  assert(graph.roster.feePolicy.kind === SPONSORED_PAYOUT_FEE_KIND, 'funding fee request does not commit the TRUC fee policy');
  participantId(request.changeParticipantId);
  assert(Array.isArray(request.fundingInputObservations) && request.fundingInputObservations.length === 3, 'funding fee requires three confirmed input observations');
  request.fundingInputObservations.forEach((observation, index) => {
    validateFeeCoinObservation(observation, graph, `funding input ${index}`);
    assertFeeCoinMatches(observation, graph.funding.inputs[index]!, `confirmed funding input ${index}`);
  });
  const parent = authorizePresignedFundingTransaction({ graph, transactionHex: request.fundingTransactionHex });
  const parentTx = parseSponsoredFeeTransaction(parent.transactionHex, 'funding fee parent');
  assert(parentTx.version === FEE_TRUC_VERSION && parentTx.ins.length === 3 && parentTx.outs.length === 4 && parent.vsize <= FEE_TRUC_MAX_PARENT_VSIZE,
    'funding fee parent must be bounded TRUC funding with all three owner refunds');
  const ownerIndex = graph.funding.inputs.findIndex(coin => coin.participantId === request.changeParticipantId);
  assert(ownerIndex >= 0, 'funding fee volunteer is not a funding participant');
  const ownerInput = graph.funding.inputs[ownerIndex]!;
  const changeVout = ownerIndex + 1;
  const changeSats = ownerInput.valueSats - graph.roster.economics.depositSatsPerParticipant - fundingFeeShare(graph.funding.feeSats, ownerIndex);
  const changeScriptPubKeyHex = ownerInput.scriptPubKeyHex;
  assert(ownerInput.changeScriptPubKeyHex === changeScriptPubKeyHex && supportedWalletScript(changeScriptPubKeyHex),
    'funding refund must return to its proven funding-input wallet');
  safeInteger(changeSats, sponsoredFeeDustFloor(changeScriptPubKeyHex), FEE_MONEY_MAX, 'funding refund');
  const change = parentTx.outs[changeVout]!;
  assert(Number(change.value) === changeSats && Buffer.from(change.script).toString('hex') === changeScriptPubKeyHex,
    'funding refund differs from its approved owner, index, script or value');

  const sponsor = request.sponsorInput;
  validateFeeCoinObservation(sponsor, graph, 'funding fee sponsor');
  assert(supportedWalletScript(sponsor.scriptPubKeyHex), 'funding fee sponsor must be native P2WPKH or key-path P2TR');
  assert(!graph.rounds.some(round => round.outputScriptHex === sponsor.scriptPubKeyHex), 'a vault cannot sponsor funding fees');
  assert(sponsor.txid !== graph.fundingTxid && !graph.exits.some(exit => exit.txid === sponsor.txid), 'funding sponsor must be outside every funding and graph output');
  assert(!graph.funding.inputs.some(coin => coin.txid === sponsor.txid && coin.vout === sponsor.vout), 'funding sponsor must not repeat a funding input');
  safeInteger(changeSats + sponsor.valueSats, 1, FEE_MONEY_MAX, 'funding fee child input total');
  const approval = request.approval;
  exactKeys(approval, ['childFeeSats', 'maxChildFeeSats', 'targetPackageRateMillisatsPerVbyte', 'minRelayRateMillisatsPerVbyte', 'sponsorChangeScriptPubKeyHex', 'approveExactNoChangeFee', 'replacement'], 'funding fee approval');
  safeInteger(approval.maxChildFeeSats, 1, graph.roster.feePolicy.maxChildFeeSats, 'funding fee cap');
  safeInteger(approval.childFeeSats, 1, approval.maxChildFeeSats, 'funding child fee');
  validateSponsoredFeeRate(approval.targetPackageRateMillisatsPerVbyte, 'funding target package feerate');
  validateSponsoredFeeRate(approval.minRelayRateMillisatsPerVbyte, 'funding minimum relay feerate');
  assert(typeof approval.approveExactNoChangeFee === 'boolean', 'funding no-change fee approval is not boolean');
  const sponsorChangeSats = sponsor.valueSats - approval.childFeeSats;
  assert(sponsorChangeSats >= 0, 'funding sponsor cannot cover the exact child fee');
  if (sponsorChangeSats === 0) {
    assert(approval.sponsorChangeScriptPubKeyHex === null && approval.approveExactNoChangeFee, 'exact funding no-change fee requires explicit approval');
  } else {
    assert(!approval.approveExactNoChangeFee && approval.sponsorChangeScriptPubKeyHex !== null, 'nonzero funding sponsor change must be preserved');
    assert(supportedWalletScript(approval.sponsorChangeScriptPubKeyHex), 'funding sponsor change must be native P2WPKH or key-path P2TR');
    assert(!graph.rounds.some(round => round.outputScriptHex === approval.sponsorChangeScriptPubKeyHex), 'funding sponsor change cannot recreate a vault output');
    assert(sponsorChangeSats >= sponsoredFeeDustFloor(approval.sponsorChangeScriptPubKeyHex), 'funding sponsor change is dust');
  }
  if (approval.replacement !== null) {
    exactKeys(approval.replacement, ['previousChildTransactionHex', 'incrementalRelayRateMillisatsPerVbyte'], 'funding fee replacement');
    validateSponsoredFeeRate(approval.replacement.incrementalRelayRateMillisatsPerVbyte, 'funding incremental relay rate');
  }
  const psbt = new bitcoin.Psbt({ network: networkParameters(graph.roster.network) });
  psbt.setVersion(FEE_TRUC_VERSION);
  psbt.setLocktime(0);
  psbt.addInput({ hash: parent.txid, index: changeVout, sequence: FEE_CHILD_SEQUENCE,
    witnessUtxo: { script: Buffer.from(changeScriptPubKeyHex, 'hex'), value: BigInt(changeSats) } });
  psbt.addInput({ hash: sponsor.txid, index: sponsor.vout, sequence: FEE_CHILD_SEQUENCE,
    witnessUtxo: { script: Buffer.from(sponsor.scriptPubKeyHex, 'hex'), value: BigInt(sponsor.valueSats) } });
  psbt.addOutput({ script: Buffer.from(changeScriptPubKeyHex, 'hex'), value: BigInt(changeSats) });
  if (sponsorChangeSats) psbt.addOutput({ script: Buffer.from(approval.sponsorChangeScriptPubKeyHex!, 'hex'), value: BigInt(sponsorChangeSats) });
  const tx = sponsoredFeeUnsignedTransaction(psbt);
  if (approval.replacement) verifyPriorFundingFeeChild(request, tx, changeScriptPubKeyHex, changeSats);
  const preview = tx.clone();
  [changeScriptPubKeyHex, sponsor.scriptPubKeyHex].forEach((script, index) =>
    preview.setWitness(index, script.startsWith('0014') ? [Buffer.alloc(73), Buffer.alloc(33)] : [Buffer.alloc(65)]));
  assert(preview.virtualSize() <= FEE_TRUC_MAX_CHILD_VSIZE, 'funding fee child exceeds the TRUC descendant size limit');
  const approvalDigest = commitmentDigest('btc-multiplayer-vault/presigned-funding-fee-approval/v1', {
    protocol: PRESIGNED_PROTOCOL, kind: SPONSORED_PAYOUT_FEE_KIND, graphDigest: graph.digest,
    fundingTransactionHex: request.fundingTransactionHex, changeParticipantId: request.changeParticipantId,
    changeVout, unsignedTxHex: tx.toHex(), fundingInputObservations: request.fundingInputObservations,
    sponsorInput: sponsor, approval,
  });
  return { version: 2, protocol: PRESIGNED_PROTOCOL, kind: SPONSORED_PAYOUT_FEE_KIND, graphDigest: graph.digest,
    changeParticipantId: request.changeParticipantId, changeVout, changeSats, changeScriptPubKeyHex,
    approvalDigest, psbtBase64: psbt.toBase64(), unsignedTxid: tx.getId(), parentTxid: parent.txid,
    parentFeeSats: parent.feeSats, parentVsize: parent.vsize, sponsorChangeSats,
    childFeeSats: approval.childFeeSats, maximumChildVsize: preview.virtualSize() };
}

export function authorizePresignedFundingFeeChild(input: {
  request: PresignedFundingFeeRequest; psbtBase64: string; approvalDigest: string;
}): PresignedFundingFeeChild {
  const built = approvedChild(input.request, input.approvalDigest);
  strictFundingFeePsbt(input.psbtBase64, built.psbtBase64, -1);
  return built;
}

/** Each external wallet contributes exactly its role's input, never the other signature. */
export function authorizePresignedFundingFeeSignedPsbt(input: {
  request: PresignedFundingFeeRequest; role: PresignedFundingFeeRole; signedPsbtBase64: string; approvalDigest: string;
}): PresignedFundingFeeSignature {
  return authorizePresignedFundingFeeWalletPsbt({ request: input.request, roles: [input.role],
    signedPsbtBase64: input.signedPsbtBase64, approvalDigest: input.approvalDigest })[0]!;
}

/** A wallet owning both coins may explicitly approve both roles, never implicitly. */
export function authorizePresignedFundingFeeWalletPsbt(input: {
  request: PresignedFundingFeeRequest; roles: PresignedFundingFeeRole[]; signedPsbtBase64: string; approvalDigest: string;
}): PresignedFundingFeeSignature[] {
  const built = approvedChild(input.request, input.approvalDigest);
  assert(Array.isArray(input.roles) && input.roles.length >= 1 && input.roles.length <= 2 && new Set(input.roles).size === input.roles.length,
    'funding fee wallet must explicitly approve one or both distinct roles');
  const indexes = input.roles.map(roleIndex);
  const submitted = strictFundingFeePsbt(input.signedPsbtBase64, built.psbtBase64, indexes.length === 2 ? 'both' : indexes[0]!);
  const tx = sponsoredFeeUnsignedTransaction(parseSponsoredFeePsbt(built.psbtBase64));
  return input.roles.map((role, index) => {
    const inputIndex = indexes[index]!;
    const witness = nativeWalletWitnessFromPsbt(submitted.data.inputs[inputIndex]!);
    verifyNativeWalletWitness(tx, inputIndex, fundingFeePrevouts(input.request, built), witness);
    return { version: 2, protocol: PRESIGNED_PROTOCOL, graphDigest: built.graphDigest, approvalDigest: built.approvalDigest,
      changeParticipantId: built.changeParticipantId, role, inputIndex, witness: witness.map(item => item.toString('hex')) };
  });
}

export function verifyPresignedFundingFeeSignature(input: {
  request: PresignedFundingFeeRequest; approvalDigest: string; signature: PresignedFundingFeeSignature;
}): PresignedFundingFeeSignature {
  const built = approvedChild(input.request, input.approvalDigest);
  const signature = input.signature;
  exactKeys(signature, ['version', 'protocol', 'graphDigest', 'approvalDigest', 'changeParticipantId', 'role', 'inputIndex', 'witness'], 'funding fee signature');
  assert(signature.version === 2 && signature.protocol === PRESIGNED_PROTOCOL && signature.graphDigest === built.graphDigest &&
    signature.approvalDigest === built.approvalDigest && signature.changeParticipantId === built.changeParticipantId,
  'funding fee signature differs from its exact approval');
  const inputIndex = roleIndex(signature.role);
  assert(signature.inputIndex === inputIndex, 'funding fee signature names the wrong input');
  assert(Array.isArray(signature.witness) && signature.witness.length >= 1 && signature.witness.length <= 2 &&
    signature.witness.every(item => typeof item === 'string' && item.length <= 146 && /^(?:[0-9a-f]{2})+$/u.test(item)), 'malformed funding fee witness');
  const tx = sponsoredFeeUnsignedTransaction(parseSponsoredFeePsbt(built.psbtBase64));
  verifyNativeWalletWitness(tx, inputIndex, fundingFeePrevouts(input.request, built), signature.witness.map(item => Buffer.from(item, 'hex')));
  return { ...signature, witness: [...signature.witness] };
}

export function finalizePresignedFundingFeeChild(input: {
  request: PresignedFundingFeeRequest; approvalDigest: string; signatures: PresignedFundingFeeSignature[];
}): PresignedFundingFeeChild & { transactionHex: string; txid: string; vsize: number; finalizationDigest: string } {
  const built = approvedChild(input.request, input.approvalDigest);
  assert(Array.isArray(input.signatures) && input.signatures.length === 2, 'funding fee needs both external wallet signatures');
  const verified = input.signatures.map(signature => verifyPresignedFundingFeeSignature({ request: input.request, approvalDigest: built.approvalDigest, signature }));
  assert(new Set(verified.map(signature => signature.inputIndex)).size === 2, 'funding fee repeats a wallet signature');
  const tx = sponsoredFeeUnsignedTransaction(parseSponsoredFeePsbt(built.psbtBase64));
  verified.forEach(signature => tx.setWitness(signature.inputIndex, signature.witness.map(item => Buffer.from(item, 'hex'))));
  const vsize = tx.virtualSize();
  assert(tx.getId() === built.unsignedTxid && tx.version === FEE_TRUC_VERSION && vsize <= FEE_TRUC_MAX_CHILD_VSIZE,
    'funding fee witness changed the approved TRUC child');
  const approval = input.request.approval;
  assert(built.childFeeSats >= sponsoredFeeAtRate(vsize, approval.minRelayRateMillisatsPerVbyte), 'funding fee child is below the approved relay floor');
  assert(built.parentFeeSats + built.childFeeSats >= sponsoredFeeAtRate(built.parentVsize + vsize, approval.minRelayRateMillisatsPerVbyte), 'funding fee package is below the approved relay floor');
  assert(built.parentFeeSats + built.childFeeSats >= sponsoredFeeAtRate(built.parentVsize + vsize, approval.targetPackageRateMillisatsPerVbyte), 'funding fee child misses the approved package feerate');
  if (approval.replacement) {
    const previous = parseSponsoredFeeTransaction(approval.replacement.previousChildTransactionHex, 'previous funding fee child');
    const previousFee = input.request.sponsorInput.valueSats + built.changeSats - sponsoredFeeOutputTotal(previous);
    assert(built.childFeeSats >= previousFee + sponsoredFeeAtRate(vsize, approval.replacement.incrementalRelayRateMillisatsPerVbyte),
      'funding fee replacement does not cover the approved incremental relay requirement');
    assert(BigInt(built.childFeeSats) * BigInt(previous.virtualSize()) > BigInt(previousFee) * BigInt(vsize), 'funding fee replacement feerate must strictly increase');
  }
  const transactionHex = tx.toHex();
  return { ...built, transactionHex, txid: tx.getId(), vsize,
    finalizationDigest: commitmentDigest('btc-multiplayer-vault/presigned-funding-fee-finalization/v1', { approvalDigest: built.approvalDigest, transactionHex }) };
}

function approvedChild(request: PresignedFundingFeeRequest, approvalDigest: string): PresignedFundingFeeChild {
  const built = buildPresignedFundingFeeChild(request);
  hexBytes(approvalDigest, 32, 'funding fee approval digest');
  assert(approvalDigest === built.approvalDigest, 'funding fee approval digest changed');
  return built;
}

function roleIndex(role: PresignedFundingFeeRole): 0 | 1 {
  assert(role === 'change' || role === 'sponsor', 'unknown funding fee wallet role');
  return role === 'change' ? 0 : 1;
}

function fundingFeePrevouts(request: PresignedFundingFeeRequest, built: PresignedFundingFeeChild) {
  return [{ scriptPubKeyHex: built.changeScriptPubKeyHex, valueSats: built.changeSats },
    { scriptPubKeyHex: request.sponsorInput.scriptPubKeyHex, valueSats: request.sponsorInput.valueSats }];
}

function verifyPriorFundingFeeChild(request: PresignedFundingFeeRequest, candidate: bitcoin.Transaction, script: string, changeSats: number): void {
  const previous = parseSponsoredFeeTransaction(request.approval.replacement!.previousChildTransactionHex, 'previous funding fee child');
  assert(previous.version === FEE_TRUC_VERSION && previous.locktime === 0 && previous.ins.length === 2 && previous.virtualSize() <= FEE_TRUC_MAX_CHILD_VSIZE,
    'previous funding fee child has invalid TRUC shape');
  for (let index = 0; index < 2; index++) {
    const before = previous.ins[index]!;
    const after = candidate.ins[index]!;
    assert(Buffer.from(before.hash).equals(Buffer.from(after.hash)) && before.index === after.index && before.sequence === FEE_CHILD_SEQUENCE && before.script.length === 0,
      'funding replacement must retain exact refund and sponsor inputs');
  }
  assert(previous.outs.length === 1 || previous.outs.length === 2, 'previous funding fee child has unexpected outputs');
  assert(Number(previous.outs[0]!.value) === changeSats && Buffer.from(previous.outs[0]!.script).toString('hex') === script, 'previous funding child did not preserve the entire refund');
  if (previous.outs.length === 2) assert(request.approval.sponsorChangeScriptPubKeyHex !== null &&
    Buffer.from(previous.outs[1]!.script).toString('hex') === request.approval.sponsorChangeScriptPubKeyHex, 'funding replacement changed sponsor change destination');
  const previousFee = changeSats + request.sponsorInput.valueSats - sponsoredFeeOutputTotal(previous);
  safeInteger(previousFee, 1, request.graph.roster.feePolicy.maxChildFeeSats, 'previous funding child fee');
  assert(previous.outs.length === 2 || previousFee === request.sponsorInput.valueSats, 'previous funding no-change child has an invalid fee');
  const prevouts = [{ scriptPubKeyHex: script, valueSats: changeSats }, { scriptPubKeyHex: request.sponsorInput.scriptPubKeyHex, valueSats: request.sponsorInput.valueSats }];
  for (let index = 0; index < 2; index++) verifyNativeWalletWitness(previous, index, prevouts, previous.ins[index]!.witness);
}

/** Benign wallet hints are discarded; only exact unsigned bytes and valid native witnesses survive. */
function strictFundingFeePsbt(base64: string, canonicalBase64: string, signedInput: -1 | 0 | 1 | 'both'): bitcoin.Psbt {
  const submitted = parseSponsoredFeePsbt(base64);
  const canonical = parseSponsoredFeePsbt(canonicalBase64);
  const tx = sponsoredFeeUnsignedTransaction(canonical);
  assert(sponsoredFeeUnsignedTransaction(submitted).toHex() === tx.toHex(), 'funding fee PSBT differs from the approved transaction');
  assert(submitted.data.inputs.length === 2 && submitted.data.outputs.length === canonical.data.outputs.length, 'funding fee PSBT shape changed');
  for (const [key, value] of Object.entries(submitted.data.globalMap)) assert(key === 'unsignedTx' || key === 'unknownKeyVals' && Array.isArray(value) && value.length === 0,
    'funding fee PSBT has unexpected global metadata');
  submitted.data.outputs.forEach(output => {
    for (const [key, value] of Object.entries(output)) {
      if (key === 'unknownKeyVals' && Array.isArray(value) && value.length === 0) continue;
      assert(signedInput !== -1 && walletHint(key, value), 'funding fee PSBT has unexpected output metadata');
    }
  });
  submitted.data.inputs.forEach((data, index) => {
    const expected = canonical.data.inputs[index]!.witnessUtxo!;
    assert(data.witnessUtxo && data.witnessUtxo.value === expected.value && Buffer.from(data.witnessUtxo.script).equals(Buffer.from(expected.script)),
      'funding fee PSBT changed an approved prevout');
    for (const [key, value] of Object.entries(data)) {
      if (key === 'witnessUtxo' || key === 'unknownKeyVals' && Array.isArray(value) && value.length === 0) continue;
      if (signedInput !== -1 && key === 'sighashType') {
        assert(value === bitcoin.Transaction.SIGHASH_ALL || expected.script[0] === 0x51 && value === bitcoin.Transaction.SIGHASH_DEFAULT,
          'funding fee wallet hash type must commit all inputs and outputs');
        continue;
      }
      if (signedInput !== -1 && key === 'nonWitnessUtxo') {
        assert(value instanceof Uint8Array && value.length > 0, 'invalid funding fee wallet previous transaction');
        const previous = bitcoin.Transaction.fromBuffer(value);
        assert(Buffer.from(previous.toBuffer()).equals(Buffer.from(value)), 'funding fee wallet previous transaction is not canonical');
        const spent = tx.ins[index]!;
        const output = previous.outs[spent.index];
        assert(previous.getId() === Buffer.from(spent.hash).reverse().toString('hex') && output && output.value === expected.value &&
          Buffer.from(output.script).equals(Buffer.from(expected.script)), 'funding fee wallet previous transaction differs from its approved prevout');
        continue;
      }
      if (signedInput !== -1 && walletHint(key, value)) continue;
      assert((index === signedInput || signedInput === 'both') && ['partialSig', 'tapKeySig', 'finalScriptWitness'].includes(key), 'funding fee PSBT includes scripts, unsupported metadata or another role signature');
    }
  });
  return submitted;
}

function walletHint(key: string, value: unknown): boolean {
  if (key === 'tapInternalKey') return value instanceof Uint8Array && value.length === 32;
  if (key === 'bip32Derivation') return Array.isArray(value) && value.length <= 4;
  if (key === 'tapBip32Derivation') return Array.isArray(value) && value.length <= 4 && value.every(entry => entry &&
    typeof entry === 'object' && Array.isArray(entry.leafHashes) && entry.leafHashes.length === 0);
  return false;
}
