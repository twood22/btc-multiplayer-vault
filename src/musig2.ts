import { randomBytes } from 'node:crypto';
import * as ecc from 'tiny-secp256k1';
import { SECP_ORDER as N, keyAgg, scalarToBuffer, taggedHash } from './crypto.js';
import type { Hex } from './types.js';

// Complete BIP-327 MuSig2: nonce generation/aggregation, tweaked key
// aggregation contexts, partial signing, partial-signature verification, and
// signature aggregation. Validated against the official BIP-327 test vectors
// in test/vectors (see runBip327ProtocolVectors in consensus.ts).
//
// Points are 33-byte compressed Buffers; the point at infinity is `null`
// (serialized as 33 zero bytes where BIP-327 allows it). Scalars are bigint
// mod n. All hash tags follow BIP-327 exactly.

type Point = Buffer | null;

const INFINITY_BYTES = Buffer.alloc(33);

function intFrom(buffer: Buffer): bigint {
  return BigInt(`0x${buffer.toString('hex') || '0'}`);
}

function mod(value: bigint): bigint {
  const result = value % N;
  return result >= 0n ? result : result + N;
}

function pointFromCompressed(bytes: Buffer, label: string): Buffer {
  if (bytes.length !== 33 || !ecc.isPoint(bytes)) {
    throw new Error(`${label}: invalid compressed point`);
  }
  return Buffer.from(bytes);
}

function pointFromCompressedExt(bytes: Buffer, label: string): Point {
  if (bytes.equals(INFINITY_BYTES)) return null;
  return pointFromCompressed(bytes, label);
}

function pointToBytesExt(point: Point): Buffer {
  return point ? Buffer.from(point) : Buffer.from(INFINITY_BYTES);
}

function pointAdd(a: Point, b: Point): Point {
  if (!a) return b ? Buffer.from(b) : null;
  if (!b) return Buffer.from(a);
  const sum = ecc.pointAdd(a, b, true);
  return sum ? Buffer.from(sum) : null;
}

function pointMultiply(point: Point, scalar: bigint): Point {
  const k = mod(scalar);
  if (!point || k === 0n) return null;
  const product = ecc.pointMultiply(point, scalarToBuffer(k), true);
  return product ? Buffer.from(product) : null;
}

function basePoint(scalar: bigint): Point {
  const k = mod(scalar);
  if (k === 0n) return null;
  const point = ecc.pointFromScalar(scalarToBuffer(k), true);
  return point ? Buffer.from(point) : null;
}

function negatePoint(point: Point): Point {
  if (!point) return null;
  const negated = Buffer.from(point);
  negated[0] = negated[0] === 0x02 ? 0x03 : 0x02;
  return negated;
}

function hasEvenY(point: Buffer): boolean {
  return point[0] === 0x02;
}

function xBytes(point: Buffer): Buffer {
  return Buffer.from(point.subarray(1));
}

// ---------------------------------------------------------------------------
// Key aggregation context (KeyAgg + ApplyTweak)

export interface KeyAggContext {
  /** Current aggregate point Q (never infinity). */
  q: Buffer;
  /** Accumulated negation factor gacc (1 or n-1 products, mod n). */
  gacc: bigint;
  /** Accumulated tweak tacc mod n. */
  tacc: bigint;
  /** The ordered pubkeys the context was created from (33-byte hex). */
  pubkeys: Hex[];
  /** Per-pubkey KeyAgg coefficients, aligned with `pubkeys`. */
  coefficients: bigint[];
}

export function keyAggContext(compressedPubkeysHex: Hex[]): KeyAggContext {
  const aggregated = keyAgg(compressedPubkeysHex);
  return {
    q: Buffer.from(aggregated.publicKeyHex, 'hex'),
    gacc: 1n,
    tacc: 0n,
    pubkeys: compressedPubkeysHex,
    coefficients: aggregated.aggregation.coefficients.map((hex) => BigInt(`0x${hex}`)),
  };
}

export function applyTweak(context: KeyAggContext, tweak: Buffer, isXonly: boolean): KeyAggContext {
  if (tweak.length !== 32) throw new Error('tweak must be 32 bytes');
  const t = intFrom(tweak);
  if (t >= N) throw new Error('The tweak must be less than n.');
  const g = isXonly && !hasEvenY(context.q) ? N - 1n : 1n;
  const gq = g === 1n ? context.q : negatePoint(context.q);
  const tweaked = pointAdd(gq, basePoint(t));
  if (!tweaked) throw new Error('The result of tweaking cannot be infinity.');
  return {
    q: tweaked,
    gacc: mod(g * context.gacc),
    tacc: mod(t + g * context.tacc),
    pubkeys: context.pubkeys,
    coefficients: context.coefficients,
  };
}

