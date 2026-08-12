import {
  AMOUNTS,
  DEMO_SEED,
  NETWORK,
  PARTICIPANTS,
  POLICY_FLOORS,
  RECOVERY_DELAY_BLOCKS,
} from './config.js';
import {
  keyAgg,
  keySort,
  buildVaultTaproot,
  deriveXpubChildPubkey,
  deterministicKeypair,
  hmacHex,
  sha256Hex,
  taprootAddress,
  xpubRootXonly,
} from './crypto.js';
import {
  asSats,
  type LedgerTx,
  type LedgerUtxo,
  type Participant,
  type RecoveryTapLeaf,
  type Sats,
  type SigbashRoundKey,
  type SoloPolicy,
  type VaultRound,
  type VaultState,
} from './types.js';

/**
 * Nested overrides: participantId -> roundId -> live leaf keys, as printed
 * by sigbash-live-setup. `key` is the policy-spend leaf key (the xpub's
 * child 0/0); `identificationKey` is the identification leaf key (the
 * xpub's internal root). Legacy bare-string overrides and objects missing
 * the identification material are rejected: silently falling back would
 * derive a different vault address than the canonical dual-leaf tree.
 */
export type SigbashLeafOverride =
  | string
  | { key: string; xpub?: string; identificationKey?: string };
export type SigbashLeafOverrides = Record<string, Record<string, SigbashLeafOverride> | undefined>;

interface ResolvedLiveLeafKeys {
  key: string;
  xpub?: string;
  identificationKey: string;
}

function resolveSigbashLeafOverride(
  participantId: string,
  round: string,
  override: SigbashLeafOverride,
): ResolvedLiveLeafKeys {
  const where = `${participantId}:${round}`;
  if (typeof override === 'string') {
    throw new Error(
      `legacy single-key Sigbash leaf override for ${where}: the dual-leaf vault needs ` +
        `{ key, xpub, identificationKey }. Regenerate SIGBASH_LEAF_KEYS_JSON with sigbash-live-setup.`,
    );
  }
  if (!override.key) {
    throw new Error(`Sigbash leaf override for ${where} is missing the policy leaf key`);
  }
  if (override.xpub) {
    const derivedChild = deriveXpubChildPubkey(override.xpub, [0, 0]).xonlyPubKeyHex;
    if (override.key !== derivedChild) {
      throw new Error(
        `Sigbash leaf override for ${where} is inconsistent: key is not the xpub's child 0/0`,
      );
    }
    const derivedRoot = xpubRootXonly(override.xpub);
    if (override.identificationKey && override.identificationKey !== derivedRoot) {
      throw new Error(
        `Sigbash leaf override for ${where} is inconsistent: identificationKey is not the xpub's internal root`,
      );
    }
    return { key: override.key, xpub: override.xpub, identificationKey: derivedRoot };
  }
  if (!override.identificationKey) {
    throw new Error(
      `incomplete Sigbash leaf override for ${where}: provide xpub or identificationKey ` +
        `so the identification leaf matches the live-registered key`,
    );
  }
  if (override.identificationKey === override.key) {
    throw new Error(
      `Sigbash leaf override for ${where} reuses the policy leaf key as the identification key`,
    );
  }
  return { key: override.key, identificationKey: override.identificationKey };
}

// Every participant has one Sigbash key *per round in which they could be the
// leaver*: round one ({A,B,C}) plus each pair round they belong to. Keys are
// never reused across rounds. This is what makes the policy set sound with
// immutable Sigbash keys: a key's signature is only valid for the tapscript
// leaf that contains that exact key, and that leaf exists in exactly one round
// vault, so a round-two policy can never be satisfied by spending the round-one
// coin (or vice versa). A single shared key with an OR-of-rounds policy does
// not have that property.
export function participantLeaveRounds(participantId: string, allIds: string[]): string[] {
  const others = allIds.filter((id) => id !== participantId);
  return [
    roundId(allIds),
    ...others.map((otherId) => roundId([participantId, otherId])),
  ];
}

