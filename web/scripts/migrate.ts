import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import postgres from 'postgres';

if (existsSync('.env.local')) loadEnvFile('.env.local');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const sql = postgres(url, { max: 1 });
try {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  const applied = await sql`
    SELECT 1 FROM schema_migrations WHERE version = '001_passkey_custody'
  `;
  if (applied.length) {
    console.log('001_passkey_custody.sql already applied');
    process.exitCode = 0;
  } else {
  const migration = readFileSync(resolve('db/migrations/001_passkey_custody.sql'), 'utf8');
  await sql.unsafe(migration);
  console.log('Applied 001_passkey_custody.sql');
  }
} finally {
  await sql.end();
}
