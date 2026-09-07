import assert from 'node:assert/strict';
import * as bitcoin from 'bitcoinjs-lib';
import { createPresignedFixture, preauthorizePresignedFixture, signPresignedFixtureFunding } from '../src/presigned/fixtures.js';
import { buildPresignedGraph } from '../src/presigned/graph.js';
import { completePresignedExit } from '../src/presigned/signing.js';
import { PARTICIPANT_IDS } from '../src/presigned/types.js';
import { withPresignedRegtest } from './lib/presigned-regtest.js';

await withPresignedRegtest(async core => {
  let acceptedExits = 0;
  let rejectedWitnesses = 0;
  let descriptorChecks = 0;
  const confirmed: Array<{ mask: number; fundingTxid: string; firstTxid: string; secondTxid: string; ordering: string }> = [];
  const orderings = PARTICIPANT_IDS.flatMap(first => PARTICIPANT_IDS.filter(second => second !== first).map(second => ({ first, second })));
  for (let mask = 0; mask < 8; mask++) {
    const fixture = createPresignedFixture({ walletKinds: PARTICIPANT_IDS.map((_, index) => mask & (1 << index) ? 'p2tr' : 'p2wpkh') });
    const coins = await core.fundScripts(PARTICIPANT_IDS.map(id => ({ scriptPubKeyHex: fixture.walletKeys[id].scriptPubKeyHex, valueSats: 12_000 })));
    fixture.graph = buildPresignedGraph({ roster: fixture.roster, funding: { ...fixture.graph.funding,
      inputs: coins.map((coin, index) => ({ ...coin, participantId: PARTICIPANT_IDS[index]!, changeScriptPubKeyHex: coin.scriptPubKeyHex })) } });
    const graph = fixture.graph;
    // The actual implementation now signs ALL descendants BEFORE wallet funding.
    const preauthorizations = preauthorizePresignedFixture(fixture);
    assert.equal(preauthorizations.length, 12);
    const funding = signPresignedFixtureFunding(fixture);
    assert.equal(funding.txid, graph.fundingTxid);
    for (const round of graph.rounds) {
      const descriptor = await core.rpc('getdescriptorinfo', [round.descriptor]);
      const [address] = await core.rpc('deriveaddresses', [descriptor.descriptor]);
      assert.equal(Buffer.from(bitcoin.address.toOutputScript(address, bitcoin.networks.regtest)).toString('hex'), round.outputScriptHex);
      descriptorChecks++;
    }
    const fundingAcceptance = await core.rpc('testmempoolaccept', [[funding.transactionHex]]);
    assert.equal(fundingAcceptance[0].allowed, true, JSON.stringify(fundingAcceptance));
    assert.equal(await core.rpc('sendrawtransaction', [funding.transactionHex]), graph.fundingTxid);
    await core.mine();
    const signed = new Map(graph.exits.map(exit => [exit.id, completePresignedExit({ graph, preauthorizations,
      exitId: exit.id, participantId: exit.leaver, privateKey: fixture.keysById[exit.leaver].soloPrivateKeys[exit.roundId]!, approvedGraphDigest: graph.digest })]));
    for (const exit of graph.exits) {
      const complete = signed.get(exit.id)!;
      const prefix = exit.parentExitId ? [signed.get(exit.parentExitId)!.transactionHex] : [];
      const acceptance = await core.rpc('testmempoolaccept', [[...prefix, complete.transactionHex]]);
      assert.equal(acceptance.at(-1).allowed, true, JSON.stringify(acceptance));
      acceptedExits++;
      const missing = bitcoin.Transaction.fromHex(complete.transactionHex);
      const round = graph.rounds.find(round => round.id === exit.roundId)!;
      missing.ins[0]!.witness[round.solo.threshold - 1 - round.solo.participantIds.indexOf(exit.leaver)] = Buffer.alloc(0);
      const missingAcceptance = await core.rpc('testmempoolaccept', [[...prefix, missing.toHex()]]);
      assert.equal(missingAcceptance.at(-1).allowed, false, 'Core accepted missing leaver signature');
      const changed = bitcoin.Transaction.fromHex(complete.transactionHex);
      changed.outs[0]!.value += 1n; changed.outs[1]!.value -= 1n;
      const changedAcceptance = await core.rpc('testmempoolaccept', [[...prefix, changed.toHex()]]);
      assert.equal(changedAcceptance.at(-1).allowed, false, 'Core accepted mutated payout');
      rejectedWitnesses += 2;
    }
    const ordering = orderings[mask % orderings.length]!;
    const first = signed.get(ordering.first)!;
    const second = signed.get(`${ordering.first}/${ordering.second}`)!;
    assert.equal(await core.rpc('sendrawtransaction', [first.transactionHex]), first.txid);
    await core.mine();
    assert.equal(await core.rpc('sendrawtransaction', [second.transactionHex]), second.txid);
    await core.mine();
    const finalCoin = await core.rpc('gettxout', [second.txid, 1, true]);
    assert.equal(Math.round(finalCoin.value * 1e8), 9350);
    confirmed.push({ mask, fundingTxid: funding.txid, firstTxid: first.txid, secondTxid: second.txid, ordering: `${ordering.first}/${ordering.second}` });
    console.log(JSON.stringify({ stage: 'funding-format-verified', mask, ordering: `${ordering.first}/${ordering.second}`, acceptedExits, rejectedWitnesses }));
  }
  assert.equal(new Set(confirmed.map(run => run.ordering)).size, 6);
  const summary = { protocol: 'presigned-graph-v2', passed: true, chain: 'isolated-regtest', coreVersion: core.coreVersion,
    publicNetworkBroadcasts: 0, fundingFormats: 8, fullExitOrderingsConfirmed: 6, acceptedExits, rejectedWitnesses,
    descriptorChecks, preauthorizationsBeforeFundingSignatures: true,
    cooperativeVerified: false, recoveryVerified: false, finalSweepVerified: false, cpfpVerified: false,
    browserVerified: false, liveSignetVerified: false, confirmed };
  core.record('graph-acceptance', summary);
  console.log(JSON.stringify(summary, null, 2));
});
