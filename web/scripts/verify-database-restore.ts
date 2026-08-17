import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import postgres from 'postgres';
import {
  createDatabaseRestoreReceipt,
  databaseEndpointFingerprint,
} from '../../src/database-restore-receipt.js';
import { writeProtectedFile } from '../../src/operator-environment.js';
import { assertReviewedNodeRuntime } from '../../src/runtime-version.js';
import { databaseEndpointCheck } from '../lib/database-config.js';
import {
  captureDatabaseRuntimeIdentity,
  captureDatabaseSnapshot,
  compareDatabaseSnapshots,
} from '../lib/database-snapshot.js';

assertReviewedNodeRuntime();
if (existsSync('.env.local')) loadEnvFile('.env.local');

const args = parseArgs(process.argv.slice(2));
const sourceUrl = requiredEnvironment('DATABASE_URL');
const restoredUrl = requiredEnvironment('RESTORED_DATABASE_URL');
for (const [label, url] of [['source', sourceUrl], ['restored', restoredUrl]] as const) {
  const endpoint = databaseEndpointCheck(url);
  if (!endpoint.ok) {
    throw new Error(`${label} database must be a non-local TLS endpoint with sslmode=verify-full`);
  }
}
const sourceEndpointFingerprint = databaseEndpointFingerprint(sourceUrl);
const restoredEndpointFingerprint = databaseEndpointFingerprint(restoredUrl);
if (sourceEndpointFingerprint === restoredEndpointFingerprint) {
  throw new Error('restored database endpoint must differ from the production source endpoint');
}

const source = postgres(sourceUrl, { max: 1, connect_timeout: 10, idle_timeout: 5 });
const restored = postgres(restoredUrl, { max: 1, connect_timeout: 10, idle_timeout: 5 });
try {
  const sourceIdentity = await captureDatabaseRuntimeIdentity(source);
  const restoredIdentity = await captureDatabaseRuntimeIdentity(restored);
  if (sourceIdentity.databaseName === restoredIdentity.databaseName ||
      sourceIdentity.fingerprint === restoredIdentity.fingerprint) {
    throw new Error(
      'restored database must report a different database name and server-side identity from the source',
    );
  }
  const sourceSnapshot = await captureDatabaseSnapshot(source);
  const restoredSnapshot = await captureDatabaseSnapshot(restored);
  const checks = [
    {
      name: 'source and restored databases are distinct protected endpoints and server-reported identities',
      ok: true,
    },
    ...compareDatabaseSnapshots(sourceSnapshot, restoredSnapshot),
  ];
  const failed = checks.filter((item) => !item.ok);
  if (failed.length) {
    throw new Error(`restored database comparison failed: ${failed.map((item) => item.name).join('; ')}`);
  }
  const receipt = createDatabaseRestoreReceipt({
    createdAt: new Date().toISOString(),
    sourceEndpointFingerprint,
    restoredEndpointFingerprint,
    sourceDatabaseIdentityFingerprint: sourceIdentity.fingerprint,
    restoredDatabaseIdentityFingerprint: restoredIdentity.fingerprint,
    sourceSnapshot,
    restoredSnapshot,
    checks,
  });
  const written = writeProtectedFile(args.outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({
    passed: true,
    receiptPath: written.path,
    reused: written.reused,
    receiptDigest: receipt.receiptDigest,
    sourceEndpointFingerprint,
    restoredEndpointFingerprint,
    sourceDatabaseIdentityFingerprint: sourceIdentity.fingerprint,
    restoredDatabaseIdentityFingerprint: restoredIdentity.fingerprint,
    tableCount: sourceSnapshot.tableCount,
    totalRows: sourceSnapshot.totalRows,
    checks: receipt.checks,
  }, null, 2));
} catch (error) {
  throw new Error(`database restore verification failed: ${safeDatabaseError(error)}`);
} finally {
  await Promise.allSettled([source.end({ timeout: 5 }), restored.end({ timeout: 5 })]);
}

function safeDatabaseError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'comparison failed';
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s]+/giu, '[database URL redacted]')
    .slice(0, 500);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseArgs(values: string[]): { outputPath: string } {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(
        'usage: --write-protected-receipt <path> ' +
        '--confirm-source-quiesced SOURCE_QUIESCED_FOR_BACKUP_RESTORE',
      );
    }
    const key = name.slice(2);
    if (!['write-protected-receipt', 'confirm-source-quiesced'].includes(key) || parsed[key]) {
      throw new Error(`unsupported or repeated database-restore argument: --${key}`);
    }
    parsed[key] = value;
  }
  if (parsed['confirm-source-quiesced'] !== 'SOURCE_QUIESCED_FOR_BACKUP_RESTORE') {
    throw new Error(
      '--confirm-source-quiesced must equal SOURCE_QUIESCED_FOR_BACKUP_RESTORE',
    );
  }
  if (!parsed['write-protected-receipt']) {
    throw new Error('--write-protected-receipt is required');
  }
  return { outputPath: parsed['write-protected-receipt'] };
}
