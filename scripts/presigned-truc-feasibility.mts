/**
 * EXPERIMENT ONLY: public deterministic fixture keys, isolated network-disabled
 * Core regtest. This does NOT change or claim to validate production v2 policy.
 * Run: PATH=/home/codex/.local/bin:$PATH node_modules/.bin/tsx scripts/presigned-truc-feasibility.mts
 */
import assert from 'node:assert/strict';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { deterministicKeypair } from '../src/crypto.js';
import { createPresignedFixture, signPresignedFixtureFunding } from '../src/presigned/fixtures.js';
import { buildPresignedGraph } from '../src/presigned/graph.js';
import { payoutScript } from '../src/presigned/roster.js';
import { PARTICIPANT_IDS, type ParticipantId, type PresignedExit } from '../src/presigned/types.js';
import { nativeWalletWitnessFromPsbt, verifyNativeWalletWitness } from '../src/presigned/wallet.js';
import { withPresignedRegtest, type PresignedRegtest, type PresignedRegtestCoin } from './lib/presigned-regtest.js';

type Fixture = ReturnType<typeof createPresignedFixture>;
type Coin = Pick<PresignedRegtestCoin, 'txid' | 'vout' | 'valueSats' | 'scriptPubKeyHex'>;
type ExperimentalExit = PresignedExit & { transaction: bitcoin.Transaction; preauthorizations: Map<ParticipantId, Uint8Array> };

function fixtureWallet(label: string) {
  const pair = deterministicKeypair('public-truc-feasibility-fixture-never-fund', label);
  const privateKey = Buffer.from(pair.privateKeyHex, 'hex');
  const publicKey = Buffer.from(pair.publicKeyHex, 'hex');
  const scriptPubKeyHex = Buffer.from(bitcoin.payments.p2tr({ internalPubkey: publicKey.subarray(1) }).output!).toString('hex');
  return { privateKey, publicKey, scriptPubKeyHex };
}

function tweakedSecret(privateKey: Uint8Array) {
  const pubkey = Buffer.from(ecc.pointFromScalar(privateKey, true)!);
  return ecc.privateAdd(pubkey[0] === 3 ? ecc.privateNegate(privateKey) : privateKey,
    bitcoin.crypto.taggedHash('TapTweak', pubkey.subarray(1)))!;
}

/** Rebuild all nine txids and all twelve counterparty signatures before funding. */
function experimentalGraph(fixture: Fixture) {
  const exits = new Map<string, ExperimentalExit>();
  for (const original of [...fixture.graph.exits].sort((a, b) => Number(Boolean(a.parentExitId)) - Number(Boolean(b.parentExitId)))) {
    const transaction = bitcoin.Transaction.fromHex(original.unsignedTxHex);
    transaction.version = 3;
    const inputTxid = original.parentExitId ? exits.get(original.parentExitId)!.txid : fixture.graph.fundingTxid;
    transaction.ins[0]!.hash = Buffer.from(inputTxid, 'hex').reverse();
    const round = fixture.graph.rounds.find(item => item.id === original.roundId)!;
    const signatureHash = transaction.hashForWitnessV1(0, [Buffer.from(original.inputScriptPubKeyHex, 'hex')],
      [BigInt(original.inputValueSats)], bitcoin.Transaction.SIGHASH_DEFAULT, Buffer.from(round.solo.leafHash, 'hex'));
    const preauthorizations = new Map<ParticipantId, Uint8Array>();
    for (const id of round.participantIds.filter(id => id !== original.leaver)) {
      const signature = ecc.signSchnorr(signatureHash, fixture.keysById[id].soloPrivateKeys[round.id]!);
      const publicKey = Buffer.from(round.solo.publicKeys[round.solo.participantIds.indexOf(id)]!, 'hex');
      assert(ecc.verifySchnorr(signatureHash, publicKey, signature));
      preauthorizations.set(id, signature);
    }
    assert.notEqual(transaction.getId(), original.txid);
    assert.deepEqual(transaction.outs, bitcoin.Transaction.fromHex(original.unsignedTxHex).outs, 'experiment changed payout economics/scripts');
    exits.set(original.id, { ...original, inputTxid, transaction, unsignedTxHex: transaction.toHex(), txid: transaction.getId(),
      signatureHash: Buffer.from(signatureHash).toString('hex'), preauthorizations });
  }
  assert.equal(exits.size, 9);
  assert.equal([...exits.values()].reduce((sum, exit) => sum + exit.preauthorizations.size, 0), 12);
  return exits;
}

