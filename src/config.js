export const NETWORK = 'signet';

export const SATS_PER_BTC = 100_000_000;

export const PARTICIPANTS = [
  { id: 'alice', label: 'Alice' },
  { id: 'bob', label: 'Bob' },
  { id: 'carol', label: 'Carol' },
];

export const AMOUNTS = {
  deposit: 100_000_000,
  firstWithdrawal: 95_000_000,
  secondWithdrawal: 102_500_000,
  feePerSoloWithdrawal: 1_000,
  finalSweepFee: 1_000,
  cooperativeFee: 0,
  recoveryFee: 1_500,
};

export const POLICY_FLOORS = {
  roundOneLeftover: 204_000_000,
  roundTwoLeftover: 102_000_000,
};

export const RECOVERY_DELAY_BLOCKS = 6;

export const DEMO_SEED =
  process.env.VAULT_DEMO_SEED || 'btc-multiplayer-vault-signet-demo';
