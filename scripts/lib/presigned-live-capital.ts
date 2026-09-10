/** Versioned isolated-test transport only. Product graph economics are unchanged. */
import assert from 'node:assert/strict';

export const LIVE_CAPITAL_EXECUTION = 'bounded-sequential-recycling-v2' as const;
export const LIVE_FUNDING_INPUT_SATS = 12_000;
export const LIVE_SPONSOR_SATS = 15_000;
export const LIVE_FIXED_CONFIRMED_FEES_SATS = 47_000;
export const RECYCLING_FEE_CAP = 338;
export const RECYCLING_FEE_RATE_MILLISATS = 300;
export const LIVE_REGTEST_CAPITAL_SATS = 89_000;

/** Ceiling in integer millisatoshis; never silently round a required fee down. */
export function recyclingFeeForVsize(vsize: number): number {
  assert(Number.isSafeInteger(vsize) && vsize > 0 && vsize <= 100_000, 'invalid isolated allocation size');
  return Number((BigInt(vsize) * BigInt(RECYCLING_FEE_RATE_MILLISATS) + 999n) / 1000n);
}

/** Every case is independently funded from the complete predecessor's leaves.
 * These envelopes reserve the maximum fee for EVERY preceding allocation, not
 * an average observed fee. 3000->4000 fee children, every graph fee, 10k deposits,
 * 9500/10250 withdrawals and CSV12 remain exactly as in the previous profile. */
export function sequentialCapitalEnvelopes() {
  let previousFixedFeesSats = 0;
  const cases = Array.from({ length: 19 }, (_, index) => {
    const sponsorCount = index === 0 ? 3 : index === 6 || index === 10 ? 1 : 0;
    const graphFeesSats = index < 6 ? 1800 : index < 10 ? index === 6 ? 900 : 1200 : index < 13 ? 1100 : 1400;
    const currentTargetsSats = 3 * LIVE_FUNDING_INPUT_SATS + sponsorCount * LIVE_SPONSOR_SATS;
    const allocationCount = index + 1;
    const envelope = { id: `case-${String(index).padStart(2, '0')}`, allocationCount, previousFixedFeesSats,
      currentTargetsSats, minimumSeedSats: previousFixedFeesSats + allocationCount * RECYCLING_FEE_CAP + currentTargetsSats + 330 };
    previousFixedFeesSats += graphFeesSats + sponsorCount * 4000;
    return envelope;
  });
  assert.equal(previousFixedFeesSats, LIVE_FIXED_CONFIRMED_FEES_SATS);
  return [...cases, { id: 'return', allocationCount: 20, previousFixedFeesSats, currentTargetsSats: 0,
    minimumSeedSats: previousFixedFeesSats + 20 * RECYCLING_FEE_CAP + 330 }];
}

export const MINIMUM_SEQUENTIAL_CAPITAL = Math.max(...sequentialCapitalEnvelopes().map(item => item.minimumSeedSats));
assert.equal(MINIMUM_SEQUENTIAL_CAPITAL, 88_352, 'review the entire capital envelope before changing this profile');
export const LIVE_MAXIMUM_CONFIRMED_FEES_SATS = LIVE_FIXED_CONFIRMED_FEES_SATS + 20 * RECYCLING_FEE_CAP;
