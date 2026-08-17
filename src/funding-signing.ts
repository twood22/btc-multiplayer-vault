import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import type { RpcMempoolAcceptResult, RpcTransaction } from './bitcoin-rpc.js';
import { sha256Hex } from './crypto.js';
import type { FundingInputCommitment, FundingProposal } from './funding-ceremony.js';
import { BITCOIN_NETWORK } from './network.js';
import { unsignedTx } from './psbt.js';

bitcoin.initEccLib(ecc);

export type FundingSignatureContribution = {
  version: 1;
  network: 'mainnet';
  vaultId: string;
  rosterDigest: string;
  proposalDigest: string;
  participantId: string;
  inputIndex: number;
  kind: 'p2wpkh';
  signatureHex: string;
  publicKeyHex: string;
} | {
  version: 1;
  network: 'mainnet';
  vaultId: string;
  rosterDigest: string;
  proposalDigest: string;
  participantId: string;
  inputIndex: number;
  kind: 'p2tr';
  signatureHex: string;
  publicKeyHex: null;
};

export interface FinalizedFundingTransaction {
  version: 1;
  network: 'mainnet';
  vaultId: string;
  rosterDigest: string;
  proposalDigest: string;
  finalizationDigest: string;
  finalTxid: string;
  transactionHex: string;
  feeSats: number;
  vsize: number;
}

export interface FundingRestartSnapshot {
  version: 1;
  network: 'mainnet';
  vaultId: string;
  rosterDigest: string;
  inputs: Array<{ participantId: string; commitmentDigest: string }>;
  signatures: Array<{ participantId: string; contributionDigest: string }>;
  finalization: {
    finalizationDigest: string;
    status: 'awaiting_approvals' | 'approved';
  } | null;
}

export function canonicalFundingRestartReason(reason: string): string {
  const canonical = reason.trim().replace(/\s+/gu, ' ');
  if (canonical.length < 10 || canonical.length > 500) {
    throw new Error('funding restart reason must be between 10 and 500 characters');
  }
  return canonical;
}

export function fundingRestartStateDigest(snapshot: FundingRestartSnapshot): string {
  const canonical = canonicalFundingRestartSnapshot(snapshot);
  return sha256Hex(JSON.stringify(canonical));
}

export function fundingRestartApprovalDigest(input: {
  snapshot: FundingRestartSnapshot;
  reason: string;
}): string {
  return sha256Hex(JSON.stringify({
    version: 1,
    network: 'mainnet',
    stateDigest: fundingRestartStateDigest(input.snapshot),
    reason: canonicalFundingRestartReason(input.reason),
  }));
}

export function canonicalFundingRestartSnapshot(
  snapshot: FundingRestartSnapshot,
): FundingRestartSnapshot {
  if (snapshot.version !== 1 || snapshot.network !== 'mainnet' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(snapshot.vaultId) ||
      !/^[0-9a-f]{64}$/u.test(snapshot.rosterDigest)) {
    throw new Error('funding restart snapshot has an invalid mainnet binding');
  }
  const inputs = [...snapshot.inputs].sort(compareParticipantBinding);
  const signatures = [...snapshot.signatures].sort(compareParticipantBinding);
  assertDistinctParticipantBindings(inputs, 'funding input');
  assertDistinctParticipantBindings(signatures, 'funding signature');
  for (const item of inputs) assertDigest(item.commitmentDigest, 'funding input commitment');
  for (const item of signatures) assertDigest(item.contributionDigest, 'funding signature contribution');
  if (snapshot.finalization) {
    assertDigest(snapshot.finalization.finalizationDigest, 'funding finalization');
    if (!['awaiting_approvals', 'approved'].includes(snapshot.finalization.status)) {
      throw new Error('broadcast or confirmed funding cannot be restarted');
    }
  }
  return {
    version: 1,
    network: 'mainnet',
    vaultId: snapshot.vaultId,
    rosterDigest: snapshot.rosterDigest,
    inputs,
    signatures,
    finalization: snapshot.finalization ? { ...snapshot.finalization } : null,
  };
}

