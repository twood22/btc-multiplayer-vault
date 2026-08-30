import { NETWORK, PARTICIPANTS, vaultPolicyFloors } from './config.js';
import { policyId, roundId, verifyNoSigbashInKeyPath } from './vault.js';
import type { SoloPolicy, VaultState } from './types.js';

export interface AuditCheck {
  name: string;
  ok: boolean;
  details?: unknown;
}

export interface AuditReport {
  passed: boolean;
  checks: AuditCheck[];
}

export function auditSpecState(state: VaultState): AuditReport {
  const checks = [
    check('exactly 3 participants', state.participants.length === 3),
    check(
      'participants are Alice, Bob, Carol',
      sameSet(
        state.participants.map((participant) => participant.id),
        PARTICIPANTS.map((participant) => participant.id),
      ),
    ),
    check('participant deposit is above the tiny-vault floor', state.economics.depositSatsPerParticipant >= 10_000),
    check('first withdrawal is the committed haircut amount', state.economics.firstWithdrawalSats < state.economics.depositSatsPerParticipant),
    check('second withdrawal is the committed bonus amount', state.economics.secondWithdrawalSats > state.economics.depositSatsPerParticipant),
    check(
      'configured payout schedule conserves exactly three deposits',
      payoutScheduleTotal(state) === state.economics.depositSatsPerParticipant * 3,
    ),
    check('precomputed vault tree has 1 round-one and 3 round-two vaults', state.vaults.size === 4),
    check(`all payout and vault addresses are ${NETWORK} taproot addresses`, allAddressesAreConfiguredTaproot(state)),
    check(`all solo policies and destination conditions declare ${NETWORK}`, allPoliciesUseConfiguredNetwork(state)),
    check('all vault scriptPubKeys are v1 P2TR outputs', allVaultScriptsAreP2tr(state)),
    check('all cooperative key-paths exclude Sigbash keys', allKeyPathsExcludeSigbash(state)),
    check('all cooperative key-paths use standard BIP-327 KeyAgg', allKeyPathsUseBip327(state)),
    check('every vault has a timelocked recovery leaf', allVaultsHaveRecoveryLeaf(state)),
    check('recovery leaves require participant key threshold', allRecoveryLeavesRequireThreshold(state)),
    check('one immutable Sigbash policy exists per (round, leaver)', state.policies.size === 9),
    check('no policy is an OR across rounds', noOrPolicies(state)),
    check('Sigbash leaf keys are unique per (participant, round)', leafKeysAreRoundScoped(state)),
    check(
      'every participant/round pairs a policy-spend leaf with a distinct identification leaf',
      dualLeavesArePairedAndDistinct(state),
    ),
    check(
      'identification leaf keys never satisfy any policy REQKEY',
      identificationKeysNeverSatisfyReqkey(state),
    ),
    check('all solo policies pin exactly two outputs', allBranchesPinOutputCount(state)),
    check('all solo policies pin exactly one input', allBranchesPinInputCount(state)),
    check('all solo policies pin the round leaf key via REQKEY', allBranchesRequireLeafKey(state)),
    check('round-one policies pin leftover to round-two vaults', roundOneLeftoversAreRevaulted(state)),
    check('round-two policies pin leftover to final participant payout address', roundTwoLeftoversGoToLastParticipant(state)),
    check('leftover floors bound the fee burn to the configured budget', leftoverFloorsBoundFeeBurn(state)),
  ];
  return {
    passed: checks.every((item) => item.ok),
    checks,
  };
}

function check(name: string, ok: boolean, details?: unknown): AuditCheck {
  return { name, ok, ...(details === undefined ? {} : { details }) };
}

function payoutScheduleTotal(state: VaultState): number {
  return state.economics.firstWithdrawalSats + state.economics.secondWithdrawalSats * 2;
}

function allAddressesAreConfiguredTaproot(state: VaultState): boolean {
  const prefix = NETWORK === 'mainnet' ? 'bc1p' : 'tb1p';
  return (
    state.participants.every((participant) => participant.payoutAddress.startsWith(prefix)) &&
    [...state.vaults.values()].every((vault) => vault.address.startsWith(prefix))
  );
}

