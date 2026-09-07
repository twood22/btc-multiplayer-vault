import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BITCOIN_NETWORK_NAME } from '../network.js';
import { createPresignedFixture, preauthorizePresignedFixture } from './fixtures.js';
import { completePresignedExit } from './signing.js';
import { createPresignedCooperativeNonce, signPresignedCooperativePartial, createPresignedRecoveryContribution, signPresignedFinalSweep } from './spends.js';
import { applyPresignedRuntimeAction, buildPresignedRuntimeProposal, presignedRuntimeBroadcastReady,
  presignedRuntimeTransactionDigest, validatePresignedRuntimeAction, type PresignedRuntimeAction,
  type PresignedRuntimeCoinObservation, type PresignedRuntimeKind, type PresignedRuntimeState } from './runtime.js';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, type ParticipantId } from './types.js';

// Public deterministic fixtures; genuine Schnorr/MuSig2, no network, provider, wallet or database.
const fixture = createPresignedFixture({ network: BITCOIN_NETWORK_NAME });
const { graph, keysById } = fixture;
const preauthorizations = preauthorizePresignedFixture(fixture);
const checks: string[] = [];
const anchor = '55'.repeat(32);
function action(body: Record<string, unknown>): PresignedRuntimeAction {
  return validatePresignedRuntimeAction({ version: 2, protocol: PRESIGNED_PROTOCOL, ...body });
}
function create(id: ParticipantId, spendKind: PresignedRuntimeKind, sourceExitId: string | null = null, exitId: string | null = null) {
  const candidate = action({ kind: 'create-proposal', epochId: graph.funding.epochId, graphDigest: graph.digest,
    proposalId: randomUUID(), spendKind, sourceExitId, exitId, confirmationBlockHash: anchor });
  assert(candidate.kind === 'create-proposal');
  const proposal = buildPresignedRuntimeProposal({ graph, action: candidate, participantId: id });
  const observation = observe(proposal.source);
  return applyPresignedRuntimeAction({ graph, action: candidate, state: null, participantId: id, observation, requiredConfirmations: 2 });
}
function observe(source: PresignedRuntimeState['proposal']['source']): PresignedRuntimeCoinObservation {
  return { network: graph.roster.network, genesisHash: graph.roster.genesisHash,
    txid: source.txid, vout: source.vout, valueSats: source.valueSats, scriptPubKeyHex: source.scriptPubKeyHex,
    confirmationBlockHash: anchor, confirmations: 20, unspentInActiveChain: true, coinbase: false };
}
function apply(state: PresignedRuntimeState, id: ParticipantId, body: Record<string, unknown>,
  observation: PresignedRuntimeCoinObservation | null = observe(state.proposal.source)) {
  return applyPresignedRuntimeAction({ graph, state, participantId: id,
    action: action({ proposalId: state.proposal.proposalId, proposalDigest: state.proposal.digest, ...body }),
    observation, requiredConfirmations: 2 });
}
for (const exit of graph.exits) {
  let state = create(exit.leaver, 'solo', exit.parentExitId, exit.id);
  assert.equal(state.proposal.source.txid, exit.inputTxid);
  assert.equal(state.proposal.slot, `solo:${exit.leaver}`);
  const completed = completePresignedExit({ graph, preauthorizations, exitId: exit.id, participantId: exit.leaver,
    privateKey: keysById[exit.leaver].soloPrivateKeys[exit.roundId]!, approvedGraphDigest: graph.digest });
  state = apply(state, exit.leaver, { kind: 'finalize-transaction', transactionHex: completed.transactionHex });
  assert.equal(state.finalized!.txid, exit.txid);
  assert.equal(presignedRuntimeBroadcastReady(state), false);
  state = apply(state, exit.leaver, { kind: 'approve-broadcast', transactionDigest: state.finalized!.transactionDigest });
  assert.equal(presignedRuntimeBroadcastReady(state), true);
}
checks.push('all nine committed unilateral exits finalize with actor-only exact-byte approval');

