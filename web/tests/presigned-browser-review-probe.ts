/** Regressions converted from independently reproduced data-only coordinator attacks.
 * PUBLIC offline fixture keys only. No DB, browser authenticator, network or real coins. */
import assert from 'node:assert/strict';
import { BITCOIN_NETWORK_NAME } from '../../src/network.js';
import { presignedBackupBinding, verifyPresignedKitRestoration, type PresignedRestorationProof } from '../../src/presigned/backup.js';
import { applyPresignedAction, newPresignedCeremony, presignedRestartStateDigest,
  type PresignedBackupReceipt, type PresignedCeremonyState, type PresignedFundingEpoch } from '../../src/presigned/ceremony.js';
import { createPresignedFixture, preauthorizePresignedFixture } from '../../src/presigned/fixtures.js';
import { buildPresignedGraph, fundingFeeShare } from '../../src/presigned/graph.js';
import { buildPresignedRounds, derivePresignedParticipantKeys } from '../../src/presigned/roster.js';
import { verifyPreauthorizations } from '../../src/presigned/signing.js';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, type ParticipantId, type PresignedPublicKit } from '../../src/presigned/types.js';
import { commitmentDigest } from '../../src/presigned/validation.js';
import { verifyPresignedCeremonyView } from '../lib/client/presigned-ceremony.js';
import { appendPresignedLocalRecord, assertPresignedLocalGraphApproved, assertPresignedLocalRestartAllowed,
  presignedLocalBinding, presignedLocalChecks, presignedLocalGraphRecord, presignedLocallyRestoredRecord,
  readPresignedLocalCeremony, type PresignedLocalRecord, type PresignedLocalStorage } from '../lib/client/presigned-local-ceremony.js';
import type { PresignedCeremonyStatus } from '../lib/server/presigned-store.js';

const fixture = createPresignedFixture({ network: BITCOIN_NETWORK_NAME });
const graph = fixture.graph;
const preauthorizations = verifyPreauthorizations(graph, preauthorizePresignedFixture(fixture), true);
const kit: PresignedPublicKit = { version: 2, protocol: PRESIGNED_PROTOCOL, graph, preauthorizations };
const settings = { network: graph.roster.network, genesisHash: graph.roster.genesisHash,
  economics: graph.roster.economics, feePolicy: graph.roster.feePolicy, fundingFeeSats: graph.funding.feeSats };
const initial = newPresignedCeremony(graph.roster.vaultId, settings);
const binding = presignedLocalBinding(initial.vaultId, graph.roster.participants.find(identity => identity.id === 'alice')!);
const rows = new Map<string, string>();
const storage: PresignedLocalStorage = { get length() { return rows.size; }, key: index => [...rows.keys()][index] ?? null,
  getItem: key => rows.get(key) ?? null, setItem: (key, value) => { rows.set(key, value); } };
const local = () => readPresignedLocalCeremony(binding, storage);
const expected = () => ({ vaultId: initial.vaultId, participantId: 'alice', settingsDigest: initial.settingsDigest, localState: local() });
const remember = (record: PresignedLocalRecord) => appendPresignedLocalRecord(binding, record, storage);
const epoch: PresignedFundingEpoch = { epochId: graph.funding.epochId, status: 'frozen',
  inputs: graph.funding.inputs, graph, preauthorizations, backups: [], walletSigningStarted: [], signatures: [],
  finalization: null, fundingApprovals: [], restartApprovals: [] };
const checks: string[] = [];
function check(name: string, test: () => void) { test(); checks.push(name); }

// Nine forged receipts, built solely from PUBLIC kit data, with invented zero witness digests.
const ready = status({ ...epoch, backups: PARTICIPANT_IDS.flatMap(id => fakeReceipts(kit, id)) }, true);
check('public-only forged backup receipts cannot unlock the local wallet stage', () => {
  assert.equal(verifyPresignedCeremonyView(ready, expected()).walletSigningReady, false);
});
check('graph review and wallet intent cannot skip the local roster comparison', () => {
  assert.throws(() => remember(presignedLocalGraphRecord('graph-reviewed', ready)), /compare the exact roster/u);
  assert.throws(() => remember(presignedLocalGraphRecord('wallet-signing-started', ready)), /compare the exact roster/u);
  assert.equal(rows.size, 0);
});
remember({ kind: 'roster-compared', rosterDigest: graph.rosterDigest, settingsDigest: initial.settingsDigest });
const replacedRoster = { ...graph.roster, participants: graph.roster.participants.map(identity => identity.id === 'alice'
  ? identity : derivePresignedParticipantKeys(Buffer.alloc(32, identity.id === 'bob' ? 21 : 22).toString('base64url'),
    identity.id, graph.roster.vaultId).publicIdentity) };
