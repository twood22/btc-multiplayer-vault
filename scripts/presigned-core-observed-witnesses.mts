import assert from 'node:assert/strict';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { createPresignedFixture, preauthorizePresignedFixture, signPresignedFixtureFunding } from '../src/presigned/fixtures.js';
import { authorizePresignedFundingSignedPsbt, authorizePresignedFundingTransaction } from '../src/presigned/funding.js';
import { buildPresignedGraph, nonWitnessTransactionHex } from '../src/presigned/graph.js';
import { authorizePresignedExitTransaction, completePresignedExit } from '../src/presigned/signing.js';
import { PARTICIPANT_IDS } from '../src/presigned/types.js';
import { collectPresignedChainView, initialPresignedGraphChainState, reconcilePresignedGraphChain,
  type PresignedChainBackend, type PresignedGraphChainState } from '../src/presigned/chain.js';
import { withPresignedRegtest } from './lib/presigned-regtest.js';

/**
 * PUBLIC fixture keys, isolated regtest only. Deliberately mine transactions
 * outside submission policy to distinguish observed consensus from relay rules.
 * This is NOT a permissive funding signer or a production consensus interpreter.
 */
await withPresignedRegtest(async core => {
  const curveOrder = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
  const miningAddress = await core.walletRpc('getnewaddress');
  const results: Array<Record<string, unknown>> = [];
  const exitWitnessResults: Array<Record<string, unknown>> = [];
  let confirmedObservationChecks = 0;
  let mempoolNonactivationChecks = 0;
  let reorgInvalidationChecks = 0;
  const regtestGenesis = await core.rpc('getblockhash', [0]);

  /**
   * TEST ONLY: genuine transactions, headers, heights and tip reads from the
   * isolated validating Core node. Production intentionally rejects regtest.
   * This bridge labels otherwise network-independent script fixtures with their
   * approved roster network; it does NOT test production network/genesis gates.
   */
  function testCoreBackend(graph: ReturnType<typeof createPresignedFixture>['graph']): PresignedChainBackend {
    return {
      async getTip() {
        const info = await core.rpc('getblockchaininfo');
        assert.equal(info.chain, 'regtest');
        assert.equal(info.pruned, false);
        assert.equal(info.initialblockdownload, false);
        assert.equal(await core.rpc('getblockhash', [0]), regtestGenesis);
        assert.equal((await core.rpc('getindexinfo')).txindex.synced, true);
        return { network: graph.roster.network, genesisHash: graph.roster.genesisHash,
          hash: info.bestblockhash as string, height: info.blocks as number };
      },
      async getTransaction(txid) {
        try {
          const raw = await core.rpc('getrawtransaction', [txid, true]);
          assert.equal(raw.txid, txid);
          return { kind: 'present', txid, transactionHex: raw.hex as string, blockHash: (raw.blockhash ?? null) as string | null };
        } catch (error) {
          return error && typeof error === 'object' && (error as { rpcCode?: number }).rpcCode === -5
            ? { kind: 'absent', txid } : { kind: 'unknown', txid };
        }
      },
      async getBlock(hash) {
        try {
          const header = await core.rpc('getblockheader', [hash, true]);
          assert.equal(header.hash, hash);
          if (header.confirmations === -1) return { kind: 'inactive', hash, height: header.height as number };
          assert(header.confirmations > 0);
          assert.equal(await core.rpc('getblockhash', [header.height]), hash);
          return { kind: 'active', hash, height: header.height as number, confirmations: header.confirmations as number };
        } catch { return { kind: 'unknown', hash }; }
      },
    };
  }

  async function reconcileFromCore(graph: ReturnType<typeof createPresignedFixture>['graph'],
    currentState = initialPresignedGraphChainState(graph)) {
    const trustedCoreView = await collectPresignedChainView({ graph, currentState, backend: testCoreBackend(graph) });
    const result = reconcilePresignedGraphChain({ graph, currentState, trustedCoreView, requiredConfirmations: 1 });
    assert.equal(result.kind, 'reconciled', result.kind === 'deferred' ? result.reason : 'expected Core reconciliation');
    assert(result.kind === 'reconciled');
    return result;
  }

  async function prepared(feeSats: number, walletKinds: Array<'p2wpkh' | 'p2tr'> = ['p2wpkh', 'p2wpkh', 'p2wpkh']) {
    const fixture = createPresignedFixture({ walletKinds });
    const coins = await core.fundScripts(PARTICIPANT_IDS.map(id => ({
      scriptPubKeyHex: fixture.walletKeys[id].scriptPubKeyHex, valueSats: 12_000,
    })));
    fixture.graph = buildPresignedGraph({ roster: fixture.roster, funding: { ...fixture.graph.funding, feeSats,
      inputs: coins.map((coin, index) => ({ ...coin, participantId: PARTICIPANT_IDS[index]!,
        changeScriptPubKeyHex: coin.scriptPubKeyHex })) } });
    // All descendant counterparty signatures exist BEFORE any wallet signature.
    const preauthorizations = preauthorizePresignedFixture(fixture);
    assert.equal(preauthorizations.length, 12);
    return { fixture, graph: fixture.graph, preauthorizations };
  }

  function strictRejection(graph: ReturnType<typeof createPresignedFixture>['graph'], transactionHex: string) {
    let reason: string | undefined;
    try { authorizePresignedFundingTransaction({ graph, transactionHex }); }
    catch (error) { reason = error instanceof Error ? error.message : 'non-Error rejection'; }
    assert(reason, 'strict submission verifier unexpectedly accepted the policy-invalid funding');
    return reason;
  }

  async function mineExactFunding(graph: ReturnType<typeof createPresignedFixture>['graph'], transactionHex: string) {
    const tx = bitcoin.Transaction.fromHex(transactionHex);
    assert.equal(tx.getId(), graph.fundingTxid);
    assert.equal(nonWitnessTransactionHex(tx), graph.fundingUnsignedTxHex);
    const before = await core.rpc('getblockcount');
    // Unlike sendrawtransaction, generateblock can take raw transactions that
    // never entered the mempool. The resulting block still passes Core consensus.
    const generated = await core.rpc('generateblock', [miningAddress, [transactionHex]]);
    assert.equal(await core.rpc('getblockcount'), before + 1);
    const header = await core.rpc('getblockheader', [generated.hash, true]);
    assert.equal(header.confirmations, 1);
    assert.equal(await core.rpc('getblockhash', [header.height]), generated.hash);
    const raw = await core.rpc('getrawtransaction', [graph.fundingTxid, true]);
    assert.equal(raw.hex, transactionHex);
    assert.equal(raw.blockhash, generated.hash);
    assert.equal(raw.confirmations, 1);
    const coin = await core.rpc('gettxout', [graph.fundingTxid, 0, true]);
    assert(coin, 'mined graph output is missing');
    assert.equal(Math.round(coin.value * 1e8), graph.roster.economics.depositSatsPerParticipant * 3);
    const full = graph.rounds.find(round => round.participantIds.length === 3)!;
    assert.equal(coin.scriptPubKey.hex, full.outputScriptHex);
    const observed = await reconcileFromCore(graph);
    assert.deepEqual(observed.state.confirmed.map(item => item.exitId), [null]);
    assert.equal(observed.projectedOutput?.valueSats, 30_000);
    confirmedObservationChecks++;
    return { blockHash: generated.hash as string, blockHeight: header.height as number, fundingVsize: tx.virtualSize(),
      actualCoreFundingRecognition: true };
  }

  async function verifyDescendants(state: Awaited<ReturnType<typeof prepared>>, alternateLeaverSighash = false) {
    const { fixture, graph, preauthorizations } = state;
    const signed = new Map(graph.exits.map(exit => [exit.id, completePresignedExit({
      graph, preauthorizations, exitId: exit.id, participantId: exit.leaver,
      privateKey: fixture.keysById[exit.leaver].soloPrivateKeys[exit.roundId]!, approvedGraphDigest: graph.digest,
    })]));
    if (alternateLeaverSighash) {
      const exit = graph.exits.find(item => item.id === 'alice')!;
      const original = signed.get(exit.id)!;
      const round = graph.rounds.find(item => item.id === exit.roundId)!;
      const tx = bitcoin.Transaction.fromHex(original.transactionHex);
      const message = tx.hashForWitnessV1(0, [Buffer.from(exit.inputScriptPubKeyHex, 'hex')],
        [BigInt(exit.inputValueSats)], bitcoin.Transaction.SIGHASH_ALL, Buffer.from(round.solo.leafHash, 'hex'));
      const signature = ecc.signSchnorr(message, fixture.keysById.alice.soloPrivateKeys[exit.roundId]!);
      const slot = round.solo.threshold - 1 - round.solo.participantIds.indexOf('alice');
      tx.ins[0]!.witness[slot] = Buffer.concat([signature, Buffer.from([bitcoin.Transaction.SIGHASH_ALL])]);
      assert.equal(tx.getId(), original.txid);
      assert.equal(nonWitnessTransactionHex(tx), exit.unsignedTxHex);
      assert.throws(() => authorizePresignedExitTransaction({ graph, exitId: exit.id, transactionHex: tx.toHex() }), /SIGHASH_DEFAULT/u);
      signed.set(exit.id, { ...original, transactionHex: tx.toHex(), vsize: tx.virtualSize() });
      core.record('sighash-all-exit-witness', { graphDigest: graph.digest, exitId: exit.id,
        unchangedExitTxid: tx.getId(), originalTransactionHex: original.transactionHex, transactionHex: tx.toHex(),
        onlyDesignatedLeaverSignatureChanged: true, counterpartyPreauthorizationsUnchanged: true });
    }
    for (const exit of graph.exits) {
      const candidate = signed.get(exit.id)!;
      const prefix = exit.parentExitId ? [signed.get(exit.parentExitId)!.transactionHex] : [];
      const acceptance = await core.rpc('testmempoolaccept', [[...prefix, candidate.transactionHex]]);
      assert.equal(acceptance.at(-1).allowed, true, JSON.stringify(acceptance));
      assert.equal(candidate.txid, exit.txid, 'witness variation changed a descendant dependency');
    }
    const first = signed.get('alice')!;
    const second = signed.get('alice/bob')!;
    let chainState: PresignedGraphChainState = (await reconcileFromCore(graph)).state;
    assert.deepEqual(chainState.confirmed.map(item => item.exitId), [null]);
    for (const candidate of [first, second]) {
      assert.equal(await core.rpc('sendrawtransaction', [candidate.transactionHex]), candidate.txid);
      const pending = await reconcileFromCore(graph, chainState);
      assert.deepEqual(pending.state, chainState, 'mempool transaction activated a graph transition');
      mempoolNonactivationChecks++;
      await core.mine();
      const raw = await core.rpc('getrawtransaction', [candidate.txid, true]);
      assert(raw.confirmations >= 1);
      assert.equal(raw.hex, candidate.transactionHex);
      const observed = await reconcileFromCore(graph, chainState);
      assert.equal(observed.state.confirmed.length, chainState.confirmed.length + 1);
      assert.equal(observed.state.confirmed.at(-1)!.txid, candidate.txid);
      chainState = observed.state;
      confirmedObservationChecks++;
    }
    const final = await core.rpc('gettxout', [second.txid, 1, true]);
    assert.equal(Math.round(final.value * 1e8), 9350);
    if (alternateLeaverSighash) {
      const previous = chainState;
      const restoreBlock = previous.confirmed.at(-1)!.blockHash;
      await core.rpc('invalidateblock', [previous.confirmed[1]!.blockHash]);
      const rolledBack = await reconcileFromCore(graph, previous);
      assert.deepEqual(rolledBack.invalidated.map(item => item.exitId), ['alice/bob', 'alice']);
      assert.deepEqual(rolledBack.state.confirmed.map(item => item.exitId), [null]);
      await core.rpc('invalidateblock', [previous.confirmed[0]!.blockHash]);
      const unfunded = await reconcileFromCore(graph, rolledBack.state);
      assert.deepEqual(unfunded.invalidated.map(item => item.exitId), [null]);
      assert.equal(unfunded.state.confirmed.length, 0);
      await core.rpc('reconsiderblock', [restoreBlock]);
      const restored = await reconcileFromCore(graph, unfunded.state);
      assert.deepEqual(restored.state, previous);
      assert.deepEqual(restored.added.map(item => item.exitId), [null, 'alice', 'alice/bob']);
      reorgInvalidationChecks += 2;
      core.record('observed-reorganization', { previous, afterExitInvalidation: rolledBack.state,
        afterFundingInvalidation: unfunded.state, restored: restored.state });
    }
    return { acceptedExits: graph.exits.length, firstTxid: first.txid, secondTxid: second.txid, finalPayoutSats: 9350,
      soloExitVersion: bitcoin.Transaction.fromHex(first.transactionHex).version, alternateLeaverSighash };
  }

  {
    const state = await prepared(600);
    const { fixture, graph } = state;
    const low = signPresignedFixtureFunding(fixture);
    const lowAcceptance = await core.rpc('testmempoolaccept', [[low.transactionHex]]);
    assert.equal(lowAcceptance[0].allowed, true, JSON.stringify(lowAcceptance));
    const high = bitcoin.Transaction.fromHex(low.transactionHex);
    const witness = high.ins[0]!.witness.map(item => Buffer.from(item));
    const decoded = bitcoin.script.signature.decode(witness[0]!);
    const compact = Buffer.from(decoded.signature);
    const oldS = BigInt(`0x${compact.subarray(32).toString('hex')}`);
    assert(oldS > 0n && oldS <= curveOrder / 2n);
    Buffer.from((curveOrder - oldS).toString(16).padStart(64, '0'), 'hex').copy(compact, 32);
    // Public arithmetic only: no private key is used to mutate this signature.
    witness[0] = Buffer.from(bitcoin.script.signature.encode(compact, decoded.hashType));
    high.setWitness(0, witness);
    assert.notEqual(high.toHex(), low.transactionHex);
    assert.equal(high.getId(), low.txid);
    const wallet = fixture.walletKeys.alice;
    const scriptCode = bitcoin.payments.p2pkh({ pubkey: wallet.publicKey }).output!;
    const message = high.hashForWitnessV0(0, scriptCode, BigInt(graph.funding.inputs[0]!.valueSats), decoded.hashType);
    assert(ecc.verify(message, wallet.publicKey, compact, false));
    assert(!ecc.verify(message, wallet.publicKey, compact, true));
    const strictReason = strictRejection(graph, high.toHex());
    assert.match(strictReason, /high-S/u);
    const acceptance = await core.rpc('testmempoolaccept', [[high.toHex()]]);
    assert.equal(acceptance[0].allowed, false, JSON.stringify(acceptance));
    assert.match(acceptance[0]['reject-reason'] ?? '', /non-mandatory-script-verify-flag|non-canonical|high.?s/iu);
    const mined = await mineExactFunding(graph, high.toHex());
    const descendants = await verifyDescendants(state);
    const result = { case: 'public-low-S-to-high-S-mutation', feeSats: graph.funding.feeSats,
      strictReason, mempoolRejection: acceptance[0], mutationNeedsPrivateKey: false,
      unchangedFundingTxid: graph.fundingTxid, ...mined, ...descendants };
    core.record('high-s-funding', { ...result, lowSFundingTransactionHex: low.transactionHex, highSFundingTransactionHex: high.toHex() });
    results.push(result);
    console.log(JSON.stringify({ stage: 'high-S-funding-consensus-confirmed', ...result }));
  }

  {
    const state = await prepared(1);
    const { fixture, graph } = state;
    // Test-only assembly bypasses the finalization relay floor deliberately.
    // Production finalizePresignedFunding must continue rejecting this transaction.
    const tx = bitcoin.Transaction.fromHex(graph.fundingUnsignedTxHex);
    for (const id of PARTICIPANT_IDS) {
      const wallet = fixture.walletKeys[id];
      const index = graph.funding.inputs.findIndex(coin => coin.participantId === id);
      const psbt = bitcoin.Psbt.fromBase64(graph.fundingPsbtBase64);
      psbt.signInput(index, { publicKey: wallet.publicKey, sign: hash => ecc.sign(hash, wallet.privateKey) });
      const contribution = authorizePresignedFundingSignedPsbt({ graph, participantId: id,
        signedPsbtBase64: psbt.toBase64(), approvedGraphDigest: graph.digest });
      tx.setWitness(index, contribution.witness.map(item => Buffer.from(item, 'hex')));
    }
    const transactionHex = tx.toHex();
    const strictReason = strictRejection(graph, transactionHex);
    assert.match(strictReason, /fee below/u);
    const acceptance = await core.rpc('testmempoolaccept', [[transactionHex]]);
    assert.equal(acceptance[0].allowed, false, JSON.stringify(acceptance));
    assert.match(acceptance[0]['reject-reason'] ?? '', /fee/iu);
    const mined = await mineExactFunding(graph, transactionHex);
    const descendants = await verifyDescendants(state);
    const result = { case: 'one-satoshi-funding-fee', feeSats: 1, strictReason,
      mempoolRejection: acceptance[0], unchangedFundingTxid: graph.fundingTxid, ...mined, ...descendants };
    core.record('one-sat-funding', { ...result, transactionHex });
    results.push(result);
    console.log(JSON.stringify({ stage: 'one-sat-funding-consensus-confirmed', ...result }));
  }

  {
    const state = await prepared(600, ['p2tr', 'p2tr', 'p2tr']);
    const { fixture, graph } = state;
    const original = signPresignedFixtureFunding(fixture);
    const originalAcceptance = await core.rpc('testmempoolaccept', [[original.transactionHex]]);
    assert.equal(originalAcceptance[0].allowed, true, JSON.stringify(originalAcceptance));
    const tx = bitcoin.Transaction.fromHex(original.transactionHex);
    // Consensus-scale observation must not inherit the old 100,000-hex send cap.
    const annex = Buffer.alloc(60_000, 0x21); annex[0] = 0x50;
    const wallet = fixture.walletKeys.alice;
    const even = wallet.publicKey[0] === 3 ? ecc.privateNegate(wallet.privateKey) : wallet.privateKey;
    const tweaked = ecc.privateAdd(even, bitcoin.crypto.taggedHash('TapTweak', wallet.publicKey.subarray(1)))!;
    const message = tx.hashForWitnessV1(0,
      graph.funding.inputs.map(coin => Buffer.from(coin.scriptPubKeyHex, 'hex')),
      graph.funding.inputs.map(coin => BigInt(coin.valueSats)), bitcoin.Transaction.SIGHASH_DEFAULT, undefined, annex);
    const signature = ecc.signSchnorr(message, tweaked);
    assert(ecc.verifySchnorr(message, Buffer.from(graph.funding.inputs[0]!.scriptPubKeyHex, 'hex').subarray(2), signature));
    tx.setWitness(0, [signature, annex]);
    assert.equal(tx.getId(), original.txid);
    const transactionHex = tx.toHex();
    const strictReason = strictRejection(graph, transactionHex);
    assert.match(strictReason, /malformed funding|without annex/u);
    assert(transactionHex.length > 100_000);
    const acceptance = await core.rpc('testmempoolaccept', [[transactionHex]]);
    assert.equal(typeof acceptance[0].allowed, 'boolean', JSON.stringify(acceptance));
    const mined = await mineExactFunding(graph, transactionHex);
    const descendants = await verifyDescendants(state);
    const result = { case: 'wallet-authorized-P2TR-annex', feeSats: graph.funding.feeSats, strictReason,
      mempoolAcceptance: acceptance[0], mutationNeedsPrivateKey: true, annexBytes: annex.length,
      unchangedFundingTxid: graph.fundingTxid, ...mined, ...descendants };
    core.record('annex-funding', { ...result, originalFundingTransactionHex: original.transactionHex, transactionHex });
    results.push(result);
    console.log(JSON.stringify({ stage: 'annex-funding-consensus-confirmed', ...result }));
  }

  {
    const state = await prepared(600);
    const funding = signPresignedFixtureFunding(state.fixture);
    assert.equal(await core.rpc('sendrawtransaction', [funding.transactionHex]), state.graph.fundingTxid);
    const pending = await reconcileFromCore(state.graph);
    assert.equal(pending.state.confirmed.length, 0, 'mempool funding must not activate the graph');
    mempoolNonactivationChecks++;
    await core.mine();
    const descendants = await verifyDescendants(state, true);
    const result = { case: 'designated-leaver-SIGHASH-ALL-exit', strictExitVerifierRejected: true,
      coreMempoolAcceptedAndConfirmed: true, counterpartyPreauthorizationsUnchanged: true, ...descendants };
    exitWitnessResults.push(result);
    console.log(JSON.stringify({ stage: 'alternate-leaver-sighash-confirmed', ...result }));
  }

  const summary = { passed: true, protocol: 'presigned-graph-v2', chain: 'isolated-regtest',
    coreVersion: core.coreVersion, publicNetworkBroadcasts: 0, preauthorizationsBeforeFundingSignatures: true,
    confirmedLocallyPolicyInvalidFundingTransactions: results.length, acceptedDescendants: 36,
    completeExitPathsConfirmed: 4, taprootAnnexTested: true, taprootScriptPathVariantTested: false,
    productionObservedRecognizerVerifiedAgainstCore: true, productionCoreNetworkBindingVerified: false,
    confirmedObservationChecks, mempoolNonactivationChecks, reorgInvalidationChecks, results, exitWitnessResults };
  core.record('observed-witnesses-acceptance', summary);
  console.log(JSON.stringify(summary, null, 2));
});
