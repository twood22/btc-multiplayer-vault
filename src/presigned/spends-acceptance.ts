import assert from 'node:assert/strict';
import { Buffer } from 'buffer';
import { randomUUID } from 'node:crypto';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { createPresignedFixture } from './fixtures.js';
import { payoutScript } from './roster.js';
import { PARTICIPANT_IDS, type ParticipantId } from './types.js';
import {
  authorizePresignedSpendTransaction, buildPresignedSpend, createPresignedCooperativeNonce,
  createPresignedRecoveryContribution, finalizePresignedCooperative, finalizePresignedRecovery,
  signPresignedCooperativePartial, signPresignedFinalSweep, validatePresignedCooperativeNonces,
  validatePresignedSpend, verifyPresignedCooperativePartial, verifyPresignedRecoveryContribution,
  type PresignedSpendProposal,
} from './spends.js';

// Public fixture keys only; no live wallets, providers, Bitcoin node or sockets.
// MuSig2 is genuinely interactive: each fixture participant creates an
// independent nonce and partial. No aggregate private key is constructed.
const results: Array<{ network: string; checks: string[] }> = [];
for (const network of ['signet', 'mainnet'] as const) {
  const fixture = createPresignedFixture({ network });
  const { graph, keysById } = fixture;
  const checks: string[] = [];
  const build = (kind: PresignedSpendProposal['kind'], sourceExitId: string | null, proposalId = randomUUID()) =>
    buildPresignedSpend({ graph, proposalId, kind, sourceExitId });
  const generate = (proposal: PresignedSpendProposal) => proposal.participantIds.map(id => createPresignedCooperativeNonce({
    graph, proposal, participantId: id, personalPrivateKey: keysById[id].personalPrivateKey,
    approvedProposalDigest: proposal.digest,
  }));
  function partialsFor(proposal: PresignedSpendProposal, generated: ReturnType<typeof generate>) {
    const publicNonces = generated.map(item => item.publicNonce);
    const partials = generated.map(item => {
      const id = item.publicNonce.participantId;
      const partial = signPresignedCooperativePartial({ graph, proposal, participantId: id,
        personalPrivateKey: keysById[id].personalPrivateKey, approvedProposalDigest: proposal.digest,
        publicNonces, nonceBinding: item.binding, consumedSecretNonce: item.secretNonce });
      assert(item.secretNonce.every(byte => byte === 0), 'signing must erase caller-owned nonce bytes');
      verifyPresignedCooperativePartial({ graph, proposal, publicNonces, partial });
      return partial;
    });
    return { publicNonces, partials };
  }
  function cooperate(proposal: PresignedSpendProposal) {
    const generated = generate(proposal);
    const contributions = partialsFor(proposal, generated);
    return { ...contributions, signed: finalizePresignedCooperative({ graph, proposal, ...contributions }) };
  }
  function assertOutputs(proposal: PresignedSpendProposal, transactionHex: string): void {
    const transaction = bitcoin.Transaction.fromHex(transactionHex);
    assert.equal(transaction.getId(), proposal.txid);
    assert.equal(transaction.ins.length, 1);
    assert.equal(Buffer.from(transaction.ins[0]!.hash).reverse().toString('hex'), proposal.source.txid);
    assert.equal(transaction.ins[0]!.index, proposal.source.vout);
    assert.equal(transaction.outs.length, proposal.participantIds.length);
    const values = transaction.outs.map(output => Number(output.value));
    assert.equal(values.reduce((sum, value) => sum + value, 0), proposal.source.valueSats - proposal.feeSats);
    assert(Math.max(...values) - Math.min(...values) <= 1);
    transaction.outs.forEach((output, index) => assert.equal(Buffer.from(output.script).toString('hex'),
      payoutScript(graph.roster, proposal.participantIds[index]!).toString('hex')));
  }

  const sources = [null, ...graph.exits.filter(exit => exit.parentExitId === null).map(exit => exit.id)];
  for (const sourceExitId of sources) {
    const cooperative = build('cooperative', sourceExitId);
    const completed = cooperate(cooperative);
    assertOutputs(cooperative, completed.signed.transactionHex);
    assert.equal(completed.signed.feeSats, graph.roster.economics.cooperativeFeeSats);
    assert.equal(bitcoin.Transaction.fromHex(completed.signed.transactionHex).ins[0]!.witness.length, 1);
    authorizePresignedSpendTransaction({ graph, proposal: cooperative, transactionHex: completed.signed.transactionHex });

    const recovery = build('recovery', sourceExitId);
    const contributions = recovery.participantIds.map(id => createPresignedRecoveryContribution({ graph,
      proposal: recovery, participantId: id, personalPrivateKey: keysById[id].personalPrivateKey,
      approvedProposalDigest: recovery.digest }));
    contributions.forEach(contribution => verifyPresignedRecoveryContribution({ graph, proposal: recovery, contribution }));
    let previousWitness: string | null = null;
    // Every legal omitted signer must work, including either signer in a pair.
    for (const absent of recovery.participantIds) {
      const selected = contributions.filter(item => item.participantId !== absent);
      const recovered = finalizePresignedRecovery({ graph, proposal: recovery, contributions: selected });
      assertOutputs(recovery, recovered.transactionHex);
      assert.equal(recovered.feeSats, graph.roster.economics.recoveryFeeSats);
      const tx = bitcoin.Transaction.fromHex(recovered.transactionHex);
      assert.equal(tx.version, 3);
      assert.equal(tx.ins[0]!.sequence, graph.roster.economics.recoveryDelayBlocks);
      assert.equal(tx.ins[0]!.witness.filter(item => item.length === 0).length, 1);
      if (previousWitness) assert.notEqual(recovered.transactionHex, previousWitness);
      previousWitness = recovered.transactionHex;
      authorizePresignedSpendTransaction({ graph, proposal: recovery, transactionHex: recovered.transactionHex });
    }
    assert.throws(() => finalizePresignedRecovery({ graph, proposal: recovery, contributions }), /exactly.*N-1/);
    assert.throws(() => finalizePresignedRecovery({ graph, proposal: recovery, contributions: [] }), /threshold/);
    if (recovery.threshold === 2) {
      assert.throws(() => finalizePresignedRecovery({ graph, proposal: recovery,
        contributions: [contributions[0]!, contributions[0]!] }), /duplicate/);
    }
    const outsider = PARTICIPANT_IDS.find(id => !cooperative.participantIds.includes(id));
    if (outsider) {
      assert.throws(() => createPresignedCooperativeNonce({ graph, proposal: cooperative, participantId: outsider,
        personalPrivateKey: keysById[outsider].personalPrivateKey, approvedProposalDigest: cooperative.digest }), /not a member/);
      assert.throws(() => createPresignedRecoveryContribution({ graph, proposal: recovery, participantId: outsider,
        personalPrivateKey: keysById[outsider].personalPrivateKey, approvedProposalDigest: recovery.digest }), /not a member/);
    }
  }
  checks.push('all four rounds complete interactive tweaked MuSig2 and every N-1 recovery subset');
  const defaultRecovery = build('recovery', null);
  assert.deepEqual(bitcoin.Transaction.fromHex(defaultRecovery.unsignedTxHex).outs.map(output => Number(output.value)), [9834, 9833, 9833]);
  checks.push('recovery refunds all current participants and deterministically preserves the exact fee remainder');

  for (const exit of graph.exits.filter(item => item.parentExitId !== null)) {
    const proposal = build('final-sweep', exit.id);
    const id = exit.finalParticipant!;
    const signed = signPresignedFinalSweep({ graph, proposal, participantId: id,
      payoutPrivateKey: keysById[id].payoutPrivateKey, approvedProposalDigest: proposal.digest });
    assertOutputs(proposal, signed.transactionHex);
    assert.equal(proposal.source.txid, exit.txid);
    assert.equal(proposal.source.vout, 1);
    assert.equal(signed.feeSats, graph.roster.economics.finalSweepFeeSats);
    const publicKey = Buffer.from(ecc.pointFromScalar(keysById[id].payoutPrivateKey, true)!);
    const evenKey = publicKey[0] === 3 ? ecc.privateNegate(keysById[id].payoutPrivateKey) : keysById[id].payoutPrivateKey;
    const tweaked = ecc.privateAdd(evenKey, bitcoin.crypto.taggedHash('TapTweak', publicKey.subarray(1)))!;
    const alternate = bitcoin.Transaction.fromHex(signed.transactionHex);
    alternate.setWitness(0, [ecc.signSchnorr(Buffer.from(proposal.signatureHash, 'hex'), tweaked, Buffer.alloc(32, 83))]);
    assert.notEqual(alternate.toHex(), signed.transactionHex);
    assert.equal(alternate.getId(), signed.txid);
    authorizePresignedSpendTransaction({ graph, proposal, transactionHex: alternate.toHex() });
    assert.throws(() => signPresignedFinalSweep({ graph, proposal, participantId: id,
      payoutPrivateKey: keysById[id].personalPrivateKey, approvedProposalDigest: proposal.digest }), /payout key/);
    const outsider = PARTICIPANT_IDS.find(other => other !== id)!;
    assert.throws(() => signPresignedFinalSweep({ graph, proposal, participantId: outsider,
      payoutPrivateKey: keysById[outsider].payoutPrivateKey, approvedProposalDigest: proposal.digest }), /payout owner/);
    assert.throws(() => signPresignedFinalSweep({ graph, proposal, participantId: id,
      payoutPrivateKey: keysById[id].payoutPrivateKey, approvedProposalDigest: '00'.repeat(32) }), /exact spend/);
  }
  checks.push('all six final payouts sweep only with their owner payout key, never the personal key');

  const cooperative = build('cooperative', null);
  const first = cooperate(cooperative);
  const second = cooperate(cooperative);
  assert.equal(first.signed.txid, second.signed.txid);
  assert.notEqual(first.signed.transactionHex, second.signed.transactionHex);
  assert.deepEqual(validatePresignedCooperativeNonces({ graph, proposal: cooperative, publicNonces: [...first.publicNonces].reverse() }),
    validatePresignedCooperativeNonces({ graph, proposal: cooperative, publicNonces: first.publicNonces }));
  assert.throws(() => finalizePresignedCooperative({ graph, proposal: cooperative,
    publicNonces: first.publicNonces, partials: second.partials }), /another nonce set/);
  assert.throws(() => finalizePresignedCooperative({ graph, proposal: cooperative,
    publicNonces: first.publicNonces, partials: first.partials.slice(1) }), /every current/);
  assert.throws(() => finalizePresignedCooperative({ graph, proposal: cooperative,
    publicNonces: first.publicNonces, partials: [first.partials[0]!, first.partials[0]!, first.partials[2]!] }), /duplicate/);
  assert.throws(() => verifyPresignedCooperativePartial({ graph, proposal: cooperative, publicNonces: first.publicNonces,
    partial: { ...first.partials[0]!, partialSignatureHex: '00'.repeat(32) } }), /invalid cooperative partial/);
  checks.push('alternate valid cooperative witnesses are accepted while missing, mixed and invalid partials are rejected');

  const generated = generate(cooperative);
  assert.throws(() => JSON.stringify(generated[0]), /must not be serialized/);
  assert(!JSON.stringify(generated.map(item => item.publicNonce)).includes('secretNonce'));
  const publicNonces = generated.map(item => item.publicNonce);
  assert.throws(() => validatePresignedCooperativeNonces({ graph, proposal: cooperative, publicNonces: publicNonces.slice(1) }), /every current/);
  assert.throws(() => validatePresignedCooperativeNonces({ graph, proposal: cooperative,
    publicNonces: [publicNonces[0]!, publicNonces[0]!, publicNonces[2]!] }), /duplicate/);
  assert.throws(() => validatePresignedCooperativeNonces({ graph, proposal: cooperative,
    publicNonces: [{ ...publicNonces[0]!, pubnonce: '00'.repeat(66) }, ...publicNonces.slice(1)] }), /invalid pubnonce/);
  assert.throws(() => validatePresignedCooperativeNonces({ graph, proposal: cooperative,
    publicNonces: [{ ...publicNonces[0]!, secretNonce: 'forbidden' } as typeof publicNonces[number], ...publicNonces.slice(1)] }), /unexpected/);
  const copy = Uint8Array.from(generated[0]!.secretNonce);
  partialsFor(cooperative, generated);
  const signerId = publicNonces[0]!.participantId;
  assert.throws(() => signPresignedCooperativePartial({ graph, proposal: cooperative, participantId: signerId,
    personalPrivateKey: keysById[signerId].personalPrivateKey, approvedProposalDigest: cooperative.digest,
    publicNonces, nonceBinding: generated[0]!.binding, consumedSecretNonce: copy }), /already consumed/);
  assert(copy.every(byte => byte === 0));
  checks.push('private nonce results refuse serialization; public artifacts reject secrets and copied nonce reuse is blocked');

  for (const corruption of ['approval', 'message', 'key', 'nonce-set'] as const) {
    const fresh = generate(cooperative);
    const own = fresh[0]!;
    const savedCopy = Uint8Array.from(own.secretNonce);
    const id = own.publicNonce.participantId;
    const wrongId = PARTICIPANT_IDS.find(other => other !== id)!;
    const list = fresh.map(item => item.publicNonce);
    assert.throws(() => signPresignedCooperativePartial({ graph, proposal: cooperative, participantId: id,
      personalPrivateKey: keysById[corruption === 'key' ? wrongId : id].personalPrivateKey,
      approvedProposalDigest: corruption === 'approval' ? '00'.repeat(32) : cooperative.digest,
      publicNonces: corruption === 'nonce-set' ? list.slice(1) : list,
      nonceBinding: corruption === 'message' ? { ...own.binding, message: '00'.repeat(32) } : own.binding,
      consumedSecretNonce: own.secretNonce }));
    assert(own.secretNonce.every(byte => byte === 0));
    assert.throws(() => signPresignedCooperativePartial({ graph, proposal: cooperative, participantId: id,
      personalPrivateKey: keysById[id].personalPrivateKey, approvedProposalDigest: cooperative.digest,
      publicNonces: list, nonceBinding: own.binding, consumedSecretNonce: savedCopy }), /already consumed/);
    assert(savedCopy.every(byte => byte === 0));
    fresh.forEach(item => item.secretNonce.fill(0));
  }
  checks.push('nonce bytes burn before signing even on wrong approval, message, key or nonce-set failures');

  const recovery = build('recovery', null);
  const contributions = recovery.participantIds.slice(0, recovery.threshold).map(id => createPresignedRecoveryContribution({ graph,
    proposal: recovery, participantId: id, personalPrivateKey: keysById[id].personalPrivateKey,
    approvedProposalDigest: recovery.digest }));
  const recovered = finalizePresignedRecovery({ graph, proposal: recovery, contributions });
  assert.throws(() => createPresignedRecoveryContribution({ graph, proposal: recovery, participantId: 'alice',
    personalPrivateKey: keysById.alice.personalPrivateKey, approvedProposalDigest: '00'.repeat(32) }), /exact spend/);
  assert.throws(() => verifyPresignedRecoveryContribution({ graph, proposal: recovery,
    contribution: { ...contributions[0]!, signatureHex: '00'.repeat(64) } }), /invalid recovery/);
  for (const mutate of [
    (tx: bitcoin.Transaction) => { tx.ins[0]!.sequence = 0xffffffff; },
    (tx: bitcoin.Transaction) => { tx.version = 1; },
    (tx: bitcoin.Transaction) => { tx.outs[0]!.value -= 1n; },
    (tx: bitcoin.Transaction) => { const witness = tx.ins[0]!.witness.map(item => Buffer.from(item)); witness[witness.length - 2]![0] ^= 1; tx.setWitness(0, witness); },
    (tx: bitcoin.Transaction) => { const witness = tx.ins[0]!.witness.map(item => Buffer.from(item)); witness[witness.length - 1]![0] ^= 1; tx.setWitness(0, witness); },
  ]) {
    const mutated = bitcoin.Transaction.fromHex(recovered.transactionHex);
    mutate(mutated);
    assert.throws(() => authorizePresignedSpendTransaction({ graph, proposal: recovery, transactionHex: mutated.toHex() }));
  }
  const annexed = bitcoin.Transaction.fromHex(first.signed.transactionHex);
  annexed.setWitness(0, [...annexed.ins[0]!.witness, Buffer.from([0x50, 1])]);
  assert.throws(() => authorizePresignedSpendTransaction({ graph, proposal: cooperative, transactionHex: annexed.toHex() }), /without annex/);
  checks.push('recovery CSV version/sequence, exact leaf/control block, fees and key-path witness shape are enforced');

  assert.throws(() => build('cooperative', 'unknown-source'), /committed graph exit/);
  assert.throws(() => build('final-sweep', null), /spend kind/);
  assert.throws(() => build('cooperative', 'alice/bob'), /spend kind/);
  assert.throws(() => buildPresignedSpend({ graph, proposalId: randomUUID(), kind: 'cooperative', sourceExitId: null,
    outputs: [] } as Parameters<typeof buildPresignedSpend>[0]), /unexpected/);
  for (const mutation of [
    { ...cooperative, feeSats: cooperative.feeSats + 1 },
    { ...cooperative, proposalId: randomUUID() },
    { ...cooperative, source: { ...cooperative.source, txid: '77'.repeat(32) } },
    { ...cooperative, signatureHash: '00'.repeat(32) },
  ]) assert.throws(() => validatePresignedSpend(graph, mutation));
  const otherNetwork = createPresignedFixture({ network: network === 'signet' ? 'mainnet' : 'signet' });
  assert.throws(() => validatePresignedSpend(otherNetwork.graph, cooperative), /commitment/);
  checks.push('unknown coins, arbitrary outputs and tampered fee/proposal/source/message/network bindings are rejected');
  results.push({ network, checks });
}
console.log(JSON.stringify({ passed: true, actualProviderContact: false, actualBlockchainContact: false,
  recoveryBlockAgeTested: false, persistentBrowserNonceConsumptionTested: false, results }, null, 2));
