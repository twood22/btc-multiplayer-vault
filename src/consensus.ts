import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { keyAgg, taggedHash } from './crypto.js';
import type { Prevout } from './types.js';

bitcoin.initEccLib(ecc);

// Independent verification of fully signed transactions produced by this repo.
// It re-derives the taproot commitment from each input's control block,
// recomputes the BIP-341 sighash, verifies every Schnorr signature, and
// emulates execution of the two tapscript shapes the vault uses:
//   1. <xonly> OP_CHECKSIG                        (solo-withdrawal leaves)
//   2. <n> OP_CSV OP_DROP <multi_a threshold>      (timelocked recovery leaf)
// plus taproot key-path spends. It also enforces BIP-68 relative-timelock
// encoding rules for the recovery path and a >= 1 sat/vB relay fee sanity
// check. This is not a full script interpreter — it accepts only the exact
// script/witness shapes this vault produces, and rejects anything else.

const ANNEX_PREFIX = 0x50;

export interface ConsensusVerification {
  txid: string;
  vsize: number;
  feeSats: number;
  checks: string[];
}

interface InputContext {
  tx: bitcoin.Transaction;
  index: number;
  prevoutScripts: Buffer[];
  prevoutValues: bigint[];
  outputKey: Buffer;
  witness: Buffer[];
  checks: string[];
}

export function verifyVaultTransaction({
  txHex,
  prevouts,
}: {
  txHex: string;
  prevouts: Prevout[];
}): ConsensusVerification {
  const tx = bitcoin.Transaction.fromHex(txHex);
  if (tx.ins.length !== prevouts.length) {
    throw new Error(`transaction has ${tx.ins.length} inputs but ${prevouts.length} prevouts supplied`);
  }
  const prevoutScripts = prevouts.map((prevout) => Buffer.from(prevout.scriptPubKeyHex, 'hex'));
  const prevoutValues = prevouts.map((prevout) => BigInt(prevout.valueSats));
  const checks: string[] = [];

  tx.ins.forEach((input, index) => {
    const script = prevoutScripts[index]!;
    if (script.length !== 34 || script[0] !== 0x51 || script[1] !== 0x20) {
      throw new Error(`input ${index} prevout is not a v1 P2TR output`);
    }
    const outputKey = script.subarray(2);
    const witness = input.witness.map((item) => Buffer.from(item));
    if (witness.length === 0) throw new Error(`input ${index} has an empty witness`);
    if (witness.length >= 2 && witness.at(-1)![0] === ANNEX_PREFIX) {
      throw new Error(`input ${index} carries an annex; the vault never produces one`);
    }

    const context: InputContext = { tx, index, prevoutScripts, prevoutValues, outputKey, witness, checks };
    if (witness.length === 1) {
      verifyKeyPathSpend(context);
    } else {
      verifyScriptPathSpend(context);
    }
  });

  const inputTotal = prevouts.reduce((sum, prevout) => sum + Number(prevout.valueSats), 0);
  const outputTotal = tx.outs.reduce((sum, output) => sum + Number(output.value), 0);
  const feeSats = inputTotal - outputTotal;
  if (feeSats < 0) throw new Error('outputs exceed inputs');
  const vsize = tx.virtualSize();
  if (feeSats < vsize) {
    throw new Error(`fee ${feeSats} sats is below 1 sat/vB relay floor for ${vsize} vbytes`);
  }
  checks.push(`fee ${feeSats} sats covers ${vsize} vbytes at >= 1 sat/vB`);

  return { txid: tx.getId(), vsize, feeSats, checks };
}

function verifyKeyPathSpend({ tx, index, prevoutScripts, prevoutValues, outputKey, witness, checks }: InputContext): void {
  const { signature, hashType } = parseSchnorrSignature(witness[0]!, `input ${index} key-path`);
  const sighash = tx.hashForWitnessV1(index, prevoutScripts, prevoutValues, hashType);
  if (!ecc.verifySchnorr(sighash, outputKey, signature)) {
    throw new Error(`input ${index} key-path Schnorr signature is invalid`);
  }
  checks.push(`input ${index}: key-path signature valid for output key ${outputKey.toString('hex')}`);
}

