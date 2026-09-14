import { validateVaultEconomics, validateVaultEconomicsAmounts } from '../config.js';
import { asSats, type VaultEconomics } from '../types.js';
import { assert, exactKeys, safeInteger } from './validation.js';

export const LAST_SURVIVOR_PAYOUT_SCHEDULE = 'last-survivor-net-v1' as const;

/** Absence means the original v2 schedule, never an invitation to migrate it. */
export interface PresignedEconomics extends VaultEconomics {
  payoutSchedule?: typeof LAST_SURVIVOR_PAYOUT_SCHEDULE;
}

type EconomicsParameters = Omit<VaultEconomics, 'firstWithdrawalSats' | 'secondWithdrawalSats'>;
const AMOUNT_KEYS = ['depositSatsPerParticipant', 'firstWithdrawalSats', 'secondWithdrawalSats',
  'soloFeeBudgetSats', 'soloWithdrawalFeeSats', 'cooperativeFeeSats', 'recoveryFeeSats',
  'finalSweepFeeSats', 'recoveryDelayBlocks'];

/** Reserve both graph fees (F + 2F) and the final sweep before a 19:20:21 split. */
function lastSurvivorAmounts(input: EconomicsParameters) {
  safeInteger(input.depositSatsPerParticipant, 10_000, 700_000_000_000_000, 'deposit');
  const total = BigInt(input.depositSatsPerParticipant) * 3n;
  const baseFees = BigInt(asSats(input.soloWithdrawalFeeSats)) * 3n + BigInt(asSats(input.finalSweepFeeSats));
  assert(total > baseFees, 'base exit and sweep fees consume the vault');
  const distributable = total - baseFees;
  // Integer arithmetic is exact even at the Bitcoin monetary limit. Rounding
  // dust belongs to the last participant, never to an unaccounted extra fee.
  const first = distributable * 19n / 60n;
  const second = distributable * 20n / 60n;
  const last = distributable - first - second;
  assert(first >= 330n && second > first && last > second, 'payouts must be non-dust and strictly increase after base fees');
  return { firstWithdrawalSats: asSats(first), secondWithdrawalSats: asSats(second),
    finalWithdrawalSats: asSats(last) };
}

/** For NEW ceremonies only. Never pass an existing roster through this builder. */
export function createLastSurvivorEconomics(input: EconomicsParameters): PresignedEconomics {
  const amounts = lastSurvivorAmounts(input);
  return validatePresignedEconomics({
    payoutSchedule: LAST_SURVIVOR_PAYOUT_SCHEDULE,
    depositSatsPerParticipant: input.depositSatsPerParticipant,
    firstWithdrawalSats: amounts.firstWithdrawalSats,
    secondWithdrawalSats: amounts.secondWithdrawalSats,
    soloFeeBudgetSats: input.soloFeeBudgetSats,
    soloWithdrawalFeeSats: input.soloWithdrawalFeeSats,
    cooperativeFeeSats: input.cooperativeFeeSats,
    recoveryFeeSats: input.recoveryFeeSats,
    finalSweepFeeSats: input.finalSweepFeeSats,
    recoveryDelayBlocks: input.recoveryDelayBlocks,
  });
}

export function validatePresignedEconomics(input: PresignedEconomics): PresignedEconomics {
  assert(input !== null && typeof input === 'object' && !Array.isArray(input), 'invalid economics');
  const versioned = Object.hasOwn(input, 'payoutSchedule');
  exactKeys(input, [...AMOUNT_KEYS, ...(versioned ? ['payoutSchedule'] : [])], 'economics');
  safeInteger(input.depositSatsPerParticipant, 10_000, 700_000_000_000_000, 'deposit');
  if (versioned) {
    assert(input.payoutSchedule === LAST_SURVIVOR_PAYOUT_SCHEDULE, 'unknown payout schedule');
    const economics = validateVaultEconomicsAmounts(input);
    const expected = lastSurvivorAmounts(economics);
    assert(economics.firstWithdrawalSats === expected.firstWithdrawalSats &&
      economics.secondWithdrawalSats === expected.secondWithdrawalSats, 'last-survivor payout amounts changed');
    return { ...economics, payoutSchedule: LAST_SURVIVOR_PAYOUT_SCHEDULE };
  }
  // Preserve canonical bytes, amounts and graph digests for old backups and
  // funded vaults. Old clients reject the new field instead of misreading it.
  const economics = validateVaultEconomics(input);
  const haircut = Math.round(economics.depositSatsPerParticipant * 0.05);
  assert(economics.firstWithdrawalSats === economics.depositSatsPerParticipant - haircut &&
    economics.secondWithdrawalSats === economics.depositSatsPerParticipant + Math.floor(haircut / 2), 'withdrawal proportions changed');
  assert(economics.depositSatsPerParticipant * 3 - economics.firstWithdrawalSats -
    economics.secondWithdrawalSats - economics.soloWithdrawalFeeSats * 3 >= 330, 'dust final payout');
  return economics;
}
