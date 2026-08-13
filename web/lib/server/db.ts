import 'server-only';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { assertDatabaseUrl } from '../database-config';

let client: Sql | undefined;

export function db(): Sql {
  if (client) return client;
  const url = assertDatabaseUrl(process.env.DATABASE_URL, {
    production: process.env.NODE_ENV === 'production',
  });
  client = postgres(url, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    transform: { undefined: null },
  });
  return client;
}

export async function transaction<T>(run: (sql: TransactionSql) => Promise<T>): Promise<T> {
  return db().begin(async (sql) => run(sql)) as Promise<T>;
}

/** Close the singleton pool when a one-shot private operator process finishes. */
export async function closeDatabase(): Promise<void> {
  const active = client;
  client = undefined;
  if (active) await active.end({ timeout: 5 });
}
