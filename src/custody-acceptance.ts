import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AMOUNTS, PARTICIPANTS, RECOVERY_DELAY_BLOCKS } from './config.js';
import { BITCOIN_NETWORK } from './network.js';
import { verifyVaultTransaction } from './consensus.js';
import { deterministicKeypair, tapLeafHash } from './crypto.js';
import { loadAndBurnSecnonce, saveSecnonce } from './nonce-store.js';
import {
  authorizeCooperativeContext,
  ceremonyAggregate,
  ceremonyNonce,
  ceremonyPartial,
  ceremonyStart,
  type CeremonyContext,
} from './ceremony.js';
import {
  aggregateRecoveryShares,
  authorizeFinalSweep,
  createRecoveryShare,
  loadLocalSigner,
  loadPublicRoster,
  localSignerFromSecret,
  validateRoster,
  type LocalSigner,
  type RecoveryShare,
} from './custody.js';
import {
  buildFinalSweepPsbt,
  buildRecoveryPsbt,
  signFinalSweepPsbt,
  soloLeavesOf,
  unsignedTx,
} from './psbt.js';
import {
  asTrustedVaultInput,
  type Hex,
  type TrustedVaultInput,
  type VaultRound,
  type VaultState,
} from './types.js';
import {
  deriveParticipantKeys,
  participantById,
  rosterEntry,
  roundId,
  type RosterEntry,
} from './vault.js';

bitcoin.initEccLib(ecc);

// Offline adversarial acceptance for the distributed-custody boundary. Three
// participants, three secrets, three separate signing states — as if each ran
// on their own device. Every hostile artifact below is built here rather than
// described, and the test passes only if each one is *rejected* for the right
// reason, with the honest paths still producing consensus-valid transactions.
//
// The secrets are deliberately public test strings containing a sentinel, so
// the final check can prove no secret and no derived private key ever reaches
// anything this suite would print.

const SENTINEL = 'custody-sentinel-1f4b8ac2e07d';
const TEST_SECRETS: Record<string, string> = {
  alice: `alice-${SENTINEL}-offline-test-secret-not-for-funds`,
  bob: `bob-${SENTINEL}-offline-test-secret-not-for-funds`,
  carol: `carol-${SENTINEL}-offline-test-secret-not-for-funds`,
};

const FUNDING_TXID = '0000000000000000000000000000000000000000000000000000000000000001';
const OTHER_TXID = '00000000000000000000000000000000000000000000000000000000000000ff';

export interface CustodyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface CustodyAcceptanceReport {
  passed: boolean;
  total: number;
  failed: number;
  checks: CustodyCheck[];
}

