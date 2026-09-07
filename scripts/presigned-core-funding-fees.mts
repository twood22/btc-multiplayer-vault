/** Real Core policy and wallet checks. Isolated, network-disabled regtest only. */
import assert from 'node:assert/strict';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { deterministicKeypair } from '../src/crypto.js';
import { createPresignedFixture, preauthorizePresignedFixture } from '../src/presigned/fixtures.js';
import { buildPresignedGraph } from '../src/presigned/graph.js';
import { authorizePresignedFundingSignedPsbt, finalizePresignedFunding } from '../src/presigned/funding.js';
import { completePresignedExit } from '../src/presigned/signing.js';
import { nativeWalletWitnessFromPsbt } from '../src/presigned/wallet.js';
import { PARTICIPANT_IDS, type ParticipantId, type PresignedGraph } from '../src/presigned/types.js';
import { type FeeCoinObservation } from '../src/presigned/fees.js';
import { buildPresignedFundingFeeChild, authorizePresignedFundingFeeSignedPsbt, authorizePresignedFundingFeeWalletPsbt,
  finalizePresignedFundingFeeChild, type PresignedFundingFeeRequest } from '../src/presigned/funding-fees.js';
import { withPresignedRegtest, type PresignedRegtest, type PresignedRegtestCoin } from './lib/presigned-regtest.js';

type WalletKind = 'p2tr' | 'p2wpkh';
type Coin = Pick<PresignedRegtestCoin, 'txid' | 'vout' | 'valueSats' | 'scriptPubKeyHex'>;

async function observed(core: PresignedRegtest, graph: PresignedGraph, coin: Coin): Promise<FeeCoinObservation> {
  const actual = await core.rpc('gettxout', [coin.txid, coin.vout, false]);
  assert(actual && actual.confirmations >= 1 && actual.coinbase === false, 'test coin must be confirmed and unspent in the actual active chain');
  assert.equal(Math.round(actual.value * 1e8), coin.valueSats);
  assert.equal(actual.scriptPubKey.hex, coin.scriptPubKeyHex);
  const transaction = await core.rpc('getrawtransaction', [coin.txid, true]);
  const header = await core.rpc('getblockheader', [transaction.blockhash]);
  assert(header.confirmations >= 1 && await core.rpc('getblockhash', [header.height]) === transaction.blockhash);
  return { network: graph.roster.network, genesisHash: graph.roster.genesisHash,
    txid: coin.txid, vout: coin.vout, valueSats: coin.valueSats, scriptPubKeyHex: coin.scriptPubKeyHex,
    confirmationBlockHash: transaction.blockhash, confirmations: actual.confirmations, unspentInActiveChain: true, coinbase: false };
}

async function walletScript(core: PresignedRegtest, label: string, kind: WalletKind): Promise<string> {
  const address = await core.walletRpc('getnewaddress', [label, kind === 'p2tr' ? 'bech32m' : 'bech32']);
  return Buffer.from(bitcoin.address.toOutputScript(address, bitcoin.networks.regtest)).toString('hex');
}

function encodedWitness(items: Buffer[]): Buffer {
  assert(items.length <= 2 && items.every(item => item.length <= 73));
  return Buffer.concat([Buffer.from([items.length]), ...items.flatMap(item => [Buffer.from([item.length]), item])]);
}

