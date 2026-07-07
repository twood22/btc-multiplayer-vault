import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { keySort, taggedHash } from './crypto.js';
import {
  nonceAgg,
  nonceGen,
  partialSigAgg,
  partialSigVerify,
  sign,
  type SessionContext,
} from './musig2.js';
import type { Hex, VaultRound, VaultState } from './types.js';
import { participantById, roundId } from './vault.js';

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

/** Round 1: build the unsigned cooperative-exit PSBT and its signing context. */
export function ceremonyStart({
  state,
  currentIds,
  txid,
  vout,
  valueSats,
  psbtBase64,
}: {
  state: VaultState;
  currentIds: string[];
  txid: string;
  vout: number;
  valueSats: number;
  psbtBase64: string;
}): CeremonyContext {
  const vault = state.vaults.get(roundId(currentIds));
  if (!vault) throw new Error(`unknown vault round ${roundId(currentIds)}`);
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: bitcoin.networks.testnet });
  const message = keySpendMessage(psbt);
  return {
    round: vault.id,
    aggregateXonly: vault.keyPath.aggregateXonlyPubkey,
    tapMerkleRoot: vault.tapMerkleRoot,
    sortedPubkeys: sortedKeyPathPubkeys(vault),
    message: message.toString('hex'),
    psbtBase64,
  };
}

/** Round 2: one participant generates their single-use nonce. */
export function ceremonyNonce({
  state,
  participantId,
  context,
}: {
  state: VaultState;
  participantId: string;
  context: CeremonyContext;
}): { participantId: string; pubnonce: Hex; secnonce: Hex } {
  const participant = participantById(state, participantId);
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
}: {
  state: VaultState;
  participantId: string;
  context: CeremonyContext;
  pubnonces: Record<string, Hex>;
  secnonce: Hex;
}): { participantId: string; partialSig: Hex } {
  const participant = participantById(state, participantId);
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
  return { participantId, partialSig: partialSig.toString('hex') };
}

/** Aggregate partial signatures into the final signed transaction. */
export function ceremonyAggregate({
  context,
  pubnonces,
  partialSigs,
}: {
  context: CeremonyContext;
  pubnonces: Record<string, Hex>;
  partialSigs: Record<string, Hex>;
}): { signedPsbtBase64: string; transactionHex: string; txid: string } {
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

  const psbt = bitcoin.Psbt.fromBase64(context.psbtBase64, { network: bitcoin.networks.testnet });
  psbt.updateInput(0, { tapKeySig: signature });
  psbt.finalizeInput(0);
  const transaction = psbt.extractTransaction();
  return {
    signedPsbtBase64: psbt.toBase64(),
    transactionHex: transaction.toHex(),
    txid: transaction.getId(),
  };
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
