/** Real Core policy/consensus checks using ONLY isolated regtest fixture funds. */
import assert from 'node:assert/strict';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { deterministicKeypair } from '../src/crypto.js';
import { createPresignedFixture, preauthorizePresignedFixture, signPresignedFixtureFunding } from '../src/presigned/fixtures.js';
import { buildPresignedGraph } from '../src/presigned/graph.js';
import { completePresignedExit } from '../src/presigned/signing.js';
import { PARTICIPANT_IDS, type PresignedGraph } from '../src/presigned/types.js';
import { buildPresignedFeeChild, finalizePresignedFeeChild, signPresignedFeePayout, type FeeCoinObservation, type PresignedFeeRequest } from '../src/presigned/fees.js';
import { withPresignedRegtest, type PresignedRegtest, type PresignedRegtestCoin } from './lib/presigned-regtest.js';

type WalletKind = 'p2tr' | 'p2wpkh';
type TestWallet = ReturnType<typeof wallet>;

function wallet(label: string, kind: WalletKind) {
  const pair = deterministicKeypair('public-presigned-core-fees-offline-only', label);
  const privateKey = Buffer.from(pair.privateKeyHex, 'hex');
  const publicKey = Buffer.from(pair.publicKeyHex, 'hex');
  const output = kind === 'p2tr' ? bitcoin.payments.p2tr({ internalPubkey: publicKey.subarray(1) }).output!
    : bitcoin.payments.p2wpkh({ pubkey: publicKey }).output!;
  return { kind, privateKey, publicKey, scriptPubKeyHex: Buffer.from(output).toString('hex') };
}

function signWalletPsbt(psbtBase64: string, index: number, signer: TestWallet): string {
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64);
  if (signer.kind === 'p2wpkh') {
    psbt.signInput(index, { publicKey: signer.publicKey, sign: hash => ecc.sign(hash, signer.privateKey) });
    psbt.updateInput(index, { bip32Derivation: [{ pubkey: signer.publicKey, masterFingerprint: Buffer.from('12345678', 'hex'), path: "m/84'/1'/0'/0/0" }] });
  } else {
    psbt.updateInput(index, { tapInternalKey: signer.publicKey.subarray(1), tapBip32Derivation: [{
      pubkey: signer.publicKey.subarray(1), leafHashes: [], masterFingerprint: Buffer.from('12345678', 'hex'), path: "m/86'/1'/0'/0/0",
    }] });
    const tweak = bitcoin.crypto.taggedHash('TapTweak', signer.publicKey.subarray(1));
    const even = signer.publicKey[0] === 3 ? ecc.privateNegate(signer.privateKey) : signer.privateKey;
    const tweaked = ecc.privateAdd(even, tweak)!;
    psbt.signInput(index, { publicKey: Buffer.from(ecc.pointFromScalar(tweaked, true)!),
      sign: () => { throw new Error('Taproot fixture signer cannot produce ECDSA'); },
      signSchnorr: hash => ecc.signSchnorr(hash, tweaked) });
  }
  return psbt.toBase64();
}

/** Uses actual active-chain RPC state; the graph is Signet-format on regtest. */
async function observed(core: PresignedRegtest, graph: PresignedGraph, txid: string, vout: number): Promise<FeeCoinObservation> {
  const coin = await core.rpc('gettxout', [txid, vout, false]);
  assert(coin && coin.confirmations >= 1 && coin.coinbase === false, 'test coin is not confirmed and unspent in the active chain');
  const transaction = await core.rpc('getrawtransaction', [txid, true]);
  assert(transaction.blockhash, 'test coin has no confirmation block');
  const block = await core.rpc('getblockheader', [transaction.blockhash]);
  assert(block.confirmations >= 1 && await core.rpc('getblockhash', [block.height]) === transaction.blockhash, 'coin confirmation anchor is not active');
  return { network: graph.roster.network, genesisHash: graph.roster.genesisHash, txid, vout,
    valueSats: Math.round(coin.value * 1e8), scriptPubKeyHex: coin.scriptPubKey.hex,
    confirmationBlockHash: transaction.blockhash, confirmations: coin.confirmations,
    unspentInActiveChain: true, coinbase: false };
}

