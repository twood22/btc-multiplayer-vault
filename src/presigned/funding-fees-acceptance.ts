/** PUBLIC DETERMINISTIC OFFLINE KEYS. No public coins or network calls. */
import assert from 'node:assert/strict';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { deterministicKeypair, sha256Hex } from '../crypto.js';
import { createPresignedFixture, signPresignedFixtureFunding } from './fixtures.js';
import { PARTICIPANT_IDS, type ParticipantId, type PresignedGraph } from './types.js';
import { type FeeCoinObservation } from './fees.js';
import { verifyNativeWalletWitness } from './wallet.js';
import { buildPresignedFundingFeeChild, authorizePresignedFundingFeeChild, authorizePresignedFundingFeeSignedPsbt,
  authorizePresignedFundingFeeWalletPsbt, verifyPresignedFundingFeeSignature, finalizePresignedFundingFeeChild,
  type PresignedFundingFeeRequest, type PresignedFundingFeeRole } from './funding-fees.js';

type WalletKind = 'p2wpkh' | 'p2tr-default' | 'p2tr-all';
type Wallet = { publicKey: Buffer; privateKey: Buffer; scriptPubKeyHex: string };
const kinds: WalletKind[] = ['p2wpkh', 'p2tr-default', 'p2tr-all'];
const checks: string[] = [];
let signedChildren = 0;

function observation(graph: PresignedGraph, coin: { txid: string; vout: number; valueSats: number; scriptPubKeyHex: string }): FeeCoinObservation {
  return { network: graph.roster.network, genesisHash: graph.roster.genesisHash, txid: coin.txid, vout: coin.vout,
    valueSats: coin.valueSats, scriptPubKeyHex: coin.scriptPubKeyHex, confirmationBlockHash: sha256Hex('offline-only-confirmed-block'),
    confirmations: 2, unspentInActiveChain: true, coinbase: false };
}

function prepare(network: 'signet' | 'mainnet', participant: ParticipantId, changeKind: WalletKind, sponsorKind: WalletKind) {
  const fixture = createPresignedFixture({ network, walletKinds: PARTICIPANT_IDS.map(id => id === participant && changeKind === 'p2wpkh' ? 'p2wpkh' : 'p2tr') });
  const pair = deterministicKeypair('public-offline-funding-fee-sponsor', sponsorKind);
  const publicKey = Buffer.from(pair.publicKeyHex, 'hex');
  const sponsor: Wallet = { publicKey, privateKey: Buffer.from(pair.privateKeyHex, 'hex'), scriptPubKeyHex: Buffer.from(sponsorKind === 'p2wpkh'
    ? bitcoin.payments.p2wpkh({ pubkey: publicKey }).output! : bitcoin.payments.p2tr({ internalPubkey: publicKey.subarray(1) }).output!).toString('hex') };
  const previous = new bitcoin.Transaction();
  previous.version = 2;
  previous.addInput(Buffer.from(sha256Hex('offline-only-sponsor-source'), 'hex'), 0);
  previous.addOutput(Buffer.from(sponsor.scriptPubKeyHex, 'hex'), 20_000n);
  const graph = fixture.graph;
  const funding = signPresignedFixtureFunding(fixture);
  const request: PresignedFundingFeeRequest = { graph, fundingTransactionHex: funding.transactionHex, changeParticipantId: participant,
    fundingInputObservations: graph.funding.inputs.map(coin => observation(graph, coin)),
    sponsorInput: observation(graph, { txid: previous.getId(), vout: 0, valueSats: 20_000, scriptPubKeyHex: sponsor.scriptPubKeyHex }),
    approval: { childFeeSats: 3_000, maxChildFeeSats: 10_000, targetPackageRateMillisatsPerVbyte: 5_000,
      minRelayRateMillisatsPerVbyte: 1_000, sponsorChangeScriptPubKeyHex: sponsor.scriptPubKeyHex,
      approveExactNoChangeFee: false, replacement: null } };
  return { fixture, request, sponsor, previous, changeKind, sponsorKind };
}

