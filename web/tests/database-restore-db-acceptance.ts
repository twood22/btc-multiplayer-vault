import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { EXPECTED_MIGRATION_FILES } from '../lib/migrations.js';
import {
  captureDatabaseRuntimeIdentity,
  captureDatabaseSnapshot,
  compareDatabaseSnapshots,
} from '../lib/database-snapshot.js';

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) throw new Error('DATABASE_URL is required for database restore acceptance');

const suffix = randomBytes(5).toString('hex');
const sourceName = `vault_restore_source_${suffix}`;
const restoredName = `vault_restore_copy_${suffix}`;
const sourceUrl = databaseUrl(sourceName);
const restoredUrl = databaseUrl(restoredName);
const admin = postgres(adminUrl, { max: 1 });
let source: ReturnType<typeof postgres> | undefined;
let restored: ReturnType<typeof postgres> | undefined;
const checks: Array<{ name: string; ok: true }> = [];

try {
  await admin.unsafe(`CREATE DATABASE "${sourceName}" TEMPLATE template0`);
  source = postgres(sourceUrl, { max: 1 });
  for (const file of EXPECTED_MIGRATION_FILES) {
    await source.unsafe(readFileSync(resolve('db/migrations', file), 'utf8'));
  }
  await source`
    INSERT INTO vaults (id, name)
    VALUES ('a1111111-1111-4111-8111-111111111111'::uuid, 'Restore acceptance vault')
  `;
  await source`
    INSERT INTO users (id, display_name)
    VALUES ('a2222222-2222-4222-8222-222222222222'::uuid, 'Restore Alice')
  `;
  await source`
    INSERT INTO vault_members (vault_id, user_id, participant_id)
    VALUES (
      'a1111111-1111-4111-8111-111111111111'::uuid,
      'a2222222-2222-4222-8222-222222222222'::uuid,
      'alice'
    )
  `;
  const sourceIdentity = await captureDatabaseRuntimeIdentity(source);
  const sourceSnapshot = await captureDatabaseSnapshot(source);
  await source.end({ timeout: 5 });
  source = undefined;

  await admin.unsafe(`CREATE DATABASE "${restoredName}" TEMPLATE "${sourceName}"`);
  restored = postgres(restoredUrl, { max: 1 });
  const restoredIdentity = await captureDatabaseRuntimeIdentity(restored);
  const restoredSnapshot = await captureDatabaseSnapshot(restored);
  assert.notEqual(restoredIdentity.databaseName, sourceIdentity.databaseName);
  assert.notEqual(restoredIdentity.fingerprint, sourceIdentity.fingerprint);
  assert.deepEqual(restoredSnapshot, sourceSnapshot);
  assert(compareDatabaseSnapshots(sourceSnapshot, restoredSnapshot).every((item) => item.ok));
  checks.push({
    name: 'a physical PostgreSQL database copy reproduces the complete reviewed schema and every application row',
    ok: true,
  });

  await restored`
    INSERT INTO users (id, display_name)
    VALUES ('a3333333-3333-4333-8333-333333333333'::uuid, 'Unexpected restored row')
  `;
  const changedSnapshot = await captureDatabaseSnapshot(restored);
  const changedChecks = compareDatabaseSnapshots(sourceSnapshot, changedSnapshot);
  assert(changedChecks.some((item) =>
    item.name === 'every restored application table exactly matches the source rows' && !item.ok));
  checks.push({
    name: 'one changed restored row changes the state digest and fails the exact-content comparison',
    ok: true,
  });

  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  await Promise.allSettled([
    source?.end({ timeout: 1 }),
    restored?.end({ timeout: 1 }),
  ]);
  for (const database of [restoredName, sourceName]) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => undefined);
  }
  await admin.end({ timeout: 5 });
}

function databaseUrl(name: string): string {
  const url = new URL(adminUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}
