import type { PresignedChainTip } from './chain.js';
import { validateFeeCoinObservation, type FeeCoinObservation } from './fees.js';
import { PRESIGNED_PROTOCOL, type PresignedGraph } from './types.js';
import { assert, exactKeys, hexBytes, safeInteger } from './validation.js';

/** Public read-only Core receipt. Its contents are not an SPV or freshness proof. */
export interface PresignedCoinObservations {
  version: 2; protocol: typeof PRESIGNED_PROTOCOL; format: 'presigned-private-core-observations-v1';
  network: PresignedGraph['roster']['network']; genesisHash: string;
  tip: PresignedChainTip; observedAt: string; coins: FeeCoinObservation[];
  availability: Array<{ txid: string; vout: number; kind: 'available' | 'mempool-spent'; spendingTxid: string | null }>;
}

export function validatePresignedCoinObservations(graph: PresignedGraph, input: unknown): PresignedCoinObservations {
  exactKeys(input, ['version','protocol','format','network','genesisHash','tip','observedAt','coins','availability'], 'private-Core observation file');
  const report = input as PresignedCoinObservations;
  assert(report.version === 2 && report.protocol === PRESIGNED_PROTOCOL && report.format === 'presigned-private-core-observations-v1' &&
    report.network === graph.roster.network && report.genesisHash === graph.roster.genesisHash, 'private-Core observation file changed network or format');
  exactKeys(report.tip, ['network','genesisHash','hash','height'], 'private-Core observation tip');
  assert(report.tip.network === report.network && report.tip.genesisHash === report.genesisHash, 'private-Core tip changed network');
  hexBytes(report.tip.hash, 32, 'private-Core tip hash'); safeInteger(report.tip.height, 1, 2_000_000, 'private-Core tip height');
  assert(typeof report.observedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(report.observedAt) &&
    Number.isFinite(Date.parse(report.observedAt)) && new Date(report.observedAt).toISOString() === report.observedAt, 'private-Core observation time is invalid');
  assert(Array.isArray(report.coins) && report.coins.length >= 1 && report.coins.length <= 16 &&
    Array.isArray(report.availability) && report.availability.length === report.coins.length, 'private-Core observation file omits coin availability');
  const ids = new Set<string>();
  for (const coin of report.coins) {
    validateFeeCoinObservation(coin, graph, 'imported private-Core coin');
    const id = `${coin.txid}:${coin.vout}`;
    assert(!ids.has(id) && coin.confirmations <= report.tip.height + 1, 'private-Core observation repeats a coin or has an impossible height');
    ids.add(id);
  }
  for (const entry of report.availability) {
    exactKeys(entry, ['txid','vout','kind','spendingTxid'], 'private-Core coin availability');
    hexBytes(entry.txid, 32, 'available coin txid'); safeInteger(entry.vout, 0, 0xffffffff, 'available coin vout');
    assert(ids.delete(`${entry.txid}:${entry.vout}`), 'private-Core availability repeats or adds another coin');
    assert((entry.kind === 'available' && entry.spendingTxid === null) ||
      (entry.kind === 'mempool-spent' && typeof entry.spendingTxid === 'string'), 'private-Core coin has no usable availability observation');
    if (entry.kind === 'mempool-spent') hexBytes(entry.spendingTxid!, 32, 'private-Core pending spender');
  }
  assert(ids.size === 0, 'private-Core availability omitted a coin');
  return report;
}

/** Permit only the exact already-signed parent or exact replaced child, never an arbitrary pending spender. */
export function presignedObservedFeeCoin(report: PresignedCoinObservations, txid: string, vout: number,
  expectedPendingSpender: string | null): FeeCoinObservation {
  const coin = report.coins.find(item => item.txid === txid && item.vout === vout);
  const state = report.availability.find(item => item.txid === txid && item.vout === vout);
  assert(coin && state, 'private-Core observations omit a required exact source or sponsor coin');
  assert(state.kind === 'available' || (expectedPendingSpender !== null && state.spendingTxid === expectedPendingSpender),
    'another mempool transaction has claimed this source or sponsor coin');
  return coin;
}
