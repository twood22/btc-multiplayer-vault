import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { validateVaultEconomics } from '../config.js';
import { deterministicKeypair, keyAgg, keySort, tapLeafHash } from '../crypto.js';
import { asSats } from '../types.js';
import {
  PARTICIPANT_IDS, PRESIGNED_PROTOCOL,
  type ParticipantId, type PresignedLeaf, type PresignedParticipant,
  type PresignedParticipantKeys, type PresignedRoster, type PresignedRound, type RoundId,
} from './types.js';
import {
  assert, exactKeys, genesisHash, identifier, memberRounds, networkParameters,
  participantId, publicKey, roundId, safeInteger,
} from './validation.js';

export function validatePresignedRoster(input: PresignedRoster): PresignedRoster {
  exactKeys(input, ['version', 'protocol', 'vaultId', 'network', 'genesisHash', 'economics', 'feePolicy', 'participants'], 'roster');
  assert(input.version === 2 && input.protocol === PRESIGNED_PROTOCOL, 'wrong roster protocol');
  identifier(input.vaultId, 'vault id');
  assert(input.genesisHash === genesisHash(input.network), 'wrong genesis hash');
  exactKeys(input.economics, ['depositSatsPerParticipant', 'firstWithdrawalSats', 'secondWithdrawalSats', 'soloFeeBudgetSats', 'soloWithdrawalFeeSats', 'cooperativeFeeSats', 'recoveryFeeSats', 'finalSweepFeeSats', 'recoveryDelayBlocks'], 'economics');
  const economics = validateVaultEconomics(input.economics);
  const haircut = Math.round(economics.depositSatsPerParticipant * 0.05);
  assert(economics.firstWithdrawalSats === economics.depositSatsPerParticipant - haircut &&
    economics.secondWithdrawalSats === economics.depositSatsPerParticipant + Math.floor(haircut / 2), 'withdrawal proportions changed');
  // Bitcoin monetary range, avoiding Number precision loss when adding values.
  safeInteger(economics.depositSatsPerParticipant, 10_000, 2_100_000_000_000_000 / 3, 'deposit');
  assert(economics.depositSatsPerParticipant * 3 - economics.firstWithdrawalSats -
    economics.secondWithdrawalSats - economics.soloWithdrawalFeeSats * 3 >= 330, 'dust final payout');
  exactKeys(input.feePolicy, ['kind', 'maxChildFeeSats'], 'fee policy');
  assert(input.feePolicy.kind === 'confirmed-truc-payout-cpfp-v1', 'unknown fee policy');
  safeInteger(input.feePolicy.maxChildFeeSats, 1, 100_000_000, 'fee-child cap');
  assert(Array.isArray(input.participants) && input.participants.length === 3, 'roster requires three participants');
  const participants = input.participants.map(entry => {
    exactKeys(entry, ['id', 'personalPublicKeyHex', 'payoutXonlyPublicKeyHex', 'soloPublicKeys'], 'participant');
    participantId(entry.id);
    publicKey(entry.personalPublicKeyHex, true, 'personal public key');
    publicKey(entry.payoutXonlyPublicKeyHex, false, 'payout public key');
    const expectedRounds = memberRounds(entry.id);
    exactKeys(entry.soloPublicKeys, expectedRounds, 'round-scoped solo keys');
    for (const id of expectedRounds) publicKey(entry.soloPublicKeys[id]!, false, 'solo public key');
    return {
      id: entry.id,
      personalPublicKeyHex: entry.personalPublicKeyHex,
      payoutXonlyPublicKeyHex: entry.payoutXonlyPublicKeyHex,
      soloPublicKeys: Object.fromEntries(expectedRounds.map(id => [id, entry.soloPublicKeys[id]!])),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  assert(participants.map(p => p.id).join(',') === PARTICIPANT_IDS.join(','), 'repeated or missing participant');
  const keys = participants.flatMap(p => [p.personalPublicKeyHex.slice(2), p.payoutXonlyPublicKeyHex, ...Object.values(p.soloPublicKeys)]);
  assert(new Set(keys).size === keys.length, 'public keys must be unique across participants, roles and rounds');
  return { version: 2, protocol: PRESIGNED_PROTOCOL, vaultId: input.vaultId, network: input.network,
    genesisHash: input.genesisHash, economics, feePolicy: { ...input.feePolicy }, participants };
}

/** Client-only deterministic derivation from the existing 256-bit participant secret. */
export function derivePresignedParticipantKeys(secret: string, id: ParticipantId, vaultId: string): {
  publicIdentity: PresignedParticipant; keys: PresignedParticipantKeys;
} {
  assert(typeof secret === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(secret), 'participant secret must encode 256 random bits');
  participantId(id);
  identifier(vaultId, 'key derivation vault id');
  const personal = deterministicKeypair(secret, `${id}:personal`);
  const payout = deterministicKeypair(secret, `${id}:payout`);
  const pairs = memberRounds(id).map(round => [round, deterministicKeypair(secret, `${id}:${PRESIGNED_PROTOCOL}:${vaultId}:solo:${round}`)] as const);
  return {
    publicIdentity: { id, personalPublicKeyHex: personal.publicKeyHex, payoutXonlyPublicKeyHex: payout.xonlyPubKeyHex,
      soloPublicKeys: Object.fromEntries(pairs.map(([round, key]) => [round, key.xonlyPubKeyHex])) },
    keys: { participantId: id, personalPrivateKey: Buffer.from(personal.privateKeyHex, 'hex'),
      payoutPrivateKey: Buffer.from(payout.privateKeyHex, 'hex'),
      soloPrivateKeys: Object.fromEntries(pairs.map(([round, key]) => [round, Buffer.from(key.privateKeyHex, 'hex')])) },
  };
}

/** Best-effort memory clearing, never a security assumption or key-deletion protocol. */
export function clearPresignedParticipantKeys(keys: PresignedParticipantKeys): void {
  keys.personalPrivateKey.fill(0);
  keys.payoutPrivateKey.fill(0);
  Object.values(keys.soloPrivateKeys).forEach(key => key.fill(0));
}

export function payoutScript(roster: PresignedRoster, id: ParticipantId): Buffer {
  const participant = roster.participants.find(p => p.id === id);
  assert(participant, 'payout participant missing');
  const payment = bitcoin.payments.p2tr({ internalPubkey: publicKey(participant.payoutXonlyPublicKeyHex, false, 'payout key'), network: networkParameters(roster.network) });
  assert(payment.output, 'payout construction failed');
  return Buffer.from(payment.output);
}

export function buildPresignedRounds(input: PresignedRoster): PresignedRound[] {
  const roster = validatePresignedRoster(input);
  const memberships = [Array.from(PARTICIPANT_IDS), ...PARTICIPANT_IDS.map(leaver => PARTICIPANT_IDS.filter(id => id !== leaver))];
  return memberships.map(ids => buildRound(roster, ids)).sort((a, b) => a.id.localeCompare(b.id));
}

function multiScript(keys: string[], threshold: number): Buffer {
  return Buffer.from(bitcoin.script.compile([
    ...keys.flatMap((key, index) => [Buffer.from(key, 'hex'), index === 0 ? bitcoin.opcodes.OP_CHECKSIG : bitcoin.opcodes.OP_CHECKSIGADD]),
    bitcoin.script.number.encode(threshold), bitcoin.opcodes.OP_NUMEQUAL,
  ]));
}

function buildRound(roster: PresignedRoster, ids: ParticipantId[]): PresignedRound {
  const id = roundId(ids);
  const members = roster.participants.filter(p => ids.includes(p.id));
  const personalPublicKeys = keySort(members.map(p => p.personalPublicKeyHex));
  const internalKeyHex = keyAgg(personalPublicKeys).xonlyPubKeyHex;
  const soloMembers = [...members].sort((a, b) => a.soloPublicKeys[id]!.localeCompare(b.soloPublicKeys[id]!));
  const recoveryMembers = [...members].sort((a, b) => a.personalPublicKeyHex.slice(2).localeCompare(b.personalPublicKeyHex.slice(2)));
  const soloKeys = soloMembers.map(p => p.soloPublicKeys[id]!);
  const recoveryKeys = recoveryMembers.map(p => p.personalPublicKeyHex.slice(2));
  const soloScript = multiScript(soloKeys, members.length);
  const recoveryScript = Buffer.from(bitcoin.script.compile([
    bitcoin.script.number.encode(roster.economics.recoveryDelayBlocks), bitcoin.opcodes.OP_CHECKSEQUENCEVERIFY,
    bitcoin.opcodes.OP_VERIFY, ...bitcoin.script.decompile(multiScript(recoveryKeys, members.length - 1))!,
  ]));
  const scriptTree: [{ output: Buffer }, { output: Buffer }] = [{ output: soloScript }, { output: recoveryScript }];
  const common = { internalPubkey: Buffer.from(internalKeyHex, 'hex'), scriptTree, network: networkParameters(roster.network) };
  const payment = bitcoin.payments.p2tr(common);
  assert(payment.address && payment.output && payment.hash, 'vault construction failed');
  const makeLeaf = (kind: PresignedLeaf['kind'], script: Buffer, selected: PresignedParticipant[], keys: string[], threshold: number): PresignedLeaf => {
    const leaf = bitcoin.payments.p2tr({ ...common, redeem: { output: script, redeemVersion: 0xc0 } });
    const control = leaf.witness?.at(-1);
    assert(control, 'control block construction failed');
    return { kind, participantIds: selected.map(p => p.id), publicKeys: keys, threshold,
      scriptHex: script.toString('hex'), leafHash: tapLeafHash(script).toString('hex'), controlBlockHex: Buffer.from(control).toString('hex') };
  };
  return { id, participantIds: members.map(p => p.id), address: payment.address,
    outputScriptHex: Buffer.from(payment.output).toString('hex'),
    descriptor: `tr(${internalKeyHex},{multi_a(${members.length},${soloKeys.join(',')}),and_v(v:older(${roster.economics.recoveryDelayBlocks}),multi_a(${members.length - 1},${recoveryKeys.join(',')}))})`,
    internalKeyHex, personalPublicKeys, tapMerkleRoot: Buffer.from(payment.hash).toString('hex'),
    solo: makeLeaf('preauthorized-solo', soloScript, soloMembers, soloKeys, members.length),
    recovery: makeLeaf('timelocked-recovery', recoveryScript, recoveryMembers, recoveryKeys, members.length - 1) };
}
