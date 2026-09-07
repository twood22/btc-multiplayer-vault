import * as bitcoin from 'bitcoinjs-lib';
import type { PresignedBlockObservation, PresignedChainTip } from './chain.js';
import { nonWitnessTransactionHex, validatePresignedGraph } from './graph.js';
import { PRESIGNED_PROTOCOL, type PresignedGraph } from './types.js';
import { assert, exactKeys, hexBytes, safeInteger } from './validation.js';

/** Resource bound at block-consensus scale, not the stricter send-policy cap. */
export const MAX_PRESIGNED_OBSERVED_TRANSACTION_HEX_LENGTH = 8_000_000;

/**
 * SERVER OBSERVATION ONLY. These fields are NOT a proof of Bitcoin consensus.
 * The caller must obtain them from its private fully validating Core node,
 * independently check the active block, and bracket the complete lookup with a
 * stable tip. Never deserialize this authority from an HTTP request, portable
 * kit, database snapshot, mempool notification or a supplied "verified" flag.
 */
export interface PresignedConfirmedCoreEvidence {
  transaction: { txid: string; transactionHex: string; blockHash: string };
  activeBlock: Extract<PresignedBlockObservation, { kind: 'active' }>;
  tip: PresignedChainTip;
}

/** Intentionally not an AuthorizedPresignedTransaction or broadcast artifact. */
export interface PresignedConfirmedTransactionRecognition {
  version: 2;
  protocol: typeof PRESIGNED_PROTOCOL;
  kind: 'confirmed-graph-observation';
  graphDigest: string;
  txid: string;
  exitId: string | null;
  feeSats: number;
  vsize: number;
  blockHash: string;
  height: number;
  confirmations: number;
}

/**
 * Match immutable economics AFTER trusted active inclusion, without applying
 * wallet/relay policy to mined witnesses. Core, not this function, validates
 * ECDSA/Schnorr, annexes, script paths, sighash flags and all consensus rules.
 * Required application confirmation depth remains the reconciler's decision.
 */
export function recognizeConfirmedPresignedFundingTransaction(input: {
  graph: PresignedGraph;
} & PresignedConfirmedCoreEvidence): PresignedConfirmedTransactionRecognition {
  exactKeys(input, ['graph', 'transaction', 'activeBlock', 'tip'], 'confirmed funding recognition');
  const graph = validatePresignedGraph(input.graph);
  const tx = confirmedTransaction(graph, input);
  assert(tx.getId() === graph.fundingTxid && nonWitnessTransactionHex(tx) === graph.fundingUnsignedTxHex,
    'observed funding changed the immutable transaction');
  const inputValue = graph.funding.inputs.reduce((sum, coin) => sum + BigInt(coin.valueSats), 0n);
  const fee = inputValue - tx.outs.reduce((sum, output) => sum + output.value, 0n);
  assert(fee === BigInt(graph.funding.feeSats), 'observed funding changed committed economics');
  return recognition(graph, input, tx, null, Number(fee));
}

/** Same confirmed-Core trust contract as funding; never authorize an exit send. */
export function recognizeConfirmedPresignedExitTransaction(input: {
  graph: PresignedGraph; exitId: string;
} & PresignedConfirmedCoreEvidence): PresignedConfirmedTransactionRecognition {
  exactKeys(input, ['graph', 'exitId', 'transaction', 'activeBlock', 'tip'], 'confirmed exit recognition');
  const graph = validatePresignedGraph(input.graph);
  const exit = graph.exits.find(item => item.id === input.exitId);
  assert(exit, 'observed transaction names an unknown exit');
  const tx = confirmedTransaction(graph, input);
  assert(tx.getId() === exit.txid && nonWitnessTransactionHex(tx) === exit.unsignedTxHex,
    'observed exit changed the immutable transaction');
  const fee = BigInt(exit.inputValueSats) - tx.outs.reduce((sum, output) => sum + output.value, 0n);
  assert(fee === BigInt(exit.feeSats), 'observed exit changed committed economics');
  return recognition(graph, input, tx, exit.id, Number(fee));
}

function confirmedTransaction(graph: PresignedGraph, evidence: PresignedConfirmedCoreEvidence): bitcoin.Transaction {
  const { transaction, activeBlock, tip } = evidence;
  exactKeys(transaction, ['txid', 'transactionHex', 'blockHash'], 'confirmed transaction evidence');
  exactKeys(activeBlock, ['kind', 'hash', 'height', 'confirmations'], 'active confirmation block');
  exactKeys(tip, ['network', 'genesisHash', 'hash', 'height'], 'confirmation tip');
  assert(tip.network === graph.roster.network && tip.genesisHash === graph.roster.genesisHash,
    'confirmation evidence belongs to another network');
  hexBytes(transaction.txid, 32, 'confirmed transaction id');
  hexBytes(transaction.blockHash, 32, 'confirmed transaction block');
  hexBytes(activeBlock.hash, 32, 'active block hash');
  hexBytes(tip.hash, 32, 'confirmation tip hash');
  safeInteger(tip.height, 1, 2_000_000_000, 'confirmation tip height');
  safeInteger(activeBlock.height, 1, tip.height, 'active block height');
  assert(activeBlock.kind === 'active' && transaction.blockHash === activeBlock.hash,
    'transaction lacks an independently active confirmation block');
  assert(activeBlock.confirmations === tip.height - activeBlock.height + 1 &&
    (activeBlock.height !== tip.height || activeBlock.hash === tip.hash), 'active block differs from the stable tip');
  assert(typeof transaction.transactionHex === 'string' && transaction.transactionHex.length <= MAX_PRESIGNED_OBSERVED_TRANSACTION_HEX_LENGTH &&
    transaction.transactionHex.length % 2 === 0 && /^[0-9a-f]+$/u.test(transaction.transactionHex), 'malformed or oversized confirmed transaction');
  const tx = bitcoin.Transaction.fromHex(transaction.transactionHex);
  assert(tx.toHex() === transaction.transactionHex && tx.getId() === transaction.txid,
    'confirmed transaction serialization or id changed');
  assert(tx.weight() <= 4_000_000, 'confirmed transaction exceeds the block weight bound');
  return tx;
}

function recognition(graph: PresignedGraph, evidence: PresignedConfirmedCoreEvidence, tx: bitcoin.Transaction,
  exitId: string | null, feeSats: number): PresignedConfirmedTransactionRecognition {
  return { version: 2, protocol: PRESIGNED_PROTOCOL, kind: 'confirmed-graph-observation',
    graphDigest: graph.digest, txid: tx.getId(), exitId, feeSats, vsize: tx.virtualSize(),
    blockHash: evidence.activeBlock.hash, height: evidence.activeBlock.height,
    confirmations: evidence.activeBlock.confirmations };
}
