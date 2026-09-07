import assert from 'node:assert/strict';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { deterministicKeypair } from '../crypto.js';
import { BITCOIN_GENESIS_HASH, BITCOIN_NETWORK_NAME } from '../network.js';
import { asSats } from '../types.js';
import { buildPresignedGraph } from './graph.js';
import { authorizePresignedFundingTransaction } from './funding.js';
import { createPresignedFixture, signPresignedFixtureFunding } from './fixtures.js';
import { MAX_PRESIGNED_OBSERVED_TRANSACTION_HEX_LENGTH, recognizeConfirmedPresignedFundingTransaction } from './observed.js';
import { derivePresignedParticipantKeys, payoutScript } from './roster.js';
import { completePresignedExit, createPreauthorizations } from './signing.js';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, type PresignedRoster } from './types.js';
import {
  collectPresignedChainView, findPresignedEpochConflicts, initialPresignedGraphChainState,
  reconcilePresignedGraphChain,
  type PresignedChainBackend, type PresignedChainReconciliation, type PresignedChainView,
  type PresignedGraphChainState,
} from './chain.js';

// Explicitly public deterministic fixture material; never chain money or live keys.
// Backend observations below are SYNTHETIC, NOT consensus/inclusion proofs.
// They test the trusted-Core contract and state machine, not trust in user JSON.
const vaultId = '9b91a7e0-d50b-4f18-a7d8-fb9342d8bb2a';
const identities = PARTICIPANT_IDS.map((id, index) =>
  derivePresignedParticipantKeys(Buffer.alloc(32, index + 21).toString('base64url'), id, vaultId));
const walletKeys = PARTICIPANT_IDS.map(id => deterministicKeypair('presigned-chain-public-test-only', id));
const roster: PresignedRoster = {
  version: 2, protocol: PRESIGNED_PROTOCOL,
  vaultId,
  network: BITCOIN_NETWORK_NAME, genesisHash: BITCOIN_GENESIS_HASH,
  economics: { depositSatsPerParticipant: asSats(10_000), firstWithdrawalSats: asSats(9_500),
    secondWithdrawalSats: asSats(10_250), soloFeeBudgetSats: asSats(2_000),
    soloWithdrawalFeeSats: asSats(300), cooperativeFeeSats: asSats(300),
    recoveryFeeSats: asSats(500), finalSweepFeeSats: asSats(300), recoveryDelayBlocks: 144 },
  feePolicy: { kind: 'confirmed-truc-payout-cpfp-v1', maxChildFeeSats: 10_000 },
  participants: identities.map(identity => identity.publicIdentity),
};
const hash = (number: number) => number.toString(16).padStart(64, '0');
const graph = buildPresignedGraph({ roster, funding: {
  epochId: 'c464ff34-4b35-47b8-a377-3c48701a103a', feeSats: 600,
  inputs: PARTICIPANT_IDS.map((participantId, index) => ({ participantId,
    txid: hash(index + 41), vout: 0, valueSats: 10_530,
    scriptPubKeyHex: `5120${walletKeys[index]!.xonlyPubKeyHex}`,
    changeScriptPubKeyHex: `5120${walletKeys[index]!.xonlyPubKeyHex}`,
    confirmationBlockHash: hash(90), confirmations: 30,
  })),
} });
const preauthorizations = identities.flatMap(identity => createPreauthorizations({ graph,
  participantId: identity.keys.participantId, privateKeys: identity.keys.soloPrivateKeys,
  approvedGraphDigest: graph.digest }));
const signedExits = new Map(graph.exits.map(exit => {
  const owner = identities.find(identity => identity.keys.participantId === exit.leaver)!;
  return [exit.id, completePresignedExit({ graph, preauthorizations, exitId: exit.id,
    participantId: exit.leaver, privateKey: owner.keys.soloPrivateKeys[exit.roundId]!,
    approvedGraphDigest: graph.digest }).transactionHex];
}));
function signedFunding(auxiliaryByte = 0, candidateGraph = graph): string {
  const tx = bitcoin.Transaction.fromHex(candidateGraph.fundingUnsignedTxHex);
  candidateGraph.funding.inputs.forEach((_, index) => {
    const message = tx.hashForWitnessV1(index,
      candidateGraph.funding.inputs.map(input => Buffer.from(input.scriptPubKeyHex, 'hex')),
      candidateGraph.funding.inputs.map(input => BigInt(input.valueSats)), bitcoin.Transaction.SIGHASH_DEFAULT);
    tx.setWitness(index, [ecc.signSchnorr(message, Buffer.from(walletKeys[index]!.privateKeyHex, 'hex'),
      Buffer.alloc(32, auxiliaryByte))]);
  });
  assert.equal(tx.getId(), candidateGraph.fundingTxid);
  return tx.toHex();
}
const originalFunding = signedFunding();
type Snapshot = Extract<PresignedChainView, { kind: 'snapshot' }>;
type PathItem = { exitId: string | null; height: number; blockHash?: string };
const firstPath: PathItem[] = [null, 'alice', 'alice/bob'].map(exitId => ({ exitId, height: 100 }));
const empty = initialPresignedGraphChainState(graph);
const checks: string[] = [];

