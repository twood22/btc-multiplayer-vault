import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDatabaseRestoreReceipt,
  databaseEndpointFingerprint,
  readProtectedDatabaseRestoreReceipt,
  validateDatabaseRestoreReceipt,
  type DatabaseSnapshotEvidence,
} from '../../src/database-restore-receipt.js';
import { writeProtectedFile } from '../../src/operator-environment.js';

const checks: Array<{ name: string; ok: true }> = [];
const directory = mkdtempSync(join(tmpdir(), 'btc-vault-database-restore-'));
const createdAt = '2026-08-12T12:00:00.000Z';
const sourceUrl = 'postgresql://source-user:secret@db.example:5432/vault?sslmode=verify-full';
const sameSourceUrl = 'postgresql://other-user:other-secret@DB.EXAMPLE/vault?sslmode=disable';
const restoredUrl = 'postgresql://restore-user:secret@restore.example:5432/vault_restore?sslmode=verify-full';
const sourceFingerprint = databaseEndpointFingerprint(sourceUrl);
const restoredFingerprint = databaseEndpointFingerprint(restoredUrl);
const sourceIdentityFingerprint = '66'.repeat(32);
const restoredIdentityFingerprint = '77'.repeat(32);
const snapshot: DatabaseSnapshotEvidence = {
  postgresMajor: 16,
  migrationVersions: [
    '001_passkey_custody',
    '002_multi_passkey_recovery',
    '003_roster_ceremony',
  ],
  schemaDigest: '11'.repeat(32),
  tableCount: 31,
  totalRows: 87,
  stateDigest: '22'.repeat(32),
};
const comparisonChecks = [
  {
    name: 'source and restored databases are distinct protected endpoints and server-reported identities',
    ok: true,
  },
  { name: 'source and restored databases run PostgreSQL 16 or newer', ok: true },
  { name: 'source and restored databases contain the exact reviewed migration set', ok: true },
  { name: 'restored schema exactly matches the source schema', ok: true },
  { name: 'every restored application table exactly matches the source rows', ok: true },
];

