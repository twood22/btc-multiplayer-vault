import assert from 'node:assert/strict';
import type { PresignedCoinObservations } from './coin-observations.js';
import { createPresignedFixture } from './fixtures.js';
import { buildPresignedGraph } from './graph.js';
import { requirePresignedOfflineRecoverySource, selectPresignedOfflineSource } from './offline-source.js';
import { clearPresignedParticipantKeys } from './roster.js';
import { buildPresignedSpend, type PresignedSpendProposal } from './spends.js';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3, type PresignedGraph } from './types.js';

let checks = 0; let positiveCases = 0; let negativeCases = 0;
let graphSources = 0; let ageBoundaryCases = 0; let pendingConflictCases = 0;
function accepts(action: () => void) { action(); checks++; positiveCases++; }
function rejects(action: () => unknown, message?: RegExp) {
  if (message) assert.throws(action, message); else assert.throws(action);
  checks++; negativeCases++;
}
function reportFor(graph: PresignedGraph, spend: PresignedSpendProposal, confirmations: number): PresignedCoinObservations {
  const { txid, vout, valueSats, scriptPubKeyHex } = spend.source;
  return { version: graph.version, protocol: graph.protocol, format: 'presigned-private-core-observations-v1',
    network: graph.roster.network, genesisHash: graph.roster.genesisHash,
    tip: { network: graph.roster.network, genesisHash: graph.roster.genesisHash, hash: '55'.repeat(32), height: 100 },
    observedAt: '2026-09-19T00:00:00.000Z',
    coins: [{ txid, vout, valueSats, scriptPubKeyHex, network: graph.roster.network, genesisHash: graph.roster.genesisHash,
      confirmations, confirmationBlockHash: (confirmations === 1 ? '55' : '44').repeat(32),
      unspentInActiveChain: true, coinbase: false }],
    availability: [{ txid, vout, kind: 'available', spendingTxid: null }] };
}
function addCoin(report: PresignedCoinObservations, extra: PresignedCoinObservations) {
  report.coins.push(...structuredClone(extra.coins)); report.availability.push(...structuredClone(extra.availability));
}
const protocols = [PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3];
const networks = ['mainnet', 'signet'] as const;
for (const protocol of protocols) for (const network of networks) {
  const fixture = createPresignedFixture({ protocol, network }); const { graph } = fixture;
  const delay = graph.roster.economics.recoveryDelayBlocks;
  const spends = [null, 'alice', 'bob', 'carol'].map(sourceExitId => buildPresignedSpend({ graph,
    proposalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'recovery', sourceExitId }));
  for (const spend of spends) {
    const participantId = spend.participantIds[0]!;
    const report = reportFor(graph, spend, delay);
    const input = { graph, participantId, observations: report };
    accepts(() => {
      const selected = selectPresignedOfflineSource(input);
      assert.equal(selected.graphDigest, graph.digest); assert.equal(selected.participantId, participantId);
      assert.deepEqual(selected.source, spend.source); assert.equal(selected.sourceExitId, spend.sourceExitId);
      assert.deepEqual(selected.participantIds, spend.participantIds); assert.deepEqual(selected.observedCoin, report.coins[0]);
      assert.deepEqual(selected.tip, report.tip); assert.equal(selected.observedAt, report.observedAt);
      assert.equal(selected.confirmationBlockHash, report.coins[0]!.confirmationBlockHash);
      assert.equal(selected.confirmationHeight, 100 - delay + 1);
      assert.equal(selected.requiredConfirmations, delay); assert.equal(selected.confirmations, delay);
      assert.equal(selected.blocksRemaining, 0); assert.equal(selected.earliestCandidateSpendHeight, 101);
      assert.equal(selected.eligibleForNextBlock, true); assert.equal(selected.unspentInActiveChain, true);
      assert.equal(selected.mempoolConflict, false); assert.deepEqual(selected.availability, report.availability[0]);
      assert.match(selected.reportDigest, /^[0-9a-f]{64}$/u);
      assert.deepEqual(requirePresignedOfflineRecoverySource(input), selected);
    }); graphSources++;
    for (const owner of PARTICIPANT_IDS) {
      const ownerInput = { ...input, participantId: owner };
      if (spend.participantIds.includes(owner)) accepts(() => { assert.equal(selectPresignedOfflineSource(ownerInput).participantId, owner); });
      else rejects(() => selectPresignedOfflineSource(ownerInput), /not a member/u);
    }
    for (const confirmations of [1, delay - 1, delay, delay + 1]) {
      const boundary = { ...input, observations: reportFor(graph, spend, confirmations) };
      accepts(() => {
        const selected = selectPresignedOfflineSource(boundary);
        assert.equal(selected.confirmationHeight, 101 - confirmations);
        assert.equal(selected.blocksRemaining, Math.max(0, delay - confirmations));
        assert.equal(selected.earliestCandidateSpendHeight, 101 - confirmations + delay);
        assert.equal(selected.eligibleForNextBlock, confirmations >= delay);
      }); ageBoundaryCases++;
      if (confirmations >= delay) accepts(() => { assert.equal(requirePresignedOfflineRecoverySource(boundary).eligibleForNextBlock, true); });
      else rejects(() => requirePresignedOfflineRecoverySource(boundary), /CSV age/u);
    }
    for (const confirmations of [1, delay]) {
      const pending = reportFor(graph, spend, confirmations);
      pending.availability[0] = { ...pending.availability[0]!, kind: 'mempool-spent', spendingTxid: '66'.repeat(32) };
      accepts(() => {
        const selected = selectPresignedOfflineSource({ ...input, observations: pending });
        assert.equal(selected.unspentInActiveChain, true); assert.equal(selected.mempoolConflict, true);
        assert.equal(selected.availability.spendingTxid, '66'.repeat(32));
        assert.equal(selected.eligibleForNextBlock, confirmations >= delay);
        assert.notEqual(selected.reportDigest, selectPresignedOfflineSource(input).reportDigest);
        if (confirmations >= delay) assert.equal(requirePresignedOfflineRecoverySource({ ...input, observations: pending }).eligibleForNextBlock, true);
      }); pendingConflictCases++;
    }
  }
  const base = reportFor(graph, spends[0]!, delay);
  const input = { graph, participantId: 'alice' as const, observations: base };
  const mutations: Array<(report: any) => void> = [
    value => { value.coins = []; value.availability = []; },
    value => { value.coins[0].valueSats++; },
    value => { value.coins[0].scriptPubKeyHex = fixture.walletKeys.alice.scriptPubKeyHex; },
    value => { value.coins[0].txid = '77'.repeat(32); value.availability[0].txid = value.coins[0].txid; },
    value => { value.coins[0].vout++; value.availability[0].vout++; },
    value => { value.coins[0].unspentInActiveChain = false; },
    value => { value.coins[0].coinbase = true; },
    value => { value.coins[0].confirmations = 0; },
    value => { value.coins[0].confirmations = 101; },
    value => { value.coins[0].confirmations = 102; },
    value => { value.coins[0].confirmations = 1.5; },
    value => { value.coins[0].confirmationBlockHash = '00'.repeat(32); },
    value => { value.coins[0].confirmationBlockHash = value.tip.hash; },
    value => { value.coins[0].confirmations = 1; },
    value => { value.coins[0].network = network === 'mainnet' ? 'signet' : 'mainnet'; },
    value => { value.coins[0].genesisHash = '77'.repeat(32); },
    value => { value.network = network === 'mainnet' ? 'signet' : 'mainnet'; },
    value => { value.genesisHash = '77'.repeat(32); },
    value => { value.tip.genesisHash = '77'.repeat(32); },
    value => { value.tip.height = 0; },
    value => { value.protocol = protocol === PRESIGNED_PROTOCOL ? PRESIGNED_PROTOCOL_V3 : PRESIGNED_PROTOCOL;
      value.version = value.protocol === PRESIGNED_PROTOCOL ? 2 : 3; },
    value => { value.version = graph.version === 2 ? 3 : 2; },
    value => { value.protocol = 'presigned-graph-v4'; },
    value => { value.observedAt = '2026-02-30T00:00:00.000Z'; },
    value => { value.availability = []; },
    value => { value.availability[0].kind = 'chain-spent'; },
    value => { value.availability[0].spendingTxid = '77'.repeat(32); },
    value => { value.availability[0].kind = 'mempool-spent'; },
    value => { value.extra = true; },
    value => { value.coins.push(structuredClone(value.coins[0])); value.availability.push(structuredClone(value.availability[0])); },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(base); mutate(changed);
    rejects(() => selectPresignedOfflineSource({ ...input, observations: changed }));
  }
  const unrelated = structuredClone(base);
  unrelated.coins[0] = { ...unrelated.coins[0]!, txid: '88'.repeat(32), scriptPubKeyHex: fixture.walletKeys.alice.scriptPubKeyHex };
  unrelated.availability[0]!.txid = unrelated.coins[0]!.txid;
  rejects(() => selectPresignedOfflineSource({ ...input, observations: unrelated }), /exactly one/u);
  const extraAllowed = structuredClone(base); addCoin(extraAllowed, unrelated);
  accepts(() => { assert.equal(selectPresignedOfflineSource({ ...input, observations: extraAllowed }).source.txid, graph.fundingTxid); });
  for (let first = 0; first < spends.length; first++) for (let second = first + 1; second < spends.length; second++) {
    const ambiguous = reportFor(graph, spends[first]!, delay); addCoin(ambiguous, reportFor(graph, spends[second]!, delay));
    rejects(() => selectPresignedOfflineSource({ ...input, observations: ambiguous }), /exactly one/u);
  }
  const allSources = structuredClone(base);
  for (const spend of spends.slice(1)) addCoin(allSources, reportFor(graph, spend, delay));
  rejects(() => selectPresignedOfflineSource({ ...input, observations: allSources }), /exactly one/u);
  const conflicting = structuredClone(base); const malformedPair = reportFor(graph, spends[1]!, delay);
  malformedPair.coins[0]!.valueSats++; addCoin(conflicting, malformedPair);
  rejects(() => selectPresignedOfflineSource({ ...input, observations: conflicting }), /differs from/u);
  for (const conflict of ['transaction', 'block-hash', 'block-height']) {
    const facts = structuredClone(base); const extra = structuredClone(unrelated);
    if (conflict === 'transaction') { extra.coins[0]!.txid = graph.fundingTxid; extra.coins[0]!.vout = 1;
      extra.availability[0] = { ...extra.availability[0]!, txid: graph.fundingTxid, vout: 1 };
      extra.coins[0]!.confirmations++; extra.coins[0]!.confirmationBlockHash = '99'.repeat(32);
    } else if (conflict === 'block-hash') extra.coins[0]!.confirmationBlockHash = '99'.repeat(32);
    else extra.coins[0]!.confirmations++;
    addCoin(facts, extra); rejects(() => selectPresignedOfflineSource({ ...input, observations: facts }), /conflicting confirmation facts/u);
  }
  for (const change of ['time', 'tip', 'depth', 'anchor', 'availability']) {
    const changed = structuredClone(base);
    if (change === 'time') changed.observedAt = '2026-09-20T00:00:00.000Z';
    else if (change === 'tip') changed.tip.hash = '88'.repeat(32);
    else if (change === 'depth') { changed.tip.height++; changed.coins[0]!.confirmations++; }
    else if (change === 'anchor') changed.coins[0]!.confirmationBlockHash = '88'.repeat(32);
    else changed.availability[0] = { ...changed.availability[0]!, kind: 'mempool-spent', spendingTxid: '88'.repeat(32) };
    accepts(() => { assert.notEqual(selectPresignedOfflineSource({ ...input, observations: changed }).reportDigest,
      selectPresignedOfflineSource(input).reportDigest); });
  }
  accepts(() => {
    const reordered = Object.fromEntries(Object.entries(base).reverse());
    assert.equal(selectPresignedOfflineSource({ ...input, observations: reordered }).reportDigest,
      selectPresignedOfflineSource(input).reportDigest);
    const changedGraph = buildPresignedGraph({ roster: graph.roster, funding: { ...graph.funding,
      epochId: '44444444-4444-4444-8444-444444444444' } });
    assert.notEqual(selectPresignedOfflineSource({ ...input, graph: changedGraph }).reportDigest,
      selectPresignedOfflineSource(input).reportDigest);
    const selected = selectPresignedOfflineSource(input); const digest = selected.reportDigest;
    selected.observedCoin.confirmations++; selected.tip.height++; selected.availability.kind = 'mempool-spent';
    assert.equal(selectPresignedOfflineSource(input).reportDigest, digest); // Returned facts do not alias caller input.
  });
  for (const spend of spends.slice(1)) accepts(() => {
    const participantId = spend.participantIds[0]!;
    assert.equal(selectPresignedOfflineSource({ graph, participantId, observations: reportFor(graph, spends[0]!, delay + 20) }).eligibleForNextBlock, true);
    const pair = selectPresignedOfflineSource({ graph, participantId, observations: reportFor(graph, spend, 1) });
    assert.equal(pair.eligibleForNextBlock, false); assert.equal(pair.blocksRemaining, delay - 1);
    assert.equal(pair.confirmationHeight, 100); assert.equal(pair.earliestCandidateSpendHeight, 100 + delay);
  });
  const terminal = buildPresignedSpend({ graph, proposalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'final-sweep', sourceExitId: 'alice/bob' });
  rejects(() => selectPresignedOfflineSource({ ...input, participantId: 'carol', observations: reportFor(graph, terminal, delay) }), /exactly one/u);
  const invalidGraph = structuredClone(graph); invalidGraph.digest = '99'.repeat(32);
  rejects(() => selectPresignedOfflineSource({ ...input, graph: invalidGraph }));
  rejects(() => selectPresignedOfflineSource({ ...input, participantId: 'mallory' as any }));
  Object.values(fixture.keysById).forEach(clearPresignedParticipantKeys);
  Object.values(fixture.walletKeys).forEach(wallet => wallet.privateKey.fill(0));
}
console.log(JSON.stringify({ passed: true, suite: 'presigned-offline-current-shared-source', checks, positiveCases, negativeCases,
  graphSources, ageBoundaryCases, pendingConflictCases, protocols, networks, syntheticPublicFixturesOnly: true,
  actualChainEvidence: false, rpc: false, signed: false, broadcast: false }));