function keyAggCoeff(context: KeyAggContext, pubkeyHex: Hex): bigint {
  const index = context.pubkeys.indexOf(pubkeyHex);
  if (index === -1) throw new Error(`public key ${pubkeyHex} is not part of this aggregate`);
  return context.coefficients[index]!;
}

// ---------------------------------------------------------------------------
// Nonces

export interface GeneratedNonce {
  /** 97 bytes: k1 (32) || k2 (32) || signer pubkey (33). Single use! */
  secnonce: Buffer;
  /** 66 bytes: R1 (33) || R2 (33). Shared with the other signers. */
  pubnonce: Buffer;
}

/**
 * BIP-327 NonceGen. `rand` defaults to fresh CSPRNG output; it is a parameter
 * only so the official test vectors (which fix rand') can be replayed.
 * The secret nonce must be used at most once — reuse leaks the private key.
 */
export function nonceGen({
  secretKey,
  publicKey,
  aggregateXonly,
  message,
  extraIn,
  rand,
}: {
  secretKey?: Buffer | undefined;
  publicKey: Buffer;
  aggregateXonly?: Buffer | undefined;
  message?: Buffer | undefined;
  extraIn?: Buffer | undefined;
  rand?: Buffer | undefined;
}): GeneratedNonce {
  if (publicKey.length !== 33) throw new Error('publicKey must be 33 bytes');
  const randPrime = rand ?? randomBytes(32);
  if (randPrime.length !== 32) throw new Error('rand must be 32 bytes');
  let seed: Buffer;
  if (secretKey) {
    if (secretKey.length !== 32) throw new Error('secretKey must be 32 bytes');
    const auxHash = taggedHash('MuSig/aux', randPrime);
    seed = Buffer.from(secretKey.map((byte, index) => byte ^ auxHash[index]!));
  } else {
    seed = randPrime;
  }
  const aggpk = aggregateXonly ?? Buffer.alloc(0);
  const messagePrefixed =
    message === undefined
      ? Buffer.from([0x00])
      : Buffer.concat([Buffer.from([0x01]), uint64be(message.length), message]);
  const extra = extraIn ?? Buffer.alloc(0);

  const nonceScalar = (index: number): bigint => {
    const hash = taggedHash(
      'MuSig/nonce',
      Buffer.concat([
        seed,
        Buffer.from([publicKey.length]),
        publicKey,
        Buffer.from([aggpk.length]),
        aggpk,
        messagePrefixed,
        uint32be(extra.length),
        extra,
        Buffer.from([index]),
      ]),
    );
    return mod(intFrom(hash));
  };

  const k1 = nonceScalar(0);
  const k2 = nonceScalar(1);
  if (k1 === 0n || k2 === 0n) throw new Error('generated nonce scalar is zero');
  const r1 = basePoint(k1)!;
  const r2 = basePoint(k2)!;
  return {
    secnonce: Buffer.concat([scalarToBuffer(k1), scalarToBuffer(k2), publicKey]),
    pubnonce: Buffer.concat([r1, r2]),
  };
}

export function nonceAgg(pubnonces: Buffer[]): Buffer {
  const halves: Buffer[] = [];
  for (const j of [0, 1] as const) {
    let sum: Point = null;
    pubnonces.forEach((pubnonce, index) => {
      if (pubnonce.length !== 66) throw new Error(`pubnonce ${index} must be 66 bytes`);
      const half = pubnonce.subarray(j * 33, (j + 1) * 33);
      let point: Buffer;
      try {
        point = pointFromCompressed(Buffer.from(half), `pubnonce ${index} half ${j + 1}`);
      } catch (error) {
        // BIP-327 attributes invalid contributions to the offending signer.
        throw Object.assign(
          new Error(`invalid pubnonce from signer ${index}: ${(error as Error).message}`),
          { signer: index },
        );
      }
      sum = pointAdd(sum, point);
    });
    halves.push(pointToBytesExt(sum));
  }
  return Buffer.concat(halves);
}

// ---------------------------------------------------------------------------
// Session

export interface SessionContext {
  aggnonce: Buffer;
  pubkeys: Hex[];
  tweaks: Buffer[];
  isXonly: boolean[];
  message: Buffer;
}

interface SessionValues {
  context: KeyAggContext;
  b: bigint;
  r: Buffer;
  e: bigint;
}

function sessionValues(session: SessionContext): SessionValues {
  if (session.aggnonce.length !== 66) throw new Error('aggnonce must be 66 bytes');
  let context = keyAggContext(session.pubkeys);
  session.tweaks.forEach((tweak, index) => {
    context = applyTweak(context, tweak, session.isXonly[index]!);
  });
  const b = mod(
    intFrom(
      taggedHash(
        'MuSig/noncecoef',
        Buffer.concat([session.aggnonce, xBytes(context.q), session.message]),
      ),
    ),
  );
  const r1 = pointFromCompressedExt(Buffer.from(session.aggnonce.subarray(0, 33)), 'aggnonce R1');
  const r2 = pointFromCompressedExt(Buffer.from(session.aggnonce.subarray(33, 66)), 'aggnonce R2');
  const rPrime = pointAdd(r1, pointMultiply(r2, b));
  const r = rPrime ?? basePoint(1n)!;
  const e = mod(
    intFrom(
      taggedHash(
        'BIP0340/challenge',
        Buffer.concat([xBytes(r), xBytes(context.q), session.message]),
      ),
    ),
  );
  return { context, b, r, e };
}

