/** Real consensus checks using public fixture keys on an isolated, network-disabled node. */
import assert from 'node:assert/strict';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { LAST_SURVIVOR_PAYOUT_SCHEDULE } from '../src/presigned/economics.js';
import { createPresignedFixture, preauthorizePresignedFixture, signPresignedFixtureFunding } from '../src/presigned/fixtures.js';
import { buildPresignedGraph } from '../src/presigned/graph.js';
import { payoutScript } from '../src/presigned/roster.js';
import { completePresignedExit } from '../src/presigned/signing.js';
import { authorizePresignedSpendTransaction, buildPresignedSpend, signPresignedFinalSweep } from '../src/presigned/spends.js';
import { PARTICIPANT_IDS } from '../src/presigned/types.js';
import { withPresignedRegtest } from './lib/presigned-regtest.js';

await withPresignedRegtest(async core => {
  let confirmedOrderings = 0;
  let changedPayoutsRejected = 0;
  let recoveryTrustCases = 0;
  async function fund() {
    const fixture = createPresignedFixture({ payoutSchedule: LAST_SURVIVOR_PAYOUT_SCHEDULE });
    const coins = await core.fundScripts(PARTICIPANT_IDS.map(id => ({
      scriptPubKeyHex: fixture.walletKeys[id].scriptPubKeyHex, valueSats: 12_000 })));
    fixture.graph = buildPresignedGraph({ roster: fixture.roster, funding: { ...fixture.graph.funding,
      inputs: coins.map((coin, index) => ({ ...coin, participantId: PARTICIPANT_IDS[index]!, changeScriptPubKeyHex: coin.scriptPubKeyHex })) } });
    const preauthorizations = preauthorizePresignedFixture(fixture);
    const signed = signPresignedFixtureFunding(fixture);
    await core.rpc('sendrawtransaction', [signed.transactionHex]); await core.mine();
    return { ...fixture, preauthorizations };
  }
  async function confirm(raw: string) {
    const policy = await core.rpc('testmempoolaccept', [[raw]]);
    assert.equal(policy[0].allowed, true, JSON.stringify(policy));
    const txid = await core.rpc('sendrawtransaction', [raw]); await core.mine();
    assert((await core.rpc('getrawtransaction', [txid, true])).confirmations >= 1);
    return txid as string;
  }
  for (const first of PARTICIPANT_IDS) for (const second of PARTICIPANT_IDS.filter(id => id !== first)) {
    const f = await fund(); const { graph } = f;
    const last = PARTICIPANT_IDS.find(id => id !== first && id !== second)!;
    for (const id of [first, `${first}/${second}`]) {
      const exit = graph.exits.find(entry => entry.id === id)!;
      const signed = completePresignedExit({ graph, preauthorizations: f.preauthorizations, exitId: id,
        participantId: exit.leaver, privateKey: f.keysById[exit.leaver].soloPrivateKeys[exit.roundId]!, approvedGraphDigest: graph.digest });
      const tx = bitcoin.Transaction.fromHex(signed.transactionHex);
      assert.equal(tx.outs[0]!.value, exit.parentExitId ? 9600n : 9120n);
      assert.deepEqual(Buffer.from(tx.outs[0]!.script), payoutScript(graph.roster, exit.leaver));
      const changed = tx.clone(); changed.outs[0]!.value++; changed.outs[1]!.value--;
      assert.equal((await core.rpc('testmempoolaccept', [[changed.toHex()]]))[0].allowed, false);
      changedPayoutsRejected++;
      await confirm(signed.transactionHex);
    }
    const proposal = buildPresignedSpend({ graph, proposalId: '44444444-4444-4444-8444-444444444444',
      kind: 'final-sweep', sourceExitId: `${first}/${second}` });
    const signed = signPresignedFinalSweep({ graph, proposal, participantId: last,
      payoutPrivateKey: f.keysById[last].payoutPrivateKey, approvedProposalDigest: proposal.digest });
    const txid = await confirm(signed.transactionHex);
    const coin = await core.rpc('gettxout', [txid, 0, true]);
    assert.equal(Math.round(coin.value * 1e8), 10080);
    assert.equal(coin.scriptPubKey.hex, payoutScript(graph.roster, last).toString('hex'));
    confirmedOrderings++;
    console.log(JSON.stringify({ ordering: `${first}/${second}/${last}`, payouts: [9120, 9600, 10080], confirmed: true }));
  }

  // Demonstrate the unchanged trust boundary: honest-app output restrictions
  // are not a covenant. These deliberately noncanonical spends never leave regtest.
  for (const sourceExitId of [null, 'alice'] as const) {
    const f = await fund(); const { graph } = f;
    if (sourceExitId) {
      const exit = graph.exits.find(entry => entry.id === sourceExitId)!;
      await confirm(completePresignedExit({ graph, preauthorizations: f.preauthorizations, exitId: sourceExitId,
        participantId: exit.leaver, privateKey: f.keysById[exit.leaver].soloPrivateKeys[exit.roundId]!, approvedGraphDigest: graph.digest }).transactionHex);
    }
    const proposal = buildPresignedSpend({ graph, proposalId: '55555555-5555-4555-8555-555555555555', kind: 'recovery', sourceExitId });
    const round = graph.rounds.find(entry => entry.id === proposal.source.roundId)!;
    assert.equal(round.recovery.threshold, sourceExitId ? 1 : 2);
    const tx = bitcoin.Transaction.fromHex(proposal.unsignedTxHex);
    tx.outs = [{ script: Buffer.from(f.walletKeys.alice.scriptPubKeyHex, 'hex'),
      value: BigInt(proposal.source.valueSats - proposal.feeSats) }];
    const hash = tx.hashForWitnessV1(0, [Buffer.from(proposal.source.scriptPubKeyHex, 'hex')],
      [BigInt(proposal.source.valueSats)], bitcoin.Transaction.SIGHASH_DEFAULT, Buffer.from(round.recovery.leafHash, 'hex'));
    const signatures = round.recovery.participantIds.map((id, index) => index < round.recovery.threshold
      ? Buffer.from(ecc.signSchnorr(hash, f.keysById[id].personalPrivateKey)) : Buffer.alloc(0));
    tx.setWitness(0, [...signatures.reverse(), Buffer.from(round.recovery.scriptHex, 'hex'), Buffer.from(round.recovery.controlBlockHex, 'hex')]);
    assert.throws(() => authorizePresignedSpendTransaction({ graph, proposal, transactionHex: tx.toHex() }), /spend changed the approved transaction/u);
    assert.equal((await core.rpc('testmempoolaccept', [[tx.toHex()]]))[0].allowed, false, 'recovery must still enforce its delay');
    await core.mine(graph.roster.economics.recoveryDelayBlocks);
    assert.equal((await core.rpc('testmempoolaccept', [[tx.toHex()]]))[0].allowed, true,
      'mature recovery quorum can choose arbitrary outputs even though the app refuses them');
    recoveryTrustCases++;
  }
  const summary = { passed: true, chain: 'isolated-regtest', coreVersion: core.coreVersion,
    payoutSchedule: LAST_SURVIVOR_PAYOUT_SCHEDULE, confirmedOrderings, changedPayoutsRejected,
    recoveryTrustCases, baseFeeNetPayouts: [9120, 9600, 10080], publicNetworkBroadcasts: 0, fundingAuthorized: false };
  core.record('last-survivor-economics', summary);
  console.log(JSON.stringify(summary));
});
