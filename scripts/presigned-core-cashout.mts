/** Actual Bitcoin execution with public fixture keys, network-disabled regtest only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as bitcoin from 'bitcoinjs-lib';
import { createPresignedPublicKit } from '../src/presigned/backup.js';
import { buildPresignedCashout, signPresignedCashout, authorizePresignedCashoutTransaction,
  type PresignedCashoutRequest } from '../src/presigned/cashout.js';
import { createPresignedFixture, preauthorizePresignedFixture, authorizePresignedFixtureRecoveries,
  signPresignedFixtureFunding } from '../src/presigned/fixtures.js';
import { buildPresignedGraph } from '../src/presigned/graph.js';
import { completePresignedExit } from '../src/presigned/signing.js';
import { buildPresignedFeeChild, signPresignedFeePayout, finalizePresignedFeeChild, type FeeCoinObservation } from '../src/presigned/fees.js';
import { buildPresignedSpend, createPresignedCooperativeNonce, createPresignedRecoveryContribution,
  finalizePresignedCooperative, finalizePresignedRecovery, signPresignedCooperativePartial, signPresignedFinalSweep } from '../src/presigned/spends.js';
import { payoutScript } from '../src/presigned/roster.js';
import { networkParameters } from '../src/presigned/validation.js';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3,
  type ParticipantId, type PresignedGraph, type PresignedProtocol } from '../src/presigned/types.js';
import { withPresignedRegtest } from './lib/presigned-regtest.js';

await withPresignedRegtest(async core => {
  let confirmedCashouts = 0; let rejectedMutations = 0; let confirmedParents = 0;
  const families = new Set<string>(); const addresses = new Set<string>();
  const sizes = new Set<number>();
  async function confirm(raw: string) {
    const result = (await core.rpc('testmempoolaccept', [[raw]]))[0]; assert.equal(result.allowed, true, JSON.stringify(result));
    const txid = await core.rpc('sendrawtransaction', [raw]); await core.mine();
    assert((await core.rpc('getrawtransaction', [txid, true])).confirmations >= 1);
    return txid as string;
  }
  async function observed(graph: PresignedGraph, txid: string, vout: number): Promise<FeeCoinObservation> {
    const coin = await core.rpc('gettxout', [txid, vout, true]);
    assert(coin && coin.confirmations >= 1 && coin.coinbase === false, 'cash-out test coin must be actually confirmed and mempool-unspent');
    const tx = await core.rpc('getrawtransaction', [txid, true]);
    const header = await core.rpc('getblockheader', [tx.blockhash]);
    assert(header.confirmations >= 1 && await core.rpc('getblockhash', [header.height]) === tx.blockhash);
    // Relabel only the network format for the production primitive. The actual
    // chain, coin, parent bytes and signatures are regtest, never Signet proof.
    return { network: graph.roster.network, genesisHash: graph.roster.genesisHash, txid, vout,
      valueSats: Math.round(coin.value * 1e8), scriptPubKeyHex: coin.scriptPubKey.hex,
      confirmationBlockHash: tx.blockhash, confirmations: coin.confirmations, unspentInActiveChain: true, coinbase: false };
  }
  async function fund(protocol: PresignedProtocol) {
    const f = createPresignedFixture({ protocol });
    const coins = await core.fundScripts(PARTICIPANT_IDS.map(id => ({ scriptPubKeyHex: f.walletKeys[id].scriptPubKeyHex, valueSats: 12000 })));
    f.graph = buildPresignedGraph({ roster: f.roster, funding: { ...f.graph.funding,
      inputs: coins.map((coin, i) => ({ ...coin, participantId: PARTICIPANT_IDS[i]!, changeScriptPubKeyHex: coin.scriptPubKeyHex })) } });
    const preauthorizations = preauthorizePresignedFixture(f);
    const recoveryAuthorizations = protocol === PRESIGNED_PROTOCOL_V3 ? authorizePresignedFixtureRecoveries(f) : undefined;
    const publicKit = createPresignedPublicKit({ graph: f.graph, preauthorizations, ...(recoveryAuthorizations ? { recoveryAuthorizations } : {}) });
    await confirm(signPresignedFixtureFunding(f).transactionHex);
    return { ...f, preauthorizations, recoveryAuthorizations, publicKit };
  }
  type Funded = Awaited<ReturnType<typeof fund>>;
  async function solo(f: Funded, exitId: string) {
    const exit = f.graph.exits.find(item => item.id === exitId)!;
    const signed = completePresignedExit({ graph: f.graph, preauthorizations: f.preauthorizations, exitId,
      participantId: exit.leaver, privateKey: f.keysById[exit.leaver].soloPrivateKeys[exit.roundId]!, approvedGraphDigest: f.graph.digest });
    await confirm(signed.transactionHex); confirmedParents++; return signed;
  }
  async function cashout(f: Funded, family: string, rawParent: string, vout: number, owner: ParticipantId) {
    const parent = bitcoin.Transaction.fromHex(rawParent);
    const point = f.walletKeys.bob.publicKey; const network = networkParameters(f.graph.roster.network);
    const witness = bitcoin.payments.p2wpkh({ pubkey: point, network });
    const destinations = [bitcoin.payments.p2pkh({ pubkey: point, network }), bitcoin.payments.p2sh({ redeem: witness, network }),
      witness, bitcoin.payments.p2wsh({ redeem: { output: bitcoin.script.compile([point, bitcoin.opcodes.OP_CHECKSIG]) }, network }),
      bitcoin.payments.p2tr({ internalPubkey: point.subarray(1), network })];
    const destination = destinations[confirmedCashouts % destinations.length]!;
    const request: PresignedCashoutRequest = { publicKit: f.publicKit, participantId: owner, parentTransactionHex: rawParent,
      sourceObservation: await observed(f.graph, parent.getId(), vout), destinationAddress: destination.address!, feeSats: 300, maxFeeSats: 1000 };
    assert.throws(() => buildPresignedCashout({ ...request, sourceObservation: { ...request.sourceObservation, confirmations: 0 } }));
    const built = buildPresignedCashout(request);
    const keys = { ...f.keysById[owner], payoutPrivateKey: Buffer.from(f.keysById[owner].payoutPrivateKey) };
    const signed = signPresignedCashout({ request, cashout: built, keys, approvedCashoutDigest: built.digest });
    assert(keys.payoutPrivateKey.every(byte => byte === 0));
    const mutations: Array<(tx: bitcoin.Transaction) => void> = [
      tx => { tx.outs[0]!.value--; }, tx => { tx.outs[0]!.script = payoutScript(f.graph.roster, owner); },
      tx => { tx.version = 3; }, tx => { tx.locktime = 1; }, tx => { tx.ins[0]!.sequence = 0xffffffff; },
      tx => { tx.ins[0]!.witness[0] = Buffer.alloc(64); },
      tx => { tx.ins[0]!.witness[0] = Buffer.concat([Buffer.from(tx.ins[0]!.witness[0]!), Buffer.from([1])]); },
      tx => { tx.ins[0]!.witness.push(Buffer.from('5001', 'hex')); },
    ];
    for (const mutate of mutations) {
      const tx = bitcoin.Transaction.fromHex(signed.transactionHex); mutate(tx);
      assert.throws(() => authorizePresignedCashoutTransaction({ request, cashout: built, transactionHex: tx.toHex() }));
      const result = (await core.rpc('testmempoolaccept', [[tx.toHex()]]))[0];
      assert.equal(result.allowed, false, JSON.stringify(result)); rejectedMutations++;
    }
    await confirm(signed.transactionHex);
    assert.equal(await core.rpc('gettxout', [parent.getId(), vout, true]), null);
    const paid = await core.rpc('gettxout', [signed.txid, 0, true]);
    assert.equal(paid.scriptPubKey.hex, Buffer.from(destination.output!).toString('hex'));
    assert.equal(Math.round(paid.value * 1e8), request.sourceObservation.valueSats - 300);
    assert.equal(bitcoin.Transaction.fromHex(signed.transactionHex).version, 2);
    sizes.add(signed.vsize); families.add(family); addresses.add(paid.scriptPubKey.type); confirmedCashouts++;
    console.log(JSON.stringify({ stage: 'owned-payout-cashout-confirmed', protocol: f.graph.protocol, family, owner, vsize: signed.vsize }));
  }
  for (const protocol of [PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3]) {
    const normal = await fund(protocol);
    const first = await solo(normal, 'alice'); await cashout(normal, 'solo-first', first.transactionHex, 0, 'alice');
    const second = await solo(normal, 'alice/bob'); await cashout(normal, 'solo-second', second.transactionHex, 0, 'bob');
    const sweepProposal = buildPresignedSpend({ graph: normal.graph, proposalId: randomUUID(), kind: 'final-sweep', sourceExitId: 'alice/bob' });
    const sweep = signPresignedFinalSweep({ graph: normal.graph, proposal: sweepProposal, participantId: 'carol',
      payoutPrivateKey: normal.keysById.carol.payoutPrivateKey, approvedProposalDigest: sweepProposal.digest });
    await confirm(sweep.transactionHex); confirmedParents++; await cashout(normal, 'final-sweep', sweep.transactionHex, 0, 'carol');
    const directFinal = await fund(protocol); await solo(directFinal, 'alice');
    const last = await solo(directFinal, 'alice/bob'); await cashout(directFinal, 'final-owned', last.transactionHex, 1, 'carol');

    const coop = await fund(protocol);
    const proposal = buildPresignedSpend({ graph: coop.graph, proposalId: randomUUID(), kind: 'cooperative', sourceExitId: null });
    const nonces = proposal.participantIds.map(id => createPresignedCooperativeNonce({ graph: coop.graph, proposal, participantId: id,
      personalPrivateKey: coop.keysById[id].personalPrivateKey, approvedProposalDigest: proposal.digest }));
    const publicNonces = nonces.map(item => item.publicNonce);
    const partials = nonces.map(item => signPresignedCooperativePartial({ graph: coop.graph, proposal,
      participantId: item.publicNonce.participantId, personalPrivateKey: coop.keysById[item.publicNonce.participantId].personalPrivateKey,
      approvedProposalDigest: proposal.digest, publicNonces, nonceBinding: item.binding, consumedSecretNonce: item.secretNonce }));
    const cooperative = finalizePresignedCooperative({ graph: coop.graph, proposal, publicNonces, partials });
    await confirm(cooperative.transactionHex); confirmedParents++;
    for (const [vout, owner] of PARTICIPANT_IDS.entries()) await cashout(coop, 'cooperative', cooperative.transactionHex, vout, owner);

    const refund = await fund(protocol);
    const recovery = buildPresignedSpend({ graph: refund.graph, proposalId: randomUUID(), kind: 'recovery', sourceExitId: null });
    const contributions = PARTICIPANT_IDS.slice(0, 2).map(id => createPresignedRecoveryContribution({ graph: refund.graph,
      proposal: recovery, participantId: id, approvedProposalDigest: recovery.digest,
      ...(protocol === PRESIGNED_PROTOCOL_V3 ? { recoveryTriggerPrivateKey: refund.keysById[id].recoveryTriggerPrivateKeys![recovery.source.roundId!]! }
        : { personalPrivateKey: refund.keysById[id].personalPrivateKey }) }));
    const recovered = finalizePresignedRecovery({ graph: refund.graph, proposal: recovery, contributions,
      ...(refund.recoveryAuthorizations ? { recoveryAuthorizations: refund.recoveryAuthorizations } : {}) });
    await core.mine(refund.graph.roster.economics.recoveryDelayBlocks); await confirm(recovered.transactionHex); confirmedParents++;
    for (const [vout, owner] of PARTICIPANT_IDS.entries()) await cashout(refund, 'recovery', recovered.transactionHex, vout, owner);

    const cpfp = await fund(protocol);
    const source = await observed(cpfp.graph, cpfp.graph.fundingTxid, 0);
    const parent = await solo(cpfp, 'alice');
    const sponsorAddress = await core.walletRpc('getnewaddress', ['cash-out-sponsor', 'bech32']);
    const sponsorScript = Buffer.from(bitcoin.address.toOutputScript(sponsorAddress, bitcoin.networks.regtest)).toString('hex');
    const [sponsor] = await core.fundScripts([{ scriptPubKeyHex: sponsorScript, valueSats: 10000 }]);
    const feeRequest = { graph: cpfp.graph, exitId: 'alice', parentTransactionHex: parent.transactionHex, roundInputObservation: source,
      sponsorInput: await observed(cpfp.graph, sponsor!.txid, sponsor!.vout), approval: { childFeeSats: 1000, maxChildFeeSats: 2000,
        targetPackageRateMillisatsPerVbyte: 1000, minRelayRateMillisatsPerVbyte: 1000,
        sponsorChangeScriptPubKeyHex: sponsorScript, approveExactNoChangeFee: false, replacement: null } };
    const child = buildPresignedFeeChild(feeRequest);
    const payout = signPresignedFeePayout({ request: feeRequest, psbtBase64: child.psbtBase64, approvalDigest: child.approvalDigest, keys: cpfp.keysById.alice });
    const walletSigned = await core.walletRpc('walletprocesspsbt', [child.psbtBase64, true, 'ALL', true, false]);
    const completed = finalizePresignedFeeChild({ request: feeRequest, approvalDigest: child.approvalDigest,
      payoutSignatureHex: payout.payoutSignatureHex, sponsorSignedPsbtBase64: walletSigned.psbt });
    await confirm(completed.transactionHex); confirmedParents++; await cashout(cpfp, 'cpfp-preserved-payout', completed.transactionHex, 0, 'alice');
    const [owned] = await core.fundScripts([{ scriptPubKeyHex: payoutScript(cpfp.graph.roster, 'bob').toString('hex'), valueSats: 5000 }]);
    const rawOwned = await core.rpc('getrawtransaction', [owned!.txid, false]);
    await cashout(cpfp, 'independently-owned-same-key', rawOwned, owned!.vout, 'bob');
  }
  assert.equal(confirmedCashouts, 24); assert.equal(rejectedMutations, 192); assert.equal(addresses.size, 5);
  const result = { passed: true, suite: 'owned-payout-cashout-core', protocols: [PRESIGNED_PROTOCOL,PRESIGNED_PROTOCOL_V3],
    actualChain: 'isolated-regtest', coreVersion: core.coreVersion, confirmedCashouts, confirmedParents, rejectedMutations,
    payoutFamilies: [...families], destinationTypes: addresses.size, actualSizes: [...sizes].sort((a,b) => a-b),
    actualCoinAnchorsVerified: true, publicNetworkBroadcasts: 0, liveSignetVerified: false, mainnetAuthorized: false };
  core.record('owned-payout-cashout', result); console.log(JSON.stringify(result));
});