const replacement = buildPresignedGraph({ roster: replacedRoster, funding: graph.funding });
check('coordinator replacement of both peers after comparison is rejected with Alice unchanged', () => {
  assert.deepEqual(graph.roster.participants[0], replacement.roster.participants[0]);
  verifyPresignedCeremonyView(status({ ...epoch, preauthorizations: [] }, false), expected());
  assert.throws(() => verifyPresignedCeremonyView(status({ ...epoch, graph: replacement, preauthorizations: [] }, false), expected()),
    /locally compared roster/u);
});
const ownInput = graph.funding.inputs.find(coin => coin.participantId === 'alice')!;
remember({ kind: 'input-committed', epochId: epoch.epochId, rosterDigest: graph.rosterDigest, input: ownInput });
check('coordinator cannot change own committed input before graph review', () => {
  const inputs = graph.funding.inputs.map(coin => coin.participantId === 'alice' ? { ...coin, txid: '77'.repeat(32) } : coin);
  const changed = buildPresignedGraph({ roster: graph.roster, funding: { ...graph.funding, inputs } });
  assert.throws(() => verifyPresignedCeremonyView(status({ ...epoch, graph: changed, inputs, preauthorizations: [] }, false), expected()),
    /locally committed wallet input/u);
});
remember(presignedLocalGraphRecord('graph-reviewed', ready));
check('graph approval does not turn remote restoration receipts into local evidence', () => {
  assert.equal(verifyPresignedCeremonyView(ready, expected()).walletSigningReady, false);
  assert.throws(() => remember(presignedLocalGraphRecord('wallet-signing-started', ready)), /restore the saved offline file/u);
});
check('runtime guard requires exact own identity and locally approved graph', () => {
  assertPresignedLocalGraphApproved(graph, local());
  assert.throws(() => assertPresignedLocalGraphApproved(replacement, local()), /runtime roster/u);
  const other = presignedLocalBinding(initial.vaultId, graph.roster.participants.find(identity => identity.id === 'bob')!);
  assert.throws(() => assertPresignedLocalGraphApproved(graph, readPresignedLocalCeremony(other, storage)), /runtime roster/u);
});
// Custody acceptance separately exercises encrypted-file opens and mock PRF unlocks. This trusted local
// operation really completes all three owner exits with PUBLIC fixture secrets, not physical passkeys.
const proof = verifyPresignedKitRestoration({ publicKit: kit, participantId: 'alice', participantSecret: fixture.participantSecrets.alice,
  expectedBinding: presignedBackupBinding(kit, 'alice') });
remember(presignedLocallyRestoredRecord({ publicKit: kit, participantId: 'alice', proof,
  backupKind: 'offline', credentialId: null, backupFileDigest: '88'.repeat(32) }));
const passkeyRecord = (id: string) => presignedLocallyRestoredRecord({ publicKit: kit, participantId: 'alice', proof,
  backupKind: 'passkey', credentialId: id, backupFileDigest: null });
