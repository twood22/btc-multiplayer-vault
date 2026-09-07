/** Public deterministic fixture keys only. No node, provider or live wallet. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { deterministicKeypair, sha256Hex } from '../crypto.js';
import { createPresignedFixture } from './fixtures.js';
import { PARTICIPANT_IDS, type ParticipantId } from './types.js';
import { buildPresignedSpend, createPresignedCooperativeNonce, createPresignedRecoveryContribution,
  finalizePresignedCooperative, finalizePresignedRecovery, signPresignedCooperativePartial,
  signPresignedFinalSweep, type PresignedSpendProposal } from './spends.js';
import { type FeeCoinObservation } from './fees.js';
import { buildPresignedSpendFeeChild, authorizePresignedSpendFeeChild, signPresignedSpendFeePayout,
  finalizePresignedSpendFeeChild, type PresignedSpendFeeRequest } from './spend-fees.js';
import { verifyNativeWalletWitness } from './wallet.js';

type Fixture = ReturnType<typeof createPresignedFixture>;
type SponsorKind = 'p2tr-default' | 'p2tr-all' | 'p2wpkh';

function signedParent(fixture: Fixture, proposal: PresignedSpendProposal) {
  const { graph, keysById } = fixture;
  if (proposal.kind === 'final-sweep') {
    const id = proposal.source.owner!;
    return signPresignedFinalSweep({ graph, proposal, participantId: id,
      payoutPrivateKey: keysById[id].payoutPrivateKey, approvedProposalDigest: proposal.digest });
  }
  if (proposal.kind === 'recovery') {
    const contributions = proposal.participantIds.slice(0, proposal.threshold).map(id => createPresignedRecoveryContribution({
      graph, proposal, participantId: id, personalPrivateKey: keysById[id].personalPrivateKey, approvedProposalDigest: proposal.digest }));
    return finalizePresignedRecovery({ graph, proposal, contributions });
  }
  const generated = proposal.participantIds.map(id => createPresignedCooperativeNonce({ graph, proposal,
    participantId: id, personalPrivateKey: keysById[id].personalPrivateKey, approvedProposalDigest: proposal.digest }));
  const publicNonces = generated.map(item => item.publicNonce);
  const partials = generated.map(item => signPresignedCooperativePartial({ graph, proposal,
    participantId: item.publicNonce.participantId, personalPrivateKey: keysById[item.publicNonce.participantId].personalPrivateKey,
    approvedProposalDigest: proposal.digest, publicNonces, nonceBinding: item.binding, consumedSecretNonce: item.secretNonce }));
  assert(generated.every(item => item.secretNonce.every(byte => byte === 0)));
  return finalizePresignedCooperative({ graph, proposal, publicNonces, partials });
}

function observed(fixture: Fixture, coin: Pick<FeeCoinObservation, 'txid' | 'vout' | 'valueSats' | 'scriptPubKeyHex'>): FeeCoinObservation {
  return { txid: coin.txid, vout: coin.vout, valueSats: coin.valueSats, scriptPubKeyHex: coin.scriptPubKeyHex,
    network: fixture.graph.roster.network, genesisHash: fixture.graph.roster.genesisHash,
    confirmationBlockHash: sha256Hex('public-synthetic-spend-fee-confirmation'), confirmations: 20,
    unspentInActiveChain: true, coinbase: false };
}

function requestFor(fixture: Fixture, proposal: PresignedSpendProposal, transactionHex: string,
  id: ParticipantId, kind: SponsorKind): PresignedSpendFeeRequest {
  const pair = deterministicKeypair('public-offline-spend-fee-sponsor', kind);
  const script = kind === 'p2wpkh' ? bitcoin.payments.p2wpkh({ pubkey: Buffer.from(pair.publicKeyHex, 'hex') }).output!
    : bitcoin.payments.p2tr({ internalPubkey: Buffer.from(pair.xonlyPubKeyHex, 'hex') }).output!;
  const scriptPubKeyHex = Buffer.from(script).toString('hex');
  return { graph: fixture.graph, parentSpendProposal: proposal, parentTransactionHex: transactionHex, payoutParticipantId: id,
    sourceObservation: observed(fixture, proposal.source), sponsorInput: observed(fixture, {
      txid: sha256Hex(`public-spend-fee-sponsor-coin:${kind}`), vout: 0, valueSats: 20_000, scriptPubKeyHex }),
    approval: { childFeeSats: 3_000, maxChildFeeSats: 10_000, targetPackageRateMillisatsPerVbyte: 5_000,
      minRelayRateMillisatsPerVbyte: 1_000, sponsorChangeScriptPubKeyHex: scriptPubKeyHex,
      approveExactNoChangeFee: false, replacement: null } };
}

function sponsorSigned(request: PresignedSpendFeeRequest, kind: SponsorKind) {
  const psbt = bitcoin.Psbt.fromBase64(buildPresignedSpendFeeChild(request).psbtBase64);
  const tx = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
  const pair = deterministicKeypair('public-offline-spend-fee-sponsor', kind);
  const secret = Buffer.from(pair.privateKeyHex, 'hex');
  if (kind === 'p2wpkh') {
    const scriptCode = bitcoin.payments.p2pkh({ pubkey: Buffer.from(pair.publicKeyHex, 'hex') }).output!;
    const hash = tx.hashForWitnessV0(1, scriptCode, BigInt(request.sponsorInput.valueSats), bitcoin.Transaction.SIGHASH_ALL);
    psbt.updateInput(1, { partialSig: [{ pubkey: Buffer.from(pair.publicKeyHex, 'hex'),
      signature: bitcoin.script.signature.encode(ecc.sign(hash, secret), bitcoin.Transaction.SIGHASH_ALL) }] });
  } else {
    const type = kind === 'p2tr-all' ? bitcoin.Transaction.SIGHASH_ALL : bitcoin.Transaction.SIGHASH_DEFAULT;
    const hash = tx.hashForWitnessV1(1, psbt.data.inputs.map(input => input.witnessUtxo!.script), psbt.data.inputs.map(input => input.witnessUtxo!.value), type);
    const tweaked = ecc.privateAdd(pair.publicKeyHex.startsWith('03') ? ecc.privateNegate(secret) : secret,
      bitcoin.crypto.taggedHash('TapTweak', Buffer.from(pair.xonlyPubKeyHex, 'hex')))!;
    const raw = Buffer.from(ecc.signSchnorr(hash, tweaked));
    psbt.updateInput(1, { tapKeySig: type === bitcoin.Transaction.SIGHASH_ALL ? Buffer.concat([raw, Buffer.from([type])]) : raw });
  }
  return psbt.toBase64();
}

function finalized(fixture: Fixture, request: PresignedSpendFeeRequest, kind: SponsorKind) {
  const built = buildPresignedSpendFeeChild(request);
  const payout = signPresignedSpendFeePayout({ request, psbtBase64: built.psbtBase64, approvalDigest: built.approvalDigest,
    keys: fixture.keysById[request.payoutParticipantId] });
  return finalizePresignedSpendFeeChild({ request, approvalDigest: built.approvalDigest,
    payoutSignatureHex: payout.payoutSignatureHex, sponsorSignedPsbtBase64: sponsorSigned(request, kind) });
}

const checks: string[] = [];
let payoutPositions = 0;
for (const network of ['signet', 'mainnet'] as const) {
  const fixture = createPresignedFixture({ network });
  const graphCommitment = JSON.stringify(fixture.graph);
  const proposals = [
    ...([null, ...PARTICIPANT_IDS] as const).flatMap(sourceExitId => (['cooperative', 'recovery'] as const).map(kind =>
      buildPresignedSpend({ graph: fixture.graph, proposalId: randomUUID(), kind, sourceExitId }))),
    ...fixture.graph.exits.filter(exit => exit.parentExitId !== null).map(exit => buildPresignedSpend({ graph: fixture.graph,
      proposalId: randomUUID(), kind: 'final-sweep', sourceExitId: exit.id })),
  ];
  const requests: Array<{ request: PresignedSpendFeeRequest; kind: SponsorKind }> = [];
  for (const proposal of proposals) {
    const parent = signedParent(fixture, proposal);
    const originalProposal = JSON.stringify(proposal);
    const parentTx = bitcoin.Transaction.fromHex(parent.transactionHex);
    assert.equal(parentTx.version, 3);
    for (const [index, id] of proposal.participantIds.entries()) {
      const kind = (['p2tr-default', 'p2tr-all', 'p2wpkh'] as const)[payoutPositions % 3]!;
      const request = requestFor(fixture, proposal, parent.transactionHex, id, kind);
      const result = finalized(fixture, request, kind);
      const child = bitcoin.Transaction.fromHex(result.transactionHex);
      assert.equal(result.payoutVout, index);
      assert.equal(result.payoutParticipantId, id);
      assert.equal(result.parentSpendProposalDigest, proposal.digest);
      assert.equal(child.version, 3);
      assert.equal(child.ins[0]!.index, index);
      assert.equal(Buffer.from(child.ins[0]!.hash).reverse().toString('hex'), parent.txid);
      assert.deepEqual(child.outs[0], parentTx.outs[index]);
      assert.equal(Number(child.outs[1]!.value), request.sponsorInput.valueSats - result.childFeeSats);
      assert.equal(child.ins.length, 2);
      assert.equal(child.outs.length, 2);
      assert(child.virtualSize() <= 1000);
      assert.equal(result.parentFeeSats, proposal.feeSats);
      assert.equal(JSON.stringify(fixture.graph), graphCommitment);
      assert.equal(JSON.stringify(proposal), originalProposal);
      const prevouts = [{ valueSats: result.payoutSats, scriptPubKeyHex: Buffer.from(child.outs[0]!.script).toString('hex') }, request.sponsorInput];
      verifyNativeWalletWitness(child, 0, prevouts, child.ins[0]!.witness);
      verifyNativeWalletWitness(child, 1, prevouts, child.ins[1]!.witness);
      requests.push({ request, kind });
      payoutPositions++;
    }
  }
  checks.push(`${network}: all 24 payout positions across four cooperative rounds, four recovery rounds and six final sweeps preserve every committed amount/script with version-3 sponsorship`);
  console.log(`Completed ${network} all 24 spend-payout positions`);

  const { request, kind } = requests.find(item => item.request.parentSpendProposal.kind === 'cooperative' &&
    item.request.parentSpendProposal.sourceExitId === null && item.request.payoutParticipantId === 'alice')!;
  const built = buildPresignedSpendFeeChild(request);
  const own = signPresignedSpendFeePayout({ request, psbtBase64: built.psbtBase64, approvalDigest: built.approvalDigest, keys: fixture.keysById.alice });
  assert.throws(() => signPresignedSpendFeePayout({ request, psbtBase64: built.psbtBase64, approvalDigest: built.approvalDigest, keys: fixture.keysById.bob }), /selected payout owner/);
  assert.throws(() => signPresignedSpendFeePayout({ request, psbtBase64: built.psbtBase64, approvalDigest: built.approvalDigest,
    keys: { ...fixture.keysById.alice, payoutPrivateKey: fixture.keysById.alice.personalPrivateKey } }), /payout key/);
  assert.throws(() => buildPresignedSpendFeeChild({ ...request, payoutVout: 2 } as PresignedSpendFeeRequest), /unexpected/);
  const pair = requests.find(item => item.request.parentSpendProposal.sourceExitId === 'alice')!.request;
  assert.throws(() => buildPresignedSpendFeeChild({ ...pair, payoutParticipantId: 'alice' }), /does not own/);
  for (const sourceObservation of [
    { ...request.sourceObservation, confirmations: 0 },
    { ...request.sourceObservation, vout: 1 },
    { ...request.sourceObservation, txid: '11'.repeat(32) },
    { ...request.sourceObservation, confirmationBlockHash: '00'.repeat(32) },
    { ...request.sourceObservation, valueSats: request.sourceObservation.valueSats + 1 },
  ]) assert.throws(() => buildPresignedSpendFeeChild({ ...request, sourceObservation }));
  const recovery = requests.find(item => item.request.parentSpendProposal.kind === 'recovery')!.request;
  assert.throws(() => buildPresignedSpendFeeChild({ ...recovery, sourceObservation: { ...recovery.sourceObservation,
    confirmations: fixture.graph.roster.economics.recoveryDelayBlocks - 1 } }), /CSV age/);
  assert.throws(() => buildPresignedSpendFeeChild({ ...request, sponsorInput: { ...request.sponsorInput, confirmations: 0 } }));
  assert.throws(() => buildPresignedSpendFeeChild({ ...request, sponsorInput: { ...request.sponsorInput,
    txid: built.parentTxid, vout: 1 } }), /every payout/);
  assert.throws(() => buildPresignedSpendFeeChild({ ...request, sponsorInput: { ...request.sponsorInput, txid: fixture.graph.fundingTxid } }), /outside/);
  assert.throws(() => buildPresignedSpendFeeChild({ ...request, approval: { ...request.approval, childFeeSats: 10_001 } }), /fee/);
  checks.push(`${network}: wrong payout owner/index/key, unconfirmed or mismatched source, immature CSV and graph/parent-payout sponsors fail closed`);

  const changedParent = bitcoin.Transaction.fromHex(request.parentTransactionHex);
  changedParent.outs[1]!.value -= 1n;
  assert.throws(() => buildPresignedSpendFeeChild({ ...request, parentTransactionHex: changedParent.toHex() }), /approved transaction/);
  const badWitness = bitcoin.Transaction.fromHex(request.parentTransactionHex);
  badWitness.ins[0]!.witness[0] = Buffer.alloc(64);
  assert.throws(() => buildPresignedSpendFeeChild({ ...request, parentTransactionHex: badWitness.toHex() }), /signature/);
  assert.throws(() => buildPresignedSpendFeeChild({ ...request, parentSpendProposal: { ...request.parentSpendProposal,
    participantIds: [...request.parentSpendProposal.participantIds].reverse() } }), /spend proposal/);
  assert.throws(() => authorizePresignedSpendFeeChild({ request, psbtBase64: built.psbtBase64, approvalDigest: '00'.repeat(32) }), /digest/);
  const changedChild = bitcoin.Psbt.fromBase64(built.psbtBase64);
  changedChild.setVersion(2);
  assert.throws(() => authorizePresignedSpendFeeChild({ request, psbtBase64: changedChild.toBase64(), approvalDigest: built.approvalDigest }), /transaction differs/);
  const changedPrevout = bitcoin.Psbt.fromBase64(built.psbtBase64);
  changedPrevout.data.inputs[1]!.witnessUtxo!.value += 1n;
  assert.throws(() => authorizePresignedSpendFeeChild({ request, psbtBase64: changedPrevout.toBase64(), approvalDigest: built.approvalDigest }), /prevout/);
  assert.throws(() => finalizePresignedSpendFeeChild({ request, approvalDigest: built.approvalDigest,
    payoutSignatureHex: `${own.payoutSignatureHex}01`, sponsorSignedPsbtBase64: sponsorSigned(request, kind) }), /SIGHASH_DEFAULT/);
  const crossSigned = bitcoin.Psbt.fromBase64(sponsorSigned(request, kind));
  crossSigned.updateInput(0, { tapKeySig: Buffer.from(own.payoutSignatureHex, 'hex') });
  assert.throws(() => finalizePresignedSpendFeeChild({ request, approvalDigest: built.approvalDigest,
    payoutSignatureHex: own.payoutSignatureHex, sponsorSignedPsbtBase64: crossSigned.toBase64() }), /another signer/);
  checks.push(`${network}: altered other-party payouts, invalid parent witnesses, reordered proposals, changed approval/PSBT/prevouts and cross-input signatures are rejected`);

  const original = finalized(fixture, request, kind);
  const replacement: PresignedSpendFeeRequest = { ...request, approval: { ...request.approval, childFeeSats: 4_000,
    replacement: { previousChildTransactionHex: original.transactionHex, incrementalRelayRateMillisatsPerVbyte: 1_000 } } };
  const bumped = finalized(fixture, replacement, kind);
  assert.equal(bumped.parentTxid, original.parentTxid);
  assert.equal(bumped.payoutVout, original.payoutVout);
  assert.notEqual(bumped.txid, original.txid);
  assert.throws(() => finalized(fixture, { ...replacement, approval: { ...replacement.approval, childFeeSats: 3_001 } }, kind), /incremental/);
  assert.throws(() => buildPresignedSpendFeeChild({ ...replacement, payoutParticipantId: 'bob' }), /retain exact/);
  const noChange: PresignedSpendFeeRequest = { ...request, sponsorInput: { ...request.sponsorInput, valueSats: 3_000 },
    approval: { ...request.approval, sponsorChangeScriptPubKeyHex: null, approveExactNoChangeFee: true } };
  assert.equal(bitcoin.Transaction.fromHex(finalized(fixture, noChange, kind).transactionHex).outs.length, 1);
  assert.throws(() => buildPresignedSpendFeeChild({ ...noChange, approval: { ...noChange.approval, approveExactNoChangeFee: false } }), /explicit/);
  assert.throws(() => finalized(fixture, { ...request, approval: { ...request.approval, targetPackageRateMillisatsPerVbyte: 30_000 } }, kind), /package feerate/);
  checks.push(`${network}: exact no-change fees and same-payout replacement work; payout switching, underfunded targets and inadequate replacement deltas are rejected`);
}
assert.equal(payoutPositions, 48);
console.log(JSON.stringify({ passed: true, offlineOnly: true, actualBitcoinCoreAcceptance: false, payoutPositions, checks }, null, 2));
