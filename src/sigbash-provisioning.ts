import { sigbashConditionConfig } from './sigbash-policy.js';
import type { SoloPolicy } from './types.js';
import {
  createRosterState,
  participantLeaveRounds,
  roundId,
  type RosterEntry,
} from './vault.js';

export interface SigbashProvisioningPlanStep {
  round: string;
  keyIndex: number;
  policyId: string;
  policy: SoloPolicy;
  conditionConfig: unknown;
}

export interface SigbashProvisioningPlan {
  completedRounds: string[];
  totalPairRegistrations: number;
  next: SigbashProvisioningPlanStep | null;
  waitingFor: string[];
}

/**
 * Preserve the original multiplayer game dependency graph. Pair-round keys
 * are independent and come first; a round-one policy is compiled only after
 * all six pair registrations make its surviving-vault destination final.
 */
export function planSigbashProvisioning(
  roster: RosterEntry[],
  participantId: string,
): SigbashProvisioningPlan {
  const expectedIds = ['alice', 'bob', 'carol'];
  const ids = roster.map((entry) => entry.id).sort();
  if (ids.join(',') !== expectedIds.join(',')) {
    throw new Error('Sigbash provisioning requires exactly the alice, bob, and carol seats');
  }
  const participant = roster.find((entry) => entry.id === participantId);
  if (!participant) throw new Error('participant is not in the canonical roster');

  const allRounds = participantLeaveRounds(participantId, expectedIds);
  const roundOne = roundId(expectedIds);
  const registrations = participant.sigbashRegistrationByRound || {};
  const completedRounds = allRounds.filter((round) => registrations[round] !== undefined);
  const pairRounds = allRounds.filter((round) => round !== roundOne);
  const missingPairRound = pairRounds.find((round) => !completedRounds.includes(round));
  const totalPairRegistrations = roster.reduce((total, entry) => {
    const entryRegistrations = entry.sigbashRegistrationByRound || {};
    return total + participantLeaveRounds(entry.id, expectedIds)
      .filter((round) => round !== roundOne && entryRegistrations[round] !== undefined)
      .length;
  }, 0);

  const waitingFor: string[] = [];
  let nextRound: string | null = missingPairRound ?? null;
  if (!nextRound && !completedRounds.includes(roundOne)) {
    if (totalPairRegistrations === 6) nextRound = roundOne;
    else waitingFor.push(`${6 - totalPairRegistrations} pair-round Sigbash key(s) are still missing`);
  }
  if (!nextRound) return { completedRounds, totalPairRegistrations, next: null, waitingFor };

  const state = createRosterState(roster);
  const policy = state.policies.get(`${nextRound}:${participantId}`);
  if (!policy) throw new Error(`canonical Sigbash policy ${nextRound} is missing`);
  return {
    completedRounds,
    totalPairRegistrations,
    waitingFor,
    next: {
      round: nextRound,
      keyIndex: allRounds.indexOf(nextRound),
      policyId: policy.id,
      policy,
      conditionConfig: sigbashConditionConfig(policy),
    },
  };
}
