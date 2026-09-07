import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import type { BitcoinNetworkName } from '../types.js';
import { validatePresignedGraph } from './graph.js';
import { authorizePresignedExitTransaction } from './signing.js';
import { payoutScript } from './roster.js';
import { nativeWalletWitnessFromPsbt, verifyNativeWalletWitness } from './wallet.js';
import { PRESIGNED_PROTOCOL, type PresignedGraph, type PresignedParticipantKeys } from './types.js';
import { assert, commitmentDigest, exactKeys, hexBytes, networkParameters, safeInteger, supportedWalletScript } from './validation.js';

const MONEY_MAX = 2_100_000_000_000_000;
const CHILD_SEQUENCE = 0xfffffffd;
const TRUC_VERSION = 3;
const TRUC_MAX_PARENT_VSIZE = 10_000;
const TRUC_MAX_CHILD_VSIZE = 1_000;
const FEE_KIND = 'confirmed-truc-payout-cpfp-v1' as const;

/**
 * This is an externally validated active-chain observation, not an SPV proof.
 * The caller must independently verify its block anchor immediately before use.
 * unspentInActiveChain ignores mempool spends, including this exact exit parent.
 */
export interface FeeCoinObservation {
  network: BitcoinNetworkName;
  genesisHash: string;
  txid: string;
  vout: number;
  valueSats: number;
  scriptPubKeyHex: string;
  confirmationBlockHash: string;
  confirmations: number;
  unspentInActiveChain: true;
  coinbase: false;
}

export interface PresignedFeeApproval {
  childFeeSats: number;
  maxChildFeeSats: number;
  /** Integer millisatoshis per virtual byte; no floating-point commitments. */
  targetPackageRateMillisatsPerVbyte: number;
  minRelayRateMillisatsPerVbyte: number;
  sponsorChangeScriptPubKeyHex: string | null;
  /** Only legal when the entire sponsor input equals the exact approved fee. */
  approveExactNoChangeFee: boolean;
  /** First implementation only replaces a child using the same sponsor coin. */
  replacement: {
    previousChildTransactionHex: string;
    incrementalRelayRateMillisatsPerVbyte: number;
  } | null;
}

export interface PresignedFeeRequest {
  graph: PresignedGraph;
  exitId: string;
  parentTransactionHex: string;
  roundInputObservation: FeeCoinObservation;
  sponsorInput: FeeCoinObservation;
  approval: PresignedFeeApproval;
}

export interface PresignedFeeChild {
  version: 2;
  protocol: typeof PRESIGNED_PROTOCOL;
  kind: typeof FEE_KIND;
  graphDigest: string;
  exitId: string;
  approvalDigest: string;
  psbtBase64: string;
  unsignedTxid: string;
  parentTxid: string;
  parentFeeSats: number;
  parentVsize: number;
  payoutSats: number;
  sponsorChangeSats: number;
  childFeeSats: number;
  /** Conservative preview only; finalization checks the actual signed vsize. */
  maximumChildVsize: number;
}