function allPoliciesUseConfiguredNetwork(state: VaultState): boolean {
  return [...state.policies.values()].every(
    (policy) =>
      policy.network === NETWORK &&
      policy.conditions
        .filter((condition) => condition.type === 'OUTPUT_DEST_IS_IN_SETS')
        .every((condition) => condition.network === NETWORK),
  );
}

function allVaultScriptsAreP2tr(state: VaultState): boolean {
  return [...state.vaults.values()].every(
    (vault) => /^5120[0-9a-f]{64}$/.test(vault.outputScriptHex),
  );
}

function allKeyPathsExcludeSigbash(state: VaultState): boolean {
  return [...state.vaults.values()].every((vault) => verifyNoSigbashInKeyPath(vault));
}

function allKeyPathsUseBip327(state: VaultState): boolean {
  return [...state.vaults.values()].every((vault) => {
    const aggregation = vault.keyPath.aggregation;
    return (
      aggregation?.type === 'BIP327-KeyAgg' &&
      aggregation.compressedPubkeys?.length === vault.participantIds.length &&
      aggregation.coefficients?.length === vault.participantIds.length
    );
  });
}

function allVaultsHaveRecoveryLeaf(state: VaultState): boolean {
  return [...state.vaults.values()].every((vault) =>
    vault.tapscriptLeaves.some(
      (leaf) =>
        leaf.type === 'timelocked-recovery' &&
        leaf.relativeBlocks === state.economics.recoveryDelayBlocks,
    ),
  );
}

function allRecoveryLeavesRequireThreshold(state: VaultState): boolean {
  return [...state.vaults.values()].every((vault) => {
    const leaf = vault.tapscriptLeaves.find((item) => item.type === 'timelocked-recovery');
    return (
      leaf?.type === 'timelocked-recovery' &&
      leaf.threshold === Math.max(1, vault.participantIds.length - 1) &&
      leaf.recoveryXonlyPubkeys?.length === vault.participantIds.length &&
      !leaf.scriptHex.endsWith('51')
    );
  });
}

function noOrPolicies(state: VaultState): boolean {
  return [...state.policies.values()].every((policy) => policy.logic === 'AND');
}

function leafKeysAreRoundScoped(state: VaultState): boolean {
  const seen = new Set<string>();
  for (const participant of state.participants) {
    for (const [round, key] of Object.entries(participant.sigbashByRound)) {
      // Policy and identification keys share one uniqueness universe: no key
      // may appear twice in any role, in any round.
      if (seen.has(key.xonlyPubKeyHex)) return false;
      seen.add(key.xonlyPubKeyHex);
      if (seen.has(key.identificationXonlyPubKeyHex)) return false;
      seen.add(key.identificationXonlyPubKeyHex);
      const vault = state.vaults.get(round);
      const leaf = vault?.tapscriptLeaves.find(
        (item) => item.type === 'solo-withdrawal' && item.participantId === participant.id,
      );
      if (
        leaf?.type !== 'solo-withdrawal' ||
        leaf.sigbashXonlyPubkey !== key.xonlyPubKeyHex
      ) {
        return false;
      }
    }
  }
  return true;
}

// Each participant in each round vault has exactly one policy-spend leaf and
// exactly one identification leaf, with distinct scripts/keys, and both match
// that participant's round key material. The `role` fields must be present so
// callers can never confuse the two.
function dualLeavesArePairedAndDistinct(state: VaultState): boolean {
  for (const vault of state.vaults.values()) {
    for (const participantId of vault.participantIds) {
      const participant = state.participants.find((item) => item.id === participantId);
      const roundKey = participant?.sigbashByRound[vault.id];
      if (!roundKey) return false;
      const policyLeaves = vault.tapscriptLeaves.filter(
        (item) => item.type === 'solo-withdrawal' && item.participantId === participantId,
      );
      const identificationLeaves = vault.tapscriptLeaves.filter(
        (item) => item.type === 'sigbash-identification' && item.participantId === participantId,
      );
      if (policyLeaves.length !== 1 || identificationLeaves.length !== 1) return false;
      const policyLeaf = policyLeaves[0]!;
      const identificationLeaf = identificationLeaves[0]!;
      if (policyLeaf.type !== 'solo-withdrawal') return false;
      if (identificationLeaf.type !== 'sigbash-identification') return false;
      if (policyLeaf.role !== 'policy-spend') return false;
      if (identificationLeaf.role !== 'identification-only') return false;
      if (policyLeaf.sigbashXonlyPubkey !== roundKey.xonlyPubKeyHex) return false;
      if (identificationLeaf.internalRootXonlyPubkey !== roundKey.identificationXonlyPubKeyHex) {
        return false;
      }
      if (identificationLeaf.scriptHex === policyLeaf.scriptHex) return false;
      if (identificationLeaf.internalRootXonlyPubkey === policyLeaf.sigbashXonlyPubkey) {
        return false;
      }
    }
  }
  return true;
}

