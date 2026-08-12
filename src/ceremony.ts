import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { BITCOIN_NETWORK } from './network.js';
import { AMOUNTS } from './config.js';
import { verifyVaultTransaction, type ConsensusVerification } from './consensus.js';
import { keyAgg, keySort, taggedHash } from './crypto.js';
import {
  assertNoSignatureMaterial,
  assertOutputsMatch,
  assertOwnedKeypair,
  assertRebuiltPsbtMatches,
  assertTrustedInputMatchesPsbt,
  assertUnsignedTransactionShape,
  canonicalParticipantIds,
  outputTotalSats,
  taprootOutputScriptHex,
  vaultForRound,
} from './custody.js';
import {
  nonceAgg,
  nonceGen,
  partialSigAgg,
  partialSigVerify,
  sign,
  type SessionContext,
} from './musig2.js';
import { buildCooperativeExitPsbt, unsignedTx } from './psbt.js';
import type { Hex, TrustedVaultInput, VaultRound, VaultState } from './types.js';
import { participantById } from './vault.js';

bitcoin.initEccLib(ecc);

// Interactive BIP-327 MuSig2 cooperative exit. Unlike the demo signer in
// psbt.ts (which reconstructs the aggregate secret on one machine), this runs
// the real two-round protocol: each participant contributes a public nonce and
// a partial signature computed only from their own secret key and secret
// nonce, so no machine ever holds another participant's key. The output is the
// same standard BIP-340 signature over the taproot key path.
//
// Round structure (three JSON blobs exchanged between participants):
//   1. ceremony-start      → unsigned PSBT + sighash + key-path metadata
//   2. ceremony-nonce      → each participant's 66-byte pubnonce
//   3. ceremony-partial    → each participant's 32-byte partial signature
// then anyone aggregates the partials into the final witness.

export interface CeremonyContext {
  round: string;
  aggregateXonly: Hex;
  tapMerkleRoot: Hex;
  sortedPubkeys: Hex[];
  message: Hex;
  psbtBase64: string;
}

function taprootTweak(aggregateXonly: Hex, tapMerkleRoot: Hex): Buffer {
  return taggedHash(
    'TapTweak',
    Buffer.concat([Buffer.from(aggregateXonly, 'hex'), Buffer.from(tapMerkleRoot, 'hex')]),
  );
}

function keySpendMessage(psbt: bitcoin.Psbt): Buffer {
  const tx = (psbt as unknown as { __CACHE: { __TX: bitcoin.Transaction } }).__CACHE.__TX;
  const scripts = psbt.data.inputs.map((input) => {
    if (!input.witnessUtxo) throw new Error('input missing witnessUtxo for key-spend sighash');
    return Buffer.from(input.witnessUtxo.script);
  });
  const values = psbt.data.inputs.map((input) => input.witnessUtxo!.value);
  return Buffer.from(tx.hashForWitnessV1(0, scripts, values, bitcoin.Transaction.SIGHASH_DEFAULT));
}

function sortedKeyPathPubkeys(vault: VaultRound): Hex[] {
  return keySort(vault.keyPath.personalCompressedPubkeys);
}

export interface CooperativeAuthorization {
  round: string;
  signerIds: string[];
  trustedInput: TrustedVaultInput;
  outputs: Array<{ index: number; address: string; valueSats: number }>;
  feeSats: number;
  messageHex: Hex;
  unsignedTxid: string;
  checks: string[];
}

/**
 * The cooperative custody gate. A ceremony context arrives from whoever
 * coordinates the exit, and a MuSig2 partial signature is irrevocable: a
 * signer who nonces-and-partials over a hostile context has already lost the
 * pot. So nothing in the context is believed. The round's vault, signer set,
 * aggregate key, tap tree, transaction, outputs, fee, and sighash are all
 * recomputed here from public roster data plus the operator's own trusted
 * outpoint, and the context must match that reconstruction exactly.
 *
 * Called before *both* ceremony rounds, because the message a signer commits
 * to with their nonce is the same message they later sign.
 */