let cooperative = create('alice', 'cooperative');
const spend = cooperative.proposal.spend!;
const nonces = PARTICIPANT_IDS.map(id => createPresignedCooperativeNonce({ graph, proposal: spend, participantId: id,
  personalPrivateKey: keysById[id].personalPrivateKey, approvedProposalDigest: spend.digest }));
for (const nonce of nonces) cooperative = apply(cooperative, nonce.publicNonce.participantId, { kind: 'contribute-nonce', publicNonce: nonce.publicNonce });
assert(cooperative.nonceSetDigest);
for (const nonce of nonces) {
  const id = nonce.publicNonce.participantId;
  const partial = signPresignedCooperativePartial({ graph, proposal: spend, participantId: id,
    personalPrivateKey: keysById[id].personalPrivateKey, approvedProposalDigest: spend.digest,
    publicNonces: cooperative.publicNonces, nonceBinding: nonce.binding, consumedSecretNonce: nonce.secretNonce });
  cooperative = apply(cooperative, id, { kind: 'contribute-partial', partial });
  assert(nonce.secretNonce.every(byte => byte === 0));
}
assert.equal(cooperative.status, 'finalized');
assert.deepEqual(cooperative.finalized!.approverParticipantIds, PARTICIPANT_IDS);
for (const id of PARTICIPANT_IDS) cooperative = apply(cooperative, id, { kind: 'approve-broadcast', transactionDigest: cooperative.finalized!.transactionDigest });
assert.equal(presignedRuntimeBroadcastReady(cooperative), true);
assert.throws(() => apply(cooperative, 'alice', { kind: 'abandon-proposal', reason: 'Completed signatures can never be revoked.' }), /cannot be abandoned/);
checks.push('interactive tweaked MuSig2 freezes nonce set and verifies each partial before exact unanimous broadcast approval');

let recovery = create('alice', 'recovery');
assert.throws(() => apply(recovery, 'alice', { kind: 'contribute-recovery', contribution: createPresignedRecoveryContribution({ graph,
  proposal: recovery.proposal.spend!, participantId: 'alice', personalPrivateKey: keysById.alice.personalPrivateKey,
  approvedProposalDigest: recovery.proposal.spend!.digest }) }, { ...observe(recovery.proposal.source), confirmations: 11 }), /CSV age/);
for (const id of ['bob','carol'] as const) recovery = apply(recovery, id, { kind: 'contribute-recovery',
  contribution: createPresignedRecoveryContribution({ graph, proposal: recovery.proposal.spend!, participantId: id,
    personalPrivateKey: keysById[id].personalPrivateKey, approvedProposalDigest: recovery.proposal.spend!.digest }) });
assert.deepEqual(recovery.finalized!.approverParticipantIds, ['bob','carol']);
assert.throws(() => apply(recovery, 'alice', { kind: 'approve-broadcast', transactionDigest: recovery.finalized!.transactionDigest }), /exact transaction signer quorum/);
const forged = structuredClone(recovery);
forged.finalized!.approverParticipantIds = ['alice','bob'];
forged.finalized!.transactionDigest = presignedRuntimeTransactionDigest(forged.proposal, forged.finalized!, ['alice','bob']);
assert.throws(() => apply(forged, 'alice', { kind: 'approve-broadcast', transactionDigest: forged.finalized!.transactionDigest }), /exact witness signers/);
for (const id of ['bob','carol'] as const) recovery = apply(recovery, id, { kind: 'approve-broadcast', transactionDigest: recovery.finalized!.transactionDigest });
assert.equal(presignedRuntimeBroadcastReady(recovery), true);
checks.push('recovery enforces current CSV age and binds broadcast approvers to the exact N-1 witness signers');

let final = create('carol', 'final-sweep', 'alice/bob');
const swept = signPresignedFinalSweep({ graph, proposal: final.proposal.spend!, participantId: 'carol',
  payoutPrivateKey: keysById.carol.payoutPrivateKey, approvedProposalDigest: final.proposal.spend!.digest });