function snapshot(path: PathItem[], previous = empty): Snapshot {
  const selected = new Map(path.map(item => [item.exitId === null ? graph.fundingTxid : graph.exits.find(exit => exit.id === item.exitId)!.txid, item]));
  const blocks = new Map<string, Snapshot['blocks'][number]>();
  for (const previousAnchor of previous.confirmed) {
    blocks.set(previousAnchor.blockHash, { kind: 'inactive', hash: previousAnchor.blockHash, height: previousAnchor.height });
  }
  for (const item of path) {
    const blockHash = item.blockHash ?? hash(item.height);
    blocks.set(blockHash, { kind: 'active', hash: blockHash, height: item.height, confirmations: 121 - item.height });
  }
  return { kind: 'snapshot', graphDigest: graph.digest,
    tip: { network: roster.network, genesisHash: roster.genesisHash, hash: hash(120), height: 120 },
    transactions: [graph.fundingTxid, ...graph.exits.map(exit => exit.txid)].map(txid => {
      const item = selected.get(txid);
      return item ? { kind: 'present', txid,
        transactionHex: item.exitId === null ? originalFunding : signedExits.get(item.exitId)!,
        blockHash: item.blockHash ?? hash(item.height) } : { kind: 'absent', txid };
    }), blocks: [...blocks.values()],
  };
}
function reconcile(view: PresignedChainView, currentState = empty): PresignedChainReconciliation {
  return reconcilePresignedGraphChain({ graph, currentState, trustedCoreView: view, requiredConfirmations: 2 });
}
function expectReconciled(result: PresignedChainReconciliation): asserts result is Extract<PresignedChainReconciliation, { kind: 'reconciled' }> {
  assert.equal(result.kind, 'reconciled', result.kind === 'deferred' ? result.reason : 'expected successful reconciliation');
}
function expectDeferred(view: PresignedChainView, currentState: PresignedGraphChainState): void {
  const before = JSON.stringify(currentState);
  const result = reconcile(view, currentState);
  assert.equal(result.kind, 'deferred');
  assert.strictEqual(result.state, currentState, 'uncertainty must retain the identical state object');
  assert.equal(JSON.stringify(currentState), before);
}

const full = reconcile(snapshot(firstPath));
expectReconciled(full);
assert.deepEqual(full.added.map(item => item.exitId), [null, 'alice', 'alice/bob']);
assert.equal(full.projectedOutput?.kind, 'final-payout');
assert.equal(full.projectedOutput?.owner, 'carol');
assert.equal(full.projectedOutput?.valueSats, 9_350);
assert.equal(full.invalidated.length, 0);
checks.push('offline funding and both exits in one block discovered before first poll');

for (const first of PARTICIPANT_IDS) {
  for (const second of PARTICIPANT_IDS.filter(id => id !== first)) {
    const path = [null, first, `${first}/${second}`].map(exitId => ({ exitId, height: 100 }));
    const result = reconcile(snapshot(path));
    expectReconciled(result);
    assert.equal(result.projectedOutput?.owner, PARTICIPANT_IDS.find(id => id !== first && id !== second));
  }
}
checks.push('all six exit paths project the correct final participant');

const alternate = snapshot(firstPath, full.state);
const fundingObservation = alternate.transactions.find(item => item.txid === graph.fundingTxid)!;
assert(fundingObservation.kind === 'present');
fundingObservation.transactionHex = signedFunding(27);
assert.notEqual(fundingObservation.transactionHex, originalFunding);
const exit = graph.exits.find(item => item.id === 'alice')!;
const round = graph.rounds.find(item => item.id === exit.roundId)!;
const owner = identities.find(identity => identity.keys.participantId === exit.leaver)!;
const alternateExit = bitcoin.Transaction.fromHex(signedExits.get(exit.id)!);
const witness = [...alternateExit.ins[0]!.witness];
witness[round.solo.threshold - 1 - round.solo.participantIds.indexOf(exit.leaver)] = ecc.signSchnorr(
  Buffer.from(exit.signatureHash, 'hex'), owner.keys.soloPrivateKeys[exit.roundId]!, Buffer.alloc(32, 73));