/** Exactly two inputs: leaver payout at 0 and one confirmed sponsor at 1. */
export function buildPresignedFeeChild(request: PresignedFeeRequest): PresignedFeeChild {
  exactKeys(request, ['graph', 'exitId', 'parentTransactionHex', 'roundInputObservation', 'sponsorInput', 'approval'], 'fee request');
  const graph = validatePresignedGraph(request.graph);
  assert(graph.roster.feePolicy.kind === FEE_KIND, 'fee request does not commit the TRUC payout policy');
  const exit = graph.exits.find(item => item.id === request.exitId);
  assert(exit, 'fee child names an unknown exit');
  validateObservation(request.roundInputObservation, graph, 'round input');
  assertCoin(request.roundInputObservation, {
    txid: exit.inputTxid, vout: exit.inputVout, valueSats: exit.inputValueSats,
    scriptPubKeyHex: exit.inputScriptPubKeyHex,
  }, 'confirmed round input');
  const parent = authorizePresignedExitTransaction({ graph, exitId: request.exitId, transactionHex: request.parentTransactionHex });
  const parentTx = parseTransaction(parent.transactionHex, 'parent transaction');
  assert(parentTx.version === TRUC_VERSION && parentTx.ins.length === 1 && parent.vsize <= TRUC_MAX_PARENT_VSIZE,
    'fee parent must be a bounded TRUC exit spending one confirmed round input');
  const payout = parentTx.outs[0]!;
  const ownPayoutScript = payoutScript(graph.roster, exit.leaver);
  assert(Buffer.from(payout.script).equals(ownPayoutScript), 'parent output 0 is not the leaver payout');
  const payoutSats = Number(payout.value);
  safeInteger(payoutSats, 330, MONEY_MAX, 'payout amount');

  const sponsor = request.sponsorInput;
  validateObservation(sponsor, graph, 'sponsor input');
  assert(supportedWalletScript(sponsor.scriptPubKeyHex), 'sponsor must be native P2WPKH or key-path P2TR');
  assert(!graph.rounds.some(round => round.outputScriptHex === sponsor.scriptPubKeyHex), 'a successor vault cannot sponsor fees');
  assert(sponsor.txid !== graph.fundingTxid && !graph.exits.some(item => item.txid === sponsor.txid), 'sponsor must be outside the funding and exit graph');
  assert(sponsor.txid !== parent.txid || sponsor.vout !== 0, 'sponsor repeats the leaver payout');
  safeInteger(payoutSats + sponsor.valueSats, 1, MONEY_MAX, 'child input total');

  const approval = request.approval;
  exactKeys(approval, ['childFeeSats', 'maxChildFeeSats', 'targetPackageRateMillisatsPerVbyte', 'minRelayRateMillisatsPerVbyte', 'sponsorChangeScriptPubKeyHex', 'approveExactNoChangeFee', 'replacement'], 'fee approval');
  safeInteger(approval.maxChildFeeSats, 1, graph.roster.feePolicy.maxChildFeeSats, 'approved fee cap');
  safeInteger(approval.childFeeSats, 1, approval.maxChildFeeSats, 'child fee');
  validateRate(approval.targetPackageRateMillisatsPerVbyte, 'target package feerate');
  validateRate(approval.minRelayRateMillisatsPerVbyte, 'minimum relay feerate');
  assert(typeof approval.approveExactNoChangeFee === 'boolean', 'no-change fee approval is not boolean');
  const sponsorChangeSats = sponsor.valueSats - approval.childFeeSats;
  assert(sponsorChangeSats >= 0, 'sponsor cannot cover the exact child fee');
  if (sponsorChangeSats === 0) {
    assert(approval.sponsorChangeScriptPubKeyHex === null && approval.approveExactNoChangeFee, 'exact no-change fee requires explicit approval');
  } else {
    assert(!approval.approveExactNoChangeFee && approval.sponsorChangeScriptPubKeyHex !== null, 'nonzero sponsor change must be preserved');
    assert(supportedWalletScript(approval.sponsorChangeScriptPubKeyHex), 'sponsor change must be native P2WPKH or key-path P2TR');
    assert(!graph.rounds.some(round => round.outputScriptHex === approval.sponsorChangeScriptPubKeyHex), 'sponsor change cannot recreate a vault output');
    assert(sponsorChangeSats >= dustFloor(approval.sponsorChangeScriptPubKeyHex), 'sponsor change is dust');
  }
  if (approval.replacement !== null) {
    exactKeys(approval.replacement, ['previousChildTransactionHex', 'incrementalRelayRateMillisatsPerVbyte'], 'replacement request');
    validateRate(approval.replacement.incrementalRelayRateMillisatsPerVbyte, 'incremental relay feerate');
  }
  const participant = graph.roster.participants.find(item => item.id === exit.leaver)!;
  const psbt = new bitcoin.Psbt({ network: networkParameters(graph.roster.network) });
  psbt.setVersion(TRUC_VERSION);
  psbt.setLocktime(0);
  psbt.addInput({ hash: parent.txid, index: 0, sequence: CHILD_SEQUENCE,
    witnessUtxo: { script: ownPayoutScript, value: BigInt(payoutSats) },
    tapInternalKey: Buffer.from(participant.payoutXonlyPublicKeyHex, 'hex') });
  psbt.addInput({ hash: sponsor.txid, index: sponsor.vout, sequence: CHILD_SEQUENCE,
    witnessUtxo: { script: Buffer.from(sponsor.scriptPubKeyHex, 'hex'), value: BigInt(sponsor.valueSats) } });
  psbt.addOutput({ script: ownPayoutScript, value: BigInt(payoutSats) });
  if (sponsorChangeSats) psbt.addOutput({ script: Buffer.from(approval.sponsorChangeScriptPubKeyHex!, 'hex'), value: BigInt(sponsorChangeSats) });
  const tx = unsignedTransaction(psbt);
  if (approval.replacement) verifyPriorChild(request, tx, ownPayoutScript, payoutSats);
  const preview = tx.clone();
  preview.setWitness(0, [Buffer.alloc(64)]);
  preview.setWitness(1, sponsor.scriptPubKeyHex.startsWith('0014') ? [Buffer.alloc(73), Buffer.alloc(33)] : [Buffer.alloc(65)]);
  assert(preview.virtualSize() <= TRUC_MAX_CHILD_VSIZE, 'fee child exceeds the TRUC descendant size limit');
  const approvalDigest = commitmentDigest('btc-multiplayer-vault/presigned-fee-approval/v1', {
    protocol: PRESIGNED_PROTOCOL, kind: FEE_KIND, graphDigest: graph.digest, exitId: exit.id,
    parentTransactionHex: request.parentTransactionHex, unsignedTxHex: tx.toHex(),
    roundInputObservation: request.roundInputObservation, sponsorInput: sponsor, approval,
  });
  return { version: 2, protocol: PRESIGNED_PROTOCOL, kind: FEE_KIND, graphDigest: graph.digest,
    exitId: exit.id, approvalDigest, psbtBase64: psbt.toBase64(), unsignedTxid: tx.getId(),
    parentTxid: parent.txid, parentFeeSats: parent.feeSats, parentVsize: parent.vsize,
    payoutSats, sponsorChangeSats, childFeeSats: approval.childFeeSats, maximumChildVsize: preview.virtualSize() };
}

