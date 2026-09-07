import * as bitcoin from 'bitcoinjs-lib';
import { collectPresignedChainView, initialPresignedGraphChainState, reconcilePresignedGraphChain,
  type PresignedChainBackend, type PresignedChainTip, type PresignedGraphChainState,
  type PresignedProjectedOutput } from './chain.js';
import { nonWitnessTransactionHex, validatePresignedGraph } from './graph.js';
import type { PresignedOutputAvailability } from './core.js';
import { validatePresignedRuntimeProposal, type PresignedRuntimeProposal } from './runtime.js';
import { buildPresignedSpend, type PresignedSpendProposal } from './spends.js';
import { PRESIGNED_PROTOCOL, type PresignedGraph } from './types.js';
import { assert, commitmentDigest, safeInteger, sameCanonical } from './validation.js';

export interface PresignedTerminalConfirmation {
  proposalId: string; txid: string; kind: 'cooperative' | 'recovery' | 'final-sweep';
  sourceTxid: string; sourceVout: number; blockHash: string; height: number;
}
export interface PresignedWatchState {
  version: 2; protocol: typeof PRESIGNED_PROTOCOL;
  graph: PresignedGraphChainState;
  terminals: PresignedTerminalConfirmation[];
}
export interface PresignedWatchedOutput extends PresignedProjectedOutput {
  confirmationBlockHash: string; confirmations: number;
  availability: 'available' | 'mempool-spent' | 'chain-spent';
  knownTerminalTxid: string | null;
}
export type PresignedEpochWatch =
  | { kind: 'deferred'; reason: string; state: PresignedWatchState }
  | { kind: 'snapshot'; state: PresignedWatchState; tip: PresignedChainTip; output: PresignedWatchedOutput | null;
      invalidatedTxids: string[]; addedTxids: string[]; reanchoredTxids: string[] };
export interface PresignedWatchBackend extends PresignedChainBackend {
  getOutputAvailability(output: PresignedProjectedOutput): Promise<PresignedOutputAvailability>;
}
export function initialPresignedWatchState(graph: PresignedGraph): PresignedWatchState {
  return { version: 2, protocol: PRESIGNED_PROTOCOL, graph: initialPresignedGraphChainState(graph), terminals: [] };
}

/** Observation targets only. These are NOT signed proposals or broadcast authority.
 * A portable-kit holder can produce each fixed terminal without contacting us.
 * Knowing the exact non-witness bytes lets private Core detect that spend even
 * when this service has never seen its signing ceremony.
 */
export function presignedTerminalWatchTargets(graph: PresignedGraph): PresignedSpendProposal[] {
  validatePresignedGraph(graph);
  const targets: PresignedSpendProposal[] = [];
  const add = (kind: PresignedSpendProposal['kind'], sourceExitId: string | null) => {
    const hash = commitmentDigest('vault/presigned-graph-v2/watch/terminal-id', { graphDigest: graph.digest, kind, sourceExitId });
    const proposalId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    targets.push(buildPresignedSpend({ graph, proposalId, kind, sourceExitId }));
  };
  for (const sourceExitId of [null, ...graph.exits.filter(exit => exit.parentExitId === null).map(exit => exit.id)]) {
    add('cooperative', sourceExitId); add('recovery', sourceExitId);
  }
  for (const exit of graph.exits.filter(exit => exit.parentExitId !== null)) add('final-sweep', exit.id);
  return targets;
}

