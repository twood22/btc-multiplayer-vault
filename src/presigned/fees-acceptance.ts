import assert from 'node:assert/strict';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { deterministicKeypair, sha256Hex } from '../crypto.js';
import type { BitcoinNetworkName } from '../types.js';
import { completePresignedExit } from './signing.js';
import type { PresignedGraph } from './types.js';
import { createPresignedFixture, preauthorizePresignedFixture } from './fixtures.js';
import { verifyNativeWalletWitness } from './wallet.js';
import {
  authorizePresignedFeeChild, buildPresignedFeeChild, finalizePresignedFeeChild, signPresignedFeePayout,
  type FeeCoinObservation, type PresignedFeeRequest,
} from './fees.js';

const checks: string[] = [];
type WalletKind = 'p2tr-default' | 'p2tr-all' | 'p2wpkh';

function fixture(network: BitcoinNetworkName) {
  const shared = createPresignedFixture({ network });
  return { graph: shared.graph, keys: shared.keysById, preauthorizations: preauthorizePresignedFixture(shared) };
}

function coin(graph: PresignedGraph, values: Pick<FeeCoinObservation, 'txid' | 'vout' | 'valueSats' | 'scriptPubKeyHex'>): FeeCoinObservation {
  return { ...values, network: graph.roster.network, genesisHash: graph.roster.genesisHash,
    confirmationBlockHash: sha256Hex('synthetic-active-block'), confirmations: 2, unspentInActiveChain: true, coinbase: false };
}

function requestFor(state: ReturnType<typeof fixture>, exitId: string, kind: WalletKind, fee = 3_000, sponsorValue = 20_000): PresignedFeeRequest {
  const exit = state.graph.exits.find(item => item.id === exitId)!;
  const parent = completePresignedExit({ graph: state.graph, preauthorizations: state.preauthorizations,
    exitId: exit.id, participantId: exit.leaver, privateKey: state.keys[exit.leaver].soloPrivateKeys[exit.roundId]!, approvedGraphDigest: state.graph.digest });
  const key = deterministicKeypair('public-offline-fee-sponsor', kind);
  const sponsorScript = kind === 'p2wpkh'
    ? Buffer.from(bitcoin.payments.p2wpkh({ pubkey: Buffer.from(key.publicKeyHex, 'hex') }).output!).toString('hex')
    : Buffer.from(bitcoin.payments.p2tr({ internalPubkey: Buffer.from(key.xonlyPubKeyHex, 'hex') }).output!).toString('hex');
  return { graph: state.graph, exitId: exit.id, parentTransactionHex: parent.transactionHex,
    roundInputObservation: coin(state.graph, { txid: exit.inputTxid, vout: exit.inputVout, valueSats: exit.inputValueSats, scriptPubKeyHex: exit.inputScriptPubKeyHex }),
    sponsorInput: coin(state.graph, { txid: sha256Hex(`synthetic-confirmed-fee-sponsor:${kind}`), vout: 1, valueSats: sponsorValue, scriptPubKeyHex: sponsorScript }),
    approval: { childFeeSats: fee, maxChildFeeSats: 10_000, targetPackageRateMillisatsPerVbyte: 5_000,
      minRelayRateMillisatsPerVbyte: 1_000, sponsorChangeScriptPubKeyHex: sponsorValue === fee ? null : sponsorScript,
      approveExactNoChangeFee: sponsorValue === fee, replacement: null } };
}