async function prepare(core: PresignedRegtest, label: string, owner: ParticipantId, changeKind: WalletKind, sponsorKind: WalletKind) {
  const fixture = createPresignedFixture();
  const scripts = await Promise.all(PARTICIPANT_IDS.map((id, index) => walletScript(core, `${label}-${id}`, id === owner ? changeKind : index % 2 ? 'p2wpkh' : 'p2tr')));
  const sponsorScripts = await Promise.all([sponsorKind, sponsorKind === 'p2tr' ? 'p2wpkh' : 'p2tr'].map((kind, index) => walletScript(core, `${label}-sponsor-${index}`, kind as WalletKind)));
  const coins = await core.fundScripts([...scripts.map(scriptPubKeyHex => ({ scriptPubKeyHex, valueSats: 12_000 })),
    ...sponsorScripts.map(scriptPubKeyHex => ({ scriptPubKeyHex, valueSats: 20_000 }))]);
  assert.equal(await core.walletRpc('lockunspent', [false, coins.map(coin => ({ txid: coin.txid, vout: coin.vout }))]), true);
  fixture.graph = buildPresignedGraph({ roster: fixture.roster, funding: { ...fixture.graph.funding,
    inputs: coins.slice(0, 3).map((coin, index) => ({ ...coin, participantId: PARTICIPANT_IDS[index]!, changeScriptPubKeyHex: coin.scriptPubKeyHex })) } });
  const { graph } = fixture;
  const preauthorizations = preauthorizePresignedFixture(fixture);
  assert.equal(preauthorizations.length, 12);
  // One isolated Core wallet holds the three disposable funding inputs. Its
  // actual signatures are projected into three single-input PSBT imports so
  // each production funding importer still enforces participant boundaries.
  const wallet = await core.walletRpc('walletprocesspsbt', [graph.fundingPsbtBase64, true, 'ALL', true, false]);
  const signed = bitcoin.Psbt.fromBase64(wallet.psbt);
  const signatures = PARTICIPANT_IDS.map((id, index) => {
    const single = bitcoin.Psbt.fromBase64(graph.fundingPsbtBase64);
    single.updateInput(index, { finalScriptWitness: encodedWitness(nativeWalletWitnessFromPsbt(signed.data.inputs[index]!)) });
    return authorizePresignedFundingSignedPsbt({ graph, participantId: id, approvedGraphDigest: graph.digest, signedPsbtBase64: single.toBase64() });
  });
  const funding = finalizePresignedFunding({ graph, signatures });
  assert.equal(bitcoin.Transaction.fromHex(funding.transactionHex).version, 3);
  const request: PresignedFundingFeeRequest = { graph, fundingTransactionHex: funding.transactionHex, changeParticipantId: owner,
    fundingInputObservations: await Promise.all(graph.funding.inputs.map(coin => observed(core, graph, coin))),
    sponsorInput: await observed(core, graph, coins[3]!), approval: { childFeeSats: 3_000, maxChildFeeSats: 10_000,
      targetPackageRateMillisatsPerVbyte: 5_000, minRelayRateMillisatsPerVbyte: 1_000,
      sponsorChangeScriptPubKeyHex: sponsorScripts[0]!, approveExactNoChangeFee: false, replacement: null } };
  const signedExit = (exitId: string) => {
    const exit = graph.exits.find(item => item.id === exitId)!;
    return completePresignedExit({ graph, preauthorizations, exitId, participantId: exit.leaver,
      privateKey: fixture.keysById[exit.leaver].soloPrivateKeys[exit.roundId]!, approvedGraphDigest: graph.digest });
  };
  return { fixture, funding, request, coins, sponsorScripts, signedExit };
}

