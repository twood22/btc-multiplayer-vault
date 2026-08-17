import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { sha256Hex } from './crypto.js';
import { assertProtectedRegularFile } from './operator-environment.js';

export interface DatabaseSnapshotEvidence {
  postgresMajor: number;
  migrationVersions: string[];
  schemaDigest: string;
  tableCount: number;
  totalRows: number;
  stateDigest: string;
}

export interface DatabaseRestoreCheck {
  name: string;
  ok: true;
}

export interface DatabaseRestoreReceipt {
  version: 1;
  kind: 'production-database-backup-restore';
  createdAt: string;
  sourceEndpointFingerprint: string;
  restoredEndpointFingerprint: string;
  sourceDatabaseIdentityFingerprint: string;
  restoredDatabaseIdentityFingerprint: string;
  sourceSnapshot: DatabaseSnapshotEvidence;
  restoredSnapshot: DatabaseSnapshotEvidence;
  checks: DatabaseRestoreCheck[];
  receiptDigest: string;
}

const DIGEST = /^[0-9a-f]{64}$/u;
const MIGRATION = /^\d{3}_[a-z0-9_]+$/u;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REQUIRED_CHECKS = [
  'source and restored databases are distinct protected endpoints and server-reported identities',
  'source and restored databases run PostgreSQL 16 or newer',
  'source and restored databases contain the exact reviewed migration set',
  'restored schema exactly matches the source schema',
  'every restored application table exactly matches the source rows',
];

export function databaseEndpointFingerprint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('database endpoint is malformed');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname ||
      !url.pathname || url.pathname === '/') {
    throw new Error('database endpoint must identify one PostgreSQL database');
  }
  return sha256Hex(JSON.stringify({
    protocol: 'postgresql:',
    hostname: url.hostname.toLowerCase(),
    port: url.port || '5432',
    database: url.pathname,
  }));
}

export function createDatabaseRestoreReceipt(input: {
  createdAt: string;
  sourceEndpointFingerprint: string;
  restoredEndpointFingerprint: string;
  sourceDatabaseIdentityFingerprint: string;
  restoredDatabaseIdentityFingerprint: string;
  sourceSnapshot: DatabaseSnapshotEvidence;
  restoredSnapshot: DatabaseSnapshotEvidence;
  checks: Array<{ name: string; ok: boolean }>;
}): DatabaseRestoreReceipt {
  if (input.sourceEndpointFingerprint === input.restoredEndpointFingerprint) {
    throw new Error('database restore drill requires distinct source and restored endpoints');
  }
  if (input.sourceDatabaseIdentityFingerprint === input.restoredDatabaseIdentityFingerprint) {
    throw new Error('database restore drill requires distinct server-reported database identities');
  }
  if (!input.checks.length || input.checks.some((item) => !item.ok)) {
    throw new Error('database restore receipt requires every comparison check to pass');
  }
  const body = canonicalBody({
    version: 1,
    kind: 'production-database-backup-restore',
    createdAt: input.createdAt,
    sourceEndpointFingerprint: input.sourceEndpointFingerprint,
    restoredEndpointFingerprint: input.restoredEndpointFingerprint,
    sourceDatabaseIdentityFingerprint: input.sourceDatabaseIdentityFingerprint,
    restoredDatabaseIdentityFingerprint: input.restoredDatabaseIdentityFingerprint,
    sourceSnapshot: input.sourceSnapshot,
    restoredSnapshot: input.restoredSnapshot,
    checks: input.checks.map((item) => ({ name: item.name, ok: true })),
  });
  return validateDatabaseRestoreReceipt({
    ...body,
    receiptDigest: sha256Hex(JSON.stringify(body)),
  });
}

