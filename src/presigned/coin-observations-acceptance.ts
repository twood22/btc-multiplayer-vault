import assert from 'node:assert/strict';
import { presignedObservedFeeCoin, validatePresignedCoinObservations, type PresignedCoinObservations } from './coin-observations.js';
import { createPresignedFixture } from './fixtures.js';
import { PRESIGNED_PROTOCOL } from './types.js';

let checks = 0;
for (const network of ['mainnet','signet'] as const) {
  const { graph } = createPresignedFixture({ network });
  const report: PresignedCoinObservations = { version: 2, protocol: PRESIGNED_PROTOCOL,
    format: 'presigned-private-core-observations-v1', network, genesisHash: graph.roster.genesisHash,
    tip: { network, genesisHash: graph.roster.genesisHash, hash: '55'.repeat(32), height: 100 },
    observedAt: '2026-09-07T00:00:00.000Z',
    coins: graph.funding.inputs.map(({ participantId: _participant, changeScriptPubKeyHex: _change, ...coin }) => ({
      ...coin, network, genesisHash: graph.roster.genesisHash, unspentInActiveChain: true, coinbase: false })),
    availability: graph.funding.inputs.map(coin => ({ txid: coin.txid, vout: coin.vout, kind: 'available', spendingTxid: null })) };
  assert.deepEqual(validatePresignedCoinObservations(graph, report), report); checks++;
  const coin = report.coins[0]!;
  assert.deepEqual(presignedObservedFeeCoin(report, coin.txid, coin.vout, null), coin); checks++;
  for (const mutate of [
    (value: any) => { value.network = network === 'mainnet' ? 'signet' : 'mainnet'; },
    (value: any) => { value.tip.genesisHash = '66'.repeat(32); },
    (value: any) => { value.observedAt = '2026-02-30T00:00:00.000Z'; },
    (value: any) => { value.availability = []; },
    (value: any) => { value.coins[1] = value.coins[0]; },
    (value: any) => { value.availability[1] = value.availability[0]; },
    (value: any) => { value.availability[0].kind = 'chain-spent'; },
    (value: any) => { value.availability[0].spendingTxid = '77'.repeat(32); },
    (value: any) => { value.availability[0].kind = 'mempool-spent'; },
    (value: any) => { value.coins[0].confirmations = 102; },
    (value: any) => { value.hidden = 'unexpected field'; },
  ]) {
    const changed = structuredClone(report); mutate(changed);
    assert.throws(() => validatePresignedCoinObservations(graph, changed)); checks++;
  }
  const pending = structuredClone(report);
  pending.availability[0] = { txid: coin.txid, vout: coin.vout, kind: 'mempool-spent', spendingTxid: '77'.repeat(32) };
  validatePresignedCoinObservations(graph, pending);
  assert.throws(() => presignedObservedFeeCoin(pending, coin.txid, coin.vout, null), /another mempool/); checks++;
  assert.throws(() => presignedObservedFeeCoin(pending, coin.txid, coin.vout, '88'.repeat(32)), /another mempool/); checks++;
  assert.deepEqual(presignedObservedFeeCoin(pending, coin.txid, coin.vout, '77'.repeat(32)), coin); checks++;
}
console.log(JSON.stringify({ passed: true, checks, networks: ['mainnet','signet'], actualChainEvidence: false }));
