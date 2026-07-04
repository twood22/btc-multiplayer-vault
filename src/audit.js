import { AMOUNTS, PARTICIPANTS, POLICY_FLOORS, RECOVERY_DELAY_BLOCKS, SOLO_FEE_BUDGET_SATS } from './config.js';
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
    check('all cooperative key-paths use standard BIP-327 KeyAgg', allKeyPathsUseBip327(state)),
    check('every vault has a timelocked recovery leaf', allVaultsHaveRecoveryLeaf(state)),
    check('recovery leaves require participant key threshold', allRecoveryLeavesRequireThreshold(state)),
    check('one immutable Sigbash policy exists per (round, leaver)', state.policies.size === 9),
    check('no policy is an OR across rounds', noOrPolicies(state)),
    check('Sigbash leaf keys are unique per (participant, round)', leafKeysAreRoundScoped(state)),
    check('all solo policies pin exactly two outputs', allBranchesPinOutputCount(state)),
    check('all solo policies pin exactly one input', allBranchesPinInputCount(state)),
    check('all solo policies carry a descriptor-mode REQKEY', allBranchesRequireLeafKey(state)),
    check('round-one policies pin leftover to round-two vaults', roundOneLeftoversAreRevaulted(state)),
    check('round-two policies pin leftover to final participant payout address', roundTwoLeftoversGoToLastParticipant(state)),
    check('leftover floors bound the fee burn to the configured budget', leftoverFloorsBoundFeeBurn()),
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

function allKeyPathsUseBip327(state) {
  return [...state.vaults.values()].every((vault) => {
    const aggregation = vault.keyPath.aggregation;
    return (
      aggregation?.type === 'BIP327-KeyAgg' &&
      aggregation.compressedPubkeys?.length === vault.participantIds.length &&
      aggregation.coefficients?.length === vault.participantIds.length
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

function noOrPolicies(state) {
  return [...state.policies.values()].every((policy) => policy.logic === 'AND');
}

function leafKeysAreRoundScoped(state) {
  const seen = new Set();
  for (const participant of state.participants) {
    for (const [round, key] of Object.entries(participant.sigbashByRound)) {
      if (seen.has(key.xonlyPubKeyHex)) return false;
      seen.add(key.xonlyPubKeyHex);
      const vault = state.vaults.get(round);
      const leaf = vault?.tapscriptLeaves.find(
        (item) => item.type === 'solo-withdrawal' && item.participantId === participant.id,
      );
      if (!leaf || leaf.sigbashXonlyPubkey !== key.xonlyPubKeyHex) return false;
    }
  }
  return true;
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

function allBranchesPinInputCount(state) {
  return [...state.policies.values()].every((policy) =>
    policy.conditions.some(
      (condition) =>
        condition.type === 'TX_INPUT_COUNT' &&
        condition.operator === 'EQ' &&
        condition.value === 1,
    ),
  );
}

function allBranchesRequireLeafKey(state) {
  return [...state.policies.values()].every((policy) => {
    const participant = state.participants.find((item) => item.id === policy.leaverId);
    const roundKey = participant?.sigbashByRound[roundId(policy.roundIds)];
    return policy.conditions.some(
      (condition) =>
        condition.type === 'REQKEY' &&
        condition.key_type === 'TAP_LEAF_XONLY_PUBKEY' &&
        condition.use_descriptor === true &&
        condition.descriptor_template === 'tr(SIGBASH_XPUB/0/*)' &&
        condition.local_key_identifier === roundKey?.xonlyPubKeyHex,
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

function leftoverFloorsBoundFeeBurn() {
  const potAfterFirst = 300_000_000 - AMOUNTS.firstWithdrawal;
  const worstRoundTwoPot = POLICY_FLOORS.roundOneLeftover;
  return (
    potAfterFirst - POLICY_FLOORS.roundOneLeftover === SOLO_FEE_BUDGET_SATS &&
    worstRoundTwoPot - AMOUNTS.secondWithdrawal - POLICY_FLOORS.roundTwoLeftover ===
      SOLO_FEE_BUDGET_SATS
  );
}

function sameSet(left, right) {
  return left.length === right.length && left.every((item) => right.includes(item));
}