function sponsorPsbt(request: PresignedFeeRequest, kind: WalletKind, mutateSignature?: (signature: Buffer) => Buffer): string {
  const built = buildPresignedFeeChild(request);
  const psbt = bitcoin.Psbt.fromBase64(built.psbtBase64);
  const tx = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
  const key = deterministicKeypair('public-offline-fee-sponsor', kind);
  if (kind === 'p2wpkh') {
    const scriptCode = bitcoin.payments.p2pkh({ pubkey: Buffer.from(key.publicKeyHex, 'hex') }).output!;
    const hash = tx.hashForWitnessV0(1, scriptCode, BigInt(request.sponsorInput.valueSats), bitcoin.Transaction.SIGHASH_ALL);
    const signature = Buffer.from(bitcoin.script.signature.encode(ecc.sign(hash, Buffer.from(key.privateKeyHex, 'hex')), bitcoin.Transaction.SIGHASH_ALL));
    psbt.updateInput(1, { partialSig: [{ pubkey: Buffer.from(key.publicKeyHex, 'hex'), signature: mutateSignature ? mutateSignature(signature) : signature }] });
  } else {
    const hashType = kind === 'p2tr-all' ? bitcoin.Transaction.SIGHASH_ALL : bitcoin.Transaction.SIGHASH_DEFAULT;
    const hash = tx.hashForWitnessV1(1, psbt.data.inputs.map(input => input.witnessUtxo!.script), psbt.data.inputs.map(input => input.witnessUtxo!.value), hashType);
    const secret = Buffer.from(key.privateKeyHex, 'hex');
    const even = key.publicKeyHex.startsWith('03') ? ecc.privateNegate(secret) : secret;
    const tweaked = ecc.privateAdd(even, bitcoin.crypto.taggedHash('TapTweak', Buffer.from(key.xonlyPubKeyHex, 'hex')))!;
    const raw = Buffer.from(ecc.signSchnorr(hash, tweaked));
    const signature = hashType === bitcoin.Transaction.SIGHASH_ALL ? Buffer.concat([raw, Buffer.from([hashType])]) : raw;
    psbt.updateInput(1, { tapKeySig: mutateSignature ? mutateSignature(signature) : signature });
  }
  return psbt.toBase64();
}

function finalized(request: PresignedFeeRequest, state: ReturnType<typeof fixture>, kind: WalletKind) {
  const built = buildPresignedFeeChild(request);
  const exit = state.graph.exits.find(item => item.id === request.exitId)!;
  const local = signPresignedFeePayout({ request, approvalDigest: built.approvalDigest, psbtBase64: built.psbtBase64, keys: state.keys[exit.leaver] });
  return finalizePresignedFeeChild({ request, approvalDigest: built.approvalDigest,
    payoutSignatureHex: local.payoutSignatureHex, sponsorSignedPsbtBase64: sponsorPsbt(request, kind) });
}

