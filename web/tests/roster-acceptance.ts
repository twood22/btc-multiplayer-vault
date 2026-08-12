import assert from 'node:assert/strict';
import {
  base58CheckEncode,
  deriveXpubChildPubkey,
  deterministicKeypair,
  sha256Hex,
  xpubRootXonly,
} from '../../src/crypto.js';
import {
  createPublishedRosterArtifact,
  publishedRosterDigest,
  rosterReview,
} from '../../src/roster-ceremony.js';
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
