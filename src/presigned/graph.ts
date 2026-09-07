import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { buildPresignedRounds, payoutScript, validatePresignedRoster } from './roster.js';
import {
  PARTICIPANT_IDS, PRESIGNED_PROTOCOL, type ParticipantId, type PresignedExit,
  type PresignedFundingTemplate, type PresignedGraph, type PresignedRoster, type PresignedRound,
} from './types.js';
import {
  assert, commitmentDigest, exactKeys, hexBytes, identifier, networkParameters,
  participantId, roundId, safeInteger, sameCanonical, supportedWalletScript,
} from './validation.js';

const MAX_MONEY = 2_100_000_000_000_000;

export function buildPresignedGraph(input: {
  roster: PresignedRoster;
  funding: PresignedFundingTemplate;
}): PresignedGraph {
  const roster = validatePresignedRoster(input.roster);
  const rosterDigest = commitmentDigest('vault/presigned-graph-v2/roster', roster);
  const rounds = buildPresignedRounds(roster);
  const full = rounds.find(round => round.id === roundId(PARTICIPANT_IDS))!;
  const funding = validateFunding(roster, rounds, input.funding);
  const fundingPsbt = new bitcoin.Psbt({ network: networkParameters(roster.network) });
  // Funding opts into the same bounded-topology relay policy. Every wallet
  // retains its own refundable change so any participant can sponsor rescue.
  fundingPsbt.setVersion(3);
  fundingPsbt.setLocktime(0);
  funding.inputs.forEach(coin => fundingPsbt.addInput({
    hash: coin.txid, index: coin.vout, sequence: 0xffffffff,
    witnessUtxo: { script: Buffer.from(coin.scriptPubKeyHex, 'hex'), value: BigInt(coin.valueSats) },
  }));
  fundingPsbt.addOutput({ script: Buffer.from(full.outputScriptHex, 'hex'), value: BigInt(roster.economics.depositSatsPerParticipant * 3) });
  funding.inputs.forEach((coin, index) => {
    const change = coin.valueSats - roster.economics.depositSatsPerParticipant - fundingFeeShare(funding.feeSats, index);
    if (change > 0) fundingPsbt.addOutput({ script: Buffer.from(coin.changeScriptPubKeyHex!, 'hex'), value: BigInt(change) });
  });
  const fundingTx = psbtUnsignedTransaction(fundingPsbt);
  const exits: PresignedExit[] = [];
  for (const first of PARTICIPANT_IDS) {
    const remaining = PARTICIPANT_IDS.filter(id => id !== first);
    const pair = rounds.find(round => round.id === roundId(remaining))!;
    const firstFee = roster.economics.soloWithdrawalFeeSats;
    const pairValue = roster.economics.depositSatsPerParticipant * 3 - roster.economics.firstWithdrawalSats - firstFee;
    const firstExit = buildExit({ roster, round: full, firstLeaver: first, leaver: first,
      parentExit: null, inputTxid: fundingTx.getId(), inputVout: 0,
      inputValueSats: roster.economics.depositSatsPerParticipant * 3,
      payoutValue: roster.economics.firstWithdrawalSats, successorValue: pairValue,
      successorScript: Buffer.from(pair.outputScriptHex, 'hex'), finalParticipant: null });
    exits.push(firstExit);
    for (const second of remaining) {
      const finalParticipant = remaining.find(id => id !== second)!;
      exits.push(buildExit({ roster, round: pair, firstLeaver: first, leaver: second,
        parentExit: firstExit, inputTxid: firstExit.txid, inputVout: 1, inputValueSats: pairValue,
        payoutValue: roster.economics.secondWithdrawalSats,
        successorValue: pairValue - roster.economics.secondWithdrawalSats - firstFee * 2,
        successorScript: payoutScript(roster, finalParticipant), finalParticipant }));
    }
  }
  exits.sort((a, b) => a.id.localeCompare(b.id));
  assert(exits.length === 9 && new Set(exits.map(exit => exit.txid)).size === 9, 'exit graph is not nine distinct transactions');
  const body = { version: 2 as const, protocol: PRESIGNED_PROTOCOL, roster, rosterDigest, funding,
    fundingUnsignedTxHex: fundingTx.toHex(), fundingPsbtBase64: fundingPsbt.toBase64(), fundingTxid: fundingTx.getId(), rounds, exits };
  return { ...body, digest: commitmentDigest('vault/presigned-graph-v2/graph', body) };
}

/** Never trust serialized scripts, PSBTs, txids, sighashes, fees or digests. */
export function validatePresignedGraph(input: PresignedGraph): PresignedGraph {
  exactKeys(input, ['version', 'protocol', 'roster', 'rosterDigest', 'funding', 'fundingUnsignedTxHex', 'fundingPsbtBase64', 'fundingTxid', 'rounds', 'exits', 'digest'], 'graph');
  assert(input.version === 2 && input.protocol === PRESIGNED_PROTOCOL, 'wrong graph protocol');
  assert(Array.isArray(input.rounds) && input.rounds.length === 4 && Array.isArray(input.exits) && input.exits.length === 9, 'graph has wrong topology');
  const rebuilt = buildPresignedGraph({ roster: input.roster, funding: input.funding });
  sameCanonical(input, rebuilt, 'graph');
  return rebuilt;
}

export function psbtUnsignedTransaction(psbt: bitcoin.Psbt): bitcoin.Transaction {
  return bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
}

export function nonWitnessTransactionHex(tx: bitcoin.Transaction): string {
  const copy = tx.clone();
  copy.ins.forEach(input => { input.witness = []; });
  return copy.toHex();
}

