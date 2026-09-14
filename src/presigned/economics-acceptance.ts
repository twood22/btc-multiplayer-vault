import assert from 'node:assert/strict';
import * as bitcoin from 'bitcoinjs-lib';
import { asSats } from '../types.js';
import { presignedBackupBinding, verifyPresignedKitRestoration } from './backup.js';
import { newPresignedCeremony, validatePresignedCeremonySettings } from './ceremony.js';
import { createLastSurvivorEconomics, LAST_SURVIVOR_PAYOUT_SCHEDULE, validatePresignedEconomics } from './economics.js';
import { createPresignedFixture, preauthorizePresignedFixture, signPresignedFixtureFunding } from './fixtures.js';
import { validatePresignedGraph } from './graph.js';
import { payoutScript } from './roster.js';
import { authorizePresignedExitTransaction, completePresignedExit, verifyPreauthorizations } from './signing.js';
import { buildPresignedSpend, signPresignedFinalSweep } from './spends.js';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL } from './types.js';

const legacy = createPresignedFixture();
// Golden commitment obtained from the previously frozen/accepted source.
assert.equal(legacy.graph.digest, '1771dfcd33d5722f5ea5d732d89f6d7c91053d4409bb5bf5e66e8acab6b03137');
assert(!Object.hasOwn(validatePresignedEconomics(legacy.roster.economics), 'payoutSchedule'));
const economics = createLastSurvivorEconomics(legacy.roster.economics);
assert.deepEqual([economics.firstWithdrawalSats, economics.secondWithdrawalSats,
  30_000 - economics.firstWithdrawalSats - economics.secondWithdrawalSats - 900 - 300], [9120, 9600, 10080]);
assert.throws(() => validatePresignedEconomics({ ...legacy.roster.economics,
  payoutSchedule: LAST_SURVIVOR_PAYOUT_SCHEDULE }), /amounts changed/u);
const unversioned = { ...economics }; delete unversioned.payoutSchedule;
assert.throws(() => validatePresignedEconomics(unversioned), /conserve/u);
assert.throws(() => validatePresignedEconomics({ ...economics, payoutSchedule: 'future' } as never), /unknown payout schedule/u);
assert.throws(() => validatePresignedEconomics({ ...economics, payoutSchedule: undefined } as never), /unknown payout schedule/u);
assert.throws(() => validatePresignedEconomics({ ...economics, surprise: 1 } as never), /unexpected/u);
assert.throws(() => validatePresignedEconomics({ ...economics,
  firstWithdrawalSats: asSats(economics.firstWithdrawalSats + 1) }), /amounts changed/u);
assert.throws(() => validatePresignedEconomics({ ...economics,
  secondWithdrawalSats: asSats(economics.secondWithdrawalSats + 1) }), /amounts changed/u);
assert.throws(() => createLastSurvivorEconomics({ ...economics, finalSweepFeeSats: asSats(30_000) }), /consume/u);
assert.throws(() => createLastSurvivorEconomics({ ...economics, finalSweepFeeSats: asSats(29_000) }), /non-dust/u);
assert.throws(() => createLastSurvivorEconomics({ ...economics, soloWithdrawalFeeSats: asSats(1001) }), /budget/u);
assert.throws(() => createLastSurvivorEconomics({ ...economics, recoveryDelayBlocks: 0 }), /delay/u);
assert.throws(() => createLastSurvivorEconomics({ ...economics, depositSatsPerParticipant: asSats(700_000_000_000_001) }), /deposit/u);
let amountCases = 0;
for (const deposit of [10_000, 100_000, 100_000_000, 699_999_999_999_900]) {
  for (let offset = 0; offset < 60; offset++) for (const sweepFee of [1, 300, 1000]) {
    const e = createLastSurvivorEconomics({ ...economics, depositSatsPerParticipant: asSats(deposit + offset),
      finalSweepFeeSats: asSats(sweepFee) });
    const net = BigInt(e.depositSatsPerParticipant) * 3n - BigInt(e.soloWithdrawalFeeSats) * 3n - BigInt(sweepFee);
    const last = net - BigInt(e.firstWithdrawalSats) - BigInt(e.secondWithdrawalSats);
    assert.equal(BigInt(e.firstWithdrawalSats), net * 19n / 60n);
    assert.equal(BigInt(e.secondWithdrawalSats), net * 20n / 60n);
    assert(last > BigInt(e.secondWithdrawalSats) && e.secondWithdrawalSats > e.firstWithdrawalSats);
    assert(last * 60n >= net * 21n);
    amountCases++;
  }
}

