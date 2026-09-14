import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { LAST_SURVIVOR_PAYOUT_SCHEDULE, validatePresignedEconomics } from './economics.js';
import { deterministicKeypair, keyAgg, keySort, tapLeafHash } from '../crypto.js';
import {
  PARTICIPANT_IDS, PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3, FIXED_RECOVERY_POLICY,
  type ParticipantId, type PresignedLeaf, type PresignedParticipant,
  type PresignedParticipantKeys, type PresignedProtocol, type PresignedRoster, type PresignedRound, type RoundId,
} from './types.js';
import {
  assert, exactKeys, genesisHash, identifier, memberRounds, networkParameters,
  participantId, presignedVersion, publicKey, roundId, safeInteger, validatePresignedProtocol,
} from './validation.js';

export function validatePresignedRoster(input: PresignedRoster): PresignedRoster {
  validatePresignedProtocol(input?.version, input?.protocol);
  const fixed = input.protocol === PRESIGNED_PROTOCOL_V3;
  exactKeys(input, ['version', 'protocol', 'vaultId', 'network', 'genesisHash', 'economics', 'feePolicy', 'participants',
    ...(fixed ? ['recoveryPolicy'] : [])], 'roster');
  if (fixed) assert(input.recoveryPolicy === FIXED_RECOVERY_POLICY, 'unknown recovery policy');
  identifier(input.vaultId, 'vault id');
  assert(input.genesisHash === genesisHash(input.network), 'wrong genesis hash');
  const economics = validatePresignedEconomics(input.economics);
  if (fixed) assert(economics.payoutSchedule === LAST_SURVIVOR_PAYOUT_SCHEDULE, 'V3 requires last-survivor net payouts');
  exactKeys(input.feePolicy, ['kind', 'maxChildFeeSats'], 'fee policy');
  assert(input.feePolicy.kind === 'confirmed-truc-payout-cpfp-v1', 'unknown fee policy');
  safeInteger(input.feePolicy.maxChildFeeSats, 1, 100_000_000, 'fee-child cap');
  assert(Array.isArray(input.participants) && input.participants.length === 3, 'roster requires three participants');
  const participants = input.participants.map(entry => {
    exactKeys(entry, ['id', 'personalPublicKeyHex', 'payoutXonlyPublicKeyHex', 'soloPublicKeys',
      ...(fixed ? ['recoveryAuthorizationPublicKeys', 'recoveryTriggerPublicKeys'] : [])], 'participant');
    participantId(entry.id);
    publicKey(entry.personalPublicKeyHex, true, 'personal public key');
    publicKey(entry.payoutXonlyPublicKeyHex, false, 'payout public key');
    const expectedRounds = memberRounds(entry.id);
    exactKeys(entry.soloPublicKeys, expectedRounds, 'round-scoped solo keys');
    for (const id of expectedRounds) publicKey(entry.soloPublicKeys[id]!, false, 'solo public key');
    if (fixed) {
      for (const name of ['recoveryAuthorizationPublicKeys', 'recoveryTriggerPublicKeys'] as const) {
        exactKeys(entry[name], expectedRounds, name);
        for (const id of expectedRounds) publicKey(entry[name]![id]!, false, name);
      }
    }
    return {
      id: entry.id,
      personalPublicKeyHex: entry.personalPublicKeyHex,
      payoutXonlyPublicKeyHex: entry.payoutXonlyPublicKeyHex,
      soloPublicKeys: Object.fromEntries(expectedRounds.map(id => [id, entry.soloPublicKeys[id]!])),
      ...(fixed ? {
        recoveryAuthorizationPublicKeys: Object.fromEntries(expectedRounds.map(id => [id, entry.recoveryAuthorizationPublicKeys![id]!])),
        recoveryTriggerPublicKeys: Object.fromEntries(expectedRounds.map(id => [id, entry.recoveryTriggerPublicKeys![id]!])),
      } : {}),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  assert(participants.map(p => p.id).join(',') === PARTICIPANT_IDS.join(','), 'repeated or missing participant');
  const keys = participants.flatMap(p => [p.personalPublicKeyHex.slice(2), p.payoutXonlyPublicKeyHex, ...Object.values(p.soloPublicKeys),
    ...Object.values(p.recoveryAuthorizationPublicKeys ?? {}), ...Object.values(p.recoveryTriggerPublicKeys ?? {})]);
  assert(new Set(keys).size === keys.length, 'public keys must be unique across participants, roles and rounds');
  return { version: input.version, protocol: input.protocol, ...(fixed ? { recoveryPolicy: FIXED_RECOVERY_POLICY } : {}), vaultId: input.vaultId, network: input.network,
    genesisHash: input.genesisHash, economics, feePolicy: { ...input.feePolicy }, participants };
}

/** Client-only deterministic derivation from the existing 256-bit participant secret. */
export function derivePresignedParticipantKeys(secret: string, id: ParticipantId, vaultId: string, protocol: PresignedProtocol = PRESIGNED_PROTOCOL): {
  publicIdentity: PresignedParticipant; keys: PresignedParticipantKeys;
} {
  assert(typeof secret === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(secret), 'participant secret must encode 256 random bits');
  participantId(id);
  identifier(vaultId, 'key derivation vault id');
  presignedVersion(protocol);
  const fixed = protocol === PRESIGNED_PROTOCOL_V3;
  const domain = `${id}:${protocol}:${vaultId}`;
  // Base custody identity predates protocol registration. V3 separates every
  // round capability, while preserving the existing passkey/payout identity.
  const personal = deterministicKeypair(secret, `${id}:personal`);
  const payout = deterministicKeypair(secret, `${id}:payout`);
  const deriveRounds = (role: string) => memberRounds(id).map(round => [round, deterministicKeypair(secret, `${domain}:${role}:${round}`)] as const);
  const pairs = deriveRounds('solo');
  const authorizations = fixed ? deriveRounds('recovery-authorization') : [];
  const triggers = fixed ? deriveRounds('recovery-trigger') : [];
  return {
    publicIdentity: { id, personalPublicKeyHex: personal.publicKeyHex, payoutXonlyPublicKeyHex: payout.xonlyPubKeyHex,
      soloPublicKeys: Object.fromEntries(pairs.map(([round, key]) => [round, key.xonlyPubKeyHex])),
      ...(fixed ? {
        recoveryAuthorizationPublicKeys: Object.fromEntries(authorizations.map(([round, key]) => [round, key.xonlyPubKeyHex])),
        recoveryTriggerPublicKeys: Object.fromEntries(triggers.map(([round, key]) => [round, key.xonlyPubKeyHex])),
      } : {}) },
    keys: { participantId: id, personalPrivateKey: Buffer.from(personal.privateKeyHex, 'hex'),
      payoutPrivateKey: Buffer.from(payout.privateKeyHex, 'hex'),
      soloPrivateKeys: Object.fromEntries(pairs.map(([round, key]) => [round, Buffer.from(key.privateKeyHex, 'hex')])),
      ...(fixed ? {
        recoveryAuthorizationPrivateKeys: Object.fromEntries(authorizations.map(([round, key]) => [round, Buffer.from(key.privateKeyHex, 'hex')])),
        recoveryTriggerPrivateKeys: Object.fromEntries(triggers.map(([round, key]) => [round, Buffer.from(key.privateKeyHex, 'hex')])),
      } : {}) },
  };
}

/** Best-effort memory clearing, never a security assumption or key-deletion protocol. */
export function clearPresignedParticipantKeys(keys: PresignedParticipantKeys): void {
  keys.personalPrivateKey.fill(0);
  keys.payoutPrivateKey.fill(0);
  Object.values(keys.soloPrivateKeys).forEach(key => key.fill(0));
  Object.values(keys.recoveryAuthorizationPrivateKeys ?? {}).forEach(key => key.fill(0));
  Object.values(keys.recoveryTriggerPrivateKeys ?? {}).forEach(key => key.fill(0));
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

function multiScript(keys: string[], threshold: number, verify = false): Buffer {
  return Buffer.from(bitcoin.script.compile([
    ...keys.flatMap((key, index) => [Buffer.from(key, 'hex'), index === 0 ? bitcoin.opcodes.OP_CHECKSIG : bitcoin.opcodes.OP_CHECKSIGADD]),
    bitcoin.script.number.encode(threshold), verify ? bitcoin.opcodes.OP_NUMEQUALVERIFY : bitcoin.opcodes.OP_NUMEQUAL,
  ]));
}

function buildRound(roster: PresignedRoster, ids: ParticipantId[]): PresignedRound {
  const id = roundId(ids);
  const members = roster.participants.filter(p => ids.includes(p.id));
  const personalPublicKeys = keySort(members.map(p => p.personalPublicKeyHex));
  const internalKeyHex = keyAgg(personalPublicKeys).xonlyPubKeyHex;
  const soloMembers = [...members].sort((a, b) => a.soloPublicKeys[id]!.localeCompare(b.soloPublicKeys[id]!));
  const fixed = roster.protocol === PRESIGNED_PROTOCOL_V3;
  const recoveryKey = (p: PresignedParticipant) => fixed ? p.recoveryTriggerPublicKeys![id]! : p.personalPublicKeyHex.slice(2);
  const recoveryMembers = [...members].sort((a, b) => recoveryKey(a).localeCompare(recoveryKey(b)));
  const authorizationMembers = fixed ? [...members].sort((a, b) => a.recoveryAuthorizationPublicKeys![id]!.localeCompare(b.recoveryAuthorizationPublicKeys![id]!)) : [];
  const soloKeys = soloMembers.map(p => p.soloPublicKeys[id]!);
  const recoveryKeys = recoveryMembers.map(recoveryKey);
  const authorizationKeys = authorizationMembers.map(p => p.recoveryAuthorizationPublicKeys![id]!);
  const soloScript = multiScript(soloKeys, members.length);
  const recoveryScript = Buffer.from(bitcoin.script.compile([
    bitcoin.script.number.encode(roster.economics.recoveryDelayBlocks), bitcoin.opcodes.OP_CHECKSEQUENCEVERIFY,
    bitcoin.opcodes.OP_VERIFY,
    ...(fixed ? bitcoin.script.decompile(multiScript(authorizationKeys, members.length, true))! : []),
    ...bitcoin.script.decompile(multiScript(recoveryKeys, members.length - 1))!,
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
  const recovery = makeLeaf('timelocked-recovery', recoveryScript, recoveryMembers, recoveryKeys, members.length - 1);
  if (fixed) Object.assign(recovery, { authorizationParticipantIds: authorizationMembers.map(p => p.id),
    authorizationPublicKeys: authorizationKeys, authorizationThreshold: members.length });
  const recoveryDescriptor = fixed
    ? `and_v(v:older(${roster.economics.recoveryDelayBlocks}),and_v(v:multi_a(${members.length},${authorizationKeys.join(',')}),multi_a(${members.length - 1},${recoveryKeys.join(',')})))`
    : `and_v(v:older(${roster.economics.recoveryDelayBlocks}),multi_a(${members.length - 1},${recoveryKeys.join(',')}))`;
  return { id, participantIds: members.map(p => p.id), address: payment.address,
    outputScriptHex: Buffer.from(payment.output).toString('hex'),
    descriptor: `tr(${internalKeyHex},{multi_a(${members.length},${soloKeys.join(',')}),${recoveryDescriptor}})`,
    internalKeyHex, personalPublicKeys, tapMerkleRoot: Buffer.from(payment.hash).toString('hex'),
    solo: makeLeaf('preauthorized-solo', soloScript, soloMembers, soloKeys, members.length),
    recovery };
}
