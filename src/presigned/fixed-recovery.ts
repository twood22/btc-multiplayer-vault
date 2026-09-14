import { Buffer } from 'buffer';
import * as ecc from 'tiny-secp256k1';
import { validatePresignedGraph } from './graph.js';
import { PRESIGNED_PROTOCOL_V3, type ParticipantId, type PresignedGraph, type RecoveryAuthorization, type RoundId } from './types.js';
import { assert, exactKeys, hexBytes, participantId } from './validation.js';

/** Client-only setup operation. These are NOT signatures under trigger keys. */
export function createRecoveryAuthorizations(input: {
  graph: PresignedGraph;
  participantId: ParticipantId;
  privateKeys: Partial<Record<RoundId, Uint8Array>>;
  approvedGraphDigest: string;
}): RecoveryAuthorization[] {
  const graph = validatePresignedGraph(input.graph);
  assert(graph.protocol === PRESIGNED_PROTOCOL_V3, 'fixed recovery authorization requires V3');
  participantId(input.participantId);
  assert(input.approvedGraphDigest === graph.digest, 'recovery authorization lacks exact local graph approval');
  const entries = graph.recoveries!.filter(recovery => recovery.recipientIds.includes(input.participantId)).map(recovery => {
    const key = input.privateKeys[recovery.roundId];
    const expected = graph.roster.participants.find(member => member.id === input.participantId)!.recoveryAuthorizationPublicKeys![recovery.roundId]!;
    assert(key instanceof Uint8Array && ecc.isPrivate(key), 'missing client-held recovery authorization key');
    const point = ecc.pointFromScalar(key, true);
    assert(point && Buffer.from(point).subarray(1).toString('hex') === expected, 'recovery authorization key differs from approved roster');
    return { version: 3 as const, protocol: PRESIGNED_PROTOCOL_V3, purpose: 'fixed-recovery-authorization' as const,
      graphDigest: graph.digest, participantId: input.participantId, recoveryId: recovery.id,
      signatureHex: Buffer.from(ecc.signSchnorr(Buffer.from(recovery.signatureHash, 'hex'), key)).toString('hex') };
  });
  assert(entries.length === 3, 'each participant must authorize exactly three fixed recoveries');
  return verifyRecoveryAuthorizations(graph, entries, false);
}

/** Rebuild every refund and require the mandatory absent-member approvals. */
export function verifyRecoveryAuthorizations(input: PresignedGraph, entries: RecoveryAuthorization[], requireComplete = true): RecoveryAuthorization[] {
  const graph = validatePresignedGraph(input);
  assert(graph.protocol === PRESIGNED_PROTOCOL_V3, 'fixed recovery authorizations are forbidden for legacy graphs');
  assert(Array.isArray(entries) && entries.length <= 9, 'too many recovery authorizations');
  const seen = new Set<string>();
  const canonical = entries.map(entry => {
    exactKeys(entry, ['version', 'protocol', 'purpose', 'graphDigest', 'participantId', 'recoveryId', 'signatureHex'], 'recovery authorization');
    assert(entry.version === 3 && entry.protocol === PRESIGNED_PROTOCOL_V3 && entry.purpose === 'fixed-recovery-authorization' && entry.graphDigest === graph.digest,
      'recovery authorization belongs to another purpose, graph or protocol');
    participantId(entry.participantId);
    const recovery = graph.recoveries!.find(candidate => candidate.id === entry.recoveryId);
    assert(recovery, 'authorization names unknown recovery');
    const round = graph.rounds.find(candidate => candidate.id === recovery.roundId)!;
    const index = round.recovery.authorizationParticipantIds!.indexOf(entry.participantId);
    assert(index >= 0, 'recovery authorization signer is not a round member');
    const binding = `${entry.recoveryId}:${entry.participantId}`;
    assert(!seen.has(binding), 'duplicate recovery authorization');
    seen.add(binding);
    const signature = hexBytes(entry.signatureHex, 64, 'recovery authorization signature');
    assert(ecc.verifySchnorr(Buffer.from(recovery.signatureHash, 'hex'), Buffer.from(round.recovery.authorizationPublicKeys![index]!, 'hex'), signature),
      'invalid recovery authorization signature');
    return { ...entry };
  }).sort((a, b) => `${a.recoveryId}:${a.participantId}`.localeCompare(`${b.recoveryId}:${b.participantId}`));
  if (requireComplete) {
    assert(canonical.length === 9, 'complete graph needs nine recovery authorizations');
    for (const recovery of graph.recoveries!) for (const id of recovery.recipientIds) {
      assert(seen.has(`${recovery.id}:${id}`), 'graph missing a recovery authorization');
    }
  }
  return canonical;
}