/** Rebuild before signing; unsigned approval accepts no wallet signature material. */
export function authorizePresignedFeeChild(input: {
  request: PresignedFeeRequest; psbtBase64: string; approvalDigest: string;
}): PresignedFeeChild {
  const built = buildPresignedFeeChild(input.request);
  hexBytes(input.approvalDigest, 32, 'fee approval digest');
  assert(input.approvalDigest === built.approvalDigest, 'fee approval digest changed');
  assertCanonicalPsbt(input.psbtBase64, built.psbtBase64, -1);
  return built;
}

/** Payout signature is a detached capability; it never signs the sponsor input. */
export function signPresignedFeePayout(input: {
  request: PresignedFeeRequest; psbtBase64: string; approvalDigest: string; keys: PresignedParticipantKeys;
}): { approvalDigest: string; payoutSignatureHex: string; payoutSignedPsbtBase64: string } {
  const built = authorizePresignedFeeChild(input);
  const exit = input.request.graph.exits.find(item => item.id === input.request.exitId)!;
  assert(input.keys.participantId === exit.leaver, 'only the designated leaver can sign this fee child');
  const participant = input.request.graph.roster.participants.find(item => item.id === exit.leaver)!;
  const secret = Buffer.from(input.keys.payoutPrivateKey);
  let adjusted: Buffer | undefined;
  let tweaked: Buffer | undefined;
  try {
    assert(secret.length === 32 && ecc.isPrivate(secret), 'invalid payout private key');
    const compressed = ecc.pointFromScalar(secret, true);
    assert(compressed && Buffer.from(compressed).subarray(1).toString('hex') === participant.payoutXonlyPublicKeyHex, 'payout private key differs from the roster');
    adjusted = Buffer.from(compressed[0] === 3 ? ecc.privateNegate(secret) : secret);
    const tweak = bitcoin.crypto.taggedHash('TapTweak', Buffer.from(participant.payoutXonlyPublicKeyHex, 'hex'));
    const result = ecc.privateAdd(adjusted, tweak);
    assert(result, 'invalid payout Taproot tweak');
    tweaked = Buffer.from(result);
    const psbt = parsePsbt(built.psbtBase64);
    const tx = unsignedTransaction(psbt);
    const prevouts = feePrevouts(input.request, built);
    const hash = tx.hashForWitnessV1(0, prevouts.map(item => Buffer.from(item.scriptPubKeyHex, 'hex')), prevouts.map(item => BigInt(item.valueSats)), bitcoin.Transaction.SIGHASH_DEFAULT);
    const signature = Buffer.from(ecc.signSchnorr(hash, tweaked));
    verifyNativeWalletWitness(tx, 0, prevouts, [signature]);
    psbt.updateInput(0, { tapKeySig: signature });
    return { approvalDigest: built.approvalDigest, payoutSignatureHex: signature.toString('hex'), payoutSignedPsbtBase64: psbt.toBase64() };
  } finally {
    secret.fill(0);
    adjusted?.fill(0);
    tweaked?.fill(0);
  }
}

