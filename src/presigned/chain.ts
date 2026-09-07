import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { validatePresignedGraph } from './graph.js';
import { recognizeConfirmedPresignedExitTransaction, recognizeConfirmedPresignedFundingTransaction } from './observed.js';
import { PRESIGNED_PROTOCOL, type ParticipantId, type PresignedGraph, type RoundId } from './types.js';
import { assert, canonicalJson, hexBytes, safeInteger } from './validation.js';

export interface PresignedChainTip {
  network: PresignedGraph['roster']['network'];
  genesisHash: string;
  hash: string;
  height: number;
}

/** `absent` means a successful authoritative lookup, never an RPC error. */
export type PresignedTransactionObservation =
  | { kind: 'present'; txid: string; transactionHex: string; blockHash: string | null }
  | { kind: 'absent'; txid: string }
  | { kind: 'unknown'; txid: string };

/** Obtain independently from the block backend, not transaction confirmations. */
export type PresignedBlockObservation =
  | { kind: 'active'; hash: string; height: number; confirmations: number }
  | { kind: 'inactive'; hash: string; height: number }
  | { kind: 'unknown'; hash: string };

/**
 * Private fully validating Core reads, not an arbitrary explorer or user proof.
 * This operational trust contract cannot be established by a JSON status flag.
 */
export interface PresignedChainBackend {
  getTip(): Promise<PresignedChainTip>;
  getTransaction(txid: string): Promise<PresignedTransactionObservation>;
  getBlock(hash: string): Promise<PresignedBlockObservation>;
}

/** In-process trusted collector output; never accept a client/DB snapshot here. */
export type PresignedChainView =
  | { kind: 'snapshot'; graphDigest: string; tip: PresignedChainTip;
      transactions: PresignedTransactionObservation[]; blocks: PresignedBlockObservation[] }
  | { kind: 'unknown'; reason: 'backend-error' | 'tip-changed' | 'invalid-backend-evidence' };

export interface PresignedGraphConfirmation {
  txid: string;
  /** Null identifies funding; exit IDs identify the remaining two transitions. */
  exitId: string | null;
  blockHash: string;
  height: number;
}

/** Confirmed graph projection only; not an assertion that its output is unspent. */
export interface PresignedGraphChainState {
  version: 2;
  protocol: typeof PRESIGNED_PROTOCOL;
  graphDigest: string;
  confirmed: PresignedGraphConfirmation[];
}

export interface PresignedProjectedOutput {
  txid: string;
  vout: number;
  valueSats: number;
  scriptPubKeyHex: string;
  kind: 'vault' | 'final-payout';
  roundId: RoundId | null;
  owner: ParticipantId | null;
}

export type PresignedChainReconciliation =
  | { kind: 'deferred'; state: PresignedGraphChainState; reason: string }
  | { kind: 'reconciled'; state: PresignedGraphChainState;
      projectedOutput: PresignedProjectedOutput | null;
      /** Reverse dependency order: child before parent. */
      invalidated: PresignedGraphConfirmation[];
      /** Dependency order: funding, first exit, second exit. */
      added: PresignedGraphConfirmation[];
      reanchored: Array<{ previous: PresignedGraphConfirmation; current: PresignedGraphConfirmation }> };

export function initialPresignedGraphChainState(graph: PresignedGraph): PresignedGraphChainState {
  validatePresignedGraph(graph);
  return { version: 2, protocol: PRESIGNED_PROTOCOL, graphDigest: graph.digest, confirmed: [] };
}

/**
 * Adapter orchestration only. The backend MUST be the private fully validating
 * Core adapter; this module knows no endpoint and never sends a transaction.
 * A moving tip defers the poll. Indexing/synchronization failures must be unknown.
 * Returned views are operationally trusted inputs, not portable consensus proofs.
 */