export function createDemoState({
  sigbashLeafOverrides = {},
}: { sigbashLeafOverrides?: SigbashLeafOverrides } = {}): VaultState {
  const allIds = PARTICIPANTS.map((participant) => participant.id);
  const participants: Participant[] = PARTICIPANTS.map((participant) => {
    const personal = deterministicKeypair(DEMO_SEED, `${participant.id}:personal`);
    const payoutKey = deterministicKeypair(DEMO_SEED, `${participant.id}:payout`);
    const sigbashByRound: Record<string, SigbashRoundKey> = {};
    for (const round of participantLeaveRounds(participant.id, allIds)) {
      const localShare = deterministicKeypair(
        DEMO_SEED,
        `${participant.id}:sigbash-client-share:${round}`,
      );
      const override = sigbashLeafOverrides[participant.id]?.[round];
      const resolved = override
        ? resolveSigbashLeafOverride(participant.id, round, override)
        : null;
      sigbashByRound[round] = {
        ...localShare,
        xonlyPubKeyHex: resolved?.key || localShare.xonlyPubKeyHex,
        isLiveKey: Boolean(resolved),
        ...(resolved?.xpub ? { xpub: resolved.xpub } : {}),
        identificationXonlyPubKeyHex:
          resolved?.identificationKey ??
          localIdentificationKey(DEMO_SEED, participant.id, round),
      };
    }
    return {
      ...participant,
      personal,
      sigbashByRound,
      payout: payoutKey,
      payoutAddress: taprootAddress(payoutKey.xonlyPubKeyHex),
    };
  });

  const vaults = buildVaultTree(participants);
  const policies = buildPolicies(participants, vaults);
  return { participants, vaults, policies };
}

// ── Per-participant key custody ────────────────────────────────────────────
// The demo derives every key from one shared seed. For real use each friend
// runs vault-keygen on their own device with their own secret, generating
// their personal and payout keys. The roster also carries the public Sigbash
// leaf material for every round, but live Sigbash controls those signing
// shares independently of the participant secret. No one ever sees another
// participant's secret. Everyone assembles the same public roster, derives
// identical vault addresses, and confirms agreement before funding.

export interface RosterEntry {
  id: string;
  label: string;
  personalPublicKeyHex: string;
  payoutAddress: string;
  payoutXonlyPubkeyHex: string;
  /** Policy-spend leaf key per round (the key solo signing uses). */
  sigbashLeafByRound: Record<string, string>;
  /** Identification-only leaf key per round; never a spend key. */
  sigbashIdentificationLeafByRound: Record<string, string>;
  /**
   * Service-created public registration data. Offline acceptance rosters omit
   * this field; a user-facing/fundable roster must contain one validated entry
   * for every round in which this participant can leave.
   */
  sigbashRegistrationByRound?: Record<string, SigbashRosterRegistration>;
}

export interface SigbashRosterRegistration {
  network: 'mainnet';
  keyId: string;
  keyIndex: number;
  bip328Xpub: string;
  policyLeafXonlyPubkey: string;
  identificationLeafXonlyPubkey: string;
  policyRoot: string;
  policyId: string;
}

// Local stand-in for the live xpub internal root: keeps local and live tap
// trees structurally identical (dual leaves per participant/round). Only the
// public key is ever retained, so the local model cannot sign this leaf.
function localIdentificationKey(secret: string, participantId: string, round: string): string {
  return deterministicKeypair(secret, `${participantId}:sigbash-identification:${round}`)
    .xonlyPubKeyHex;
}

export function deriveParticipantKeys(participantId: string, secret: string, allIds: string[]) {
  const config = PARTICIPANTS.find((p) => p.id === participantId);
  if (!config) throw new Error(`unknown participant ${participantId}`);
  const personal = deterministicKeypair(secret, `${participantId}:personal`);
  const payout = deterministicKeypair(secret, `${participantId}:payout`);
  const sigbashByRound: Record<string, SigbashRoundKey> = {};
  for (const round of participantLeaveRounds(participantId, allIds)) {
    sigbashByRound[round] = {
      ...deterministicKeypair(secret, `${participantId}:sigbash-client-share:${round}`),
      isLiveKey: false,
      identificationXonlyPubKeyHex: localIdentificationKey(secret, participantId, round),
    };
  }
  return { config, personal, payout, sigbashByRound };
}

