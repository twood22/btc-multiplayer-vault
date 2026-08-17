import assert from 'node:assert/strict';
import {
  base58CheckEncode,
  deriveXpubChildPubkey,
  deterministicKeypair,
  sha256Hex,
  xpubRootXonly,
} from '../../src/crypto.js';
import { auditSpecState } from '../../src/audit.js';
import {
  buildSoloWithdrawalPsbt,
  inspectPsbt,
  psbtInspectionToPolicyTx,
} from '../../src/psbt.js';
import {
  createPublishedRosterArtifact,
  publishedRosterDigest,
  rosterReview,
} from '../../src/roster-ceremony.js';
import { planSigbashProvisioning } from '../../src/sigbash-provisioning.js';
import { buildSigbashReadinessFixture } from '../../src/sigbash-readiness.js';
import { evaluatePolicy } from '../../src/sigbash.js';
import { asSats, type VaultEconomics } from '../../src/types.js';
import {
  assertFreshMatureRecoveryObservation,
  assertProposalStatusTransition,
  buildVaultProposal,
  deriveNextVaultCoin,
  validateVaultCoin,
  vaultCoinSnapshotDigest,
  vaultProposalDigest,
  type VaultCoinSnapshot,
} from '../../src/vault-runtime.js';
import { unlockPublishedVault } from '../lib/client/vault-signing.js';
import {
  createRosterState,
  participantLeaveRounds,
  rosterEntry,
  type RosterEntry,
  type SigbashRosterRegistration,
} from '../../src/vault.js';

const ids = ['alice', 'bob', 'carol'];
const vaultId = '11111111-2222-4333-8444-555555555555';
const roster = liveRoster();
const artifact = createPublishedRosterArtifact(vaultId, roster);
const digest = publishedRosterDigest(artifact);
const checks: Array<{ name: string; ok: boolean }> = [];

check('a publishable roster contains nine real mainnet Sigbash registrations', () => {
  const registrations = artifact.participants.flatMap((participant) =>
    Object.values(participant.sigbashRegistrationByRound || {}));
  assert.equal(registrations.length, 9);
  assert(registrations.every((registration) => registration.network === 'mainnet'));
  assert.equal(artifact.policies.length, 9);
  assert(artifact.policies.every((policy) => policy.keyId.startsWith('live-key:')));
});

check('roster-derived signing state retains each live xpub and Sigbash keyId', () => {
  const state = createRosterState(roster);
  for (const participant of state.participants) {
    for (const [round, key] of Object.entries(participant.sigbashByRound)) {
      assert.equal(key.isLiveKey, true);
      assert.match(key.xpub || '', /xpub/);
      assert.equal(state.policies.get(`${round}:${participant.id}`)?.keyId, `live-key:${participant.id}:${round}`);
    }
  }
});

check('the roster deterministically derives a mainnet round-one funding vault', () => {
  assert.match(artifact.funding.address, /^bc1p/);
  assert.equal(artifact.funding.valueSats, artifact.economics.depositSatsPerParticipant * 3);
  assert.equal(artifact.vaults.length, 4);
});

check('participant ordering cannot change the canonical roster digest', () => {
  const reversed = createPublishedRosterArtifact(vaultId, [...roster].reverse());
  assert.equal(publishedRosterDigest(reversed), digest);
});

check('offline leaf fixtures cannot become a publishable roster', () => {
  const offline = ids.map((id) => rosterEntry(id, `offline-${id}-secret-material-that-is-long-enough`, ids));
  assert.throws(() => createPublishedRosterArtifact(vaultId, offline), /missing live Sigbash registrations/);
});

check('a registration whose leaf does not derive from its own xpub is rejected', () => {
  const tampered = structuredClone(roster);
  const registration = tampered[0]!.sigbashRegistrationByRound!.alicebobcarol!;
  registration.policyLeafXonlyPubkey = tampered[1]!.sigbashLeafByRound.alicebobcarol!;
  tampered[0]!.sigbashLeafByRound.alicebobcarol = registration.policyLeafXonlyPubkey;
  assert.throws(() => createPublishedRosterArtifact(vaultId, tampered), /policy leaf does not match/);
});

check('a testnet extended-public-key version is rejected even when its points are valid', () => {
  const tampered = structuredClone(roster);
  const round = 'alicebobcarol';
  const testnetXpub = syntheticXpub('alice:testnet-version', '043587cf');
  const registration = tampered[0]!.sigbashRegistrationByRound![round]!;
  registration.bip328Xpub = testnetXpub;
  registration.policyLeafXonlyPubkey = deriveXpubChildPubkey(testnetXpub, [0, 0]).xonlyPubKeyHex;
  registration.identificationLeafXonlyPubkey = xpubRootXonly(testnetXpub);
  tampered[0]!.sigbashLeafByRound[round] = registration.policyLeafXonlyPubkey;
  tampered[0]!.sigbashIdentificationLeafByRound[round] = registration.identificationLeafXonlyPubkey;
  assert.throws(() => createPublishedRosterArtifact(vaultId, tampered), /mainnet xpub/);
});