async function child(core: PresignedRegtest, request: PresignedFundingFeeRequest) {
  const built = buildPresignedFundingFeeChild(request);
  const wallet = await core.walletRpc('walletprocesspsbt', [built.psbtBase64, true, 'ALL', true, false]);
  // Core cannot discover an absent parent from witnessUtxo alone for every
  // wallet kind; supplying the verified full parent is harmless PSBT metadata.
  let returned = bitcoin.Psbt.fromBase64(wallet.psbt);
  if (!returned.data.inputs[0]!.tapKeySig && !returned.data.inputs[0]!.partialSig?.length && !returned.data.inputs[0]!.finalScriptWitness) {
    const supplied = bitcoin.Psbt.fromBase64(built.psbtBase64);
    supplied.updateInput(0, { nonWitnessUtxo: bitcoin.Transaction.fromHex(request.fundingTransactionHex).toBuffer() });
    const withParent = await core.walletRpc('walletprocesspsbt', [supplied.toBase64(), true, 'ALL', true, false]);
    returned = bitcoin.Psbt.fromBase64(withParent.psbt);
  }
  const signedPsbtBase64 = returned.toBase64();
  assert.throws(() => authorizePresignedFundingFeeSignedPsbt({ request, role: 'change', signedPsbtBase64, approvalDigest: built.approvalDigest }), /another role/);
  assert.throws(() => authorizePresignedFundingFeeSignedPsbt({ request, role: 'sponsor', signedPsbtBase64, approvalDigest: built.approvalDigest }), /another role/);
  const signatures = authorizePresignedFundingFeeWalletPsbt({ request, roles: ['change', 'sponsor'], signedPsbtBase64, approvalDigest: built.approvalDigest });
  // Independently verify that native single-role contributions can be merged.
  const separate = signatures.map(signature => {
    const single = bitcoin.Psbt.fromBase64(built.psbtBase64);
    single.updateInput(signature.inputIndex, { finalScriptWitness: encodedWitness(signature.witness.map(item => Buffer.from(item, 'hex'))) });
    return authorizePresignedFundingFeeSignedPsbt({ request, role: signature.role, signedPsbtBase64: single.toBase64(), approvalDigest: built.approvalDigest });
  });
  const completed = finalizePresignedFundingFeeChild({ request, approvalDigest: built.approvalDigest, signatures });
  assert.equal(finalizePresignedFundingFeeChild({ request, approvalDigest: built.approvalDigest, signatures: separate }).transactionHex, completed.transactionHex);
  return completed;
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

async function rejected(core: PresignedRegtest, label: string, hex: string, reason: RegExp) {
  const result = await core.rpc('testmempoolaccept', [[hex]]);
  assert.equal(result[0].allowed, false, JSON.stringify(result));
  assert.match(result[0]['reject-reason'], reason);
  core.record(label, result);
  return result;
}

async function walletSpend(core: PresignedRegtest, coin: Coin, version: number, feeSats = 500, payloadBytes = 0) {
  const psbt = new bitcoin.Psbt();
  psbt.setVersion(version);
  psbt.addInput({ hash: coin.txid, index: coin.vout, sequence: 0xfffffffd,
    witnessUtxo: { value: BigInt(coin.valueSats), script: Buffer.from(coin.scriptPubKeyHex, 'hex') } });
  psbt.addOutput({ value: BigInt(coin.valueSats - feeSats), script: Buffer.from(coin.scriptPubKeyHex, 'hex') });
  if (payloadBytes) psbt.addOutput({ value: 0n, script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, Buffer.alloc(payloadBytes, 7)]) });
  const wallet = await core.walletRpc('walletprocesspsbt', [psbt.toBase64(), true, 'ALL', true, true]);
  const finalized = await core.rpc('finalizepsbt', [wallet.psbt]);
  assert.equal(finalized.complete, true);
  return bitcoin.Transaction.fromHex(finalized.hex);
}

function filler(index: number) {
  const pair = deterministicKeypair('public-regtest-funding-fee-congestion-only', String(index));
  const publicKey = Buffer.from(pair.publicKeyHex, 'hex');
  return { privateKey: Buffer.from(pair.privateKeyHex, 'hex'), publicKey,
    scriptPubKeyHex: Buffer.from(bitcoin.payments.p2tr({ internalPubkey: publicKey.subarray(1) }).output!).toString('hex') };
}

function fillerTransaction(coin: Coin, key: ReturnType<typeof filler>) {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.from(coin.txid, 'hex').reverse(), coin.vout, 0xfffffffd);
  tx.addOutput(Buffer.from(coin.scriptPubKeyHex, 'hex'), BigInt(coin.valueSats - 160_500));
  tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, Buffer.alloc(80_000, 7)]), 0n);
  const even = key.publicKey[0] === 3 ? ecc.privateNegate(key.privateKey) : key.privateKey;
  const secret = ecc.privateAdd(even, bitcoin.crypto.taggedHash('TapTweak', key.publicKey.subarray(1)))!;
  const hash = tx.hashForWitnessV1(0, [Buffer.from(coin.scriptPubKeyHex, 'hex')], [BigInt(coin.valueSats)], bitcoin.Transaction.SIGHASH_DEFAULT);
  tx.setWitness(0, [ecc.signSchnorr(hash, secret)]);
  assert(tx.virtualSize() < 100_000);
  return tx;
}