function completeExit(fixture: Fixture, exit: ExperimentalExit) {
  const round = fixture.graph.rounds.find(item => item.id === exit.roundId)!;
  const hash = Buffer.from(exit.signatureHash, 'hex');
  const signatures = round.solo.participantIds.map((id, index) => {
    const signature = id === exit.leaver ? ecc.signSchnorr(hash, fixture.keysById[id].soloPrivateKeys[round.id]!) : exit.preauthorizations.get(id)!;
    assert(signature.length === 64 && ecc.verifySchnorr(hash, Buffer.from(round.solo.publicKeys[index]!, 'hex'), signature));
    return signature;
  });
  const tx = exit.transaction.clone();
  tx.setWitness(0, [...signatures.reverse(), Buffer.from(round.solo.scriptHex, 'hex'), Buffer.from(round.solo.controlBlockHex, 'hex')]);
  assert.equal(tx.getId(), exit.txid);
  return tx;
}

async function scenario(core: PresignedRegtest, label: string) {
  const fixture = createPresignedFixture();
  const sponsorScripts = await Promise.all(['bech32m', 'bech32'].map(async kind => {
    const address = await core.walletRpc('getnewaddress', [`${label}-${kind}`, kind]);
    return Buffer.from(bitcoin.address.toOutputScript(address, bitcoin.networks.regtest)).toString('hex');
  }));
  const coins = await core.fundScripts([
    ...PARTICIPANT_IDS.map(id => ({ scriptPubKeyHex: fixture.walletKeys[id].scriptPubKeyHex, valueSats: 12_000 })),
    ...sponsorScripts.map(scriptPubKeyHex => ({ scriptPubKeyHex, valueSats: 100_000 })),
  ]);
  fixture.graph = buildPresignedGraph({ roster: fixture.roster, funding: { ...fixture.graph.funding,
    inputs: coins.slice(0, 3).map((coin, index) => ({ ...coin, participantId: PARTICIPANT_IDS[index]!, changeScriptPubKeyHex: coin.scriptPubKeyHex })) } });
  const exits = experimentalGraph(fixture);
  const funding = signPresignedFixtureFunding(fixture);
  assert.equal(bitcoin.Transaction.fromHex(funding.transactionHex).version, 2);
  return { fixture, exits, funding, sponsorCoins: coins.slice(3), originalGraph: JSON.stringify(fixture.graph) };
}