check('changing a service policy root changes the exact roster digest', () => {
  const changed = structuredClone(roster);
  changed[0]!.sigbashRegistrationByRound!.alicebobcarol!.policyRoot = 'ab'.repeat(32);
  const changedArtifact = createPublishedRosterArtifact(vaultId, changed);
  assert.notEqual(publishedRosterDigest(changedArtifact), digest);
});

check('the round-one funding address is absent before unanimous confirmation', () => {
  const review = rosterReview(artifact, ['alice', 'bob']);
  assert.equal(review.unanimous, false);
  assert.equal(review.fundingAddress, null);
  assert(review.vaults.some((vault) =>
    vault.round === artifact.funding.round && vault.address === null && vault.outputScriptHex === null));
  assert(!JSON.stringify(review).includes(artifact.funding.address));
  assert(!JSON.stringify(review).includes(artifact.funding.outputScriptHex));
});

check('three distinct participant confirmations reveal the committed address', () => {
  const review = rosterReview(artifact, ['carol', 'alice', 'bob', 'alice']);
  assert.equal(review.unanimous, true);
  assert.equal(review.fundingAddress, artifact.funding.address);
  assert.equal(review.confirmations.join(','), 'alice,bob,carol');
});

check('provisioning creates pair-round keys before the round-one key', () => {
  const empty = withoutRegistrations(roster, () => false);
  const plan = planSigbashProvisioning(empty, 'alice');
  assert.equal(plan.next?.round, 'alicebob');
  assert.equal(plan.next?.keyIndex, 1);
});

check('round-one provisioning remains unavailable until all six pair keys exist', () => {
  const fivePairs = withoutRegistrations(roster, (participantId, round) =>
    round !== 'alicebobcarol' && !(participantId === 'carol' && round === 'bobcarol'));
  const plan = planSigbashProvisioning(fivePairs, 'alice');
  assert.equal(plan.next, null);
  assert.equal(plan.totalPairRegistrations, 5);
  assert.deepEqual(plan.waitingFor, ['1 pair-round Sigbash key(s) are still missing']);
});

check('round-one policy pins the vault built from the actual surviving pair keys', () => {
  const pairComplete = withoutRegistrations(roster, (_participantId, round) => round !== 'alicebobcarol');
  const plan = planSigbashProvisioning(pairComplete, 'alice');
  const state = createRosterState(pairComplete);
  const survivingPairAddress = state.vaults.get('bobcarol')?.address;
  assert.equal(plan.next?.round, 'alicebobcarol');
  assert.equal(plan.next?.keyIndex, 0);
  assert(survivingPairAddress);
  assert(JSON.stringify(plan.next.policy).includes(survivingPairAddress));
});

check('tiny-mainnet economics are committed into every vault and transaction', () => {
  const economics = tinyEconomics();
  const tinyArtifact = createPublishedRosterArtifact(vaultId, roster, economics);
  const state = createRosterState(roster, undefined, economics);
  assert.equal(tinyArtifact.funding.valueSats, 30_000);
  assert.equal(tinyArtifact.economics.soloWithdrawalFeeSats, 300);
  assert.equal(tinyArtifact.economics.recoveryDelayBlocks, 12);
  assert(auditSpecState(state).passed);
  const built = buildSoloWithdrawalPsbt({
    state,
    currentIds: ids,
    leaverId: 'alice',
    txid: '11'.repeat(32),
    vout: 0,
    valueSats: 30_000,
  });
  const inspection = inspectPsbt(built.psbtBase64);
  assert.equal(inspection.outputs[0]?.valueSats, 9_500);
  assert.equal(inspection.outputs[1]?.valueSats, 20_200);
});

check('changing any committed economic rule changes the roster digest', () => {
  const tiny = tinyEconomics();
  const first = createPublishedRosterArtifact(vaultId, roster, tiny);
  const changed = createPublishedRosterArtifact(vaultId, roster, {
    ...tiny,
    recoveryDelayBlocks: tiny.recoveryDelayBlocks + 1,
  });
  assert.notEqual(publishedRosterDigest(first), publishedRosterDigest(changed));
  assert.notEqual(first.funding.address, changed.funding.address);
});

