import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { nonWitnessTransactionHex, validatePresignedGraph } from './graph.js';
import {
  PRESIGNED_PROTOCOL, type ParticipantId, type Preauthorization, type PresignedExit,
  type PresignedGraph, type RoundId,
} from './types.js';
import { assert, exactKeys, hexBytes, participantId, sameCanonical } from './validation.js';

export function createPreauthorizations(input: {
  graph: PresignedGraph;
  participantId: ParticipantId;
  privateKeys: Partial<Record<RoundId, Uint8Array>>;
  approvedGraphDigest: string;
}): Preauthorization[] {
  const graph = validatePresignedGraph(input.graph);
  participantId(input.participantId);
  assert(input.approvedGraphDigest === graph.digest, 'preauthorization lacks exact local graph approval');
  const entries = graph.exits.filter(exit => exit.leaver !== input.participantId &&
    graph.rounds.find(round => round.id === exit.roundId)!.participantIds.includes(input.participantId)).map(exit => {
    const key = input.privateKeys[exit.roundId];
    assert(key, 'missing client-held round key');
    assertRoundPrivateKey(graph, exit, input.participantId, key);
    return { version: 2 as const, protocol: PRESIGNED_PROTOCOL, graphDigest: graph.digest,
      participantId: input.participantId, exitId: exit.id,
      signatureHex: Buffer.from(ecc.signSchnorr(Buffer.from(exit.signatureHash, 'hex'), key)).toString('hex') };
  });
  assert(entries.length === 4, 'each participant must contribute exactly four preauthorizations');
  return verifyPreauthorizations(graph, entries, false);
}

export function verifyPreauthorizations(input: PresignedGraph, entries: Preauthorization[], requireComplete = true): Preauthorization[] {
  const graph = validatePresignedGraph(input);
  assert(Array.isArray(entries) && entries.length <= 12, 'too many preauthorizations');
  const seen = new Set<string>();
  const canonical = entries.map(entry => {
    exactKeys(entry, ['version', 'protocol', 'graphDigest', 'participantId', 'exitId', 'signatureHex'], 'preauthorization');
    assert(entry.version === 2 && entry.protocol === PRESIGNED_PROTOCOL && entry.graphDigest === graph.digest, 'preauthorization belongs to another graph or protocol');
    participantId(entry.participantId);
    const exit = graph.exits.find(candidate => candidate.id === entry.exitId);
    assert(exit, 'preauthorization names unknown exit');
    assert(exit.leaver !== entry.participantId, 'setup must not release the designated leaver signature');
    const round = graph.rounds.find(candidate => candidate.id === exit.roundId)!;
    const keyIndex = round.solo.participantIds.indexOf(entry.participantId);
    assert(keyIndex >= 0, 'preauthorization signer is not a round member');
    const binding = `${entry.exitId}:${entry.participantId}`;
    assert(!seen.has(binding), 'duplicate preauthorization');
    seen.add(binding);
    const signature = hexBytes(entry.signatureHex, 64, 'preauthorization signature');
    assert(ecc.verifySchnorr(Buffer.from(exit.signatureHash, 'hex'), Buffer.from(round.solo.publicKeys[keyIndex]!, 'hex'), signature), 'invalid preauthorization signature');
    return { ...entry };
  }).sort((a, b) => `${a.exitId}:${a.participantId}`.localeCompare(`${b.exitId}:${b.participantId}`));
  if (requireComplete) {
    assert(canonical.length === 12, 'complete graph needs twelve preauthorizations');
    for (const exit of graph.exits) {
      const round = graph.rounds.find(candidate => candidate.id === exit.roundId)!;
      for (const id of round.participantIds.filter(id => id !== exit.leaver)) {
        assert(seen.has(`${exit.id}:${id}`), 'graph missing a counterparty preauthorization');
      }
    }
  }
  return canonical;
}