/** Actual descriptor-wallet signing, not a simulated external signer. */
async function sponsoredChild(core: PresignedRegtest, fixture: Fixture, parent: bitcoin.Transaction, exit: ExperimentalExit,
  sponsor: Coin, feeSats: number, version = 3) {
  const payout = parent.outs[0]!;
  const psbt = new bitcoin.Psbt();
  psbt.setVersion(version);
  psbt.addInput({ hash: parent.getId(), index: 0, sequence: 0xfffffffd,
    witnessUtxo: { script: payout.script, value: payout.value } });
  psbt.addInput({ hash: sponsor.txid, index: sponsor.vout, sequence: 0xfffffffd,
    witnessUtxo: { script: Buffer.from(sponsor.scriptPubKeyHex, 'hex'), value: BigInt(sponsor.valueSats) } });
  psbt.addOutput({ script: payout.script, value: payout.value });
  psbt.addOutput({ script: Buffer.from(sponsor.scriptPubKeyHex, 'hex'), value: BigInt(sponsor.valueSats - feeSats) });
  const tx = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
  const originalUnsignedHex = tx.toHex();
  const response = await core.walletRpc('walletprocesspsbt', [psbt.toBase64(), true, 'ALL', true, false]);
  const walletPsbt = bitcoin.Psbt.fromBase64(response.psbt);
  assert.equal(bitcoin.Transaction.fromBuffer(walletPsbt.data.globalMap.unsignedTx.toBuffer()).toHex(), originalUnsignedHex,
    'Core wallet changed the explicitly approved version-3 transaction');
  assert(!walletPsbt.data.inputs[0]!.tapKeySig && !walletPsbt.data.inputs[0]!.finalScriptWitness,
    'Core fixture wallet unexpectedly has the participant payout secret');
  const prevouts = [{ scriptPubKeyHex: Buffer.from(payout.script).toString('hex'), valueSats: Number(payout.value) }, sponsor];
  const walletWitness = nativeWalletWitnessFromPsbt(walletPsbt.data.inputs[1]!);
  verifyNativeWalletWitness(tx, 1, prevouts, walletWitness);
  const payoutHash = tx.hashForWitnessV1(0, prevouts.map(coin => Buffer.from(coin.scriptPubKeyHex, 'hex')),
    prevouts.map(coin => BigInt(coin.valueSats)), bitcoin.Transaction.SIGHASH_DEFAULT);
  const payoutWitness = [ecc.signSchnorr(payoutHash, tweakedSecret(fixture.keysById[exit.leaver].payoutPrivateKey))];
  verifyNativeWalletWitness(tx, 0, prevouts, payoutWitness);
  tx.setWitness(0, payoutWitness);
  tx.setWitness(1, walletWitness);
  assert.deepEqual(tx.outs[0], payout);
  assert.equal(sponsor.valueSats - Number(tx.outs[1]!.value), feeSats);
  assert(tx.virtualSize() <= 1000, 'intended fee child exceeds TRUC child size');
  return { tx, feeSats, walletWitnessBytes: walletWitness.map(item => item.length), sponsor };
}

function selfSpend(coin: Coin, secret: Uint8Array, feeSats: number, version = 3, payloadBytes = 0) {
  const tx = new bitcoin.Transaction();
  tx.version = version;
  tx.addInput(Buffer.from(coin.txid, 'hex').reverse(), coin.vout, 0xfffffffd);
  tx.addOutput(Buffer.from(coin.scriptPubKeyHex, 'hex'), BigInt(coin.valueSats - feeSats));
  if (payloadBytes) tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, Buffer.alloc(payloadBytes, 7)]), 0n);
  const hash = tx.hashForWitnessV1(0, [Buffer.from(coin.scriptPubKeyHex, 'hex')], [BigInt(coin.valueSats)], bitcoin.Transaction.SIGHASH_DEFAULT);
  tx.setWitness(0, [ecc.signSchnorr(hash, tweakedSecret(secret))]);
  return tx;
}

function pairRecovery(fixture: Fixture, first: ExperimentalExit) {
  const pairScript = first.transaction.outs[1]!.script;
  const round = fixture.graph.rounds.find(item => item.outputScriptHex === Buffer.from(pairScript).toString('hex'))!;
  const tx = new bitcoin.Transaction();
  tx.version = 3;
  tx.addInput(Buffer.from(first.txid, 'hex').reverse(), 1, fixture.roster.economics.recoveryDelayBlocks);
  const total = Number(first.transaction.outs[1]!.value) - fixture.roster.economics.recoveryFeeSats;
  [...round.participantIds].sort().forEach((id, index, ids) => tx.addOutput(payoutScript(fixture.roster, id),
    BigInt(Math.floor(total / ids.length) + (index < total % ids.length ? 1 : 0))));
  const hash = tx.hashForWitnessV1(0, [pairScript], [first.transaction.outs[1]!.value], bitcoin.Transaction.SIGHASH_DEFAULT,
    Buffer.from(round.recovery.leafHash, 'hex'));
  const signatures = round.recovery.participantIds.map((id, index) => index < round.recovery.threshold
    ? ecc.signSchnorr(hash, fixture.keysById[id].personalPrivateKey) : Buffer.alloc(0));
  tx.setWitness(0, [...signatures.reverse(), Buffer.from(round.recovery.scriptHex, 'hex'), Buffer.from(round.recovery.controlBlockHex, 'hex')]);
  return tx;
}