export function runCustodyAcceptance(): CustodyAcceptanceReport {
  const checks: CustodyCheck[] = [];
  // Everything the suite produced or reported, scanned at the end for secret
  // material. Includes rejection messages, which are the likeliest leak.
  const transcript: string[] = [];

  const record = (check: CustodyCheck): void => {
    checks.push(check);
    transcript.push(`${check.name}::${check.detail ?? ''}`);
  };
  const expect = (name: string, run: () => unknown): void => {
    try {
      const value = run();
      record({ name, ok: true, ...(value === undefined ? {} : { detail: describe(value) }) });
    } catch (error) {
      record({ name, ok: false, detail: `unexpected failure: ${messageOf(error)}` });
    }
  };
  const expectReject = (name: string, because: string, run: () => unknown): void => {
    try {
      run();
      record({ name, ok: false, detail: 'accepted a hostile artifact that must be rejected' });
    } catch (error) {
      const message = messageOf(error);
      record({
        name,
        ok: message.includes(because),
        detail: message.includes(because) ? `rejected: ${message}` : `rejected for the wrong reason: ${message}`,
      });
    }
  };

  const allIds = PARTICIPANTS.map((participant) => participant.id);
  const roster: RosterEntry[] = allIds.map((id) => rosterEntry(id, secretFor(id), allIds));
  const rosterJson = JSON.stringify(roster);
  const publicOnly = loadPublicRoster(rosterJson);
  const signers: Record<string, LocalSigner> = Object.fromEntries(
    allIds.map((id) => [id, localSignerFromSecret(roster, secretFor(id))]),
  );

  // ── 1. One-secret isolation ──────────────────────────────────────────────

  for (const id of allIds) {
    expect(`${id}'s device holds only ${id}'s private keys`, () => {
      const signer = signers[id]!;
      assert(signer.participantId === id, `secret resolved to ${signer.participantId}, expected ${id}`);
      const local = participantById(signer.state, id);
      assert(local.personal.privateKeyHex !== '', 'local personal key missing');
      assert(local.payout.privateKeyHex !== '', 'local payout key missing');
      for (const [round, key] of Object.entries(local.sigbashByRound)) {
        assert(key.privateKeyHex === '', `${id} ${round} Sigbash key must remain service-controlled`);
      }
      for (const other of signer.state.participants) {
        if (other.id === id) continue;
        assert(other.personal.privateKeyHex === '', `${other.id} personal key present on ${id}'s device`);
        assert(other.payout.privateKeyHex === '', `${other.id} payout key present on ${id}'s device`);
        for (const [round, key] of Object.entries(other.sigbashByRound)) {
          assert(key.privateKeyHex === '', `${other.id} ${round} Sigbash key present on ${id}'s device`);
        }
      }
      return signer.custodyChecks.length;
    });
  }

  expect('all three devices and the public-only roster derive identical vault addresses', () => {
    const addresses = [...allIds.map((id) => signers[id]!.state), publicOnly.state].map((state) =>
      [...state.vaults.values()].map((vault) => `${vault.id}:${vault.address}`).sort().join('|'),
    );
    assert(new Set(addresses).size === 1, 'devices disagree on vault addresses');
    return addresses[0]!.split('|').length;
  });

  expect('a personal secret loads against independent live-style Sigbash leaf keys', () => {
    const liveRoster = structuredClone(roster);
    for (const entry of liveRoster) {
      for (const round of Object.keys(entry.sigbashLeafByRound)) {
        entry.sigbashLeafByRound[round] = deterministicKeypair(
          `live-policy-${entry.id}-${round}`,
          'sigbash-managed-leaf',
        ).xonlyPubKeyHex;
        entry.sigbashIdentificationLeafByRound[round] = deterministicKeypair(
          `live-identification-${entry.id}-${round}`,
          'sigbash-managed-identification',
        ).xonlyPubKeyHex;
      }
    }
    const validated = validateRoster(liveRoster);
    const signer = localSignerFromSecret(validated, secretFor('alice'));
    assert(signer.participantId === 'alice', 'personal secret resolved to the wrong participant');
    const local = participantById(signer.state, 'alice');
    assert(local.personal.privateKeyHex !== '', 'local personal key missing');
    assert(local.payout.privateKeyHex !== '', 'local payout key missing');
    for (const participant of signer.state.participants) {
      for (const key of Object.values(participant.sigbashByRound)) {
        assert(key.privateKeyHex === '', 'a live-style Sigbash private key entered participant custody');
      }
    }
    return Object.values(local.sigbashByRound).length;
  });

  expect('public-only roster state carries no private key material at all', () => {
    for (const participant of publicOnly.state.participants) {
      assert(participant.personal.privateKeyHex === '', 'public roster leaked a personal key');
      assert(participant.payout.privateKeyHex === '', 'public roster leaked a payout key');
    }
    return publicOnly.state.participants.length;
  });

  expect('the signer secret is read from VAULT_PARTICIPANT_SECRET, not from arguments', () => {
    const previous = process.env.VAULT_PARTICIPANT_SECRET;
    try {
      process.env.VAULT_PARTICIPANT_SECRET = secretFor('bob');
      const fromEnv = loadLocalSigner(rosterJson);
      assert(fromEnv.participantId === 'bob', 'env secret resolved to the wrong participant');
      delete process.env.VAULT_PARTICIPANT_SECRET;
      let refused = false;
      try {
        loadLocalSigner(rosterJson);
      } catch {
        refused = true;
      }
      assert(refused, 'signer loaded with no secret in the environment');
      return 'bob';
    } finally {
      if (previous === undefined) delete process.env.VAULT_PARTICIPANT_SECRET;
      else process.env.VAULT_PARTICIPANT_SECRET = previous;
    }
  });

  expectReject('a secret that matches no roster entry cannot load a signer', 'does not reproduce', () =>
    localSignerFromSecret(roster, `intruder-${SENTINEL}-not-a-participant-secret`),
  );
  expectReject('a too-short secret is refused', 'at least', () => localSignerFromSecret(roster, 'short'));

  const tamperedRosters: Array<[string, string, (entries: RosterEntry[]) => void]> = [
    ['a roster that reuses one payout key for two participants', 'reuses public material', (entries) => {
      entries[1]!.payoutXonlyPubkeyHex = entries[0]!.payoutXonlyPubkeyHex;
      entries[1]!.payoutAddress = entries[0]!.payoutAddress;
    }],
    ['a roster whose payout address does not match its payout key', 'payoutAddress is not the P2TR address', (entries) => {
      entries[0]!.payoutAddress = entries[1]!.payoutAddress;
    }],
    ['a roster missing a round of leaf keys', 'must cover exactly the rounds', (entries) => {
      const rounds = Object.keys(entries[0]!.sigbashLeafByRound);
      delete entries[0]!.sigbashLeafByRound[rounds[0]!];
    }],
    ['a roster with an extra unexpected round', 'must cover exactly the rounds', (entries) => {
      entries[0]!.sigbashLeafByRound['alicedave'] = entries[0]!.payoutXonlyPubkeyHex;
    }],
    ['a roster naming an unknown participant', 'unknown participant id', (entries) => {
      entries[2]!.id = 'mallory';
    }],
    ['a roster with a mislabelled participant', 'expected', (entries) => {
      entries[0]!.label = 'Not Alice';
    }],
    ['a roster reusing the policy leaf key as the identification leaf key', 'repeats the policy-spend leaf key', (entries) => {
      const round = roundId(allIds);
      entries[0]!.sigbashIdentificationLeafByRound[round] = entries[0]!.sigbashLeafByRound[round]!;
    }],
    ['a roster with an off-curve personal key', 'valid 33-byte compressed', (entries) => {
      // x = 2^256-1 is beyond the field prime, so this is definitively not a point.
      entries[0]!.personalPublicKeyHex = `02${'ff'.repeat(32)}`;
    }],
  ];
  for (const [name, because, tamper] of tamperedRosters) {
    expectReject(name, because, () => {
      const entries = structuredClone(roster);
      tamper(entries);
      return validateRoster(entries);
    });
  }
  expectReject('a roster of the wrong size', 'exactly 3 entries', () => validateRoster(roster.slice(0, 2)));
  expectReject('a roster that is not an array', 'must be a JSON array', () => validateRoster({ alice: roster[0] }));

  // ── 2. Independent MuSig2 cooperative exit ───────────────────────────────

  const roundOneIds = [...allIds].sort();
  const roundOneVault = vaultOf(publicOnly.state, roundOneIds);
  const potSats = AMOUNTS.deposit * allIds.length;
  const trustedInput = asTrustedVaultInput({
    txid: FUNDING_TXID,
    vout: 0,
    valueSats: potSats,
    scriptPubKeyHex: roundOneVault.outputScriptHex,
  });
  const context = ceremonyStart({ state: publicOnly.state, currentIds: roundOneIds, trustedInput });
  transcript.push(JSON.stringify(context));

  const nonceStoreDir = mkdtempSync(join(tmpdir(), 'vault-secnonce-'));
  const storedNonce = ceremonyNonce({
    state: signers['alice']!.state,
    participantId: 'alice',
    context,
    trustedInput,
  });
  const nonceExpectation = {
    participantId: storedNonce.participantId,
    round: context.round,
    message: context.message,
    pubnonce: storedNonce.pubnonce,
  };
  const nonceRecord = { version: 1 as const, ...nonceExpectation, secnonce: storedNonce.secnonce };
  try {
    expect('a secret nonce is stored owner-only and destroyed when consumed', () => {
      const path = join(nonceStoreDir, 'consume-once.json');
      saveSecnonce(path, nonceRecord);
      assert((statSync(path).mode & 0o077) === 0, 'secret nonce file is accessible to group or other users');
      const consumed = loadAndBurnSecnonce(path, nonceExpectation);
      assert(consumed.secnonce === storedNonce.secnonce, 'consumed nonce does not match generated nonce');
      assert(!existsSync(path), 'consumed nonce file was not destroyed');
      return 'mode 0600, bound to ceremony, burned before signing';
    });

    expect('an existing secret nonce file cannot be overwritten', () => {
      const path = join(nonceStoreDir, 'no-overwrite.json');
      saveSecnonce(path, nonceRecord);
      let refused = false;
      try {
        saveSecnonce(path, nonceRecord);
      } catch {
        refused = true;
      }
      assert(refused, 'existing nonce file was overwritten');
      loadAndBurnSecnonce(path, nonceExpectation);
      return 'exclusive create enforced';
    });

    expect('a nonce bound to a different message is rejected without exposing or consuming it', () => {
      const path = join(nonceStoreDir, 'wrong-message.json');
      saveSecnonce(path, nonceRecord);
      let refused = false;
      try {
        loadAndBurnSecnonce(path, { ...nonceExpectation, message: flipHex(context.message) });
      } catch {
        refused = true;
      }
      assert(refused, 'nonce was accepted for a different message');
      assert(existsSync(path), 'rejected nonce was unexpectedly destroyed');
      loadAndBurnSecnonce(path, nonceExpectation);
      return 'message binding enforced';
    });

    expect('an over-permissive secret nonce file is rejected', () => {
      const path = join(nonceStoreDir, 'bad-mode.json');
      saveSecnonce(path, nonceRecord);
      chmodSync(path, 0o644);
      let refused = false;
      try {
        loadAndBurnSecnonce(path, nonceExpectation);
      } catch {
        refused = true;
      }
      assert(refused, 'world-readable nonce file was accepted');
      chmodSync(path, 0o600);
      loadAndBurnSecnonce(path, nonceExpectation);
      return 'group and other permission bits rejected';
    });
  } finally {
    rmSync(nonceStoreDir, { recursive: true, force: true });
  }

  let cooperativeTxid = '';
  expect('a cooperative exit signed by three independent devices verifies at consensus level', () => {
    const nonces = roundOneIds.map((id) =>
      ceremonyNonce({ state: signers[id]!.state, participantId: id, context, trustedInput }),
    );
    const pubnonces = Object.fromEntries(
      roundOneIds.map((id, index) => [pubkeyOf(publicOnly.state, id), nonces[index]!.pubnonce]),
    );
    const partialSigs = Object.fromEntries(
      roundOneIds.map((id, index) => [
        pubkeyOf(publicOnly.state, id),
        ceremonyPartial({
          state: signers[id]!.state,
          participantId: id,
          context,
          pubnonces,
          secnonce: nonces[index]!.secnonce,
          trustedInput,
        }).partialSig,
      ]),
    );
    const aggregated = ceremonyAggregate({
      state: publicOnly.state,
      context,
      pubnonces,
      partialSigs,
      trustedInput,
    });
    cooperativeTxid = aggregated.txid;
    transcript.push(aggregated.transactionHex, JSON.stringify(aggregated.authorization));
    assert(aggregated.consensus.checks.length > 0, 'no consensus checks were run');
    return aggregated.txid;
  });

  // Every participant's payout must appear exactly once — an exit that quietly
  // drops a participant is the whole attack this ceremony has to survive.
  expect('the cooperative exit pays every participant their equal share', () => {
    const authorization = authorizeCooperativeContext({
      state: publicOnly.state,
      context,
      trustedInput,
    });
    const addresses = authorization.outputs.map((output) => output.address).sort();
    const expected = roundOneIds.map((id) => participantById(publicOnly.state, id).payoutAddress).sort();
    assert(addresses.join(',') === expected.join(','), 'cooperative outputs are not the roster payout set');
    const values = new Set(authorization.outputs.map((output) => output.valueSats));
    assert(values.size === 1, 'cooperative outputs are not equal');
    return authorization.feeSats;
  });

  const hostileContexts: Array<[string, string, () => CeremonyContext]> = [
    ['a context paying the whole pot to one participant', 'byte-for-byte', () =>
      contextWithPsbt(
        context,
        hostilePsbt(roundOneVault, trustedInput, [
          { address: participantById(publicOnly.state, 'alice').payoutAddress, valueSats: potSats - AMOUNTS.cooperativeFee },
        ]),
        trustedInput,
      ),
    ],
    ['a context skimming an extra output to one participant', 'byte-for-byte', () =>
      contextWithPsbt(
        context,
        hostilePsbt(roundOneVault, trustedInput, [
          ...cooperativeSplit(publicOnly.state, roundOneIds, potSats - 1_000),
          { address: participantById(publicOnly.state, 'alice').payoutAddress, valueSats: 1_000 },
        ]),
        trustedInput,
      ),
    ],
    ['a context whose message is not the sighash of its own transaction', 'BIP-341 key-spend sighash', () => ({
      ...context,
      message: flipHex(context.message),
    })],
    ['a context claiming a different MuSig2 aggregate key', 'aggregate key', () => ({
      ...context,
      aggregateXonly: vaultOf(publicOnly.state, ['bob', 'carol']).keyPath.aggregateXonlyPubkey,
    })],
    ['a context claiming a different tap merkle root', 'tap merkle root', () => ({
      ...context,
      tapMerkleRoot: vaultOf(publicOnly.state, ['bob', 'carol']).tapMerkleRoot,
    })],
    ['a context with a reordered signer set', 'KeySort order', () => ({
      ...context,
      sortedPubkeys: [...context.sortedPubkeys].reverse(),
    })],
    ['a context that drops a signer from the aggregate', 'KeySort order', () => ({
      ...context,
      sortedPubkeys: context.sortedPubkeys.slice(1),
    })],
    ['a context for a different round than the coin being spent', 'KeySort order', () => ({
      ...context,
      round: roundId(['bob', 'carol']),
    })],
    ['a context whose PSBT already carries a key-path signature', 'byte-for-byte', () =>
      contextWithPsbt(context, presignedPsbt(context.psbtBase64), trustedInput),
    ],
  ];
  for (const [name, because, build] of hostileContexts) {
    expectReject(`${name} is rejected before any nonce is generated`, because, () =>
      ceremonyNonce({
        state: signers['alice']!.state,
        participantId: 'alice',
        context: build(),
        trustedInput,
      }),
    );
  }

  const hostileInputs: Array<[string, string, TrustedVaultInput]> = [
    ['a swapped outpoint txid', 'not the trusted outpoint', { ...trustedInput, txid: OTHER_TXID }],
    ['a swapped outpoint index', 'trusted outpoint index', { ...trustedInput, vout: 1 }],
    ['an inflated input value', 'is not the trusted', { ...trustedInput, valueSats: potSats + 100_000 }],
    ['a foreign input script', 'vault script', {
      ...trustedInput,
      scriptPubKeyHex: vaultOf(publicOnly.state, ['bob', 'carol']).outputScriptHex,
    }],
  ];
  for (const [name, because, hostile] of hostileInputs) {
    expectReject(`a context that disagrees with the signer's own view of the coin (${name})`, because, () =>
      ceremonyNonce({
        state: signers['alice']!.state,
        participantId: 'alice',
        context,
        trustedInput: hostile,
      }),
    );
  }

  expectReject('a tampered context is rejected again at the partial-signature round', 'byte-for-byte', () => {
    const honest = ceremonyNonce({
      state: signers['alice']!.state,
      participantId: 'alice',
      context,
      trustedInput,
    });
    const hostile = contextWithPsbt(
      context,
      hostilePsbt(roundOneVault, trustedInput, [
        { address: participantById(publicOnly.state, 'alice').payoutAddress, valueSats: potSats - AMOUNTS.cooperativeFee },
      ]),
      trustedInput,
    );
    return ceremonyPartial({
      state: signers['alice']!.state,
      participantId: 'alice',
      context: hostile,
      pubnonces: { [pubkeyOf(publicOnly.state, 'alice')]: honest.pubnonce },
      secnonce: honest.secnonce,
      trustedInput,
    });
  });

  expectReject('a participant outside the round cannot join its ceremony', 'not a signer', () => {
    const pairVault = vaultOf(publicOnly.state, ['bob', 'carol']);
    const pairInput = asTrustedVaultInput({
      txid: FUNDING_TXID,
      vout: 0,
      valueSats: pairPotSats(),
      scriptPubKeyHex: pairVault.outputScriptHex,
    });
    const pairContext = ceremonyStart({
      state: publicOnly.state,
      currentIds: ['bob', 'carol'],
      trustedInput: pairInput,
    });
    return ceremonyNonce({
      state: signers['alice']!.state,
      participantId: 'alice',
      context: pairContext,
      trustedInput: pairInput,
    });
  });

  // ── 3. Timelocked recovery from independent shares ───────────────────────

  const vanishedId = 'carol';
  const recoveryIds = roundOneIds;
  const recoveryBuilt = buildRecoveryPsbt({
    state: publicOnly.state,
    currentIds: recoveryIds,
    vanishedId,
    txid: trustedInput.txid,
    vout: trustedInput.vout,
    valueSats: trustedInput.valueSats,
  });
  const shareOf = (id: string, psbtBase64 = recoveryBuilt.psbtBase64, input = trustedInput): RecoveryShare =>
    createRecoveryShare({
      signer: signers[id]!,
      currentIds: recoveryIds,
      vanishedId,
      psbtBase64,
      trustedInput: input,
    }).share;

  let aliceShare: RecoveryShare | null = null;
  let bobShare: RecoveryShare | null = null;
  expect('two rescuers each sign a recovery share on their own device', () => {
    aliceShare = shareOf('alice');
    bobShare = shareOf('bob');
    transcript.push(JSON.stringify(aliceShare), JSON.stringify(bobShare));
    assert(aliceShare.participantId === 'alice' && bobShare.participantId === 'bob', 'share attribution mismatch');
    assert(aliceShare.unsignedTxid === bobShare.unsignedTxid, 'rescuers signed different transactions');
    assert(aliceShare.signatureHex !== bobShare.signatureHex, 'rescuers produced identical signatures');
    return aliceShare.unsignedTxid;
  });

  expect('independently produced shares aggregate into a consensus-valid recovery', () => {
    const aggregated = aggregateRecoveryShares({
      state: publicOnly.state,
      currentIds: recoveryIds,
      vanishedId,
      psbtBase64: recoveryBuilt.psbtBase64,
      trustedInput,
      shares: [aliceShare!, bobShare!],
    });
    transcript.push(aggregated.transactionHex);
    assert(aggregated.threshold === 2, `expected threshold 2, got ${aggregated.threshold}`);
    assert(aggregated.signerIds.join(',') === 'alice,bob', 'unexpected recovery signer set');
    assert(aggregated.consensus.checks.length > 0, 'recovery ran no consensus checks');
    assert(aggregated.txid !== cooperativeTxid, 'recovery reused the cooperative txid');
    return aggregated.txid;
  });

  const aggregateWith = (shares: RecoveryShare[], psbtBase64 = recoveryBuilt.psbtBase64) =>
    aggregateRecoveryShares({
      state: publicOnly.state,
      currentIds: recoveryIds,
      vanishedId,
      psbtBase64,
      trustedInput,
      shares,
    });

  expectReject('an insufficient number of recovery shares', 'exactly 2 distinct share', () =>
    aggregateWith([aliceShare!]),
  );
  expectReject('a duplicated recovery share standing in for a second rescuer', 'duplicate recovery share', () =>
    aggregateWith([aliceShare!, { ...aliceShare! }]),
  );
  expectReject('a recovery share signed over a different tapscript leaf', 'not a valid signature', () => {
    const { policyLeaf } = soloLeavesOf(roundOneVault, 'alice');
    const wrongLeafSignature = signRecoveryLeaf(
      signers['alice']!,
      recoveryBuilt.psbtBase64,
      trustedInput,
      tapLeafHash(Buffer.from(policyLeaf.scriptHex, 'hex')),
    );
    return aggregateWith([{ ...aliceShare!, signatureHex: wrongLeafSignature }, bobShare!]);
  });
  expectReject('a recovery share labelled with a foreign leaf hash', 'different tapscript leaf', () => {
    const { policyLeaf } = soloLeavesOf(roundOneVault, 'alice');
    return aggregateWith([
      { ...aliceShare!, leafHashHex: tapLeafHash(Buffer.from(policyLeaf.scriptHex, 'hex')).toString('hex') },
      bobShare!,
    ]);
  });
  expectReject('a recovery share bound to a different transaction', 'different transaction', () =>
    aggregateWith([{ ...aliceShare!, unsignedTxid: FUNDING_TXID }, bobShare!]),
  );
  expectReject('a recovery share claiming another participant\'s key', 'roster key', () =>
    aggregateWith([{ ...aliceShare!, participantId: 'bob' }, bobShare!]),
  );
  expectReject('a recovery share from a key outside the recovery set', 'recovery key set', () =>
    aggregateWith([
      { ...aliceShare!, xonlyPubkey: participantById(publicOnly.state, 'alice').payout.xonlyPubKeyHex },
      bobShare!,
    ]),
  );
  expectReject('a recovery transaction that skims sats off a rescuer\'s payout', 'byte-for-byte', () =>
    aggregateWith(
      [aliceShare!, bobShare!],
      hostileRecoveryPsbt(publicOnly.state, roundOneVault, recoveryIds, trustedInput, 'skim'),
    ),
  );
  expectReject('a recovery transaction carrying an extra hostile output', 'byte-for-byte', () =>
    aggregateWith(
      [aliceShare!, bobShare!],
      hostileRecoveryPsbt(publicOnly.state, roundOneVault, recoveryIds, trustedInput, 'extra-output'),
    ),
  );
  expectReject(
    'a rescuer signing a recovery PSBT that does not match their own trusted coin',
    'is not the trusted',
    () => shareOf('alice', recoveryBuilt.psbtBase64, { ...trustedInput, valueSats: potSats - 1 }),
  );
  expectReject('the vanished participant contributing their own recovery share', 'vanished participant', () =>
    shareOf('carol'),
  );

  // ── 4. Final sweep: the owner, and only the owner ────────────────────────

  const sweepOwner = signers['carol']!;
  const carol = participantById(publicOnly.state, 'carol');
  const sweepValueSats = 102_497_000;
  const sweepInput = asTrustedVaultInput({
    txid: FUNDING_TXID,
    vout: 1,
    valueSats: sweepValueSats,
    scriptPubKeyHex: payoutScriptHex(carol.payoutAddress),
  });
  const sweepBuilt = buildFinalSweepPsbt({
    state: publicOnly.state,
    participantId: 'carol',
    txid: sweepInput.txid,
    vout: sweepInput.vout,
    valueSats: sweepInput.valueSats,
    feeSats: AMOUNTS.finalSweepFee,
  });

  expect('the last participant sweeps their own payout output and the result verifies', () => {
    const authorization = authorizeFinalSweep({
      state: sweepOwner.state,
      participantId: sweepOwner.participantId,
      psbtBase64: sweepBuilt.psbtBase64,
      trustedInput: sweepInput,
      feeSats: AMOUNTS.finalSweepFee,
    });
    const signed = signFinalSweepPsbt({
      state: sweepOwner.state,
      participantId: sweepOwner.participantId,
      psbtBase64: sweepBuilt.psbtBase64,
    });
    assert(signed.txid === authorization.unsignedTxid, 'signed sweep is not the authorized transaction');
    const consensus = verifyVaultTransaction({
      txHex: signed.transactionHex,
      prevouts: [{ scriptPubKeyHex: sweepInput.scriptPubKeyHex, valueSats: sweepInput.valueSats }],
    });
    transcript.push(signed.transactionHex, JSON.stringify(authorization));
    assert(consensus.checks.length > 0, 'final sweep ran no consensus checks');
    return signed.txid;
  });

  expectReject('another participant authorizing a sweep of the owner\'s coin', 'payout output', () =>
    authorizeFinalSweep({
      state: signers['bob']!.state,
      participantId: signers['bob']!.participantId,
      psbtBase64: sweepBuilt.psbtBase64,
      trustedInput: sweepInput,
      feeSats: AMOUNTS.finalSweepFee,
    }),
  );
  expectReject('another participant signing the owner\'s sweep', 'private key', () =>
    signFinalSweepPsbtGuarded(signers['bob']!, 'carol', sweepBuilt.psbtBase64),
  );
  expectReject('a sweep redirected to a destination the owner did not authorize', 'byte-for-byte', () =>
    authorizeFinalSweep({
      state: sweepOwner.state,
      participantId: sweepOwner.participantId,
      psbtBase64: buildFinalSweepPsbt({
        state: publicOnly.state,
        participantId: 'carol',
        txid: sweepInput.txid,
        vout: sweepInput.vout,
        valueSats: sweepInput.valueSats,
        feeSats: AMOUNTS.finalSweepFee,
        destinationAddress: participantById(publicOnly.state, 'alice').payoutAddress,
      }).psbtBase64,
      trustedInput: sweepInput,
      feeSats: AMOUNTS.finalSweepFee,
    }),
  );
  expectReject('a sweep that quietly raises the fee', 'byte-for-byte', () =>
    authorizeFinalSweep({
      state: sweepOwner.state,
      participantId: sweepOwner.participantId,
      psbtBase64: buildFinalSweepPsbt({
        state: publicOnly.state,
        participantId: 'carol',
        txid: sweepInput.txid,
        vout: sweepInput.vout,
        valueSats: sweepInput.valueSats,
        feeSats: AMOUNTS.finalSweepFee + 50_000,
      }).psbtBase64,
      trustedInput: sweepInput,
      feeSats: AMOUNTS.finalSweepFee,
    }),
  );
  expectReject('a sweep of a coin the owner never vouched for', 'trusted outpoint', () =>
    authorizeFinalSweep({
      state: sweepOwner.state,
      participantId: sweepOwner.participantId,
      psbtBase64: sweepBuilt.psbtBase64,
      trustedInput: { ...sweepInput, txid: OTHER_TXID },
      feeSats: AMOUNTS.finalSweepFee,
    }),
  );
  expectReject('a sweep of a vault coin dressed up as a payout output', 'payout output', () =>
    authorizeFinalSweep({
      state: sweepOwner.state,
      participantId: sweepOwner.participantId,
      psbtBase64: sweepBuilt.psbtBase64,
      trustedInput,
      feeSats: AMOUNTS.finalSweepFee,
    }),
  );

  // ── 5. Nothing secret ever left the device ───────────────────────────────

  const forbidden = secretMaterial(allIds);
  const haystack = `${transcript.join('\n')}\n${JSON.stringify(checks)}`;
  const leaked = forbidden.filter(({ value }) => haystack.includes(value));
  record({
    name: 'no secret, private key, or sentinel appears in anything this suite reports',
    ok: leaked.length === 0,
    detail:
      leaked.length === 0
        ? `scanned ${haystack.length} characters against ${forbidden.length} secret values`
        : `leaked: ${leaked.map((item) => item.label).join(', ')}`,
  });

  const failed = checks.filter((item) => !item.ok).length;
  return { passed: failed === 0, total: checks.length, failed, checks };
}