export function rosterEntry(participantId: string, secret: string, allIds: string[]): RosterEntry {
  const keys = deriveParticipantKeys(participantId, secret, allIds);
  return {
    id: participantId,
    label: keys.config.label,
    personalPublicKeyHex: keys.personal.publicKeyHex,
    payoutAddress: taprootAddress(keys.payout.xonlyPubKeyHex),
    payoutXonlyPubkeyHex: keys.payout.xonlyPubKeyHex,
    sigbashLeafByRound: Object.fromEntries(
      Object.entries(keys.sigbashByRound).map(([round, key]) => [round, key.xonlyPubKeyHex]),
    ),
    sigbashIdentificationLeafByRound: Object.fromEntries(
      Object.entries(keys.sigbashByRound).map(([round, key]) => [
        round,
        key.identificationXonlyPubKeyHex,
      ]),
    ),
  };
}

// Build vault state from a roster of public keys, optionally filling in one
// participant's personal and payout private keys so that participant can sign
// cooperative exits, recovery shares, and their final sweep locally. Sigbash
// leaf keys are always public-only here: live leaf keys are created and held by
// Sigbash, not derived from (or recoverable through) the participant secret.
// With no secret, the entire state is public-only.
export function createRosterState(
  roster: RosterEntry[],
  localSecret?: { participantId: string; secret: string },
): VaultState {
  const allIds = roster.map((entry) => entry.id);
  const participants: Participant[] = roster.map((entry) => {
    const isLocal = localSecret?.participantId === entry.id;
    const localKeys = isLocal
      ? deriveParticipantKeys(entry.id, localSecret!.secret, allIds)
      : null;
    if (localKeys && localKeys.personal.publicKeyHex !== entry.personalPublicKeyHex) {
      throw new Error(`local secret for ${entry.id} does not match the roster's public key`);
    }
    if (
      localKeys &&
      (localKeys.payout.xonlyPubKeyHex !== entry.payoutXonlyPubkeyHex ||
        taprootAddress(localKeys.payout.xonlyPubKeyHex) !== entry.payoutAddress)
    ) {
      throw new Error(`local secret for ${entry.id} does not match the roster's payout key`);
    }
    const sigbashByRound: Record<string, SigbashRoundKey> = {};
    for (const [round, leafKey] of Object.entries(entry.sigbashLeafByRound)) {
      const identificationKey = entry.sigbashIdentificationLeafByRound?.[round];
      if (!identificationKey) {
        throw new Error(
          `roster entry for ${entry.id} is missing the ${round} identification leaf key; ` +
            `regenerate the entry with vault-keygen`,
        );
      }
      const registration = entry.sigbashRegistrationByRound?.[round];
      sigbashByRound[round] = {
        privateKeyHex: '',
        publicKeyHex: `02${leafKey}`,
        xonlyPubKeyHex: leafKey,
        isLiveKey: Boolean(registration),
        ...(registration ? { xpub: registration.bip328Xpub } : {}),
        identificationXonlyPubKeyHex: identificationKey,
      };
    }
    return {
      id: entry.id,
      label: entry.label,
      personal: {
        privateKeyHex: localKeys?.personal.privateKeyHex ?? '',
        publicKeyHex: entry.personalPublicKeyHex,
        xonlyPubKeyHex: Buffer.from(entry.personalPublicKeyHex, 'hex').subarray(1).toString('hex'),
      },
      payout: {
        privateKeyHex: localKeys?.payout.privateKeyHex ?? '',
        publicKeyHex: localKeys?.payout.publicKeyHex ?? `02${entry.payoutXonlyPubkeyHex}`,
        xonlyPubKeyHex: entry.payoutXonlyPubkeyHex,
      },
      payoutAddress: entry.payoutAddress,
      sigbashByRound,
    };
  });
  const vaults = buildVaultTree(participants);
  const policies = buildPolicies(participants, vaults);
  for (const entry of roster) {
    for (const [round, registration] of Object.entries(entry.sigbashRegistrationByRound || {})) {
      const expectedPolicy = policies.get(`${round}:${entry.id}`);
      if (!expectedPolicy) throw new Error(`no policy for live Sigbash registration ${entry.id}:${round}`);
      expectedPolicy.keyId = registration.keyId;
    }
  }
  return { participants, vaults, policies };
}