function verifyScriptPathSpend(context: InputContext): void {
  const { tx, index, outputKey, witness, checks } = context;
  if (witness.length < 2) throw new Error(`input ${index} script-path witness too short`);
  const controlBlock = witness.at(-1)!;
  const leafScript = witness.at(-2)!;
  const stack = witness.slice(0, -2);

  if (controlBlock.length < 33 || (controlBlock.length - 33) % 32 !== 0) {
    throw new Error(`input ${index} control block length ${controlBlock.length} is invalid`);
  }
  const leafVersion = controlBlock[0]! & 0xfe;
  if (leafVersion !== 0xc0) throw new Error(`input ${index} unexpected leaf version ${leafVersion}`);
  const outputParity = controlBlock[0]! & 0x01;
  const internalKey = controlBlock.subarray(1, 33);

  const leafHash = taggedHash(
    'TapLeaf',
    Buffer.concat([Buffer.from([0xc0]), compactSize(leafScript.length), leafScript]),
  );
  let merkle = leafHash;
  for (let offset = 33; offset < controlBlock.length; offset += 32) {
    const node = controlBlock.subarray(offset, offset + 32);
    merkle =
      Buffer.compare(merkle, node) <= 0
        ? taggedHash('TapBranch', Buffer.concat([merkle, node]))
        : taggedHash('TapBranch', Buffer.concat([node, merkle]));
  }
  const tweak = taggedHash('TapTweak', Buffer.concat([internalKey, merkle]));
  const derived = ecc.xOnlyPointAddTweak(internalKey, tweak);
  if (!derived) throw new Error(`input ${index} taproot tweak failed`);
  if (!Buffer.from(derived.xOnlyPubkey).equals(outputKey)) {
    throw new Error(`input ${index} control block does not commit to the prevout output key`);
  }
  if (derived.parity !== outputParity) {
    throw new Error(`input ${index} control block parity bit is wrong`);
  }
  checks.push(
    `input ${index}: control block commits leaf to output key (merkle depth ${(controlBlock.length - 33) / 32})`,
  );

  const decompiled = bitcoin.script.decompile(leafScript);
  if (!decompiled) throw new Error(`input ${index} leaf script does not parse`);

  if (
    decompiled.length === 2 &&
    Buffer.isBuffer(decompiled[0]) &&
    decompiled[0].length === 32 &&
    decompiled[1] === bitcoin.opcodes.OP_CHECKSIG
  ) {
    executeSingleKeyLeaf(context, leafHash, decompiled[0], stack);
    return;
  }
  executeRecoveryLeaf(context, leafHash, decompiled, stack);
}

function executeSingleKeyLeaf(
  { tx, index, prevoutScripts, prevoutValues, checks }: InputContext,
  leafHash: Buffer,
  leafKey: Buffer,
  stack: Buffer[],
): void {
  if (stack.length !== 1) {
    throw new Error(`input ${index} pk() leaf expects exactly one witness element, got ${stack.length}`);
  }
  const { signature, hashType } = parseSchnorrSignature(stack[0]!, `input ${index} leaf`);
  const sighash = tx.hashForWitnessV1(index, prevoutScripts, prevoutValues, hashType, leafHash);
  if (!ecc.verifySchnorr(sighash, leafKey, signature)) {
    throw new Error(`input ${index} tapscript signature is invalid for leaf key`);
  }
  checks.push(`input ${index}: pk(${leafKey.toString('hex')}) OP_CHECKSIG satisfied`);
}

function executeRecoveryLeaf(
  { tx, index, prevoutScripts, prevoutValues, checks }: InputContext,
  leafHash: Buffer,
  decompiled: Array<number | Uint8Array>,
  stack: Buffer[],
): void {
  // Expected: <delay> OP_CSV OP_DROP <pk1> OP_CHECKSIG (<pkN> OP_CHECKSIGADD)* <k> OP_NUMEQUAL
  let cursor = 0;
  const delay = decodeScriptNum(decompiled[cursor], `input ${index} CSV delay`);
  cursor += 1;
  if (decompiled[cursor] !== bitcoin.opcodes.OP_CHECKSEQUENCEVERIFY) {
    throw new Error(`input ${index} expected OP_CHECKSEQUENCEVERIFY`);
  }
  cursor += 1;
  if (decompiled[cursor] !== bitcoin.opcodes.OP_DROP) {
    throw new Error(`input ${index} expected OP_DROP after CSV`);
  }
  cursor += 1;

  // BIP-112/BIP-68 semantics for a block-based relative delay.
  const sequence = tx.ins[index]!.sequence;
  if (tx.version < 2) throw new Error(`input ${index} CSV requires tx version >= 2`);
  if (sequence >= 0x80000000) throw new Error(`input ${index} sequence disables BIP-68`);
  if (sequence & 0x00400000) throw new Error(`input ${index} sequence uses time-based lock, script expects blocks`);
  if ((sequence & 0xffff) < delay) {
    throw new Error(`input ${index} sequence ${sequence & 0xffff} is below CSV delay ${delay}`);
  }
  checks.push(`input ${index}: CSV delay ${delay} blocks satisfied by sequence ${sequence}`);

  const keys: Buffer[] = [];
  while (cursor < decompiled.length && Buffer.isBuffer(decompiled[cursor])) {
    const key = decompiled[cursor] as Buffer;
    if (key.length !== 32) {
      if (keys.length > 0) break;
      throw new Error(`input ${index} unexpected non-key push in recovery leaf`);
    }
    const expectedOp = keys.length === 0 ? bitcoin.opcodes.OP_CHECKSIG : bitcoin.opcodes.OP_CHECKSIGADD;
    if (decompiled[cursor + 1] !== expectedOp) {
      throw new Error(`input ${index} recovery leaf key ${keys.length} not followed by expected opcode`);
    }
    keys.push(key);
    cursor += 2;
  }
  const threshold = decodeScriptNum(decompiled[cursor], `input ${index} threshold`);
  cursor += 1;
  if (decompiled[cursor] !== bitcoin.opcodes.OP_NUMEQUAL || cursor + 1 !== decompiled.length) {
    throw new Error(`input ${index} recovery leaf must end with <k> OP_NUMEQUAL`);
  }

  if (stack.length !== keys.length) {
    throw new Error(
      `input ${index} recovery witness has ${stack.length} elements for ${keys.length} keys`,
    );
  }
  // Initial stack bottom-to-top is stack[0..]; the signature consumed for
  // script key j (0-based) is stack[keys.length - 1 - j].
  let validCount = 0;
  keys.forEach((key, keyIndex) => {
    const signatureItem = stack[keys.length - 1 - keyIndex]!;
    if (signatureItem.length === 0) return;
    const { signature, hashType } = parseSchnorrSignature(
      signatureItem,
      `input ${index} recovery key ${keyIndex}`,
    );
    const sighash = tx.hashForWitnessV1(index, prevoutScripts, prevoutValues, hashType, leafHash);
    if (!ecc.verifySchnorr(sighash, key, signature)) {
      throw new Error(`input ${index} recovery signature for key ${keyIndex} is invalid (consensus failure)`);
    }
    validCount += 1;
  });
  if (validCount !== threshold) {
    throw new Error(
      `input ${index} recovery has ${validCount} valid signature(s), OP_NUMEQUAL requires exactly ${threshold}`,
    );
  }
  checks.push(`input ${index}: multi_a ${threshold}-of-${keys.length} satisfied with CSV ${delay}`);
}