export function validateDatabaseRestoreReceipt(input: unknown): DatabaseRestoreReceipt {
  if (!isPlainObject(input)) throw new Error('database restore receipt is not an object');
  const allowed = [
    'version', 'kind', 'createdAt', 'sourceEndpointFingerprint',
    'restoredEndpointFingerprint', 'sourceDatabaseIdentityFingerprint',
    'restoredDatabaseIdentityFingerprint', 'sourceSnapshot',
    'restoredSnapshot', 'checks', 'receiptDigest',
  ];
  if (Object.keys(input).sort().join(',') !== [...allowed].sort().join(',')) {
    throw new Error('database restore receipt has unexpected or missing fields');
  }
  if (input.version !== 1 || input.kind !== 'production-database-backup-restore' ||
      typeof input.createdAt !== 'string' || !validIsoTimestamp(input.createdAt) ||
      typeof input.sourceEndpointFingerprint !== 'string' || !DIGEST.test(input.sourceEndpointFingerprint) ||
      typeof input.restoredEndpointFingerprint !== 'string' || !DIGEST.test(input.restoredEndpointFingerprint) ||
      input.sourceEndpointFingerprint === input.restoredEndpointFingerprint ||
      typeof input.sourceDatabaseIdentityFingerprint !== 'string' ||
      !DIGEST.test(input.sourceDatabaseIdentityFingerprint) ||
      typeof input.restoredDatabaseIdentityFingerprint !== 'string' ||
      !DIGEST.test(input.restoredDatabaseIdentityFingerprint) ||
      input.sourceDatabaseIdentityFingerprint === input.restoredDatabaseIdentityFingerprint ||
      typeof input.receiptDigest !== 'string' || !DIGEST.test(input.receiptDigest)) {
    throw new Error('database restore receipt has an invalid identity or endpoint binding');
  }
  const sourceSnapshot = validateSnapshot(input.sourceSnapshot, 'source');
  const restoredSnapshot = validateSnapshot(input.restoredSnapshot, 'restored');
  if (JSON.stringify(sourceSnapshot) !== JSON.stringify(restoredSnapshot)) {
    throw new Error('database restore receipt snapshots do not exactly match');
  }
  const checks = Array.isArray(input.checks) && input.checks.length > 0 && input.checks.every(validCheck)
    ? input.checks as DatabaseRestoreCheck[]
    : null;
  if (!checks || REQUIRED_CHECKS.some((prefix) =>
    !checks.some((item) => item.name.startsWith(prefix)))) {
    throw new Error('database restore receipt is missing a mandatory passing comparison');
  }
  const body = canonicalBody({
    version: 1,
    kind: 'production-database-backup-restore',
    createdAt: input.createdAt,
    sourceEndpointFingerprint: input.sourceEndpointFingerprint,
    restoredEndpointFingerprint: input.restoredEndpointFingerprint,
    sourceDatabaseIdentityFingerprint: input.sourceDatabaseIdentityFingerprint,
    restoredDatabaseIdentityFingerprint: input.restoredDatabaseIdentityFingerprint,
    sourceSnapshot,
    restoredSnapshot,
    checks,
  });
  if (sha256Hex(JSON.stringify(body)) !== input.receiptDigest) {
    throw new Error('database restore receipt digest does not match its canonical contents');
  }
  return { ...body, receiptDigest: input.receiptDigest };
}

