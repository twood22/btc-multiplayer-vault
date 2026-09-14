/** Public deterministic keys only; no network requests or production custody. */
import assert from 'node:assert/strict';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { authorizePresignedFixtureRecoveries, createPresignedFixture, preauthorizePresignedFixture } from './fixtures.js';
import { createRecoveryAuthorizations, verifyRecoveryAuthorizations } from './fixed-recovery.js';
import { buildPresignedGraph, validatePresignedGraph } from './graph.js';
import { clearPresignedParticipantKeys, derivePresignedParticipantKeys, payoutScript, validatePresignedRoster } from './roster.js';
import { completePresignedExit, verifyPreauthorizations } from './signing.js';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3, type PresignedGraph } from './types.js';
import { validatePresignedProtocol } from './validation.js';

const old = createPresignedFixture();
assert.equal(old.graph.digest, '1771dfcd33d5722f5ea5d732d89f6d7c91053d4409bb5bf5e66e8acab6b03137');
for (const object of [old.roster, old.graph, old.keysById.alice, old.roster.participants[0]!]) {
  assert(!Object.keys(object).some(key => key.startsWith('recovery')));
}
const fixture = createPresignedFixture({ protocol: PRESIGNED_PROTOCOL_V3 });
const { graph } = fixture;
const authorizations = authorizePresignedFixtureRecoveries(fixture);
const solo = preauthorizePresignedFixture(fixture);
assert.equal(authorizations.length, 9);
assert.equal(solo.length, 12);
assert.deepEqual(validatePresignedGraph(graph), graph);
for (const id of PARTICIPANT_IDS) {
  assert.equal(authorizations.filter(entry => entry.participantId === id).length, 3);
  assert.equal(solo.filter(entry => entry.participantId === id).length, 4);
  const alternate = derivePresignedParticipantKeys(fixture.participantSecrets[id], id, '55555555-5555-4555-8555-555555555555', PRESIGNED_PROTOCOL_V3);
  const identity = graph.roster.participants.find(p => p.id === id)!;
  const otherKeys = [...Object.values(alternate.publicIdentity.soloPublicKeys), ...Object.values(alternate.publicIdentity.recoveryAuthorizationPublicKeys!),
    ...Object.values(alternate.publicIdentity.recoveryTriggerPublicKeys!)];
  const keys = [...Object.values(identity.soloPublicKeys),
    ...Object.values(identity.recoveryAuthorizationPublicKeys!), ...Object.values(identity.recoveryTriggerPublicKeys!)];
  assert(keys.every(key => !otherKeys.includes(key)), 'every V3 round capability must bind the vault');
  assert.equal(identity.personalPublicKeyHex, old.roster.participants.find(p => p.id === id)!.personalPublicKeyHex);
  assert.equal(identity.payoutXonlyPublicKeyHex, old.roster.participants.find(p => p.id === id)!.payoutXonlyPublicKeyHex);
  assert.throws(() => createRecoveryAuthorizations({ graph, participantId: id, privateKeys: fixture.keysById[id].recoveryTriggerPrivateKeys!,
    approvedGraphDigest: graph.digest }), /differs/u);
  const cleared = structuredClone(alternate.keys);
  clearPresignedParticipantKeys(cleared);
  for (const key of [cleared.personalPrivateKey, cleared.payoutPrivateKey, ...Object.values(cleared.soloPrivateKeys),
    ...Object.values(cleared.recoveryAuthorizationPrivateKeys!), ...Object.values(cleared.recoveryTriggerPrivateKeys!)]) assert(key.every(byte => byte === 0));
}
let exactRefunds = 0;
for (const recovery of graph.recoveries!) {
  const round = graph.rounds.find(candidate => candidate.id === recovery.roundId)!;
  const tx = bitcoin.Transaction.fromHex(recovery.unsignedTxHex);
  assert.equal(tx.version, 3);
  assert.equal(tx.locktime, 0);
  assert.equal(tx.ins[0]!.sequence, graph.roster.economics.recoveryDelayBlocks);
  assert.equal(tx.outs.length, round.participantIds.length);
  assert.equal(round.recovery.authorizationThreshold, round.participantIds.length);
  assert.equal(round.recovery.threshold, round.participantIds.length - 1);
  assert.equal(Buffer.from(round.recovery.controlBlockHex, 'hex').length, 65, 'actual two-leaf tree');
  assert.equal(bitcoin.script.decompile(Buffer.from(round.recovery.scriptHex, 'hex'))!.filter(op => op === bitcoin.opcodes.OP_NUMEQUALVERIFY).length, 1);
  assert.equal(round.recovery.authorizationPublicKeys!.filter(key => round.recovery.publicKeys.includes(key)).length, 0);
  const available = BigInt(recovery.inputValueSats - recovery.feeSats);
  const count = BigInt(tx.outs.length);
  recovery.recipientIds.forEach((id, index) => {
    assert.equal(tx.outs[index]!.value, available / count + (BigInt(index) < available % count ? 1n : 0n));
    assert.deepEqual(Buffer.from(tx.outs[index]!.script), payoutScript(graph.roster, id));
    const entry = authorizations.find(item => item.recoveryId === recovery.id && item.participantId === id)!;
    const altered = tx.clone(); altered.outs[index]!.value--;
    const hash = altered.hashForWitnessV1(0, [Buffer.from(recovery.inputScriptPubKeyHex, 'hex')], [BigInt(recovery.inputValueSats)],
      bitcoin.Transaction.SIGHASH_DEFAULT, Buffer.from(round.recovery.leafHash, 'hex'));
    const keyIndex = round.recovery.authorizationParticipantIds!.indexOf(id);
    assert.equal(ecc.verifySchnorr(hash, Buffer.from(round.recovery.authorizationPublicKeys![keyIndex]!, 'hex'), Buffer.from(entry.signatureHex, 'hex')), false);
  });
  exactRefunds++;
}