export function buildVaultTree(participants: Participant[]): Map<string, VaultRound> {
  const byIds = new Map(participants.map((p) => [p.id, p]));
  const allIds = participants.map((p) => p.id);
  const rounds = new Map<string, VaultRound>();

  for (const ids of [allIds, ...pairs(allIds)]) {
    const round = roundId(ids);
    // Sort participants canonically by id so the vault (leaf order, tap tree,
    // key aggregation) is identical regardless of the order participants were
    // supplied in — a roster reordering must not change any vault address.
    const current = [...ids]
      .sort()
      .map((id) => {
        const participant = byIds.get(id);
        if (!participant) throw new Error(`unknown participant ${id}`);
        return participant;
      });
    const keyPath = keyAgg(keySort(current.map((p) => p.personal.publicKeyHex)));
    const taproot = buildVaultTaproot({
      internalXonlyPubkey: keyPath.xonlyPubKeyHex,
      soloLeafPubkeys: current.map((p) => ({
        participantId: p.id,
        xonlyPubkey: sigbashRoundKey(p, round).xonlyPubKeyHex,
        identificationXonlyPubkey: sigbashRoundKey(p, round).identificationXonlyPubKeyHex,
      })),
      recoveryDelayBlocks: RECOVERY_DELAY_BLOCKS,
      recoveryXonlyPubkeys: current.map((p) => p.personal.xonlyPubKeyHex),
    });
    rounds.set(round, {
      id: round,
      participantIds: ids,
      address: taproot.address,
      outputScriptHex: taproot.outputScriptHex,
      tapMerkleRoot: taproot.tapMerkleRoot,
      // Leaf order mirrors the tree: per participant the policy-spend leaf
      // pk(child 0/0) followed by the identification leaf pk(internal root).
      descriptor: `tr(musig(${current
        .map((p) => p.personal.publicKeyHex)
        .join(',')}),{${current
        .flatMap((p) => [
          `pk(${sigbashRoundKey(p, round).xonlyPubKeyHex})`,
          `pk(${sigbashRoundKey(p, round).identificationXonlyPubKeyHex})`,
        ])
        .join(',')},and_v(v:older(${RECOVERY_DELAY_BLOCKS}),multi_a(${Math.max(1, current.length - 1)},${current
        .map((p) => p.personal.xonlyPubKeyHex)
        .join(',')}))})`,
      keyPath: {
        type: 'MuSig2',
        personalXonlyPubkeys: current.map((p) => p.personal.xonlyPubKeyHex),
        personalCompressedPubkeys: current.map((p) => p.personal.publicKeyHex),
        sigbashXonlyPubkeys: [],
        aggregateXonlyPubkey: keyPath.xonlyPubKeyHex,
        aggregateCompressedPubkey: keyPath.publicKeyHex,
        aggregation: keyPath.aggregation,
      },
      tapscriptLeaves: taproot.tapLeaves,
    });
  }

  return rounds;
}

export function sigbashRoundKey(participant: Participant, round: string): SigbashRoundKey {
  const key = participant.sigbashByRound[round];
  if (!key) throw new Error(`${participant.id} has no Sigbash key for round ${round}`);
  return key;
}