export function completePresignedExit(input: {
  graph: PresignedGraph; preauthorizations: Preauthorization[]; exitId: string;
  participantId: ParticipantId; privateKey: Uint8Array; approvedGraphDigest: string;
}): AuthorizedPresignedTransaction {
  const graph = validatePresignedGraph(input.graph);
  assert(input.approvedGraphDigest === graph.digest, 'exit lacks exact local graph approval');
  const entries = verifyPreauthorizations(graph, input.preauthorizations);
  const exit = graph.exits.find(candidate => candidate.id === input.exitId);
  assert(exit && exit.leaver === input.participantId, 'only the designated leaver can complete this exit');
  assertRoundPrivateKey(graph, exit, input.participantId, input.privateKey);
  const round = graph.rounds.find(candidate => candidate.id === exit.roundId)!;
  const tx = bitcoin.Transaction.fromHex(exit.unsignedTxHex);
  const signatures = round.solo.participantIds.map(id => id === input.participantId
    ? Buffer.from(ecc.signSchnorr(Buffer.from(exit.signatureHash, 'hex'), input.privateKey))
    : Buffer.from(entries.find(entry => entry.exitId === exit.id && entry.participantId === id)!.signatureHex, 'hex'));
  tx.setWitness(0, [...signatures].reverse().concat([Buffer.from(round.solo.scriptHex, 'hex'), Buffer.from(round.solo.controlBlockHex, 'hex')]));
  return authorizePresignedExitTransaction({ graph, exitId: exit.id, transactionHex: tx.toHex() });
}

export interface AuthorizedPresignedTransaction {
  transactionHex: string;
  txid: string;
  feeSats: number;
  vsize: number;
}

/** Accept alternate valid witness signatures, never alternate non-witness bytes. */
export function authorizePresignedExitTransaction(input: {
  graph: PresignedGraph; exitId: string; transactionHex: string;
}): AuthorizedPresignedTransaction {
  const graph = validatePresignedGraph(input.graph);
  const exit = graph.exits.find(candidate => candidate.id === input.exitId);
  assert(exit, 'unknown exit');
  assert(typeof input.transactionHex === 'string' && input.transactionHex.length < 10_000 && /^(?:[0-9a-f]{2})+$/u.test(input.transactionHex), 'malformed exit transaction');
  const tx = bitcoin.Transaction.fromHex(input.transactionHex);
  assert(tx.ins.length === 1 && tx.ins[0]!.script.length === 0, 'exit must have one native input');
  assert(nonWitnessTransactionHex(tx) === exit.unsignedTxHex && tx.getId() === exit.txid, 'exit changed immutable transaction');
  const round = graph.rounds.find(candidate => candidate.id === exit.roundId)!;
  const witness = tx.ins[0]!.witness;
  assert(witness.length === round.solo.threshold + 2, 'wrong exit witness element count');
  assert(Buffer.from(witness.at(-2)!).toString('hex') === round.solo.scriptHex &&
    Buffer.from(witness.at(-1)!).toString('hex') === round.solo.controlBlockHex, 'wrong exit leaf or control block');
  for (const [index, key] of round.solo.publicKeys.entries()) {
    const signature = witness[round.solo.threshold - 1 - index]!;
    assert(signature.length === 64, 'exit requires all fixed SIGHASH_DEFAULT signatures');
    assert(ecc.verifySchnorr(Buffer.from(exit.signatureHash, 'hex'), Buffer.from(key, 'hex'), signature), 'invalid exit witness signature');
  }
  return { transactionHex: tx.toHex(), txid: tx.getId(), feeSats: exit.feeSats, vsize: tx.virtualSize() };
}

function assertRoundPrivateKey(graph: PresignedGraph, exit: PresignedExit, id: ParticipantId, privateKey: Uint8Array): void {
  const expected = graph.roster.participants.find(participant => participant.id === id)?.soloPublicKeys[exit.roundId];
  assert(expected && privateKey instanceof Uint8Array && ecc.isPrivate(privateKey), 'invalid client-held round key');
  const publicKey = ecc.pointFromScalar(privateKey, true);
  assert(publicKey && Buffer.from(publicKey).subarray(1).toString('hex') === expected, 'client-held key does not match approved roster');
}
