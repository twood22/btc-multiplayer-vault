/** Exact, bounded transport of isolated test capital. Not a product withdrawal API. */
import assert from 'node:assert/strict';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { taggedHash } from '../../src/crypto.js';
import { commitmentDigest } from '../../src/presigned/validation.js';
import { hasWalletSignature, nativeWalletWitnessFromPsbt, verifyNativeWalletWitness } from '../../src/presigned/wallet.js';
import type { ParticipantId } from '../../src/presigned/types.js';
import { RECYCLING_FEE_CAP, RECYCLING_FEE_RATE_MILLISATS, recyclingFeeForVsize } from './presigned-live-capital.js';

export { RECYCLING_FEE_CAP, RECYCLING_FEE_RATE_MILLISATS, MINIMUM_SEQUENTIAL_CAPITAL, recyclingFeeForVsize } from './presigned-live-capital.js';
export interface RecyclingCoin {
  txid: string; vout: number; valueSats: number; scriptPubKeyHex: string;
  participantId: ParticipantId | null; parentTransactionHex: string;
}
export interface RecyclingTarget { scriptPubKeyHex: string; valueSats: number }
export interface RecyclingIntent {
  version: 2; kind: 'presigned-isolated-capital-allocation'; id: string;
  sourceDigest: string; runDigest: string; previousCaseDigest: string | null;
  inputs: RecyclingCoin[]; targets: RecyclingTarget[]; reserveScriptPubKeyHex: string;
  inputSats: number; reserveSats: number; feeSats: number; maximumFeeSats: number;
  feeRateMillisatsPerVbyte: number;
  maximumSignedVsize: number; unsignedTransactionHex: string; txid: string; psbtBase64: string;
  intentDigest: string;
}
export interface RecyclingSigned { transactionHex: string; txid: string; intentDigest: string }

