import { asSats, type Sats, type VaultEconomics } from './types.js';
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

// Amounts remain configurable so a deliberately tiny mainnet run can use the
// exact same game. The immutable roster commits every value below; signers use
// that committed object, never ambient browser environment variables.
const depositSats = integerEnv('VAULT_DEPOSIT_SATS', 100_000_000);
const haircutSats = Math.round(depositSats * 0.05);
const soloFeeSats = integerEnv('VAULT_SOLO_FEE_SATS', depositSats < 1_000_000 ? 300 : 1_000);
const soloFeeBudgetSats = integerEnv(
  'VAULT_SOLO_FEE_BUDGET_SATS',
  Math.min(10_000, Math.floor(depositSats * 0.2)),
);

export const VAULT_ECONOMICS: VaultEconomics = validateVaultEconomics({
  depositSatsPerParticipant: asSats(depositSats),
  firstWithdrawalSats: asSats(depositSats - haircutSats),
  secondWithdrawalSats: asSats(depositSats + Math.floor(haircutSats / 2)),
  soloFeeBudgetSats: asSats(soloFeeBudgetSats),
  soloWithdrawalFeeSats: asSats(soloFeeSats),
  cooperativeFeeSats: asSats(integerEnv('VAULT_COOP_FEE_SATS', depositSats < 1_000_000 ? 300 : 900)),
  recoveryFeeSats: asSats(integerEnv('VAULT_RECOVERY_FEE_SATS', depositSats < 1_000_000 ? 500 : 1_500)),
  finalSweepFeeSats: asSats(integerEnv('VAULT_FINAL_SWEEP_FEE_SATS', soloFeeSats)),
  recoveryDelayBlocks: integerEnv('RECOVERY_DELAY_BLOCKS', 6),
});

// Compatibility names for CLI fixtures. Product paths use state.economics.
export const SOLO_FEE_BUDGET_SATS: Sats = VAULT_ECONOMICS.soloFeeBudgetSats;
export const AMOUNTS = {
  deposit: VAULT_ECONOMICS.depositSatsPerParticipant,
  firstWithdrawal: VAULT_ECONOMICS.firstWithdrawalSats,
  secondWithdrawal: VAULT_ECONOMICS.secondWithdrawalSats,
  feePerSoloWithdrawal: VAULT_ECONOMICS.soloWithdrawalFeeSats,
  finalSweepFee: VAULT_ECONOMICS.finalSweepFeeSats,
  cooperativeFee: VAULT_ECONOMICS.cooperativeFeeSats,
  recoveryFee: VAULT_ECONOMICS.recoveryFeeSats,
} satisfies Record<string, Sats>;

// Leftover floors are derived from the schedule so the maximum a malicious
// leaver can burn to fees is SOLO_FEE_BUDGET_SATS per withdrawal:
//   round one:  3.0 BTC in, 0.95 BTC out  -> leftover >= 2.0499 BTC
//   round two:  worst-case round-two vault (round-one floor) minus 1.025 BTC
//               payout minus one more fee budget
export const POLICY_FLOORS = {
  ...vaultPolicyFloors(VAULT_ECONOMICS),
} satisfies Record<string, Sats>;

// The default remains the original prototype value for reproducible offline
// acceptance only. Mainnet deployment must explicitly choose and review a
// production delay before the release gate can pass.
export const RECOVERY_DELAY_BLOCKS = VAULT_ECONOMICS.recoveryDelayBlocks;

export function vaultPolicyFloors(economics: VaultEconomics): {
  roundOneLeftover: Sats;
  roundTwoLeftover: Sats;
} {
  const validated = validateVaultEconomics(economics);
  return {
    roundOneLeftover: asSats(
      validated.depositSatsPerParticipant * PARTICIPANTS.length -
        validated.firstWithdrawalSats - validated.soloFeeBudgetSats,
    ),
    roundTwoLeftover: asSats(
      validated.depositSatsPerParticipant * PARTICIPANTS.length -
        validated.firstWithdrawalSats - validated.soloFeeBudgetSats -
        validated.secondWithdrawalSats - validated.soloFeeBudgetSats,
    ),
  };
}

export function validateVaultEconomics(input: VaultEconomics): VaultEconomics {
  const economics: VaultEconomics = {
    depositSatsPerParticipant: asSats(input.depositSatsPerParticipant),
    firstWithdrawalSats: asSats(input.firstWithdrawalSats),
    secondWithdrawalSats: asSats(input.secondWithdrawalSats),
    soloFeeBudgetSats: asSats(input.soloFeeBudgetSats),
    soloWithdrawalFeeSats: asSats(input.soloWithdrawalFeeSats),
    cooperativeFeeSats: asSats(input.cooperativeFeeSats),
    recoveryFeeSats: asSats(input.recoveryFeeSats),
    finalSweepFeeSats: asSats(input.finalSweepFeeSats),
    recoveryDelayBlocks: Number(input.recoveryDelayBlocks),
  };
  if (economics.depositSatsPerParticipant < 10_000) {
    throw new Error('vault deposit must be at least 10,000 sats per participant');
  }
  if (!Number.isSafeInteger(economics.recoveryDelayBlocks) || economics.recoveryDelayBlocks < 1) {
    throw new Error('recovery delay must be a positive integer number of blocks');
  }
  if (
    economics.firstWithdrawalSats + economics.secondWithdrawalSats * 2 !==
    economics.depositSatsPerParticipant * PARTICIPANTS.length
  ) {
    throw new Error('withdrawal schedule must conserve exactly three participant deposits');
  }
  for (const [name, value] of Object.entries({
    soloFeeBudgetSats: economics.soloFeeBudgetSats,
    soloWithdrawalFeeSats: economics.soloWithdrawalFeeSats,
    cooperativeFeeSats: economics.cooperativeFeeSats,
    recoveryFeeSats: economics.recoveryFeeSats,
    finalSweepFeeSats: economics.finalSweepFeeSats,
  })) {
    if (value <= 0) throw new Error(`${name} must be positive`);
  }
  const roundOneFloor = economics.depositSatsPerParticipant * 3 -
    economics.firstWithdrawalSats - economics.soloFeeBudgetSats;
  const roundTwoFloor = roundOneFloor - economics.secondWithdrawalSats -
    economics.soloFeeBudgetSats;
  if (roundTwoFloor < 330) throw new Error('economics leave a dust-sized final payout floor');
  if (economics.soloWithdrawalFeeSats > economics.soloFeeBudgetSats) {
    throw new Error('solo withdrawal fee exceeds the policy fee budget');
  }
  if (economics.soloWithdrawalFeeSats * 2 > economics.soloFeeBudgetSats) {
    throw new Error('pair-round solo fee exceeds the policy fee budget');
  }
  return economics;
}

function integerEnv(name: string, fallback: number): number {
  const raw = typeof process === 'undefined' ? undefined : process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

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