/** Accept only verified input-1 signature material, then rebuild final bytes. */
export function finalizePresignedFeeChild(input: {
  request: PresignedFeeRequest; approvalDigest: string; payoutSignatureHex: string; sponsorSignedPsbtBase64: string;
}): PresignedFeeChild & { transactionHex: string; txid: string; vsize: number; finalizationDigest: string } {
  const built = buildPresignedFeeChild(input.request);
  assert(input.approvalDigest === built.approvalDigest, 'fee approval digest changed');
  const submitted = assertCanonicalPsbt(input.sponsorSignedPsbtBase64, built.psbtBase64, 1);
  const tx = unsignedTransaction(parsePsbt(built.psbtBase64));
  const prevouts = feePrevouts(input.request, built);
  const payoutSignature = hexBytes(input.payoutSignatureHex, 64, 'SIGHASH_DEFAULT payout signature');
  verifyNativeWalletWitness(tx, 0, prevouts, [payoutSignature]);
  const sponsorWitness = nativeWalletWitnessFromPsbt(submitted.data.inputs[1]!);
  verifyNativeWalletWitness(tx, 1, prevouts, sponsorWitness);
  tx.setWitness(0, [payoutSignature]);
  tx.setWitness(1, sponsorWitness);
  assert(tx.getId() === built.unsignedTxid, 'signatures mutated fee child txid');
  const vsize = tx.virtualSize();
  assert(tx.version === TRUC_VERSION && vsize <= TRUC_MAX_CHILD_VSIZE, 'final fee child violates TRUC version or size limits');
  const approval = input.request.approval;
  assert(built.childFeeSats >= feeAtRate(vsize, approval.minRelayRateMillisatsPerVbyte), 'fee child is below the approved relay floor');
  // TRUC permits a below-minrelay immutable parent when its 1-parent/1-child
  // package pays the relay floor. Actual mempool/replacement policy still needs
  // live Core preflight; confirmed observations alone cannot attest that state.
  assert(built.parentFeeSats + built.childFeeSats >= feeAtRate(built.parentVsize + vsize, approval.minRelayRateMillisatsPerVbyte), 'fee package is below the approved relay floor');
  assert(built.parentFeeSats + built.childFeeSats >= feeAtRate(built.parentVsize + vsize, approval.targetPackageRateMillisatsPerVbyte), 'fee child misses the approved package feerate');
  if (approval.replacement) {
    const previous = parseTransaction(approval.replacement.previousChildTransactionHex, 'previous fee child');
    const previousFee = input.request.sponsorInput.valueSats + built.payoutSats - outputTotal(previous);
    assert(built.childFeeSats >= previousFee + feeAtRate(vsize, approval.replacement.incrementalRelayRateMillisatsPerVbyte), 'replacement fee does not cover the approved incremental relay requirement');
    assert(BigInt(built.childFeeSats) * BigInt(previous.virtualSize()) > BigInt(previousFee) * BigInt(vsize), 'replacement child feerate must strictly increase');
  }
  const transactionHex = tx.toHex();
  const finalizationDigest = commitmentDigest('btc-multiplayer-vault/presigned-fee-finalization/v1', { approvalDigest: built.approvalDigest, transactionHex });
  return { ...built, transactionHex, txid: tx.getId(), vsize, finalizationDigest };
}

