/** Real Core checks, public fixture keys and isolated regtest coins only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { createPresignedFixture, preauthorizePresignedFixture, signPresignedFixtureFunding } from '../src/presigned/fixtures.js';
import { buildPresignedGraph } from '../src/presigned/graph.js';
import { completePresignedExit } from '../src/presigned/signing.js';
import { buildPresignedSpend, createPresignedCooperativeNonce, createPresignedRecoveryContribution,
  finalizePresignedCooperative, finalizePresignedRecovery, signPresignedCooperativePartial,
  signPresignedFinalSweep, type PresignedSpendKind, type PresignedSpendProposal } from '../src/presigned/spends.js';
import { buildPresignedSpendFeeChild, signPresignedSpendFeePayout, finalizePresignedSpendFeeChild,
  type PresignedSpendFeeRequest } from '../src/presigned/spend-fees.js';
import { PARTICIPANT_IDS, type ParticipantId, type PresignedGraph } from '../src/presigned/types.js';
import { type FeeCoinObservation } from '../src/presigned/fees.js';
import { withPresignedRegtest, type PresignedRegtest } from './lib/presigned-regtest.js';

type Fixture = ReturnType<typeof createPresignedFixture>;

function signedParent(fixture: Fixture, proposal: PresignedSpendProposal) {
  const { graph, keysById } = fixture;
  if (proposal.kind === 'final-sweep') {
    const id = proposal.source.owner!;
    return signPresignedFinalSweep({ graph, proposal, participantId: id,
      payoutPrivateKey: keysById[id].payoutPrivateKey, approvedProposalDigest: proposal.digest });
  }
  if (proposal.kind === 'recovery') return finalizePresignedRecovery({ graph, proposal,
    contributions: proposal.participantIds.slice(0, proposal.threshold).map(id => createPresignedRecoveryContribution({
      graph, proposal, participantId: id, personalPrivateKey: keysById[id].personalPrivateKey, approvedProposalDigest: proposal.digest })) });
  const generated = proposal.participantIds.map(id => createPresignedCooperativeNonce({ graph, proposal,
    participantId: id, personalPrivateKey: keysById[id].personalPrivateKey, approvedProposalDigest: proposal.digest }));
  const publicNonces = generated.map(item => item.publicNonce);
  const partials = generated.map(item => signPresignedCooperativePartial({ graph, proposal,
    participantId: item.publicNonce.participantId, personalPrivateKey: keysById[item.publicNonce.participantId].personalPrivateKey,
    approvedProposalDigest: proposal.digest, publicNonces, nonceBinding: item.binding, consumedSecretNonce: item.secretNonce }));
  assert(generated.every(item => item.secretNonce.every(byte => byte === 0)));
  return finalizePresignedCooperative({ graph, proposal, publicNonces, partials });
}

async function observed(core: PresignedRegtest, graph: PresignedGraph, txid: string, vout: number): Promise<FeeCoinObservation> {
  const coin = await core.rpc('gettxout', [txid, vout, false]);
  assert(coin && coin.confirmations >= 1 && coin.coinbase === false, 'fee source must be confirmed and unspent in the actual active chain');
  const tx = await core.rpc('getrawtransaction', [txid, true]);
  const block = await core.rpc('getblockheader', [tx.blockhash]);
  assert(block.confirmations >= 1 && await core.rpc('getblockhash', [block.height]) === tx.blockhash);
  return { network: graph.roster.network, genesisHash: graph.roster.genesisHash, txid, vout,
    valueSats: Math.round(coin.value * 1e8), scriptPubKeyHex: coin.scriptPubKey.hex,
    confirmationBlockHash: tx.blockhash, confirmations: coin.confirmations, unspentInActiveChain: true, coinbase: false };
}

async function feeChild(core: PresignedRegtest, fixture: Fixture, request: PresignedSpendFeeRequest) {
  const built = buildPresignedSpendFeeChild(request);
  const payout = signPresignedSpendFeePayout({ request, psbtBase64: built.psbtBase64, approvalDigest: built.approvalDigest,
    keys: fixture.keysById[request.payoutParticipantId] });
  const wallet = await core.walletRpc('walletprocesspsbt', [built.psbtBase64, true, 'ALL', true, false]);
  return finalizePresignedSpendFeeChild({ request, approvalDigest: built.approvalDigest,
    payoutSignatureHex: payout.payoutSignatureHex, sponsorSignedPsbtBase64: wallet.psbt });
}

async function submit(core: PresignedRegtest, label: string, parentHex: string, childHex: string) {
  const response = await core.rpc('submitpackage', [[parentHex, childHex]]);
  core.record(label, response);
  assert.equal(response.package_msg, 'success', JSON.stringify(response));
  const results = Object.values(response['tx-results']) as any[];
  for (const hex of [parentHex, childHex]) {
    const txid = bitcoin.Transaction.fromHex(hex).getId();
    assert(results.some(result => result.txid === txid && !result.error), JSON.stringify(response));
    assert(await core.rpc('getmempoolentry', [txid]));
  }
  return response;
}

await withPresignedRegtest(async core => {
  try {
    const results: Array<Record<string, unknown>> = [];
    const cases: Array<{ label: string; kind: PresignedSpendKind; source: string | null; volunteer: ParticipantId }> = [
      { label: 'abc-cooperative', kind: 'cooperative', source: null, volunteer: 'carol' },
      { label: 'pair-cooperative', kind: 'cooperative', source: 'alice', volunteer: 'carol' },
      { label: 'abc-recovery', kind: 'recovery', source: null, volunteer: 'bob' },
      { label: 'pair-recovery', kind: 'recovery', source: 'bob', volunteer: 'carol' },
      { label: 'final-sweep', kind: 'final-sweep', source: 'alice/bob', volunteer: 'carol' },
    ];
    for (const [caseIndex, item] of cases.entries()) {
      const fixture = createPresignedFixture();
      const sponsorScripts = await Promise.all(['bech32m', 'bech32'].map(async kind => {
        const address = await core.walletRpc('getnewaddress', [`${item.label}-${kind}`, kind]);
        return Buffer.from(bitcoin.address.toOutputScript(address, bitcoin.networks.regtest)).toString('hex');
      }));
      const coins = await core.fundScripts([
        ...PARTICIPANT_IDS.map(id => ({ scriptPubKeyHex: fixture.walletKeys[id].scriptPubKeyHex, valueSats: 12_000 })),
        ...sponsorScripts.map(scriptPubKeyHex => ({ scriptPubKeyHex, valueSats: 50_000 })),
      ]);
      assert.equal(await core.walletRpc('lockunspent', [false, coins.slice(3).map(coin => ({ txid: coin.txid, vout: coin.vout }))]), true);
      fixture.graph = buildPresignedGraph({ roster: fixture.roster, funding: { ...fixture.graph.funding,
        inputs: coins.slice(0, 3).map((coin, index) => ({ ...coin, participantId: PARTICIPANT_IDS[index]!, changeScriptPubKeyHex: coin.scriptPubKeyHex })) } });
      const { graph, keysById } = fixture;
      const graphCommitment = JSON.stringify(graph);
      const preauthorizations = preauthorizePresignedFixture(fixture);
      const funding = signPresignedFixtureFunding(fixture);
      assert.equal(bitcoin.Transaction.fromHex(funding.transactionHex).version, 3);
      await core.rpc('sendrawtransaction', [funding.transactionHex]);
      await core.mine();
      if (item.source !== null) for (const exitId of item.source.includes('/') ? [item.source.split('/')[0]!, item.source] : [item.source]) {
        const exit = graph.exits.find(exit => exit.id === exitId)!;
        const signed = completePresignedExit({ graph, preauthorizations, exitId, participantId: exit.leaver,
          privateKey: keysById[exit.leaver].soloPrivateKeys[exit.roundId]!, approvedGraphDigest: graph.digest });
        await core.rpc('sendrawtransaction', [signed.transactionHex]);
        await core.mine();
      }
      const proposal = buildPresignedSpend({ graph, proposalId: randomUUID(), kind: item.kind, sourceExitId: item.source });
      const proposalCommitment = JSON.stringify(proposal);
      const parent = signedParent(fixture, proposal);
      const parentTx = bitcoin.Transaction.fromHex(parent.transactionHex);
      assert.equal(parentTx.version, 3);
      const sponsorIndex = caseIndex % 2;
      let request: PresignedSpendFeeRequest = { graph, parentSpendProposal: proposal, parentTransactionHex: parent.transactionHex,
        payoutParticipantId: item.volunteer, sourceObservation: await observed(core, graph, proposal.source.txid, proposal.source.vout),
        sponsorInput: await observed(core, graph, coins[3 + sponsorIndex]!.txid, coins[3 + sponsorIndex]!.vout),
        approval: { childFeeSats: 3_000, maxChildFeeSats: 10_000, targetPackageRateMillisatsPerVbyte: 5_000,
          minRelayRateMillisatsPerVbyte: 1_000, sponsorChangeScriptPubKeyHex: sponsorScripts[sponsorIndex]!,
          approveExactNoChangeFee: false, replacement: null } };
      if (item.kind === 'recovery') {
        const early = await core.rpc('testmempoolaccept', [[parent.transactionHex]]);
        assert.equal(early[0].allowed, false);
        assert.equal(early[0]['reject-reason'], 'non-BIP68-final');
        core.record(`${item.label}-immature-parent`, early);
        assert.throws(() => buildPresignedSpendFeeChild(request), /CSV age/);
        await core.mine(graph.roster.economics.recoveryDelayBlocks - 1);
        request = { ...request, sourceObservation: await observed(core, graph, proposal.source.txid, proposal.source.vout) };
      }
      const outsider = PARTICIPANT_IDS.find(id => !proposal.participantIds.includes(id));
      if (outsider) assert.throws(() => buildPresignedSpendFeeChild({ ...request, payoutParticipantId: outsider }), /does not own/);
      assert.throws(() => buildPresignedSpendFeeChild({ ...request, sponsorInput: { ...request.sponsorInput, txid: parent.txid, vout: 0 } }), /every payout/);
      assert.throws(() => buildPresignedSpendFeeChild({ ...request, approval: { ...request.approval, childFeeSats: 10_001 } }), /fee/);
      const child = await feeChild(core, fixture, request);
      await submit(core, `${item.label}-parent-child-package`, parent.transactionHex, child.transactionHex);
      const replacementRequest: PresignedSpendFeeRequest = { ...request, approval: { ...request.approval, childFeeSats: 4_000,
        replacement: { previousChildTransactionHex: child.transactionHex, incrementalRelayRateMillisatsPerVbyte: 1_000 } } };
      let activeChild = await feeChild(core, fixture, replacementRequest);
      let activeRequest = replacementRequest;
      const replacement = await submit(core, `${item.label}-child-replacement`, parent.transactionHex, activeChild.transactionHex);
      assert((replacement['replaced-transactions'] ?? []).includes(child.txid));
      let differentVolunteerSiblingEviction = false;
      if (item.label === 'abc-cooperative') {
        // Independent volunteer and independent confirmed sponsor: no inputs
        // conflict. Core must use TRUC sibling eviction, not ordinary RBF.
        activeRequest = { ...request, payoutParticipantId: 'alice',
          sponsorInput: await observed(core, graph, coins[4]!.txid, coins[4]!.vout),
          approval: { ...request.approval, childFeeSats: 5_000, sponsorChangeScriptPubKeyHex: sponsorScripts[1]!, replacement: null } };
        const alternate = await feeChild(core, fixture, activeRequest);
        const before = bitcoin.Transaction.fromHex(activeChild.transactionHex);
        const after = bitcoin.Transaction.fromHex(alternate.transactionHex);
        assert(!before.ins.some(a => after.ins.some(b => Buffer.from(a.hash).equals(Buffer.from(b.hash)) && a.index === b.index)));
        const sibling = await submit(core, 'abc-cooperative-different-volunteer-sibling', parent.transactionHex, alternate.transactionHex);
        assert((sibling['replaced-transactions'] ?? []).includes(activeChild.txid));
        activeChild = alternate;
        differentVolunteerSiblingEviction = true;
      }
      await core.mine();
      assert((await core.rpc('getrawtransaction', [parent.txid, true])).confirmations >= 1);
      assert((await core.rpc('getrawtransaction', [activeChild.txid, true])).confirmations >= 1);
      for (const [index, output] of parentTx.outs.entries()) {
        const coin = index === activeChild.payoutVout ? await core.rpc('gettxout', [activeChild.txid, 0, true])
          : await core.rpc('gettxout', [parent.txid, index, true]);
        assert(coin, 'fee child consumed or stranded another participant payout');
        assert.equal(Math.round(coin.value * 1e8), Number(output.value));
        assert.equal(coin.scriptPubKey.hex, Buffer.from(output.script).toString('hex'));
      }
      const change = await core.rpc('gettxout', [activeChild.txid, 1, true]);
      assert.equal(Math.round(change.value * 1e8), activeRequest.sponsorInput.valueSats - activeChild.childFeeSats);
      assert.equal(JSON.stringify(graph), graphCommitment);
      assert.equal(JSON.stringify(proposal), proposalCommitment);
      results.push({ ...item, parentTxid: parent.txid, feeChildTxid: activeChild.txid,
        initialPayoutVout: child.payoutVout, confirmedPayoutVout: activeChild.payoutVout,
        parentFeeSats: parent.feeSats, unchangedParentPayoutsSats: parentTx.outs.map(output => Number(output.value)),
        differentVolunteerSiblingEviction, actualCoreWalletSigning: true });
      console.log(JSON.stringify({ stage: 'spend-fee-package-confirmed', ...item, selectedPayout: activeChild.payoutVout }));
    }
    assert.equal(results.length, 5);
    const summary = { passed: true, protocol: 'presigned-graph-v2', chain: 'isolated-regtest', coreVersion: core.coreVersion,
      publicNetworkBroadcasts: 0, actualCoreWalletSponsorKinds: ['p2tr-all', 'p2wpkh'],
      parentAndChildVersionThree: true, confirmedPackagesAndReplacements: 5,
      differentVolunteerSiblingEviction: true, csvAgeCheckedInApplicationAndCore: true,
      everyPayoutPreserved: true, noFakeSoloGraphOrAggregatePrivateKey: true,
      highRollingFloorTestedInThisSuite: false, liveSignetVerified: false, browserOrPhysicalPasskeysVerified: false,
      evidence: core.directory, results };
    core.record('spend-fees-acceptance', summary);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    core.record('spend-fees-failure', { message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null });
    throw error;
  }
});
