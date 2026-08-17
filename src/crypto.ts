import { Buffer } from 'buffer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hmac } from '@noble/hashes/hmac.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { BITCOIN_NETWORK } from './network.js';
import type { Hex, KeyAggResult, KeyAggregation, Keypair, TapLeaf } from './types.js';

bitcoin.initEccLib(ecc);

export const SECP_ORDER = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
);

export function sha256Hex(value: string | Buffer): Hex {
  return Buffer.from(sha256(bytes(value))).toString('hex');
}

export function taggedHash(tag: string, value: Buffer): Buffer {
  const tagHash = Buffer.from(sha256(utf8ToBytes(tag)));
  return Buffer.from(sha256(Buffer.concat([tagHash, tagHash, value])));
}

export function taggedHashHex(tag: string, value: Buffer): Hex {
  return taggedHash(tag, value).toString('hex');
}

export function hmacHex(key: string | Buffer, value: string | Buffer): Hex {
  return Buffer.from(hmac(sha256, bytes(key), bytes(value))).toString('hex');
}

export function deterministicKeypair(seed: string, label: string): Keypair {
  let counter = 0;
  while (true) {
    const priv = Buffer.from(sha256(utf8ToBytes(`${seed}:${label}:${counter}`)));
    const scalar = BigInt(`0x${priv.toString('hex')}`);
    if (scalar > 0n && scalar < SECP_ORDER) {
      try {
        const compressed = Buffer.from(secp256k1.getPublicKey(priv, true));
        return {
          privateKeyHex: priv.toString('hex'),
          publicKeyHex: compressed.toString('hex'),
          xonlyPubKeyHex: compressed.subarray(1).toString('hex'),
        };
      } catch {
        counter += 1;
      }
    }
    counter += 1;
  }
}

export function taprootAddress(xonlyPubKeyHex: Hex): string {
  const { address } = bitcoin.payments.p2tr({
    internalPubkey: Buffer.from(xonlyPubKeyHex, 'hex'),
    network: BITCOIN_NETWORK,
  });
  if (!address) throw new Error('failed to derive taproot address');
  return address;
}

// BIP-327 KeySort: lexicographic order of 33-byte compressed pubkeys.
export function keySort(compressedPubkeysHex: Hex[]): Hex[] {
  return [...compressedPubkeysHex].sort();
}

// BIP-327 KeyAgg over 33-byte compressed pubkeys, in the order given.
// Callers that need a canonical aggregate should pass keySort(...) output.
export function keyAgg(compressedPubkeysHex: Hex[]): KeyAggResult {
  if (compressedPubkeysHex.length === 0) {
    throw new Error('cannot aggregate an empty public key set');
  }
  const pubkeyBuffers = compressedPubkeysHex.map((hex) => {
    const buffer = Buffer.from(hex, 'hex');
    if (buffer.length !== 33 || (buffer[0] !== 0x02 && buffer[0] !== 0x03)) {
      throw new Error(`invalid compressed public key ${hex}`);
    }
    if (!ecc.isPoint(buffer)) {
      throw new Error(`public key is not on the curve: ${hex}`);
    }
    return buffer;
  });

  const keyAggList = taggedHash('KeyAgg list', Buffer.concat(pubkeyBuffers));
  const first = pubkeyBuffers[0]!;
  const second = pubkeyBuffers.find((buffer) => !buffer.equals(first)) ?? null;

  const coefficients = pubkeyBuffers.map((buffer) => {
    if (second && buffer.equals(second)) return 1n;
    const hash = taggedHash('KeyAgg coefficient', Buffer.concat([keyAggList, buffer]));
    const value = BigInt(`0x${hash.toString('hex')}`) % SECP_ORDER;
    if (value === 0n) throw new Error('invalid zero KeyAgg coefficient');
    return value;
  });

  let aggregate: Buffer | null = null;
  pubkeyBuffers.forEach((buffer, index) => {
    const coefficient = coefficients[index]!;
    const weighted =
      coefficient === 1n
        ? buffer
        : ecc.pointMultiply(buffer, scalarToBuffer(coefficient), true);
    if (!weighted) throw new Error('failed to weight KeyAgg public key');
    if (aggregate) {
      const added = ecc.pointAdd(aggregate, Buffer.from(weighted), true);
      if (!added) throw new Error('KeyAgg aggregate is the point at infinity');
      aggregate = Buffer.from(added);
    } else {
      aggregate = Buffer.from(weighted);
    }
  });
  const aggregateBuffer: Buffer = aggregate!;

  return {
    publicKeyHex: aggregateBuffer.toString('hex'),
    xonlyPubKeyHex: aggregateBuffer.subarray(1).toString('hex'),
    aggregation: {
      type: 'BIP327-KeyAgg',
      compressedPubkeys: compressedPubkeysHex,
      coefficients: coefficients.map((value) => scalarToBuffer(value).toString('hex')),
      hasEvenY: aggregateBuffer[0] === 0x02,
    },
  };
}