export function authorizeCooperativeContext({
  state,
  context,
  trustedInput,
}: {
  state: VaultState;
  context: CeremonyContext;
  trustedInput: TrustedVaultInput;
}): CooperativeAuthorization {
  if (!context || typeof context !== 'object') throw new Error('ceremony context is missing');
  if (typeof context.round !== 'string' || !context.round) {
    throw new Error('ceremony context is missing its round');
  }
  if (typeof context.psbtBase64 !== 'string' || !context.psbtBase64) {
    throw new Error('ceremony context is missing its unsigned PSBT');
  }
  if (typeof context.message !== 'string' || !/^[0-9a-f]{64}$/.test(context.message)) {
    throw new Error('ceremony context message is not a 32-byte sighash');
  }
  const vault = state.vaults.get(context.round);
  if (!vault) throw new Error(`ceremony context names unknown vault round ${context.round}`);
  const currentIds = canonicalParticipantIds(vault);

  // Signer set and aggregate key: recomputed from the roster, never adopted.
  const expectedPubkeys = keySort(vault.keyPath.personalCompressedPubkeys);
  if (
    !Array.isArray(context.sortedPubkeys) ||
    context.sortedPubkeys.length !== expectedPubkeys.length ||
    context.sortedPubkeys.some((pubkey, index) => pubkey !== expectedPubkeys[index])
  ) {
    throw new Error(
      `ceremony context signer set is not the ${vault.id} key-path participants in BIP-327 KeySort order`,
    );
  }
  if (keyAgg(expectedPubkeys).xonlyPubKeyHex !== vault.keyPath.aggregateXonlyPubkey) {
    throw new Error('roster-derived MuSig2 aggregate does not match the round key path');
  }
  if (context.aggregateXonly !== vault.keyPath.aggregateXonlyPubkey) {
    throw new Error(`ceremony context aggregate key is not the ${vault.id} MuSig2 aggregate`);
  }
  if (context.tapMerkleRoot !== vault.tapMerkleRoot) {
    throw new Error(`ceremony context tap merkle root is not the ${vault.id} tap tree`);
  }
  if (vault.keyPath.sigbashXonlyPubkeys.length !== 0) {
    throw new Error('cooperative key path includes Sigbash keys');
  }
  if (trustedInput.scriptPubKeyHex !== vault.outputScriptHex) {
    throw new Error(
      `trusted input scriptPubKey is not the ${vault.id} vault script; this coin is not that round's vault UTXO`,
    );
  }
  if (
    taprootOutputScriptHex(context.aggregateXonly, context.tapMerkleRoot) !== vault.outputScriptHex
  ) {
    throw new Error(
      'the ceremony aggregate key and merkle root do not tweak to the vault output script being spent',
    );
  }

  // Outpoint and value first (they give the sharpest diagnostic), then the
  // byte-for-byte comparison that catches everything else.
  const psbt = bitcoin.Psbt.fromBase64(context.psbtBase64, { network: BITCOIN_NETWORK });
  assertTrustedInputMatchesPsbt('cooperative exit PSBT', psbt, trustedInput);
  const rebuilt = buildCooperativeExitPsbt({
    state,
    currentIds,
    txid: trustedInput.txid,
    vout: trustedInput.vout,
    valueSats: trustedInput.valueSats,
  });
  assertRebuiltPsbtMatches('cooperative exit PSBT', rebuilt.psbtBase64, context.psbtBase64);
  assertNoSignatureMaterial('cooperative exit PSBT', psbt);
  assertUnsignedTransactionShape('cooperative exit PSBT', psbt, {
    version: 2,
    locktime: 0,
    sequence: 0xffffffff,
    outputCount: currentIds.length,
  });
  const input = psbt.data.inputs[0]!;
  if (Buffer.from(input.tapInternalKey ?? []).toString('hex') !== vault.keyPath.aggregateXonlyPubkey) {
    throw new Error('cooperative exit PSBT does not commit to the round MuSig2 internal key');
  }
  if (input.tapLeafScript?.length) {
    throw new Error('cooperative exit PSBT offers a tapscript leaf; the exit is a pure key-path spend');
  }

  const participants = currentIds.map((id) => participantById(state, id));
  const refundSats = Math.floor((trustedInput.valueSats - AMOUNTS.cooperativeFee) / participants.length);
  assertOutputsMatch(
    'cooperative exit PSBT',
    psbt,
    participants.map((participant) => ({
      address: participant.payoutAddress,
      valueSats: refundSats,
    })),
  );
  const feeSats = trustedInput.valueSats - outputTotalSats(psbt);
  if (feeSats < AMOUNTS.cooperativeFee || feeSats >= AMOUNTS.cooperativeFee + participants.length) {
    throw new Error(
      `cooperative exit fee ${feeSats} sats is not the configured ${AMOUNTS.cooperativeFee} sats (plus rounding dust)`,
    );
  }

  const message = keySpendMessage(psbt);
  if (message.toString('hex') !== context.message) {
    throw new Error(
      'ceremony context message is not the BIP-341 key-spend sighash of the authorized transaction',
    );
  }

  return {
    round: vault.id,
    signerIds: currentIds,
    trustedInput,
    outputs: participants.map((participant, index) => ({
      index,
      address: participant.payoutAddress,
      valueSats: refundSats,
    })),
    feeSats,
    messageHex: message.toString('hex'),
    unsignedTxid: unsignedTx(psbt).getId(),
    checks: [
      'ceremony PSBT is byte-for-byte the cooperative exit rebuilt from the roster and the trusted outpoint',
      'input is the trusted outpoint with the trusted value and the round vault script',
      'signer set, MuSig2 aggregate, and tap merkle root are recomputed from the roster and tweak to the spent script',
      'every output pays a roster payout address for the configured cooperative split and fee',
      'no tapscript leaf, no signature material, SIGHASH_DEFAULT only',
      'the context message equals the recomputed BIP-341 key-spend sighash',
    ],
  };
}