// ── Fixtures and helpers ───────────────────────────────────────────────────

function secretFor(participantId: string): string {
  const secret = TEST_SECRETS[participantId];
  if (!secret) throw new Error(`no offline test secret for ${participantId}`);
  return secret;
}

/** Every value that must never appear in output: secrets and derived keys. */
function secretMaterial(allIds: string[]): Array<{ label: string; value: string }> {
  const material: Array<{ label: string; value: string }> = [{ label: 'sentinel', value: SENTINEL }];
  for (const id of allIds) {
    material.push({ label: `${id} secret`, value: secretFor(id) });
    const keys = deriveParticipantKeys(id, secretFor(id), allIds);
    material.push({ label: `${id} personal private key`, value: keys.personal.privateKeyHex });
    material.push({ label: `${id} payout private key`, value: keys.payout.privateKeyHex });
    for (const [round, key] of Object.entries(keys.sigbashByRound)) {
      material.push({ label: `${id} ${round} Sigbash private key`, value: key.privateKeyHex });
    }
  }
  return material;
}

function vaultOf(state: VaultState, ids: string[]): VaultRound {
  const vault = state.vaults.get(roundId(ids));
  if (!vault) throw new Error(`no vault for ${roundId(ids)}`);
  return vault;
}

function pubkeyOf(state: VaultState, id: string): Hex {
  return participantById(state, id).personal.publicKeyHex;
}

