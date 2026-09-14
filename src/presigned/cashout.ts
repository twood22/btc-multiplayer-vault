import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { validatePresignedPublicKit } from './backup.js';
import { validateFeeCoinObservation, type FeeCoinObservation } from './fees.js';
import { nonWitnessTransactionHex, psbtUnsignedTransaction } from './graph.js';
import { payoutScript } from './roster.js';
import type { AuthorizedPresignedTransaction } from './signing.js';
import type { ParticipantId, PresignedParticipantKeys, PresignedPublicKit } from './types.js';
import { assert, commitmentDigest, exactKeys, hexBytes, networkParameters, participantId,
  presignedDomain, safeInteger, sameCanonical } from './validation.js';

export interface PresignedCashoutRequest {
  publicKit: PresignedPublicKit;
  participantId: ParticipantId;
  parentTransactionHex: string;
  /** Not an SPV/freshness proof. Recheck its active-chain anchor and mempool availability before use. */
  sourceObservation: FeeCoinObservation;
  destinationAddress: string;
  feeSats: number;
  maxFeeSats: number;
}
export interface PresignedCashout {
  version: PresignedPublicKit['version']; protocol: PresignedPublicKit['protocol'];
  kind: 'owned-payout-cashout-v1'; graphDigest: string; participantId: ParticipantId;
  source: { txid: string; vout: number; valueSats: number; scriptPubKeyHex: string };
  destinationAddress: string; destinationScriptPubKeyHex: string;
  payoutSats: number; feeSats: number; maxFeeSats: number;
  unsignedTxHex: string; txid: string; psbtBase64: string; signatureHash: string; vsize: number; digest: string;
}

/** Spend an already individual payout, never a multi-party vault coin.
 * The full parent and matching payout script also cover refunds and CPFP payouts.
 * Chain inclusion and current spendability remain the caller's independent duty. */
export function buildPresignedCashout(request: PresignedCashoutRequest): PresignedCashout {
  exactKeys(request, ['publicKit','participantId','parentTransactionHex','sourceObservation','destinationAddress','feeSats','maxFeeSats'], 'cash-out request');
  const { graph } = validatePresignedPublicKit(request.publicKit);
  participantId(request.participantId);
  const participant = graph.roster.participants.find(item => item.id === request.participantId)!;
  const observed = request.sourceObservation;
  validateFeeCoinObservation(observed, graph, 'cash-out source');
  const parent = parseTransaction(request.parentTransactionHex, 800_000, 'cash-out parent');
  assert(!parent.isCoinbase(), 'cash-out parent cannot be coinbase');
  const output = parent.outs[observed.vout];
  const script = payoutScript(graph.roster, request.participantId);
  assert(parent.getId() === observed.txid && output && Number(output.value) === observed.valueSats &&
    Buffer.from(output.script).equals(script) && script.toString('hex') === observed.scriptPubKeyHex,
  'cash-out source must be the exact observed coin owned by this participant payout key');
  assert(!graph.rounds.some(round => round.outputScriptHex === observed.scriptPubKeyHex), 'cash-out cannot spend a vault output');
  assert(typeof request.destinationAddress === 'string' && request.destinationAddress.length >= 14 &&
    request.destinationAddress.length <= 100 && request.destinationAddress.trim() === request.destinationAddress,
  'invalid cash-out destination address');
  const destination = bitcoin.address.toOutputScript(request.destinationAddress, networkParameters(graph.roster.network));
  assert(bitcoin.address.fromOutputScript(destination, networkParameters(graph.roster.network)) === request.destinationAddress,
    'cash-out destination address must use its canonical encoding');
  const destinationHex = Buffer.from(destination).toString('hex');
  assert(/^(?:76a914[0-9a-f]{40}88ac|a914[0-9a-f]{40}87|0014[0-9a-f]{40}|0020[0-9a-f]{64}|5120[0-9a-f]{64})$/u.test(destinationHex),
    'cash-out destination must be a supported standard Bitcoin address');
  assert(!graph.rounds.some(round => round.outputScriptHex === destinationHex), 'cash-out destination cannot recreate a vault output');
  safeInteger(request.maxFeeSats, 1, graph.roster.feePolicy.maxChildFeeSats, 'cash-out fee cap');
  safeInteger(request.feeSats, 1, request.maxFeeSats, 'cash-out fee');
  const payoutSats = observed.valueSats - request.feeSats;
  // Conservative standard dust floor across every accepted destination type.
  safeInteger(payoutSats, 546, 2_100_000_000_000_000, 'cash-out destination amount');
  const psbt = new bitcoin.Psbt({ network: networkParameters(graph.roster.network) });
  psbt.setVersion(2); psbt.setLocktime(0);
  psbt.addInput({ hash: observed.txid, index: observed.vout, sequence: 0xfffffffd,
    witnessUtxo: { script, value: BigInt(observed.valueSats) },
    tapInternalKey: Buffer.from(participant.payoutXonlyPublicKeyHex, 'hex') });
  psbt.addOutput({ script: destination, value: BigInt(payoutSats) });
  const tx = psbtUnsignedTransaction(psbt);
  const preview = tx.clone(); preview.setWitness(0, [Buffer.alloc(64)]);
  const vsize = preview.virtualSize();
  assert(request.feeSats >= vsize, 'cash-out fee is below the one-sat/vbyte relay floor');
  const hash = tx.hashForWitnessV1(0, [script], [BigInt(observed.valueSats)], bitcoin.Transaction.SIGHASH_DEFAULT);
  const body = { version: graph.version, protocol: graph.protocol, kind: 'owned-payout-cashout-v1' as const,
    graphDigest: graph.digest, participantId: request.participantId,
    source: { txid: observed.txid, vout: observed.vout, valueSats: observed.valueSats, scriptPubKeyHex: observed.scriptPubKeyHex },
    destinationAddress: request.destinationAddress, destinationScriptPubKeyHex: destinationHex,
    payoutSats, feeSats: request.feeSats, maxFeeSats: request.maxFeeSats, unsignedTxHex: tx.toHex(), txid: tx.getId(),
    psbtBase64: psbt.toBase64(), signatureHash: Buffer.from(hash).toString('hex'), vsize };
  return { ...body, digest: commitmentDigest(presignedDomain(graph.protocol, 'owned-payout-cashout'), {
    cashout: body, parentTransactionHex: request.parentTransactionHex, sourceObservation: observed }) };
}