/** Round 1: build the unsigned cooperative-exit PSBT and its signing context. */
export function ceremonyStart({
  state,
  currentIds,
  trustedInput,
}: {
  state: VaultState;
  currentIds: string[];
  trustedInput: TrustedVaultInput;
}): CeremonyContext {
  const vault = vaultForRound(state, currentIds);
  // The coordinator builds the PSBT here rather than accepting one, so the
  // context can never be seeded with a foreign transaction.
  const built = buildCooperativeExitPsbt({
    state,
    currentIds: canonicalParticipantIds(vault),
    txid: trustedInput.txid,
    vout: trustedInput.vout,
    valueSats: trustedInput.valueSats,
  });
  const psbt = bitcoin.Psbt.fromBase64(built.psbtBase64, { network: BITCOIN_NETWORK });
  const context: CeremonyContext = {
    round: vault.id,
    aggregateXonly: vault.keyPath.aggregateXonlyPubkey,
    tapMerkleRoot: vault.tapMerkleRoot,
    sortedPubkeys: sortedKeyPathPubkeys(vault),
    message: keySpendMessage(psbt).toString('hex'),
    psbtBase64: built.psbtBase64,
  };
  // Self-check: the context we hand out must pass the same gate every signer
  // applies to it.
  authorizeCooperativeContext({ state, context, trustedInput });
  return context;
}

/** Round 2: one participant generates their single-use nonce. */
export function ceremonyNonce({
  state,
  participantId,
  context,
  trustedInput,
}: {
  state: VaultState;
  participantId: string;
  context: CeremonyContext;
  trustedInput: TrustedVaultInput;
}): {
  participantId: string;
  pubnonce: Hex;
  secnonce: Hex;
  authorization: CooperativeAuthorization;
} {
  const authorization = authorizeCooperativeContext({ state, context, trustedInput });
  const participant = requireLocalSigner(state, participantId, authorization);
  const generated = nonceGen({
    secretKey: Buffer.from(participant.personal.privateKeyHex, 'hex'),
    publicKey: Buffer.from(participant.personal.publicKeyHex, 'hex'),
    aggregateXonly: Buffer.from(context.aggregateXonly, 'hex'),
    message: Buffer.from(context.message, 'hex'),
  });
  return {
    participantId,
    pubnonce: generated.pubnonce.toString('hex'),
    secnonce: generated.secnonce.toString('hex'),
    authorization,
  };
}