// Demo-only helper: with every participant secret available locally, the
// BIP-327 aggregate secret is sum(coefficient_i * d_i) mod n. A production
// wallet must never do this — it requires all private keys in one place.
// It exists so the demo can produce a consensus-valid key-path signature
// that verifies against the standard BIP-327 aggregate key.
export function keyAggSecret(
  aggregation: KeyAggregation,
  privateKeysByPubkeyHex: Record<Hex, Hex>,
): Buffer {
  let sum = 0n;
  aggregation.compressedPubkeys.forEach((pubkeyHex, index) => {
    const privateKeyHex = privateKeysByPubkeyHex[pubkeyHex];
    if (!privateKeyHex) throw new Error(`missing private key for ${pubkeyHex}`);
    const d = BigInt(`0x${privateKeyHex}`);
    const c = BigInt(`0x${aggregation.coefficients[index]!}`);
    sum = (sum + c * d) % SECP_ORDER;
  });
  if (sum === 0n) throw new Error('aggregate secret is zero');
  if (!aggregation.hasEvenY) sum = SECP_ORDER - sum;
  return scalarToBuffer(sum);
}

export function scalarToBuffer(value: bigint): Buffer {
  const normalized = ((value % SECP_ORDER) + SECP_ORDER) % SECP_ORDER;
  return Buffer.from(normalized.toString(16).padStart(64, '0'), 'hex');
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58CheckDecode(value: string): Buffer {
  let acc = 0n;
  for (const char of value) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) throw new Error(`invalid base58 character ${char}`);
    acc = acc * 58n + BigInt(digit);
  }
  let hex = acc.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  let payload = Buffer.from(hex, 'hex');
  let leadingZeros = 0;
  for (const char of value) {
    if (char !== '1') break;
    leadingZeros += 1;
  }
  payload = Buffer.concat([Buffer.alloc(leadingZeros), payload]);
  const checksum = payload.subarray(-4);
  const data = payload.subarray(0, -4);
  const expected = Buffer.from(sha256(sha256(data))).subarray(0, 4);
  if (!checksum.equals(expected)) throw new Error('base58 checksum mismatch');
  return data;
}

export function base58CheckEncode(data: Buffer): string {
  const checksum = Buffer.from(sha256(sha256(data))).subarray(0, 4);
  const payload = Buffer.concat([data, checksum]);
  let acc = BigInt(`0x${payload.toString('hex')}`);
  let encoded = '';
  while (acc > 0n) {
    encoded = BASE58_ALPHABET[Number(acc % 58n)] + encoded;
    acc /= 58n;
  }
  for (const byte of payload) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded;
}