for (const network of ['signet', 'mainnet'] as const) {
  const state = fixture(network);
  const originalGraph = JSON.stringify(state.graph);
  for (const exit of state.graph.exits) {
    for (const kind of ['p2tr-default', 'p2tr-all', 'p2wpkh'] as const) {
      const request = requestFor(state, exit.id, kind);
      const result = finalized(request, state, kind);
      const tx = bitcoin.Transaction.fromHex(result.transactionHex);
      const parent = bitcoin.Transaction.fromHex(request.parentTransactionHex);
      assert.equal(parent.version, 3);
      assert.equal(tx.version, 3);
      assert.equal(result.kind, 'confirmed-truc-payout-cpfp-v1');
      assert(tx.virtualSize() <= 1000);
      assert.equal(tx.ins.length, 2);
      assert.equal(tx.outs.length, 2);
      assert.equal(tx.outs[0]!.value, parent.outs[0]!.value);
      assert.deepEqual(tx.outs[0]!.script, parent.outs[0]!.script);
      assert.equal(Number(tx.outs[1]!.value), request.sponsorInput.valueSats - result.childFeeSats);
      assert.equal(tx.getId(), result.unsignedTxid);
      assert(tx.ins.every(input => input.sequence === 0xfffffffd));
      const prevouts = [{ scriptPubKeyHex: Buffer.from(parent.outs[0]!.script).toString('hex'), valueSats: Number(parent.outs[0]!.value) }, request.sponsorInput];
      verifyNativeWalletWitness(tx, 0, prevouts, tx.ins[0]!.witness);
      verifyNativeWalletWitness(tx, 1, prevouts, tx.ins[1]!.witness);
      assert.equal(JSON.stringify(state.graph), originalGraph, 'fee bump mutated the immutable graph');
    }
  }
  checks.push(`${network}: all nine TRUC exits accept bounded version-3 P2TR DEFAULT, P2TR ALL and P2WPKH sponsorship while preserving parent graph and exact payout`);
  console.log(`Completed ${network} nine-exit / three-wallet positive fee matrix`);

  const kind = 'p2tr-default';
  const request = requestFor(state, 'alice', kind);
  const built = buildPresignedFeeChild(request);
  for (const changed of [
    { ...request.sponsorInput, confirmations: 0 },
    { ...request.sponsorInput, confirmationBlockHash: '00'.repeat(32) },
    { ...request.sponsorInput, unspentInActiveChain: false },
    { ...request.sponsorInput, coinbase: true },
    { ...request.sponsorInput, network: network === 'signet' ? 'mainnet' : 'signet' },
    { ...request.sponsorInput, scriptPubKeyHex: state.graph.rounds[0]!.outputScriptHex },
    { ...request.sponsorInput, txid: state.graph.exits[0]!.txid },
  ]) assert.throws(() => buildPresignedFeeChild({ ...request, sponsorInput: changed as FeeCoinObservation }));
  assert.throws(() => buildPresignedFeeChild({ ...request, roundInputObservation: { ...request.roundInputObservation, confirmations: 0 } }));
  assert.throws(() => buildPresignedFeeChild({ ...request, roundInputObservation: { ...request.roundInputObservation, vout: 1 } }));
  assert.throws(() => buildPresignedFeeChild({ ...request, approval: { ...request.approval, childFeeSats: 10_001 } }));
  assert.throws(() => buildPresignedFeeChild({ ...request, approval: { ...request.approval, targetPackageRateMillisatsPerVbyte: 1.5 } }));
  assert.throws(() => buildPresignedFeeChild(requestFor(state, 'alice', kind, 3_000, 3_329)), /dust/);
  const invalidParent = bitcoin.Transaction.fromHex(request.parentTransactionHex);
  invalidParent.outs[1]!.value -= 1n;
  assert.throws(() => buildPresignedFeeChild({ ...request, parentTransactionHex: invalidParent.toHex() }), /immutable/);
  const legacyParent = bitcoin.Transaction.fromHex(request.parentTransactionHex);
  legacyParent.version = 2;
  assert.throws(() => buildPresignedFeeChild({ ...request, parentTransactionHex: legacyParent.toHex() }), /immutable/);
  checks.push(`${network}: unconfirmed/wrong-network/coinbase/vault sponsors, invalid round anchor, parent mutation, fee-cap overflow and dust fail closed`);

  const local = signPresignedFeePayout({ request, approvalDigest: built.approvalDigest, psbtBase64: built.psbtBase64, keys: state.keys.alice });
  assert.throws(() => signPresignedFeePayout({ request, approvalDigest: built.approvalDigest, psbtBase64: built.psbtBase64, keys: state.keys.bob }), /leaver/);
  assert.throws(() => authorizePresignedFeeChild({ request, approvalDigest: '00'.repeat(32), psbtBase64: built.psbtBase64 }), /digest/);
  const corrupt = bitcoin.Psbt.fromBase64(built.psbtBase64);
  corrupt.data.inputs[1]!.witnessUtxo!.value = BigInt(request.sponsorInput.valueSats + 1);
  assert.throws(() => authorizePresignedFeeChild({ request, approvalDigest: built.approvalDigest, psbtBase64: corrupt.toBase64() }), /prevout/);
  const legacyChild = bitcoin.Psbt.fromBase64(built.psbtBase64);
  legacyChild.setVersion(2);
  assert.throws(() => authorizePresignedFeeChild({ request, approvalDigest: built.approvalDigest, psbtBase64: legacyChild.toBase64() }), /transaction differs/);
  const signature = Buffer.from(local.payoutSignatureHex, 'hex');
  signature[0] = signature[0]! ^ 1;
  assert.throws(() => finalizePresignedFeeChild({ request, approvalDigest: built.approvalDigest, payoutSignatureHex: signature.toString('hex'), sponsorSignedPsbtBase64: sponsorPsbt(request, kind) }), /signature/);
  assert.throws(() => finalizePresignedFeeChild({ request, approvalDigest: built.approvalDigest, payoutSignatureHex: `${local.payoutSignatureHex}01`, sponsorSignedPsbtBase64: sponsorPsbt(request, kind) }), /SIGHASH_DEFAULT/);
  assert.throws(() => finalizePresignedFeeChild({ request, approvalDigest: built.approvalDigest, payoutSignatureHex: local.payoutSignatureHex,
    sponsorSignedPsbtBase64: sponsorPsbt(request, kind, value => { value[0] = value[0]! ^ 1; return value; }) }), /signature/);
  const both = bitcoin.Psbt.fromBase64(sponsorPsbt(request, kind));
  both.updateInput(0, { tapKeySig: Buffer.from(local.payoutSignatureHex, 'hex') });
  assert.throws(() => finalizePresignedFeeChild({ request, approvalDigest: built.approvalDigest, payoutSignatureHex: local.payoutSignatureHex, sponsorSignedPsbtBase64: both.toBase64() }), /another signer/);
  checks.push(`${network}: wrong payout owner, altered approval/prevout, corrupt signatures, non-default payout sighash and cross-input wallet signatures rejected`);

  const finalizedSponsor = bitcoin.Psbt.fromBase64(sponsorPsbt(request, kind));
  const sponsorSignature = Buffer.from(finalizedSponsor.data.inputs[1]!.tapKeySig!);
  delete finalizedSponsor.data.inputs[1]!.tapKeySig;
  finalizedSponsor.updateInput(1, { finalScriptWitness: Buffer.concat([Buffer.from([1, sponsorSignature.length]), sponsorSignature]) });
  finalizePresignedFeeChild({ request, approvalDigest: built.approvalDigest, payoutSignatureHex: local.payoutSignatureHex, sponsorSignedPsbtBase64: finalizedSponsor.toBase64() });
  // The real offline export includes the fully verified parent at input 0.
  // Core's wallet may preserve it even though it signs only sponsor input 1.
  const preservedParent = bitcoin.Psbt.fromBase64(sponsorPsbt(request, kind));
  preservedParent.updateInput(0, { nonWitnessUtxo: bitcoin.Transaction.fromHex(request.parentTransactionHex).toBuffer() });
  finalizePresignedFeeChild({ request, approvalDigest: built.approvalDigest, payoutSignatureHex: local.payoutSignatureHex,
    sponsorSignedPsbtBase64: preservedParent.toBase64() });
  const changedParent = bitcoin.Transaction.fromHex(request.parentTransactionHex); changedParent.outs[0]!.value -= 1n;
  preservedParent.data.inputs[0]!.nonWitnessUtxo = changedParent.toBuffer();
  assert.throws(() => finalizePresignedFeeChild({ request, approvalDigest: built.approvalDigest, payoutSignatureHex: local.payoutSignatureHex,
    sponsorSignedPsbtBase64: preservedParent.toBase64() }), /previous transaction/);
  const annotated = bitcoin.Psbt.fromBase64(sponsorPsbt(request, kind));
  const sponsorKey = deterministicKeypair('public-offline-fee-sponsor', kind);
  const tapOrigin = { pubkey: Buffer.from(sponsorKey.xonlyPubKeyHex, 'hex'), leafHashes: [],
    masterFingerprint: Buffer.from('12345678', 'hex'), path: "m/86'/1'/0'/0/1" };
  annotated.updateInput(1, { tapInternalKey: tapOrigin.pubkey, tapBip32Derivation: [tapOrigin] });
  annotated.updateInput(0, { sighashType: bitcoin.Transaction.SIGHASH_ALL });
  annotated.updateInput(1, { sighashType: bitcoin.Transaction.SIGHASH_ALL });
  annotated.updateOutput(1, { tapInternalKey: tapOrigin.pubkey, tapBip32Derivation: [tapOrigin] });
  finalizePresignedFeeChild({ request, approvalDigest: built.approvalDigest, payoutSignatureHex: local.payoutSignatureHex, sponsorSignedPsbtBase64: annotated.toBase64() });
  for (const index of [0, 1]) {
    const unsafeHint = bitcoin.Psbt.fromBase64(annotated.toBase64());
    unsafeHint.data.inputs[index]!.sighashType = bitcoin.Transaction.SIGHASH_SINGLE | bitcoin.Transaction.SIGHASH_ANYONECANPAY;
    assert.throws(() => finalizePresignedFeeChild({ request, approvalDigest: built.approvalDigest,
      payoutSignatureHex: local.payoutSignatureHex, sponsorSignedPsbtBase64: unsafeHint.toBase64() }), /sighash hint/);
  }
  const p2wRequest = requestFor(state, 'alice', 'p2wpkh');
  const p2wBuilt = buildPresignedFeeChild(p2wRequest);
  const p2wLocal = signPresignedFeePayout({ request: p2wRequest, approvalDigest: p2wBuilt.approvalDigest, psbtBase64: p2wBuilt.psbtBase64, keys: state.keys.alice });
  const p2wAnnotated = bitcoin.Psbt.fromBase64(sponsorPsbt(p2wRequest, 'p2wpkh'));
  const p2wOrigin = { pubkey: Buffer.from(deterministicKeypair('public-offline-fee-sponsor', 'p2wpkh').publicKeyHex, 'hex'),
    masterFingerprint: Buffer.from('12345678', 'hex'), path: "m/84'/1'/0'/0/1" };
  p2wAnnotated.updateInput(1, { bip32Derivation: [p2wOrigin] });
  p2wAnnotated.updateInput(0, { sighashType: bitcoin.Transaction.SIGHASH_ALL });
  p2wAnnotated.updateInput(1, { sighashType: bitcoin.Transaction.SIGHASH_ALL });
  p2wAnnotated.updateOutput(1, { bip32Derivation: [p2wOrigin] });
  finalizePresignedFeeChild({ request: p2wRequest, approvalDigest: p2wBuilt.approvalDigest, payoutSignatureHex: p2wLocal.payoutSignatureHex, sponsorSignedPsbtBase64: p2wAnnotated.toBase64() });
  p2wAnnotated.data.inputs[1]!.sighashType = bitcoin.Transaction.SIGHASH_DEFAULT;
  assert.throws(() => finalizePresignedFeeChild({ request: p2wRequest, approvalDigest: p2wBuilt.approvalDigest,
    payoutSignatureHex: p2wLocal.payoutSignatureHex, sponsorSignedPsbtBase64: p2wAnnotated.toBase64() }), /sighash hint/);
  const fullPrevious = new bitcoin.Transaction();
  fullPrevious.version = 2;
  fullPrevious.addInput(Buffer.from(sha256Hex('synthetic-external-wallet-funding'), 'hex'), 0, 0xffffffff);
  fullPrevious.addOutput(Buffer.from(p2wRequest.sponsorInput.scriptPubKeyHex, 'hex'), BigInt(p2wRequest.sponsorInput.valueSats));
  const fullPreviousRequest = { ...p2wRequest, sponsorInput: { ...p2wRequest.sponsorInput, txid: fullPrevious.getId(), vout: 0 } };
  const withPrevious = (current: PresignedFeeRequest, previous: bitcoin.Transaction) => {
    const fullBuilt = buildPresignedFeeChild(current);
    const fullLocal = signPresignedFeePayout({ request: current, approvalDigest: fullBuilt.approvalDigest,
      psbtBase64: fullBuilt.psbtBase64, keys: state.keys.alice });
    const fullSigned = bitcoin.Psbt.fromBase64(sponsorPsbt(current, 'p2wpkh'));
    fullSigned.updateInput(1, { nonWitnessUtxo: previous.toBuffer() });
    return finalizePresignedFeeChild({ request: current, approvalDigest: fullBuilt.approvalDigest,
      payoutSignatureHex: fullLocal.payoutSignatureHex, sponsorSignedPsbtBase64: fullSigned.toBase64() });
  };
  withPrevious(fullPreviousRequest, fullPrevious);
  const wrongPrevious = fullPrevious.clone();
  wrongPrevious.outs[0]!.value -= 1n;
  assert.throws(() => withPrevious(fullPreviousRequest, wrongPrevious), /previous transaction txid/);
  assert.throws(() => withPrevious({ ...fullPreviousRequest, sponsorInput: { ...fullPreviousRequest.sponsorInput,
    valueSats: fullPreviousRequest.sponsorInput.valueSats + 1 } }, fullPrevious), /previous transaction output/);
  checks.push(`${network}: native wallet Taproot/BIP32 and all-committing sighash metadata is normalized; unsafe sighash hints and non-ALL P2WPKH are rejected`);
  checks.push(`${network}: wallet full previous transactions are checked against the exact approved txid, output index, value and script before their metadata is discarded`);
  const noChange = requestFor(state, 'alice', kind, 5_000, 5_000);
  assert.equal(bitcoin.Transaction.fromHex(finalized(noChange, state, kind).transactionHex).outs.length, 1);
  assert.throws(() => buildPresignedFeeChild({ ...noChange, approval: { ...noChange.approval, approveExactNoChangeFee: false } }), /explicit approval/);
  assert.throws(() => finalized(requestFor(state, 'alice', kind, 1), state, kind), /relay floor/);
  const insufficient = requestFor(state, 'alice', kind, 300);
  assert.throws(() => finalized(insufficient, state, kind), /package feerate/);
  // A TRUC parent may be below the approved relay floor if the complete
  // package pays it. The child meeting that floor alone is not sufficient.
  finalized({ ...request, approval: { ...request.approval, minRelayRateMillisatsPerVbyte: 2_000 } }, state, kind);
  assert.throws(() => finalized({ ...request, approval: { ...request.approval,
    minRelayRateMillisatsPerVbyte: 10_000, targetPackageRateMillisatsPerVbyte: 1_000 } }, state, kind), /package is below/);
  const original = finalized(request, state, kind);
  const replacement = { ...request, approval: { ...request.approval, childFeeSats: 4_000,
    replacement: { previousChildTransactionHex: original.transactionHex, incrementalRelayRateMillisatsPerVbyte: 1_000 } } };
  const replaced = finalized(replacement, state, kind);
  assert.notEqual(replaced.txid, original.txid);
  assert.equal(replaced.parentTxid, original.parentTxid);
  const legacyPrevious = bitcoin.Transaction.fromHex(original.transactionHex);
  legacyPrevious.version = 2;
  assert.throws(() => buildPresignedFeeChild({ ...replacement, approval: { ...replacement.approval,
    replacement: { ...replacement.approval.replacement, previousChildTransactionHex: legacyPrevious.toHex() } } }), /TRUC/);
  assert.throws(() => finalized({ ...replacement, approval: { ...replacement.approval, childFeeSats: 3_001 } }, state, kind), /incremental relay/);
  const wrongSponsor = { ...replacement, sponsorInput: { ...replacement.sponsorInput, txid: sha256Hex('a different sponsor coin') } };
  assert.throws(() => buildPresignedFeeChild(wrongSponsor), /retain exact/);
  checks.push(`${network}: final witness import and approved no-change fees work; actual signed-vsize rate floors and same-input child-only replacement are enforced`);
  checks.push(`${network}: version-2 parents, children and replacement history are rejected; TRUC sponsorship can pay a below-floor parent only when the whole package meets the floor`);
}

console.log(JSON.stringify({ passed: true, offlineOnly: true, actualBitcoinCoreAcceptance: false, checks }, null, 2));
