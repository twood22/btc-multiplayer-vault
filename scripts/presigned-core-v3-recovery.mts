/** Actual two-leaf consensus checks; public fixture keys on network-disabled Core only. */
import assert from 'node:assert/strict';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { authorizePresignedFixtureRecoveries, createPresignedFixture, preauthorizePresignedFixture, signPresignedFixtureFunding } from '../src/presigned/fixtures.js';
import { buildPresignedGraph } from '../src/presigned/graph.js';
import { payoutScript } from '../src/presigned/roster.js';
import { completePresignedExit } from '../src/presigned/signing.js';
import { authorizePresignedSpendTransaction, buildPresignedSpend, createPresignedRecoveryContribution, finalizePresignedRecovery, signPresignedFinalSweep } from '../src/presigned/spends.js';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL_V3, type ParticipantId, type PresignedRecovery } from '../src/presigned/types.js';
import { withPresignedRegtest } from './lib/presigned-regtest.js';

await withPresignedRegtest(async core => {
  let confirmedRecoveryQuorums = 0;
  let confirmedNormalOrderings = 0;
  let freshCollusionRefusals = 0;
  let annexConsensusRefusals = 0;
  let witnessRefusals = 0;
  let exactBoundaryChecks = 0;
  let reorgBoundaryChecks = 0;
  const actualSizes: Record<string, number> = {};
  async function fund(includeAlternateSources = false) {
    const fixture = createPresignedFixture({ protocol: PRESIGNED_PROTOCOL_V3 });
    const allCoins = await core.fundScripts([...PARTICIPANT_IDS.map(id => ({ scriptPubKeyHex: fixture.walletKeys[id].scriptPubKeyHex, valueSats: 12_000 })),
      ...(includeAlternateSources ? fixture.graph.recoveries!.map(item => ({ scriptPubKeyHex: item.inputScriptPubKeyHex, valueSats: item.inputValueSats })) : [])]);
    const coins = allCoins.slice(0, 3);
    const alternateSources = Object.fromEntries(fixture.graph.recoveries!.map((item, index) => [item.roundId, allCoins[index + 3]]));
    fixture.graph = buildPresignedGraph({ roster: fixture.roster, funding: { ...fixture.graph.funding,
      inputs: coins.map((coin, index) => ({ ...coin, participantId: PARTICIPANT_IDS[index]!, changeScriptPubKeyHex: coin.scriptPubKeyHex })) } });
    // All twenty-one setup signatures precede the first funding signature.
    const preauthorizations = preauthorizePresignedFixture(fixture);
    const recoveryAuthorizations = authorizePresignedFixtureRecoveries(fixture);
    assert.equal(preauthorizations.length + recoveryAuthorizations.length, 21);
    await confirm(signPresignedFixtureFunding(fixture).transactionHex);
    return { ...fixture, preauthorizations, recoveryAuthorizations, alternateSources };
  }
  async function accepted(raw: string) { return (await core.rpc('testmempoolaccept', [[raw]]))[0]; }
  async function confirm(raw: string) {
    const result = await accepted(raw); assert.equal(result.allowed, true, JSON.stringify(result));
    const txid = await core.rpc('sendrawtransaction', [raw]); await core.mine();
    assert((await core.rpc('getrawtransaction', [txid, true])).confirmations >= 1);
    return txid as string;
  }
  function soloExit(f: Awaited<ReturnType<typeof fund>>, exitId: string) {
    const exit = f.graph.exits.find(item => item.id === exitId)!;
    return completePresignedExit({ graph: f.graph, preauthorizations: f.preauthorizations, exitId,
      participantId: exit.leaver, privateKey: f.keysById[exit.leaver].soloPrivateKeys[exit.roundId]!, approvedGraphDigest: f.graph.digest });
  }
  function colludingWitness(f: Awaited<ReturnType<typeof fund>>, recovery: PresignedRecovery, absent: ParticipantId,
    tx: bitcoin.Transaction, annex?: Buffer) {
    const round = f.graph.rounds.find(item => item.id === recovery.roundId)!;
    const message = tx.hashForWitnessV1(0, [Buffer.from(recovery.inputScriptPubKeyHex, 'hex')], [BigInt(recovery.inputValueSats)],
      bitcoin.Transaction.SIGHASH_DEFAULT, Buffer.from(round.recovery.leafHash, 'hex'), annex);
    const auth = round.recovery.authorizationParticipantIds!.map(id => id === absent
      ? Buffer.from(f.recoveryAuthorizations.find(item => item.recoveryId === recovery.id && item.participantId === id)!.signatureHex, 'hex')
      : Buffer.from(ecc.signSchnorr(message, f.keysById[id].recoveryAuthorizationPrivateKeys![round.id]!)));
    const triggers = round.recovery.participantIds.map(id => id === absent ? Buffer.alloc(0)
      : Buffer.from(ecc.signSchnorr(message, f.keysById[id].recoveryTriggerPrivateKeys![round.id]!)));
    tx.setWitness(0, [...triggers.reverse(), ...auth.reverse(), Buffer.from(round.recovery.scriptHex, 'hex'),
      Buffer.from(round.recovery.controlBlockHex, 'hex'), ...(annex ? [annex] : [])]);
    return { tx, message };
  }

  // Each absent member in each actual source round: 3 + 2 + 2 + 2.
  for (const sourceExitId of [null, ...PARTICIPANT_IDS]) {
    const members = PARTICIPANT_IDS.filter(id => id !== sourceExitId);
    for (const absent of members) {
      const f = await fund(true);
      if (sourceExitId) await confirm(soloExit(f, sourceExitId).transactionHex);
      const recovery = f.graph.recoveries!.find(item => item.parentExitId === sourceExitId)!;
      const round = f.graph.rounds.find(item => item.id === recovery.roundId)!;
      assert.equal(Buffer.from(round.recovery.controlBlockHex, 'hex').length, 65);
      const descriptor = await core.rpc('getdescriptorinfo', [round.descriptor]);
      const [address] = await core.rpc('deriveaddresses', [descriptor.descriptor]);
      assert.equal(Buffer.from(bitcoin.address.toOutputScript(address, bitcoin.networks.regtest)).toString('hex'), round.outputScriptHex,
        'Core must independently derive the exact committed two-leaf descriptor');
      const proposal = buildPresignedSpend({ graph: f.graph, proposalId: '44444444-4444-4444-8444-444444444444', kind: 'recovery', sourceExitId });
      const contributions = members.filter(id => id !== absent).map(id => createPresignedRecoveryContribution({ graph: f.graph,
        proposal, participantId: id, recoveryTriggerPrivateKey: f.keysById[id].recoveryTriggerPrivateKeys![round.id]!, approvedProposalDigest: proposal.digest }));
      const canonical = finalizePresignedRecovery({ graph: f.graph, proposal, contributions, recoveryAuthorizations: f.recoveryAuthorizations });
      assert.equal(canonical.txid, recovery.txid);
      actualSizes[String(members.length)] = canonical.vsize;
      assert.equal((await accepted(canonical.transactionHex)).allowed, false, 'new current coin must restart its CSV delay');
      await core.mine(f.graph.roster.economics.recoveryDelayBlocks - 2);
      const immature = await accepted(canonical.transactionHex);
      assert.equal(immature.allowed, false, 'candidate block immediately before maturity must refuse');
      assert.match(immature['reject-reason'], /non-BIP68-final/u);
      const [boundaryBlock] = await core.mine();
      assert.equal((await accepted(canonical.transactionHex)).allowed, true, 'candidate block exactly at maturity must accept');
      exactBoundaryChecks++;
      await core.rpc('invalidateblock', [boundaryBlock]);
      assert.equal((await accepted(canonical.transactionHex)).allowed, false, 'one-block reorg must restore immature status');
      await core.rpc('reconsiderblock', [boundaryBlock]);
      assert.equal((await accepted(canonical.transactionHex)).allowed, true);
      reorgBoundaryChecks++;

      const mutations: Array<{ name: string; change: (tx: bitcoin.Transaction) => void; annex?: Buffer }> = [
        { name: 'whole-vault-theft', change: tx => { tx.outs = [{ script: Buffer.from(f.walletKeys[members.find(id => id !== absent)!].scriptPubKeyHex, 'hex'), value: BigInt(recovery.inputValueSats - recovery.feeSats) }]; } },
        { name: 'one-satoshi-redistribution', change: tx => { const victim = recovery.recipientIds.indexOf(absent); tx.outs[victim]!.value--; tx.outs[(victim + 1) % tx.outs.length]!.value++; } },
        { name: 'changed-destination', change: tx => { tx.outs[recovery.recipientIds.indexOf(absent)]!.script = Buffer.from(f.walletKeys[members.find(id => id !== absent)!].scriptPubKeyHex, 'hex'); } },
        { name: 'raised-parent-fee', change: tx => { tx.outs[recovery.recipientIds.indexOf(absent)]!.value--; } },
        { name: 'reordered-outputs', change: tx => { tx.outs.reverse(); } },
        { name: 'removed-output', change: tx => { const removed = tx.outs.pop()!; tx.outs[0]!.value += removed.value; } },
        { name: 'added-output', change: tx => { tx.outs[0]!.value -= 330n; tx.outs.push({ script: Buffer.from(f.walletKeys.alice.scriptPubKeyHex, 'hex'), value: 330n }); } },
        { name: 'changed-version', change: tx => { tx.version = 2; } },
        { name: 'changed-input-same-script-value', change: tx => {
          const alternate = f.alternateSources[round.id]!;
          tx.ins[0]!.hash = Buffer.from(alternate.txid, 'hex').reverse(); tx.ins[0]!.index = alternate.vout;
        } },
        { name: 'changed-locktime', change: tx => { tx.locktime = 1; } },
        { name: 'disabled-sequence', change: tx => { tx.ins[0]!.sequence = 0xffffffff; } },
        { name: 'added-annex', change: () => {}, annex: Buffer.from('5001', 'hex') },
      ];
      for (const mutation of mutations) {
        const tx = bitcoin.Transaction.fromHex(recovery.unsignedTxHex); mutation.change(tx);
        const signed = colludingWitness(f, recovery, absent, tx, mutation.annex);
        const honestIndex = round.recovery.authorizationParticipantIds!.indexOf(absent);
        const honest = f.recoveryAuthorizations.find(item => item.recoveryId === recovery.id && item.participantId === absent)!;
        assert.equal(ecc.verifySchnorr(signed.message, Buffer.from(round.recovery.authorizationPublicKeys![honestIndex]!, 'hex'), Buffer.from(honest.signatureHex, 'hex')), false,
          `${mutation.name} must invalidate the absent member's required signature`);
        assert.throws(() => authorizePresignedSpendTransaction({ graph: f.graph, proposal, transactionHex: signed.tx.toHex() }));
        const result = await accepted(signed.tx.toHex());
        assert.equal(result.allowed, false, `${mutation.name}: ${JSON.stringify(result)}`);
        if (mutation.annex) {
          // Annex is nonstandard before script evaluation. Bypass relay policy
          // only inside this isolated test block and prove consensus rejection.
          assert.equal(result['reject-reason'], 'bad-witness-nonstandard');
          const tip = await core.rpc('getbestblockhash');
          await assert.rejects(core.rpc('generateblock', [await core.walletRpc('getnewaddress'), [signed.tx.toHex()]]), /TestBlockValidity|block not accepted|script|signature/u);
          assert.equal(await core.rpc('getbestblockhash'), tip, 'invalid annex spend must never change the active chain');
          annexConsensusRefusals++;
        } else assert.match(result['reject-reason'], /script|signature/u, mutation.name);
        freshCollusionRefusals++;
      }
      const canonicalTx = bitcoin.Transaction.fromHex(canonical.transactionHex);
      const n = members.length;
      const honestSlot = n + n - 1 - round.recovery.authorizationParticipantIds!.indexOf(absent);
      const triggeringSlot = n - 1 - round.recovery.participantIds.indexOf(members.find(id => id !== absent)!);
      const witnessChanges: Array<(tx: bitcoin.Transaction) => void> = [
        tx => { tx.ins[0]!.witness[honestSlot] = Buffer.alloc(0); },
        tx => { tx.ins[0]!.witness[triggeringSlot] = Buffer.alloc(0); },
        tx => { tx.ins[0]!.witness[triggeringSlot] = tx.ins[0]!.witness[honestSlot]!; },
        tx => { const absentTriggerSlot = n - 1 - round.recovery.participantIds.indexOf(absent); tx.ins[0]!.witness[absentTriggerSlot] = ecc.signSchnorr(Buffer.from(recovery.signatureHash, 'hex'), f.keysById[absent].recoveryTriggerPrivateKeys![round.id]!); },
        tx => { tx.ins[0]!.witness[honestSlot] = Buffer.concat([Buffer.from(tx.ins[0]!.witness[honestSlot]!), Buffer.from([1])]); },
        tx => { tx.ins[0]!.witness[tx.ins[0]!.witness.length - 1] = Buffer.from(round.solo.controlBlockHex, 'hex'); },
      ];
      for (const mutate of witnessChanges) {
        const tx = canonicalTx.clone(); mutate(tx);
        assert.throws(() => authorizePresignedSpendTransaction({ graph: f.graph, proposal, transactionHex: tx.toHex() }));
        assert.equal((await accepted(tx.toHex())).allowed, false);
        witnessRefusals++;
      }
      if (n === 3) {
        const duplicate = canonicalTx.clone();
        const selected = round.recovery.participantIds.map((id, index) => ({ id, index })).filter(item => item.id !== absent);
        duplicate.ins[0]!.witness[n - 1 - selected[1]!.index] = duplicate.ins[0]!.witness[n - 1 - selected[0]!.index]!;
        assert.equal((await accepted(duplicate.toHex())).allowed, false, 'one trigger signature cannot be counted as two');
        witnessRefusals++;
      }
      const legacy = createPresignedFixture().graph.rounds.find(item => item.id === round.id)!;
      const oldLeafTheft = bitcoin.Transaction.fromHex(recovery.unsignedTxHex);
      oldLeafTheft.outs = [{ script: Buffer.from(f.walletKeys[members.find(id => id !== absent)!].scriptPubKeyHex, 'hex'), value: BigInt(recovery.inputValueSats - recovery.feeSats) }];
      const oldMessage = oldLeafTheft.hashForWitnessV1(0, [Buffer.from(round.outputScriptHex, 'hex')], [BigInt(recovery.inputValueSats)],
        bitcoin.Transaction.SIGHASH_DEFAULT, Buffer.from(legacy.recovery.leafHash, 'hex'));
      oldLeafTheft.setWitness(0, [...legacy.recovery.participantIds.map(id => id === absent ? Buffer.alloc(0)
        : Buffer.from(ecc.signSchnorr(oldMessage, f.keysById[id].personalPrivateKey))).reverse(),
      Buffer.from(legacy.recovery.scriptHex, 'hex'), Buffer.from(legacy.recovery.controlBlockHex, 'hex')]);
      assert.equal((await accepted(oldLeafTheft.toHex())).allowed, false, 'the unrestricted V2 leaf must not exist in the V3 output');
      witnessRefusals++;
      const txid = await confirm(canonical.transactionHex);
      for (const [index, id] of recovery.recipientIds.entries()) {
        const coin = await core.rpc('gettxout', [txid, index, true]);
        assert.equal(coin.scriptPubKey.hex, payoutScript(f.graph.roster, id).toString('hex'));
        assert.equal(Math.round(coin.value * 1e8), Number(canonicalTx.outs[index]!.value));
      }
      confirmedRecoveryQuorums++;
      console.log(JSON.stringify({ stage: 'V3-fixed-recovery-confirmed', round: round.id, absent, vsize: canonical.vsize }));
    }
  }
  for (const first of PARTICIPANT_IDS) for (const second of PARTICIPANT_IDS.filter(id => id !== first)) {
    const f = await fund();
    const final = PARTICIPANT_IDS.find(id => id !== first && id !== second)!;
    const firstSigned = soloExit(f, first); await confirm(firstSigned.transactionHex);
    const secondSigned = soloExit(f, `${first}/${second}`); await confirm(secondSigned.transactionHex);
    assert.equal(bitcoin.Transaction.fromHex(firstSigned.transactionHex).outs[0]!.value, 9120n);
    assert.equal(bitcoin.Transaction.fromHex(secondSigned.transactionHex).outs[0]!.value, 9600n);
    const proposal = buildPresignedSpend({ graph: f.graph, proposalId: '55555555-5555-4555-8555-555555555555', kind: 'final-sweep', sourceExitId: `${first}/${second}` });
    const sweep = signPresignedFinalSweep({ graph: f.graph, proposal, participantId: final,
      payoutPrivateKey: f.keysById[final].payoutPrivateKey, approvedProposalDigest: proposal.digest });
    const txid = await confirm(sweep.transactionHex);
    const coin = await core.rpc('gettxout', [txid, 0, true]);
    assert.equal(Math.round(coin.value * 1e8), 10080);
    assert.equal(coin.scriptPubKey.hex, payoutScript(f.graph.roster, final).toString('hex'));
    confirmedNormalOrderings++;
  }
  assert.equal(confirmedRecoveryQuorums, 9);
  assert.equal(confirmedNormalOrderings, 6);
  const result = { passed: true, protocol: PRESIGNED_PROTOCOL_V3, coreVersion: core.coreVersion,
    actualBitcoinChain: 'isolated-regtest', confirmedRecoveryQuorums, confirmedNormalOrderings, freshCollusionRefusals,
    witnessRefusals, annexConsensusRefusals, exactBoundaryChecks, reorgBoundaryChecks, recoveryVsizeByMemberCount: actualSizes,
    publicNetworkBroadcasts: 0, mainnetFundingAuthorized: false };
  core.record('v3-fixed-recovery', result);
  console.log(JSON.stringify(result));
});
