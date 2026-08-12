import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import type { RpcTransaction } from './bitcoin-rpc.js';
import { sha256Hex } from './crypto.js';
import {
  isSupportedFundingInputScript,
  MIN_FUNDING_RELAY_FEE_SATS,
  MIN_SAFE_CHANGE_SATS,
} from './funding.js';
import { BITCOIN_NETWORK } from './network.js';
import { buildFundingPsbt, unsignedTx } from './psbt.js';
import {
  publishedRosterDigest,
  type PublishedRosterArtifact,
} from './roster-ceremony.js';
import { createRosterState } from './vault.js';

export const DEFAULT_FUNDING_FEE_SATS = 600;

export interface FundingInputCommitment {
  version: 1;
  network: 'mainnet';
  vaultId: string;
  rosterDigest: string;
  participantId: string;
  txid: string;
  vout: number;
  valueSats: number;
  scriptPubKeyHex: string;
  changeAddress: string | null;
  sourceOrigin: string;
  confirmations: number;
  observedUnspent: true;
  fundingFeeSats: number;
}

export interface FundingProposal {
  version: 1;
  network: 'mainnet';
  vaultId: string;
  rosterDigest: string;
  fundingFeeSats: number;
  digest: string;
  unsignedTxid: string;
  psbtBase64: string;
  txTemplate: ReturnType<typeof buildFundingPsbt>['txTemplate'];
}

/** Digest of the exact mainnet UTXO evidence and change destination a passkey approves. */
export function fundingInputCommitmentDigest(commitment: FundingInputCommitment): string {
  return sha256Hex(JSON.stringify(canonicalFundingInputCommitment(commitment)));
}

export function validateFundingInputCommitment(
  artifact: PublishedRosterArtifact,
  commitment: FundingInputCommitment,
): FundingInputCommitment {
  const rosterDigest = publishedRosterDigest(artifact);
  if (commitment.version !== 1 || commitment.network !== 'mainnet' || artifact.network !== 'mainnet') {
    throw new Error('funding input commitment must use version 1 on Bitcoin mainnet');
  }
  if (commitment.vaultId !== artifact.vaultId || commitment.rosterDigest !== rosterDigest) {
    throw new Error('funding input commitment belongs to a different confirmed roster');
  }
  const participantIndex = artifact.participants.findIndex((item) => item.id === commitment.participantId);
  if (participantIndex < 0 || artifact.participants.length !== 3) {
    throw new Error('funding input commitment does not name one of the three participants');
  }
  const txid = commitment.txid.toLowerCase();
  const scriptPubKeyHex = commitment.scriptPubKeyHex.toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(txid) || !Number.isSafeInteger(commitment.vout) ||
      commitment.vout < 0 || commitment.vout > 0xffffffff) {
    throw new Error('funding input commitment has an invalid outpoint');
  }
  if (!Number.isSafeInteger(commitment.valueSats) || commitment.valueSats <= 0 ||
      !isSupportedFundingInputScript(scriptPubKeyHex)) {
    throw new Error('funding input must be a positive native P2WPKH or P2TR mainnet output');
  }
  validateFundingFee(commitment.fundingFeeSats, artifact.economics.depositSatsPerParticipant);
  const feeShare = participantFundingFeeShare(
    commitment.fundingFeeSats,
    participantIndex,
    artifact.participants.length,
  );
  const changeSats = commitment.valueSats - artifact.economics.depositSatsPerParticipant - feeShare;
  if (changeSats < 0) throw new Error('funding input cannot cover the committed deposit and fee share');
  if (changeSats > 0 && changeSats < MIN_SAFE_CHANGE_SATS) {
    throw new Error(`funding input would create unsafe ${changeSats} sat change`);
  }
  if (changeSats === 0 && commitment.changeAddress !== null) {
    throw new Error('an exact funding input must not add a change address');
  }
  if (changeSats > 0) {
    if (!commitment.changeAddress) throw new Error('funding input requires a mainnet change address');
    let changeScript: Uint8Array;
    try {
      changeScript = bitcoin.address.toOutputScript(commitment.changeAddress, BITCOIN_NETWORK);
    } catch {
      throw new Error('funding change address is not a valid Bitcoin mainnet address');
    }
    const changeScriptHex = Buffer.from(changeScript).toString('hex');
    if (!isSupportedFundingInputScript(changeScriptHex)) {
      throw new Error('funding change address must be native P2WPKH or P2TR');
    }
    if (changeScriptHex === artifact.funding.outputScriptHex) {
      throw new Error('funding change cannot reuse the committed vault output script');
    }
  }
  if (commitment.observedUnspent !== true || !Number.isSafeInteger(commitment.confirmations) ||
      commitment.confirmations < 1 || commitment.confirmations > 2_000_000) {
    throw new Error('funding input needs a confirmed unspent mainnet observation');
  }
  const source = new URL(commitment.sourceOrigin);
  if (source.origin !== commitment.sourceOrigin || source.protocol !== 'https:') {
    throw new Error('funding input observation source must be an HTTPS origin');
  }
  return canonicalFundingInputCommitment({ ...commitment, txid, scriptPubKeyHex });
}