function validateObservation(observation: FeeCoinObservation, graph: PresignedGraph, label: string): void {
  exactKeys(observation, ['network', 'genesisHash', 'txid', 'vout', 'valueSats', 'scriptPubKeyHex', 'confirmationBlockHash', 'confirmations', 'unspentInActiveChain', 'coinbase'], label);
  assert(observation.network === graph.roster.network && observation.genesisHash === graph.roster.genesisHash, `${label} is on another network`);
  hexBytes(observation.txid, 32, `${label} txid`);
  hexBytes(observation.confirmationBlockHash, 32, `${label} confirmation block`);
  assert(observation.confirmationBlockHash !== '00'.repeat(32), `${label} has a zero confirmation anchor`);
  safeInteger(observation.vout, 0, 0xffffffff, `${label} output index`);
  safeInteger(observation.valueSats, 1, MONEY_MAX, `${label} value`);
  assert(supportedWalletScript(observation.scriptPubKeyHex), `${label} has an unsupported script`);
  safeInteger(observation.confirmations, 1, 10_000_000, `${label} confirmations`);
  assert(observation.unspentInActiveChain === true && observation.coinbase === false, `${label} must be a confirmed unspent non-coinbase coin`);
}

function assertCoin(actual: FeeCoinObservation, expected: { txid: string; vout: number; valueSats: number; scriptPubKeyHex: string }, label: string): void {
  assert(actual.txid === expected.txid && actual.vout === expected.vout && actual.valueSats === expected.valueSats && actual.scriptPubKeyHex === expected.scriptPubKeyHex, `${label} differs from graph`);
}

function feePrevouts(request: PresignedFeeRequest, built: PresignedFeeChild) {
  const exit = request.graph.exits.find(item => item.id === request.exitId)!;
  return [{ scriptPubKeyHex: payoutScript(request.graph.roster, exit.leaver).toString('hex'), valueSats: built.payoutSats },
    { scriptPubKeyHex: request.sponsorInput.scriptPubKeyHex, valueSats: request.sponsorInput.valueSats }];
}

function verifyPriorChild(request: Pick<PresignedFeeRequest, 'graph' | 'approval' | 'sponsorInput'>, candidate: bitcoin.Transaction, script: Buffer, payoutSats: number): void {
  const previous = parseTransaction(request.approval.replacement!.previousChildTransactionHex, 'previous fee child');
  assert(previous.version === TRUC_VERSION && previous.locktime === 0 && previous.ins.length === 2 && previous.virtualSize() <= TRUC_MAX_CHILD_VSIZE, 'previous child has invalid TRUC transaction shape');
  for (let index = 0; index < 2; index++) {
    const before = previous.ins[index]!;
    const after = candidate.ins[index]!;
    assert(Buffer.from(before.hash).equals(Buffer.from(after.hash)) && before.index === after.index && before.sequence === CHILD_SEQUENCE && before.script.length === 0, 'replacement must retain exact payout and sponsor inputs');
  }
  assert(previous.outs.length === 1 || previous.outs.length === 2, 'previous child has unexpected outputs');
  assert(Number(previous.outs[0]!.value) === payoutSats && Buffer.from(previous.outs[0]!.script).equals(script), 'previous child did not preserve the full payout');
  if (previous.outs.length === 2) {
    assert(request.approval.sponsorChangeScriptPubKeyHex !== null && Buffer.from(previous.outs[1]!.script).toString('hex') === request.approval.sponsorChangeScriptPubKeyHex, 'replacement changed the sponsor change destination');
  }
  const previousFee = payoutSats + request.sponsorInput.valueSats - outputTotal(previous);
  safeInteger(previousFee, 1, request.graph.roster.feePolicy.maxChildFeeSats, 'previous child fee');
  assert(previous.outs.length === 2 || previousFee === request.sponsorInput.valueSats, 'previous no-change child has an invalid fee');
  const prevouts = [{ scriptPubKeyHex: script.toString('hex'), valueSats: payoutSats }, { scriptPubKeyHex: request.sponsorInput.scriptPubKeyHex, valueSats: request.sponsorInput.valueSats }];
  assert(previous.ins[0]!.witness.length === 1 && previous.ins[0]!.witness[0]!.length === 64, 'previous payout witness is not SIGHASH_DEFAULT');
  for (let index = 0; index < 2; index++) verifyNativeWalletWitness(previous, index, prevouts, previous.ins[index]!.witness);
}

