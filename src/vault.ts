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
  deterministicKeypair,
  hmacHex,
  sha256Hex,
  taprootAddress,
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
 * Nested overrides: participantId -> roundId -> live leaf key. Either the
 * bare x-only pubkey hex, or an object carrying the key plus its BIP-328
 * xpub (as printed by sigbash-live-setup).
 */
export type SigbashLeafOverride = string | { key: string; xpub?: string };
export type SigbashLeafOverrides = Record<string, Record<string, SigbashLeafOverride> | undefined>;

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
      const overrideKey = typeof override === 'string' ? override : override?.key;
      const overrideXpub = typeof override === 'object' ? override.xpub : undefined;
      sigbashByRound[round] = {
        ...localShare,
        xonlyPubKeyHex: overrideKey || localShare.xonlyPubKeyHex,
        isLiveKey: Boolean(overrideKey),
        ...(overrideXpub ? { xpub: overrideXpub } : {}),
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

export function buildVaultTree(participants: Participant[]): Map<string, VaultRound> {
  const byIds = new Map(participants.map((p) => [p.id, p]));
  const allIds = participants.map((p) => p.id);
  const rounds = new Map<string, VaultRound>();

  for (const ids of [allIds, ...pairs(allIds)]) {
    const round = roundId(ids);
    const current = ids.map((id) => {
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
      descriptor: `tr(musig(${current
        .map((p) => p.personal.publicKeyHex)
        .join(',')}),{${current
        .map((p) => `pk(${sigbashRoundKey(p, round).xonlyPubKeyHex})`)
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
        // Descriptor-mode REQKEY: proven on live Sigbash signet to satisfy the
        // "signer key in required signer universe" clause when the tapscript
        // leaf contains the xpub's child 0/0 key. The local model checks the
        // equivalent round-scoped leaf key via local_key_identifier, which is
        // stripped before the policy is sent to Sigbash.
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