/** Require the exact witness serialization unanimously approved by the three participants. */
export function authorizeObservedFinalizedFundingTransaction(input: {
  transaction: RpcTransaction;
  finalization: FinalizedFundingTransaction;
}): void {
  const observedHex = input.transaction.hex?.toLowerCase();
  if (!observedHex || !/^(?:[0-9a-f]{2})+$/u.test(observedHex)) {
    throw new Error('Bitcoin backend did not return the exact finalized funding transaction bytes');
  }
  if (observedHex !== input.finalization.transactionHex) {
    throw new Error('confirmed funding transaction witness bytes differ from unanimous passkey approval');
  }
  let parsed: bitcoin.Transaction;
  try {
    parsed = bitcoin.Transaction.fromHex(observedHex);
  } catch {
    throw new Error('Bitcoin backend returned malformed finalized funding transaction bytes');
  }
  if (parsed.getId() !== input.finalization.finalTxid ||
      input.transaction.txid !== input.finalization.finalTxid) {
    throw new Error('confirmed funding transaction id differs from unanimous passkey approval');
  }
}

export function authorizeFundingMempoolAcceptance(input: {
  results: RpcMempoolAcceptResult[];
  finalization: FinalizedFundingTransaction;
}): void {
  const result = input.results[0];
  if (input.results.length !== 1 || !result || result.txid !== input.finalization.finalTxid) {
    throw new Error('Bitcoin Core tested a different funding transaction');
  }
  if (result.allowed !== true) {
    throw new Error(`Bitcoin Core rejected exact funding transaction: ${result['reject-reason'] || 'unknown reason'}`);
  }
  if (result.vsize !== input.finalization.vsize) {
    throw new Error('Bitcoin Core calculated a different funding transaction vsize');
  }
  if (result.fees?.base === undefined ||
      btcFeeToSats(result.fees.base) !== input.finalization.feeSats) {
    throw new Error('Bitcoin Core calculated a different funding transaction fee');
  }
}

function compareParticipantBinding(
  left: { participantId: string },
  right: { participantId: string },
): number {
  return left.participantId.localeCompare(right.participantId);
}

function assertDistinctParticipantBindings(
  items: Array<{ participantId: string }>,
  label: string,
): void {
  if (items.length > 3 || new Set(items.map((item) => item.participantId)).size !== items.length ||
      items.some((item) => !['alice', 'bob', 'carol'].includes(item.participantId))) {
    throw new Error(`${label} restart bindings are not one per participant`);
  }
}