async function makeFee(request: PresignedFeeRequest, fixture: ReturnType<typeof createPresignedFixture>, core: PresignedRegtest) {
  const built = buildPresignedFeeChild(request);
  const exit = request.graph.exits.find(item => item.id === request.exitId)!;
  const payout = signPresignedFeePayout({ request, psbtBase64: built.psbtBase64, approvalDigest: built.approvalDigest, keys: fixture.keysById[exit.leaver] });
  const signed = await core.walletRpc('walletprocesspsbt', [built.psbtBase64, true, 'ALL', true, false]);
  try {
    return finalizePresignedFeeChild({ request, approvalDigest: built.approvalDigest, payoutSignatureHex: payout.payoutSignatureHex,
      sponsorSignedPsbtBase64: signed.psbt });
  } catch (error) {
    const returned = bitcoin.Psbt.fromBase64(signed.psbt);
    core.record('wallet-psbt-metadata-rejection', { globalKeys: Object.keys(returned.data.globalMap),
      inputKeys: returned.data.inputs.map(input => Object.keys(input)), outputKeys: returned.data.outputs.map(output => Object.keys(output)) });
    throw error;
  }
}

function walletSpend(coin: Pick<PresignedRegtestCoin, 'txid' | 'vout' | 'valueSats' | 'scriptPubKeyHex'>,
  signer: TestWallet, feeSats: number, version = 2, payloadBytes = 0) {
  assert(coin.valueSats - feeSats >= 330, 'test wallet spend would become dust');
  const psbt = new bitcoin.Psbt();
  psbt.setVersion(version);
  psbt.addInput({ hash: coin.txid, index: coin.vout, sequence: 0xfffffffd,
    witnessUtxo: { script: Buffer.from(coin.scriptPubKeyHex, 'hex'), value: BigInt(coin.valueSats) } });
  psbt.addOutput({ script: Buffer.from(signer.scriptPubKeyHex, 'hex'), value: BigInt(coin.valueSats - feeSats) });
  if (payloadBytes) psbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, Buffer.alloc(payloadBytes, 7)]), value: 0n });
  const signed = bitcoin.Psbt.fromBase64(signWalletPsbt(psbt.toBase64(), 0, signer));
  signed.finalizeInput(0);
  const tx = signed.extractTransaction();
  return { transactionHex: tx.toHex(), txid: tx.getId(), vout: 0, valueSats: coin.valueSats - feeSats,
    scriptPubKeyHex: signer.scriptPubKeyHex, feeSats, vsize: tx.virtualSize() };
}

async function assertPackage(core: PresignedRegtest, name: string, transactionHexes: string[]) {
  const response = await core.rpc('submitpackage', [transactionHexes]);
  core.record(name, response);
  assert.equal(response.package_msg, 'success', JSON.stringify(response));
  assert(response['tx-results'] && typeof response['tx-results'] === 'object', 'submitpackage omitted per-transaction results');
  const results = Object.values(response['tx-results']) as Array<Record<string, unknown>>;
  const expectedTxids = transactionHexes.map(hex => bitcoin.Transaction.fromHex(hex).getId());
  for (const txid of expectedTxids) {
    const result = results.find(item => item.txid === txid);
    assert(result && !result.error, `submitpackage failed or omitted expected transaction ${txid}: ${JSON.stringify(response)}`);
    const mempool = await core.rpc('getmempoolentry', [txid]);
    assert(mempool && typeof mempool.vsize === 'number', 'accepted package transaction missing from actual mempool');
  }
  return response;
}