function parseSchnorrSignature(
  item: Buffer,
  label: string,
): { signature: Buffer; hashType: number } {
  if (item.length === 64) return { signature: item, hashType: bitcoin.Transaction.SIGHASH_DEFAULT };
  if (item.length === 65) {
    const hashType = item[64]!;
    if (hashType === 0x00) throw new Error(`${label} 65-byte signature cannot use SIGHASH_DEFAULT`);
    return { signature: item.subarray(0, 64), hashType };
  }
  throw new Error(`${label} signature has invalid length ${item.length}`);
}

function decodeScriptNum(value: number | Uint8Array | undefined, label: string): number {
  if (typeof value === 'number') {
    // bitcoinjs decompile maps small numbers to OP_1..OP_16 opcodes.
    if (value >= bitcoin.opcodes.OP_1 && value <= bitcoin.opcodes.OP_16) {
      return value - bitcoin.opcodes.OP_1 + 1;
    }
    if (value === bitcoin.opcodes.OP_0) return 0;
    throw new Error(`${label} is not a script number`);
  }
  if (!(value instanceof Uint8Array) || value.length === 0 || value.length > 5) {
    throw new Error(`${label} is not a minimally encoded script number`);
  }
  return bitcoin.script.number.decode(Buffer.from(value));
}

function compactSize(length: number): Buffer {
  if (length > 0xfc) throw new Error('script too large for single-byte compact size');
  return Buffer.from([length]);
}

// Official BIP-327 KeyAgg test vectors (bitcoin/bips, bip-0327/vectors/
// key_agg_vectors.json). Proves the cooperative key-path aggregate is the
// standard MuSig2 KeyAgg any compliant wallet would compute.
const BIP327_PUBKEYS = [
  '02F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9',
  '03DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659',
  '023590A94E768F8E1815C2F24B4D80A8E3149316C3518CE7B7AD338368D038CA66',
];

const BIP327_VALID_CASES = [
  { keyIndices: [0, 1, 2], expected: '90539EEDE565F5D054F32CC0C220126889ED1E5D193BAF15AEF344FE59D4610C' },
  { keyIndices: [2, 1, 0], expected: '6204DE8B083426DC6EAF9502D27024D53FC826BF7D2012148A0575435DF54B2B' },
  { keyIndices: [0, 0, 0], expected: 'B436E3BAD62B8CD409969A224731C193D051162D8C5AE8B109306127DA3AA935' },
  { keyIndices: [0, 0, 1, 1], expected: '69BC22BFA5D106306E48A20679DE1D7389386124D07571D0D872686028C26A3E' },
];

export interface KeyAggVectorReport {
  passed: boolean;
  results: Array<{ keyIndices: number[]; expected: string; actual: string; ok: boolean }>;
}

export function runBip327KeyAggVectors(): KeyAggVectorReport {
  const results = BIP327_VALID_CASES.map(({ keyIndices, expected }) => {
    const pubkeys = keyIndices.map((keyIndex) => BIP327_PUBKEYS[keyIndex]!.toLowerCase());
    const actual = keyAgg(pubkeys).xonlyPubKeyHex;
    return {
      keyIndices,
      expected: expected.toLowerCase(),
      actual,
      ok: actual === expected.toLowerCase(),
    };
  });
  return { passed: results.every((item) => item.ok), results };
}