export async function collectPresignedChainView(input: {
  graph: PresignedGraph;
  currentState: PresignedGraphChainState;
  backend: PresignedChainBackend;
}): Promise<PresignedChainView> {
  validatePresignedGraph(input.graph);
  validateState(input.graph, input.currentState);
  try {
    const before = await input.backend.getTip();
    validateTip(input.graph, before);
    const txids = knownTxids(input.graph);
    const transactions = await Promise.all(txids.map(txid => input.backend.getTransaction(txid)));
    for (const [index, observation] of transactions.entries()) {
      assert(observation && observation.txid === txids[index], 'backend returned another transaction');
    }
    const hashes = new Set(input.currentState.confirmed.map(item => item.blockHash));
    for (const observation of transactions) {
      if (observation.kind === 'present' && observation.blockHash !== null) {
        hexBytes(observation.blockHash, 32, 'observed confirmation block');
        hashes.add(observation.blockHash);
      }
    }
    const blocks = await Promise.all([...hashes].map(hash => input.backend.getBlock(hash)));
    for (const [index, block] of blocks.entries()) {
      assert(block && block.hash === [...hashes][index], 'backend returned another block');
    }
    const after = await input.backend.getTip();
    validateTip(input.graph, after);
    if (before.hash !== after.hash || before.height !== after.height) {
      return { kind: 'unknown', reason: 'tip-changed' };
    }
    return { kind: 'snapshot', graphDigest: input.graph.digest, tip: after, transactions, blocks };
  } catch {
    // Do not leak RPC URLs, credentials or backend error strings into state.
    return { kind: 'unknown', reason: 'backend-error' };
  }
}

/**
 * Pure all-or-nothing reconciliation of a CURRENT IN-PROCESS private Core view.
 * Unknown, contradictory or mismatched-economic
 * evidence returns the identical prior state object. Caller-owned graph/state
 * corruption throws instead of manufacturing a replacement state.
 */