export function buildPolicies(
  participants: Participant[],
  vaults: Map<string, VaultRound>,
): Map<string, SoloPolicy> {
  const byId = new Map(participants.map((p) => [p.id, p]));
  const policies = new Map<string, SoloPolicy>();
  const requireParticipant = (id: string): Participant => {
    const participant = byId.get(id);
    if (!participant) throw new Error(`unknown participant ${id}`);
    return participant;
  };

  const roundOneIds = participants.map((p) => p.id);
  for (const leaverId of roundOneIds) {
    const remainingIds = roundOneIds.filter((id) => id !== leaverId);
    const leaver = requireParticipant(leaverId);
    const nextVault = vaults.get(roundId(remainingIds));
    if (!nextVault) throw new Error(`missing vault for ${roundId(remainingIds)}`);
    policies.set(policyId(roundOneIds, leaverId), soloPolicy({
      roundIds: roundOneIds,
      leaver,
      payoutSats: AMOUNTS.firstWithdrawal,
      nextAddress: nextVault.address,
      leftoverFloor: POLICY_FLOORS.roundOneLeftover,
    }));
  }

  for (const ids of pairs(roundOneIds)) {
    for (const leaverId of ids) {
      const remainingId = ids.find((id) => id !== leaverId);
      if (!remainingId) throw new Error('pair round missing remaining participant');
      const leaver = requireParticipant(leaverId);
      const remaining = requireParticipant(remainingId);
      policies.set(policyId(ids, leaverId), soloPolicy({
        roundIds: ids,
        leaver,
        payoutSats: AMOUNTS.secondWithdrawal,
        nextAddress: remaining.payoutAddress,
        leftoverFloor: POLICY_FLOORS.roundTwoLeftover,
      }));
    }
  }

  return policies;
}

// The policy for one (round, leaver) Sigbash key. This is the whole policy for
// that key — no OR across rounds. Every condition is known before the key is
// created, so the key can be immutable (no admin-only `updateable` flag, no
// 24-hour post-update signing cooldown):
//   - payout amount and destination are pinned to output 0
//   - the leftover destination is pinned to the next round's vault (round two
//     keys are created first, so round-one policies can reference the round-two
//     vault addresses)
//   - the leftover floor bounds how much a malicious leaver can burn as fees
//   - output count and input count are pinned
//   - REQKEY in descriptor mode pins the tapscript leaf key to this Sigbash
//     key's own xpub-derived child, without needing to know the key in advance
export function soloPolicy({
  roundIds,
  leaver,
  payoutSats,
  nextAddress,
  leftoverFloor,
}: {
  roundIds: string[];
  leaver: Participant;
  payoutSats: Sats;
  nextAddress: string;
  leftoverFloor: Sats;
}): SoloPolicy {
  return {
    id: policyId(roundIds, leaver.id),
    leaverId: leaver.id,
    roundIds,
    network: NETWORK,
    logic: 'AND',
    conditions: [
      {
        type: 'OUTPUT_VALUE',
        selector: { type: 'INDEX', index: 0 },
        operator: 'EQ',
        value: payoutSats,
      },
      {
        type: 'OUTPUT_DEST_IS_IN_SETS',
        selector: { type: 'INDEX', index: 0 },
        addresses: [leaver.payoutAddress],
        network: NETWORK,
      },
      {
        type: 'OUTPUT_DEST_IS_IN_SETS',
        selector: { type: 'INDEX', index: 1 },
        addresses: [nextAddress],
        network: NETWORK,
      },
      {
        type: 'OUTPUT_VALUE',
        selector: { type: 'INDEX', index: 1 },
        operator: 'GTE',
        value: leftoverFloor,
      },
      { type: 'TX_OUTPUT_COUNT', operator: 'EQ', value: 2 },
      { type: 'TX_INPUT_COUNT', operator: 'EQ', value: 1 },
      {
        // Descriptor-mode REQKEY: previous live service testing proved this satisfies the
        // "signer key in required signer universe" clause when the tapscript
        // leaf contains the xpub's child 0/0 key. The local model checks the
        // equivalent round-scoped leaf key via local_key_identifier, which is
        // stripped before the policy is sent to Sigbash. This always refers to
        // the policy-spend leaf key; the identification leaf key must never
        // appear here (the audit suite enforces this).
        type: 'REQKEY',
        key_type: 'TAP_LEAF_XONLY_PUBKEY',
        use_descriptor: true,
        descriptor_template: 'tr(SIGBASH_XPUB/0/*)',
        local_key_identifier: sigbashRoundKey(leaver, roundId(roundIds)).xonlyPubKeyHex,
        selector: { type: 'ALL' },
      },
    ],
  };
}