export const coinId = (coin: { txid: string; vout: number }) => `${coin.txid}:${coin.vout}`;
function nativeKind(script: string) {
  assert(/^(?:0014[0-9a-f]{40}|5120[0-9a-f]{64})$/u.test(script), 'capital transport needs native wallet or payout inputs');
  return script.startsWith('5120') ? 'p2tr' : 'p2wpkh';
}
function unsignedHex(transaction: bitcoin.Transaction) {
  const copy = transaction.clone();
  for (const input of copy.ins) input.witness = [];
  return copy.toHex();
}
function exactKeys(value: object, keys: string[]) {
  assert.deepEqual(Object.keys(value).sort(), keys.sort(), 'unexpected capital journal field');
}
function transactionHex(value: unknown): asserts value is string {
  assert(typeof value === 'string' && value.length >= 20 && value.length <= 400_000 &&
    /^(?:[0-9a-f]{2})+$/u.test(value), 'capital transaction must be bounded canonical hexadecimal');
}
export function buildRecyclingIntent(input: {
  id: string; sourceDigest: string; runDigest: string; previousCaseDigest: string | null;
  inputs: RecyclingCoin[]; targets: RecyclingTarget[]; reserveScriptPubKeyHex: string;
}): RecyclingIntent {
  assert(/^(?:case-(?:0[0-9]|1[0-8])|return)$/u.test(input.id));
  assert(/^[0-9a-f]{64}$/u.test(input.sourceDigest) && /^[0-9a-f]{64}$/u.test(input.runDigest));
  assert(input.previousCaseDigest === null || /^[0-9a-f]{64}$/u.test(input.previousCaseDigest));
  assert(input.inputs.length >= 1 && input.inputs.length <= 10 && input.targets.length <= 6);
  nativeKind(input.reserveScriptPubKeyHex);
  const coins = input.inputs.map(coin => {
    exactKeys(coin, ['txid', 'vout', 'valueSats', 'scriptPubKeyHex', 'participantId', 'parentTransactionHex']);
    return { txid: coin.txid, vout: coin.vout, valueSats: coin.valueSats,
      scriptPubKeyHex: coin.scriptPubKeyHex, participantId: coin.participantId, parentTransactionHex: coin.parentTransactionHex };
  }).sort((a, b) => coinId(a).localeCompare(coinId(b)));
  assert(new Set(coins.map(coinId)).size === coins.length, 'duplicate capital input');
  let inputSats = 0;
  for (const coin of coins) {
    assert(/^[0-9a-f]{64}$/u.test(coin.txid) && Number.isSafeInteger(coin.vout) && coin.vout >= 0);
    assert(Number.isSafeInteger(coin.valueSats) && coin.valueSats >= 330 && coin.valueSats <= 1_000_000);
    nativeKind(coin.scriptPubKeyHex);
    assert(coin.participantId === null || ['alice', 'bob', 'carol'].includes(coin.participantId));
    assert(coin.participantId === null || coin.scriptPubKeyHex.startsWith('5120'));
    transactionHex(coin.parentTransactionHex);
    const parent = bitcoin.Transaction.fromHex(coin.parentTransactionHex);
    assert.equal(parent.toHex(), coin.parentTransactionHex, 'capital parent hexadecimal is not canonical');
    const output = parent.outs[coin.vout];
    assert(parent.getId() === coin.txid && output && output.value === BigInt(coin.valueSats) &&
      Buffer.from(output.script).toString('hex') === coin.scriptPubKeyHex, 'capital input differs from its exact parent');
    inputSats += coin.valueSats;
  }
  assert(inputSats <= 1_000_000, 'isolated capital transport exceeds its absolute bound');
  const targets = input.targets.map(target => {
    exactKeys(target, ['scriptPubKeyHex', 'valueSats']);
    nativeKind(target.scriptPubKeyHex);
    assert(Number.isSafeInteger(target.valueSats) && target.valueSats >= 330);
    return { scriptPubKeyHex: target.scriptPubKeyHex, valueSats: target.valueSats };
  });
  const scripts = [...targets.map(target => target.scriptPubKeyHex), input.reserveScriptPubKeyHex];
  assert(new Set(scripts).size === scripts.length, 'allocation repeats a target or reserve script');
  const transaction = new bitcoin.Transaction(); transaction.version = 2; transaction.locktime = 0;
  for (const coin of coins) transaction.addInput(Buffer.from(coin.txid, 'hex').reverse(), coin.vout, 0xfffffffe);
  for (const target of targets) transaction.addOutput(Buffer.from(target.scriptPubKeyHex, 'hex'), BigInt(target.valueSats));
  transaction.addOutput(Buffer.from(input.reserveScriptPubKeyHex, 'hex'), 330n);
  coins.forEach((coin, index) => transaction.setWitness(index, nativeKind(coin.scriptPubKeyHex) === 'p2tr'
    ? [Buffer.alloc(coin.participantId === null ? 65 : 64)] : [Buffer.alloc(73), Buffer.alloc(33)]));
  const maximumSignedVsize = transaction.virtualSize();
  const feeSats = recyclingFeeForVsize(maximumSignedVsize);
  assert(feeSats > 0 && feeSats <= RECYCLING_FEE_CAP, 'bounded allocation fee is insufficient for these exact inputs/outputs');
  const reserveSats = inputSats - targets.reduce((sum, target) => sum + target.valueSats, 0) - feeSats;
  assert(reserveSats >= 330, 'insufficient isolated capital for this exact allocation and reserve');
  transaction.outs.at(-1)!.value = BigInt(reserveSats);
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.testnet }); psbt.setVersion(2); psbt.setLocktime(0);
  for (const coin of coins) psbt.addInput({ hash: coin.txid, index: coin.vout, sequence: 0xfffffffe,
    witnessUtxo: { script: Buffer.from(coin.scriptPubKeyHex, 'hex'), value: BigInt(coin.valueSats) },
    nonWitnessUtxo: Buffer.from(coin.parentTransactionHex, 'hex') });
  for (const output of transaction.outs) psbt.addOutput({ script: output.script, value: output.value });
  const body = { version: 2 as const, kind: 'presigned-isolated-capital-allocation' as const, id: input.id,
    sourceDigest: input.sourceDigest, runDigest: input.runDigest, previousCaseDigest: input.previousCaseDigest,
    inputs: coins, targets, reserveScriptPubKeyHex: input.reserveScriptPubKeyHex, inputSats, reserveSats, feeSats,
    maximumFeeSats: RECYCLING_FEE_CAP, feeRateMillisatsPerVbyte: RECYCLING_FEE_RATE_MILLISATS, maximumSignedVsize,
    unsignedTransactionHex: unsignedHex(transaction), txid: transaction.getId(), psbtBase64: psbt.toBase64() };
  const intent = { ...body, intentDigest: commitmentDigest('vault/presigned-graph-v2/isolated-capital-allocation', body) };
  assert(Buffer.byteLength(JSON.stringify(intent, null, 2)) < 4_000_000, 'capital intent exceeds its private journal bound');
  return intent;
}
export function validateRecyclingIntent(intent: RecyclingIntent) {
  assert.deepEqual(intent, buildRecyclingIntent(intent), 'capital allocation intent changed');
  return intent;
}
/** Core may omit redundant native parents or strip their witnesses. Compare
 * authoritative outpoint identity/non-witness bytes, not wallet serialization
 * choices. Verify ALL external inputs before the caller restores payout keys. */