export function reconcilePresignedGraphChain(input: {
  graph: PresignedGraph;
  currentState: PresignedGraphChainState;
  trustedCoreView: PresignedChainView;
  requiredConfirmations: number;
}): PresignedChainReconciliation {
  const { graph, currentState, trustedCoreView: view } = input;
  validatePresignedGraph(graph);
  validateState(graph, currentState);
  safeInteger(input.requiredConfirmations, 1, 2_000_000, 'required confirmation depth');
  if (view.kind === 'unknown') return deferred(currentState, view.reason);
  try {
    validateTip(graph, view.tip);
    assert(view.graphDigest === graph.digest, 'chain snapshot belongs to another graph');
    const expectedTxids = knownTxids(graph);
    assert(Array.isArray(view.transactions) && view.transactions.length === expectedTxids.length,
      'incomplete transaction observation set');
    const observations = new Map(view.transactions.map(item => [item.txid, item]));
    assert(observations.size === expectedTxids.length && expectedTxids.every(txid => observations.has(txid)),
      'duplicate or unrelated transaction observation');
    assert(Array.isArray(view.blocks), 'missing block observation set');
    const blocks = new Map(view.blocks.map(item => [item.hash, item]));
    assert(blocks.size === view.blocks.length, 'duplicate block observation');
    const activeHeights = new Map<number, string>();
    for (const block of blocks.values()) {
      hexBytes(block.hash, 32, 'observed block hash');
      if (block.kind === 'unknown') return deferred(currentState, 'unknown-block');
      assert(block.kind === 'active' || block.kind === 'inactive', 'invalid block observation');
      safeInteger(block.height, 1, 2_000_000_000, 'observed block height');
      if (block.kind === 'active') {
        assert(block.height <= view.tip.height &&
          block.confirmations === view.tip.height - block.height + 1, 'block depth differs from snapshot tip');
        assert(block.height !== view.tip.height || block.hash === view.tip.hash, 'active tip block mismatch');
        assert(!activeHeights.has(block.height) || activeHeights.get(block.height) === block.hash,
          'two active blocks at one height');
        activeHeights.set(block.height, block.hash);
      }
    }

    const active = new Map<string, PresignedGraphConfirmation>();
    for (const txid of expectedTxids) {
      const observation = observations.get(txid)!;
      if (observation.kind === 'unknown') return deferred(currentState, 'unknown-transaction');
      assert(observation.kind === 'absent' || observation.kind === 'present', 'invalid transaction observation');
      if (observation.kind === 'absent') continue;
      // No mempool payload or unanchored status may reach confirmed recognition.
      if (observation.blockHash === null) continue;
      hexBytes(observation.blockHash, 32, 'transaction confirmation block');
      const block = blocks.get(observation.blockHash);
      assert(block, 'transaction confirmation has no independent block observation');
      if (block.kind !== 'active') continue;
      const exit = graph.exits.find(item => item.txid === txid);
      const evidence = { graph, transaction: { txid, transactionHex: observation.transactionHex, blockHash: observation.blockHash },
        activeBlock: block, tip: view.tip };
      const recognized = exit
        ? recognizeConfirmedPresignedExitTransaction({ ...evidence, exitId: exit.id })
        : recognizeConfirmedPresignedFundingTransaction(evidence);
      active.set(txid, { txid: recognized.txid, exitId: recognized.exitId,
        blockHash: recognized.blockHash, height: recognized.height });
    }

    // Absence alone cannot erase a confirmation whose independently observed
    // block is still active. Such disagreement means the backend view is unsafe.
    for (const previous of currentState.confirmed) {
      const oldBlock = blocks.get(previous.blockHash);
      assert(oldBlock && oldBlock.kind !== 'unknown' && oldBlock.height === previous.height,
        'previous anchor was not independently observed');
      const now = active.get(previous.txid);
      if (oldBlock.kind === 'active') {
        assert(now && now.blockHash === previous.blockHash,
          'transaction missing or moved despite an active prior anchor');
      }
    }

    // Check the complete active chain, even shallow confirmations that will
    // not yet be promoted. A child cannot be active without its actual parent.
    const spent = new Map<string, string>();
    for (const exit of graph.exits) {
      const confirmation = active.get(exit.txid);
      if (!confirmation) continue;
      const parent = active.get(exit.inputTxid);
      assert(parent && parent.height <= confirmation.height, 'active exit lacks an earlier active parent');
      const outpoint = `${exit.inputTxid}:${exit.inputVout}`;
      assert(!spent.has(outpoint), 'conflicting graph branches are both claimed active');
      spent.set(outpoint, exit.txid);
    }
    const qualified = (txid: string): PresignedGraphConfirmation | undefined => {
      const confirmation = active.get(txid);
      return confirmation && view.tip.height - confirmation.height + 1 >= input.requiredConfirmations
        ? confirmation : undefined;
    };
    const confirmed: PresignedGraphConfirmation[] = [];
    const funding = qualified(graph.fundingTxid);
    if (funding) {
      confirmed.push(funding);
      let parentTxid = graph.fundingTxid;
      for (let depth = 0; depth < 2; depth += 1) {
        const next = graph.exits.find(exit => exit.inputTxid === parentTxid && qualified(exit.txid));
        if (!next) break;
        confirmed.push(qualified(next.txid)!);
        parentTxid = next.txid;
      }
    }
    const state: PresignedGraphChainState = {
      version: 2, protocol: PRESIGNED_PROTOCOL, graphDigest: graph.digest, confirmed,
    };
    validateState(graph, state);
    const previousByTxid = new Map(currentState.confirmed.map(item => [item.txid, item]));
    const currentByTxid = new Map(confirmed.map(item => [item.txid, item]));
    return {
      kind: 'reconciled', state, projectedOutput: projectOutput(graph, state),
      invalidated: currentState.confirmed.filter(item => !currentByTxid.has(item.txid)).reverse(),
      added: confirmed.filter(item => !previousByTxid.has(item.txid)),
      reanchored: confirmed.flatMap(item => {
        const previous = previousByTxid.get(item.txid);
        return previous && (previous.blockHash !== item.blockHash || previous.height !== item.height)
          ? [{ previous, current: item }] : [];
      }),
    };
  } catch {
    return deferred(currentState, 'inconsistent-or-unauthorized-chain-evidence');
  }
}

/**
 * Flags coexistence; never deletes, selects, or silently retires an epoch.
 * Supply states reconciled to the same stable chain view. This diagnostic
 * cannot adjudicate snapshots taken on opposite sides of a reorganization.
 */