// ---------------------------------------------------------------------------
// Partial signatures

export function sign(secnonce: Buffer, secretKey: Buffer, session: SessionContext): Buffer {
  if (secnonce.length !== 97) throw new Error('secnonce must be 97 bytes');
  const { context, b, r, e } = sessionValues(session);
  const k1Prime = intFrom(Buffer.from(secnonce.subarray(0, 32)));
  const k2Prime = intFrom(Buffer.from(secnonce.subarray(32, 64)));
  if (k1Prime === 0n || k1Prime >= N || k2Prime === 0n || k2Prime >= N) {
    throw new Error('secnonce scalar out of range');
  }
  const k1 = hasEvenY(r) ? k1Prime : N - k1Prime;
  const k2 = hasEvenY(r) ? k2Prime : N - k2Prime;
  const dPrime = intFrom(secretKey);
  if (dPrime === 0n || dPrime >= N) throw new Error('secret key out of range');
  const point = basePoint(dPrime)!;
  const secnoncePubkey = Buffer.from(secnonce.subarray(64, 97));
  if (!point.equals(secnoncePubkey)) {
    throw new Error('secnonce was generated for a different signing key');
  }
  const a = keyAggCoeff(context, point.toString('hex'));
  const g = hasEvenY(context.q) ? 1n : N - 1n;
  const d = mod(g * context.gacc * dPrime);
  const s = mod(k1 + b * k2 + e * a * d);
  const partialSig = scalarToBuffer(s);
  // Belt and braces: verify our own partial signature before returning it.
  const pubnonce = Buffer.concat([basePoint(k1Prime)!, basePoint(k2Prime)!]);
  if (!partialSigVerifyInternal(partialSig, pubnonce, point, session)) {
    throw new Error('own partial signature failed verification');
  }
  return partialSig;
}

export function partialSigVerify(
  partialSig: Buffer,
  pubnonces: Buffer[],
  session: SessionContext,
  signerIndex: number,
): boolean {
  const pubnonce = pubnonces[signerIndex];
  const pubkeyHex = session.pubkeys[signerIndex];
  if (!pubnonce || !pubkeyHex) throw new Error(`no signer at index ${signerIndex}`);
  return partialSigVerifyInternal(
    partialSig,
    pubnonce,
    Buffer.from(pubkeyHex, 'hex'),
    session,
  );
}

function partialSigVerifyInternal(
  partialSig: Buffer,
  pubnonce: Buffer,
  publicKey: Buffer,
  session: SessionContext,
): boolean {
  try {
    const { context, b, r, e } = sessionValues(session);
    const s = intFrom(partialSig);
    if (s >= N) return false;
    const r1 = pointFromCompressed(Buffer.from(pubnonce.subarray(0, 33)), 'pubnonce R1');
    const r2 = pointFromCompressed(Buffer.from(pubnonce.subarray(33, 66)), 'pubnonce R2');
    let re = pointAdd(r1, pointMultiply(r2, b));
    if (!hasEvenY(r)) re = negatePoint(re);
    const point = pointFromCompressed(publicKey, 'signer pubkey');
    const a = keyAggCoeff(context, point.toString('hex'));
    const g = hasEvenY(context.q) ? 1n : N - 1n;
    const gPrime = mod(g * context.gacc);
    const lhs = basePoint(s);
    const rhs = pointAdd(re, pointMultiply(point, mod(e * a * gPrime)));
    if (!lhs || !rhs) return lhs === rhs;
    return lhs.equals(rhs);
  } catch {
    return false;
  }
}

export function partialSigAgg(partialSigs: Buffer[], session: SessionContext): Buffer {
  const { context, r, e } = sessionValues(session);
  let s = 0n;
  partialSigs.forEach((partialSig, index) => {
    const value = intFrom(partialSig);
    if (value >= N) {
      throw Object.assign(new Error(`invalid partial signature from signer ${index}`), {
        signer: index,
      });
    }
    s = mod(s + value);
  });
  const g = hasEvenY(context.q) ? 1n : N - 1n;
  s = mod(s + e * g * context.tacc);
  return Buffer.concat([xBytes(r), scalarToBuffer(s)]);
}

// ---------------------------------------------------------------------------

function uint32be(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function uint64be(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value), 0);
  return buffer;
}
