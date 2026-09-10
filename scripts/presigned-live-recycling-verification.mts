/** PUBLIC DETERMINISTIC OFFLINE FIXTURES ONLY. Never fund these keys or parents.
 * Pure signing/validation checks: no RPC, wallet, filesystem, or network calls.
 * Synthetic parents establish serialization/prevout bindings, NOT consensus.
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { deterministicKeypair, SECP_ORDER, taggedHash } from '../src/crypto.js';
import { BITCOIN_NETWORK_NAME } from '../src/network.js';
import { createPresignedFixture } from '../src/presigned/fixtures.js';
import { PARTICIPANT_IDS, type ParticipantId } from '../src/presigned/types.js';
import { verifyNativeWalletWitness } from '../src/presigned/wallet.js';
import { buildRecyclingIntent, RECYCLING_FEE_CAP, RECYCLING_FEE_RATE_MILLISATS, recyclingFeeForVsize,
  signRecyclingPayout, validateRecyclingIntent, validateRecyclingWalletPsbt, validateSignedRecycling,
  type RecyclingCoin, type RecyclingIntent, type RecyclingSigned } from './lib/presigned-live-recycling.js';
import { sequentialCapitalEnvelopes, MINIMUM_SEQUENTIAL_CAPITAL, LIVE_CAPITAL_EXECUTION } from './lib/presigned-live-capital.js';

const fixture = createPresignedFixture({ network: 'signet', walletKinds: ['p2tr', 'p2wpkh', 'p2tr'] });
const checks: string[] = [];
let rejected = 0;
let signedTransactions = 0;
let normalizedWalletPsbts = 0;
const reservePair = deterministicKeypair('public-offline-recycling-verification', 'reserve');
const reserveScript = Buffer.from(bitcoin.payments.p2tr({
  internalPubkey: Buffer.from(reservePair.xonlyPubKeyHex, 'hex'),
}).output!).toString('hex');

function check(name: string, action: () => void) { action(); checks.push(name); }
function denied(action: () => unknown, message?: RegExp) {
  if (message) assert.throws(action, message); else assert.throws(action);
  rejected++;
}
function payoutScript(id: ParticipantId) {
  return Buffer.from(bitcoin.payments.p2tr({ internalPubkey: Buffer.from(
    fixture.roster.participants.find(item => item.id === id)!.payoutXonlyPublicKeyHex, 'hex'),
  }).output!).toString('hex');
}
function parentCoins(outputs: Array<{ scriptPubKeyHex: string; valueSats: number; participantId: ParticipantId | null }>,
  witnessBytes = 0): RecyclingCoin[] {
  const parent = new bitcoin.Transaction(); parent.version = 2;
  parent.addInput(Buffer.alloc(32, 0x42), 0, 0xfffffffe);
  for (const output of outputs) parent.addOutput(Buffer.from(output.scriptPubKeyHex, 'hex'), BigInt(output.valueSats));
  if (witnessBytes) parent.setWitness(0, [Buffer.alloc(witnessBytes, 0x51)]);
  return outputs.map((output, vout) => ({ ...output, txid: parent.getId(), vout, parentTransactionHex: parent.toHex() }));
}
function request(id: ParticipantId = 'alice') {
  return { id: 'case-00', sourceDigest: 'aa'.repeat(32), runDigest: 'bb'.repeat(32), previousCaseDigest: 'cc'.repeat(32),
    inputs: parentCoins([
      { scriptPubKeyHex: fixture.walletKeys.alice.scriptPubKeyHex, valueSats: 20_000, participantId: null },
      { scriptPubKeyHex: fixture.walletKeys.bob.scriptPubKeyHex, valueSats: 20_000, participantId: null },
      { scriptPubKeyHex: payoutScript(id), valueSats: 20_000, participantId: id },
    ]), targets: [{ scriptPubKeyHex: fixture.walletKeys.carol.scriptPubKeyHex, valueSats: 12_000 }],
    reserveScriptPubKeyHex: reserveScript };
}
function taprootWitness(tx: bitcoin.Transaction, intent: RecyclingIntent, index: number,
  privateKey: Uint8Array, publicKey: Uint8Array, hashType: number): Buffer[] {
  const publicBytes = Buffer.from(publicKey);
  const adjusted = Buffer.from(publicBytes[0] === 3 ? ecc.privateNegate(privateKey) : privateKey);
  const tweaked = ecc.privateAdd(adjusted, taggedHash('TapTweak', publicBytes.subarray(1))); assert(tweaked);
  try {
    const message = tx.hashForWitnessV1(index, intent.inputs.map(item => Buffer.from(item.scriptPubKeyHex, 'hex')),
      intent.inputs.map(item => BigInt(item.valueSats)), hashType);
    const signature = Buffer.from(ecc.signSchnorr(message, tweaked));
    return [hashType === bitcoin.Transaction.SIGHASH_DEFAULT ? signature : Buffer.concat([signature, Buffer.from([hashType])])];
  } finally { adjusted.fill(0); tweaked.fill(0); }
}
function sign(intent: RecyclingIntent, walletTaprootType = bitcoin.Transaction.SIGHASH_DEFAULT): RecyclingSigned {
  const tx = bitcoin.Transaction.fromHex(intent.unsignedTransactionHex);
  for (const [index, coin] of intent.inputs.entries()) {
    if (coin.participantId !== null) {
      const key = fixture.keysById[coin.participantId].payoutPrivateKey;
      const before = Buffer.from(key);
      tx.setWitness(index, [signRecyclingPayout(intent, index, coin.participantId, key,
        fixture.roster.participants.find(item => item.id === coin.participantId)!.payoutXonlyPublicKeyHex)]);
      assert(Buffer.from(key).equals(before), 'local signing modified its caller-owned key');
      continue;
    }
    const wallet = Object.values(fixture.walletKeys).find(item => item.scriptPubKeyHex === coin.scriptPubKeyHex); assert(wallet);
    if (wallet.kind === 'p2tr') tx.setWitness(index, taprootWitness(tx, intent, index, wallet.privateKey, wallet.publicKey, walletTaprootType));
    else {
      const message = tx.hashForWitnessV0(index, bitcoin.payments.p2pkh({ pubkey: wallet.publicKey }).output!,
        BigInt(coin.valueSats), bitcoin.Transaction.SIGHASH_ALL);
      tx.setWitness(index, [Buffer.from(bitcoin.script.signature.encode(ecc.sign(message, wallet.privateKey), bitcoin.Transaction.SIGHASH_ALL)), wallet.publicKey]);
    }
  }
  const signed = { transactionHex: tx.toHex(), txid: tx.getId(), intentDigest: intent.intentDigest };
  validateSignedRecycling(intent, signed);
  assert.equal(intent.inputSats - Number(tx.outs.reduce((sum, output) => sum + output.value, 0n)), intent.feeSats);
  assert.equal(intent.feeSats, recyclingFeeForVsize(intent.maximumSignedVsize));
  assert.equal(intent.feeRateMillisatsPerVbyte, RECYCLING_FEE_RATE_MILLISATS);
  assert(tx.virtualSize() <= intent.maximumSignedVsize && intent.feeSats <= RECYCLING_FEE_CAP);
  signedTransactions++;
  return signed;
}
function changedTransaction(signed: RecyclingSigned, change: (tx: bitcoin.Transaction) => void): RecyclingSigned {
  const tx = bitcoin.Transaction.fromHex(signed.transactionHex); change(tx);
  return { ...signed, transactionHex: tx.toHex(), txid: tx.getId() };
}
function nonminimalInputCount(hex: string): string {
  const offset = hex.slice(8, 12) === '0001' ? 12 : 8;
  assert(parseInt(hex.slice(offset, offset + 2), 16) < 0xfd);
  return `${hex.slice(0, offset)}fd${hex.slice(offset, offset + 2)}00${hex.slice(offset + 2)}`;
}
function encodeNativeWitness(witness: Uint8Array[]): Buffer {
  assert(witness.length >= 1 && witness.length <= 2 && witness.every(item => item.length <= 73));
  return Buffer.concat([Buffer.from([witness.length]), ...witness.flatMap(item => [Buffer.from([item.length]), Buffer.from(item)])]);
}
function walletPsbt(allocation: RecyclingIntent, completed: RecyclingSigned,
  metadata: 'full' | 'omitted' | 'stripped' | 'mixed' = 'full', finalized = false,
  changeUnsigned?: (tx: bitcoin.Transaction) => void): bitcoin.Psbt {
  const unsigned = bitcoin.Transaction.fromHex(allocation.unsignedTransactionHex);
  changeUnsigned?.(unsigned);
  const psbt = new bitcoin.Psbt(); psbt.setVersion(unsigned.version); psbt.setLocktime(unsigned.locktime);
  for (const [index, spent] of unsigned.ins.entries()) {
    const coin = allocation.inputs[index]!;
    const parent = bitcoin.Transaction.fromHex(coin.parentTransactionHex);
    const mode = metadata === 'mixed' ? (['full', 'omitted', 'stripped'] as const)[index % 3]! : metadata;
    if (mode === 'stripped') for (const input of parent.ins) input.witness = [];
    psbt.addInput({ hash: spent.hash, index: spent.index, sequence: spent.sequence,
      witnessUtxo: { script: Buffer.from(coin.scriptPubKeyHex, 'hex'), value: BigInt(coin.valueSats) },
      ...(mode === 'omitted' ? {} : { nonWitnessUtxo: parent.toBuffer() }) });
  }
  for (const output of unsigned.outs) psbt.addOutput(output);
  const signedTx = bitcoin.Transaction.fromHex(completed.transactionHex);
  for (const [index, coin] of allocation.inputs.entries()) {
    if (coin.participantId !== null) continue;
    const witness = signedTx.ins[index]!.witness;
    if (finalized) psbt.updateInput(index, { finalScriptWitness: encodeNativeWitness(witness) });
    else if (coin.scriptPubKeyHex.startsWith('5120')) psbt.updateInput(index, { tapKeySig: witness[0]! });
    else psbt.updateInput(index, { partialSig: [{ signature: witness[0]!, pubkey: witness[1]! }] });
  }
  return psbt;
}

check('new transport version preserves all cases and bounds every capital envelope with integer-ceiling fees', () => {
  assert.equal(LIVE_CAPITAL_EXECUTION, 'bounded-sequential-recycling-v2');
  assert.equal(MINIMUM_SEQUENTIAL_CAPITAL, 88_352);
  const envelopes = sequentialCapitalEnvelopes();
  assert.equal(envelopes.length, 20);
  assert.deepEqual([envelopes[0]!.minimumSeedSats, envelopes[6]!.minimumSeedSats, envelopes[10]!.minimumSeedSats,
    envelopes[18]!.minimumSeedSats, envelopes[19]!.minimumSeedSats], [81668, 76496, 86348, 88352, 54090]);
  assert(envelopes.every(item => item.minimumSeedSats <= MINIMUM_SEQUENTIAL_CAPITAL));
  for (let vsize = 1; vsize <= 1126; vsize++) {
    const fee = recyclingFeeForVsize(vsize);
    assert(BigInt(fee) * 1000n >= BigInt(vsize) * 300n);
    assert(BigInt(fee - 1) * 1000n < BigInt(vsize) * 300n);
  }
  denied(() => recyclingFeeForVsize(0)); denied(() => recyclingFeeForVsize(1.5));
  const current = buildRecyclingIntent(request());
  denied(() => validateRecyclingIntent({ ...current, version: 1 } as unknown as RecyclingIntent));
  denied(() => validateRecyclingIntent({ ...current, feeRateMillisatsPerVbyte: 2000 }));
});
check('all three local payout owners sign mixed P2WPKH ALL and wallet Taproot DEFAULT/ALL inputs', () => {
  for (const id of PARTICIPANT_IDS) for (const hashType of [bitcoin.Transaction.SIGHASH_DEFAULT, bitcoin.Transaction.SIGHASH_ALL]) {
    const original = request(id); const intent = buildRecyclingIntent(original);
    assert.equal(validateRecyclingIntent(intent), intent);
    const signed = sign(intent, hashType); const tx = bitcoin.Transaction.fromHex(signed.transactionHex);
    assert.equal(tx.outs[0]!.value, 12_000n);
    assert.equal(Buffer.from(tx.outs[0]!.script).toString('hex'), original.targets[0]!.scriptPubKeyHex);
    assert.equal(tx.ins[0]!.witness[0]!.length, hashType === bitcoin.Transaction.SIGHASH_DEFAULT ? 64 : 65);
    assert.equal(tx.ins[2]!.witness[0]!.length, 64);
    assert.equal(tx.getId(), intent.txid);
  }
});
const base = request(); const intent = buildRecyclingIntent(base); const signed = sign(intent, bitcoin.Transaction.SIGHASH_ALL);

check('high-S ECDSA is rejected despite being a cryptographically valid alternate witness', () => {
  const high = changedTransaction(signed, tx => {
    const decoded = bitcoin.script.signature.decode(tx.ins[1]!.witness[0]!);
    const compact = Buffer.from(decoded.signature);
    const oldS = BigInt(`0x${compact.subarray(32).toString('hex')}`); assert(oldS <= SECP_ORDER / 2n);
    Buffer.from((SECP_ORDER - oldS).toString(16).padStart(64, '0'), 'hex').copy(compact, 32);
    const message = tx.hashForWitnessV0(1, bitcoin.payments.p2pkh({ pubkey: fixture.walletKeys.bob.publicKey }).output!,
      BigInt(intent.inputs[1]!.valueSats), bitcoin.Transaction.SIGHASH_ALL);
    assert(ecc.verify(message, fixture.walletKeys.bob.publicKey, compact, false));
    assert.equal(ecc.verify(message, fixture.walletKeys.bob.publicKey, compact, true), false);
    tx.ins[1]!.witness[0] = bitcoin.script.signature.encode(compact, bitcoin.Transaction.SIGHASH_ALL);
  });
  assert.equal(high.txid, signed.txid);
  denied(() => validateSignedRecycling(intent, high), /high-S/);
});
check('local payouts require DEFAULT while wallet Taproot rejects weaker sighashes and annexes', () => {
  const privateKey = fixture.keysById.alice.payoutPrivateKey;
  const publicKey = ecc.pointFromScalar(privateKey, true)!;
  const localAll = changedTransaction(signed, tx => tx.setWitness(2,
    taprootWitness(tx, intent, 2, privateKey, publicKey, bitcoin.Transaction.SIGHASH_ALL)));
  const localAllTx = bitcoin.Transaction.fromHex(localAll.transactionHex);
  verifyNativeWalletWitness(localAllTx, 2, intent.inputs, localAllTx.ins[2]!.witness);
  denied(() => validateSignedRecycling(intent, localAll));
  for (const type of [bitcoin.Transaction.SIGHASH_NONE, bitcoin.Transaction.SIGHASH_ALL | bitcoin.Transaction.SIGHASH_ANYONECANPAY]) {
    const weaker = changedTransaction(signed, tx => tx.setWitness(0,
      taprootWitness(tx, intent, 0, fixture.walletKeys.alice.privateKey, fixture.walletKeys.alice.publicKey, type)));
    denied(() => validateSignedRecycling(intent, weaker), /SIGHASH_DEFAULT or ALL/);
  }
  denied(() => validateSignedRecycling(intent, changedTransaction(signed, tx => tx.ins[0]!.witness.push(Buffer.from([0x50])))));
});
check('missing or invalid witnesses, wrong payout owner, key and index are rejected', () => {
  for (let index = 0; index < 3; index++) {
    denied(() => validateSignedRecycling(intent, changedTransaction(signed, tx => tx.setWitness(index, []))));
    denied(() => validateSignedRecycling(intent, changedTransaction(signed, tx => {
      const witness = tx.ins[index]!.witness[0]!; witness[8] = witness[8]! ^ 1;
    })));
  }
  const identity = fixture.roster.participants.find(item => item.id === 'alice')!;
  denied(() => signRecyclingPayout(intent, 2, 'bob', fixture.keysById.alice.payoutPrivateKey, identity.payoutXonlyPublicKeyHex));
  denied(() => signRecyclingPayout(intent, 2, 'alice', fixture.keysById.bob.payoutPrivateKey, identity.payoutXonlyPublicKeyHex));
  denied(() => signRecyclingPayout(intent, 0, 'alice', fixture.keysById.alice.payoutPrivateKey, identity.payoutXonlyPublicKeyHex));
  denied(() => signRecyclingPayout(intent, -1, 'alice', fixture.keysById.alice.payoutPrivateKey, identity.payoutXonlyPublicKeyHex));
});
check('unknown journal fields are rejected and caller coin mutation cannot alter a built intent', () => {
  const unexpectedCoin = { ...base.inputs[0]!, unexpectedField: true };
  const unexpectedTarget = { ...base.targets[0]!, unexpectedField: true };
  denied(() => buildRecyclingIntent({ ...base, inputs: [unexpectedCoin, ...base.inputs.slice(1)] }));
  denied(() => buildRecyclingIntent({ ...base, targets: [unexpectedTarget] }));
  denied(() => validateRecyclingIntent({ ...intent, unexpectedField: true } as RecyclingIntent));
  denied(() => validateSignedRecycling(intent, { ...signed, unexpectedField: true } as RecyclingSigned));
  const original = request(); const copied = buildRecyclingIntent(original);
  original.inputs[0]!.valueSats++;
  assert.equal(copied.inputs[0]!.valueSats, 20_000); validateRecyclingIntent(copied);
});
check('signed and parent hex reject suffixes, odd hex, uppercase, oversized data and nonminimal serialization', () => {
  for (const hex of [signed.transactionHex + 'zz', signed.transactionHex + '0', signed.transactionHex.toUpperCase(),
    signed.transactionHex + '00'.repeat(200_001), nonminimalInputCount(signed.transactionHex)])
    denied(() => validateSignedRecycling(intent, { ...signed, transactionHex: hex }));
  for (const hex of [base.inputs[0]!.parentTransactionHex + 'zz', base.inputs[0]!.parentTransactionHex + '0',
    base.inputs[0]!.parentTransactionHex.toUpperCase(), '00'.repeat(200_001), nonminimalInputCount(base.inputs[0]!.parentTransactionHex)])
    denied(() => buildRecyclingIntent({ ...base, inputs: [{ ...base.inputs[0]!, parentTransactionHex: hex }, ...base.inputs.slice(1)] }));
});
check('mutated templates, output substitution, fee claims and approval digests cannot pass validation', () => {
  for (const change of [
    (tx: bitcoin.Transaction) => { tx.outs[0]!.value--; },
    (tx: bitcoin.Transaction) => { tx.outs[0]!.script = Buffer.from(payoutScript('bob'), 'hex'); },
    (tx: bitcoin.Transaction) => { tx.outs.at(-1)!.value--; },
    (tx: bitcoin.Transaction) => { tx.ins[0]!.sequence--; },
    (tx: bitcoin.Transaction) => { tx.ins[0]!.index++; },
    (tx: bitcoin.Transaction) => { tx.version = 3; },
  ]) denied(() => validateSignedRecycling(intent, changedTransaction(signed, change)));
  for (const patch of [{ feeSats: RECYCLING_FEE_CAP + 1 }, { maximumFeeSats: RECYCLING_FEE_CAP + 1 },
    { maximumSignedVsize: intent.maximumSignedVsize - 1 }, { reserveSats: intent.reserveSats + 1 },
    { inputSats: intent.inputSats + 1 }, { unsignedTransactionHex: intent.unsignedTransactionHex + '00' }])
    denied(() => validateRecyclingIntent({ ...intent, ...patch }));
  denied(() => validateSignedRecycling(intent, { ...signed, intentDigest: 'dd'.repeat(32) }));
});
check('duplicate or substituted inputs and destinations, dust, overspending and unsupported sources fail', () => {
  denied(() => buildRecyclingIntent({ ...base, inputs: [...base.inputs, { ...base.inputs[0]! }] }));
  denied(() => buildRecyclingIntent({ ...base, inputs: [] }));
  denied(() => buildRecyclingIntent({ ...base, targets: [...base.targets, { ...base.targets[0]! }] }));
  denied(() => buildRecyclingIntent({ ...base, reserveScriptPubKeyHex: base.targets[0]!.scriptPubKeyHex }));
  denied(() => buildRecyclingIntent({ ...base, targets: [{ ...base.targets[0]!, valueSats: 329 }] }));
  denied(() => buildRecyclingIntent({ ...base, targets: [{ ...base.targets[0]!, valueSats: intent.inputSats }] }));
  for (const patch of [{ valueSats: 20_001 }, { valueSats: 329 }, { valueSats: 1_000_001 }, { valueSats: 1.5 },
    { vout: -1 }, { vout: 0x1_0000_0000 }, { txid: 'dd'.repeat(32) },
    { scriptPubKeyHex: 'a914' + '22'.repeat(20) + '87' }])
    denied(() => buildRecyclingIntent({ ...base, inputs: [{ ...base.inputs[0]!, ...patch }, ...base.inputs.slice(1)] }));
  denied(() => buildRecyclingIntent({ ...base, inputs: [base.inputs[0]!, { ...base.inputs[1]!, participantId: 'alice' }, base.inputs[2]!] }));
});
check('maximum native shapes remain conservatively sized and absolute input/output limits reject excess', () => {
  const targetScripts = [...Object.values(fixture.walletKeys).map(item => item.scriptPubKeyHex), ...PARTICIPANT_IDS.map(payoutScript)];
  for (const kind of ['p2tr', 'p2wpkh'] as const) {
    const scriptPubKeyHex = fixture.walletKeys[kind === 'p2tr' ? 'alice' : 'bob'].scriptPubKeyHex;
    const maximum = { ...base, inputs: parentCoins(Array.from({ length: 10 }, () => ({ scriptPubKeyHex, valueSats: 100_000, participantId: null }))),
      targets: targetScripts.map(scriptPubKeyHex => ({ scriptPubKeyHex, valueSats: 12_000 })) };
    sign(buildRecyclingIntent(maximum), bitcoin.Transaction.SIGHASH_ALL);
    denied(() => buildRecyclingIntent({ ...maximum, inputs: parentCoins(Array.from({ length: 11 }, () => ({ scriptPubKeyHex, valueSats: 12_000, participantId: null }))) }));
    denied(() => buildRecyclingIntent({ ...maximum, inputs: parentCoins(Array.from({ length: 10 }, () => ({ scriptPubKeyHex, valueSats: 100_001, participantId: null }))) }));
    denied(() => buildRecyclingIntent({ ...maximum, targets: [...maximum.targets, { scriptPubKeyHex: reserveScript, valueSats: 12_000 }] }));
  }
});
check('individually bounded parents cannot create an unreadable oversized durable intent', () => {
  const inputs = parentCoins(Array.from({ length: 10 }, () => ({ scriptPubKeyHex: fixture.walletKeys.bob.scriptPubKeyHex,
    valueSats: 12_000, participantId: null })), 180_000);
  assert(inputs.every(coin => coin.parentTransactionHex.length < 400_000));
  denied(() => buildRecyclingIntent({ ...base, inputs }), /private journal bound/);
});

// A nonempty synthetic parent witness makes the normalization test meaningful:
// stripped and full parents differ in serialization/wtxid but not txid or value.
const normalizedRequest = request();
normalizedRequest.inputs = parentCoins(normalizedRequest.inputs.map(coin => ({ scriptPubKeyHex: coin.scriptPubKeyHex,
  valueSats: coin.valueSats, participantId: coin.participantId })), 64);
const normalizedIntent = buildRecyclingIntent(normalizedRequest);
const normalizedSigned = sign(normalizedIntent, bitcoin.Transaction.SIGHASH_ALL);
const normalizedTx = bitcoin.Transaction.fromHex(normalizedSigned.transactionHex);

check('Core full, omitted, witness-stripped and mixed parent metadata preserve verified wallet signatures', () => {
  const originalParent = bitcoin.Transaction.fromHex(normalizedIntent.inputs[0]!.parentTransactionHex);
  const strippedParent = originalParent.clone(); strippedParent.ins[0]!.witness = [];
  assert.notEqual(strippedParent.toHex(), originalParent.toHex());
  assert.equal(strippedParent.getId(), originalParent.getId());
  assert.notEqual(Buffer.from(strippedParent.getHash(true)).toString('hex'), Buffer.from(originalParent.getHash(true)).toString('hex'));
  for (const metadata of ['full', 'omitted', 'stripped', 'mixed'] as const) for (const finalized of [false, true]) {
    const psbt = walletPsbt(normalizedIntent, normalizedSigned, metadata, finalized);
    const witnesses = validateRecyclingWalletPsbt(normalizedIntent, psbt.toBase64());
    assert.equal(witnesses.length, 3);
    for (const index of [0, 1]) assert.deepEqual(witnesses[index]!.map(item => Buffer.from(item)),
      normalizedTx.ins[index]!.witness.map(item => Buffer.from(item)));
    assert.equal(witnesses[2], null, 'wallet metadata must not supply the local payout signature');
    normalizedWalletPsbts++;
  }
});
check('Core PSBT changed templates, missing/changed witness prevouts and substituted parents are rejected', () => {
  for (const change of [
    (tx: bitcoin.Transaction) => { tx.version = 3; },
    (tx: bitcoin.Transaction) => { tx.locktime++; },
    (tx: bitcoin.Transaction) => { tx.ins[0]!.sequence--; },
    (tx: bitcoin.Transaction) => { tx.ins[0]!.index += 10; },
    (tx: bitcoin.Transaction) => { tx.outs[0]!.value--; },
    (tx: bitcoin.Transaction) => { tx.outs[0]!.script = Buffer.from(payoutScript('bob'), 'hex'); },
  ]) {
    const changed = walletPsbt(normalizedIntent, normalizedSigned, 'omitted', false, change).toBase64();
    denied(() => validateRecyclingWalletPsbt(normalizedIntent, changed), /template/);
  }
  for (let index = 0; index < normalizedIntent.inputs.length; index++) {
    for (const change of ['missing', 'value', 'script'] as const) {
      const psbt = walletPsbt(normalizedIntent, normalizedSigned, 'omitted');
      const input = psbt.data.inputs[index]!;
      if (change === 'missing') delete input.witnessUtxo;
      else if (change === 'value') input.witnessUtxo!.value++;
      else input.witnessUtxo!.script = Buffer.from(reserveScript, 'hex');
      denied(() => validateRecyclingWalletPsbt(normalizedIntent, psbt.toBase64()), /witness prevout/);
    }
  }
  for (const change of [
    (tx: bitcoin.Transaction) => { tx.ins[0]!.index++; },
    (tx: bitcoin.Transaction) => { tx.outs[0]!.value++; },
    (tx: bitcoin.Transaction) => { tx.outs[1]!.value++; },
    (tx: bitcoin.Transaction) => { tx.outs[0]!.script = Buffer.from(reserveScript, 'hex'); },
  ]) {
    const psbt = walletPsbt(normalizedIntent, normalizedSigned);
    const parent = bitcoin.Transaction.fromBuffer(psbt.data.inputs[0]!.nonWitnessUtxo!); change(parent);
    psbt.data.inputs[0]!.nonWitnessUtxo = parent.toBuffer();
    denied(() => validateRecyclingWalletPsbt(normalizedIntent, psbt.toBase64()), /parent identity/);
  }
  const noncanonical = walletPsbt(normalizedIntent, normalizedSigned);
  noncanonical.data.inputs[0]!.nonWitnessUtxo = Buffer.from(nonminimalInputCount(normalizedIntent.inputs[0]!.parentTransactionHex), 'hex');
  denied(() => validateRecyclingWalletPsbt(normalizedIntent, noncanonical.toBase64()));
  const canonical = walletPsbt(normalizedIntent, normalizedSigned).toBase64();
  for (const malformed of [canonical + '!', canonical + '\n', 'A'.repeat(4_000_004)])
    denied(() => validateRecyclingWalletPsbt(normalizedIntent, malformed), /canonical base64/);
});
check('Core PSBT invalid/missing wallet signatures and any participant signature are rejected before local signing', () => {
  for (const index of [0, 1]) for (const mutation of ['missing', 'invalid'] as const) {
    const psbt = walletPsbt(normalizedIntent, normalizedSigned);
    const input = psbt.data.inputs[index]!;
    if (mutation === 'missing') { delete input.tapKeySig; delete input.partialSig; }
    else {
      const bytes = input.tapKeySig ?? input.partialSig![0]!.signature;
      bytes[8] = bytes[8]! ^ 1;
    }
    denied(() => validateRecyclingWalletPsbt(normalizedIntent, psbt.toBase64()));
  }
  const high = walletPsbt(normalizedIntent, normalizedSigned);
  const compact = Buffer.from(bitcoin.script.signature.decode(high.data.inputs[1]!.partialSig![0]!.signature).signature);
  const oldS = BigInt(`0x${compact.subarray(32).toString('hex')}`);
  Buffer.from((SECP_ORDER - oldS).toString(16).padStart(64, '0'), 'hex').copy(compact, 32);
  high.data.inputs[1]!.partialSig![0]!.signature = bitcoin.script.signature.encode(compact, bitcoin.Transaction.SIGHASH_ALL);
  denied(() => validateRecyclingWalletPsbt(normalizedIntent, high.toBase64()), /high-S/);
  for (const participantField of ['tapKeySig', 'partialSig', 'finalScriptWitness', 'finalScriptSig'] as const) {
    const psbt = walletPsbt(normalizedIntent, normalizedSigned);
    const participant = psbt.data.inputs[2]!;
    if (participantField === 'tapKeySig') participant.tapKeySig = normalizedTx.ins[2]!.witness[0]!;
    else if (participantField === 'partialSig') participant.partialSig = [{ pubkey: fixture.walletKeys.bob.publicKey,
      signature: normalizedTx.ins[1]!.witness[0]! }];
    else if (participantField === 'finalScriptWitness') participant.finalScriptWitness = encodeNativeWitness(normalizedTx.ins[2]!.witness);
    else participant.finalScriptSig = Buffer.from([0]);
    denied(() => validateRecyclingWalletPsbt(normalizedIntent, psbt.toBase64()), /unexpectedly signed/);
  }
});

console.log(JSON.stringify({ passed: true, protocol: 'presigned-graph-v2', configuredNetwork: BITCOIN_NETWORK_NAME,
  scope: 'pure-offline-capital-recycling', publicDeterministicKeys: true, syntheticParents: true,
  networkCalls: 0, walletCalls: 0, consensusOrLiveSignetVerified: false, signedTransactions,
  normalizedWalletPsbts, rejectedMutations: rejected, completedChecks: checks.length, checks }, null, 2));