function payoutScriptHex(address: string): Hex {
  return Buffer.from(bitcoin.address.toOutputScript(address, BITCOIN_NETWORK)).toString('hex');
}

function pairPotSats(): number {
  return AMOUNTS.deposit * PARTICIPANTS.length - AMOUNTS.firstWithdrawal - AMOUNTS.feePerSoloWithdrawal;
}

function cooperativeSplit(
  state: VaultState,
  ids: string[],
  totalSats: number,
): Array<{ address: string; valueSats: number }> {
  const each = Math.floor(totalSats / ids.length);
  return ids.map((id) => ({ address: participantById(state, id).payoutAddress, valueSats: each }));
}

/** A structurally plausible key-path PSBT with attacker-chosen outputs. */
function hostilePsbt(
  vault: VaultRound,
  trustedInput: TrustedVaultInput,
  outputs: Array<{ address: string; valueSats: number }>,
): bitcoin.Psbt {
  const psbt = new bitcoin.Psbt({ network: BITCOIN_NETWORK });
  psbt.addInput({
    hash: trustedInput.txid,
    index: trustedInput.vout,
    witnessUtxo: {
      script: Buffer.from(trustedInput.scriptPubKeyHex, 'hex'),
      value: BigInt(trustedInput.valueSats),
    },
    tapInternalKey: Buffer.from(vault.keyPath.aggregateXonlyPubkey, 'hex'),
  });
  for (const output of outputs) {
    psbt.addOutput({ address: output.address, value: BigInt(output.valueSats) });
  }
  return psbt;
}