assert.throws(() => apply(final, 'alice', { kind: 'finalize-transaction', transactionHex: swept.transactionHex }), /current source participant/);
final = apply(final, 'carol', { kind: 'finalize-transaction', transactionHex: swept.transactionHex });
final = apply(final, 'carol', { kind: 'approve-broadcast', transactionDigest: final.finalized!.transactionDigest });
assert(presignedRuntimeBroadcastReady(final));
checks.push('final payout derives directly from the committed offline second exit and requires its payout-key owner');

const pending = create('alice', 'cooperative');
const pendingNonce = createPresignedCooperativeNonce({ graph, proposal: pending.proposal.spend!, participantId: 'alice',
  personalPrivateKey: keysById.alice.personalPrivateKey, approvedProposalDigest: pending.proposal.spend!.digest });
const exposed = apply(pending, 'alice', { kind: 'contribute-nonce', publicNonce: pendingNonce.publicNonce });
const abandoned = apply(exposed, 'bob', { kind: 'abandon-proposal', reason: 'A current participant abandons a stalled shared session.' }, null);
assert.deepEqual(abandoned.publicNonces, exposed.publicNonces);
pendingNonce.secretNonce.fill(0);
assert.throws(() => validatePresignedRuntimeAction({ version: 2, protocol: PRESIGNED_PROTOCOL, kind: 'contribute-nonce',
  proposalId: pending.proposal.proposalId, proposalDigest: pending.proposal.digest,
  publicNonce: { ...pendingNonce.publicNonce, secretNonce: 'never accepted' } }), /unexpected or missing/);
assert.throws(() => apply(exposed, 'alice', { kind: 'contribute-nonce', publicNonce: pendingNonce.publicNonce },
  { ...observe(exposed.proposal.source), confirmationBlockHash: '66'.repeat(32) }), /source changed/);
assert.throws(() => apply(exposed, 'alice', { kind: 'contribute-nonce', publicNonce: pendingNonce.publicNonce }, null), /private-Core/);
for (const secret of Object.values(fixture.participantSecrets)) assert(!JSON.stringify(cooperative).includes(secret));
checks.push('abandonment retains exposed material; strict public schema and fresh anchored source reject secrets and changed chain evidence');
for (const predecessor of [cooperative,recovery]) {
  const reanchor = action({ kind: 'reanchor-transaction',proposalId: randomUUID(),
    predecessorProposalId: predecessor.proposal.proposalId,predecessorProposalDigest: predecessor.proposal.digest,
    transactionDigest: predecessor.finalized!.transactionDigest,confirmationBlockHash: '66'.repeat(32) });
  const observation = { ...observe(predecessor.proposal.source),confirmationBlockHash: '66'.repeat(32) };
  let successor = applyPresignedRuntimeAction({ graph,state: predecessor,action: reanchor,participantId: 'bob',observation,requiredConfirmations: 2 });
  assert.equal(successor.finalized!.transactionHex,predecessor.finalized!.transactionHex);
  assert.equal(successor.finalized!.txid,predecessor.finalized!.txid);
  assert.notEqual(successor.finalized!.transactionDigest,predecessor.finalized!.transactionDigest);
  assert.deepEqual(successor.finalized!.approverParticipantIds,predecessor.finalized!.approverParticipantIds);
  assert.deepEqual([successor.publicNonces,successor.partials,successor.recoveryContributions,successor.broadcastApprovals],[[],[],[],[]]);
  assert.equal(presignedRuntimeBroadcastReady(successor),false);
  for (const id of successor.finalized!.approverParticipantIds) successor = apply(successor,id,
    { kind: 'approve-broadcast',transactionDigest: successor.finalized!.transactionDigest },observation);
  assert(presignedRuntimeBroadcastReady(successor));
  assert(presignedRuntimeBroadcastReady(predecessor),'old signatures and approvals must remain recorded, not claimed revoked');
}
checks.push('cooperative/recovery reanchor creates a fresh fully reapproved execution context with identical bytes and no copied nonces or partials');
console.log(JSON.stringify({ suite: 'presigned-runtime', network: graph.roster.network, passed: checks.length, checks,
  evidence: 'public fixture cryptography only; no actual chain observation, passkey device, broadcast or provider' }, null, 2));
