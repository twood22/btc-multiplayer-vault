import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { nonWitnessTransactionHex, psbtUnsignedTransaction, validatePresignedGraph } from './graph.js';
import type { AuthorizedPresignedTransaction } from './signing.js';
import { PRESIGNED_PROTOCOL, type ParticipantId, type PresignedGraph } from './types.js';
import { assert, commitmentDigest, exactKeys, networkParameters, participantId } from './validation.js';
import { hasWalletSignature, nativeWalletWitnessFromPsbt, verifyNativeWalletWitness } from './wallet.js';

export interface PresignedFundingSignature {
  version: 2;
  protocol: typeof PRESIGNED_PROTOCOL;
  graphDigest: string;
  participantId: ParticipantId;
  inputIndex: number;
  witness: string[];
}

export function authorizePresignedFundingSignedPsbt(input: {
  graph: PresignedGraph; participantId: ParticipantId; signedPsbtBase64: string;
  approvedGraphDigest: string;
}): PresignedFundingSignature {
  const graph = validatePresignedGraph(input.graph);
  assert(input.approvedGraphDigest === graph.digest, 'funding signature lacks exact graph approval');
  participantId(input.participantId);
  assert(typeof input.signedPsbtBase64 === 'string' && input.signedPsbtBase64.length > 0 && input.signedPsbtBase64.length <= 100_000, 'wallet funding PSBT too large or empty');
  const submitted = bitcoin.Psbt.fromBase64(input.signedPsbtBase64, { network: networkParameters(graph.roster.network) });
  const tx = psbtUnsignedTransaction(submitted);
  assert(tx.toHex() === graph.fundingUnsignedTxHex && tx.getId() === graph.fundingTxid, 'wallet changed frozen funding transaction');
  const index = graph.funding.inputs.findIndex(coin => coin.participantId === input.participantId);
  assert(index >= 0 && submitted.inputCount === 3, 'wallet signed unknown funding input');
  for (const [i, coin] of graph.funding.inputs.entries()) {
    const data = submitted.data.inputs[i]!;
    assert(data.witnessUtxo && data.witnessUtxo.value === BigInt(coin.valueSats) &&
      Buffer.from(data.witnessUtxo.script).toString('hex') === coin.scriptPubKeyHex, 'wallet changed funding witness prevout');
    assert(tx.ins[i]!.script.length === 0, 'funding input must remain native SegWit');
    if (i !== index) assert(!hasWalletSignature(data), 'wallet supplied another participant signature');
  }
  const witness = nativeWalletWitnessFromPsbt(submitted.data.inputs[index]!);
  verifyNativeWalletWitness(tx, index, graph.funding.inputs, witness);
  return { version: 2, protocol: PRESIGNED_PROTOCOL, graphDigest: graph.digest,
    participantId: input.participantId, inputIndex: index, witness: witness.map(item => item.toString('hex')) };
}

export function verifyPresignedFundingSignature(graphInput: PresignedGraph, contribution: PresignedFundingSignature): PresignedFundingSignature {
  const graph = validatePresignedGraph(graphInput);
  exactKeys(contribution, ['version', 'protocol', 'graphDigest', 'participantId', 'inputIndex', 'witness'], 'funding signature');
  assert(contribution.version === 2 && contribution.protocol === PRESIGNED_PROTOCOL && contribution.graphDigest === graph.digest, 'funding signature has wrong protocol or graph');
  participantId(contribution.participantId);
  const index = graph.funding.inputs.findIndex(coin => coin.participantId === contribution.participantId);
  assert(index >= 0 && index === contribution.inputIndex, 'funding signature has wrong input');
  assert(Array.isArray(contribution.witness) && contribution.witness.length >= 1 && contribution.witness.length <= 2 &&
    contribution.witness.every(item => typeof item === 'string' && item.length <= 146 && /^(?:[0-9a-f]{2})+$/u.test(item)), 'malformed funding witness');
  const witness = contribution.witness.map(item => Buffer.from(item, 'hex'));
  verifyNativeWalletWitness(bitcoin.Transaction.fromHex(graph.fundingUnsignedTxHex), index, graph.funding.inputs, witness);
  return { ...contribution, witness: [...contribution.witness] };
}

export function finalizePresignedFunding(input: {
  graph: PresignedGraph; signatures: PresignedFundingSignature[];
}): AuthorizedPresignedTransaction & { finalizationDigest: string } {
  const graph = validatePresignedGraph(input.graph);
  assert(Array.isArray(input.signatures) && input.signatures.length === 3, 'funding needs three wallet signatures');
  const verified = input.signatures.map(signature => verifyPresignedFundingSignature(graph, signature));
  assert(new Set(verified.map(signature => signature.inputIndex)).size === 3, 'funding repeats a wallet signature');
  const tx = bitcoin.Transaction.fromHex(graph.fundingUnsignedTxHex);
  verified.forEach(signature => tx.setWitness(signature.inputIndex, signature.witness.map(item => Buffer.from(item, 'hex'))));
  const authorized = authorizePresignedFundingTransaction({ graph, transactionHex: tx.toHex() });
  return { ...authorized, finalizationDigest: commitmentDigest('vault/presigned-graph-v2/funding-finalization', {
    protocol: PRESIGNED_PROTOCOL, graphDigest: graph.digest, ...authorized,
  }) };
}

/** Strict client import/submission validator. Confirmed observation uses observed.ts instead. */
export function authorizePresignedFundingTransaction(input: {
  graph: PresignedGraph; transactionHex: string;
}): AuthorizedPresignedTransaction {
  const graph = validatePresignedGraph(input.graph);
  assert(typeof input.transactionHex === 'string' && input.transactionHex.length <= 100_000 && /^(?:[0-9a-f]{2})+$/u.test(input.transactionHex), 'malformed funding transaction');
  const tx = bitcoin.Transaction.fromHex(input.transactionHex);
  assert(nonWitnessTransactionHex(tx) === graph.fundingUnsignedTxHex && tx.getId() === graph.fundingTxid, 'funding changed immutable transaction');
  tx.ins.forEach((coin, index) => verifyNativeWalletWitness(tx, index, graph.funding.inputs, coin.witness));
  const feeSats = graph.funding.inputs.reduce((sum, coin) => sum + coin.valueSats, 0) - tx.outs.reduce((sum, output) => sum + Number(output.value), 0);
  assert(feeSats === graph.funding.feeSats, 'funding fee changed');
  assert(feeSats >= tx.virtualSize(), 'funding fee below conservative 1 sat/vB floor');
  return { transactionHex: tx.toHex(), txid: tx.getId(), feeSats, vsize: tx.virtualSize() };
}