function assertCanonicalPsbt(base64: string, canonicalBase64: string, signedInput: -1 | 1): bitcoin.Psbt {
  const submitted = parsePsbt(base64);
  const canonical = parsePsbt(canonicalBase64);
  assert(unsignedTransaction(submitted).toHex() === unsignedTransaction(canonical).toHex(), 'fee PSBT transaction differs from the approved child');
  assert(submitted.data.inputs.length === 2 && submitted.data.outputs.length === canonical.data.outputs.length, 'fee PSBT shape changed');
  for (const [key, value] of Object.entries(submitted.data.globalMap)) assert(key === 'unsignedTx' || key === 'unknownKeyVals' && Array.isArray(value) && value.length === 0, 'fee PSBT has unexpected global metadata');
  submitted.data.outputs.forEach(output => {
    for (const [key, value] of Object.entries(output)) {
      if (key === 'unknownKeyVals' && Array.isArray(value) && value.length === 0) continue;
      // A wallet may annotate its change key. These hints confer no authority
      // and are discarded when final bytes are rebuilt from the approval.
      assert(signedInput === 1 && benignWalletMetadata(key, value), 'fee PSBT has unexpected output metadata');
    }
  });
  submitted.data.inputs.forEach((input, index) => {
    const expected = canonical.data.inputs[index]!;
    assert(input.witnessUtxo && expected.witnessUtxo && input.witnessUtxo.value === expected.witnessUtxo.value && Buffer.from(input.witnessUtxo.script).equals(Buffer.from(expected.witnessUtxo.script)), 'fee PSBT prevout metadata changed');
    if (index === 0) assert(input.tapInternalKey && Buffer.from(input.tapInternalKey).equals(Buffer.from(expected.tapInternalKey!)), 'payout internal key metadata changed');
    for (const [key, value] of Object.entries(input)) {
      if (key === 'witnessUtxo' || index === 0 && key === 'tapInternalKey') continue;
      if (key === 'unknownKeyVals' && Array.isArray(value) && value.length === 0) continue;
      // Core annotates *all* inputs with its requested hash type, including
      // the payout it cannot sign. Treat only all-committing types as hints;
      // detached payout/wallet witness verification below remains authoritative.
      if (signedInput === 1 && key === 'sighashType') {
        const taproot = expected.witnessUtxo!.script.length === 34 && expected.witnessUtxo!.script[0] === 0x51;
        assert(value === bitcoin.Transaction.SIGHASH_ALL || taproot && value === bitcoin.Transaction.SIGHASH_DEFAULT,
          'wallet fee sighash hint must commit all inputs and outputs');
        continue;
      }
      // A sponsor wallet may preserve the full payout parent supplied by the
      // UI even though it cannot sign input 0. Validate that exact previous
      // transaction on either input, then discard the non-authorizing hint.
      if (signedInput === 1 && key === 'nonWitnessUtxo') {
        assert(value instanceof Uint8Array && value.length > 0, 'invalid wallet full previous transaction');
        const previous = bitcoin.Transaction.fromBuffer(value);
        assert(Buffer.from(previous.toBuffer()).equals(Buffer.from(value)), 'wallet full previous transaction is not canonical');
        const spent = unsignedTransaction(canonical).ins[index]!;
        assert(previous.getId() === Buffer.from(spent.hash).reverse().toString('hex'), 'wallet full previous transaction txid changed');
        const output = previous.outs[spent.index];
        assert(output && output.value === expected.witnessUtxo!.value && Buffer.from(output.script).equals(Buffer.from(expected.witnessUtxo!.script)),
          'wallet full previous transaction output differs from the approved prevout');
        continue;
      }
      if (index === signedInput && benignWalletMetadata(key, value)) continue;
      assert(index === signedInput && ['partialSig', 'tapKeySig', 'finalScriptWitness'].includes(key), 'fee PSBT has unexpected input metadata or another signer signature');
    }
  });
  return submitted;
}