remember(passkeyRecord('alice-real-fixture-key-one')); remember(passkeyRecord('alice-real-fixture-key-one'));
check('repeated restoration with one credential does not count as two passkeys', () => {
  assert.equal(presignedLocalChecks(ready, local()).passkeysRestored.length, 1);
  assert.equal(verifyPresignedCeremonyView(ready, expected()).walletSigningReady, false);
});
remember(passkeyRecord('alice-real-fixture-key-two'));
check('graph-bound local restoration records open the wallet stage across reload', () => {
  assert.equal(verifyPresignedCeremonyView(ready, expected()).walletSigningReady, true);
  assertPresignedLocalRestartAllowed(ready, local());
});
check('failed storage persistence prevents the first irreversible signing intent', () => {
  const rejecting: PresignedLocalStorage = { get length() { return storage.length; }, key: storage.key, getItem: storage.getItem,
    setItem: () => { throw new Error('fixture localStorage quota failure'); } };
  let released = false;
  assert.throws(() => { appendPresignedLocalRecord(binding, presignedLocalGraphRecord('wallet-signing-started', ready), rejecting);
    released = true; }, /quota failure/u);
  assert.equal(released, false); assert.equal(presignedLocalChecks(ready, local()).walletSigningStarted, false);
});
remember(presignedLocalGraphRecord('wallet-signing-started', ready));
check('network failure or replayed pre-intent status cannot reopen restart; exact epoch remains retryable', () => {
  verifyPresignedCeremonyView(ready, expected()); // Request did not reach server: its restart digest remains present.
  assert.notEqual(ready.restartStateDigest, null);
  assert.throws(() => assertPresignedLocalRestartAllowed(ready, local()), /irreversible/u);
  const count = rows.size; remember(presignedLocalGraphRecord('wallet-signing-started', ready)); assert.equal(rows.size, count);
  verifyPresignedCeremonyView(status({ ...ready.epoch!, walletSigningStarted: ['alice'] }, true), expected());
  verifyPresignedCeremonyView(ready, expected());
});
check('coordinator cannot retire or replace a locally started epoch', () => {
  const changed = buildPresignedGraph({ roster: graph.roster,
    funding: { ...graph.funding, epochId: '55555555-5555-4555-8555-555555555555' } });
  assert.throws(() => verifyPresignedCeremonyView(status({ ...epoch, epochId: changed.funding.epochId,
    graph: changed, preauthorizations: [] }, false), expected()), /cannot replace or retire/u);
  assert.throws(() => assertPresignedLocalGraphApproved(changed, local()), /exact runtime graph/u);
});
check('new device cannot inherit restoration authority from coordinator metadata', () => {
  const empty: PresignedLocalStorage = { length: 0, key: () => null, getItem: () => null, setItem: () => undefined };
  assert.equal(verifyPresignedCeremonyView(ready, { ...expected(), localState: readPresignedLocalCeremony(binding, empty) }).walletSigningReady, false);
});
check('local records contain no secret keys and reject hidden fields', () => {
  const serialized = JSON.stringify([...rows]);
  for (const secret of Object.values(fixture.participantSecrets)) assert(!serialized.includes(secret));
  for (const keys of Object.values(fixture.keysById)) for (const secret of Object.values(keys.soloPrivateKeys)) {
    assert(!serialized.includes(Buffer.from(secret).toString('hex')));
  }
  assert.throws(() => remember({ ...presignedLocalGraphRecord('graph-reviewed', ready), participantSecret: 'SECRET_SENTINEL' } as unknown as PresignedLocalRecord), /fields/u);
});
check('corrupted local record fails closed without deleting history', () => {
  const [key, value] = [...rows][0]!;
  rows.set(key, value.replace(graph.rosterDigest, '00'.repeat(32)));
  assert.throws(() => local(), /local ceremony record changed/u); rows.set(key, value);
  assert.equal(presignedLocalChecks(ready, local()).walletSigningStarted, true);
});
const eligible = { alice: ['alice-key-one', 'alice-key-two'], bob: ['bob-key-one', 'bob-key-two'], carol: ['carol-key-one', 'carol-key-two'] };
const collecting: PresignedCeremonyState = { ...initial, identities: graph.roster.participants, roster: graph.roster,
  rosterDigest: graph.rosterDigest, rosterApprovals: [...PARTICIPANT_IDS], epochs: [{ ...epoch, status: 'collecting', inputs: [], graph: null, preauthorizations: [] }] };
const commit = (id: ParticipantId, input: typeof ownInput) => applyPresignedAction({ state: collecting, participantId: id,
  credentialId: eligible[id][0], eligibleCredentials: eligible, nextEpochId: '55555555-5555-4555-8555-555555555555',
  action: { version: 2, protocol: PRESIGNED_PROTOCOL, kind: 'commit-funding-input', epochId: epoch.epochId, rosterDigest: graph.rosterDigest, input } });