/** A recovery PSBT with the right leaf, the right coin, and hostile outputs. */
function hostileRecoveryPsbt(
  state: VaultState,
  vault: VaultRound,
  ids: string[],
  trustedInput: TrustedVaultInput,
  mutation: 'extra-output' | 'skim',
): string {
  const leaf = vault.tapscriptLeaves.find((item) => item.type === 'timelocked-recovery');
  if (leaf?.type !== 'timelocked-recovery') throw new Error('no recovery leaf');
  const psbt = new bitcoin.Psbt({ network: BITCOIN_NETWORK });
  psbt.setVersion(2);
  psbt.addInput({
    hash: trustedInput.txid,
    index: trustedInput.vout,
    sequence: RECOVERY_DELAY_BLOCKS,
    witnessUtxo: {
      script: Buffer.from(trustedInput.scriptPubKeyHex, 'hex'),
      value: BigInt(trustedInput.valueSats),
    },
    tapInternalKey: Buffer.from(vault.keyPath.aggregateXonlyPubkey, 'hex'),
    tapLeafScript: [
      {
        leafVersion: 0xc0,
        script: Buffer.from(leaf.scriptHex, 'hex'),
        controlBlock: Buffer.from(leaf.controlBlockHex, 'hex'),
      },
    ],
  });
  const honestEach = Math.floor((trustedInput.valueSats - AMOUNTS.recoveryFee) / ids.length);
  if (mutation === 'skim') {
    // Same shape, same coin: one rescuer is quietly shorted 25,000 sats.
    ids.forEach((id, index) => {
      psbt.addOutput({
        address: participantById(state, id).payoutAddress,
        value: BigInt(index === 0 ? honestEach - 25_000 : honestEach),
      });
    });
    return psbt.toBase64();
  }
  const each = Math.floor((trustedInput.valueSats - AMOUNTS.recoveryFee - 25_000) / ids.length);
  for (const id of ids) {
    psbt.addOutput({ address: participantById(state, id).payoutAddress, value: BigInt(each) });
  }
  psbt.addOutput({
    address: participantById(state, 'alice').payoutAddress,
    value: BigInt(25_000),
  });
  return psbt.toBase64();
}