/** In-process private validating-Core reads only. Never accept an HTTP-submitted chain snapshot. */
export async function collectPresignedEpochWatch(input: {
  graph: PresignedGraph; current: PresignedWatchState; proposals: PresignedRuntimeProposal[];
  backend: PresignedWatchBackend; requiredConfirmations: number;
}): Promise<PresignedEpochWatch> {
  const { graph, current, backend } = input;
  validatePresignedGraph(graph);
  assert(current.version === 2 && current.protocol === PRESIGNED_PROTOCOL && current.graph.graphDigest === graph.digest,
    'watch state has another protocol or graph');
  safeInteger(input.requiredConfirmations, 1, 144, 'watch confirmation depth');
  const retained = input.proposals.map(proposal => validatePresignedRuntimeProposal(graph, proposal)).filter(item => item.kind !== 'solo');
  assert(new Set(retained.map(item => item.proposalId)).size === retained.length, 'watch has duplicate proposals');
  const allProposals: Array<PresignedSpendProposal | PresignedRuntimeProposal> = [...retained, ...presignedTerminalWatchTargets(graph)];
  assert(Array.isArray(current.terminals) && new Set(current.terminals.map(item => item.proposalId)).size === current.terminals.length,
    'watch has duplicate terminal confirmations');
  for (const terminal of current.terminals) {
    const proposal = allProposals.find(item => item.proposalId === terminal.proposalId);
    assert(proposal && proposal.txid === terminal.txid && proposal.kind === terminal.kind &&
      proposal.source.txid === terminal.sourceTxid && proposal.source.vout === terminal.sourceVout,
    'previous terminal does not match a retained or independently derived observation target');
  }
  // Restarting MuSig after a burned/lost nonce changes ceremony identity, not
  // fixed transaction bytes. Observe identical txids once, retaining old anchors.
  const proposalsByTxid = new Map<string, PresignedSpendProposal | PresignedRuntimeProposal>();
  for (const proposal of allProposals) {
    const previous = current.terminals.find(item => item.txid === proposal.txid);
    if (!proposalsByTxid.has(proposal.txid) || previous?.proposalId === proposal.proposalId) proposalsByTxid.set(proposal.txid, proposal);
  }
  const proposals = [...proposalsByTxid.values()];
  const deferred = (reason: string): PresignedEpochWatch => ({ kind: 'deferred', reason, state: current });
  try {
    const before = await backend.getTip();
    const view = await collectPresignedChainView({ graph, currentState: current.graph, backend });
    const reconciled = reconcilePresignedGraphChain({ graph, currentState: current.graph,
      trustedCoreView: view, requiredConfirmations: input.requiredConfirmations });
    if (reconciled.kind === 'deferred') return deferred(reconciled.reason);
    assert(view.kind === 'snapshot', 'reconciled watch lacks a stable snapshot');
    sameCanonical(before, view.tip, 'watch graph collection tip');
    const observations = await Promise.all(proposals.map(proposal => backend.getTransaction(proposal.txid)));
    const terminals: PresignedTerminalConfirmation[] = [];
    for (const [index, observed] of observations.entries()) {
      const proposal = proposals[index]!;
      assert(observed.txid === proposal.txid && observed.kind !== 'unknown', 'terminal lookup is unknown or changed transaction');
      const previous = current.terminals.find(item => item.proposalId === proposal.proposalId);
      let now: PresignedTerminalConfirmation | undefined;
      if (observed.kind === 'present' && observed.blockHash !== null) {
        const block = await backend.getBlock(observed.blockHash);
        assert(block.kind !== 'unknown' && block.hash === observed.blockHash, 'terminal block is unknown');
        if (block.kind === 'active') {
          assert(block.confirmations === before.height - block.height + 1 &&
            (block.height !== before.height || block.hash === before.hash), 'terminal anchor differs from stable tip');
          // Observation is deliberately broader than the send validator. Core
          // establishes consensus validity; exact non-witness bytes bind all economics.
          const tx = bitcoin.Transaction.fromHex(observed.transactionHex);
          assert(tx.getId() === proposal.txid && nonWitnessTransactionHex(tx) === proposal.unsignedTxHex,
            'confirmed terminal changed its exact source or payouts');
          if (block.confirmations >= input.requiredConfirmations) {
            assert(reconciled.state.confirmed.some(item => item.txid === proposal.source.txid && item.height <= block.height),
              'qualified terminal lacks its active source graph ancestor');
            now = { proposalId: proposal.proposalId, txid: proposal.txid,
              kind: proposal.kind as PresignedTerminalConfirmation['kind'], sourceTxid: proposal.source.txid,
              sourceVout: proposal.source.vout, blockHash: block.hash, height: block.height };
            terminals.push(now);
          }
        }
      }
      if (previous) {
        const anchor = await backend.getBlock(previous.blockHash);
        assert(anchor.kind !== 'unknown' && anchor.height === previous.height, 'previous terminal anchor is unknown');
        if (anchor.kind === 'active') assert(now && now.blockHash === previous.blockHash,
          'terminal disappeared despite its prior block remaining active');
      }
    }
    const spent = new Map<string, string>();
    for (const confirmation of reconciled.state.confirmed) {
      if (confirmation.exitId === null) continue;
      const exit = graph.exits.find(item => item.id === confirmation.exitId)!;
      spent.set(`${exit.inputTxid}:${exit.inputVout}`, exit.txid);
    }
    for (const terminal of terminals) {
      const key = `${terminal.sourceTxid}:${terminal.sourceVout}`;
      assert(!spent.has(key), 'conflicting terminal and graph spends are both claimed active');
      spent.set(key, terminal.txid);
    }
    let output: PresignedWatchedOutput | null = null;
    if (reconciled.projectedOutput) {
      const projected = reconciled.projectedOutput;
      const confirmation = reconciled.state.confirmed.find(item => item.txid === projected.txid)!;
      const availability = await backend.getOutputAvailability(projected);
      assert(availability.kind !== 'unknown', 'confirmed source availability is unknown');
      const terminal = terminals.find(item => item.sourceTxid === projected.txid && item.sourceVout === projected.vout);
      if (terminal) assert(availability.kind === 'chain-spent', 'confirmed terminal source is claimed unspent');
      output = { ...projected, confirmationBlockHash: confirmation.blockHash,
        confirmations: before.height - confirmation.height + 1, availability: availability.kind,
        knownTerminalTxid: terminal?.txid ?? null };
    }
    const after = await backend.getTip();
    sameCanonical(before, after, 'complete watch tip');
    const state: PresignedWatchState = { version: 2, protocol: PRESIGNED_PROTOCOL, graph: reconciled.state, terminals };
    const oldByTxid = new Map(current.terminals.map(item => [item.txid, item]));
    const newByTxid = new Map(terminals.map(item => [item.txid, item]));
    return { kind: 'snapshot', state, tip: after, output,
      invalidatedTxids: [...current.terminals.filter(item => !newByTxid.has(item.txid)).reverse().map(item => item.txid),
        ...reconciled.invalidated.map(item => item.txid)],
      addedTxids: [...reconciled.added.map(item => item.txid), ...terminals.filter(item => !oldByTxid.has(item.txid)).map(item => item.txid)],
      reanchoredTxids: [...reconciled.reanchored.map(item => item.current.txid),
        ...terminals.filter(item => oldByTxid.has(item.txid) && oldByTxid.get(item.txid)!.blockHash !== item.blockHash).map(item => item.txid)] };
  } catch { return deferred('unknown-or-inconsistent-private-Core-watch'); }
}