export class Ledger {
  utxos = new Map<string, LedgerUtxo>();
  height = 100;

  fund(address: string, value: Sats, label: string): LedgerUtxo {
    const txid = sha256Hex(`${address}:${value}:${label}:${this.utxos.size}`);
    const outpoint = `${txid}:0`;
    const utxo: LedgerUtxo = { outpoint, address, value, label, spent: false };
    this.utxos.set(outpoint, utxo);
    return utxo;
  }

  spend(outpoint: string, tx: LedgerTx): LedgerTx {
    const utxo = this.utxos.get(outpoint);
    if (!utxo || utxo.spent) {
      throw new Error(`double-spend rejected: ${outpoint} is not spendable`);
    }
    const outputTotal = tx.outputs.reduce((sum, output) => sum + output.value, 0);
    if (outputTotal > utxo.value) {
      throw new Error('transaction outputs exceed input value');
    }
    utxo.spent = true;
    tx.txid = sha256Hex(JSON.stringify(tx));
    tx.fee = asSats(utxo.value - outputTotal);
    tx.outputs.forEach((output, index) => {
      const nextOutpoint = `${tx.txid}:${index}`;
      this.utxos.set(nextOutpoint, {
        outpoint: nextOutpoint,
        address: output.address,
        value: output.value,
        label: output.label,
        spent: false,
      });
    });
    return tx;
  }

  mine(blocks: number): number {
    this.height += blocks;
    return this.height;
  }
}

export function consolidateDeposits(ledger: Ledger, state: VaultState): LedgerUtxo {
  const roundOne = state.vaults.get(roundId(state.participants.map((p) => p.id)));
  if (!roundOne) throw new Error('missing round-one vault');
  const deposits = [...ledger.utxos.values()].filter(
    (utxo) => utxo.address === roundOne.address && !utxo.spent && utxo.value > 0,
  );
  for (const deposit of deposits) deposit.spent = true;
  const value = asSats(deposits.reduce((sum, utxo) => sum + utxo.value, 0));
  return ledger.fund(roundOne.address, value, 'round-1 vault UTXO');
}

export function buildSoloWithdrawal({
  state,
  currentUtxo,
  currentIds,
  leaverId,
}: {
  state: VaultState;
  currentUtxo: LedgerUtxo;
  currentIds: string[];
  leaverId: string;
}): LedgerTx {
  const policy = state.policies.get(policyId(currentIds, leaverId));
  if (!policy) throw new Error(`no solo policy for ${leaverId} in ${roundId(currentIds)}`);
  const payoutCondition = policy.conditions.find(
    (c) => c.type === 'OUTPUT_VALUE' && c.operator === 'EQ',
  );
  const nextAddressCondition = policy.conditions.find(
    (c) => c.type === 'OUTPUT_DEST_IS_IN_SETS' && c.selector.index === 1,
  );
  if (
    payoutCondition?.type !== 'OUTPUT_VALUE' ||
    nextAddressCondition?.type !== 'OUTPUT_DEST_IS_IN_SETS'
  ) {
    throw new Error(`policy ${policy.id} is missing payout conditions`);
  }
  const payout = payoutCondition.value;
  const nextAddress = nextAddressCondition.addresses[0];
  if (!nextAddress) throw new Error(`policy ${policy.id} pins no next address`);
  const fee =
    currentIds.length === 3 ? AMOUNTS.feePerSoloWithdrawal : AMOUNTS.feePerSoloWithdrawal * 2;
  const leaver = participantById(state, leaverId);
  return {
    kind: 'solo-withdrawal',
    round: roundId(currentIds),
    signer: leaverId,
    input: currentUtxo.outpoint,
    inputCount: 1,
    inputValue: currentUtxo.value,
    sigbashLeafKey: sigbashRoundKey(leaver, roundId(currentIds)).xonlyPubKeyHex,
    outputs: [
      {
        address: leaver.payoutAddress,
        value: payout,
        label: `${leaverId} payout`,
      },
      {
        address: nextAddress,
        value: asSats(currentUtxo.value - payout - fee),
        label: 'leftover re-vault',
      },
    ],
  };
}