function assertDigest(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} digest is invalid`);
}

function btcFeeToSats(value: number): number {
  const sats = Math.round(value * 100_000_000);
  if (!Number.isFinite(value) || !Number.isSafeInteger(sats) || sats < 0 ||
      Math.abs(value - sats / 100_000_000) > 1e-12) {
    throw new Error('Bitcoin Core returned an invalid funding fee');
  }
  return sats;
}

/** Normalize exactly one participant's wallet signature and discard all wallet metadata. */
export function authorizeFundingSignedPsbt(input: {
  proposal: FundingProposal;
  commitments: FundingInputCommitment[];
  participantId: string;
  signedPsbtBase64: string;
}): { contribution: FundingSignatureContribution; contributionDigest: string } {
  if (!input.signedPsbtBase64 || input.signedPsbtBase64.length > 400_000) {
    throw new Error('signed funding PSBT is empty or too large');
  }
  const canonical = parsePsbt(input.proposal.psbtBase64, 'approved funding PSBT');
  const submitted = parsePsbt(input.signedPsbtBase64, 'wallet-signed funding PSBT');
  const canonicalTx = unsignedTx(canonical);
  const submittedTx = unsignedTx(submitted);
  if (canonicalTx.toHex() !== submittedTx.toHex() || canonicalTx.getId() !== input.proposal.unsignedTxid) {
    throw new Error('wallet changed the passkey-approved funding transaction');
  }
  if (canonical.inputCount !== 3 || submitted.inputCount !== 3 || input.commitments.length !== 3) {
    throw new Error('funding signature authorization requires exactly three inputs');
  }
  const inputIndex = input.proposal.txTemplate.inputs.findIndex(
    (item) => item.participantId === input.participantId,
  );
  if (inputIndex < 0) throw new Error('participant has no input in the approved funding proposal');
  const orderedCommitments = input.proposal.txTemplate.inputs.map((template) => {
    const commitment = input.commitments.find((item) => item.participantId === template.participantId);
    if (!commitment) throw new Error(`approved funding commitment is missing ${template.participantId}`);
    if (commitment.txid !== template.txid || commitment.vout !== template.vout ||
        commitment.valueSats !== template.valueSats ||
        commitment.scriptPubKeyHex !== template.scriptPubKeyHex) {
      throw new Error(`approved funding commitment differs from PSBT input for ${template.participantId}`);
    }
    return commitment;
  });
  for (let index = 0; index < 3; index += 1) {
    assertExactWitnessUtxo(canonical, submitted, index);
    if (index !== inputIndex && hasSignatureMaterial(submitted.data.inputs[index]!)) {
      throw new Error(`wallet-signed PSBT carries a signature for another participant input ${index}`);
    }
  }
  const target = submitted.data.inputs[inputIndex]!;
  const commitment = orderedCommitments[inputIndex]!;
  const script = Buffer.from(commitment.scriptPubKeyHex, 'hex');
  let contribution: FundingSignatureContribution;
  if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14) {
    const material = extractP2wpkhMaterial(target);
    verifyP2wpkhSignature(canonicalTx, inputIndex, commitment.valueSats, script, material);
    contribution = {
      ...contributionBinding(input.proposal, input.participantId, inputIndex),
      kind: 'p2wpkh',
      signatureHex: material.signature.toString('hex'),
      publicKeyHex: material.publicKey.toString('hex'),
    };
  } else if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) {
    const signature = extractP2trSignature(target);
    verifyP2trSignature(canonical, canonicalTx, inputIndex, script, signature);
    contribution = {
      ...contributionBinding(input.proposal, input.participantId, inputIndex),
      kind: 'p2tr',
      signatureHex: signature.toString('hex'),
      publicKeyHex: null,
    };
  } else {
    throw new Error('approved funding input is not native P2WPKH or P2TR');
  }
  return {
    contribution,
    contributionDigest: fundingSignatureContributionDigest(contribution),
  };
}

export function fundingSignatureContributionDigest(contribution: FundingSignatureContribution): string {
  const binding = {
    version: contribution.version,
    network: contribution.network,
    vaultId: contribution.vaultId,
    rosterDigest: contribution.rosterDigest,
    proposalDigest: contribution.proposalDigest,
    participantId: contribution.participantId,
    inputIndex: contribution.inputIndex,
    kind: contribution.kind,
    signatureHex: contribution.signatureHex,
    publicKeyHex: contribution.publicKeyHex,
  };
  return sha256Hex(JSON.stringify(binding));
}

export function validateFundingSignatureContribution(input: {
  proposal: FundingProposal;
  commitments: FundingInputCommitment[];
  contribution: FundingSignatureContribution;
}): void {
  const contribution = input.contribution;
  const expectedIndex = input.proposal.txTemplate.inputs.findIndex(
    (item) => item.participantId === contribution.participantId,
  );
  const commitment = input.commitments.find((item) => item.participantId === contribution.participantId);
  if (!commitment || expectedIndex < 0 || contribution.inputIndex !== expectedIndex ||
      contribution.version !== 1 || contribution.network !== 'mainnet' ||
      contribution.vaultId !== input.proposal.vaultId ||
      contribution.rosterDigest !== input.proposal.rosterDigest ||
      contribution.proposalDigest !== input.proposal.digest) {
    throw new Error(`funding signature contribution for ${contribution.participantId} has the wrong binding`);
  }
  const psbt = parsePsbt(input.proposal.psbtBase64, 'approved funding PSBT');
  const tx = unsignedTx(psbt);
  const script = Buffer.from(commitment.scriptPubKeyHex, 'hex');
  if (contribution.kind === 'p2wpkh') {
    verifyP2wpkhSignature(tx, expectedIndex, commitment.valueSats, script, {
      signature: strictHex(contribution.signatureHex, 'P2WPKH signature'),
      publicKey: strictHex(contribution.publicKeyHex, 'P2WPKH public key'),
    });
  } else {
    verifyP2trSignature(
      psbt,
      tx,
      expectedIndex,
      script,
      strictHex(contribution.signatureHex, 'P2TR signature'),
    );
  }
}

/** Apply only normalized verified signatures to the pristine approved PSBT and finalize it. */
export function finalizeFundingSignatures(input: {
  proposal: FundingProposal;
  commitments: FundingInputCommitment[];
  contributions: FundingSignatureContribution[];
}): FinalizedFundingTransaction {
  if (input.contributions.length !== 3) {
    throw new Error(`funding finalization requires three wallet signatures, got ${input.contributions.length}`);
  }
  const psbt = parsePsbt(input.proposal.psbtBase64, 'approved funding PSBT');
  const tx = unsignedTx(psbt);
  const participantIds = input.proposal.txTemplate.inputs.map((item) => item.participantId);
  const byParticipant = new Map(input.contributions.map((item) => [item.participantId, item]));
  if (byParticipant.size !== 3 || participantIds.some((participantId) => !byParticipant.has(participantId))) {
    throw new Error('funding finalization needs one distinct signature from alice, bob, and carol');
  }
  for (const [index, participantId] of participantIds.entries()) {
    const contribution = byParticipant.get(participantId)!;
    const commitment = input.commitments.find((item) => item.participantId === participantId);
    validateFundingSignatureContribution({
      proposal: input.proposal,
      commitments: input.commitments,
      contribution,
    });
    if (!commitment || contribution.inputIndex !== index) throw new Error('funding signature input ordering changed');
    const script = Buffer.from(commitment.scriptPubKeyHex, 'hex');
    if (contribution.kind === 'p2wpkh') {
      const material = {
        signature: strictHex(contribution.signatureHex, 'P2WPKH signature'),
        publicKey: strictHex(contribution.publicKeyHex, 'P2WPKH public key'),
      };
      verifyP2wpkhSignature(tx, index, commitment.valueSats, script, material);
      psbt.updateInput(index, { partialSig: [{ pubkey: material.publicKey, signature: material.signature }] });
    } else {
      const signature = strictHex(contribution.signatureHex, 'P2TR signature');
      verifyP2trSignature(psbt, tx, index, script, signature);
      psbt.updateInput(index, { tapKeySig: signature });
    }
    psbt.finalizeInput(index);
  }
  const finalized = psbt.extractTransaction();
  if (finalized.getId() !== input.proposal.unsignedTxid) {
    throw new Error('finalized funding transaction id differs from the approved proposal');
  }
  const inputTotal = input.commitments.reduce((sum, item) => sum + item.valueSats, 0);
  const outputTotal = finalized.outs.reduce((sum, output) => sum + Number(output.value), 0);
  const feeSats = inputTotal - outputTotal;
  if (feeSats !== input.proposal.fundingFeeSats) {
    throw new Error('finalized funding transaction fee differs from the approved proposal');
  }
  const vsize = finalized.virtualSize();
  if (feeSats < vsize) {
    throw new Error(`approved funding fee ${feeSats} sats is below 1 sat/vB for ${vsize} vbytes`);
  }
  const transactionHex = finalized.toHex();
  const finalTxid = finalized.getId();
  const binding = {
    version: 1 as const,
    network: 'mainnet' as const,
    vaultId: input.proposal.vaultId,
    rosterDigest: input.proposal.rosterDigest,
    proposalDigest: input.proposal.digest,
    finalTxid,
    transactionHex,
    feeSats,
    vsize,
  };
  return {
    ...binding,
    finalizationDigest: sha256Hex(JSON.stringify(binding)),
  };
}

function contributionBinding(proposal: FundingProposal, participantId: string, inputIndex: number) {
  return {
    version: 1 as const,
    network: 'mainnet' as const,
    vaultId: proposal.vaultId,
    rosterDigest: proposal.rosterDigest,
    proposalDigest: proposal.digest,
    participantId,
    inputIndex,
  };
}

function parsePsbt(base64: string, label: string): bitcoin.Psbt {
  try {
    return bitcoin.Psbt.fromBase64(base64, { network: BITCOIN_NETWORK });
  } catch {
    throw new Error(`${label} is malformed`);
  }
}

function assertExactWitnessUtxo(canonical: bitcoin.Psbt, submitted: bitcoin.Psbt, index: number): void {
  const expected = canonical.data.inputs[index]?.witnessUtxo;
  const actual = submitted.data.inputs[index]?.witnessUtxo;
  if (!expected || !actual || expected.value !== actual.value ||
      !Buffer.from(expected.script).equals(Buffer.from(actual.script))) {
    throw new Error(`wallet changed witness UTXO metadata for funding input ${index}`);
  }
}

function hasSignatureMaterial(input: bitcoin.Psbt['data']['inputs'][number]): boolean {
  return Boolean(input.partialSig?.length || input.tapKeySig || input.tapScriptSig?.length ||
    input.finalScriptSig || input.finalScriptWitness);
}

function extractP2wpkhMaterial(input: bitcoin.Psbt['data']['inputs'][number]): {
  signature: Buffer;
  publicKey: Buffer;
} {
  if (input.finalScriptSig) throw new Error('native P2WPKH funding input must not have finalScriptSig');
  if (input.tapKeySig || input.tapScriptSig?.length) {
    throw new Error('P2WPKH funding input carries Taproot signature material');
  }
  if (input.finalScriptWitness) {
    if (input.partialSig?.length) throw new Error('P2WPKH input mixes final and partial signatures');
    const witness = decodeScriptWitness(Buffer.from(input.finalScriptWitness));
    if (witness.length !== 2) throw new Error('finalized P2WPKH funding witness must contain signature and public key');
    return { signature: witness[0]!, publicKey: witness[1]! };
  }
  if (input.partialSig?.length !== 1) {
    throw new Error('P2WPKH funding input must contain exactly one wallet signature');
  }
  return {
    signature: Buffer.from(input.partialSig[0]!.signature),
    publicKey: Buffer.from(input.partialSig[0]!.pubkey),
  };
}

function extractP2trSignature(input: bitcoin.Psbt['data']['inputs'][number]): Buffer {
  if (input.finalScriptSig) throw new Error('native P2TR funding input must not have finalScriptSig');
  if (input.partialSig?.length || input.tapScriptSig?.length || input.tapLeafScript?.length) {
    throw new Error('P2TR funding input must use one key-path signature');
  }
  if (input.finalScriptWitness) {
    if (input.tapKeySig) throw new Error('P2TR input mixes final and key signatures');
    const witness = decodeScriptWitness(Buffer.from(input.finalScriptWitness));
    if (witness.length !== 1) throw new Error('finalized P2TR funding witness must contain one key-path signature');
    return witness[0]!;
  }
  if (!input.tapKeySig) throw new Error('P2TR funding input is missing its key-path signature');
  return Buffer.from(input.tapKeySig);
}

function verifyP2wpkhSignature(
  tx: bitcoin.Transaction,
  index: number,
  valueSats: number,
  script: Buffer,
  material: { signature: Buffer; publicKey: Buffer },
): void {
  if (script.length !== 22 || script[0] !== 0 || script[1] !== 20 || material.publicKey.length !== 33 ||
      !bitcoin.script.isCanonicalPubKey(material.publicKey) ||
      !Buffer.from(bitcoin.crypto.hash160(material.publicKey)).equals(script.subarray(2))) {
    throw new Error(`funding input ${index} P2WPKH public key does not match its output`);
  }
  let decoded: { signature: Uint8Array; hashType: number };
  try {
    decoded = bitcoin.script.signature.decode(material.signature);
  } catch {
    throw new Error(`funding input ${index} P2WPKH signature is not canonical DER`);
  }
  if (decoded.hashType !== bitcoin.Transaction.SIGHASH_ALL) {
    throw new Error(`funding input ${index} P2WPKH signature must commit all inputs and outputs`);
  }
  const scriptCode = bitcoin.payments.p2pkh({ hash: script.subarray(2), network: BITCOIN_NETWORK }).output;
  if (!scriptCode) throw new Error('could not construct P2WPKH script code');
  const sighash = tx.hashForWitnessV0(index, scriptCode, BigInt(valueSats), decoded.hashType);
  if (!ecc.verify(sighash, material.publicKey, decoded.signature)) {
    throw new Error(`funding input ${index} P2WPKH signature is invalid`);
  }
}

function verifyP2trSignature(
  psbt: bitcoin.Psbt,
  tx: bitcoin.Transaction,
  index: number,
  script: Buffer,
  signatureWithHashType: Buffer,
): void {
  if (script.length !== 34 || script[0] !== 0x51 || script[1] !== 0x20 ||
      (signatureWithHashType.length !== 64 && signatureWithHashType.length !== 65)) {
    throw new Error(`funding input ${index} P2TR signature is malformed`);
  }
  const hashType = signatureWithHashType.length === 64
    ? bitcoin.Transaction.SIGHASH_DEFAULT
    : signatureWithHashType[64]!;
  if (hashType !== bitcoin.Transaction.SIGHASH_DEFAULT && hashType !== bitcoin.Transaction.SIGHASH_ALL) {
    throw new Error(`funding input ${index} P2TR signature must commit all inputs and outputs`);
  }
  const prevoutScripts = psbt.data.inputs.map((item, inputIndex) => {
    if (!item.witnessUtxo) throw new Error(`funding input ${inputIndex} is missing witness UTXO data`);
    return item.witnessUtxo.script;
  });
  const prevoutValues = psbt.data.inputs.map((item) => item.witnessUtxo!.value);
  const sighash = tx.hashForWitnessV1(index, prevoutScripts, prevoutValues, hashType);
  if (!ecc.verifySchnorr(sighash, script.subarray(2), signatureWithHashType.subarray(0, 64))) {
    throw new Error(`funding input ${index} P2TR key-path signature is invalid`);
  }
}

function strictHex(value: string, label: string): Buffer {
  if (!/^[0-9a-f]+$/u.test(value) || value.length % 2 !== 0) throw new Error(`${label} is malformed`);
  return Buffer.from(value, 'hex');
}

function decodeScriptWitness(buffer: Buffer): Buffer[] {
  let offset = 0;
  const readCompactSize = (): number => {
    if (offset >= buffer.length) throw new Error('final funding witness is truncated');
    const marker = buffer[offset++]!;
    if (marker < 0xfd) return marker;
    const bytes = marker === 0xfd ? 2 : marker === 0xfe ? 4 : 8;
    if (offset + bytes > buffer.length) throw new Error('final funding witness compact size is truncated');
    let value = 0n;
    for (let index = 0; index < bytes; index += 1) {
      value |= BigInt(buffer[offset + index]!) << BigInt(index * 8);
    }
    offset += bytes;
    const minimum = bytes === 2 ? 0xfdn : bytes === 4 ? 0x10000n : 0x100000000n;
    if (value < minimum || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('final funding witness uses a non-canonical compact size');
    }
    return Number(value);
  };
  const count = readCompactSize();
  if (count > 100) throw new Error('final funding witness has too many elements');
  const stack: Buffer[] = [];
  for (let index = 0; index < count; index += 1) {
    const length = readCompactSize();
    if (offset + length > buffer.length) throw new Error('final funding witness element is truncated');
    stack.push(buffer.subarray(offset, offset + length));
    offset += length;
  }
  if (offset !== buffer.length) throw new Error('final funding witness has trailing bytes');
  return stack;
}
