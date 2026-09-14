/** Public deterministic fixture keys. No node, live wallet, or public broadcast. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { createPresignedFixture, authorizePresignedFixtureRecoveries, signPresignedFixtureFunding, preauthorizePresignedFixture } from './fixtures.js';
import { PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3, type ParticipantId } from './types.js';
import { buildPresignedSpend, createPresignedRecoveryContribution, finalizePresignedRecovery,
  authorizePresignedSpendTransaction, validatePresignedSpend, createPresignedCooperativeNonce,
  signPresignedCooperativePartial, finalizePresignedCooperative, signPresignedFinalSweep } from './spends.js';
import { completePresignedExit } from './signing.js';
import { applyPresignedRuntimeAction, presignedRuntimeBroadcastReady, validatePresignedRuntimeAction,
  type PresignedRuntimeState, type PresignedRuntimeAction } from './runtime.js';
import { initialPresignedGraphChainState } from './chain.js';
import { buildPresignedSpendFeeChild, signPresignedSpendFeePayout, finalizePresignedSpendFeeChild,
  type PresignedSpendFeeRequest } from './spend-fees.js';
import { buildPresignedFeeDraft } from './fee-package.js';
import { buildPresignedFeeChild, signPresignedFeePayout, finalizePresignedFeeChild, type FeeCoinObservation } from './fees.js';
import { buildPresignedFundingFeeChild, authorizePresignedFundingFeeSignedPsbt, finalizePresignedFundingFeeChild,
  type PresignedFundingFeeRequest } from './funding-fees.js';

const fixture = createPresignedFixture({ protocol: PRESIGNED_PROTOCOL_V3 });
const { graph, keysById } = fixture;
const recoveryAuthorizations = authorizePresignedFixtureRecoveries(fixture);
const header = { version: graph.version, protocol: graph.protocol };
assert.equal(graph.version, 3);
assert.equal(recoveryAuthorizations.length, 9);
const funding = signPresignedFixtureFunding(fixture);
assert.equal(funding.txid, graph.fundingTxid);
assert.equal(initialPresignedGraphChainState(graph).protocol, PRESIGNED_PROTOCOL_V3);
let quorumCases = 0;
let feePositions = 0;
const sizes: Record<string, number> = {};

function observe(source: Pick<FeeCoinObservation, 'txid' | 'vout' | 'valueSats' | 'scriptPubKeyHex'>): FeeCoinObservation {
  return { txid: source.txid, vout: source.vout, valueSats: source.valueSats, scriptPubKeyHex: source.scriptPubKeyHex,
    network: graph.roster.network, genesisHash: graph.roster.genesisHash,
    confirmationBlockHash: '55'.repeat(32), confirmations: graph.roster.economics.recoveryDelayBlocks,
    unspentInActiveChain: true, coinbase: false };
}

function finalizeFee(request: PresignedSpendFeeRequest) {
  const built = buildPresignedSpendFeeChild(request);
  const payout = signPresignedSpendFeePayout({ request, psbtBase64: built.psbtBase64,
    approvalDigest: built.approvalDigest, keys: keysById[request.payoutParticipantId] });
  const psbt = bitcoin.Psbt.fromBase64(built.psbtBase64);
  const wallet = fixture.walletKeys.bob;
  psbt.signInput(1, { publicKey: wallet.publicKey, sign: hash => ecc.sign(hash, wallet.privateKey) });
  return finalizePresignedSpendFeeChild({ request, approvalDigest: built.approvalDigest,
    payoutSignatureHex: payout.payoutSignatureHex, sponsorSignedPsbtBase64: psbt.toBase64() });
}

for (const refund of graph.recoveries!) {
  const proposal = buildPresignedSpend({ graph, proposalId: randomUUID(), kind: 'recovery', sourceExitId: refund.parentExitId });
  assert.equal(proposal.unsignedTxHex, refund.unsignedTxHex);
  assert.equal(proposal.psbtBase64, refund.psbtBase64);
  assert.equal(proposal.signatureHash, refund.signatureHash);
  assert.equal(proposal.version, 3);
  assert.throws(() => validatePresignedSpend(graph, { ...proposal, feeSats: proposal.feeSats + 1 }));
  assert.throws(() => validatePresignedSpend(graph, { ...proposal, version: 2, protocol: PRESIGNED_PROTOCOL }));
  const contributions = proposal.participantIds.map(id => createPresignedRecoveryContribution({
    graph, proposal, participantId: id, recoveryTriggerPrivateKey: keysById[id].recoveryTriggerPrivateKeys![refund.roundId]!,
    approvedProposalDigest: proposal.digest }));
  for (const missing of proposal.participantIds) {
    const quorum = contributions.filter(item => item.participantId !== missing);
    const result = finalizePresignedRecovery({ graph, proposal, contributions: quorum, recoveryAuthorizations });
    const tx = bitcoin.Transaction.fromHex(result.transactionHex);
    sizes[refund.roundId] = result.vsize;
    assert.equal(tx.ins[0]!.witness.length, 2 * proposal.participantIds.length + 2);
    assert.deepEqual(tx.outs, bitcoin.Transaction.fromHex(refund.unsignedTxHex).outs);
    assert.equal(result.feeSats, graph.roster.economics.recoveryFeeSats);
    assert(result.vsize <= result.feeSats);
    assert.throws(() => finalizePresignedRecovery({ graph, proposal, contributions: quorum }));
    assert.throws(() => finalizePresignedRecovery({ graph, proposal, contributions: quorum,
      recoveryAuthorizations: recoveryAuthorizations.filter(item => item.participantId !== missing) }));
    const omittedAuth = tx.clone();
    omittedAuth.ins[0]!.witness[proposal.participantIds.length] = Buffer.alloc(0);
    assert.throws(() => authorizePresignedSpendTransaction({ graph, proposal, transactionHex: omittedAuth.toHex() }), /authorization/);
    const annex = tx.clone(); annex.ins[0]!.witness.push(Buffer.from('50', 'hex'));
    assert.throws(() => authorizePresignedSpendTransaction({ graph, proposal, transactionHex: annex.toHex() }));
    const changed = tx.clone(); changed.outs[0]!.value -= 1n;
    assert.throws(() => authorizePresignedSpendTransaction({ graph, proposal, transactionHex: changed.toHex() }), /approved transaction/);
    quorumCases++;
  }
  const quorum = contributions.slice(0, proposal.threshold);
  assert.throws(() => finalizePresignedRecovery({ graph, proposal, contributions, recoveryAuthorizations }), /threshold/);
  assert.throws(() => finalizePresignedRecovery({ graph, proposal, contributions: quorum.slice(1), recoveryAuthorizations }), /threshold/);
  if (quorum.length === 2) assert.throws(() => finalizePresignedRecovery({ graph, proposal,
    contributions: [quorum[0]!, quorum[0]!], recoveryAuthorizations }), /duplicate/);
  const actor = proposal.participantIds[0]!;
  for (const wrong of [keysById[actor].personalPrivateKey, keysById[actor].recoveryAuthorizationPrivateKeys![refund.roundId]!]) {
    assert.throws(() => createPresignedRecoveryContribution({ graph, proposal, participantId: actor,
      recoveryTriggerPrivateKey: wrong, approvedProposalDigest: proposal.digest }), /trigger key/);
  }
  assert.throws(() => createPresignedRecoveryContribution({ graph, proposal, participantId: actor,
    personalPrivateKey: keysById[actor].personalPrivateKey, approvedProposalDigest: proposal.digest }), /key role/);

  const parent = finalizePresignedRecovery({ graph, proposal, contributions: quorum, recoveryAuthorizations });
  for (const owner of proposal.participantIds) {
    const request: PresignedSpendFeeRequest = { graph, parentSpendProposal: proposal, parentTransactionHex: parent.transactionHex,
      payoutParticipantId: owner, sourceObservation: observe(proposal.source), sponsorInput: observe({ txid: '77'.repeat(32),
        vout: 0, valueSats: 20_000, scriptPubKeyHex: fixture.walletKeys.bob.scriptPubKeyHex }),
      approval: { childFeeSats: 3_000, maxChildFeeSats: 10_000, targetPackageRateMillisatsPerVbyte: 5_000,
        minRelayRateMillisatsPerVbyte: 1_000, sponsorChangeScriptPubKeyHex: fixture.walletKeys.bob.scriptPubKeyHex,
        approveExactNoChangeFee: false, replacement: null } };
    const child = finalizeFee(request);
    const childTx = bitcoin.Transaction.fromHex(child.transactionHex);
    assert.equal(child.version, 3);
    assert.equal(child.protocol, PRESIGNED_PROTOCOL_V3);
    assert.equal(child.parentVsize, parent.vsize);
    assert.deepEqual(childTx.outs[0], bitcoin.Transaction.fromHex(parent.transactionHex).outs[proposal.participantIds.indexOf(owner)]);
    assert.equal(Number(childTx.outs[1]!.value), request.sponsorInput.valueSats - request.approval.childFeeSats);
    const replacement = finalizeFee({ ...request, approval: { ...request.approval, childFeeSats: 4_000,
      replacement: { previousChildTransactionHex: child.transactionHex, incrementalRelayRateMillisatsPerVbyte: 1_000 } } });
    assert.equal(replacement.childFeeSats, 4_000);
    assert.throws(() => buildPresignedSpendFeeChild({ ...request, sponsorInput: { ...request.sponsorInput,
      txid: graph.recoveries!.find(item => item.id !== refund.id)!.txid } }), /fixed recovery/);
    const draft = { ...header, epochId: graph.funding.epochId, proposalId: proposal.proposalId,
      ownerParticipantId: owner, parentAuthorityDigest: proposal.digest, mode: 'spend' as const, request };
    assert.equal(buildPresignedFeeDraft(draft).protocol, PRESIGNED_PROTOCOL_V3);
    assert.throws(() => buildPresignedFeeDraft({ ...draft, version: 2, protocol: PRESIGNED_PROTOCOL }), /graph protocol/);
    feePositions++;
  }

  let state: PresignedRuntimeState | null = null;
  const act = (action: PresignedRuntimeAction, id: ParticipantId, block = '55'.repeat(32)) => {
    state = applyPresignedRuntimeAction({ graph, state, action, participantId: id,
      observation: { ...observe(proposal.source), confirmationBlockHash: block }, requiredConfirmations: 1, recoveryAuthorizations });
    return state;
  };
  let current = act({ ...header, kind: 'create-proposal', epochId: graph.funding.epochId, graphDigest: graph.digest,
    proposalId: proposal.proposalId, spendKind: 'recovery', sourceExitId: refund.parentExitId, exitId: null,
    confirmationBlockHash: '55'.repeat(32) }, actor);
  for (const contribution of quorum) current = act({ ...header, kind: 'contribute-recovery', proposalId: proposal.proposalId,
    proposalDigest: current.proposal.digest, contribution }, contribution.participantId);
  assert.equal(current.status, 'finalized');
  assert.deepEqual(current.finalized!.approverParticipantIds, quorum.map(item => item.participantId).sort());
  assert.equal(presignedRuntimeBroadcastReady(current), false);
  for (const id of current.finalized!.approverParticipantIds) current = act({ ...header, kind: 'approve-broadcast',
    proposalId: current.proposal.proposalId, proposalDigest: current.proposal.digest,
    transactionDigest: current.finalized!.transactionDigest }, id);
  assert(presignedRuntimeBroadcastReady(current));
  const old = current;
  const reanchored = act({ ...header, kind: 'reanchor-transaction', proposalId: randomUUID(),
    predecessorProposalId: old.proposal.proposalId, predecessorProposalDigest: old.proposal.digest,
    transactionDigest: old.finalized!.transactionDigest, confirmationBlockHash: '66'.repeat(32) }, actor, '66'.repeat(32));
  assert.equal(reanchored.finalized!.transactionHex, old.finalized!.transactionHex);
  assert.equal(reanchored.broadcastApprovals.length, 0);
  assert.equal(reanchored.protocol, PRESIGNED_PROTOCOL_V3);
  console.log(`V3 runtime complete: ${refund.roundId}`);
}

const cooperative = buildPresignedSpend({ graph, proposalId: randomUUID(), kind: 'cooperative', sourceExitId: null });
const nonces = cooperative.participantIds.map(id => createPresignedCooperativeNonce({ graph, proposal: cooperative,
  participantId: id, personalPrivateKey: keysById[id].personalPrivateKey, approvedProposalDigest: cooperative.digest }));
const publicNonces = nonces.map(item => item.publicNonce);
const partials = nonces.map(item => signPresignedCooperativePartial({ graph, proposal: cooperative,
  participantId: item.publicNonce.participantId, personalPrivateKey: keysById[item.publicNonce.participantId].personalPrivateKey,
  approvedProposalDigest: cooperative.digest, publicNonces, nonceBinding: item.binding, consumedSecretNonce: item.secretNonce }));
const cooperativeParent = finalizePresignedCooperative({ graph, proposal: cooperative, publicNonces, partials });
assert.equal(cooperativeParent.txid, cooperative.txid);
assert.throws(() => validatePresignedRuntimeAction({ version: 2, protocol: PRESIGNED_PROTOCOL, kind: 'contribute-nonce',
  proposalId: cooperative.proposalId, proposalDigest: cooperative.digest, publicNonce: publicNonces[0]! }), /mixed/);

// Remaining four parent families use the same protocol-bound sponsor policy.
const sponsorInput = observe({ txid: '77'.repeat(32), vout: 0, valueSats: 20_000,
  scriptPubKeyHex: fixture.walletKeys.bob.scriptPubKeyHex });
const approval = { childFeeSats: 3_000, maxChildFeeSats: 10_000, targetPackageRateMillisatsPerVbyte: 5_000,
  minRelayRateMillisatsPerVbyte: 1_000, sponsorChangeScriptPubKeyHex: sponsorInput.scriptPubKeyHex,
  approveExactNoChangeFee: false, replacement: null };
const fundedRequest: PresignedFundingFeeRequest = { graph, fundingTransactionHex: funding.transactionHex,
  changeParticipantId: 'alice', fundingInputObservations: graph.funding.inputs.map(observe), sponsorInput, approval };
const fundedChild = buildPresignedFundingFeeChild(fundedRequest);
const signatures = (['change', 'sponsor'] as const).map((role, index) => {
  const psbt = bitcoin.Psbt.fromBase64(fundedChild.psbtBase64);
  const wallet = fixture.walletKeys[role === 'change' ? 'alice' : 'bob'];
  if (wallet.kind === 'p2wpkh') psbt.signInput(index, { publicKey: wallet.publicKey, sign: hash => ecc.sign(hash, wallet.privateKey) });
  else {
    const key = wallet.publicKey.subarray(1);
    const tweaked = ecc.privateAdd(wallet.publicKey[0] === 3 ? ecc.privateNegate(wallet.privateKey) : wallet.privateKey,
      bitcoin.crypto.taggedHash('TapTweak', key))!;
    psbt.updateInput(index, { tapInternalKey: key });
    psbt.signInput(index, { publicKey: Buffer.from(ecc.pointFromScalar(tweaked, true)!),
      sign: () => { throw new Error('not an ECDSA input'); }, signSchnorr: hash => ecc.signSchnorr(hash, tweaked) });
  }
  return authorizePresignedFundingFeeSignedPsbt({ request: fundedRequest, role,
    signedPsbtBase64: psbt.toBase64(), approvalDigest: fundedChild.approvalDigest });
});
const funded = finalizePresignedFundingFeeChild({ request: fundedRequest, approvalDigest: fundedChild.approvalDigest, signatures });
assert.equal(funded.protocol, PRESIGNED_PROTOCOL_V3);
assert.deepEqual(bitcoin.Transaction.fromHex(funded.transactionHex).outs[0], bitcoin.Transaction.fromHex(funding.transactionHex).outs[1]);

const exit = graph.exits.find(item => item.id === 'alice')!;
const solo = completePresignedExit({ graph, preauthorizations: preauthorizePresignedFixture(fixture), exitId: exit.id,
  participantId: 'alice', privateKey: keysById.alice.soloPrivateKeys[exit.roundId]!, approvedGraphDigest: graph.digest });
const soloRequest = { graph, exitId: exit.id, parentTransactionHex: solo.transactionHex,
  roundInputObservation: observe({ txid: exit.inputTxid, vout: exit.inputVout, valueSats: exit.inputValueSats,
    scriptPubKeyHex: exit.inputScriptPubKeyHex }), sponsorInput, approval };
const soloBuilt = buildPresignedFeeChild(soloRequest);
const soloPayout = signPresignedFeePayout({ request: soloRequest, psbtBase64: soloBuilt.psbtBase64,
  approvalDigest: soloBuilt.approvalDigest, keys: keysById.alice });
const soloWallet = bitcoin.Psbt.fromBase64(soloBuilt.psbtBase64);
soloWallet.signInput(1, { publicKey: fixture.walletKeys.bob.publicKey,
  sign: hash => ecc.sign(hash, fixture.walletKeys.bob.privateKey) });
const soloChild = finalizePresignedFeeChild({ request: soloRequest, approvalDigest: soloBuilt.approvalDigest,
  payoutSignatureHex: soloPayout.payoutSignatureHex, sponsorSignedPsbtBase64: soloWallet.toBase64() });
assert.equal(soloChild.protocol, PRESIGNED_PROTOCOL_V3);
assert.deepEqual(bitcoin.Transaction.fromHex(soloChild.transactionHex).outs[0], bitcoin.Transaction.fromHex(solo.transactionHex).outs[0]);
const cooperativeChild = finalizeFee({ graph, parentSpendProposal: cooperative,
  parentTransactionHex: cooperativeParent.transactionHex, payoutParticipantId: 'alice',
  sourceObservation: observe(cooperative.source), sponsorInput, approval });
assert.equal(cooperativeChild.protocol, PRESIGNED_PROTOCOL_V3);
const finalProposal = buildPresignedSpend({ graph, kind: 'final-sweep', proposalId: randomUUID(), sourceExitId: 'alice/bob' });
const finalParent = signPresignedFinalSweep({ graph, proposal: finalProposal, participantId: 'carol',
  payoutPrivateKey: keysById.carol.payoutPrivateKey, approvedProposalDigest: finalProposal.digest });
const finalChild = finalizeFee({ graph, parentSpendProposal: finalProposal, parentTransactionHex: finalParent.transactionHex,
  payoutParticipantId: 'carol', sourceObservation: observe(finalProposal.source), sponsorInput, approval });
assert.equal(finalChild.protocol, PRESIGNED_PROTOCOL_V3);
assert.equal(quorumCases, 9);
assert.equal(feePositions, 9);
console.log(JSON.stringify({ passed: true, protocol: graph.protocol, recoveryQuorums: quorumCases,
  sponsoredRefundPositions: feePositions, replacements: feePositions, actualRecoveryVsizes: sizes,
  runtimeReanchors: 4, cooperativeMuSig2: true, sponsoredParentFamilies: 5, publicNetworkBroadcasts: 0 }));