export function fundingFeeShare(feeSats: number, participantIndex: number): number {
  safeInteger(feeSats, 1, MAX_MONEY, 'funding fee');
  safeInteger(participantIndex, 0, 2, 'funding participant index');
  return Math.floor(feeSats / 3) + (participantIndex < feeSats % 3 ? 1 : 0);
}

function validateFunding(roster: PresignedRoster, rounds: PresignedRound[], input: PresignedFundingTemplate): PresignedFundingTemplate {
  exactKeys(input, ['epochId', 'inputs', 'feeSats'], 'funding template');
  identifier(input.epochId, 'funding epoch');
  safeInteger(input.feeSats, 1, Math.min(100_000_000, roster.economics.depositSatsPerParticipant), 'funding fee');
  assert(Array.isArray(input.inputs) && input.inputs.length === 3, 'one funding coin per participant required');
  const inputs = input.inputs.map(coin => {
    exactKeys(coin, ['participantId', 'txid', 'vout', 'valueSats', 'scriptPubKeyHex', 'changeScriptPubKeyHex', 'confirmationBlockHash', 'confirmations'], 'funding coin');
    participantId(coin.participantId);
    hexBytes(coin.txid, 32, 'funding txid');
    hexBytes(coin.confirmationBlockHash, 32, 'funding block anchor');
    safeInteger(coin.vout, 0, 0xffffffff, 'funding vout');
    safeInteger(coin.valueSats, 1, MAX_MONEY / 3, 'funding value');
    safeInteger(coin.confirmations, 1, 2_000_000, 'funding confirmations');
    assert(supportedWalletScript(coin.scriptPubKeyHex), 'funding requires native P2WPKH or P2TR');
    return { ...coin };
  }).sort((a, b) => a.participantId.localeCompare(b.participantId));
  assert(inputs.map(coin => coin.participantId).join(',') === PARTICIPANT_IDS.join(','), 'funding repeats or omits a participant');
  assert(new Set(inputs.map(coin => `${coin.txid}:${coin.vout}`)).size === 3, 'funding repeats an outpoint');
  inputs.forEach((coin, index) => {
    const change = coin.valueSats - roster.economics.depositSatsPerParticipant - fundingFeeShare(input.feeSats, index);
    assert(change >= 330, 'each funding input must cover its deposit, fee share and at least 330 refundable change sats');
    assert(coin.changeScriptPubKeyHex === coin.scriptPubKeyHex,
      'funding refund must return to the proven funding-input wallet script for independent fee rescue');
    assert(!rounds.some(round => coin.changeScriptPubKeyHex === round.outputScriptHex),
      'funding change must not recreate a vault coin');
  });
  return { epochId: input.epochId, inputs, feeSats: input.feeSats };
}

function buildExit(input: {
  roster: PresignedRoster; round: PresignedRound; firstLeaver: ParticipantId; leaver: ParticipantId;
  parentExit: PresignedExit | null; inputTxid: string; inputVout: number; inputValueSats: number;
  payoutValue: number; successorValue: number; successorScript: Buffer; finalParticipant: ParticipantId | null;
}): PresignedExit {
  assert(input.payoutValue >= 330 && input.successorValue >= 330, 'exit would create dust');
  const psbt = new bitcoin.Psbt({ network: networkParameters(input.roster.network) });
  // BIP431 opt-in restricts unconfirmed descendants and enables sibling
  // eviction for payout-funded CPFP. Funding uses V3 too and must confirm
  // before the application offers a game exit for relay.
  psbt.setVersion(3);
  psbt.setLocktime(0);
  psbt.addInput({ hash: input.inputTxid, index: input.inputVout, sequence: 0xffffffff,
    witnessUtxo: { value: BigInt(input.inputValueSats), script: Buffer.from(input.round.outputScriptHex, 'hex') },
    tapInternalKey: Buffer.from(input.round.internalKeyHex, 'hex'), tapMerkleRoot: Buffer.from(input.round.tapMerkleRoot, 'hex'),
    tapLeafScript: [{ leafVersion: 0xc0, script: Buffer.from(input.round.solo.scriptHex, 'hex'), controlBlock: Buffer.from(input.round.solo.controlBlockHex, 'hex') }] });
  psbt.addOutput({ script: payoutScript(input.roster, input.leaver), value: BigInt(input.payoutValue) });
  psbt.addOutput({ script: input.successorScript, value: BigInt(input.successorValue) });
  const tx = psbtUnsignedTransaction(psbt);
  const signatureHash = tx.hashForWitnessV1(0, [Buffer.from(input.round.outputScriptHex, 'hex')], [BigInt(input.inputValueSats)], bitcoin.Transaction.SIGHASH_DEFAULT, Buffer.from(input.round.solo.leafHash, 'hex'));
  return { id: input.parentExit ? `${input.firstLeaver}/${input.leaver}` : input.leaver,
    roundId: input.round.id, firstLeaver: input.firstLeaver, leaver: input.leaver,
    finalParticipant: input.finalParticipant, parentExitId: input.parentExit?.id ?? null,
    inputTxid: input.inputTxid, inputVout: input.inputVout, inputValueSats: input.inputValueSats,
    inputScriptPubKeyHex: input.round.outputScriptHex, unsignedTxHex: tx.toHex(), txid: tx.getId(),
    psbtBase64: psbt.toBase64(), feeSats: input.inputValueSats - input.payoutValue - input.successorValue,
    signatureHash: Buffer.from(signatureHash).toString('hex') };
}