let signedExits = 0;
let signedSweeps = 0;
let restoredKits = 0;
for (const network of ['signet', 'mainnet'] as const) for (let mask = 0; mask < 8; mask++) {
  const fixture = createPresignedFixture({ network, payoutSchedule: LAST_SURVIVOR_PAYOUT_SCHEDULE,
    walletKinds: PARTICIPANT_IDS.map((_, index) => mask & (1 << index) ? 'p2tr' : 'p2wpkh') });
  const { graph, keysById } = fixture;
  assert.deepEqual(validatePresignedGraph(graph), graph);
  const entries = preauthorizePresignedFixture(fixture); // all descendants before funding signatures
  assert.equal(signPresignedFixtureFunding(fixture).txid, graph.fundingTxid);
  for (const exit of graph.exits) {
    const signed = completePresignedExit({ graph, preauthorizations: entries, exitId: exit.id,
      participantId: exit.leaver, privateKey: keysById[exit.leaver].soloPrivateKeys[exit.roundId]!, approvedGraphDigest: graph.digest });
    const tx = bitcoin.Transaction.fromHex(signed.transactionHex);
    assert.equal(tx.outs[0]!.value, exit.parentExitId ? 9600n : 9120n);
    assert.deepEqual(Buffer.from(tx.outs[0]!.script), payoutScript(graph.roster, exit.leaver));
    const changed = tx.clone(); changed.outs[0]!.value++; changed.outs[1]!.value--;
    assert.throws(() => authorizePresignedExitTransaction({ graph, exitId: exit.id, transactionHex: changed.toHex() }), /immutable/u);
    signedExits++;
    if (exit.finalParticipant) {
      const proposal = buildPresignedSpend({ graph, proposalId: '44444444-4444-4444-8444-444444444444',
        kind: 'final-sweep', sourceExitId: exit.id });
      const sweep = signPresignedFinalSweep({ graph, proposal, participantId: exit.finalParticipant,
        payoutPrivateKey: keysById[exit.finalParticipant].payoutPrivateKey, approvedProposalDigest: proposal.digest });
      const sweepTx = bitcoin.Transaction.fromHex(sweep.transactionHex);
      assert.equal(sweepTx.outs[0]!.value, 10080n);
      assert.deepEqual(Buffer.from(sweepTx.outs[0]!.script), payoutScript(graph.roster, exit.finalParticipant));
      signedSweeps++;
    }
  }
  if (mask === 0) {
    const settings = { network, genesisHash: graph.roster.genesisHash, economics: graph.roster.economics,
      feePolicy: graph.roster.feePolicy, fundingFeeSats: graph.funding.feeSats };
    assert.deepEqual(validatePresignedCeremonySettings(settings), settings);
    assert.notEqual(newPresignedCeremony(graph.roster.vaultId, settings).settingsDigest,
      newPresignedCeremony(graph.roster.vaultId, { ...settings, economics: legacy.roster.economics }).settingsDigest);
    const changed = structuredClone(graph); delete changed.roster.economics.payoutSchedule;
    assert.throws(() => validatePresignedGraph(changed));
    assert.throws(() => verifyPreauthorizations(graph, preauthorizePresignedFixture(legacy)), /another graph/u);
    const publicKit = { version: 2 as const, protocol: PRESIGNED_PROTOCOL, graph, preauthorizations: entries };
    for (const id of PARTICIPANT_IDS) {
      verifyPresignedKitRestoration({ publicKit, participantId: id, participantSecret: fixture.participantSecrets[id],
        expectedBinding: presignedBackupBinding(publicKit, id) });
      restoredKits++;
    }
  }
}
console.log(JSON.stringify({ passed: true, payoutSchedule: LAST_SURVIVOR_PAYOUT_SCHEDULE,
  baseFeeNetPayouts: [9120, 9600, 10080], amountCases, signedExits, signedSweeps, restoredKits,
  legacyGoldenGraphUnchanged: true, publicNetworkBroadcasts: 0, fundingAuthorized: false }));