check('browser signing state accepts only the exact artifact digest and participant secret', () => {
  const aliceSecret = 'participant-alice-secret-material-that-is-long-enough';
  const signingRoster = rosterWithKnownAliceSecret(aliceSecret);
  const signingArtifact = createPublishedRosterArtifact(vaultId, signingRoster, tinyEconomics());
  const digest = publishedRosterDigest(signingArtifact);
  const unlocked = unlockPublishedVault({
    artifact: signingArtifact,
    expectedDigest: digest,
    participantSecret: aliceSecret,
  });
  assert.equal(unlocked.signer.participantId, 'alice');
  assert.equal(unlocked.signer.state.economics.depositSatsPerParticipant, 10_000);
  assert.throws(() => unlockPublishedVault({
    artifact: signingArtifact,
    expectedDigest: '00'.repeat(32),
    participantSecret: aliceSecret,
  }), /confirmed digest/);
  assert.throws(() => unlockPublishedVault({
    artifact: signingArtifact,
    expectedDigest: digest,
    participantSecret: 'wrong-participant-secret-material-that-is-long-enough',
  }), /does not reproduce/);
});

check('runtime coin snapshots are bound to the exact roster, script, round, and value', () => {
  const coin = roundOneCoin();
  const validated = validateVaultCoin(artifact, coin);
  assert.deepEqual(validated.currentParticipantIds, ['alice', 'bob', 'carol']);
  assert.match(vaultCoinSnapshotDigest(coin), /^[0-9a-f]{64}$/);
  assert.throws(
    () => validateVaultCoin(artifact, { ...coin, rosterDigest: '00'.repeat(32) }),
    /different vault roster/,
  );
  assert.throws(
    () => validateVaultCoin(artifact, { ...coin, scriptPubKeyHex: `5120${'00'.repeat(32)}` }),
    /committed vault round/,
  );
  assert.throws(
    () => validateVaultCoin(artifact, { ...coin, valueSats: coin.valueSats - 1 }),
    /committed funding value/,
  );
});

check('every proposal digest commits the current coin, exact PSBT, actor, and expiry', () => {
  const coin = roundOneCoin();
  const expiresAt = '2030-01-01T00:00:00.000Z';
  const solo = buildVaultProposal({
    artifact,
    coin,
    kind: 'solo',
    actorParticipantId: 'alice',
    expiresAt,
  });
  assert.deepEqual(solo.requiredSignerIds, ['alice']);
  assert.equal(solo.commitment.unsignedTxid, solo.unsignedTxid);
  assert.notEqual(
    solo.digest,
    vaultProposalDigest({ ...solo.commitment, expiresAt: '2030-01-02T00:00:00.000Z' }),
  );
  assert.notEqual(
    solo.digest,
    vaultProposalDigest({ ...solo.commitment, actorParticipantId: 'bob' }),
  );

  const cooperative = buildVaultProposal({ artifact, coin, kind: 'cooperative', expiresAt });
  assert.deepEqual(cooperative.requiredSignerIds, ['alice', 'bob', 'carol']);
  const recovery = buildVaultProposal({
    artifact,
    coin,
    kind: 'recovery',
    actorParticipantId: 'carol',
    expiresAt,
  });
  assert.deepEqual(recovery.requiredSignerIds, ['alice', 'bob']);
});

check('confirmed solo outputs advance through the pair round to the final owner coin', () => {
  const expiresAt = '2030-01-01T00:00:00.000Z';
  const first = buildVaultProposal({
    artifact,
    coin: roundOneCoin(),
    kind: 'solo',
    actorParticipantId: 'alice',
    expiresAt,
  });
  const pairCoin = deriveNextVaultCoin({
    artifact,
    coin: roundOneCoin(),
    proposal: first,
    confirmedTxid: first.unsignedTxid,
  })!;
  assert.equal(pairCoin.kind, 'vault');
  assert.equal(pairCoin.roundId, 'bobcarol');
  validateVaultCoin(artifact, pairCoin);
  const second = buildVaultProposal({
    artifact,
    coin: pairCoin,
    kind: 'solo',
    actorParticipantId: 'bob',
    expiresAt,
  });
  const payoutCoin = deriveNextVaultCoin({
    artifact,
    coin: pairCoin,
    proposal: second,
    confirmedTxid: second.unsignedTxid,
  })!;
  assert.equal(payoutCoin.kind, 'final_payout');
  assert.equal(payoutCoin.ownerParticipantId, 'carol');
  validateVaultCoin(artifact, payoutCoin);
  const sweep = buildVaultProposal({
    artifact,
    coin: payoutCoin,
    kind: 'final_sweep',
    actorParticipantId: 'carol',
    expiresAt,
  });
  assert.deepEqual(sweep.requiredSignerIds, ['carol']);
  assert.throws(() => buildVaultProposal({
    artifact,
    coin: payoutCoin,
    kind: 'final_sweep',
    actorParticipantId: 'bob',
    expiresAt,
  }), /must own/);
});