// No REQKEY anywhere may reference an identification-leaf key: the
// identification leaf must carry zero policy authority.
function identificationKeysNeverSatisfyReqkey(state: VaultState): boolean {
  const identificationKeys = new Set(
    state.participants.flatMap((participant) =>
      Object.values(participant.sigbashByRound).map((key) => key.identificationXonlyPubKeyHex),
    ),
  );
  return [...state.policies.values()].every((policy) =>
    policy.conditions.every(
      (condition) =>
        condition.type !== 'REQKEY' || !identificationKeys.has(condition.local_key_identifier),
    ),
  );
}

function allBranchesPinOutputCount(state: VaultState): boolean {
  return [...state.policies.values()].every((policy) =>
    policy.conditions.some(
      (condition) =>
        condition.type === 'TX_OUTPUT_COUNT' &&
        condition.operator === 'EQ' &&
        condition.value === 2,
    ),
  );
}

function allBranchesPinInputCount(state: VaultState): boolean {
  return [...state.policies.values()].every((policy) =>
    policy.conditions.some(
      (condition) =>
        condition.type === 'TX_INPUT_COUNT' &&
        condition.operator === 'EQ' &&
        condition.value === 1,
    ),
  );
}

function allBranchesRequireLeafKey(state: VaultState): boolean {
  return [...state.policies.values()].every((policy) => {
    const participant = state.participants.find((item) => item.id === policy.leaverId);
    const roundKey = participant?.sigbashByRound[roundId(policy.roundIds)];
    return policy.conditions.some(
      (condition) =>
        condition.type === 'REQKEY' &&
        condition.key_type === 'TAP_LEAF_XONLY_PUBKEY' &&
        condition.use_descriptor === true &&
        condition.local_key_identifier === roundKey?.xonlyPubKeyHex,
    );
  });
}

function roundOneLeftoversAreRevaulted(state: VaultState): boolean {
  const allIds = state.participants.map((participant) => participant.id);
  return state.participants.every((leaver) => {
    const remainingIds = allIds.filter((id) => id !== leaver.id);
    const policy = state.policies.get(policyId(allIds, leaver.id));
    const nextVault = state.vaults.get(roundId(remainingIds));
    return Boolean(nextVault) && pinsOutputOneAddress(policy, nextVault!.address);
  });
}

function roundTwoLeftoversGoToLastParticipant(state: VaultState): boolean {
  const ids = state.participants.map((participant) => participant.id);
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const pair = [ids[i]!, ids[j]!];
      for (const leaverId of pair) {
        const remainingId = pair.find((id) => id !== leaverId);
        const remaining = state.participants.find((participant) => participant.id === remainingId);
        const policy = state.policies.get(policyId(pair, leaverId));
        if (!remaining || !pinsOutputOneAddress(policy, remaining.payoutAddress)) return false;
      }
    }
  }
  return true;
}

function pinsOutputOneAddress(policy: SoloPolicy | undefined, address: string): boolean {
  return Boolean(
    policy?.conditions.some(
      (condition) =>
        condition.type === 'OUTPUT_DEST_IS_IN_SETS' &&
        condition.selector.index === 1 &&
        condition.addresses.includes(address),
    ),
  );
}

function leftoverFloorsBoundFeeBurn(state: VaultState): boolean {
  const policyFloors = vaultPolicyFloors(state.economics);
  const potAfterFirst = state.economics.depositSatsPerParticipant * 3 -
    state.economics.firstWithdrawalSats;
  const worstRoundTwoPot = policyFloors.roundOneLeftover;
  return (
    potAfterFirst - policyFloors.roundOneLeftover === state.economics.soloFeeBudgetSats &&
    worstRoundTwoPot - state.economics.secondWithdrawalSats - policyFloors.roundTwoLeftover ===
      state.economics.soloFeeBudgetSats
  );
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}