alternateExit.setWitness(0, witness);
assert.notEqual(alternateExit.toHex(), signedExits.get(exit.id));
assert.equal(alternateExit.getId(), exit.txid);
const exitObservation = alternate.transactions.find(item => item.txid === exit.txid)!;
assert(exitObservation.kind === 'present');
exitObservation.transactionHex = alternateExit.toHex();
const alternateResult = reconcile(alternate, full.state);
expectReconciled(alternateResult);
assert.deepEqual(alternateResult.state, full.state);
assert.equal(alternateResult.added.length + alternateResult.invalidated.length + alternateResult.reanchored.length, 0);
checks.push('different valid funding and exit witnesses preserve the same economic state');

const replacement = reconcile(snapshot([null, 'carol', 'carol/alice'].map(exitId => ({ exitId, height: 103 })), full.state), full.state);
expectReconciled(replacement);
assert.deepEqual(replacement.invalidated.map(item => item.exitId), ['alice/bob', 'alice']);
assert.deepEqual(replacement.added.map(item => item.exitId), ['carol', 'carol/alice']);
assert.deepEqual(replacement.reanchored.map(item => item.current.exitId), [null]);
assert.equal(replacement.projectedOutput?.owner, 'bob');
checks.push('authoritative reorg switches branches, invalidating children before parents');

const reanchored = reconcile(snapshot(firstPath.map(item => ({ ...item, height: 104 })), full.state), full.state);
expectReconciled(reanchored);
assert.equal(reanchored.reanchored.length, 3);
assert.equal(reanchored.added.length + reanchored.invalidated.length, 0);
const rolledBack = reconcile(snapshot([], full.state), full.state);
expectReconciled(rolledBack);
assert.deepEqual(rolledBack.invalidated.map(item => item.exitId), ['alice/bob', 'alice', null]);
assert.equal(rolledBack.state.confirmed.length, 0);
assert.equal(rolledBack.projectedOutput, null);
checks.push('reanchor preserves exact graph transactions and total rollback reverses dependencies');

const unknown = snapshot([], full.state);
unknown.transactions[0] = { kind: 'unknown', txid: graph.fundingTxid };
expectDeferred(unknown, full.state);
const unknownBlock = snapshot([], full.state);
unknownBlock.blocks[0] = { kind: 'unknown', hash: full.state.confirmed[0]!.blockHash };
expectDeferred(unknownBlock, full.state);
const absentInActiveBlock = snapshot([], full.state);
absentInActiveBlock.blocks[0] = { kind: 'active', hash: hash(100), height: 100, confirmations: 21 };
expectDeferred(absentInActiveBlock, full.state);
const movedFromActiveBlock = snapshot(firstPath.map(item => ({ ...item, height: 103 })), full.state);
movedFromActiveBlock.blocks[0] = { kind: 'active', hash: hash(100), height: 100, confirmations: 21 };
expectDeferred(movedFromActiveBlock, full.state);
const missingObservation = snapshot(firstPath, full.state);
missingObservation.transactions.pop();
expectDeferred(missingObservation, full.state);
const wrongDepth = snapshot(firstPath, full.state);
const block = wrongDepth.blocks[0]!;
assert(block.kind === 'active');
block.confirmations += 1;
expectDeferred(wrongDepth, full.state);
checks.push('unknown, omitted, contradictory active-anchor and inconsistent-depth evidence never changes state');

expectDeferred(snapshot([...firstPath, { exitId: 'bob', height: 100 }]), empty);
expectDeferred(snapshot([{ exitId: 'alice', height: 100 }]), empty);
expectDeferred(snapshot([{ exitId: null, height: 105 }, { exitId: 'alice', height: 100 }]), empty);
checks.push('competing active branches, missing ancestors and impossible block ordering are rejected');