async function submit(core: PresignedRegtest, label: string, txs: bitcoin.Transaction[]) {
  const response = await core.rpc('submitpackage', [txs.map(tx => tx.toHex())]);
  core.record(label, response);
  assert.equal(response.package_msg, 'success', JSON.stringify(response));
  const results = Object.values(response['tx-results'] ?? {}) as any[];
  for (const tx of txs) {
    assert(results.some(result => result.txid === tx.getId() && !result.error), JSON.stringify(response));
    assert(await core.rpc('getmempoolentry', [tx.getId()]));
  }
  return response;
}

async function rejected(core: PresignedRegtest, label: string, tx: bitcoin.Transaction, reason: RegExp) {
  const result = await core.rpc('testmempoolaccept', [[tx.toHex()]]);
  core.record(label, result);
  assert.equal(result[0].allowed, false, JSON.stringify(result));
  assert.match(result[0]['reject-reason'], reason);
  return result[0]['reject-reason'] as string;
}

await withPresignedRegtest(async core => {
  try {
    const firstScenario = await scenario(core, 'topology');
    const { fixture, exits, funding } = firstScenario;
    const first = exits.get('alice')!;
    const second = exits.get('alice/bob')!;
    const firstTx = completeExit(fixture, first);
    const secondTx = completeExit(fixture, second);
    await core.rpc('sendrawtransaction', [funding.transactionHex]);
    const inheritance = await rejected(core, 'unconfirmed-vtwo-funding-rejected', firstTx, /TRUC|non-TRUC/i);
    await core.mine();
    await submit(core, 'truc-game-parent-successor', [firstTx, secondTx]);
    const fee = await sponsoredChild(core, fixture, firstTx, first, firstScenario.sponsorCoins[0]!, 3_000);
    const sibling = await submit(core, 'truc-sibling-eviction', [firstTx, fee.tx]);
    assert((sibling['replaced-transactions'] ?? []).includes(secondTx.getId()), 'Core did not report sibling eviction');
    assert(!(await core.rpc('getrawmempool')).includes(secondTx.getId()));
    const pairBlocked = await rejected(core, 'low-fee-successor-cannot-evict-cpfp', secondTx, /insufficient fee|TRUC/i);

    // The leaver can sign a descendant of its preserved payout, but topology
    // policy rejects that valid signature before it can flood the cluster.
    const payoutCoin = { txid: fee.tx.getId(), vout: 0, valueSats: Number(fee.tx.outs[0]!.value),
      scriptPubKeyHex: Buffer.from(fee.tx.outs[0]!.script).toString('hex') };
    const flood = selfSpend(payoutCoin, fixture.keysById.alice.payoutPrivateKey, 1_000);
    const floodReject = await rejected(core, 'truc-grandchild-flood-rejected', flood, /TRUC/i);
    await rejected(core, 'vtwo-grandchild-cannot-bypass-truc', selfSpend(payoutCoin, fixture.keysById.alice.payoutPrivateKey, 1_000, 2), /TRUC|non-TRUC/i);
    const wrongVersionChild = await sponsoredChild(core, fixture, firstTx, first, firstScenario.sponsorCoins[0]!, 8_000, 2);
    await rejected(core, 'vtwo-fee-child-rejected', wrongVersionChild.tx, /TRUC|non-TRUC/i);
    const replacement = await sponsoredChild(core, fixture, firstTx, first, firstScenario.sponsorCoins[0]!, 4_000);
    const replaced = await submit(core, 'truc-child-only-replacement', [firstTx, replacement.tx]);
    assert((replaced['replaced-transactions'] ?? []).includes(fee.tx.getId()));
    assert.equal(firstTx.getId(), first.txid);
    assert.deepEqual(firstTx.outs[1], first.transaction.outs[1]);
    console.log(JSON.stringify({ stage: 'truc-sibling-eviction-and-flood-proof', siblingEvicted: secondTx.getId(), floodReject }));
    await core.mine();
    const recovery = pairRecovery(fixture, first);
    await rejected(core, 'truc-csv-immature', recovery, /non-BIP68-final/);
    await core.mine(fixture.roster.economics.recoveryDelayBlocks - 1);
    const matureRecovery = await core.rpc('testmempoolaccept', [[recovery.toHex()]]);
    assert.equal(matureRecovery[0].allowed, true, JSON.stringify(matureRecovery));
    core.record('truc-csv-mature', matureRecovery);
    const secondFee = await sponsoredChild(core, fixture, secondTx, second, firstScenario.sponsorCoins[1]!, 3_000);
    await submit(core, 'truc-confirmed-first-then-pair', [secondTx, secondFee.tx]);
    await core.mine();
    assert((await core.rpc('getrawtransaction', [secondTx.getId(), true])).confirmations >= 1);
    assert.equal(JSON.stringify(fixture.graph), firstScenario.originalGraph);

    // Direct block assembly intentionally bypasses relay policy. These exact
    // signed transactions are still subject to Bitcoin Core consensus checks.
    const direct = await scenario(core, 'same-block');
    await core.rpc('sendrawtransaction', [direct.funding.transactionHex]);
    await core.mine();
    const directFirst = completeExit(direct.fixture, direct.exits.get('alice')!);
    const directSecond = completeExit(direct.fixture, direct.exits.get('alice/bob')!);
    const directFee = await sponsoredChild(core, direct.fixture, directFirst, direct.exits.get('alice')!, direct.sponsorCoins[0]!, 3_000);
    const miningAddress = await core.walletRpc('getnewaddress');
    const generated = await core.rpc('generateblock', [miningAddress, [directFirst.toHex(), directSecond.toHex(), directFee.tx.toHex()]]);
    const block = await core.rpc('getblock', [generated.hash]);
    for (const tx of [directFirst, directSecond, directFee.tx]) assert(block.tx.includes(tx.getId()));
    core.record('truc-same-block-consensus', { generated, transactionIds: block.tx,
      bypassedRelayPolicyIntentionally: true, fundingPreviouslyConfirmed: true });

    // Raise the real rolling floor through actual low-feerate mempool eviction.
    // No prioritisetransaction, mock floor, synthetic RPC, or public traffic.
    const fillers = Array.from({ length: 90 }, (_, index) => fixtureWallet(`mempool-filler-${index}`));
    const fillerCoins = await core.fundScripts(fillers.map(wallet => ({ scriptPubKeyHex: wallet.scriptPubKeyHex, valueSats: 1_000_000 })));
    const congestion = await scenario(core, 'rolling-floor');
    await core.rpc('sendrawtransaction', [congestion.funding.transactionHex]);
    await core.mine();
    const floorBefore = await core.rpc('getmempoolinfo');
    assert.equal(floorBefore.maxmempool, 5_000_000);
    const acceptedFillers: string[] = [];
    let triggeringRejection: string | null = null;
    for (let index = 0; index < fillers.length; index++) {
      const tx = selfSpend(fillerCoins[index]!, fillers[index]!.privateKey, 160_500, 2, 80_000);
      assert(tx.virtualSize() < 100_000);
      try { assert.equal(await core.rpc('sendrawtransaction', [tx.toHex()]), tx.getId()); acceptedFillers.push(tx.getId()); }
      catch (error) {
        triggeringRejection = String(error);
        assert.match(triggeringRejection, /mempool.*(full|min fee)|mempool min fee/i);
        break;
      }
      if ((await core.rpc('getmempoolinfo')).mempoolminfee > floorBefore.mempoolminfee) break;
    }
    const floorAfter = await core.rpc('getmempoolinfo');
    assert(floorAfter.mempoolminfee > floorBefore.mempoolminfee, 'actual rolling floor did not rise through eviction');
    const remaining = await core.rpc('getrawmempool');
    assert(triggeringRejection || acceptedFillers.some(txid => !remaining.includes(txid)), 'no real mempool eviction was observed');
    const congestedExit = congestion.exits.get('alice')!;
    const congestedParent = completeExit(congestion.fixture, congestedExit);
    const lowParentReason = await rejected(core, 'truc-parent-below-real-rolling-floor', congestedParent, /mempool min fee/);
    const insufficientFee = await sponsoredChild(core, congestion.fixture, congestedParent, congestedExit, congestion.sponsorCoins[0]!, 100);
    const insufficientPackage = await core.rpc('submitpackage', [[congestedParent.toHex(), insufficientFee.tx.toHex()]]);
    assert.notEqual(insufficientPackage.package_msg, 'success');
    assert(!(await core.rpc('getrawmempool')).includes(congestedParent.getId()));
    core.record('truc-insufficient-congested-package', insufficientPackage);
    const adequateFee = await sponsoredChild(core, congestion.fixture, congestedParent, congestedExit, congestion.sponsorCoins[0]!, 3_000);
    await submit(core, 'truc-real-rolling-floor-package-rescue', [congestedParent, adequateFee.tx]);
    const bumped = await sponsoredChild(core, congestion.fixture, congestedParent, congestedExit, congestion.sponsorCoins[0]!, 4_000);
    await submit(core, 'truc-real-rolling-floor-child-replacement', [congestedParent, bumped.tx]);
    core.record('truc-real-rolling-floor', { floorBefore, floorAfter, acceptedFillerCount: acceptedFillers.length,
      triggeringRejection, parentRejectedAlone: lowParentReason, actualEviction: true, feePrioritizationUsed: false,
      parentFeeSats: congestedExit.feeSats, parentVsize: congestedParent.virtualSize(), childFeeSats: adequateFee.feeSats,
      childVsize: adequateFee.tx.virtualSize() });
    await core.mine();
    assert((await core.rpc('getrawtransaction', [congestedParent.getId(), true])).confirmations >= 1);
    assert((await core.rpc('getrawtransaction', [bumped.tx.getId(), true])).confirmations >= 1);
    const summary = { passed: true, experimentalOnly: true, productionProtocolChanged: false,
      chain: 'isolated-regtest', coreVersion: core.coreVersion, publicNetworkBroadcasts: 0,
      fundingVersion: 2, gameAndFeeChildVersion: 3, allNineExitTxidsAndTwelvePresignaturesRebuilt: true,
      payoutEconomicsAndScriptsUnchanged: true, confirmedFundingRequiredByRelay: inheritance,
      realSiblingEviction: true, lowFeeSuccessorMustWaitForConfirmedFirst: pairBlocked,
      descendantFloodRejected: floodReject, childOnlyReplacement: true,
      actualCoreWalletPsbtSignatures: { p2tr: fee.walletWitnessBytes, p2wpkh: secondFee.walletWitnessBytes },
      matureCsvAcceptedAndImmatureRejected: true, firstThenPairConfirmedWithSponsors: true,
      sameBlockMultiChildConsensusValidViaDirectBlock: true, highRollingFloorFromRealEviction: true,
      congestedPackageRescueAndReplacement: true, liveSignetOrWalletHardwareVerified: false, evidence: core.directory };
    core.record('truc-feasibility', summary);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    core.record('truc-failure', { message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null });
    throw error;
  }
}, { maxMempoolMb: 5 });