let refusalChecks = 0;
const refuse = (fn: () => unknown) => { assert.throws(fn); refusalChecks++; };
refuse(() => verifyRecoveryAuthorizations(graph, authorizations.slice(1)));
refuse(() => verifyRecoveryAuthorizations(graph, [...authorizations.slice(0, -1), authorizations[0]!]));
for (const property of ['protocol', 'purpose', 'graphDigest', 'participantId', 'recoveryId', 'signatureHex'] as const) {
  refuse(() => verifyRecoveryAuthorizations(graph, [{ ...authorizations[0]!, [property]: 'invalid' }], false));
}
refuse(() => verifyRecoveryAuthorizations(graph, [{ ...authorizations[0]!, signatureHex: authorizations[0]!.signatureHex + '01' }], false));
refuse(() => verifyRecoveryAuthorizations(old.graph, authorizations));
refuse(() => verifyPreauthorizations(graph, preauthorizePresignedFixture(old)));
refuse(() => verifyPreauthorizations(old.graph, solo));
refuse(() => createRecoveryAuthorizations({ graph, participantId: 'alice', privateKeys: fixture.keysById.alice.recoveryAuthorizationPrivateKeys!, approvedGraphDigest: old.graph.digest }));
for (const pair of [[2, PRESIGNED_PROTOCOL_V3], [3, PRESIGNED_PROTOCOL], [4, PRESIGNED_PROTOCOL_V3], [3, 'presigned-graph-v4']]) {
  refuse(() => validatePresignedProtocol(pair[0], pair[1]));
}
const mutations: Array<(g: PresignedGraph) => void> = [
  g => { g.recoveries!.pop(); },
  g => { g.recoveries![0]!.feeSats++; },
  g => { g.recoveries![0]!.signatureHash = '00'.repeat(32); },
  g => { g.recoveries![0]!.recipientIds.reverse(); },
  g => { g.recoveries![0]!.unsignedTxHex += '00'; },
  g => { g.recoveries![0]!.inputTxid = '00'.repeat(32); },
  g => { g.recoveries![0]!.parentExitId = null; },
  g => { g.rounds[0]!.recovery = structuredClone(old.graph.rounds[0]!.recovery); },
  g => { g.rounds[0]!.recovery.controlBlockHex = g.rounds[0]!.solo.controlBlockHex; },
  g => { g.roster.participants[0]!.recoveryTriggerPublicKeys = { ...g.roster.participants[0]!.recoveryAuthorizationPublicKeys }; },
  g => { delete g.roster.recoveryPolicy; },
  g => { delete g.roster.economics.payoutSchedule; },
  g => { g.roster = old.roster; },
  g => { g.funding.epochId = '66666666-6666-4666-8666-666666666666'; },
  g => { g.roster.network = 'mainnet'; },
  g => { g.roster.vaultId = '55555555-5555-4555-8555-555555555555'; },
  g => { g.version = 2; g.protocol = PRESIGNED_PROTOCOL; },
];
for (const mutation of mutations) { const changed = structuredClone(graph); mutation(changed); refuse(() => validatePresignedGraph(changed)); }
for (const role of ['soloPublicKeys', 'recoveryAuthorizationPublicKeys', 'recoveryTriggerPublicKeys'] as const) {
  const roster = structuredClone(graph.roster);
  roster.participants[0]![role]!.alicebobcarol = roster.participants[0]!.payoutXonlyPublicKeyHex;
  refuse(() => validatePresignedRoster(roster));
}
for (const fee of [0, 1, 331, 30_000, 0.5]) {
  const roster = structuredClone(graph.roster); roster.economics.recoveryFeeSats = fee as typeof roster.economics.recoveryFeeSats;
  refuse(() => buildPresignedGraph({ roster, funding: graph.funding }));
}
const floorRoster = structuredClone(graph.roster);
floorRoster.economics.recoveryFeeSats = 332 as typeof floorRoster.economics.recoveryFeeSats;
assert.equal(buildPresignedGraph({ roster: floorRoster, funding: graph.funding }).recoveries!.length, 4);
let signedExits = 0;
for (const network of ['mainnet', 'signet'] as const) for (let mask = 0; mask < 8; mask++) {
  const f = createPresignedFixture({ protocol: PRESIGNED_PROTOCOL_V3, network,
    walletKinds: PARTICIPANT_IDS.map((_, index) => mask & (1 << index) ? 'p2tr' : 'p2wpkh') });
  const preauthorizations = preauthorizePresignedFixture(f);
  assert.equal(verifyRecoveryAuthorizations(f.graph, authorizePresignedFixtureRecoveries(f)).length, 9);
  for (const exit of f.graph.exits) {
    const signed = completePresignedExit({ graph: f.graph, preauthorizations, exitId: exit.id, participantId: exit.leaver,
      privateKey: f.keysById[exit.leaver].soloPrivateKeys[exit.roundId]!, approvedGraphDigest: f.graph.digest });
    assert.equal(signed.txid, exit.txid);
    signedExits++;
  }
}
console.log(JSON.stringify({ passed: true, protocol: PRESIGNED_PROTOCOL_V3, legacyGoldenDigest: old.graph.digest,
  exactRefunds, setupAuthorizations: solo.length + authorizations.length, refusalChecks, signedExits,
  networkFormats: 2, walletCombinations: 8, actualPublicNetworkBroadcasts: 0, bitcoinCoreVerified: false }));