for (const target of [null, 'alice']) {
  const invalid = snapshot(firstPath, full.state);
  const txid = target === null ? graph.fundingTxid : graph.exits.find(item => item.id === target)!.txid;
  const observation = invalid.transactions.find(item => item.txid === txid)!;
  assert(observation.kind === 'present');
  const transaction = bitcoin.Transaction.fromHex(observation.transactionHex);
  transaction.outs[0]!.value += 1n;
  transaction.outs[1]!.value -= 1n;
  assert.notEqual(transaction.getId(), txid);
  observation.transactionHex = transaction.toHex();
  expectDeferred(invalid, full.state);
}
for (const malformed of ['not-hex', '00', `${originalFunding}00`]) {
  const invalid = snapshot(firstPath, full.state);
  const observation = invalid.transactions.find(item => item.txid === graph.fundingTxid)!;
  assert(observation.kind === 'present');
  observation.transactionHex = malformed;
  expectDeferred(invalid, full.state);
}
checks.push('active observations with malformed bytes, wrong transaction IDs or changed immutable economics defer');

function fundingVariantSnapshot(candidateGraph: typeof graph, transactionHex: string): Snapshot {
  return { kind: 'snapshot', graphDigest: candidateGraph.digest,
    tip: { network: candidateGraph.roster.network, genesisHash: candidateGraph.roster.genesisHash, hash: hash(120), height: 120 },
    transactions: [candidateGraph.fundingTxid, ...candidateGraph.exits.map(item => item.txid)].map((txid, index) =>
      index === 0 ? { kind: 'present', txid, transactionHex, blockHash: hash(100) } : { kind: 'absent', txid }),
    blocks: [{ kind: 'active', hash: hash(100), height: 100, confirmations: 21 }] };
}
function checkFundingVariant(candidateGraph: typeof graph, transactionHex: string, strictError: RegExp): void {
  assert.throws(() => authorizePresignedFundingTransaction({ graph: candidateGraph, transactionHex }), strictError);
  const initial = initialPresignedGraphChainState(candidateGraph);
  const view = fundingVariantSnapshot(candidateGraph, transactionHex);
  const recognized = reconcilePresignedGraphChain({ graph: candidateGraph, currentState: initial, trustedCoreView: view, requiredConfirmations: 2 });
  expectReconciled(recognized);
  assert.deepEqual(recognized.state.confirmed.map(item => item.txid), [candidateGraph.fundingTxid]);
  const activeBlock = view.blocks[0]!;
  assert(activeBlock.kind === 'active');
  const direct = recognizeConfirmedPresignedFundingTransaction({ graph: candidateGraph,
    transaction: { txid: candidateGraph.fundingTxid, transactionHex, blockHash: hash(100) }, activeBlock, tip: view.tip });
  assert.equal(direct.kind, 'confirmed-graph-observation');
  assert.equal(direct.feeSats, candidateGraph.funding.feeSats);
  assert(!('transactionHex' in direct), 'observations must not be broadcast artifacts');
  for (const blockHash of [null, hash(100)]) {
    const unconfirmed = fundingVariantSnapshot(candidateGraph, transactionHex);
    const tx = unconfirmed.transactions[0]!;
    assert(tx.kind === 'present');
    tx.blockHash = blockHash;
    // Prove neither mempool nor inactive-block bytes reach the recognizer.
    Object.defineProperty(tx, 'transactionHex', { get() { throw new Error('must establish an active block first'); } });
    unconfirmed.blocks = blockHash === null ? [] : [{ kind: 'inactive', hash: hash(100), height: 100 }];
    const result = reconcilePresignedGraphChain({ graph: candidateGraph, currentState: initial,
      trustedCoreView: unconfirmed, requiredConfirmations: 2 });
    expectReconciled(result);
    assert.equal(result.state.confirmed.length, 0);
  }
  for (const blocks of [[], [{ kind: 'unknown' as const, hash: hash(100) }]]) {
    const missing = { ...view, blocks };
    const result = reconcilePresignedGraphChain({ graph: candidateGraph, currentState: initial,
      trustedCoreView: missing, requiredConfirmations: 2 });
    assert.equal(result.kind, 'deferred');
    assert.strictEqual(result.state, initial);
  }
  assert.throws(() => recognizeConfirmedPresignedFundingTransaction({ graph: candidateGraph,
    transaction: { txid: candidateGraph.fundingTxid, transactionHex, blockHash: null as unknown as string }, activeBlock, tip: view.tip }));
}

