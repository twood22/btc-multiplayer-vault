import { asSats, type Sats } from './types.js';
import { BITCOIN_NETWORK_NAME } from './network.js';

export const NETWORK = BITCOIN_NETWORK_NAME;

export const SATS_PER_BTC = 100_000_000;

export interface ParticipantConfig {
  id: string;
  label: string;
}

export const PARTICIPANTS: ParticipantConfig[] = [
  { id: 'alice', label: 'Alice' },
  { id: 'bob', label: 'Bob' },
  { id: 'carol', label: 'Carol' },
];

// Per-transaction fee budget enforced by the Sigbash policy floors below. A
// leaver chooses the actual fee, but the policy guarantees the leftover can be
// short of its ideal value by at most this many sats.
export const SOLO_FEE_BUDGET_SATS: Sats = asSats(10_000);

// Amounts remain configurable so a deliberately tiny mainnet run can use the
// same round-based payout schedule without changing transaction semantics.
// Set VAULT_DEPOSIT_SATS; the schedule scales with haircut = bonus = 5% of the
// deposit (first = deposit - haircut, second = deposit + haircut/2), which
// keeps first + second + second == 3 * deposit. The defaults are the spec's
// 1 BTC / 0.95 / 1.025 schedule.
const depositSats = Number(process.env.VAULT_DEPOSIT_SATS || 100_000_000);
if (!Number.isSafeInteger(depositSats) || depositSats < 1_000_000) {
  throw new Error('VAULT_DEPOSIT_SATS must be an integer >= 1,000,000 (0.01 BTC)');
}
const haircutSats = Math.round(depositSats * 0.05);

export const AMOUNTS = {
  deposit: asSats(depositSats),
  firstWithdrawal: asSats(depositSats - haircutSats),
  secondWithdrawal: asSats(depositSats + Math.floor(haircutSats / 2)),
  feePerSoloWithdrawal: asSats(Number(process.env.VAULT_SOLO_FEE_SATS || 1_000)),
  finalSweepFee: asSats(Number(process.env.VAULT_SOLO_FEE_SATS || 1_000)),
  cooperativeFee: asSats(Number(process.env.VAULT_COOP_FEE_SATS || 900)),
  recoveryFee: asSats(Number(process.env.VAULT_RECOVERY_FEE_SATS || 1_500)),
} satisfies Record<string, Sats>;

// Leftover floors are derived from the schedule so the maximum a malicious
// leaver can burn to fees is SOLO_FEE_BUDGET_SATS per withdrawal:
//   round one:  3.0 BTC in, 0.95 BTC out  -> leftover >= 2.0499 BTC
//   round two:  worst-case round-two vault (round-one floor) minus 1.025 BTC
//               payout minus one more fee budget
export const POLICY_FLOORS = {
  roundOneLeftover: asSats(
    AMOUNTS.deposit * PARTICIPANTS.length - AMOUNTS.firstWithdrawal - SOLO_FEE_BUDGET_SATS,
  ),
  roundTwoLeftover: asSats(
    AMOUNTS.deposit * PARTICIPANTS.length -
      AMOUNTS.firstWithdrawal -
      SOLO_FEE_BUDGET_SATS -
      AMOUNTS.secondWithdrawal -
      SOLO_FEE_BUDGET_SATS,
  ),
} satisfies Record<string, Sats>;

// The default remains the original prototype value for reproducible offline
// acceptance only. Mainnet deployment must explicitly choose and review a
// production delay before the release gate can pass.
export const RECOVERY_DELAY_BLOCKS = Number(process.env.RECOVERY_DELAY_BLOCKS || 6);

export const DEFAULT_DEMO_SEED = 'btc-multiplayer-vault-public-test-fixture';

export const DEMO_SEED = process.env.VAULT_DEMO_SEED || DEFAULT_DEMO_SEED;

// Anyone can derive every "private" key produced from the default seed. That
// is fine for offline demos and unit tests, and catastrophic for anything
// funded. Commands that talk to live Sigbash or prepare real spends call this.
export function assertNonDefaultSeed(): void {
  if (DEMO_SEED === DEFAULT_DEMO_SEED) {
    throw new Error(
      'VAULT_DEMO_SEED is the public default seed; every key derived from it is public knowledge. ' +
        'Set VAULT_DEMO_SEED to a strong random secret before running live-mode commands or funding anything.',
    );
  }
}