export function validateRecyclingWalletPsbt(intent: RecyclingIntent, psbtBase64: string): Array<Buffer[] | null> {
  validateRecyclingIntent(intent);
  assert(typeof psbtBase64 === 'string' && psbtBase64.length > 0 && psbtBase64.length <= 4_000_000 &&
    Buffer.from(psbtBase64, 'base64').toString('base64') === psbtBase64, 'capital wallet PSBT must be bounded canonical base64');
  const external = bitcoin.Psbt.fromBase64(psbtBase64);
  const unsigned = bitcoin.Transaction.fromHex(intent.unsignedTransactionHex);
  assert.equal(Buffer.from(external.data.globalMap.unsignedTx.toBuffer()).toString('hex'), intent.unsignedTransactionHex,
    'wallet substituted the isolated allocation template');
  assert.equal(external.data.inputs.length, intent.inputs.length);
  return intent.inputs.map((coin, index) => {
    const input = external.data.inputs[index]!;
    assert(input.witnessUtxo?.value === BigInt(coin.valueSats) &&
      Buffer.from(input.witnessUtxo.script).toString('hex') === coin.scriptPubKeyHex,
    'wallet substituted isolated allocation witness prevout data');
    if (input.nonWitnessUtxo) {
      const parent = bitcoin.Transaction.fromBuffer(input.nonWitnessUtxo);
      assert(Buffer.from(parent.toBuffer()).equals(Buffer.from(input.nonWitnessUtxo)) && parent.getId() === coin.txid &&
        unsignedHex(parent) === unsignedHex(bitcoin.Transaction.fromHex(coin.parentTransactionHex)),
      'wallet substituted isolated allocation parent identity');
    }
    if (coin.participantId !== null) {
      assert(!hasWalletSignature(input), 'Core unexpectedly signed a participant-owned payout');
      return null;
    }
    const witness = nativeWalletWitnessFromPsbt(input);
    verifyNativeWalletWitness(unsigned, index, intent.inputs, witness);
    return witness;
  });
}
export function validateSignedRecycling(intent: RecyclingIntent, signed: RecyclingSigned) {
  validateRecyclingIntent(intent);
  exactKeys(signed, ['transactionHex', 'txid', 'intentDigest']);
  assert(signed.intentDigest === intent.intentDigest && signed.txid === intent.txid);
  transactionHex(signed.transactionHex);
  const tx = bitcoin.Transaction.fromHex(signed.transactionHex);
  assert.equal(tx.toHex(), signed.transactionHex, 'signed capital hexadecimal is not canonical');
  assert(tx.getId() === signed.txid && unsignedHex(tx) === intent.unsignedTransactionHex, 'signed allocation changed its exact template');
  for (const [index, coin] of intent.inputs.entries()) {
    const witness = tx.ins[index]!.witness;
    if (coin.participantId !== null) {
      assert(witness.length === 1 && witness[0]!.length === 64);
    }
    verifyNativeWalletWitness(tx, index, intent.inputs, witness);
  }
  assert(tx.virtualSize() <= intent.maximumSignedVsize && intent.feeSats >= recyclingFeeForVsize(tx.virtualSize()) &&
    intent.feeSats <= RECYCLING_FEE_CAP);
  return signed;
}
/** Restore keys at the caller; this signature never imports them into Core. */
export function signRecyclingPayout(intent: RecyclingIntent, index: number, participantId: ParticipantId,
  payoutPrivateKey: Uint8Array, payoutXonlyPublicKeyHex: string) {
  validateRecyclingIntent(intent);
  const coin = intent.inputs[index]; assert(coin && coin.participantId === participantId);
  const secret = Buffer.from(payoutPrivateKey); let adjusted: Uint8Array | undefined; let tweaked: Uint8Array | undefined;
  try {
    assert(secret.length === 32 && ecc.isPrivate(secret));
    const point = Buffer.from(ecc.pointFromScalar(secret, true)!);
    assert(point.subarray(1).toString('hex') === payoutXonlyPublicKeyHex);
    const script = bitcoin.payments.p2tr({ internalPubkey: point.subarray(1), network: bitcoin.networks.testnet }).output!;
    assert(Buffer.from(script).toString('hex') === coin.scriptPubKeyHex, 'payout key differs from exact recycling input');
    adjusted = point[0] === 3 ? ecc.privateNegate(secret) : Buffer.from(secret);
    const value = ecc.privateAdd(adjusted, taggedHash('TapTweak', point.subarray(1))); assert(value);
    tweaked = value;
    const tx = bitcoin.Transaction.fromHex(intent.unsignedTransactionHex);
    return Buffer.from(ecc.signSchnorr(tx.hashForWitnessV1(index,
      intent.inputs.map(input => Buffer.from(input.scriptPubKeyHex, 'hex')),
      intent.inputs.map(input => BigInt(input.valueSats)), bitcoin.Transaction.SIGHASH_DEFAULT), tweaked));
  } finally { secret.fill(0); adjusted?.fill(0); tweaked?.fill(0); }
}
