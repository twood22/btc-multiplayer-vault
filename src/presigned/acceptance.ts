import assert from 'node:assert/strict';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { BITCOIN_NETWORK_NAME } from '../network.js';
import { createPresignedFixture, preauthorizePresignedFixture, signPresignedFixtureFunding } from './fixtures.js';
import { authorizePresignedFundingSignedPsbt, authorizePresignedFundingTransaction } from './funding.js';
import { buildPresignedGraph, validatePresignedGraph } from './graph.js';
import { derivePresignedParticipantKeys, validatePresignedRoster } from './roster.js';
import { authorizePresignedExitTransaction, completePresignedExit, createPreauthorizations, verifyPreauthorizations } from './signing.js';
import { PARTICIPANT_IDS } from './types.js';

const checks: string[] = [];
const fixture = createPresignedFixture({ network: BITCOIN_NETWORK_NAME });
const graph = fixture.graph;
const preauthorizations = preauthorizePresignedFixture(fixture);
assert.equal(graph.rounds.length, 4);
assert.equal(graph.exits.length, 9);
assert.equal(graph.exits.filter(exit => exit.parentExitId === null).length, 3);
assert.equal(graph.exits.filter(exit => exit.parentExitId !== null).length, 6);
assert.equal(preauthorizations.length, 12);
for (const id of PARTICIPANT_IDS) assert.equal(preauthorizations.filter(entry => entry.participantId === id).length, 4);
assert.deepEqual(validatePresignedGraph(graph), graph);
checks.push('four deterministic Miniscript trees, three first/six second exits, twelve counterparty preauthorizations');

for (let mask = 0; mask < 8; mask += 1) {
  const f = createPresignedFixture({ network: BITCOIN_NETWORK_NAME,
    walletKinds: PARTICIPANT_IDS.map((_, index) => mask & (1 << index) ? 'p2tr' : 'p2wpkh') });
  // Deliberate order: descendant authorizations before ANY funding signature.
  const entries = preauthorizePresignedFixture(f);
  const funding = signPresignedFixtureFunding(f);
  assert.equal(funding.txid, f.graph.fundingTxid);
  const approved = authorizePresignedFundingTransaction({ graph: f.graph, transactionHex: funding.transactionHex });
  assert.equal(approved.txid, f.graph.fundingTxid);
  for (const exit of f.graph.exits) {
    const completed = completePresignedExit({ graph: f.graph, preauthorizations: entries, exitId: exit.id,
      participantId: exit.leaver, privateKey: f.keysById[exit.leaver].soloPrivateKeys[exit.roundId]!, approvedGraphDigest: f.graph.digest });
    assert.equal(completed.txid, exit.txid);
    const tx = bitcoin.Transaction.fromHex(completed.transactionHex);
    const incomplete = bitcoin.Transaction.fromHex(tx.toHex());
    const round = f.graph.rounds.find(round => round.id === exit.roundId)!;
    const leaverIndex = round.solo.threshold - 1 - round.solo.participantIds.indexOf(exit.leaver);
    incomplete.ins[0]!.witness[leaverIndex] = Buffer.alloc(0);
    assert.throws(() => authorizePresignedExitTransaction({ graph: f.graph, exitId: exit.id, transactionHex: incomplete.toHex() }), /signature/u);
    const tampered = tx.clone(); tampered.outs[0]!.value += 1n; tampered.outs[1]!.value -= 1n;
    assert.throws(() => authorizePresignedExitTransaction({ graph: f.graph, exitId: exit.id, transactionHex: tampered.toHex() }), /immutable/u);
    // Different valid Schnorr witness on the same transaction is safe to recognize.
    const alternate = bitcoin.Transaction.fromHex(tx.toHex());
    alternate.ins[0]!.witness[leaverIndex] = ecc.signSchnorr(Buffer.from(exit.signatureHash, 'hex'), f.keysById[exit.leaver].soloPrivateKeys[exit.roundId]!, Buffer.alloc(32, 9));
    assert.notEqual(alternate.toHex(), tx.toHex());
    assert.equal(authorizePresignedExitTransaction({ graph: f.graph, exitId: exit.id, transactionHex: alternate.toHex() }).txid, exit.txid);
  }
}
checks.push('all eight native wallet combinations preauthorize before funding, retain every dependency txid and reject missing leaver or changed payouts');
checks.push('consensus-valid alternate exit witnesses preserve exact graph recognition');