const highFixture = createPresignedFixture({ network: roster.network, walletKinds: ['p2wpkh', 'p2wpkh', 'p2wpkh'] });
const highTransaction = bitcoin.Transaction.fromHex(signPresignedFixtureFunding(highFixture).transactionHex);
const highWitness = highTransaction.ins[0]!.witness.map(item => Buffer.from(item));
const decoded = bitcoin.script.signature.decode(highWitness[0]!);
const compact = Buffer.from(decoded.signature);
const curveOrder = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const highS = curveOrder - BigInt(`0x${compact.subarray(32).toString('hex')}`);
Buffer.from(highS.toString(16).padStart(64, '0'), 'hex').copy(compact, 32);
highWitness[0] = Buffer.from(bitcoin.script.signature.encode(compact, decoded.hashType));
highTransaction.setWitness(0, highWitness);
checkFundingVariant(highFixture.graph, highTransaction.toHex(), /high-S/u);

const lowFeeGraph = buildPresignedGraph({ roster, funding: { ...graph.funding, feeSats: 1 } });
checkFundingVariant(lowFeeGraph, signedFunding(0, lowFeeGraph), /fee below/u);

const annexedFunding = bitcoin.Transaction.fromHex(originalFunding);
const annex = Buffer.alloc(60_000, 0x21); annex[0] = 0x50;
const annexMessage = annexedFunding.hashForWitnessV1(0,
  graph.funding.inputs.map(coin => Buffer.from(coin.scriptPubKeyHex, 'hex')),
  graph.funding.inputs.map(coin => BigInt(coin.valueSats)), bitcoin.Transaction.SIGHASH_DEFAULT, undefined, annex);
annexedFunding.setWitness(0, [ecc.signSchnorr(annexMessage, Buffer.from(walletKeys[0]!.privateKeyHex, 'hex')), annex]);
assert(annexedFunding.toHex().length > 100_000, 'exercise a mined witness above the send-policy size cap');
checkFundingVariant(graph, annexedFunding.toHex(), /malformed|annex/u);
assert.equal(MAX_PRESIGNED_OBSERVED_TRANSACTION_HEX_LENGTH, 8_000_000);
const tooLarge = fundingVariantSnapshot(graph, '00'.repeat(4_000_001));
expectDeferred(tooLarge, empty);
checks.push('synthetic active inclusion recognizes high-S, low-fee and large-annex funding without weakening strict sends; mempool/inactive/no-anchor never activate');

const allExit = bitcoin.Transaction.fromHex(signedExits.get(exit.id)!);
const allMessage = allExit.hashForWitnessV1(0, [Buffer.from(exit.inputScriptPubKeyHex, 'hex')],
  [BigInt(exit.inputValueSats)], bitcoin.Transaction.SIGHASH_ALL, Buffer.from(round.solo.leafHash, 'hex'));
allExit.ins[0]!.witness[round.solo.threshold - 1 - round.solo.participantIds.indexOf(exit.leaver)] = Buffer.concat([
  ecc.signSchnorr(allMessage, owner.keys.soloPrivateKeys[exit.roundId]!), Buffer.from([bitcoin.Transaction.SIGHASH_ALL]),
]);
const allView = snapshot(firstPath);
const allObservation = allView.transactions.find(item => item.txid === exit.txid)!;
assert(allObservation.kind === 'present');
allObservation.transactionHex = allExit.toHex();
const allResult = reconcile(allView);
expectReconciled(allResult);
assert.deepEqual(allResult.state, full.state);
const allMissingAnchor = structuredClone(allView);
const allUnconfirmed = allMissingAnchor.transactions.find(item => item.txid === exit.txid)!;
assert(allUnconfirmed.kind === 'present');
allUnconfirmed.blockHash = null;
expectDeferred(allMissingAnchor, empty); // Its claimed active child would lack a confirmed parent.
checks.push('synthetic active inclusion recognizes a designated-leaver ALL signature without changing graph descendants');

const shallow = snapshot(firstPath, full.state);
shallow.tip.hash = hash(100);
shallow.tip.height = 100;
for (const item of shallow.blocks) if (item.kind === 'active') item.confirmations = 1;
const demoted = reconcile(shallow, full.state);
expectReconciled(demoted);
assert.equal(demoted.state.confirmed.length, 0);
assert.equal(demoted.invalidated.length, 3);
checks.push('active blocks below required depth do not remain promoted');

const mempool = snapshot(firstPath, full.state);
for (const observation of mempool.transactions) if (observation.kind === 'present') observation.blockHash = null;
mempool.blocks = [{ kind: 'inactive', hash: hash(100), height: 100 }];
const unconfirmed = reconcile(mempool, full.state);
expectReconciled(unconfirmed);
assert.equal(unconfirmed.state.confirmed.length, 0);
assert.equal(unconfirmed.invalidated.length, 3);
checks.push('valid mempool transactions are not promoted and an orphaned confirmed path is demoted');

