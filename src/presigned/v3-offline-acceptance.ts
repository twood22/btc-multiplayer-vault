/** PUBLIC DETERMINISTIC FIXTURES ONLY. Portable local cryptography; no network. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as bitcoin from 'bitcoinjs-lib';
import { createPresignedFixture, preauthorizePresignedFixture, authorizePresignedFixtureRecoveries } from './fixtures.js';
import { createPresignedPublicKit, encryptPresignedOfflineBackup, parsePresignedOfflineBackup,
  presignedBackupBinding, serializePresignedOfflineBackup, verifyPresignedOfflineBackupRestoration,
  withRestoredPresignedOfflineBackup, type PresignedOfflineBackup } from './backup.js';
import { derivePresignedParticipantKeys, clearPresignedParticipantKeys } from './roster.js';
import { buildPresignedSpend, createPresignedRecoveryContribution, signPresignedFinalSweep } from './spends.js';
import { completePresignedExit } from './signing.js';
import { newPresignedOfflineExchange, mergePresignedOfflineExchanges, finalizePresignedOfflineExchange,
  validatePresignedOfflineExchange, validatePresignedOfflineTransaction } from './offline.js';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3, type ParticipantId, type PresignedParticipantKeys,
  type PresignedPublicKit } from './types.js';

const fixture = createPresignedFixture({ protocol: PRESIGNED_PROTOCOL_V3 });
const { graph } = fixture;
const publicKit = createPresignedPublicKit({ graph, preauthorizations: preauthorizePresignedFixture(fixture),
  recoveryAuthorizations: authorizePresignedFixtureRecoveries(fixture) });
const envelopes = new Map<ParticipantId, PresignedOfflineBackup>();
const wraps = new Map<ParticipantId, Uint8Array>();
let restores = 0;
for (const [index, id] of PARTICIPANT_IDS.entries()) {
  const offlineSecret = new Uint8Array(32).fill(index + 91);
  const encrypted = await encryptPresignedOfflineBackup({ publicKit, participantId: id,
    participantSecret: fixture.participantSecrets[id], offlineSecret });
  const parsed = parsePresignedOfflineBackup(serializePresignedOfflineBackup(encrypted));
  const proof = await verifyPresignedOfflineBackupRestoration({ envelope: parsed, offlineSecret,
    expectedBinding: presignedBackupBinding(publicKit, id) });
  assert.equal(proof.version, 3);
  assert.equal(proof.exitProofs.length, 3);
  assert.equal(proof.recoveryProofs!.length, 3);
  assert(!JSON.stringify(proof).includes('transactionHex'));
  assert.throws(() => parsePresignedOfflineBackup(JSON.stringify({ ...parsed, protocol: PRESIGNED_PROTOCOL })));
  envelopes.set(id, parsed); wraps.set(id, offlineSecret); restores++;
}
assert.throws(() => createPresignedPublicKit({ graph, preauthorizations: publicKit.preauthorizations,
  recoveryAuthorizations: publicKit.recoveryAuthorizations!.slice(1) }));

async function restoredAction<T>(id: ParticipantId, action: (kit: PresignedPublicKit, keys: PresignedParticipantKeys) => T): Promise<T> {
  const result = await withRestoredPresignedOfflineBackup({ envelope: envelopes.get(id)!, offlineSecret: wraps.get(id)!,
    expectedBinding: presignedBackupBinding(publicKit, id), action: restored => {
      const derived = derivePresignedParticipantKeys(restored.participantSecret, id, restored.publicKit.graph.roster.vaultId,
        restored.publicKit.graph.protocol);
      try { return action(restored.publicKit, derived.keys); }
      finally { clearPresignedParticipantKeys(derived.keys); }
    } });
  restores++;
  return result;
}

let recoveries = 0;
for (const refund of graph.recoveries!) {
  for (const missing of refund.recipientIds) {
    const proposal = buildPresignedSpend({ graph, kind: 'recovery', proposalId: randomUUID(), sourceExitId: refund.parentExitId });
    let exchange = newPresignedOfflineExchange(graph, proposal);
    for (const id of refund.recipientIds.filter(id => id !== missing)) {
      const contribution = await restoredAction(id, (kit, keys) => createPresignedRecoveryContribution({ graph: kit.graph, proposal,
        participantId: id, recoveryTriggerPrivateKey: keys.recoveryTriggerPrivateKeys![refund.roundId]!, approvedProposalDigest: proposal.digest }));
      exchange = mergePresignedOfflineExchanges(publicKit, exchange, { ...newPresignedOfflineExchange(graph, proposal),
        recoveryContributions: [contribution] });
    }
    const actor = refund.recipientIds.find(id => id !== missing)!;
    const completed = await restoredAction(actor, kit => finalizePresignedOfflineExchange(kit, exchange));
    const exported = { version: graph.version, protocol: graph.protocol, format: 'presigned-offline-transaction-v1' as const,
      graphDigest: graph.digest, transactionHex: completed.transactionHex, txid: completed.txid,
      kind: 'recovery' as const, exitId: null, proposal };
    assert.equal(validatePresignedOfflineTransaction(publicKit, exported).txid, refund.txid);
    assert.throws(() => validatePresignedOfflineTransaction(publicKit, { ...exported, version: 2, protocol: PRESIGNED_PROTOCOL }));
    assert.throws(() => validatePresignedOfflineExchange(publicKit, { ...exchange, version: 2, protocol: PRESIGNED_PROTOCOL }));
    assert.deepEqual(bitcoin.Transaction.fromHex(completed.transactionHex).outs, bitcoin.Transaction.fromHex(refund.unsignedTxHex).outs);
    recoveries++;
  }
  console.log(`Portable V3 missing-participant recovery complete: ${refund.roundId}`);
}

let soloExports = 0;
let finalSweeps = 0;
for (const exit of graph.exits) {
  const completed = await restoredAction(exit.leaver, (kit, keys) => completePresignedExit({ graph: kit.graph,
    preauthorizations: kit.preauthorizations, exitId: exit.id, participantId: exit.leaver,
    privateKey: keys.soloPrivateKeys[exit.roundId]!, approvedGraphDigest: kit.graph.digest }));
  assert.equal(validatePresignedOfflineTransaction(publicKit, { version: graph.version, protocol: graph.protocol,
    format: 'presigned-offline-transaction-v1', graphDigest: graph.digest, kind: 'solo', exitId: exit.id,
    proposal: null, transactionHex: completed.transactionHex, txid: completed.txid }).txid, exit.txid);
  soloExports++;
  if (exit.finalParticipant) {
    const proposal = buildPresignedSpend({ graph, proposalId: randomUUID(), kind: 'final-sweep', sourceExitId: exit.id });
    const swept = await restoredAction(exit.finalParticipant, (kit, keys) => signPresignedFinalSweep({ graph: kit.graph, proposal,
      participantId: exit.finalParticipant!, payoutPrivateKey: keys.payoutPrivateKey, approvedProposalDigest: proposal.digest }));
    assert.equal(validatePresignedOfflineTransaction(publicKit, { version: graph.version, protocol: graph.protocol,
      format: 'presigned-offline-transaction-v1', graphDigest: graph.digest, kind: 'final-sweep', exitId: null,
      proposal, transactionHex: swept.transactionHex, txid: swept.txid }).txid, proposal.txid);
    assert.equal(Number(bitcoin.Transaction.fromHex(swept.transactionHex).outs[0]!.value), 10_080);
    finalSweeps++;
  }
}
wraps.forEach(secret => secret.fill(0));
assert.equal(recoveries, 9);
assert.equal(soloExports, 9);
assert.equal(finalSweeps, 6);
console.log(JSON.stringify({ passed: true, protocol: graph.protocol, encryptedPortableRestores: restores,
  missingParticipantRecoveries: recoveries, soloExports, finalSweeps, websiteContact: false,
  actualBrowserExecuted: false, actualBlockchainContact: false, publicNetworkBroadcasts: 0 }));