await withPresignedRegtest(async core => {
  try {
    const results: Record<string, unknown>[] = [];
    const pairs: [WalletKind, WalletKind][] = [['p2tr', 'p2tr'], ['p2tr', 'p2wpkh'], ['p2wpkh', 'p2tr'], ['p2wpkh', 'p2wpkh']];
    for (const [caseIndex, [changeKind, sponsorKind]] of pairs.entries()) {
      const label = `wallet-pair-${caseIndex}`;
      const state = await prepare(core, label, PARTICIPANT_IDS[caseIndex % 3]!, changeKind, sponsorKind);
      const { request, funding } = state;
      const graphCommitment = JSON.stringify(request.graph);
      const preSignedTransactions = request.graph.exits.map(exit => state.signedExit(exit.id));
      const first = state.signedExit('alice');
      if (caseIndex === 0) await submit(core, 'funding-plus-early-first-exit', funding.transactionHex, first.transactionHex);
      if (caseIndex === 2) await core.rpc('sendrawtransaction', [funding.transactionHex]);
      let activeRequest = request;
      let activeChild = await child(core, request);
      const firstSubmit = await submit(core, `${label}-funding-fee-package`, funding.transactionHex, activeChild.transactionHex);
      if (caseIndex === 0) assert((firstSubmit['replaced-transactions'] ?? []).includes(first.txid), 'refund CPFP did not sibling-evict the early first exit');
      await submit(core, `${label}-idempotent-package`, funding.transactionHex, activeChild.transactionHex);
      activeRequest = { ...request, approval: { ...request.approval, childFeeSats: 4_000,
        replacement: { previousChildTransactionHex: activeChild.transactionHex, incrementalRelayRateMillisatsPerVbyte: 1_000 } } };
      const replacement = await child(core, activeRequest);
      const replaced = await submit(core, `${label}-child-only-replacement`, funding.transactionHex, replacement.transactionHex);
      assert((replaced['replaced-transactions'] ?? []).includes(activeChild.txid));
      activeChild = replacement;
      if (caseIndex === 0) {
        const alternateOwner = PARTICIPANT_IDS.find(id => id !== request.changeParticipantId)!;
        activeRequest = { ...request, changeParticipantId: alternateOwner,
          sponsorInput: await observed(core, request.graph, state.coins[4]!), approval: { ...request.approval,
            childFeeSats: 5_000, sponsorChangeScriptPubKeyHex: state.sponsorScripts[1]! } };
        const alternate = await child(core, activeRequest);
        const before = bitcoin.Transaction.fromHex(activeChild.transactionHex);
        const after = bitcoin.Transaction.fromHex(alternate.transactionHex);
        assert(!before.ins.some(a => after.ins.some(b => Buffer.from(a.hash).equals(Buffer.from(b.hash)) && a.index === b.index)));
        const sibling = await submit(core, 'different-funding-volunteer-sibling-eviction', funding.transactionHex, alternate.transactionHex);
        assert((sibling['replaced-transactions'] ?? []).includes(activeChild.txid));
        activeChild = alternate;
        await rejected(core, 'early-first-exit-blocked-by-refund-child', first.transactionHex, /insufficient fee.*sibling/);
        const refund = { txid: activeChild.txid, vout: 0, valueSats: activeChild.changeSats, scriptPubKeyHex: activeChild.changeScriptPubKeyHex };
        await rejected(core, 'funding-fee-grandchild-rejected', (await walletSpend(core, refund, 3)).toHex(), /TRUC/);
        await rejected(core, 'funding-fee-vtwo-grandchild-bypass-rejected', (await walletSpend(core, refund, 2)).toHex(), /TRUC/);
        const oversized = await walletSpend(core, { ...refund, txid: funding.txid, vout: activeChild.changeVout }, 3, 1_000, 1_100);
        assert(oversized.virtualSize() > 1_000);
        await rejected(core, 'funding-fee-oversized-child-rejected', oversized.toHex(), /TRUC/);
        const available = (await core.walletRpc('listunspent', [1])).find((coin: any) => coin.spendable && coin.amount > 0.001);
        assert(available, 'isolated faucet has no confirmed coin for unconfirmed-sponsor test');
        const unconfirmedParent = await walletSpend(core, { txid: available.txid, vout: available.vout,
          valueSats: Math.round(available.amount * 1e8), scriptPubKeyHex: available.scriptPubKey }, 2, 1_000);
        await core.rpc('sendrawtransaction', [unconfirmedParent.toHex()]);
        const unconfirmed = await core.rpc('gettxout', [unconfirmedParent.getId(), 0, true]);
        assert.equal(unconfirmed.confirmations, 0);
        const unconfirmedRequest = { ...request, sponsorInput: { ...request.sponsorInput,
          txid: unconfirmedParent.getId(), vout: 0, valueSats: Math.round(unconfirmed.value * 1e8), scriptPubKeyHex: unconfirmed.scriptPubKey.hex,
          confirmations: 0 }, approval: { ...request.approval, sponsorChangeScriptPubKeyHex: unconfirmed.scriptPubKey.hex } };
        assert.throws(() => buildPresignedFundingFeeChild(unconfirmedRequest), /confirmations/);
        // Deliberately lying to the pure observation contract is not an SPV
        // proof. Core must independently reject this real extra v2 ancestor.
        const falseObservationChild = await child(core, { ...unconfirmedRequest, sponsorInput: { ...unconfirmedRequest.sponsorInput, confirmations: 1 } });
        await rejected(core, 'actual-unconfirmed-sponsor-rejected-by-core', falseObservationChild.transactionHex, /TRUC/);
        assert.throws(() => buildPresignedFundingFeeChild({ ...request, sponsorInput: request.fundingInputObservations[0]! }), /repeat a funding input/);
        assert.throws(() => buildPresignedFundingFeeChild({ ...request, sponsorInput: { ...request.sponsorInput, txid: funding.txid, vout: 0 } }), /outside/);
        assert.throws(() => buildPresignedFundingFeeChild({ ...request, approval: { ...request.approval, childFeeSats: 10_001 } }), /fee/);
      }
      await core.mine();
      assert((await core.rpc('getrawtransaction', [funding.txid, true])).confirmations >= 1);
      assert((await core.rpc('getrawtransaction', [activeChild.txid, true])).confirmations >= 1);
      const fundingTx = bitcoin.Transaction.fromHex(funding.transactionHex);
      for (const [index, output] of fundingTx.outs.entries()) {
        const actual = index === activeChild.changeVout ? await core.rpc('gettxout', [activeChild.txid, 0, true]) : await core.rpc('gettxout', [funding.txid, index, true]);
        assert(actual, 'funding CPFP consumed the vault or another owner refund');
        assert.equal(Math.round(actual.value * 1e8), Number(output.value));
        assert.equal(actual.scriptPubKey.hex, Buffer.from(output.script).toString('hex'));
      }
      assert.equal(Math.round((await core.rpc('gettxout', [activeChild.txid, 1, true])).value * 1e8), activeRequest.sponsorInput.valueSats - activeChild.childFeeSats);
      if (caseIndex === 0) {
        const acceptance = await core.rpc('testmempoolaccept', [[first.transactionHex]]);
        assert.equal(acceptance[0].allowed, true);
        await core.rpc('sendrawtransaction', [first.transactionHex]);
        await core.mine();
        const second = state.signedExit('alice/bob');
        await core.rpc('sendrawtransaction', [second.transactionHex]);
        await core.mine();
        assert((await core.rpc('getrawtransaction', [second.txid, true])).confirmations >= 1);
        assert.equal(Math.round((await core.rpc('gettxout', [second.txid, 1, true])).value * 1e8), 9_350);
      }
      assert.equal(JSON.stringify(request.graph), graphCommitment);
      assert.deepEqual(request.graph.exits.map(exit => state.signedExit(exit.id).txid), preSignedTransactions.map(transaction => transaction.txid));
      results.push({ label, changeKind, sponsorKind, fundingTxid: funding.txid, childTxid: activeChild.txid,
        refundSats: activeChild.changeSats, exactVaultSats: 30_000, immutableExitCount: 9,
        parentAndChildVersionThree: true, actualCoreWalletBothRolesAndSingleRoleMerge: true });
      console.log(JSON.stringify({ stage: 'funding-fee-package-confirmed', label, changeKind, sponsorKind }));
    }

    // A real rolling-floor rise through eviction, not priority deltas or a
    // fabricated observation. Funding remains absent until its child pays.
    const fillerKeys = Array.from({ length: 90 }, (_, index) => filler(index));
    const fillerCoins = await core.fundScripts(fillerKeys.map(key => ({ scriptPubKeyHex: key.scriptPubKeyHex, valueSats: 1_000_000 })));
    const congested = await prepare(core, 'congested-funding', 'carol', 'p2wpkh', 'p2tr');
    const frozenGraph = JSON.stringify(congested.request.graph);
    const floorBefore = await core.rpc('getmempoolinfo');
    assert.equal(floorBefore.maxmempool, 5_000_000);
    const acceptedFillers: string[] = [];
    let triggeringRejection: string | null = null;
    for (const [index, key] of fillerKeys.entries()) {
      const tx = fillerTransaction(fillerCoins[index]!, key);
      try { assert.equal(await core.rpc('sendrawtransaction', [tx.toHex()]), tx.getId()); acceptedFillers.push(tx.getId()); }
      catch (error) { triggeringRejection = String(error); assert.match(triggeringRejection, /mempool.*(full|min fee)|mempool min fee/i); break; }
      if ((await core.rpc('getmempoolinfo')).mempoolminfee > floorBefore.mempoolminfee) break;
    }
    const floorAfter = await core.rpc('getmempoolinfo');
    assert(floorAfter.mempoolminfee > floorBefore.mempoolminfee);
    const remaining = await core.rpc('getrawmempool');
    assert(triggeringRejection || acceptedFillers.some(txid => !remaining.includes(txid)));
    await rejected(core, 'funding-below-real-rolling-floor', congested.funding.transactionHex, /mempool min fee/);
    const underfundedRequest = { ...congested.request, approval: { ...congested.request.approval,
      childFeeSats: 100, targetPackageRateMillisatsPerVbyte: 500, minRelayRateMillisatsPerVbyte: 100 } };
    const underfunded = await child(core, underfundedRequest);
    const failedPackage = await core.rpc('submitpackage', [[congested.funding.transactionHex, underfunded.transactionHex]]);
    assert.notEqual(failedPackage.package_msg, 'success');
    const failedResults = Object.values(failedPackage['tx-results']) as any[];
    assert.equal(failedResults.length, 2);
    assert(failedResults.every(result => /mempool min fee/.test(result.error)));
    assert(!(await core.rpc('getrawmempool')).includes(congested.funding.txid));
    core.record('underfunded-funding-package-real-floor', failedPackage);
    const rescued = await child(core, congested.request);
    await submit(core, 'absent-funding-rescued-above-real-floor', congested.funding.transactionHex, rescued.transactionHex);
    const bumpRequest = { ...congested.request, approval: { ...congested.request.approval, childFeeSats: 4_000,
      replacement: { previousChildTransactionHex: rescued.transactionHex, incrementalRelayRateMillisatsPerVbyte: 1_000 } } };
    const bumped = await child(core, bumpRequest);
    const bump = await submit(core, 'funding-child-replacement-above-real-floor', congested.funding.transactionHex, bumped.transactionHex);
    assert((bump['replaced-transactions'] ?? []).includes(rescued.txid));
    await core.mine();
    assert((await core.rpc('getrawtransaction', [congested.funding.txid, true])).confirmations >= 1);
    assert((await core.rpc('getrawtransaction', [bumped.txid, true])).confirmations >= 1);
    assert.equal(JSON.stringify(congested.request.graph), frozenGraph);
    core.record('funding-actual-rolling-floor', { floorBefore, floorAfter, acceptedFillerCount: acceptedFillers.length, triggeringRejection,
      feePrioritizationUsed: false, parentFeeSats: congested.funding.feeSats, parentVsize: congested.funding.vsize,
      childFeeSats: rescued.childFeeSats, childVsize: rescued.vsize });
    const summary = { passed: true, protocol: 'presigned-graph-v2', chain: 'isolated-regtest', coreVersion: core.coreVersion,
      publicNetworkBroadcasts: 0, realCoreWalletFundingAndBothFeeRoles: true, confirmedNativeWalletPairs: 4,
      absentFundingAndPresentFundingPackages: true, childReplacement: true, firstExitSiblingEviction: true,
      differentOwnerSiblingEviction: true, descendantsAndOversizedChildrenRejected: true,
      actualUnconfirmedSponsorRejectedByApplicationAndCore: true,
      confirmedFundingUnlocksOriginalFirstAndSecondExits: true, fundingVaultAndAllRefundValuesPreserved: true,
      dynamicMempoolFloorRaisedByRealEviction: true, underfundedPackageRejected: true, adequatelySponsoredFundingAndReplacementConfirmed: true,
      exactGraphAndNineExitTxidsUnchanged: true, liveSignetVerified: false, browserOrPhysicalPasskeysVerified: false,
      evidence: core.directory, results };
    core.record('funding-fees-acceptance', summary);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    core.record('funding-fees-failure', { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null });
    throw error;
  }
}, { maxMempoolMb: 5 });