check('confirmed transition derivation rejects replay and ends terminal exits', () => {
  const coin = roundOneCoin();
  const expiresAt = '2030-01-01T00:00:00.000Z';
  const solo = buildVaultProposal({ artifact, coin, kind: 'solo', actorParticipantId: 'alice', expiresAt });
  assert.throws(() => deriveNextVaultCoin({
    artifact,
    coin: { ...coin, txid: '33'.repeat(32) },
    proposal: solo,
    confirmedTxid: solo.unsignedTxid,
  }), /supplied current coin|reproduce/);
  assert.throws(() => deriveNextVaultCoin({
    artifact,
    coin,
    proposal: { ...solo, digest: '00'.repeat(32) },
    confirmedTxid: solo.unsignedTxid,
  }), /digest/);
  const cooperative = buildVaultProposal({ artifact, coin, kind: 'cooperative', expiresAt });
  assert.equal(deriveNextVaultCoin({
    artifact,
    coin,
    proposal: cooperative,
    confirmedTxid: cooperative.unsignedTxid,
  }), null);
  const recovery = buildVaultProposal({
    artifact,
    coin,
    kind: 'recovery',
    actorParticipantId: 'carol',
    expiresAt,
  });
  assert.equal(deriveNextVaultCoin({
    artifact,
    coin,
    proposal: recovery,
    confirmedTxid: recovery.unsignedTxid,
  }), null);
});

check('proposal lifecycle rejects replay from terminal and backwards states', () => {
  assert.doesNotThrow(() => assertProposalStatusTransition('collecting', 'finalized'));
  assert.doesNotThrow(() => assertProposalStatusTransition('finalized', 'broadcast'));
  assert.doesNotThrow(() => assertProposalStatusTransition('broadcast', 'confirmed'));
  assert.throws(() => assertProposalStatusTransition('confirmed', 'broadcast'), /invalid proposal/);
  assert.throws(() => assertProposalStatusTransition('rejected', 'collecting'), /invalid proposal/);
  assert.throws(() => assertProposalStatusTransition('broadcast', 'finalized'), /invalid proposal/);
});

check('recovery readiness requires both CSV maturity and a fresh chain observation', () => {
  const nowMs = 2_000_000;
  assert.doesNotThrow(() => assertFreshMatureRecoveryObservation({
    confirmations: 13,
    recoveryDelayBlocks: 12,
    observedAtMs: nowMs - 1_000,
    nowMs,
  }));
  assert.throws(() => assertFreshMatureRecoveryObservation({
    confirmations: 12,
    recoveryDelayBlocks: 12,
    observedAtMs: nowMs - 1_000,
    nowMs,
  }), /not mature/);
  assert.throws(() => assertFreshMatureRecoveryObservation({
    confirmations: 13,
    recoveryDelayBlocks: 12,
    observedAtMs: nowMs - 2 * 60 * 1000,
    nowMs,
  }), /stale/);
  assert.throws(() => assertFreshMatureRecoveryObservation({
    confirmations: 13,
    recoveryDelayBlocks: 12,
    observedAtMs: nowMs + 1,
    nowMs,
  }), /timing/);
});

check('nine readiness fixtures bind every live key and reject each hostile transaction locally', () => {
  const state = createRosterState(artifact.participants, undefined, artifact.economics);
  let count = 0;
  for (const participant of artifact.participants) {
    for (const round of participantLeaveRounds(participant.id, ids)) {
      const fixture = buildSigbashReadinessFixture({
        artifact,
        rosterDigest: digest,
        participantId: participant.id,
        round,
        inputTxid: sha256Hex(`readiness:${participant.id}:${round}`),
      });
      const policy = state.policies.get(`${round}:${participant.id}`)!;
      const validFailures = evaluatePolicy(
        psbtInspectionToPolicyTx({ state, inspection: inspectPsbt(fixture.validPsbtBase64) }),
        policy,
      );
      assert.deepEqual(validFailures, []);
      for (const hostile of Object.values(fixture.tamperedPsbts)) {
        assert(evaluatePolicy(
          psbtInspectionToPolicyTx({ state, inspection: inspectPsbt(hostile) }),
          policy,
        ).length > 0);
      }
      assert.equal(fixture.key.keyId, participant.sigbashRegistrationByRound?.[round]?.keyId);
      count += 1;
    }
  }
  assert.equal(count, 9);
  assert.throws(() => buildSigbashReadinessFixture({
    artifact,
    rosterDigest: '00'.repeat(32),
    participantId: 'alice',
    round: 'alicebobcarol',
    inputTxid: '11'.repeat(32),
  }), /confirmed roster digest/);
  assert.throws(() => buildSigbashReadinessFixture({
    artifact,
    rosterDigest: digest,
    participantId: 'alice',
    round: 'bobcarol',
    inputTxid: '11'.repeat(32),
  }), /missing the challenged/);
});