export function findPresignedEpochConflicts(epochs: ReadonlyArray<{
  graph: PresignedGraph; state: PresignedGraphChainState;
}>): Array<{ kind: 'multiple-funded-epochs' | 'shared-funding-input'; graphDigests: [string, string] }> {
  for (const epoch of epochs) {
    validatePresignedGraph(epoch.graph);
    validateState(epoch.graph, epoch.state);
  }
  const conflicts: Array<{ kind: 'multiple-funded-epochs' | 'shared-funding-input'; graphDigests: [string, string] }> = [];
  for (let leftIndex = 0; leftIndex < epochs.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < epochs.length; rightIndex += 1) {
      const left = epochs[leftIndex]!;
      const right = epochs[rightIndex]!;
      if (left.graph.digest === right.graph.digest || !left.state.confirmed.length || !right.state.confirmed.length) continue;
      // Restart before wallet release can freeze the very same economic graph
      // under a new epoch ID. Retain both histories without inventing a second
      // funded coin. This compares literal public authority, not just txid.
      if (samePresignedEconomicGraph(left.graph, right.graph)) continue;
      const graphDigests: [string, string] = [left.graph.digest, right.graph.digest];
      if (left.graph.roster.vaultId === right.graph.roster.vaultId &&
          left.graph.roster.genesisHash === right.graph.roster.genesisHash) {
        conflicts.push({ kind: 'multiple-funded-epochs', graphDigests });
      }
      if (left.graph.fundingTxid !== right.graph.fundingTxid && left.graph.roster.genesisHash === right.graph.roster.genesisHash &&
          left.graph.funding.inputs.some(input => right.graph.funding.inputs.some(other => input.txid === other.txid && input.vout === other.vout))) {
        conflicts.push({ kind: 'shared-funding-input', graphDigests });
      }
    }
  }
  return conflicts;
}

export function samePresignedEconomicGraph(left: PresignedGraph, right: PresignedGraph): boolean {
  validatePresignedGraph(left); validatePresignedGraph(right);
  const authority = (graph: PresignedGraph) => ({ roster: graph.roster, rounds: graph.rounds,
    fundingUnsignedTxHex: graph.fundingUnsignedTxHex,
    exits: graph.exits.map(exit => ({ id: exit.id, unsignedTxHex: exit.unsignedTxHex })) });
  return canonicalJson(authority(left)) === canonicalJson(authority(right));
}

function knownTxids(graph: PresignedGraph): string[] {
  return [graph.fundingTxid, ...graph.exits.filter(exit => exit.parentExitId === null).map(exit => exit.txid),
    ...graph.exits.filter(exit => exit.parentExitId !== null).map(exit => exit.txid)];
}

function validateTip(graph: PresignedGraph, tip: PresignedChainTip): void {
  assert(tip && tip.network === graph.roster.network && tip.genesisHash === graph.roster.genesisHash,
    'backend network or genesis differs from graph');
  hexBytes(tip.hash, 32, 'chain tip hash');
  safeInteger(tip.height, 1, 2_000_000_000, 'chain tip height');
}

function validateState(graph: PresignedGraph, state: PresignedGraphChainState): void {
  assert(state && state.version === 2 && state.protocol === PRESIGNED_PROTOCOL && state.graphDigest === graph.digest,
    'chain state belongs to another graph');
  assert(Array.isArray(state.confirmed) && state.confirmed.length <= 3, 'invalid graph confirmation path');
  for (const [index, confirmation] of state.confirmed.entries()) {
    hexBytes(confirmation.blockHash, 32, 'stored confirmation block');
    safeInteger(confirmation.height, 1, 2_000_000_000, 'stored confirmation height');
    if (index === 0) {
      assert(confirmation.txid === graph.fundingTxid && confirmation.exitId === null, 'confirmation path must start at funding');
    } else {
      const previous = state.confirmed[index - 1]!;
      const exit = graph.exits.find(item => item.id === confirmation.exitId);
      assert(exit && exit.txid === confirmation.txid && exit.inputTxid === previous.txid &&
        previous.height <= confirmation.height, 'confirmation path changed its exact parent');
    }
  }
}

function projectOutput(graph: PresignedGraph, state: PresignedGraphChainState): PresignedProjectedOutput | null {
  const last = state.confirmed.at(-1);
  if (!last) return null;
  const exit = last.exitId === null ? undefined : graph.exits.find(item => item.id === last.exitId)!;
  const transaction = bitcoin.Transaction.fromHex(exit?.unsignedTxHex ?? graph.fundingUnsignedTxHex);
  const vout = exit ? 1 : 0;
  const output = transaction.outs[vout]!;
  const scriptPubKeyHex = Buffer.from(output.script).toString('hex');
  const terminal = Boolean(exit?.parentExitId);
  const round = graph.rounds.find(item => item.outputScriptHex === scriptPubKeyHex);
  assert(terminal || round, 'projected vault output has no committed round');
  return { txid: last.txid, vout, valueSats: Number(output.value), scriptPubKeyHex,
    kind: terminal ? 'final-payout' : 'vault', roundId: terminal ? null : round!.id,
    owner: terminal ? exit!.finalParticipant : null };
}

function deferred(state: PresignedGraphChainState, reason: string): PresignedChainReconciliation {
  return { kind: 'deferred', state, reason };
}
