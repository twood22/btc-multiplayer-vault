import { AMOUNTS, PARTICIPANTS, POLICY_FLOORS, RECOVERY_DELAY_BLOCKS } from './config.js';
import { policyId, roundId, verifyNoSigbashInKeyPath } from './vault.js';

export function auditSpecState(state) {
  const checks = [
    check('exactly 3 participants', state.participants.length === 3),
    check(
      'participants are Alice, Bob, Carol',
      sameSet(
        state.participants.map((participant) => participant.id),
        PARTICIPANTS.map((participant) => participant.id),
      ),
    ),
    check('deposit amount is 1 BTC', AMOUNTS.deposit === 100_000_000),
    check('first withdrawal amount is 0.95 BTC', AMOUNTS.firstWithdrawal === 95_000_000),
    check('second withdrawal amount is 1.025 BTC', AMOUNTS.secondWithdrawal === 102_500_000),
    check('configured payout schedule sums to 3 BTC', payoutScheduleTotal() === 300_000_000),
    check('precomputed vault tree has 1 round-one and 3 round-two vaults', state.vaults.size === 4),
    check('all vault addresses are signet taproot addresses', allVaultAddressesAreSignetTaproot(state)),
    check('all vault scriptPubKeys are v1 P2TR outputs', allVaultScriptsAreP2tr(state)),
    check('all cooperative key-paths exclude Sigbash keys', allKeyPathsExcludeSigbash(state)),
    check('all cooperative key-paths use coefficient-weighted aggregation', allKeyPathsUseWeightedAggregation(state)),
    check('every vault has a timelocked recovery leaf', allVaultsHaveRecoveryLeaf(state)),
    check('recovery leaves require participant key threshold', allRecoveryLeavesRequireThreshold(state)),
    check('one Sigbash policy exists per participant', state.sigbashPolicies.size === 3),
    check('all participant Sigbash policies are OR-composed branch policies', allParticipantPoliciesAreOrs(state)),
    check('all solo policy branches pin exactly two outputs', allBranchesPinOutputCount(state)),
    check('all solo policy branches require the participant tapscript key', allBranchesRequireLeafKey(state)),
    check('round-one policies pin leftover to round-two vaults', roundOneLeftoversAreRevaulted(state)),
    check('round-two policies pin leftover to final participant payout address', roundTwoLeftoversGoToLastParticipant(state)),
    check('leftover floors leave fee room', leftoverFloorsLeaveFeeRoom()),
  ];
  return {
    passed: checks.every((item) => item.ok),
    checks,
  };
}

function check(name, ok, details = undefined) {
  return { name, ok, ...(details === undefined ? {} : { details }) };
}

function payoutScheduleTotal() {
  return AMOUNTS.firstWithdrawal + AMOUNTS.secondWithdrawal + AMOUNTS.secondWithdrawal;
}

function allVaultAddressesAreSignetTaproot(state) {
  return [...state.vaults.values()].every((vault) => vault.address.startsWith('tb1p'));
}

function allVaultScriptsAreP2tr(state) {
  return [...state.vaults.values()].every(
    (vault) => /^5120[0-9a-f]{64}$/.test(vault.outputScriptHex),
  );
}

function allKeyPathsExcludeSigbash(state) {
  return [...state.vaults.values()].every((vault) => verifyNoSigbashInKeyPath(vault));
}

function allKeyPathsUseWeightedAggregation(state) {
  return [...state.vaults.values()].every((vault) => {
    const aggregation = vault.keyPath.aggregation;
    return (
      aggregation?.type === 'BIP327-keyagg' &&
      aggregation.sortedXonlyPubkeys?.length === vault.participantIds.length &&
      aggregation.secondUniqueXonlyPubkey !== null &&
      /^[0-9a-f]{64}$/.test(aggregation.keyAggListHash)
    );
  });
}

function allVaultsHaveRecoveryLeaf(state) {
  return [...state.vaults.values()].every((vault) =>
    vault.tapscriptLeaves.some(
      (leaf) =>
        leaf.type === 'timelocked-recovery' && leaf.relativeBlocks === RECOVERY_DELAY_BLOCKS,
    ),
  );
}

function allRecoveryLeavesRequireThreshold(state) {
  return [...state.vaults.values()].every((vault) => {
    const leaf = vault.tapscriptLeaves.find((item) => item.type === 'timelocked-recovery');
    return (
      leaf &&
      leaf.threshold === Math.max(1, vault.participantIds.length - 1) &&
      leaf.recoveryXonlyPubkeys?.length === vault.participantIds.length &&
      !leaf.scriptHex.endsWith('51')
    );
  });
}

function allParticipantPoliciesAreOrs(state) {
  return state.participants.every((participant) => {
    const policy = state.sigbashPolicies.get(participant.id);
    return (
      policy?.logic === 'OR' &&
      policy.conditions.length === 3 &&
      policy.conditions.every((branch) => branch.logic === 'AND')
    );
  });
}

function allBranchesPinOutputCount(state) {
  return [...state.policies.values()].every((policy) =>
    policy.conditions.some(
      (condition) =>
        condition.type === 'TX_OUTPUT_COUNT' &&
        condition.operator === 'EQ' &&
        condition.value === 2,
    ),
  );
}

function allBranchesRequireLeafKey(state) {
  return [...state.policies.values()].every((policy) => {
    const participant = state.participants.find((item) => item.id === policy.leaverId);
    return policy.conditions.some(
      (condition) =>
        condition.type === 'REQKEY' &&
        condition.key_type === 'TAP_LEAF_XONLY_PUBKEY' &&
        condition.key_identifier === participant.sigbash.xonlyPubKeyHex,
    );
  });
}

function roundOneLeftoversAreRevaulted(state) {
  const allIds = state.participants.map((participant) => participant.id);
  return state.participants.every((leaver) => {
    const remainingIds = allIds.filter((id) => id !== leaver.id);
    const policy = state.policies.get(policyId(allIds, leaver.id));
    const nextVault = state.vaults.get(roundId(remainingIds));
    return pinsOutputOneAddress(policy, nextVault.address);
  });
}

function roundTwoLeftoversGoToLastParticipant(state) {
  const ids = state.participants.map((participant) => participant.id);
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const pair = [ids[i], ids[j]];
      for (const leaverId of pair) {
        const remainingId = pair.find((id) => id !== leaverId);
        const remaining = state.participants.find((participant) => participant.id === remainingId);
        const policy = state.policies.get(policyId(pair, leaverId));
        if (!pinsOutputOneAddress(policy, remaining.payoutAddress)) return false;
      }
    }
  }
  return true;
}

function pinsOutputOneAddress(policy, address) {
  return policy?.conditions.some(
    (condition) =>
      condition.type === 'OUTPUT_DEST_IS_IN_SETS' &&
      condition.selector.index === 1 &&
      condition.addresses.includes(address),
  );
}

function leftoverFloorsLeaveFeeRoom() {
  return (
    POLICY_FLOORS.roundOneLeftover < 300_000_000 - AMOUNTS.firstWithdrawal &&
    POLICY_FLOORS.roundTwoLeftover < 205_000_000 - AMOUNTS.secondWithdrawal
  );
}

function sameSet(left, right) {
  return left.length === right.length && left.every((item) => right.includes(item));
}