async function rejected(core: PresignedRegtest, name: string, transactionHex: string, reason: RegExp) {
  const result = await core.rpc('testmempoolaccept', [[transactionHex]]);
  assert.equal(result[0].allowed, false, JSON.stringify(result));
  assert.match(result[0]['reject-reason'], reason);
  core.record(name, result);
  return result[0]['reject-reason'] as string;
}

async function walletSponsor(core: PresignedRegtest, label: string, kind: WalletKind) {
  const address = await core.walletRpc('getnewaddress', [label, kind === 'p2tr' ? 'bech32m' : 'bech32']);
  return { kind, scriptPubKeyHex: Buffer.from(bitcoin.address.toOutputScript(address, bitcoin.networks.regtest)).toString('hex') };
}

await withPresignedRegtest(async core => {
  try {
    const fixture = createPresignedFixture();
    const firstSponsor = await walletSponsor(core, 'first-sponsor', 'p2tr');
    const secondSponsor = await walletSponsor(core, 'second-sponsor', 'p2wpkh');
    const policyWallet = wallet('policy-probe', 'p2tr');
    const unconfirmedWallet = wallet('unconfirmed-probe', 'p2tr');
    const coins = await core.fundScripts([
      ...PARTICIPANT_IDS.map(id => ({ scriptPubKeyHex: fixture.walletKeys[id].scriptPubKeyHex, valueSats: 12_000 })),
      ...[firstSponsor, secondSponsor, policyWallet].map(signer => ({ scriptPubKeyHex: signer.scriptPubKeyHex, valueSats: 20_000 })),
    ]);
    // These are ordinary descriptor-wallet coins now. Reserve them so unrelated
    // faucet probes cannot consume the next-round sponsor through coin selection.
    assert.equal(await core.walletRpc('lockunspent', [false, coins.slice(3, 5).map(coin => ({ txid: coin.txid, vout: coin.vout }))]), true);
    fixture.graph = buildPresignedGraph({ roster: fixture.roster, funding: { ...fixture.graph.funding,
      inputs: coins.slice(0, 3).map((coin, index) => ({ ...coin, participantId: PARTICIPANT_IDS[index]!, changeScriptPubKeyHex: coin.scriptPubKeyHex })) } });
    const graph = fixture.graph;
    const originalGraph = JSON.stringify(graph);
    const preauthorizations = preauthorizePresignedFixture(fixture);
    const funding = signPresignedFixtureFunding(fixture);
    const first = graph.exits.find(exit => exit.id === 'alice')!;
    const second = graph.exits.find(exit => exit.id === 'alice/bob')!;
    const signedExit = (exitId: string) => {
      const exit = graph.exits.find(item => item.id === exitId)!;
      return completePresignedExit({ graph, preauthorizations, exitId, participantId: exit.leaver,
        privateKey: fixture.keysById[exit.leaver].soloPrivateKeys[exit.roundId]!, approvedGraphDigest: graph.digest });
    };
    const firstParent = signedExit(first.id);
    const successor = signedExit(second.id);
    assert.equal(bitcoin.Transaction.fromHex(funding.transactionHex).version, 3);
    assert.equal(bitcoin.Transaction.fromHex(firstParent.transactionHex).version, 3);
    const fundingAcceptance = await core.rpc('testmempoolaccept', [[funding.transactionHex]]);
    assert.equal(fundingAcceptance[0].allowed, true, JSON.stringify(fundingAcceptance));
    await core.rpc('sendrawtransaction', [funding.transactionHex]);
    // Funding is itself V3: the first exit is a legal single unconfirmed
    // child, not a mixed-version TRUC violation. The third generation is what
    // exceeds topology limits. Application fee rescue separately requires the
    // round input to have confirmed before offering a parent/fee-child pair.
    const earlyChild = await core.rpc('testmempoolaccept', [[firstParent.transactionHex]]);
    assert.equal(earlyChild[0].allowed, true, JSON.stringify(earlyChild));
    const thirdGeneration = await core.rpc('testmempoolaccept', [[firstParent.transactionHex, successor.transactionHex]]);
    const tooDeep = thirdGeneration.find((item: any) => item.txid === successor.txid);
    assert(tooDeep && tooDeep.allowed !== true &&
      /TRUC-violation/.test(tooDeep['reject-reason'] ?? tooDeep['package-error'] ?? ''), JSON.stringify(thirdGeneration));
    await assert.rejects(() => observed(core, graph, first.inputTxid, first.inputVout), /not confirmed/);
    assert.deepEqual(await core.rpc('getrawmempool'), [funding.txid], 'a non-mutating topology probe changed the mempool');
    core.record('truc-unconfirmed-funding-topology', { earlyChild, thirdGeneration,
      unconfirmedRoundObservationRejected: true, mempoolUnchanged: true });
    await core.mine();
    const firstRequest: PresignedFeeRequest = { graph, exitId: first.id, parentTransactionHex: firstParent.transactionHex,
      roundInputObservation: await observed(core, graph, first.inputTxid, first.inputVout),
      sponsorInput: await observed(core, graph, coins[3]!.txid, coins[3]!.vout),
      approval: { childFeeSats: 3_000, maxChildFeeSats: 10_000, targetPackageRateMillisatsPerVbyte: 5_000,
        minRelayRateMillisatsPerVbyte: 1_000, sponsorChangeScriptPubKeyHex: firstSponsor.scriptPubKeyHex,
        approveExactNoChangeFee: false, replacement: null } };
    const firstChild = await makeFee(firstRequest, fixture, core);
    assert.equal(bitcoin.Transaction.fromHex(firstChild.transactionHex).version, 3);
    const independentCoreAcceptance = await core.rpc('testmempoolaccept', [[firstParent.transactionHex, firstChild.transactionHex]]);
    assert(independentCoreAcceptance.every((result: any) => result.allowed === true), JSON.stringify(independentCoreAcceptance));
    core.record('first-package-preflight', independentCoreAcceptance);

    // A correctly signed independent wallet transaction below the actual static
    // relay floor is rejected by Core, not by a stub or our application verifier.
    const lowFee = walletSpend(coins[5]!, policyWallet, 1);
    const lowFeeAcceptance = await core.rpc('testmempoolaccept', [[lowFee.transactionHex]]);
    assert.equal(lowFeeAcceptance[0].allowed, false);
    assert.match(lowFeeAcceptance[0]['reject-reason'], /min relay fee/i);
    core.record('static-relay-rejection', { mempool: await core.rpc('getmempoolinfo'), transaction: lowFee, result: lowFeeAcceptance });

    // Genuine unconfirmed sponsor output, never submitted to the fee signer.
    const unconfirmedAddress = bitcoin.address.fromOutputScript(Buffer.from(unconfirmedWallet.scriptPubKeyHex, 'hex'), bitcoin.networks.regtest);
    const unconfirmedTxid = await core.walletRpc('sendtoaddress', [unconfirmedAddress, 0.0002]);
    const unconfirmedTx = await core.rpc('getrawtransaction', [unconfirmedTxid, true]);
    const unconfirmedOutput = unconfirmedTx.vout.find((out: any) => out.scriptPubKey.hex === unconfirmedWallet.scriptPubKeyHex);
    assert(unconfirmedOutput && !unconfirmedTx.blockhash);
    const unconfirmedCoin = await core.rpc('gettxout', [unconfirmedTxid, unconfirmedOutput.n, true]);
    assert.equal(unconfirmedCoin.confirmations, 0);
    assert.throws(() => buildPresignedFeeChild({ ...firstRequest, sponsorInput: { ...firstRequest.sponsorInput,
      txid: unconfirmedTxid, vout: unconfirmedOutput.n, scriptPubKeyHex: unconfirmedWallet.scriptPubKeyHex,
      confirmations: 0, confirmationBlockHash: '00'.repeat(32) } }));
    assert.throws(() => buildPresignedFeeChild({ ...firstRequest,
      approval: { ...firstRequest.approval, childFeeSats: firstRequest.approval.maxChildFeeSats + 1 } }), /fee/);

    await assertPackage(core, 'parent-successor-package', [firstParent.transactionHex, successor.transactionHex]);
    const sibling = await assertPackage(core, 'truc-sibling-eviction', [firstParent.transactionHex, firstChild.transactionHex]);
    assert((sibling['replaced-transactions'] ?? []).includes(successor.txid), 'Core did not report eviction of the competing successor sibling');
    assert(!(await core.rpc('getrawmempool')).includes(successor.txid));
    await assertPackage(core, 'already-present-package', [firstParent.transactionHex, firstChild.transactionHex]);
    const competitor = signedExit('bob');
    const competingAcceptance = await core.rpc('testmempoolaccept', [[competitor.transactionHex]]);
    assert.equal(competingAcceptance[0].allowed, false);
    assert.match(competingAcceptance[0]['reject-reason'], /insufficient fee/i);
    core.record('competing-branch-rejection', competingAcceptance);

    const replacementRequest: PresignedFeeRequest = { ...firstRequest, approval: { ...firstRequest.approval,
      childFeeSats: 4_000, replacement: { previousChildTransactionHex: firstChild.transactionHex, incrementalRelayRateMillisatsPerVbyte: 1_000 } } };
    const replacement = await makeFee(replacementRequest, fixture, core);
    const replacementResult = await assertPackage(core, 'present-parent-child-replacement', [firstParent.transactionHex, replacement.transactionHex]);
    const afterReplacement = await core.rpc('getrawmempool');
    assert(afterReplacement.includes(firstParent.txid) && afterReplacement.includes(replacement.txid) && !afterReplacement.includes(firstChild.txid));
    assert((replacementResult['replaced-transactions'] ?? []).includes(firstChild.txid), 'Core did not report the replaced child');
    const successorBefore = await core.rpc('gettxout', [firstParent.txid, 1, true]);
    assert(successorBefore && successorBefore.scriptPubKey.hex === second.inputScriptPubKeyHex && Math.round(successorBefore.value * 1e8) === second.inputValueSats);
    console.log(JSON.stringify({ stage: 'actual-Core-fee-package-and-child-replacement', parent: firstParent.txid, originalChild: firstChild.txid, replacement: replacement.txid }));

    // TRUC rejects any grandchild, including a valid ordinary-version bypass.
    // A malicious next leaver may publish the committed successor as the only
    // child, but the earlier fee-child submission actually sibling-evicted it.
    const payoutPrivateKey = Buffer.from(fixture.keysById.alice.payoutPrivateKey);
    const payoutSigner: TestWallet = { kind: 'p2tr', privateKey: payoutPrivateKey,
      publicKey: Buffer.from(ecc.pointFromScalar(payoutPrivateKey, true)!),
      scriptPubKeyHex: Buffer.from(bitcoin.Transaction.fromHex(replacement.transactionHex).outs[0]!.script).toString('hex') };
    const preservedPayout = { txid: replacement.txid, vout: 0, valueSats: replacement.payoutSats, scriptPubKeyHex: payoutSigner.scriptPubKeyHex };
    const flood = walletSpend(preservedPayout, payoutSigner, 100, 3);
    const descendantRejection = await rejected(core, 'truc-descendant-flood-rejected', flood.transactionHex, /TRUC/);
    await rejected(core, 'vtwo-descendant-bypass-rejected', walletSpend(preservedPayout, payoutSigner, 100, 2).transactionHex, /TRUC/);
    const oversizedChild = walletSpend({ ...preservedPayout, txid: firstParent.txid }, payoutSigner, 8_000, 3, 1_100);
    assert(oversizedChild.vsize > 1000);
    await rejected(core, 'truc-oversized-child-rejected', oversizedChild.transactionHex, /TRUC/);
    const blockedSuccessor = await rejected(core, 'lower-fee-successor-awaits-parent-confirmation', successor.transactionHex, /insufficient fee.*sibling/);
    const cluster = await core.rpc('getmempoolcluster', [firstParent.txid]);
    core.record('truc-bounded-topology', { descendantRejection, blockedSuccessor, cluster,
      siblingEvictionActuallyObserved: true, noUnlimitedFeeLivenessGuarantee: true });
    console.log(JSON.stringify({ stage: 'actual-Core-TRUC-sibling-eviction-and-descendant-rejection', descendantRejection }));

    await core.mine();
    const firstOnChain = await core.rpc('getrawtransaction', [firstParent.txid, true]);
    assert(firstOnChain.confirmations >= 1);
    const replacementOnChain = await core.rpc('getrawtransaction', [replacement.txid, true]);
    assert(replacementOnChain.confirmations >= 1);
    const secondRequest: PresignedFeeRequest = { graph, exitId: second.id, parentTransactionHex: successor.transactionHex,
      roundInputObservation: await observed(core, graph, second.inputTxid, second.inputVout),
      sponsorInput: await observed(core, graph, coins[4]!.txid, coins[4]!.vout),
      approval: { ...firstRequest.approval, sponsorChangeScriptPubKeyHex: secondSponsor.scriptPubKeyHex } };
    assert.throws(() => buildPresignedFeeChild({ ...secondRequest, sponsorInput: { ...secondRequest.roundInputObservation } }), /vault cannot sponsor/i);
    const secondChild = await makeFee(secondRequest, fixture, core);
    const secondPreflight = await core.rpc('testmempoolaccept', [[successor.transactionHex, secondChild.transactionHex]]);
    assert(secondPreflight.every((item: any) => item.allowed === true), JSON.stringify(secondPreflight));
    core.record('second-package-preflight', secondPreflight);
    assert.equal(await core.rpc('sendrawtransaction', [successor.transactionHex]), successor.txid);
    await assertPackage(core, 'second-present-parent-package', [successor.transactionHex, secondChild.transactionHex]);
    await core.mine();
    const secondOnChain = await core.rpc('getrawtransaction', [successor.txid, true]);
    const childOnChain = await core.rpc('getrawtransaction', [secondChild.txid, true]);
    assert(secondOnChain.confirmations >= 1 && childOnChain.confirmations >= 1);
    const firstPayout = await core.rpc('getrawtransaction', [replacement.txid, true]);
    assert.equal(Math.round(firstPayout.vout[0].value * 1e8), 9_500);
    assert.equal(Math.round(childOnChain.vout[0].value * 1e8), 10_250);
    assert.equal(Math.round(childOnChain.vout[1].value * 1e8), secondRequest.sponsorInput.valueSats - secondChild.childFeeSats);
    const finalPayout = await core.rpc('gettxout', [successor.txid, 1, true]);
    assert(finalPayout && Math.round(finalPayout.value * 1e8) === 9_350);
    assert.equal(successor.txid, second.txid);
    assert.equal(JSON.stringify(graph), originalGraph, 'Core fee operations mutated graph commitments');

    // Fill the deliberately small isolated mempool with real independent
    // transactions until Core evicts one and raises its rolling fee floor.
    // No priority deltas or simulated policy values are used.
    const fillerWallets = Array.from({ length: 90 }, (_, index) => wallet(`rolling-floor-filler-${index}`, 'p2tr'));
    const fillerCoins = await core.fundScripts(fillerWallets.map(signer => ({ scriptPubKeyHex: signer.scriptPubKeyHex, valueSats: 1_000_000 })));
    const congestedFixture = createPresignedFixture();
    const congestedSponsor = await walletSponsor(core, 'rolling-floor-sponsor', 'p2tr');
    const congestedCoins = await core.fundScripts([
      ...PARTICIPANT_IDS.map(id => ({ scriptPubKeyHex: congestedFixture.walletKeys[id].scriptPubKeyHex, valueSats: 12_000 })),
      { scriptPubKeyHex: congestedSponsor.scriptPubKeyHex, valueSats: 20_000 },
    ]);
    congestedFixture.graph = buildPresignedGraph({ roster: congestedFixture.roster, funding: { ...congestedFixture.graph.funding,
      inputs: congestedCoins.slice(0, 3).map((coin, index) => ({ ...coin, participantId: PARTICIPANT_IDS[index]!, changeScriptPubKeyHex: coin.scriptPubKeyHex })) } });
    const congestedPreauthorizations = preauthorizePresignedFixture(congestedFixture);
    const congestedFunding = signPresignedFixtureFunding(congestedFixture);
    await core.rpc('sendrawtransaction', [congestedFunding.transactionHex]);
    await core.mine();
    const congestedGraph = congestedFixture.graph;
    const congestedGraphCommitment = JSON.stringify(congestedGraph);
    const congestedExit = congestedGraph.exits.find(exit => exit.id === 'alice')!;
    const congestedParent = completePresignedExit({ graph: congestedGraph, preauthorizations: congestedPreauthorizations,
      exitId: 'alice', participantId: 'alice', privateKey: congestedFixture.keysById.alice.soloPrivateKeys[congestedExit.roundId]!, approvedGraphDigest: congestedGraph.digest });
    const congestedRequest: PresignedFeeRequest = { graph: congestedGraph, exitId: 'alice', parentTransactionHex: congestedParent.transactionHex,
      roundInputObservation: await observed(core, congestedGraph, congestedExit.inputTxid, congestedExit.inputVout),
      sponsorInput: await observed(core, congestedGraph, congestedCoins[3]!.txid, congestedCoins[3]!.vout),
      approval: { ...firstRequest.approval, sponsorChangeScriptPubKeyHex: congestedSponsor.scriptPubKeyHex } };
    const floorBefore = await core.rpc('getmempoolinfo');
    assert.equal(floorBefore.maxmempool, 5_000_000);
    const acceptedFillers: string[] = [];
    let triggeringRejection: string | null = null;
    for (let index = 0; index < fillerWallets.length; index++) {
      const fill = walletSpend(fillerCoins[index]!, fillerWallets[index]!, 160_500, 2, 80_000);
      assert(fill.vsize < 100_000);
      try { assert.equal(await core.rpc('sendrawtransaction', [fill.transactionHex]), fill.txid); acceptedFillers.push(fill.txid); }
      catch (error) {
        triggeringRejection = String(error);
        assert.match(triggeringRejection, /mempool.*(full|min fee)|mempool min fee/i);
        break;
      }
      if ((await core.rpc('getmempoolinfo')).mempoolminfee > floorBefore.mempoolminfee) break;
    }
    const floorAfter = await core.rpc('getmempoolinfo');
    assert(floorAfter.mempoolminfee > floorBefore.mempoolminfee, 'real rolling floor did not rise through eviction');
    const remaining = await core.rpc('getrawmempool');
    assert(triggeringRejection || acceptedFillers.some(txid => !remaining.includes(txid)), 'no actual eviction observed');
    await rejected(core, 'parent-below-real-rolling-floor', congestedParent.transactionHex, /mempool min fee/);
    const underfundedRequest: PresignedFeeRequest = { ...congestedRequest, approval: { ...congestedRequest.approval,
      childFeeSats: 100, targetPackageRateMillisatsPerVbyte: 500, minRelayRateMillisatsPerVbyte: 100 } };
    const underfunded = await makeFee(underfundedRequest, congestedFixture, core);
    const failedPackage = await core.rpc('submitpackage', [[congestedParent.transactionHex, underfunded.transactionHex]]);
    assert.notEqual(failedPackage.package_msg, 'success');
    assert(!(await core.rpc('getrawmempool')).includes(congestedParent.txid));
    assert(Object.values(failedPackage['tx-results']).every((result: any) => /mempool min fee/.test(result.error)));
    core.record('underfunded-real-rolling-floor-package', failedPackage);
    const rescued = await makeFee(congestedRequest, congestedFixture, core);
    await assertPackage(core, 'absent-parent-real-rolling-floor-package', [congestedParent.transactionHex, rescued.transactionHex]);
    const congestionBumpRequest: PresignedFeeRequest = { ...congestedRequest, approval: { ...congestedRequest.approval,
      childFeeSats: 4_000, replacement: { previousChildTransactionHex: rescued.transactionHex, incrementalRelayRateMillisatsPerVbyte: 1_000 } } };
    const congestionBump = await makeFee(congestionBumpRequest, congestedFixture, core);
    const congestionReplacement = await assertPackage(core, 'real-rolling-floor-child-replacement', [congestedParent.transactionHex, congestionBump.transactionHex]);
    assert((congestionReplacement['replaced-transactions'] ?? []).includes(rescued.txid));
    core.record('actual-rolling-floor', { floorBefore, floorAfter, acceptedFillerCount: acceptedFillers.length,
      triggeringRejection, actualEviction: true, feePrioritizationUsed: false, parentFeeSats: congestedParent.feeSats,
      parentVsize: congestedParent.vsize, childFeeSats: rescued.childFeeSats, childVsize: rescued.vsize });
    await core.mine();
    assert((await core.rpc('getrawtransaction', [congestedParent.txid, true])).confirmations >= 1);
    assert((await core.rpc('getrawtransaction', [congestionBump.txid, true])).confirmations >= 1);
    assert.equal(JSON.stringify(congestedGraph), congestedGraphCommitment, 'real congestion or replacement mutated the committed graph');
    const summary = { protocol: 'presigned-graph-v2', passed: true, chain: 'isolated-regtest', fixtureNetwork: graph.roster.network,
      coreVersion: core.coreVersion, publicNetworkBroadcasts: 0, actualCoreConsensusAndMempool: true,
      absentParentPackageAccepted: true, alreadyPresentPackageIdempotent: true, existingParentNewChildAccepted: true,
      childOnlyReplacementAccepted: true, firstAndSecondSponsorKinds: ['p2tr', 'p2wpkh'],
      actualCoreWalletProcessPsbtUsed: true,
      exactPayoutsSats: [9500, 10250, 9350], fundingAndGraphUnchanged: true, successorRemainedSpendable: true,
      unconfirmedSponsorRejectedByApplication: true, successorSponsorRejectedByApplication: true, feeCapRejectedByApplication: true,
      lowStaticFeeRejectedByCore: true, lowFeeCompetingBranchRejectedByCore: true,
      versionThreeTrucParentAndChild: true, unconfirmedV3FundingAllowsOneChild: true,
      thirdUnconfirmedGenerationRejected: true, unconfirmedRoundObservationRejected: true,
      actualSiblingEviction: true, descendantFloodRejected: true,
      oversizedChildRejected: true, sequentialConfirmationUnlocksSuccessor: true, highDynamicMempoolFloorTested: true,
      actualRollingFloorFromEviction: true, underfundedPackageRejectedByCore: true, adequatePackageAndReplacementConfirmed: true,
      transactionIds: { funding: funding.txid, first: firstParent.txid, firstChild: firstChild.txid,
        replacementChild: replacement.txid, second: successor.txid, secondChild: secondChild.txid },
      liveSignetVerified: false, browserVerified: false, physicalPasskeysVerified: false, evidence: core.directory };
    core.record('fee-acceptance', summary);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    core.record('fee-failure', { message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null });
    throw error;
  }
}, { maxMempoolMb: 5 });