function signPsbt(base64: string, index: number, wallet: Wallet, kind: WalletKind, hashType?: number): string {
  const psbt = bitcoin.Psbt.fromBase64(base64);
  const tx = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
  const type = hashType ?? (kind === 'p2tr-default' ? bitcoin.Transaction.SIGHASH_DEFAULT : bitcoin.Transaction.SIGHASH_ALL);
  if (kind === 'p2wpkh') {
    const code = bitcoin.payments.p2pkh({ pubkey: wallet.publicKey }).output!;
    const hash = tx.hashForWitnessV0(index, code, psbt.data.inputs[index]!.witnessUtxo!.value, type);
    psbt.updateInput(index, { partialSig: [{ pubkey: wallet.publicKey,
      signature: bitcoin.script.signature.encode(ecc.sign(hash, wallet.privateKey), type) }] });
  } else {
    const hash = tx.hashForWitnessV1(index, psbt.data.inputs.map(item => item.witnessUtxo!.script), psbt.data.inputs.map(item => item.witnessUtxo!.value), type);
    const adjusted = wallet.publicKey[0] === 3 ? ecc.privateNegate(wallet.privateKey) : wallet.privateKey;
    const tweaked = ecc.privateAdd(adjusted, bitcoin.crypto.taggedHash('TapTweak', wallet.publicKey.subarray(1)))!;
    const signature = Buffer.from(ecc.signSchnorr(hash, tweaked));
    psbt.updateInput(index, { tapKeySig: type === 0 ? signature : Buffer.concat([signature, Buffer.from([type])]) });
  }
  return psbt.toBase64();
}

function contribution(state: ReturnType<typeof prepare>, request: PresignedFundingFeeRequest, role: PresignedFundingFeeRole) {
  const built = buildPresignedFundingFeeChild(request);
  const wallet = role === 'change' ? state.fixture.walletKeys[request.changeParticipantId] : state.sponsor;
  const signedPsbtBase64 = signPsbt(built.psbtBase64, role === 'change' ? 0 : 1, wallet, role === 'change' ? state.changeKind : state.sponsorKind);
  return authorizePresignedFundingFeeSignedPsbt({ request, role, signedPsbtBase64, approvalDigest: built.approvalDigest });
}

function finalize(state: ReturnType<typeof prepare>, request = state.request) {
  const built = buildPresignedFundingFeeChild(request);
  return finalizePresignedFundingFeeChild({ request, approvalDigest: built.approvalDigest,
    signatures: [contribution(state, request, 'change'), contribution(state, request, 'sponsor')] });
}

