import { resolve } from 'node:path';
import { loadProtectedEnvironmentFile, writeProtectedFile } from '../../src/operator-environment.js';
import { assertReviewedNodeRuntime } from '../../src/runtime-version.js';
import { databaseEndpointFingerprint } from '../../src/database-restore-receipt.js';
import { assert, identifier } from '../../src/presigned/validation.js';

assertReviewedNodeRuntime();
const args = process.argv.slice(2); const flags = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  const name = args[i]!; const value = args[i + 1];
  assert(['--vault-id', '--epoch-id', '--write-protected-receipt', '--write-database-receipt', '--confirm-source-quiesced'].includes(name) &&
    value && !value.startsWith('--') && !flags.has(name), 'invalid or repeated V2 restore verification argument');
  flags.set(name, value);
}
const vaultId = flags.get('--vault-id')!; const epochId = flags.get('--epoch-id')!;
identifier(vaultId, 'restore vault'); identifier(epochId, 'restore epoch');
assert(flags.get('--confirm-source-quiesced') === 'SOURCE_QUIESCED_FOR_BACKUP_RESTORE', 'explicit source-quiescence acknowledgement is required');
const output = flags.get('--write-protected-receipt'); const databaseOutput = flags.get('--write-database-receipt');
assert(output && databaseOutput && resolve(output) !== resolve(databaseOutput), 'two distinct protected receipt output paths are required');
// No ambient dotenv loading, default database, automatic backup, SQL writes,
// service pause or restore operation. The user supplies exact protected URLs.
if (process.env.BTC_VAULT_ENV_FILE) loadProtectedEnvironmentFile(process.env.BTC_VAULT_ENV_FILE, { required: true });
assert(['mainnet', 'signet'].includes(process.env.VAULT_NETWORK ?? '') && process.env.NEXT_PUBLIC_VAULT_NETWORK === process.env.VAULT_NETWORK,
  'matching explicit browser/runtime networks are required');
const [{ default: postgres }, { databaseEndpointCheck }, { verifyPresignedFundingDatabaseRestore }] = await Promise.all([
  import('postgres'), import('../lib/database-config.js'), import('../lib/presigned-funding-restore.js')]);
const sourceUrl = process.env.DATABASE_URL; const restoredUrl = process.env.RESTORED_DATABASE_URL;
assert(sourceUrl && restoredUrl && databaseEndpointCheck(sourceUrl).ok && databaseEndpointCheck(restoredUrl).ok,
  'both exact database endpoints must use non-local verified TLS');
const source = postgres(sourceUrl, { max: 1, connect_timeout: 10, idle_timeout: 5, onnotice: () => {} });
const restored = postgres(restoredUrl, { max: 1, connect_timeout: 10, idle_timeout: 5, onnotice: () => {} });
try {
  const receipt = await verifyPresignedFundingDatabaseRestore({ source, restored, vaultId, epochId,
    sourceEndpointFingerprint: databaseEndpointFingerprint(sourceUrl), restoredEndpointFingerprint: databaseEndpointFingerprint(restoredUrl) });
  assert(receipt.sourceFunding.network === process.env.VAULT_NETWORK, 'restored funding has another explicit network');
  writeProtectedFile(databaseOutput, `${JSON.stringify(receipt.databaseRestore, null, 2)}\n`);
  writeProtectedFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, protocol: receipt.protocol, vaultId, epochId,
    fundingRestoreReceiptDigest: receipt.receiptDigest, databaseRestoreReceiptDigest: receipt.databaseRestore.receiptDigest,
    graphDigest: receipt.sourceFunding.graphDigest, fundingTxid: receipt.sourceFunding.fundingTxid,
    fundingAllowed: false, physicalPasskeysProven: false }));
} catch {
  console.error('V2 database/funding restore verification failed. Private rows and connection details are redacted; no funding authority was issued.');
  process.exitCode = 1;
} finally { await Promise.allSettled([source.end({ timeout: 5 }), restored.end({ timeout: 5 })]); }
