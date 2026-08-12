import 'server-only';
import postgres, { type Sql, type TransactionSql } from 'postgres';

let client: Sql | undefined;

export function db(): Sql {
  if (client) return client;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
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