export function readProtectedDatabaseRestoreReceipt(
  rawPath: string,
  expected: {
    receiptDigest: string;
    sourceEndpointFingerprint: string;
    now?: number;
    maxAgeMs?: number;
  },
): DatabaseRestoreReceipt {
  const receiptPath = resolve(rawPath);
  if (!existsSync(receiptPath)) throw new Error(`database restore receipt does not exist: ${receiptPath}`);
  assertProtectedRegularFile(receiptPath, 'database restore receipt');
  const parent = lstatSync(dirname(receiptPath));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) {
    throw new Error('database restore receipt parent must be a private real directory');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch {
    throw new Error('database restore receipt is not valid JSON');
  }
  const receipt = validateDatabaseRestoreReceipt(parsed);
  if (!DIGEST.test(expected.receiptDigest) || receipt.receiptDigest !== expected.receiptDigest) {
    throw new Error('database restore receipt does not match the reviewed receipt digest');
  }
  if (!DIGEST.test(expected.sourceEndpointFingerprint) ||
      receipt.sourceEndpointFingerprint !== expected.sourceEndpointFingerprint) {
    throw new Error('database restore receipt belongs to a different production database endpoint');
  }
  const now = expected.now ?? Date.now();
  const maxAge = expected.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const age = now - Date.parse(receipt.createdAt);
  if (!Number.isFinite(now) || !Number.isFinite(maxAge) || maxAge <= 0) {
    throw new Error('database restore receipt freshness policy is invalid');
  }
  if (!Number.isFinite(age) || age < 0 || age > maxAge) {
    throw new Error('database restore receipt is stale or dated in the future; run a fresh restore drill');
  }
  return receipt;
}

function canonicalBody(
  input: Omit<DatabaseRestoreReceipt, 'receiptDigest'>,
): Omit<DatabaseRestoreReceipt, 'receiptDigest'> {
  return {
    version: 1,
    kind: 'production-database-backup-restore',
    createdAt: input.createdAt,
    sourceEndpointFingerprint: input.sourceEndpointFingerprint,
    restoredEndpointFingerprint: input.restoredEndpointFingerprint,
    sourceDatabaseIdentityFingerprint: input.sourceDatabaseIdentityFingerprint,
    restoredDatabaseIdentityFingerprint: input.restoredDatabaseIdentityFingerprint,
    sourceSnapshot: canonicalSnapshot(input.sourceSnapshot),
    restoredSnapshot: canonicalSnapshot(input.restoredSnapshot),
    checks: input.checks.map((item) => ({ name: item.name, ok: true })),
  };
}

function validateSnapshot(input: unknown, label: string): DatabaseSnapshotEvidence {
  if (!isPlainObject(input)) throw new Error(`${label} database snapshot is not an object`);
  const keys = [
    'postgresMajor', 'migrationVersions', 'schemaDigest', 'tableCount',
    'totalRows', 'stateDigest',
  ];
  if (Object.keys(input).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error(`${label} database snapshot has unexpected or missing fields`);
  }
  if (typeof input.postgresMajor !== 'number' || !Number.isSafeInteger(input.postgresMajor) || input.postgresMajor < 16 ||
      !Array.isArray(input.migrationVersions) || input.migrationVersions.length === 0 ||
      !input.migrationVersions.every((item) => typeof item === 'string' && MIGRATION.test(item)) ||
      new Set(input.migrationVersions).size !== input.migrationVersions.length ||
      typeof input.schemaDigest !== 'string' || !DIGEST.test(input.schemaDigest) ||
      typeof input.tableCount !== 'number' || !Number.isSafeInteger(input.tableCount) || input.tableCount < 1 ||
      typeof input.totalRows !== 'number' || !Number.isSafeInteger(input.totalRows) || input.totalRows < 1 ||
      typeof input.stateDigest !== 'string' || !DIGEST.test(input.stateDigest)) {
    throw new Error(`${label} database snapshot is invalid`);
  }
  return canonicalSnapshot(input as unknown as DatabaseSnapshotEvidence);
}

function canonicalSnapshot(input: DatabaseSnapshotEvidence): DatabaseSnapshotEvidence {
  return {
    postgresMajor: input.postgresMajor,
    migrationVersions: [...input.migrationVersions],
    schemaDigest: input.schemaDigest,
    tableCount: input.tableCount,
    totalRows: input.totalRows,
    stateDigest: input.stateDigest,
  };
}

function validCheck(input: unknown): boolean {
  return isPlainObject(input) && Object.keys(input).sort().join(',') === 'name,ok' &&
    typeof input.name === 'string' && input.name.length >= 10 && input.name.length <= 300 &&
    input.ok === true;
}

function validIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