for (const id of PARTICIPANT_IDS) {
  for (const round of buildPresignedRounds(graph.roster)) check(`initial ${id} commitment rejects ${round.id} vault refund`, () => {
    const own = graph.funding.inputs.find(coin => coin.participantId === id)!;
    assert.throws(() => commit(id, { ...own, scriptPubKeyHex: round.outputScriptHex, changeScriptPubKeyHex: round.outputScriptHex }), /must not recreate a vault coin/u);
    assert.throws(() => commit(id, { ...own, changeScriptPubKeyHex: round.outputScriptHex }), /exact input wallet script/u);
  });
  for (const refund of [0, 329, 330]) check(`initial ${id} commitment enforces refund boundary ${refund}`, () => {
    const own = graph.funding.inputs.find(coin => coin.participantId === id)!;
    const coin = { ...own, valueSats: graph.roster.economics.depositSatsPerParticipant + fundingFeeShare(graph.funding.feeSats, PARTICIPANT_IDS.indexOf(id)) + refund };
    if (refund < 330) assert.throws(() => commit(id, coin), /non-dust wallet refund/u);
    else assert.equal(commit(id, coin).epochs[0]!.inputs.length, 1);
  });
}
console.log(JSON.stringify({ title: 'Offline browser coordinator security review regressions', network: graph.roster.network,
  passed: true, checks, realPasskeyOrBrowserEvidence: false, networkOrDatabaseContacted: false }, null, 2));

function status(candidate: PresignedFundingEpoch, walletReady: boolean): PresignedCeremonyStatus {
  const activeGraph = candidate.graph!;
  const state = { ...initial, identities: activeGraph.roster.participants, roster: activeGraph.roster,
    rosterDigest: activeGraph.rosterDigest, rosterApprovals: [...PARTICIPANT_IDS], epochs: [candidate] };
  const ownIntent = candidate.walletSigningStarted.includes('alice');
  return { version: 2, protocol: PRESIGNED_PROTOCOL, vaultId: initial.vaultId, participantId: 'alice', vaultStatus: 'ready',
    phase: walletReady ? 'wallet-signing' : 'preauthorizations', settings, settingsDigest: initial.settingsDigest,
    identities: state.identities, roster: state.roster, rosterDigest: state.rosterDigest, rosterApprovals: state.rosterApprovals,
    epoch: candidate, walletSigningReady: walletReady, participantWalletSigningStarted: ownIntent, fundingPsbtReleased: ownIntent && walletReady,
    fundingPsbtBase64: ownIntent && walletReady ? activeGraph.fundingPsbtBase64 : null, restartStateDigest: presignedRestartStateDigest(state),
    epochHistory: [{ epochId: candidate.epochId, status: candidate.status, graphDigest: activeGraph.digest, fundingTxid: activeGraph.fundingTxid }] };
}
function fakeReceipts(publicKit: PresignedPublicKit, id: ParticipantId): PresignedBackupReceipt[] {
  const domain = 'btc-multiplayer-vault/presigned-offline-recovery/v1';
  const body: Omit<PresignedRestorationProof, 'proofDigest'> = { version: 2, protocol: PRESIGNED_PROTOCOL,
    binding: presignedBackupBinding(publicKit, id), publicKitDigest: commitmentDigest(`${domain}/public-kit`, publicKit),
    participantIdentityDigest: commitmentDigest(`${domain}/participant`, publicKit.graph.roster.participants.find(identity => identity.id === id)!),
    exitProofs: publicKit.graph.exits.filter(exit => exit.leaver === id).sort((a, b) => a.id.localeCompare(b.id))
      .map(exit => ({ exitId: exit.id, txid: exit.txid, transactionDigest: '00'.repeat(32) })) };
  const proof = { ...body, proofDigest: commitmentDigest(`${domain}/restoration-proof`, body) };
  return [{ participantId: id, backupKind: 'offline', restoreCredentialId: null, approvedCredentialId: `${id}-invented-one`, backupFileDigest: '00'.repeat(32), proof },
    ...['one', 'two'].map(suffix => ({ participantId: id, backupKind: 'passkey' as const,
      restoreCredentialId: `${id}-invented-${suffix}`, approvedCredentialId: `${id}-invented-${suffix}`, backupFileDigest: null, proof }))];
}