const view = snapshot(firstPath);
const txLookups: string[] = [];
const blockLookups: string[] = [];
const backend: PresignedChainBackend = {
  async getTip() { return { ...view.tip }; },
  async getTransaction(txid) {
    txLookups.push(txid);
    return view.transactions.find(item => item.txid === txid)!;
  },
  async getBlock(blockHash) {
    blockLookups.push(blockHash);
    return view.blocks.find(item => item.hash === blockHash)!;
  },
};
const collected = await collectPresignedChainView({ graph, currentState: empty, backend });
const collectedResult = reconcile(collected);
expectReconciled(collectedResult);
assert.deepEqual(collectedResult.state, full.state);
assert.equal(txLookups.length, 10);
assert.equal(new Set(txLookups).size, 10);
assert.deepEqual(blockLookups, [hash(100)]);
const reorgView = snapshot(firstPath.map(item => ({ ...item, height: 103 })), full.state);
const anchorLookups: string[] = [];
const collectedReorg = await collectPresignedChainView({ graph, currentState: full.state, backend: {
  async getTip() { return reorgView.tip; },
  async getTransaction(txid) { return reorgView.transactions.find(item => item.txid === txid)!; },
  async getBlock(blockHash) {
    anchorLookups.push(blockHash);
    return reorgView.blocks.find(item => item.hash === blockHash)!;
  },
} });
assert.deepEqual(anchorLookups.sort(), [hash(100), hash(103)]);
const discoveredReanchor = reconcile(collectedReorg, full.state);
expectReconciled(discoveredReanchor);
assert.equal(discoveredReanchor.reanchored.length, 3);
let tipReads = 0;
const moving = await collectPresignedChainView({ graph, currentState: full.state, backend: {
  ...backend, async getTip() { tipReads += 1; return tipReads === 1 ? view.tip : { ...view.tip, hash: hash(121), height: 121 }; },
} });
assert.deepEqual(moving, { kind: 'unknown', reason: 'tip-changed' });
expectDeferred(moving, full.state);
const unavailable = await collectPresignedChainView({ graph, currentState: full.state, backend: {
  ...backend, async getTransaction() { throw new Error('synthetic unavailable lookup'); },
} });
assert.deepEqual(unavailable, { kind: 'unknown', reason: 'backend-error' });
expectDeferred(unavailable, full.state);
checks.push('collector reads all ten known txids and independent anchors, deferring changed tips and backend errors');

const secondGraph = buildPresignedGraph({ roster, funding: { ...graph.funding,
  epochId: '7b5c3284-bb27-41c1-9872-983dab2a32dc', feeSats: 597 } });
const secondState: PresignedGraphChainState = { ...initialPresignedGraphChainState(secondGraph), confirmed: [
  { txid: secondGraph.fundingTxid, exitId: null, blockHash: hash(101), height: 101 },
] };
assert.deepEqual(findPresignedEpochConflicts([{ graph, state: full.state }, { graph: secondGraph, state: secondState }])
  .map(item => item.kind), ['multiple-funded-epochs', 'shared-funding-input']);
assert.deepEqual(findPresignedEpochConflicts([{ graph, state: full.state }, { graph: secondGraph, state: initialPresignedGraphChainState(secondGraph) }]), []);
checks.push('multiple funded epochs and impossible shared confirmed inputs are flagged without retiring history');

const repeatedGraph = buildPresignedGraph({ roster, funding: { ...graph.funding, epochId: '23644534-fbf0-4d07-8e72-c1d70baf5379' } });
assert.notEqual(repeatedGraph.digest, graph.digest);
assert.equal(repeatedGraph.fundingTxid, graph.fundingTxid);
assert.deepEqual(findPresignedEpochConflicts([{ graph, state: full.state },
  { graph: repeatedGraph, state: { ...full.state, graphDigest: repeatedGraph.digest } }]), []);
checks.push('identical economic transactions in retained restart epochs are not counted as multiple funded coins');

console.log(JSON.stringify({ passed: true, network: roster.network, pureGraphReconciliation: true,
  actualProviderContact: false, actualBlockchainContact: false, syntheticObservationsAreConsensusProofs: false,
  witnessConsensusDelegatedToPrivateCore: true, checks }, null, 2));