// The session's pubkey order and the aggregated nonce both follow the sorted
// key-path order, so signer index i lines up across pubkeys, pubnonces, and
// partial signatures.
function sessionFor(context: CeremonyContext, pubnonces: Record<string, Hex>): SessionContext {
  const orderedPubnonces = context.sortedPubkeys.map((pubkey) =>
    Buffer.from(pubnonceForKey(context, pubnonces, pubkey), 'hex'),
  );
  return {
    aggnonce: nonceAgg(orderedPubnonces),
    pubkeys: context.sortedPubkeys,
    tweaks: [taprootTweak(context.aggregateXonly, context.tapMerkleRoot)],
    isXonly: [true],
    message: Buffer.from(context.message, 'hex'),
  };
}

function pubnonceForKey(
  context: CeremonyContext,
  pubnonces: Record<string, Hex>,
  compressedPubkey: Hex,
): Hex {
  const value = pubnonces[compressedPubkey];
  if (!value) throw new Error(`missing pubnonce for ${compressedPubkey}`);
  return value;
}

/** Round 3: one participant produces their partial signature. */
export function ceremonyPartial({
  state,
  participantId,
  context,
  pubnonces,
  secnonce,
  trustedInput,
}: {
  state: VaultState;
  participantId: string;
  context: CeremonyContext;
  pubnonces: Record<string, Hex>;
  secnonce: Hex;
  trustedInput: TrustedVaultInput;
}): { participantId: string; partialSig: Hex; authorization: CooperativeAuthorization } {
  const authorization = authorizeCooperativeContext({ state, context, trustedInput });
  const participant = requireLocalSigner(state, participantId, authorization);
  assertNonceSet(context, pubnonces);
  const session = sessionFor(context, pubnonces);
  const partialSig = sign(
    Buffer.from(secnonce, 'hex'),
    Buffer.from(participant.personal.privateKeyHex, 'hex'),
    session,
  );
  // Self-check against our own pubnonce and pubkey before broadcasting.
  const signerIndex = context.sortedPubkeys.indexOf(participant.personal.publicKeyHex);
  if (signerIndex === -1) throw new Error('participant is not in the key-path aggregate');
  const pubnonceList = context.sortedPubkeys.map((pubkey) =>
    Buffer.from(pubnonceForKey(context, pubnonces, pubkey), 'hex'),
  );
  if (!partialSigVerify(partialSig, pubnonceList, session, signerIndex)) {
    throw new Error('own partial signature failed verification');
  }
  return { participantId, partialSig: partialSig.toString('hex'), authorization };
}

