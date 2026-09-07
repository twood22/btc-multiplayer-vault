import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as bitcoin from 'bitcoinjs-lib';
import { createPresignedFixture, preauthorizePresignedFixture, signPresignedFixtureFunding } from '../src/presigned/fixtures.js';
import { buildPresignedGraph } from '../src/presigned/graph.js';
import { createPresignedCoreBackend, type PresignedCoreRpc } from '../src/presigned/core.js';
import { collectPresignedEpochWatch, initialPresignedWatchState } from '../src/presigned/watch.js';
import { completePresignedExit } from '../src/presigned/signing.js';
import { buildPresignedSpend, createPresignedCooperativeNonce, createPresignedRecoveryContribution,
  finalizePresignedCooperative, finalizePresignedRecovery, signPresignedCooperativePartial,
  signPresignedFinalSweep } from '../src/presigned/spends.js';
import { PARTICIPANT_IDS, type ParticipantId, type PresignedGraph } from '../src/presigned/types.js';
import { withPresignedRegtest } from './lib/presigned-regtest.js';

// All keys below are PUBLIC fixtures. This host has networking disabled and
// never reads the application's RPC configuration or live wallet credentials.
await withPresignedRegtest(async core => {
  const confirmed: Array<{ kind: string; source: string | null; omitted?: ParticipantId; txid: string }> = [];
  let rejected = 0;
  let offlineTerminalsObserved = 0;
  const genesisHash = createPresignedFixture().roster.genesisHash;
  // Only identity is relabeled in-process. Every tx, anchor and UTXO is real
  // network-disabled Core evidence, NOT actual default-Signet verification.
  const rpc: PresignedCoreRpc = async <T,>(method: string, params: unknown[] = []): Promise<T> => {
    try {
      const result = await core.rpc(method, params);
      if (method === 'getblockchaininfo') return { ...result, chain: 'signet' } as T;
      if (method === 'getblockhash' && params[0] === 0) return genesisHash as T;
      return result as T;
    } catch (error) { throw Object.assign(new Error('isolated Core rejected test request'), { code: (error as { rpcCode?: number }).rpcCode }); }
  };
  const backend = createPresignedCoreBackend({ network: 'signet', genesisHash, rpc });
  async function ready(source: string | null) {
    const fixture = createPresignedFixture();
    const coins = await core.fundScripts(PARTICIPANT_IDS.map(id => ({
      scriptPubKeyHex: fixture.walletKeys[id].scriptPubKeyHex, valueSats: 12_000,
    })));
    fixture.graph = buildPresignedGraph({ roster: fixture.roster, funding: { ...fixture.graph.funding,
      inputs: coins.map((coin, index) => ({ ...coin, participantId: PARTICIPANT_IDS[index]!,
        changeScriptPubKeyHex: coin.scriptPubKeyHex })) } });
    const { graph, keysById } = fixture;
    const preauthorizations = preauthorizePresignedFixture(fixture);
    const funding = signPresignedFixtureFunding(fixture);
    await core.rpc('sendrawtransaction', [funding.transactionHex]);
    await core.mine();
    if (source !== null) {
      const ids = source.includes('/') ? [source.split('/')[0]!, source] : [source];
      for (const exitId of ids) {
        const exit = graph.exits.find(item => item.id === exitId)!;
        const signed = completePresignedExit({ graph, preauthorizations, exitId, participantId: exit.leaver,
          privateKey: keysById[exit.leaver].soloPrivateKeys[exit.roundId]!, approvedGraphDigest: graph.digest });
        await core.rpc('sendrawtransaction', [signed.transactionHex]);
        await core.mine();
      }
    }
    return fixture;
  }
  async function acceptable(hex: string, expected: boolean) {
    const result = await core.rpc('testmempoolaccept', [[hex]]);
    assert.equal(result[0].allowed, expected, JSON.stringify(result));
    if (!expected) rejected++;
    return result[0];
  }
  async function hostileMutations(hex: string) {
    const missing = bitcoin.Transaction.fromHex(hex);
    const signature = missing.ins[0]!.witness.findIndex(item => item.length === 64);
    assert(signature >= 0);
    missing.ins[0]!.witness[signature] = Buffer.alloc(0);
    await acceptable(missing.toHex(), false);
    const changed = bitcoin.Transaction.fromHex(hex);
    changed.outs[0]!.value -= 1n;
    await acceptable(changed.toHex(), false);
  }
  async function confirm(hex: string, txid: string, graph: PresignedGraph) {
    await acceptable(hex, true);
    assert.equal(await core.rpc('sendrawtransaction', [hex]), txid);
    await core.mine();
    const raw = await core.rpc('getrawtransaction', [txid, true]);
    assert(raw.confirmations >= 1);
    assert.equal(raw.hex, hex);
    for (let i = 0; i < 100 && !(await core.rpc('getindexinfo')).txindex?.synced; i++) await new Promise(resolve => setTimeout(resolve, 50));
    const observed = await collectPresignedEpochWatch({ graph, current: initialPresignedWatchState(graph),
      proposals: [], backend, requiredConfirmations: 1 });
    assert.equal(observed.kind, 'snapshot');
    assert(observed.kind === 'snapshot');
    assert.equal(observed.state.terminals.length, 1);
    assert.equal(observed.output?.knownTerminalTxid, txid);
    assert.equal(observed.output?.availability, 'chain-spent');
    const again = await collectPresignedEpochWatch({ graph, current: observed.state, proposals: [], backend, requiredConfirmations: 1 });
    assert.equal(again.kind, 'snapshot');
    assert(again.kind === 'snapshot');
    assert.deepEqual(again.state, observed.state);
    assert.deepEqual(again.addedTxids, []);
    offlineTerminalsObserved++;
  }

  for (const source of [null, ...PARTICIPANT_IDS]) {
    const { graph, keysById } = await ready(source);
    const proposal = buildPresignedSpend({ graph, proposalId: randomUUID(), kind: 'cooperative', sourceExitId: source });
    // Separate nonce/partial generation per participant, without aggregating
    // private keys. These are the actual browser signing primitives.
    const nonces = proposal.participantIds.map(id => createPresignedCooperativeNonce({ graph, proposal,
      participantId: id, personalPrivateKey: keysById[id].personalPrivateKey, approvedProposalDigest: proposal.digest }));
    const publicNonces = nonces.map(item => item.publicNonce);
    const partials = nonces.map(item => signPresignedCooperativePartial({ graph, proposal,
      participantId: item.publicNonce.participantId,
      personalPrivateKey: keysById[item.publicNonce.participantId].personalPrivateKey,
      approvedProposalDigest: proposal.digest, publicNonces, nonceBinding: item.binding, consumedSecretNonce: item.secretNonce }));
    assert(nonces.every(item => item.secretNonce.every(byte => byte === 0)));
    const signed = finalizePresignedCooperative({ graph, proposal, publicNonces, partials });
    await hostileMutations(signed.transactionHex);
    await confirm(signed.transactionHex, signed.txid, graph);
    confirmed.push({ kind: 'cooperative', source, txid: signed.txid });
    console.log(JSON.stringify({ stage: 'cooperative-confirmed', source, participants: proposal.participantIds.length }));
  }

  for (const source of [null, ...PARTICIPANT_IDS]) {
    const participants = source === null ? PARTICIPANT_IDS : PARTICIPANT_IDS.filter(id => id !== source);
    for (const omitted of participants) {
      const { graph, keysById } = await ready(source);
      const proposal = buildPresignedSpend({ graph, proposalId: randomUUID(), kind: 'recovery', sourceExitId: source });
      const contributions = proposal.participantIds.filter(id => id !== omitted).map(id =>
        createPresignedRecoveryContribution({ graph, proposal, participantId: id,
          personalPrivateKey: keysById[id].personalPrivateKey, approvedProposalDigest: proposal.digest }));
      const signed = finalizePresignedRecovery({ graph, proposal, contributions });
      const early = await acceptable(signed.transactionHex, false);
      assert.equal(early['reject-reason'], 'non-BIP68-final');
      await core.mine(graph.roster.economics.recoveryDelayBlocks - 2);
      const oneEarly = await acceptable(signed.transactionHex, false);
      assert.equal(oneEarly['reject-reason'], 'non-BIP68-final');
      await core.mine();
      await hostileMutations(signed.transactionHex);
      await confirm(signed.transactionHex, signed.txid, graph);
      confirmed.push({ kind: 'recovery', source, omitted, txid: signed.txid });
      console.log(JSON.stringify({ stage: 'mature-recovery-confirmed', source, omitted,
        delayBlocks: graph.roster.economics.recoveryDelayBlocks }));
    }
  }

  for (const first of PARTICIPANT_IDS) for (const second of PARTICIPANT_IDS.filter(id => id !== first)) {
    const source = `${first}/${second}`;
    const { graph, keysById } = await ready(source);
    const proposal = buildPresignedSpend({ graph, proposalId: randomUUID(), kind: 'final-sweep', sourceExitId: source });
    const owner = proposal.source.owner!;
    const signed = signPresignedFinalSweep({ graph, proposal, participantId: owner,
      payoutPrivateKey: keysById[owner].payoutPrivateKey, approvedProposalDigest: proposal.digest });
    await hostileMutations(signed.transactionHex);
    await confirm(signed.transactionHex, signed.txid, graph);
    const payout = await core.rpc('gettxout', [signed.txid, 0, true]);
    assert.equal(Math.round(payout.value * 1e8), 9050);
    confirmed.push({ kind: 'final-sweep', source, txid: signed.txid });
    console.log(JSON.stringify({ stage: 'final-sweep-confirmed', source, owner }));
  }
  assert.equal(confirmed.filter(item => item.kind === 'cooperative').length, 4);
  assert.equal(confirmed.filter(item => item.kind === 'recovery').length, 9);
  assert.equal(confirmed.filter(item => item.kind === 'final-sweep').length, 6);
  assert.equal(rejected, 56);
  assert.equal(offlineTerminalsObserved, 19);
  const summary = { passed: true, protocol: 'presigned-graph-v2', chain: 'isolated-regtest',
    coreVersion: core.coreVersion, publicNetworkBroadcasts: 0, cooperativeRoundsConfirmed: 4,
    recoverySignerSubsetsConfirmed: 9, recoveryBoundaryChecks: 18, finalSweepsConfirmed: 6,
    invalidWitnessOrPayoutRejected: 38, offlineTerminalsObservedWithoutAnyServiceProposal: offlineTerminalsObserved,
    physicalPasskeysVerified: false, liveSignetVerified: false, confirmed };
  core.record('spends-acceptance', summary);
  console.log(JSON.stringify(summary, null, 2));
});