try {
  assert.equal(databaseEndpointFingerprint(sameSourceUrl), sourceFingerprint);
  assert.notEqual(restoredFingerprint, sourceFingerprint);
  checks.push({
    name: 'endpoint fingerprints bind host, port, and database without retaining credentials or query parameters',
    ok: true,
  });

  const receipt = createDatabaseRestoreReceipt({
    createdAt,
    sourceEndpointFingerprint: sourceFingerprint,
    restoredEndpointFingerprint: restoredFingerprint,
    sourceDatabaseIdentityFingerprint: sourceIdentityFingerprint,
    restoredDatabaseIdentityFingerprint: restoredIdentityFingerprint,
    sourceSnapshot: snapshot,
    restoredSnapshot: { ...snapshot },
    checks: comparisonChecks,
  });
  assert.deepEqual(validateDatabaseRestoreReceipt(receipt), receipt);
  assert(!JSON.stringify(receipt).includes('secret'));
  assert(!JSON.stringify(receipt).includes('db.example'));
  checks.push({
    name: 'canonical restore evidence contains only endpoint fingerprints, counts, and database digests',
    ok: true,
  });

  assert.throws(
    () => createDatabaseRestoreReceipt({
      createdAt,
      sourceEndpointFingerprint: sourceFingerprint,
      restoredEndpointFingerprint: sourceFingerprint,
      sourceDatabaseIdentityFingerprint: sourceIdentityFingerprint,
      restoredDatabaseIdentityFingerprint: restoredIdentityFingerprint,
      sourceSnapshot: snapshot,
      restoredSnapshot: snapshot,
      checks: comparisonChecks,
    }),
    /distinct source and restored endpoints/u,
  );
  assert.throws(
    () => createDatabaseRestoreReceipt({
      createdAt,
      sourceEndpointFingerprint: sourceFingerprint,
      restoredEndpointFingerprint: restoredFingerprint,
      sourceDatabaseIdentityFingerprint: sourceIdentityFingerprint,
      restoredDatabaseIdentityFingerprint: sourceIdentityFingerprint,
      sourceSnapshot: snapshot,
      restoredSnapshot: snapshot,
      checks: comparisonChecks,
    }),
    /distinct server-reported database identities/u,
  );
  assert.throws(
    () => createDatabaseRestoreReceipt({
      createdAt,
      sourceEndpointFingerprint: sourceFingerprint,
      restoredEndpointFingerprint: restoredFingerprint,
      sourceDatabaseIdentityFingerprint: sourceIdentityFingerprint,
      restoredDatabaseIdentityFingerprint: restoredIdentityFingerprint,
      sourceSnapshot: snapshot,
      restoredSnapshot: { ...snapshot, stateDigest: '33'.repeat(32) },
      checks: comparisonChecks,
    }),
    /snapshots do not exactly match/u,
  );
  assert.throws(
    () => createDatabaseRestoreReceipt({
      createdAt,
      sourceEndpointFingerprint: sourceFingerprint,
      restoredEndpointFingerprint: restoredFingerprint,
      sourceDatabaseIdentityFingerprint: sourceIdentityFingerprint,
      restoredDatabaseIdentityFingerprint: restoredIdentityFingerprint,
      sourceSnapshot: snapshot,
      restoredSnapshot: snapshot,
      checks: comparisonChecks.map((item, index) => index === 4 ? { ...item, ok: false } : item),
    }),
    /every comparison check/u,
  );
  assert.throws(
    () => validateDatabaseRestoreReceipt({ ...receipt, unexpected: true }),
    /unexpected or missing fields/u,
  );
  assert.throws(
    () => validateDatabaseRestoreReceipt({
      ...receipt,
      sourceSnapshot: { ...snapshot, totalRows: 88 },
    }),
    /snapshots do not exactly match/u,
  );
  checks.push({
    name: 'same-endpoint, same-identity, mismatched-state, failed-check, and tampered receipts are rejected',
    ok: true,
  });

  const protectedDirectory = join(directory, 'protected');
  mkdirSync(protectedDirectory, { mode: 0o700 });
  const receiptPath = join(protectedDirectory, 'database-restore-receipt.json');
  writeProtectedFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const expected = {
    receiptDigest: receipt.receiptDigest,
    sourceEndpointFingerprint: sourceFingerprint,
    now: Date.parse(createdAt) + 60_000,
  };
  assert.deepEqual(readProtectedDatabaseRestoreReceipt(receiptPath, expected), receipt);
  assert.throws(
    () => readProtectedDatabaseRestoreReceipt(receiptPath, {
      ...expected,
      receiptDigest: '44'.repeat(32),
    }),
    /reviewed receipt digest/u,
  );
  assert.throws(
    () => readProtectedDatabaseRestoreReceipt(receiptPath, {
      ...expected,
      sourceEndpointFingerprint: '55'.repeat(32),
    }),
    /different production database endpoint/u,
  );
  assert.throws(
    () => readProtectedDatabaseRestoreReceipt(receiptPath, {
      ...expected,
      now: Date.parse(createdAt) + 25 * 60 * 60_000,
    }),
    /stale or dated in the future/u,
  );
  checks.push({
    name: 'the protected reader binds the reviewed digest, production endpoint, and 24-hour freshness window',
    ok: true,
  });

  const permissivePath = join(protectedDirectory, 'permissive.json');
  writeFileSync(permissivePath, readFileSync(receiptPath), { mode: 0o600 });
  chmodSync(permissivePath, 0o640);
  assert.throws(
    () => readProtectedDatabaseRestoreReceipt(permissivePath, expected),
    /must not be accessible by group or other users/u,
  );
  const linkedPath = join(protectedDirectory, 'linked.json');
  symlinkSync(receiptPath, linkedPath);
  assert.throws(
    () => readProtectedDatabaseRestoreReceipt(linkedPath, expected),
    /regular file, not a link/u,
  );
  checks.push({ name: 'linked and over-permissive restore receipts are rejected', ok: true });

  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
