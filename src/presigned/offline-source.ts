import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { validatePresignedCoinObservations, type PresignedCoinObservations } from './coin-observations.js';
import type { FeeCoinObservation } from './fees.js';
import { validatePresignedGraph } from './graph.js';
import type { PresignedSpendSource } from './spends.js';
import type { ParticipantId, PresignedGraph, RoundId } from './types.js';
import { assert, commitmentDigest, participantId, safeInteger } from './validation.js';

export interface PresignedOfflineSourceInput {
  graph: PresignedGraph;
  participantId: ParticipantId;
  observations: unknown;
}

export interface PresignedOfflineSource {
  graphDigest: string;
  participantId: ParticipantId;
  /** Commits to the exact report and graph, not just its selected coin. */
  reportDigest: string;
  sourceExitId: string | null;
  source: PresignedSpendSource & { roundId: RoundId; owner: null };
  participantIds: ParticipantId[];
  observedCoin: FeeCoinObservation;
  tip: PresignedCoinObservations['tip'];
  observedAt: string;
  confirmationBlockHash: string;
  confirmationHeight: number;
  confirmations: number;
  requiredConfirmations: number;
  blocksRemaining: number;
  earliestCandidateSpendHeight: number;
  eligibleForNextBlock: boolean;
  unspentInActiveChain: true;
  availability: PresignedCoinObservations['availability'][number];
  mempoolConflict: boolean;
}

/**
 * Select only the shared graph source claimed by an independently obtained
 * own-Core receipt. This is local consistency validation, NOT an RPC, SPV,
 * freshness, or active-chain proof. Reimport/recheck after any chain change.
 * A pending spender is a conflict warning, not confirmed settlement.
 */
export function selectPresignedOfflineSource(input: PresignedOfflineSourceInput): PresignedOfflineSource {
  const graph = validatePresignedGraph(input.graph);
  participantId(input.participantId);
  const report = validatePresignedCoinObservations(graph, input.observations);
  // Enumerate ALL four shared sources before applying membership. Filtering by
  // the caller first could hide a competing reported source after their exit.
  const candidates = [null, ...graph.exits.filter(exit => exit.parentExitId === null)].map(exit => {
    const transaction = bitcoin.Transaction.fromHex(exit?.unsignedTxHex ?? graph.fundingUnsignedTxHex);
    const vout = exit === null ? 0 : 1;
    const output = transaction.outs[vout]!;
    const scriptPubKeyHex = Buffer.from(output.script).toString('hex');
    const round = graph.rounds.find(item => item.outputScriptHex === scriptPubKeyHex);
    assert(round, 'offline source is not a committed shared graph round');
    return { sourceExitId: exit?.id ?? null, participantIds: [...round.participantIds],
      source: { txid: transaction.getId(), vout, valueSats: Number(output.value), scriptPubKeyHex,
        roundId: round.id, owner: null } as PresignedOfflineSource['source'] };
  });
  const matches: Array<{ candidate: typeof candidates[number]; coin: FeeCoinObservation }> = [];
  for (const coin of report.coins) {
    const exact = candidates.find(item => item.source.txid === coin.txid && item.source.vout === coin.vout);
    const sharedScript = candidates.some(item => item.source.scriptPubKeyHex === coin.scriptPubKeyHex);
    if (!exact && !sharedScript) continue; // Unrelated sponsor/payout observations are allowed.
    assert(exact && exact.source.valueSats === coin.valueSats && exact.source.scriptPubKeyHex === coin.scriptPubKeyHex,
      'offline reported shared source differs from its exact graph outpoint, value or script');
    matches.push({ candidate: exact, coin });
  }
  assert(matches.length === 1, 'offline observations must identify exactly one current shared graph source');
  const { candidate, coin } = matches[0]!;
  assert(candidate.participantIds.includes(input.participantId), 'participant is not a member of the observed current shared source');
  const confirmationHeight = report.tip.height - coin.confirmations + 1;
  safeInteger(confirmationHeight, 1, report.tip.height, 'offline shared source confirmation height');
  assert((coin.confirmations === 1) === (coin.confirmationBlockHash === report.tip.hash),
    'offline source confirmation anchor conflicts with the reported tip');
  for (const other of report.coins) {
    // An extra observation cannot disagree about this transaction or block.
    assert(other.txid !== coin.txid || (other.confirmations === coin.confirmations &&
      other.confirmationBlockHash === coin.confirmationBlockHash), 'offline source transaction has conflicting confirmation facts');
    assert((other.confirmations === coin.confirmations) === (other.confirmationBlockHash === coin.confirmationBlockHash),
      'offline source block has conflicting confirmation facts');
  }
  const requiredConfirmations = graph.roster.economics.recoveryDelayBlocks;
  const blocksRemaining = Math.max(0, requiredConfirmations - coin.confirmations);
  const availability = report.availability.find(item => item.txid === coin.txid && item.vout === coin.vout)!;
  return { graphDigest: graph.digest, participantId: input.participantId,
    reportDigest: commitmentDigest(`vault/${graph.protocol}/offline-source-observations`, { graphDigest: graph.digest, report }),
    sourceExitId: candidate.sourceExitId, source: { ...candidate.source }, participantIds: [...candidate.participantIds],
    observedCoin: { ...coin }, tip: { ...report.tip }, observedAt: report.observedAt,
    confirmationBlockHash: coin.confirmationBlockHash, confirmationHeight, confirmations: coin.confirmations,
    requiredConfirmations, blocksRemaining, earliestCandidateSpendHeight: confirmationHeight + requiredConfirmations,
    eligibleForNextBlock: blocksRemaining === 0, unspentInActiveChain: true,
    availability: { ...availability }, mempoolConflict: availability.kind === 'mempool-spent' };
}

/** Revalidate the raw report at the recovery-signing boundary; no cached flag is authority. */
export function requirePresignedOfflineRecoverySource(input: PresignedOfflineSourceInput): PresignedOfflineSource {
  const selected = selectPresignedOfflineSource(input);
  assert(selected.eligibleForNextBlock, 'offline current shared source has not reached the committed recovery CSV age');
  return selected;
}