export function buildCooperativeExit({
  state,
  currentUtxo,
  currentIds,
}: {
  state: VaultState;
  currentUtxo: LedgerUtxo;
  currentIds: string[];
}): LedgerTx {
  const participants = currentIds.map((id) => participantById(state, id));
  const refund = asSats(
    Math.floor((currentUtxo.value - AMOUNTS.cooperativeFee) / participants.length),
  );
  const vault = state.vaults.get(roundId(currentIds));
  if (!vault) throw new Error(`missing vault for ${roundId(currentIds)}`);
  return {
    kind: 'cooperative-exit',
    input: currentUtxo.outpoint,
    inputCount: 1,
    inputValue: currentUtxo.value,
    keyPath: vault.keyPath,
    signatures: participants.map((p) => simulatedSignature(p.personal.privateKeyHex, currentUtxo.outpoint)),
    outputs: participants.map((p) => ({
      address: p.payoutAddress,
      value: refund,
      label: `${p.id} cooperative refund`,
    })),
  };
}

export function buildFinalSweep({
  state,
  currentUtxo,
  participantId,
}: {
  state: VaultState;
  currentUtxo: LedgerUtxo;
  participantId: string;
}): LedgerTx {
  const participant = participantById(state, participantId);
  return {
    kind: 'final-sweep',
    input: currentUtxo.outpoint,
    inputCount: 1,
    inputValue: currentUtxo.value,
    keyPath: {
      type: 'single-party-key-path',
      personalXonlyPubkeys: [participant.personal.xonlyPubKeyHex],
      sigbashXonlyPubkeys: [],
    },
    outputs: [
      {
        address: participant.payoutAddress,
        value: currentUtxo.value,
        label: `${participant.id} final sweep`,
      },
    ],
  };
}

export function buildRecovery({
  state,
  currentUtxo,
  currentIds,
  vanishedId,
  blocksWaited,
}: {
  state: VaultState;
  currentUtxo: LedgerUtxo;
  currentIds: string[];
  vanishedId: string;
  blocksWaited: number;
}): LedgerTx {
  if (blocksWaited < RECOVERY_DELAY_BLOCKS) {
    throw new Error(`recovery locked for ${RECOVERY_DELAY_BLOCKS - blocksWaited} more blocks`);
  }
  const recipients = currentIds.map((id) => participantById(state, id));
  const recoverEach = asSats(
    Math.floor((currentUtxo.value - AMOUNTS.recoveryFee) / recipients.length),
  );
  const vault = state.vaults.get(roundId(currentIds));
  if (!vault) throw new Error(`missing vault for ${roundId(currentIds)}`);
  return {
    kind: 'timelocked-recovery',
    input: currentUtxo.outpoint,
    inputCount: 1,
    inputValue: currentUtxo.value,
    vanishedId,
    signerIds: currentIds.filter((id) => id !== vanishedId),
    recoveryLeaf: vault.tapscriptLeaves.find(
      (leaf): leaf is RecoveryTapLeaf => leaf.type === 'timelocked-recovery',
    ),
    outputs: recipients.map((p) => ({
      address: p.payoutAddress,
      value: recoverEach,
      label: `${p.id} recovered funds`,
    })),
  };
}

export function verifyNoSigbashInKeyPath(vault: VaultRound): boolean {
  return vault.keyPath.sigbashXonlyPubkeys.length === 0;
}

export function policyId(ids: string[], leaverId: string): string {
  return `${roundId(ids)}:${leaverId}`;
}

export function roundId(ids: string[]): string {
  return [...ids].sort().join('');
}

export function pairs(ids: string[]): string[][] {
  const result: string[][] = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      result.push([ids[i]!, ids[j]!]);
    }
  }
  return result;
}

export function participantById(state: VaultState, id: string): Participant {
  const participant = state.participants.find((p) => p.id === id);
  if (!participant) throw new Error(`unknown participant ${id}`);
  return participant;
}

function simulatedSignature(privateKeyHex: string, message: string): string {
  return hmacHex(privateKeyHex, message);
}
