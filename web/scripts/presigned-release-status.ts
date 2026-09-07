import { loadProtectedEnvironmentFile } from '../../src/operator-environment.js';
import { assertReviewedNodeRuntime } from '../../src/runtime-version.js';

assertReviewedNodeRuntime();
// Parse the required identity before loading operational files or importing any
// module whose typed network constants are selected during module evaluation.
const args = process.argv.slice(2);
if (!args.includes('--vault-id')) throw new Error('--vault-id is required');
if (!args.includes('--epoch-id')) throw new Error('--epoch-id is required');
if (process.env.BTC_VAULT_ENV_FILE) loadProtectedEnvironmentFile(process.env.BTC_VAULT_ENV_FILE, { required: true });
if (!['mainnet','signet'].includes(process.env.VAULT_NETWORK ?? '') || process.env.NEXT_PUBLIC_VAULT_NETWORK !== process.env.VAULT_NETWORK)
  throw new Error('explicit matching VAULT_NETWORK and NEXT_PUBLIC_VAULT_NETWORK are required');
await import('./presigned-release-status-main.js');