export function validatePresignedCashout(input: { request: PresignedCashoutRequest; cashout: PresignedCashout }): PresignedCashout {
  const built = buildPresignedCashout(input.request);
  sameCanonical(input.cashout, built, 'cash-out approval');
  return built;
}

/** CLIENT ONLY. The owner approves the exact output and extra fee independently. */
export function signPresignedCashout(input: {
  request: PresignedCashoutRequest; cashout: PresignedCashout; keys: PresignedParticipantKeys; approvedCashoutDigest: string;
}): AuthorizedPresignedTransaction {
  assert(input.keys.payoutPrivateKey instanceof Uint8Array, 'cash-out key must be client-held bytes');
  const secret = Buffer.from(input.keys.payoutPrivateKey);
  input.keys.payoutPrivateKey.fill(0);
  let adjusted: Buffer | undefined; let tweaked: Buffer | undefined;
  try {
    const cashout = validatePresignedCashout(input);
    hexBytes(input.approvedCashoutDigest, 32, 'approved cash-out digest');
    assert(input.approvedCashoutDigest === cashout.digest, 'cash-out was not explicitly approved');
    assert(input.keys.participantId === cashout.participantId, 'only the payout owner can cash out');
    const participant = input.request.publicKit.graph.roster.participants.find(item => item.id === cashout.participantId)!;
    assert(secret.length === 32 && ecc.isPrivate(secret), 'invalid cash-out payout key');
    const point = Buffer.from(ecc.pointFromScalar(secret, true)!);
    assert(point.subarray(1).toString('hex') === participant.payoutXonlyPublicKeyHex, 'cash-out payout key differs from the roster');
    adjusted = Buffer.from(point[0] === 3 ? ecc.privateNegate(secret) : secret);
    const added = ecc.privateAdd(adjusted, bitcoin.crypto.taggedHash('TapTweak', point.subarray(1)));
    assert(added, 'invalid cash-out Taproot tweak'); tweaked = Buffer.from(added);
    const tx = bitcoin.Transaction.fromHex(cashout.unsignedTxHex);
    tx.setWitness(0, [ecc.signSchnorr(Buffer.from(cashout.signatureHash, 'hex'), tweaked)]);
    return authorizeChecked(cashout, tx.toHex());
  } finally { secret.fill(0); adjusted?.fill(0); tweaked?.fill(0); }
}

export function authorizePresignedCashoutTransaction(input: {
  request: PresignedCashoutRequest; cashout: PresignedCashout; transactionHex: string;
}): AuthorizedPresignedTransaction {
  return authorizeChecked(validatePresignedCashout(input), input.transactionHex);
}

/** Private fast path: a public entry point has already fully rebuilt the kit/request. */
function authorizeChecked(cashout: PresignedCashout, transactionHex: string): AuthorizedPresignedTransaction {
  const tx = parseTransaction(transactionHex, 2_000, 'cash-out transaction');
  assert(tx.version === 2 && tx.locktime === 0 && tx.ins.length === 1 && tx.outs.length === 1 &&
    tx.ins[0]!.script.length === 0 && tx.ins[0]!.sequence === 0xfffffffd &&
    nonWitnessTransactionHex(tx) === cashout.unsignedTxHex && tx.getId() === cashout.txid,
  'cash-out changed the exact owner-approved transaction');
  const witness = tx.ins[0]!.witness;
  assert(witness.length === 1 && witness[0]!.length === 64, 'cash-out requires SIGHASH_DEFAULT without annex or script-path material');
  assert(ecc.verifySchnorr(Buffer.from(cashout.signatureHash, 'hex'),
    Buffer.from(cashout.source.scriptPubKeyHex, 'hex').subarray(2), witness[0]!), 'invalid cash-out owner signature');
  assert(tx.virtualSize() === cashout.vsize && cashout.source.valueSats - Number(tx.outs[0]!.value) === cashout.feeSats,
    'cash-out fee or signed size differs');
  return { transactionHex: tx.toHex(), txid: tx.getId(), feeSats: cashout.feeSats, vsize: tx.virtualSize() };
}
function parseTransaction(raw: string, maxHexLength: number, label: string): bitcoin.Transaction {
  assert(typeof raw === 'string' && raw.length <= maxHexLength && /^(?:[0-9a-f]{2})+$/u.test(raw), `invalid ${label}`);
  const tx = bitcoin.Transaction.fromHex(raw);
  assert(tx.toHex() === raw, `${label} is not canonically encoded`);
  return tx;
}