function benignWalletMetadata(key: string, value: unknown): boolean {
  if (key === 'tapInternalKey') return value instanceof Uint8Array && value.length === 32;
  if (key === 'bip32Derivation') return Array.isArray(value) && value.length <= 4;
  if (key === 'tapBip32Derivation') return Array.isArray(value) && value.length <= 4 &&
    value.every(entry => entry && typeof entry === 'object' && Array.isArray(entry.leafHashes) && entry.leafHashes.length === 0);
  return false;
}

function parsePsbt(value: string): bitcoin.Psbt {
  assert(typeof value === 'string' && value.length > 0 && value.length <= 24_000, 'invalid fee PSBT size');
  return bitcoin.Psbt.fromBase64(value);
}

function parseTransaction(value: string, label: string): bitcoin.Transaction {
  assert(typeof value === 'string' && value.length > 0 && value.length <= 40_000 && /^(?:[0-9a-f]{2})+$/u.test(value), `invalid ${label} encoding`);
  const transaction = bitcoin.Transaction.fromHex(value);
  assert(transaction.toHex() === value, `${label} is not canonical`);
  return transaction;
}

function unsignedTransaction(psbt: bitcoin.Psbt): bitcoin.Transaction {
  return bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
}

function outputTotal(transaction: bitcoin.Transaction): number {
  const total = transaction.outs.reduce((sum, output) => sum + output.value, 0n);
  assert(total <= BigInt(MONEY_MAX), 'child outputs exceed Bitcoin monetary range');
  return Number(total);
}

function validateRate(value: number, label: string): void {
  safeInteger(value, 1, 1_000_000_000, label);
}

function feeAtRate(vsize: number, millisatsPerVbyte: number): number {
  const fee = (BigInt(vsize) * BigInt(millisatsPerVbyte) + 999n) / 1000n;
  assert(fee <= BigInt(MONEY_MAX), 'computed fee exceeds Bitcoin monetary range');
  return Number(fee);
}

function dustFloor(scriptPubKeyHex: string): number {
  // Conservative default 3 sat/vB dust relay policy; Core preflight remains authoritative.
  return scriptPubKeyHex.startsWith('0014') ? 294 : 330;
}

/**
 * Internal primitives shared with the independently authorized spend-fee API.
 * These do not authorize a parent, an actor, or a spend proposal on their own.
 */
export {
  MONEY_MAX as FEE_MONEY_MAX, CHILD_SEQUENCE as FEE_CHILD_SEQUENCE, TRUC_VERSION as FEE_TRUC_VERSION,
  TRUC_MAX_PARENT_VSIZE as FEE_TRUC_MAX_PARENT_VSIZE, TRUC_MAX_CHILD_VSIZE as FEE_TRUC_MAX_CHILD_VSIZE,
  FEE_KIND as SPONSORED_PAYOUT_FEE_KIND, validateObservation as validateFeeCoinObservation,
  assertCoin as assertFeeCoinMatches, assertCanonicalPsbt as assertSponsoredFeePsbt,
  verifyPriorChild as verifySponsoredFeePriorChild, parsePsbt as parseSponsoredFeePsbt,
  parseTransaction as parseSponsoredFeeTransaction, unsignedTransaction as sponsoredFeeUnsignedTransaction,
  outputTotal as sponsoredFeeOutputTotal, validateRate as validateSponsoredFeeRate,
  feeAtRate as sponsoredFeeAtRate, dustFloor as sponsoredFeeDustFloor,
};