/** Aggregate partial signatures into the final signed transaction. */
export function ceremonyAggregate({
  state,
  context,
  pubnonces,
  partialSigs,
  trustedInput,
}: {
  state: VaultState;
  context: CeremonyContext;
  pubnonces: Record<string, Hex>;
  partialSigs: Record<string, Hex>;
  trustedInput: TrustedVaultInput;
}): {
  signedPsbtBase64: string;
  transactionHex: string;
  txid: string;
  consensus: ConsensusVerification;
  authorization: CooperativeAuthorization;
} {
  const authorization = authorizeCooperativeContext({ state, context, trustedInput });
  assertNonceSet(context, pubnonces);
  assertPartialSigSet(context, partialSigs);
  const session = sessionFor(context, pubnonces);
  // Verify every partial signature before aggregation.
  context.sortedPubkeys.forEach((pubkey, index) => {
    const partial = partialSigForKey(context, partialSigs, pubkey);
    const pubnonceList = context.sortedPubkeys.map((key) =>
      Buffer.from(pubnonceForKey(context, pubnonces, key), 'hex'),
    );
    if (!partialSigVerify(Buffer.from(partial, 'hex'), pubnonceList, session, index)) {
      throw new Error(`partial signature for ${pubkey} failed verification`);
    }
  });
  const orderedPartials = context.sortedPubkeys.map((pubkey) =>
    Buffer.from(partialSigForKey(context, partialSigs, pubkey), 'hex'),
  );
  const signature = partialSigAgg(orderedPartials, session);

  const outputKey = xonlyOutputKey(context);
  if (!ecc.verifySchnorr(Buffer.from(context.message, 'hex'), outputKey, signature)) {
    throw new Error('aggregated MuSig2 signature is invalid for the taproot output key');
  }

  const psbt = bitcoin.Psbt.fromBase64(context.psbtBase64, { network: BITCOIN_NETWORK });
  psbt.updateInput(0, { tapKeySig: signature });
  psbt.finalizeInput(0);
  const transaction = psbt.extractTransaction();
  if (transaction.getId() !== authorization.unsignedTxid) {
    throw new Error('aggregated transaction is not the transaction the signers authorized');
  }
  // Independent re-verification of the finished article, from the trusted
  // prevout rather than from anything the ceremony produced.
  const consensus = verifyVaultTransaction({
    txHex: transaction.toHex(),
    prevouts: [
      {
        scriptPubKeyHex: trustedInput.scriptPubKeyHex,
        valueSats: trustedInput.valueSats,
      },
    ],
  });
  return {
    signedPsbtBase64: psbt.toBase64(),
    transactionHex: transaction.toHex(),
    txid: transaction.getId(),
    consensus,
    authorization,
  };
}

/**
 * The local participant must be one of this round's signers and must actually
 * hold the private key for the roster pubkey they are signing under. Which
 * participant that is comes from the loaded secret, not from the context.
 */
function requireLocalSigner(
  state: VaultState,
  participantId: string,
  authorization: CooperativeAuthorization,
) {
  const participant = participantById(state, participantId);
  if (!authorization.signerIds.includes(participantId)) {
    throw new Error(`${participantId} is not a signer in round ${authorization.round}`);
  }
  assertOwnedKeypair(participant.personal, `${participantId} personal key`);
  return participant;
}

/** Exactly one well-formed pubnonce per signer, keyed by their roster pubkey. */
function assertNonceSet(context: CeremonyContext, pubnonces: Record<string, Hex>): void {
  assertKeyedBySigners('pubnonce', context, pubnonces, /^[0-9a-f]{132}$/);
}

/** Exactly one well-formed partial signature per signer. */
function assertPartialSigSet(context: CeremonyContext, partialSigs: Record<string, Hex>): void {
  assertKeyedBySigners('partial signature', context, partialSigs, /^[0-9a-f]{64}$/);
}

function assertKeyedBySigners(
  label: string,
  context: CeremonyContext,
  values: Record<string, Hex>,
  shape: RegExp,
): void {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error(`${label} map must be an object keyed by compressed signer pubkey`);
  }
  const supplied = Object.keys(values).sort();
  const expected = [...context.sortedPubkeys].sort();
  if (supplied.join(',') !== expected.join(',')) {
    throw new Error(
      `${label} map must contain exactly one entry per ceremony signer (${expected.length} expected, got ${supplied.length})`,
    );
  }
  for (const pubkey of expected) {
    const value = values[pubkey];
    if (typeof value !== 'string' || !shape.test(value)) {
      throw new Error(`${label} for ${pubkey} is malformed`);
    }
  }
}

function partialSigForKey(
  context: CeremonyContext,
  partialSigs: Record<string, Hex>,
  compressedPubkey: Hex,
): Hex {
  const value = partialSigs[compressedPubkey];
  if (!value) throw new Error(`missing partial signature for ${compressedPubkey}`);
  return value;
}

function xonlyOutputKey(context: CeremonyContext): Buffer {
  const tweak = taprootTweak(context.aggregateXonly, context.tapMerkleRoot);
  const output = ecc.xOnlyPointAddTweak(Buffer.from(context.aggregateXonly, 'hex'), tweak);
  if (!output) throw new Error('failed to derive taproot output key');
  return Buffer.from(output.xOnlyPubkey);
}