/** Build the one canonical three-input transaction every participant can reproduce locally. */
export function buildFundingProposal(input: {
  artifact: PublishedRosterArtifact;
  commitments: FundingInputCommitment[];
  fundingFeeSats: number;
}): FundingProposal {
  const rosterDigest = publishedRosterDigest(input.artifact);
  validateFundingFee(input.fundingFeeSats, input.artifact.economics.depositSatsPerParticipant);
  if (input.commitments.length !== 3) {
    throw new Error('funding proposal requires one approved input from each of three participants');
  }
  const validated = input.commitments.map((commitment) =>
    validateFundingInputCommitment(input.artifact, commitment));
  if (validated.some((commitment) => commitment.fundingFeeSats !== input.fundingFeeSats)) {
    throw new Error('funding input approvals commit different total fees');
  }
  const byParticipant = new Map(validated.map((commitment) => [commitment.participantId, commitment]));
  if (byParticipant.size !== 3) throw new Error('funding proposal repeats a participant input');
  const ordered = input.artifact.participants.map((participant) => {
    const commitment = byParticipant.get(participant.id);
    if (!commitment) throw new Error(`funding proposal is missing ${participant.id}`);
    return commitment;
  });
  const outpoints = ordered.map((item) => `${item.txid}:${item.vout}`);
  if (new Set(outpoints).size !== outpoints.length) throw new Error('funding proposal repeats an outpoint');
  const state = createRosterState(input.artifact.participants, undefined, input.artifact.economics);
  const built = buildFundingPsbt({
    state,
    feeSats: input.fundingFeeSats,
    inputs: ordered.map((commitment) => ({
      participantId: commitment.participantId,
      txid: commitment.txid,
      vout: commitment.vout,
      valueSats: commitment.valueSats,
      scriptPubKeyHex: commitment.scriptPubKeyHex,
      ...(commitment.changeAddress ? { changeAddress: commitment.changeAddress } : {}),
    })),
  });
  const digest = sha256Hex(JSON.stringify({
    version: 1,
    network: 'mainnet',
    vaultId: input.artifact.vaultId,
    rosterDigest,
    fundingFeeSats: input.fundingFeeSats,
    psbtBase64: built.psbtBase64,
  }));
  const unsignedTxid = unsignedTx(bitcoin.Psbt.fromBase64(built.psbtBase64)).getId();
  return {
    version: 1,
    network: 'mainnet',
    vaultId: input.artifact.vaultId,
    rosterDigest,
    fundingFeeSats: input.fundingFeeSats,
    digest,
    unsignedTxid,
    psbtBase64: built.psbtBase64,
    txTemplate: built.txTemplate,
  };
}

/** Require the exact non-witness transaction all three passkeys approved. */
export function authorizeConfirmedFundingProposal(
  transaction: RpcTransaction,
  proposal: FundingProposal,
): void {
  const expected = unsignedTx(bitcoin.Psbt.fromBase64(proposal.psbtBase64));
  if (proposal.unsignedTxid !== expected.getId() || transaction.txid !== expected.getId()) {
    throw new Error('confirmed funding transaction is not the passkey-approved proposal transaction');
  }
  if (transaction.version !== expected.version || transaction.locktime !== expected.locktime) {
    throw new Error('confirmed funding transaction changed the approved version or locktime');
  }
  if (transaction.vin.length !== expected.ins.length) {
    throw new Error('confirmed funding transaction changed the approved input count');
  }
  for (const [index, expectedInput] of expected.ins.entries()) {
    const actual = transaction.vin[index];
    const expectedTxid = Buffer.from(expectedInput.hash).reverse().toString('hex');
    if (!actual || actual.txid !== expectedTxid || actual.vout !== expectedInput.index ||
        actual.sequence !== expectedInput.sequence) {
      throw new Error(`confirmed funding transaction changed approved input ${index}`);
    }
  }
  if (transaction.vout.length !== expected.outs.length) {
    throw new Error('confirmed funding transaction changed the approved output count');
  }
  for (const [index, expectedOutput] of expected.outs.entries()) {
    const actual = transaction.vout[index];
    if (!actual || actual.n !== index || actual.scriptPubKey?.hex?.toLowerCase() !==
        Buffer.from(expectedOutput.script).toString('hex') ||
        btcValueToSats(actual.value) !== Number(expectedOutput.value)) {
      throw new Error(`confirmed funding transaction changed approved output ${index}`);
    }
  }
}

function participantFundingFeeShare(totalFeeSats: number, index: number, participantCount: number): number {
  const base = Math.floor(totalFeeSats / participantCount);
  return base + (index === 0 ? totalFeeSats - base * participantCount : 0);
}

function validateFundingFee(feeSats: number, depositSats: number): void {
  if (!Number.isSafeInteger(feeSats) || feeSats < MIN_FUNDING_RELAY_FEE_SATS) {
    throw new Error(`funding fee must be an integer of at least ${MIN_FUNDING_RELAY_FEE_SATS} sats`);
  }
  if (feeSats >= depositSats) throw new Error('funding fee cannot consume a participant deposit');
}

function canonicalFundingInputCommitment(
  commitment: FundingInputCommitment,
): FundingInputCommitment {
  return {
    version: commitment.version,
    network: commitment.network,
    vaultId: commitment.vaultId,
    rosterDigest: commitment.rosterDigest,
    participantId: commitment.participantId,
    txid: commitment.txid.toLowerCase(),
    vout: commitment.vout,
    valueSats: commitment.valueSats,
    scriptPubKeyHex: commitment.scriptPubKeyHex.toLowerCase(),
    changeAddress: commitment.changeAddress,
    sourceOrigin: commitment.sourceOrigin,
    confirmations: commitment.confirmations,
    observedUnspent: commitment.observedUnspent,
    fundingFeeSats: commitment.fundingFeeSats,
  };
}

function btcValueToSats(value: number | string): number {
  const numeric = Number(value);
  const sats = Math.round(numeric * 100_000_000);
  if (!Number.isFinite(numeric) || !Number.isSafeInteger(sats) || sats < 0 ||
      Math.abs(numeric - sats / 100_000_000) > 1e-12) {
    throw new Error('confirmed funding transaction contains an invalid output value');
  }
  return sats;
}
