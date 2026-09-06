import { loadProtectedEnvironmentFile } from '../../src/operator-environment';

/** Run before importing modules that snapshot network/database configuration. */
export function loadOperatorEnvironment(): void {
  const path = process.env.BTC_VAULT_OPERATOR_ENV_FILE;
  if (path) loadProtectedEnvironmentFile(path, { required: true });
  const network = process.env.VAULT_NETWORK;
  if ((network !== 'mainnet' && network !== 'signet') ||
      process.env.NEXT_PUBLIC_VAULT_NETWORK !== network) {
    throw new Error('operator requires explicit matching VAULT_NETWORK and NEXT_PUBLIC_VAULT_NETWORK');
  }
}
