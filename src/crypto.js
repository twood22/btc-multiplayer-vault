import { createECDH, createHash, createHmac } from 'node:crypto';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';

bitcoin.initEccLib(ecc);

export const SECP_ORDER = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
);

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function taggedHash(tag, value) {
  const tagHash = createHash('sha256').update(tag).digest();
  return createHash('sha256').update(tagHash).update(tagHash).update(value).digest();
}

export function taggedHashHex(tag, value) {
  return taggedHash(tag, value).toString('hex');
}

export function hmacHex(key, value) {
  return createHmac('sha256', key).update(value).digest('hex');
}

export function deterministicKeypair(seed, label) {
  let counter = 0;
  while (true) {
    const priv = createHash('sha256')
      .update(`${seed}:${label}:${counter}`)
      .digest();
    const scalar = BigInt(`0x${priv.toString('hex')}`);
    if (scalar > 0n && scalar < SECP_ORDER) {
      try {
        const ecdh = createECDH('secp256k1');
        ecdh.setPrivateKey(priv);
        const compressed = ecdh.getPublicKey(null, 'compressed');
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

export function taprootAddress(xonlyPubKeyHex) {
  return bitcoin.payments.p2tr({
    internalPubkey: Buffer.from(xonlyPubKeyHex, 'hex'),
    network: bitcoin.networks.testnet,
  }).address;
}

// BIP-327 KeySort: lexicographic order of 33-byte compressed pubkeys.
export function keySort(compressedPubkeysHex) {
  return [...compressedPubkeysHex].sort();
}

// BIP-327 KeyAgg over 33-byte compressed pubkeys, in the order given.
// Callers that need a canonical aggregate should pass keySort(...) output.
export function keyAgg(compressedPubkeysHex) {
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
  const first = pubkeyBuffers[0];
  const second = pubkeyBuffers.find((buffer) => !buffer.equals(first)) || null;

  const coefficients = pubkeyBuffers.map((buffer) => {
    if (second && buffer.equals(second)) return 1n;
    const hash = taggedHash('KeyAgg coefficient', Buffer.concat([keyAggList, buffer]));
    const value = BigInt(`0x${hash.toString('hex')}`) % SECP_ORDER;
    if (value === 0n) throw new Error('invalid zero KeyAgg coefficient');
    return value;
  });

  let aggregate = null;
  pubkeyBuffers.forEach((buffer, index) => {
    const weighted =
      coefficients[index] === 1n
        ? buffer
        : ecc.pointMultiply(buffer, scalarToBuffer(coefficients[index]), true);
    if (!weighted) throw new Error('failed to weight KeyAgg public key');
    if (aggregate) {
      const added = ecc.pointAdd(aggregate, Buffer.from(weighted), true);
      if (!added) throw new Error('KeyAgg aggregate is the point at infinity');
      aggregate = Buffer.from(added);
    } else {
      aggregate = Buffer.from(weighted);
    }
  });

  return {
    publicKeyHex: aggregate.toString('hex'),
    xonlyPubKeyHex: aggregate.subarray(1).toString('hex'),
    aggregation: {
      type: 'BIP327-KeyAgg',
      compressedPubkeys: compressedPubkeysHex,
      coefficients: coefficients.map((value) => scalarToBuffer(value).toString('hex')),
      hasEvenY: aggregate[0] === 0x02,
    },
  };
}

// Demo-only helper: with every participant secret available locally, the
// BIP-327 aggregate secret is sum(coefficient_i * d_i) mod n. A production
// wallet must never do this — it requires all private keys in one place.
// It exists so the demo can produce a consensus-valid key-path signature
// that verifies against the standard BIP-327 aggregate key.
export function keyAggSecret(aggregation, privateKeysByPubkeyHex) {
  let sum = 0n;
  aggregation.compressedPubkeys.forEach((pubkeyHex, index) => {
    const privateKeyHex = privateKeysByPubkeyHex[pubkeyHex];
    if (!privateKeyHex) throw new Error(`missing private key for ${pubkeyHex}`);
    const d = BigInt(`0x${privateKeyHex}`);
    const c = BigInt(`0x${aggregation.coefficients[index]}`);
    sum = (sum + c * d) % SECP_ORDER;
  });
  if (sum === 0n) throw new Error('aggregate secret is zero');
  if (!aggregation.hasEvenY) sum = SECP_ORDER - sum;
  return scalarToBuffer(sum);
}

export function scalarToBuffer(value) {
  const normalized = ((value % SECP_ORDER) + SECP_ORDER) % SECP_ORDER;
  return Buffer.from(normalized.toString(16).padStart(64, '0'), 'hex');
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58CheckDecode(value) {
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
  const expected = createHash('sha256')
    .update(createHash('sha256').update(data).digest())
    .digest()
    .subarray(0, 4);
  if (!checksum.equals(expected)) throw new Error('base58 checksum mismatch');
  return data;
}

// Non-hardened BIP32 public derivation, used to derive the Sigbash tapscript
// leaf key from the BIP-328 xpub returned by createKey() (child path 0/0 by
// default, matching the SDK's tr(SIGBASH_XPUB/0/*) descriptor convention).
export function deriveXpubChildPubkey(xpubBase58, path = [0, 0]) {
  const data = base58CheckDecode(xpubBase58);
  if (data.length !== 78) throw new Error('invalid extended public key length');
  let chainCode = data.subarray(13, 45);
  let publicKey = Buffer.from(data.subarray(45, 78));
  for (const index of path) {
    if (index >= 0x80000000) throw new Error('cannot derive hardened child from xpub');
    const indexBuffer = Buffer.alloc(4);
    indexBuffer.writeUInt32BE(index, 0);
    const i = createHmac('sha512', chainCode)
      .update(Buffer.concat([publicKey, indexBuffer]))
      .digest();
    const tweak = i.subarray(0, 32);
    const child = ecc.pointAddScalar(publicKey, tweak, true);
    if (!child) throw new Error('invalid BIP32 child derivation');
    publicKey = Buffer.from(child);
    chainCode = i.subarray(32);
  }
  return {
    publicKeyHex: publicKey.toString('hex'),
    xonlyPubKeyHex: publicKey.subarray(1).toString('hex'),
  };
}

export function buildVaultTaproot({
  internalXonlyPubkey,
  soloLeafPubkeys,
  recoveryDelayBlocks,
  recoveryXonlyPubkeys,
}) {
  const soloLeaves = soloLeafPubkeys.map(({ participantId, xonlyPubkey }) => ({
    type: 'solo-withdrawal',
    participantId,
    sigbashXonlyPubkey: xonlyPubkey,
    scriptHex: Buffer.from(
      bitcoin.script.compile([Buffer.from(xonlyPubkey, 'hex'), bitcoin.opcodes.OP_CHECKSIG]),
    ).toString('hex'),
  }));
  const recoveryThreshold = Math.max(1, recoveryXonlyPubkeys.length - 1);
  const sortedRecoveryPubkeys = [...recoveryXonlyPubkeys].sort();
  const recoveryScript = bitcoin.script.compile([
    bitcoin.script.number.encode(recoveryDelayBlocks),
    bitcoin.opcodes.OP_CHECKSEQUENCEVERIFY,
    bitcoin.opcodes.OP_DROP,
    ...recoveryThresholdScript(sortedRecoveryPubkeys, recoveryThreshold),
  ]);
  const recoveryLeaf = {
    type: 'timelocked-recovery',
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
    scriptTree,
    network: bitcoin.networks.testnet,
  });

  const leavesWithControlBlocks = leaves.map((leaf) => {
    const leafPayment = bitcoin.payments.p2tr({
      internalPubkey: Buffer.from(internalXonlyPubkey, 'hex'),
      scriptTree,
      redeem: { output: Buffer.from(leaf.scriptHex, 'hex') },
      network: bitcoin.networks.testnet,
    });
    return {
      ...leaf,
      controlBlockHex: Buffer.from(leafPayment.witness.at(-1)).toString('hex'),
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
function recoveryThresholdScript(xonlyPubkeys, threshold) {
  const script = [];
  xonlyPubkeys.forEach((pubkey, index) => {
    script.push(Buffer.from(pubkey, 'hex'));
    script.push(index === 0 ? bitcoin.opcodes.OP_CHECKSIG : bitcoin.opcodes.OP_CHECKSIGADD);
  });
  script.push(bitcoin.script.number.encode(threshold));
  script.push(bitcoin.opcodes.OP_NUMEQUAL);
  return script;
}

function toBinaryTapTree(leaves) {
  if (leaves.length === 1) return leaves[0];
  if (leaves.length === 2) return leaves;
  const midpoint = Math.ceil(leaves.length / 2);
  return [toBinaryTapTree(leaves.slice(0, midpoint)), toBinaryTapTree(leaves.slice(midpoint))];
}