assert.throws(() => verifyPreauthorizations(graph, preauthorizations.slice(1)), /twelve/u);
assert.throws(() => verifyPreauthorizations(graph, [...preauthorizations.slice(0, 11), preauthorizations[0]!]), /duplicate/u);
assert.throws(() => verifyPreauthorizations(graph, [{ ...preauthorizations[0]!, graphDigest: '00'.repeat(32) }], false), /another graph/u);
assert.throws(() => verifyPreauthorizations(graph, [{ ...preauthorizations[0]!, signatureHex: `${preauthorizations[0]!.signatureHex}01` }], false), /signature/u);
assert.throws(() => verifyPreauthorizations(graph, [{ ...preauthorizations[0]!, participantId: 'alice', exitId: 'alice' }], false), /designated leaver/u);
assert.throws(() => createPreauthorizations({ graph, participantId: 'alice', privateKeys: fixture.keysById.alice.soloPrivateKeys, approvedGraphDigest: '00'.repeat(32) }), /approval/u);
assert.throws(() => completePresignedExit({ graph, preauthorizations, exitId: 'alice', participantId: 'bob', privateKey: fixture.keysById.bob.soloPrivateKeys.alicebobcarol!, approvedGraphDigest: graph.digest }), /designated leaver/u);
checks.push('partial, duplicate, cross-graph, weak-sighash and leaked-leaver setup authorizations rejected');

const mutations = [
  (g: typeof graph) => { g.exits[0]!.feeSats++; },
  (g: typeof graph) => { g.exits[0]!.unsignedTxHex += '00'; },
  (g: typeof graph) => { g.rounds[0]!.recovery.controlBlockHex = g.rounds[0]!.solo.controlBlockHex; },
  (g: typeof graph) => { g.digest = '11'.repeat(32); },
  (g: typeof graph) => { g.roster.genesisHash = '11'.repeat(32); },
  (g: typeof graph) => { g.funding.inputs[0]!.txid = '11'.repeat(32); },
];
for (const mutate of mutations) { const changed = structuredClone(graph); mutate(changed); assert.throws(() => validatePresignedGraph(changed)); }
assert.throws(() => validatePresignedGraph({ ...graph, privateKey: 'not-accepted' } as typeof graph), /unexpected/u);
const duplicateRole = structuredClone(graph.roster);
duplicateRole.participants[0]!.soloPublicKeys.alicebobcarol = duplicateRole.participants[0]!.personalPublicKeyHex.slice(2);
assert.throws(() => validatePresignedRoster(duplicateRole), /unique/u);
const anotherVault = derivePresignedParticipantKeys(fixture.participantSecrets.alice, 'alice', '55555555-5555-4555-8555-555555555555');
assert.equal(anotherVault.publicIdentity.personalPublicKeyHex, graph.roster.participants[0]!.personalPublicKeyHex);
assert.notEqual(anotherVault.publicIdentity.soloPublicKeys.alicebobcarol, graph.roster.participants[0]!.soloPublicKeys.alicebobcarol);
for (const script of ['a914' + '11'.repeat(20) + '87', '76a914' + '11'.repeat(20) + '88ac']) {
  const funding = structuredClone(graph.funding); funding.inputs[0]!.scriptPubKeyHex = script;
  assert.throws(() => buildPresignedGraph({ roster: graph.roster, funding }), /native/u);
}
checks.push('full graph reconstruction rejects serialized substitutions, non-SegWit inputs and key reuse; solo derivation binds vault identity');

for (const participant of PARTICIPANT_IDS) for (const round of graph.rounds) {
  const funding = structuredClone(graph.funding);
  funding.inputs.find(coin => coin.participantId === participant)!.changeScriptPubKeyHex = round.outputScriptHex;
  assert.throws(() => buildPresignedGraph({ roster: graph.roster, funding }), /funding refund must return|must not recreate a vault coin/u);
}
checks.push('all twelve participant-to-round funding change substitutions reject unprotected extra vault coins');

const finalized = signPresignedFixtureFunding(fixture);
const changedFunding = bitcoin.Transaction.fromHex(finalized.transactionHex);
changedFunding.ins[0]!.script = Buffer.from([0]);
assert.throws(() => authorizePresignedFundingTransaction({ graph, transactionHex: changedFunding.toHex() }), /immutable/u);
const psbt = bitcoin.Psbt.fromBase64(graph.fundingPsbtBase64);
psbt.updateInput(1, { partialSig: [{ pubkey: fixture.walletKeys.bob.publicKey,
  signature: bitcoin.script.signature.encode(ecc.sign(Buffer.alloc(32), fixture.walletKeys.bob.privateKey), bitcoin.Transaction.SIGHASH_ALL) }] });
assert.throws(() => authorizePresignedFundingSignedPsbt({ graph, participantId: 'alice', signedPsbtBase64: psbt.toBase64(), approvedGraphDigest: graph.digest }), /another participant/u);
checks.push('funding scriptSig and cross-participant wallet signature injection rejected');

console.log(JSON.stringify({ protocol: 'presigned-graph-v2', kind: 'offline-cryptographic-acceptance', passed: true,
  network: graph.roster.network, nativeWalletCombinations: 8, exitsPerCombination: 9,
  publicNetworkBroadcasts: 0, bitcoinCoreVerified: false, browserVerified: false, checks }, null, 2));
