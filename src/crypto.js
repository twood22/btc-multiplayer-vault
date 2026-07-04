import { createECDH, createHash, createHmac } from 'node:crypto';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';

bitcoin.initEccLib(ecc);

const SECP_ORDER = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
);
const BECH32M_CONST = 0x2bc830a3;
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function taggedHashHex(tag, value) {
  const tagHash = createHash('sha256').update(tag).digest();
  return createHash('sha256')
    .update(tagHash)
    .update(tagHash)
    .update(value)
    .digest('hex');
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

export function aggregateXonlyPubkeys(pubkeys) {
  const sorted = [...pubkeys].sort();
  return taggedHashHex('VaultMuSig2DemoAggregate', Buffer.from(sorted.join(''), 'hex')).slice(
    0,
    64,
  );
}

export function taprootAddress(xonlyPubKeyHex, hrp = 'tb') {
  if (hrp === 'tb') {
    return bitcoin.payments.p2tr({
      internalPubkey: Buffer.from(xonlyPubKeyHex, 'hex'),
      network: bitcoin.networks.testnet,
    }).address;
  }
  const program = Buffer.from(xonlyPubKeyHex, 'hex');
  return bech32mEncode(hrp, [1, ...convertBits([...program], 8, 5, true)]);
}

export function aggregateCompressedPubkeys(pubkeys) {
  if (pubkeys.length === 0) throw new Error('cannot aggregate an empty public key set');
  if (pubkeys.length === 1) {
    const publicKeyHex = pubkeys[0];
    return {
      publicKeyHex,
      xonlyPubKeyHex: Buffer.from(publicKeyHex, 'hex').subarray(1).toString('hex'),
      aggregation: {
        type: 'single-key',
        sortedXonlyPubkeys: [Buffer.from(publicKeyHex, 'hex').subarray(1).toString('hex')],
        secondUniqueXonlyPubkey: null,
        keyAggListHash: null,
      },
    };
  }

  const xonlyPubkeys = pubkeys.map((pubkey) => Buffer.from(pubkey, 'hex').subarray(1).toString('hex'));
  const sortedXonly = [...xonlyPubkeys].sort();
  const keyAggList = Buffer.from(taggedHashHex('KeyAgg list', Buffer.from(sortedXonly.join(''), 'hex')), 'hex');
  const secondUnique = sortedXonly.find((pubkey) => pubkey !== sortedXonly[0]) || null;

  let aggregate = null;
  for (const xonlyPubkey of sortedXonly) {
    const coefficient = xonlyPubkey === secondUnique
      ? Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex')
      : coefficientScalar(keyAggList, xonlyPubkey);
    const point = Buffer.from(`02${xonlyPubkey}`, 'hex');
    const weighted = ecc.pointMultiply(point, coefficient, true);
    if (!weighted) throw new Error('failed to weight MuSig2 public key');
    if (aggregate) {
      const added = ecc.pointAdd(aggregate, Buffer.from(weighted), true);
      if (!added) throw new Error('failed to aggregate MuSig2 public keys');
      aggregate = Buffer.from(added);
    } else {
      aggregate = Buffer.from(weighted);
    }
  }
  return {
    publicKeyHex: aggregate.toString('hex'),
    xonlyPubKeyHex: Buffer.from(ecc.xOnlyPointFromPoint(aggregate)).toString('hex'),
    aggregation: {
      type: 'BIP327-keyagg',
      sortedXonlyPubkeys: sortedXonly,
      secondUniqueXonlyPubkey: secondUnique,
      keyAggListHash: keyAggList.toString('hex'),
    },
  };
}

function coefficientScalar(keyAggList, xonlyPubkey) {
  const hash = taggedHashHex(
    'KeyAgg coefficient',
    Buffer.concat([keyAggList, Buffer.from(xonlyPubkey, 'hex')]),
  );
  const value = BigInt(`0x${hash}`) % SECP_ORDER;
  if (value === 0n) throw new Error('invalid zero MuSig2 key aggregation coefficient');
  return bigintToBuffer32(value);
}

function bigintToBuffer32(value) {
  return Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
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
  const recoveryScript = bitcoin.script.compile([
    bitcoin.script.number.encode(recoveryDelayBlocks),
    bitcoin.opcodes.OP_CHECKSEQUENCEVERIFY,
    bitcoin.opcodes.OP_DROP,
    ...recoveryThresholdScript(recoveryXonlyPubkeys, recoveryThreshold),
  ]);
  const recoveryLeaf = {
    type: 'timelocked-recovery',
    relativeBlocks: recoveryDelayBlocks,
    threshold: recoveryThreshold,
    recoveryXonlyPubkeys,
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

function recoveryThresholdScript(xonlyPubkeys, threshold) {
  const sorted = [...xonlyPubkeys].sort();
  const script = [];
  sorted.forEach((pubkey, index) => {
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

function bech32mEncode(hrp, data) {
  const checksum = createChecksum(hrp, data);
  const combined = [...data, ...checksum];
  return `${hrp}1${combined.map((v) => CHARSET[v]).join('')}`;
}

function hrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function createChecksum(hrp, data) {
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ BECH32M_CONST;
  const result = [];
  for (let p = 0; p < 6; p += 1) {
    result.push((mod >> (5 * (5 - p))) & 31);
  }
  return result;
}

function polymod(values) {
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) {
      if ((top >> i) & 1) chk ^= GENERATOR[i];
    }
  }
  return chk;
}

function convertBits(data, fromBits, toBits, pad) {
  let acc = 0;
  let bits = 0;
  const ret = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) {
      throw new Error('invalid bech32 value');
    }
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) {
    ret.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    throw new Error('invalid bech32 padding');
  }
  return ret;
}
