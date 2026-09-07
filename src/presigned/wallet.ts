import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { assert } from './validation.js';

export interface NativeWalletPrevout { scriptPubKeyHex: string; valueSats: number }

/** Pure verification shared by v2 funding and fee sponsorship. No key custody. */
export function verifyNativeWalletWitness(
  tx: bitcoin.Transaction, index: number, prevouts: NativeWalletPrevout[], witness: Uint8Array[],
): void {
  assert(tx.ins.length === prevouts.length && index >= 0 && index < prevouts.length, 'wallet prevout mismatch');
  assert(tx.ins[index]!.script.length === 0, 'native wallet input must not have scriptSig');
  const script = Buffer.from(prevouts[index]!.scriptPubKeyHex, 'hex');
  if (script.length === 22 && script[0] === 0 && script[1] === 20) {
    assert(witness.length === 2, 'P2WPKH witness must contain signature and public key');
    const [signature, key] = witness;
    assert(key!.length === 33 && (key![0] === 2 || key![0] === 3) && ecc.isPoint(key!) &&
      Buffer.from(bitcoin.crypto.hash160(key!)).equals(script.subarray(2)), 'P2WPKH key differs from prevout');
    const decoded = bitcoin.script.signature.decode(signature!);
    assert(decoded.hashType === bitcoin.Transaction.SIGHASH_ALL, 'wallet P2WPKH signature must commit all inputs and outputs');
    const scriptCode = bitcoin.payments.p2pkh({ hash: script.subarray(2) }).output!;
    const message = tx.hashForWitnessV0(index, scriptCode, BigInt(prevouts[index]!.valueSats), decoded.hashType);
    assert(ecc.verify(message, key!, decoded.signature, true), 'invalid or high-S wallet P2WPKH signature');
  } else {
    assert(script.length === 34 && script[0] === 0x51 && script[1] === 0x20, 'wallet input is not native SegWit');
    assert(witness.length === 1, 'wallet P2TR input must be key-path without annex');
    const signature = witness[0]!;
    assert(signature.length === 64 || (signature.length === 65 && signature[64] === bitcoin.Transaction.SIGHASH_ALL), 'wallet P2TR requires SIGHASH_DEFAULT or ALL');
    const hashType = signature.length === 64 ? bitcoin.Transaction.SIGHASH_DEFAULT : bitcoin.Transaction.SIGHASH_ALL;
    const message = tx.hashForWitnessV1(index, prevouts.map(p => Buffer.from(p.scriptPubKeyHex, 'hex')),
      prevouts.map(p => BigInt(p.valueSats)), hashType);
    assert(ecc.verifySchnorr(message, script.subarray(2), signature.subarray(0, 64)), 'invalid wallet P2TR signature');
  }
}

export function nativeWalletWitnessFromPsbt(input: bitcoin.Psbt['data']['inputs'][number]): Buffer[] {
  assert(!input.finalScriptSig && !input.redeemScript && !input.witnessScript && !input.tapLeafScript?.length && !input.tapScriptSig?.length, 'wallet input contains a non-key-path script');
  if (input.finalScriptWitness) {
    assert(!input.partialSig?.length && !input.tapKeySig, 'wallet mixes final and partial signatures');
    return decodeNativeWalletWitness(Buffer.from(input.finalScriptWitness));
  }
  if (input.tapKeySig) {
    assert(!input.partialSig?.length, 'wallet mixes ECDSA and Taproot signatures');
    return [Buffer.from(input.tapKeySig)];
  }
  assert(input.partialSig?.length === 1, 'wallet input needs exactly one signature');
  return [Buffer.from(input.partialSig[0]!.signature), Buffer.from(input.partialSig[0]!.pubkey)];
}

export function hasWalletSignature(input: bitcoin.Psbt['data']['inputs'][number]): boolean {
  return Boolean(input.finalScriptSig || input.finalScriptWitness || input.partialSig?.length || input.tapKeySig || input.tapScriptSig?.length);
}

/** Native witnesses have <= 2 items of <= 73 bytes; no large CompactSize needed. */
export function decodeNativeWalletWitness(bytes: Buffer): Buffer[] {
  assert(bytes.length > 0 && bytes[0]! >= 1 && bytes[0]! <= 2, 'invalid native witness item count');
  let offset = 1;
  const result: Buffer[] = [];
  for (let index = 0; index < bytes[0]!; index += 1) {
    assert(offset < bytes.length, 'truncated native witness');
    const length = bytes[offset++]!;
    assert(length > 0 && length <= 73 && offset + length <= bytes.length, 'invalid native witness item');
    result.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  assert(offset === bytes.length, 'trailing native witness bytes');
  return result;
}