console.log(JSON.stringify({ passed: checks.every((item) => item.ok), checks }, null, 2));

function check(name: string, run: () => void): void {
  run();
  checks.push({ name, ok: true });
}

function liveRoster(): RosterEntry[] {
  return ids.map((id) => {
    const base = rosterEntry(id, `participant-${id}-secret-material-that-is-long-enough`, ids);
    const registrations = Object.fromEntries(participantLeaveRounds(id, ids).map((round) => {
      const xpub = syntheticMainnetXpub(`${id}:${round}`);
      const policyLeaf = deriveXpubChildPubkey(xpub, [0, 0]).xonlyPubKeyHex;
      const identificationLeaf = xpubRootXonly(xpub);
      return [round, {
        network: 'mainnet',
        keyId: `live-key:${id}:${round}`,
        keyIndex: participantLeaveRounds(id, ids).indexOf(round),
        bip328Xpub: xpub,
        policyLeafXonlyPubkey: policyLeaf,
        identificationLeafXonlyPubkey: identificationLeaf,
        policyRoot: sha256Hex(`policy-root:${id}:${round}`),
        policyId: `${round}:${id}`,
      } satisfies SigbashRosterRegistration];
    }));
    return {
      ...base,
      sigbashLeafByRound: Object.fromEntries(
        Object.entries(registrations).map(([round, registration]) => [round, registration.policyLeafXonlyPubkey]),
      ),
      sigbashIdentificationLeafByRound: Object.fromEntries(
        Object.entries(registrations).map(([round, registration]) => [round, registration.identificationLeafXonlyPubkey]),
      ),
      sigbashRegistrationByRound: registrations,
    };
  });
}

function rosterWithKnownAliceSecret(aliceSecret: string): RosterEntry[] {
  const known = rosterEntry('alice', aliceSecret, ids);
  const base = liveRoster();
  return base.map((entry) => entry.id === 'alice' ? {
    ...entry,
    personalPublicKeyHex: known.personalPublicKeyHex,
    payoutXonlyPubkeyHex: known.payoutXonlyPubkeyHex,
    payoutAddress: known.payoutAddress,
  } : entry);
}

function withoutRegistrations(
  source: RosterEntry[],
  keep: (participantId: string, round: string) => boolean,
): RosterEntry[] {
  return structuredClone(source).map((entry) => ({
    ...entry,
    sigbashRegistrationByRound: Object.fromEntries(
      Object.entries(entry.sigbashRegistrationByRound || {})
        .filter(([round]) => keep(entry.id, round)),
    ),
  }));
}

function tinyEconomics(): VaultEconomics {
  return {
    depositSatsPerParticipant: asSats(10_000),
    firstWithdrawalSats: asSats(9_500),
    secondWithdrawalSats: asSats(10_250),
    soloFeeBudgetSats: asSats(2_000),
    soloWithdrawalFeeSats: asSats(300),
    cooperativeFeeSats: asSats(300),
    recoveryFeeSats: asSats(500),
    finalSweepFeeSats: asSats(300),
    recoveryDelayBlocks: 12,
  };
}

function roundOneCoin(): VaultCoinSnapshot {
  return {
    vaultId,
    rosterDigest: digest,
    kind: 'vault',
    roundId: artifact.funding.round,
    ownerParticipantId: null,
    txid: '44'.repeat(32),
    vout: 0,
    valueSats: artifact.funding.valueSats,
    scriptPubKeyHex: artifact.funding.outputScriptHex,
  };
}

function syntheticMainnetXpub(label: string): string {
  return syntheticXpub(label, '0488b21e');
}

function syntheticXpub(label: string, versionHex: string): string {
  const root = deterministicKeypair('roster-acceptance', `${label}:root`);
  return base58CheckEncode(Buffer.concat([
    Buffer.from(versionHex, 'hex'),
    Buffer.from([0]),
    Buffer.alloc(4),
    Buffer.alloc(4),
    Buffer.from(sha256Hex(`${label}:chain-code`), 'hex'),
    Buffer.from(root.publicKeyHex, 'hex'),
  ]));
}