/** A ceremony context rebuilt around a hostile PSBT, message included. */
function contextWithPsbt(
  context: CeremonyContext,
  psbt: bitcoin.Psbt,
  trustedInput: TrustedVaultInput,
): CeremonyContext {
  const tx = unsignedTx(psbt);
  const message = Buffer.from(
    tx.hashForWitnessV1(
      0,
      [Buffer.from(trustedInput.scriptPubKeyHex, 'hex')],
      [BigInt(trustedInput.valueSats)],
      bitcoin.Transaction.SIGHASH_DEFAULT,
    ),
  ).toString('hex');
  return { ...context, psbtBase64: psbt.toBase64(), message };
}

/** The same transaction, but already carrying a (bogus) key-path signature. */
function presignedPsbt(psbtBase64: string): bitcoin.Psbt {
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: BITCOIN_NETWORK });
  psbt.updateInput(0, { tapKeySig: Buffer.alloc(64, 7) });
  return psbt;
}

/** A real BIP-340 signature over the *wrong* leaf's sighash. */
function signRecoveryLeaf(
  signer: LocalSigner,
  psbtBase64: string,
  trustedInput: TrustedVaultInput,
  leafHash: Buffer,
): Hex {
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: BITCOIN_NETWORK });
  const message = Buffer.from(
    unsignedTx(psbt).hashForWitnessV1(
      0,
      [Buffer.from(trustedInput.scriptPubKeyHex, 'hex')],
      [BigInt(trustedInput.valueSats)],
      bitcoin.Transaction.SIGHASH_DEFAULT,
      leafHash,
    ),
  );
  const participant = participantById(signer.state, signer.participantId);
  return Buffer.from(
    ecc.signSchnorr(message, Buffer.from(participant.personal.privateKeyHex, 'hex')),
  ).toString('hex');
}

/**
 * signFinalSweepPsbt with the guard the CLI enforces: a device may only sign
 * for the participant its secret belongs to. Without the guard bitcoinjs would
 * fail on an empty private key anyway; this makes the reason explicit.
 */
function signFinalSweepPsbtGuarded(signer: LocalSigner, participantId: string, psbtBase64: string) {
  const participant = participantById(signer.state, participantId);
  if (participant.payout.privateKeyHex === '') {
    throw new Error(`${signer.participantId}'s device holds no ${participantId} payout private key`);
  }
  return signFinalSweepPsbt({ state: signer.state, participantId, psbtBase64 });
}

function flipHex(value: string): string {
  const first = value[0] === '0' ? '1' : '0';
  return `${first}${value.slice(1)}`;
}

function describe(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