// The xpub's own root public key (x-only). For a Sigbash key this is the
// untweaked MuSig2 aggregate — the key that signs a tapscript-leaf input.
export function xpubRootXonly(xpubBase58: string): Hex {
  const data = base58CheckDecode(xpubBase58.replace(/^\[[0-9a-fA-F/h']*\]/, ''));
  if (data.length !== 78) throw new Error('invalid extended public key length');
  return data.subarray(46, 78).toString('hex');
}

export function tapLeafHash(script: Buffer, leafVersion = 0xc0): Buffer {
  if (script.length > 0xfc) throw new Error('script too large for single-byte compact size');
  return taggedHash(
    'TapLeaf',
    Buffer.concat([Buffer.from([leafVersion]), Buffer.from([script.length]), script]),
  );
}

// Master fingerprint for BIP-371 derivation fields: prefer the BIP-380 key
// origin prefix ([fingerprint]xpub...); otherwise, for a depth-0 xpub, the
// fingerprint is hash160 of its own public key.
export function xpubMasterFingerprint(xpubBase58: string): Buffer {
  const origin = xpubBase58.match(/^\[([0-9a-fA-F]{8})/);
  if (origin) return Buffer.from(origin[1]!, 'hex');
  const data = base58CheckDecode(xpubBase58.replace(/^\[[0-9a-fA-F/h']*\]/, ''));
  if (data.length !== 78) throw new Error('invalid extended public key length');
  if (data[4] !== 0) {
    throw new Error('xpub has no key origin prefix and is not a master key; cannot derive fingerprint');
  }
  const pubkey = data.subarray(45, 78);
  const hashed = sha256(pubkey);
  return Buffer.from(ripemd160(hashed)).subarray(0, 4);
}

// Non-hardened BIP32 public derivation, used to derive the Sigbash tapscript
// leaf key from the BIP-328 xpub returned by createKey() (child path 0/0 by
// default, matching the SDK's tr(SIGBASH_XPUB/0/*) descriptor convention).
export function deriveXpubChildPubkey(
  xpubBase58: string,
  path: number[] = [0, 0],
): { publicKeyHex: Hex; xonlyPubKeyHex: Hex } {
  // Sigbash returns the xpub with a BIP-380 key-origin prefix: [fingerprint]xpub...
  const stripped = xpubBase58.replace(/^\[[0-9a-fA-F/h']*\]/, '');
  const data = base58CheckDecode(stripped);
  if (data.length !== 78) throw new Error('invalid extended public key length');
  let chainCode: Buffer = Buffer.from(data.subarray(13, 45));
  let publicKey: Buffer = Buffer.from(data.subarray(45, 78));
  for (const index of path) {
    if (index >= 0x80000000) throw new Error('cannot derive hardened child from xpub');
    const indexBuffer = Buffer.alloc(4);
    indexBuffer.writeUInt32BE(index, 0);
    const i = Buffer.from(hmac(
      sha512,
      chainCode,
      Buffer.concat([publicKey, indexBuffer]),
    ));
    const tweak = i.subarray(0, 32);
    const child = ecc.pointAddScalar(publicKey, tweak, true);
    if (!child) throw new Error('invalid BIP32 child derivation');
    publicKey = Buffer.from(child);
    chainCode = Buffer.from(i.subarray(32));
  }
  return {
    publicKeyHex: publicKey.toString('hex'),
    xonlyPubKeyHex: publicKey.subarray(1).toString('hex'),
  };
}

function bytes(value: string | Buffer): Uint8Array {
  return typeof value === 'string' ? utf8ToBytes(value) : value;
}

export interface VaultTaproot {
  address: string;
  outputScriptHex: Hex;
  tapInternalKey: Hex;
  tapMerkleRoot: Hex;
  tapLeaves: TapLeaf[];
}

type TapTreeNode = { output: Buffer } | [TapTreeNode, TapTreeNode];

type P2trScriptTree = NonNullable<Parameters<typeof bitcoin.payments.p2tr>[0]>['scriptTree'];

export function buildVaultTaproot({
  internalXonlyPubkey,
  soloLeafPubkeys,
  recoveryDelayBlocks,
  recoveryXonlyPubkeys,
}: {
  internalXonlyPubkey: Hex;
  soloLeafPubkeys: Array<{
    participantId: string;
    xonlyPubkey: Hex;
    identificationXonlyPubkey: Hex;
  }>;
  recoveryDelayBlocks: number;
  recoveryXonlyPubkeys: Hex[];
}): VaultTaproot {
  const pkScriptHex = (xonlyPubkey: Hex): Hex =>
    Buffer.from(
      bitcoin.script.compile([Buffer.from(xonlyPubkey, 'hex'), bitcoin.opcodes.OP_CHECKSIG]),
    ).toString('hex');
  // Dual-leaf Sigbash structure (live-verified, see REVIEW.md): per
  // participant/round the tree carries a policy-spend leaf pk(child 0/0)
  // that solo signing uses, plus an identification-only leaf
  // pk(internal root) that live Sigbash needs to recognize the input.
  const soloLeaves = soloLeafPubkeys.flatMap(
    ({ participantId, xonlyPubkey, identificationXonlyPubkey }) => {
      if (xonlyPubkey === identificationXonlyPubkey) {
        throw new Error(
          `${participantId}: identification leaf key must differ from the policy-spend leaf key`,
        );
      }
      return [
        {
          type: 'solo-withdrawal' as const,
          role: 'policy-spend' as const,
          participantId,
          sigbashXonlyPubkey: xonlyPubkey,
          scriptHex: pkScriptHex(xonlyPubkey),
        },
        {
          type: 'sigbash-identification' as const,
          role: 'identification-only' as const,
          participantId,
          internalRootXonlyPubkey: identificationXonlyPubkey,
          scriptHex: pkScriptHex(identificationXonlyPubkey),
        },
      ];
    },
  );
  const recoveryThreshold = Math.max(1, recoveryXonlyPubkeys.length - 1);
  const sortedRecoveryPubkeys = [...recoveryXonlyPubkeys].sort();
  const recoveryScript = bitcoin.script.compile([
    bitcoin.script.number.encode(recoveryDelayBlocks),
    bitcoin.opcodes.OP_CHECKSEQUENCEVERIFY,
    bitcoin.opcodes.OP_DROP,
    ...recoveryThresholdScript(sortedRecoveryPubkeys, recoveryThreshold),
  ]);
  const recoveryLeaf = {
    type: 'timelocked-recovery' as const,
    relativeBlocks: recoveryDelayBlocks,
    threshold: recoveryThreshold,
    recoveryXonlyPubkeys: sortedRecoveryPubkeys,
    scriptHex: Buffer.from(recoveryScript).toString('hex'),
  };
  const leaves = [...soloLeaves, recoveryLeaf];
  const scriptTree = toBinaryTapTree(
    leaves.map((leaf) => ({ output: Buffer.from(leaf.scriptHex, 'hex') })),
  );
  const payment = bitcoin.payments.p2tr({
    internalPubkey: Buffer.from(internalXonlyPubkey, 'hex'),
    // bitcoinjs' Taptree is the same recursive leaf/[left,right] shape our
    // builder produces, but it is typed as a branded tuple.
    scriptTree: scriptTree as P2trScriptTree,
    network: BITCOIN_NETWORK,
  });
  if (!payment.address || !payment.output || !payment.hash) {
    throw new Error('failed to build vault taproot payment');
  }

  const leavesWithControlBlocks: TapLeaf[] = leaves.map((leaf) => {
    const leafPayment = bitcoin.payments.p2tr({
      internalPubkey: Buffer.from(internalXonlyPubkey, 'hex'),
      scriptTree: scriptTree as P2trScriptTree,
      redeem: { output: Buffer.from(leaf.scriptHex, 'hex') },
      network: BITCOIN_NETWORK,
    });
    const controlBlock = leafPayment.witness?.at(-1);
    if (!controlBlock) throw new Error('failed to derive tapleaf control block');
    return {
      ...leaf,
      controlBlockHex: Buffer.from(controlBlock).toString('hex'),
    };
  });

  return {
    address: payment.address,
    outputScriptHex: Buffer.from(payment.output).toString('hex'),
    tapInternalKey: internalXonlyPubkey,
    tapMerkleRoot: Buffer.from(payment.hash).toString('hex'),
    tapLeaves: leavesWithControlBlocks,
  };
}

// multi_a-style threshold: keys must already be in final script order.
function recoveryThresholdScript(
  xonlyPubkeys: Hex[],
  threshold: number,
): Array<Uint8Array | number> {
  const script: Array<Uint8Array | number> = [];
  xonlyPubkeys.forEach((pubkey, index) => {
    script.push(Buffer.from(pubkey, 'hex'));
    script.push(index === 0 ? bitcoin.opcodes.OP_CHECKSIG : bitcoin.opcodes.OP_CHECKSIGADD);
  });
  script.push(bitcoin.script.number.encode(threshold));
  script.push(bitcoin.opcodes.OP_NUMEQUAL);
  return script;
}

function toBinaryTapTree(leaves: Array<{ output: Buffer }>): TapTreeNode {
  if (leaves.length === 1) return leaves[0]!;
  if (leaves.length === 2) return [leaves[0]!, leaves[1]!];
  const midpoint = Math.ceil(leaves.length / 2);
  return [toBinaryTapTree(leaves.slice(0, midpoint)), toBinaryTapTree(leaves.slice(midpoint))];
}