for (const network of ['signet', 'mainnet'] as const) {
  for (const participant of PARTICIPANT_IDS) for (const changeKind of kinds) for (const sponsorKind of kinds) {
    const state = prepare(network, participant, changeKind, sponsorKind);
    const { request } = state;
    const originalGraph = JSON.stringify(request.graph);
    const completed = finalize(state);
    const tx = bitcoin.Transaction.fromHex(completed.transactionHex);
    const funding = bitcoin.Transaction.fromHex(request.fundingTransactionHex);
    assert.equal(funding.version, 3);
    assert.equal(tx.version, 3);
    assert.equal(tx.ins.length, 2);
    assert.equal(tx.ins[0]!.index, PARTICIPANT_IDS.indexOf(participant) + 1);
    assert.equal(tx.ins[1]!.index, request.sponsorInput.vout);
    assert(tx.ins.every(input => input.sequence === 0xfffffffd));
    assert.deepEqual(tx.outs[0], funding.outs[completed.changeVout]);
    assert.equal(Number(tx.outs[1]!.value), request.sponsorInput.valueSats - completed.childFeeSats);
    assert.equal(Number(tx.outs[0]!.value), 1_800);
    const prevouts = [{ scriptPubKeyHex: completed.changeScriptPubKeyHex, valueSats: completed.changeSats }, request.sponsorInput];
    for (const index of [0, 1]) verifyNativeWalletWitness(tx, index, prevouts, tx.ins[index]!.witness);
    assert(tx.virtualSize() <= completed.maximumChildVsize && tx.virtualSize() <= 1_000);
    assert.equal(JSON.stringify(request.graph), originalGraph);
    assert.equal(completed.parentTxid, request.graph.fundingTxid);
    signedChildren++;
  }
  checks.push(`${network}: all three refund owners and all nine P2WPKH/P2TR DEFAULT/P2TR ALL signer pairs preserve the refund, funding txid and nine exits`);
  console.log(`Completed ${network} 27-child funding-fee native-wallet matrix`);

  const state = prepare(network, 'alice', 'p2tr-default', 'p2tr-all');
  const { request } = state;
  const built = buildPresignedFundingFeeChild(request);
  const approve = (psbtBase64: string) => authorizePresignedFundingFeeChild({ request, psbtBase64, approvalDigest: built.approvalDigest });
  const importing = (signedPsbtBase64: string, role: PresignedFundingFeeRole = 'change') => authorizePresignedFundingFeeSignedPsbt({ request, role, signedPsbtBase64, approvalDigest: built.approvalDigest });
  for (let index = 0; index < 3; index++) for (const patch of [{ confirmations: 0 }, { confirmationBlockHash: '00'.repeat(32) }, { vout: 999 }, { valueSats: 12_001 }, { coinbase: true }, { unspentInActiveChain: false }]) {
    const observations = structuredClone(request.fundingInputObservations);
    Object.assign(observations[index]!, patch);
    assert.throws(() => buildPresignedFundingFeeChild({ ...request, fundingInputObservations: observations }));
  }
  assert.throws(() => buildPresignedFundingFeeChild({ ...request, fundingInputObservations: [...request.fundingInputObservations].reverse() }), /differs/);
  assert.throws(() => buildPresignedFundingFeeChild({ ...request, fundingInputObservations: request.fundingInputObservations.slice(0, 2) }), /three/);
  for (const patch of [{ confirmations: 0 }, { coinbase: true }, { unspentInActiveChain: false }, { txid: request.graph.fundingTxid },
    { txid: request.graph.exits[0]!.txid }, { scriptPubKeyHex: request.graph.rounds[0]!.outputScriptHex },
    { network: network === 'signet' ? 'mainnet' : 'signet' }, { genesisHash: '00'.repeat(32) }]) {
    assert.throws(() => buildPresignedFundingFeeChild({ ...request, sponsorInput: { ...request.sponsorInput, ...patch } as FeeCoinObservation }));
  }
  assert.throws(() => buildPresignedFundingFeeChild({ ...request, sponsorInput: request.fundingInputObservations[0]! }), /repeat a funding input/);
  for (const patch of [{ childFeeSats: 10_001 }, { maxChildFeeSats: 100_001 }, { childFeeSats: 1.5 },
    { targetPackageRateMillisatsPerVbyte: 0 }, { sponsorChangeScriptPubKeyHex: null }, { approveExactNoChangeFee: true },
    { sponsorChangeScriptPubKeyHex: request.graph.rounds[0]!.outputScriptHex }]) {
    assert.throws(() => buildPresignedFundingFeeChild({ ...request, approval: { ...request.approval, ...patch } }));
  }
  for (const mutate of [(tx: bitcoin.Transaction) => { tx.version = 2; }, (tx: bitcoin.Transaction) => { tx.outs[0]!.value -= 1n; },
    (tx: bitcoin.Transaction) => { tx.outs[1]!.value += 1n; }, (tx: bitcoin.Transaction) => { tx.ins[1]!.witness = []; }]) {
    const changed = bitcoin.Transaction.fromHex(request.fundingTransactionHex);
    mutate(changed);
    assert.throws(() => buildPresignedFundingFeeChild({ ...request, fundingTransactionHex: changed.toHex() }));
  }
  checks.push(`${network}: all three source observations, external sponsor, ownership, parent signatures, changed economics and fee caps fail closed`);

  for (const mutate of [(psbt: bitcoin.Psbt) => { psbt.setVersion(2); }, (psbt: bitcoin.Psbt) => { psbt.data.inputs[0]!.witnessUtxo!.value += 1n; },
    (psbt: bitcoin.Psbt) => { psbt.data.inputs[1]!.witnessUtxo!.script = Buffer.from(request.graph.rounds[0]!.outputScriptHex, 'hex'); }]) {
    const changed = bitcoin.Psbt.fromBase64(built.psbtBase64);
    mutate(changed);
    assert.throws(() => approve(changed.toBase64()));
  }
  const vaultInput = bitcoin.Psbt.fromBase64(built.psbtBase64);
  vaultInput.data.globalMap.unsignedTx = bitcoin.Psbt.fromBase64(built.psbtBase64).data.globalMap.unsignedTx;
  const alteredTx = bitcoin.Transaction.fromBuffer(vaultInput.data.globalMap.unsignedTx.toBuffer());
  alteredTx.ins[0]!.index = 0;
  const fromScratch = new bitcoin.Psbt();
  fromScratch.setVersion(3);
  fromScratch.addInput({ hash: request.graph.fundingTxid, index: 0, sequence: 0xfffffffd, witnessUtxo: vaultInput.data.inputs[0]!.witnessUtxo! });
  fromScratch.addInput({ hash: request.sponsorInput.txid, index: request.sponsorInput.vout, sequence: 0xfffffffd, witnessUtxo: vaultInput.data.inputs[1]!.witnessUtxo! });
  alteredTx.outs.forEach(output => fromScratch.addOutput(output));
  assert.throws(() => approve(fromScratch.toBase64()), /transaction/);
  assert.throws(() => authorizePresignedFundingFeeChild({ request, psbtBase64: built.psbtBase64, approvalDigest: '00'.repeat(32) }), /digest/);
  assert.throws(() => importing(built.psbtBase64), /signature/);
  const changeSigned = signPsbt(built.psbtBase64, 0, state.fixture.walletKeys.alice, state.changeKind);
  const bothSigned = signPsbt(changeSigned, 1, state.sponsor, state.sponsorKind);
  assert.throws(() => importing(bothSigned), /another role/);
  assert.throws(() => importing(bothSigned, 'sponsor'), /another role/);
  const explicitlyBoth = authorizePresignedFundingFeeWalletPsbt({ request, roles: ['change', 'sponsor'], signedPsbtBase64: bothSigned, approvalDigest: built.approvalDigest });
  finalizePresignedFundingFeeChild({ request, approvalDigest: built.approvalDigest, signatures: explicitlyBoth });
  assert.throws(() => authorizePresignedFundingFeeWalletPsbt({ request, roles: ['change', 'change'], signedPsbtBase64: bothSigned, approvalDigest: built.approvalDigest }), /distinct roles/);
  assert.throws(() => approve(changeSigned), /another role/);
  for (const role of ['change', 'sponsor'] as const) {
    const index = role === 'change' ? 0 : 1;
    const wallet = role === 'change' ? state.fixture.walletKeys.alice : state.sponsor;
    const kind = role === 'change' ? state.changeKind : state.sponsorKind;
    assert.throws(() => importing(signPsbt(built.psbtBase64, index, wallet, kind, bitcoin.Transaction.SIGHASH_SINGLE | bitcoin.Transaction.SIGHASH_ANYONECANPAY), role), /DEFAULT or ALL/);
    const corrupt = bitcoin.Psbt.fromBase64(signPsbt(built.psbtBase64, index, wallet, kind));
    corrupt.data.inputs[index]!.tapKeySig![0] ^= 1;
    assert.throws(() => importing(corrupt.toBase64(), role), /signature/);
  }
  const signatures = [contribution(state, request, 'change'), contribution(state, request, 'sponsor')];
  assert.throws(() => finalizePresignedFundingFeeChild({ request, approvalDigest: built.approvalDigest, signatures: signatures.slice(0, 1) }), /both/);
  assert.throws(() => finalizePresignedFundingFeeChild({ request, approvalDigest: built.approvalDigest, signatures: [signatures[0]!, signatures[0]!] }), /repeats/);
  assert.throws(() => verifyPresignedFundingFeeSignature({ request, approvalDigest: built.approvalDigest, signature: { ...signatures[0]!, changeParticipantId: 'bob' } }), /approval/);
  assert.throws(() => verifyPresignedFundingFeeSignature({ request, approvalDigest: built.approvalDigest, signature: { ...signatures[0]!, inputIndex: 1 } }), /wrong input/);
  assert.throws(() => verifyPresignedFundingFeeSignature({ request, approvalDigest: built.approvalDigest, signature: { ...signatures[0]!, witness: [...signatures[0]!.witness, '50'] } }), /without annex/);
  checks.push(`${network}: vault substitution, witness-prevout forgery, missing/corrupt/weak/cross-role signatures, annexes and contribution replay are rejected`);

  for (const role of ['change', 'sponsor'] as const) {
    const index = role === 'change' ? 0 : 1;
    const wallet = role === 'change' ? state.fixture.walletKeys.alice : state.sponsor;
    const signed = bitcoin.Psbt.fromBase64(signPsbt(built.psbtBase64, index, wallet, role === 'change' ? state.changeKind : state.sponsorKind));
    const origin = { pubkey: wallet.publicKey.subarray(1), leafHashes: [], masterFingerprint: Buffer.from('12345678', 'hex'), path: "m/86'/1'/0'/0/0" };
    signed.updateInput(index, { tapInternalKey: origin.pubkey, tapBip32Derivation: [origin] });
    signed.updateOutput(index, { tapInternalKey: origin.pubkey, tapBip32Derivation: [origin] });
    signed.data.inputs.forEach(input => { input.sighashType = bitcoin.Transaction.SIGHASH_ALL; });
    importing(signed.toBase64(), role);
    for (const inputIndex of [0, 1]) {
      const weakHint = bitcoin.Psbt.fromBase64(signed.toBase64());
      weakHint.data.inputs[inputIndex]!.sighashType = bitcoin.Transaction.SIGHASH_NONE;
      assert.throws(() => importing(weakHint.toBase64(), role), /hash type/);
    }
    const rawSignature = Buffer.from(signed.data.inputs[index]!.tapKeySig!);
    delete signed.data.inputs[index]!.tapKeySig;
    signed.updateInput(index, { finalScriptWitness: Buffer.concat([Buffer.from([1, rawSignature.length]), rawSignature]) });
    importing(signed.toBase64(), role);
  }
  const p2w = prepare(network, 'bob', 'p2wpkh', 'p2wpkh');
  const p2wBuilt = buildPresignedFundingFeeChild(p2w.request);
  for (const role of ['change', 'sponsor'] as const) {
    const index = role === 'change' ? 0 : 1;
    const wallet = role === 'change' ? p2w.fixture.walletKeys.bob : p2w.sponsor;
    const signed = bitcoin.Psbt.fromBase64(signPsbt(p2wBuilt.psbtBase64, index, wallet, 'p2wpkh'));
    const origin = { pubkey: wallet.publicKey, masterFingerprint: Buffer.from('12345678', 'hex'), path: "m/84'/1'/0'/0/0" };
    signed.updateInput(index, { bip32Derivation: [origin], nonWitnessUtxo: role === 'change' ? bitcoin.Transaction.fromHex(p2w.request.fundingTransactionHex).toBuffer() : p2w.previous.toBuffer() });
    signed.updateOutput(index, { bip32Derivation: [origin] });
    const importingP2w = (base64: string) => authorizePresignedFundingFeeSignedPsbt({ request: p2w.request, role, signedPsbtBase64: base64, approvalDigest: p2wBuilt.approvalDigest });
    importingP2w(signed.toBase64());
    const badPrevious = bitcoin.Transaction.fromBuffer(signed.data.inputs[index]!.nonWitnessUtxo!);
    badPrevious.outs[0]!.value -= 1n;
    signed.data.inputs[index]!.nonWitnessUtxo = badPrevious.toBuffer();
    assert.throws(() => importingP2w(signed.toBase64()), /previous transaction differs/);
    assert.throws(() => importingP2w(signPsbt(p2wBuilt.psbtBase64, index, wallet, 'p2wpkh', bitcoin.Transaction.SIGHASH_NONE)), /commit all/);
  }
  checks.push(`${network}: both external wallets accept safe Taproot/BIP32 and full-parent metadata, reject forged full prevouts and weak sighash hints`);

  const original = finalize(state);
  const replacement: PresignedFundingFeeRequest = { ...request, approval: { ...request.approval, childFeeSats: 4_000,
    replacement: { previousChildTransactionHex: original.transactionHex, incrementalRelayRateMillisatsPerVbyte: 1_000 } } };
  const replaced = finalize(state, replacement);
  assert.notEqual(replaced.txid, original.txid);
  assert.equal(replaced.parentTxid, original.parentTxid);
  assert.throws(() => finalize(state, { ...replacement, approval: { ...replacement.approval, childFeeSats: 3_001 } }), /incremental relay/);
  assert.throws(() => buildPresignedFundingFeeChild({ ...replacement, sponsorInput: { ...replacement.sponsorInput, txid: sha256Hex('different sponsor') } }), /retain exact/);
  for (const mutate of [(tx: bitcoin.Transaction) => { tx.version = 2; }, (tx: bitcoin.Transaction) => { tx.outs[0]!.value -= 1n; },
    (tx: bitcoin.Transaction) => { tx.ins[0]!.witness = [Buffer.alloc(1001)]; }]) {
    const previous = bitcoin.Transaction.fromHex(original.transactionHex);
    mutate(previous);
    assert.throws(() => buildPresignedFundingFeeChild({ ...replacement, approval: { ...replacement.approval,
      replacement: { ...replacement.approval.replacement!, previousChildTransactionHex: previous.toHex() } } }));
  }
  assert.throws(() => finalize(state, { ...request, approval: { ...request.approval, childFeeSats: 1 } }), /relay floor/);
  assert.throws(() => finalize(state, { ...request, approval: { ...request.approval, childFeeSats: 500 } }), /package feerate/);
  finalize(state, { ...request, approval: { ...request.approval, minRelayRateMillisatsPerVbyte: 2_000 } });
  assert.throws(() => finalize(state, { ...request, approval: { ...request.approval, minRelayRateMillisatsPerVbyte: 10_000, targetPackageRateMillisatsPerVbyte: 1_000 } }), /package is below/);
  const noChange = { ...request, sponsorInput: { ...request.sponsorInput, valueSats: 3_000 },
    approval: { ...request.approval, sponsorChangeScriptPubKeyHex: null, approveExactNoChangeFee: true } };
  assert.equal(bitcoin.Transaction.fromHex(finalize(state, noChange).transactionHex).outs.length, 1);
  assert.throws(() => buildPresignedFundingFeeChild({ ...noChange, approval: { ...noChange.approval, approveExactNoChangeFee: false } }), /explicit/);
  assert.throws(() => buildPresignedFundingFeeChild({ ...request, sponsorInput: { ...request.sponsorInput, valueSats: 3_329 } }), /dust/);
  checks.push(`${network}: child-only replacement validates prior native signatures and exact inputs, caps, actual signed vsize rates and explicit no-change approval`);
}

assert.equal(signedChildren, 54);
console.log(JSON.stringify({ passed: true, offlineOnly: true, actualBitcoinCoreAcceptance: false, signedChildren, checks }, null, 2));
