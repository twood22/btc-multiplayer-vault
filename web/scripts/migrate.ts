import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import postgres from 'postgres';
import { assertDatabaseUrl } from '../lib/database-config';
import { EXPECTED_MIGRATION_FILES } from '../lib/migrations';

if (existsSync('.env.local')) loadEnvFile('.env.local');
const url = assertDatabaseUrl(process.env.DATABASE_URL, {
  production: process.env.NODE_ENV === 'production',
});
const sql = postgres(url, { max: 1 });
try {
  await sql`SELECT pg_advisory_lock(713714794042931745::bigint)`;
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  const migrationFiles = readdirSync(resolve('db/migrations'))
    .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/u.test(file))
    .sort();
  if (JSON.stringify(migrationFiles) !== JSON.stringify(EXPECTED_MIGRATION_FILES)) {
    throw new Error('database migration files do not match the reviewed deployment manifest');
  }
  for (const file of migrationFiles) {
    const version = basename(file, '.sql');
    const applied = await sql`
      SELECT 1 FROM schema_migrations WHERE version = ${version}
    `;
    if (applied.length) {
      console.log(`${file} already applied`);
      continue;
    }
    const migration = readFileSync(resolve('db/migrations', file), 'utf8');
    await sql.unsafe(migration);
    console.log(`Applied ${file}`);
  }
} finally {
  await sql`SELECT pg_advisory_unlock(713714794042931745::bigint)`.catch(() => undefined);
  await sql.end();
}
