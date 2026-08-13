import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type { DatabaseSnapshotEvidence } from '../../src/database-restore-receipt.js';
import { EXPECTED_MIGRATION_VERSIONS } from './migrations.js';

const TABLE_NAME = /^[a-z_][a-z0-9_]*$/u;
const MAX_CANONICAL_TABLE_BYTES = 64 * 1024 * 1024;

interface TableEvidence {
  name: string;
  rowCount: number;
  contentDigest: string;
}

export interface DatabaseRuntimeIdentity {
  databaseName: string;
  fingerprint: string;
}

export async function captureDatabaseRuntimeIdentity(sql: Sql): Promise<DatabaseRuntimeIdentity> {
  const rows = await sql<Array<{
    database_name: string;
    database_oid: string;
    server_address: string;
    server_port: string;
  }>>`
    SELECT current_database() AS database_name,
           (SELECT oid::text FROM pg_catalog.pg_database WHERE datname = current_database()) AS database_oid,
           COALESCE(inet_server_addr()::text, 'local-socket') AS server_address,
           COALESCE(inet_server_port()::text, 'local-socket') AS server_port
  `;
  const row = rows[0];
  if (!row?.database_name || !row.database_oid || !row.server_address || !row.server_port) {
    throw new Error('database did not return a complete server-side identity');
  }
  return {
    databaseName: row.database_name,
    fingerprint: digest(JSON.stringify(row)),
  };
}

/**
 * Capture a repeatable, read-only digest of every public application table and
 * the schema objects that enforce it. Raw rows never leave this process.
 */
export async function captureDatabaseSnapshot(sql: Sql): Promise<DatabaseSnapshotEvidence> {
  return sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
    const versions = await tx<Array<{ server_version_num: string }>>`
      SELECT current_setting('server_version_num') AS server_version_num
    `;
    const postgresMajor = Math.floor(Number(versions[0]?.server_version_num) / 10_000);
    if (!Number.isSafeInteger(postgresMajor) || postgresMajor < 16) {
      throw new Error('database restore verification requires PostgreSQL 16 or newer');
    }
    const migrations = await tx<Array<{ version: string }>>`
      SELECT version FROM schema_migrations ORDER BY version
    `;
    const migrationVersions = migrations.map((row) => row.version);
    const schemaDigest = await captureSchemaDigest(tx);
    const tableRows = await tx<Array<{ name: string }>>`
      SELECT tablename AS name
      FROM pg_catalog.pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `;
    if (!tableRows.length) throw new Error('database restore verification found no public application tables');
    const tables: TableEvidence[] = [];
    for (const { name } of tableRows) {
      if (!TABLE_NAME.test(name)) throw new Error('database contains an unsafe public table name');
      const quotedName = `"${name}"`;
      const rows = await tx.unsafe<Array<{ row_count: string; canonical_rows: string }>>(
        `SELECT count(*)::text AS row_count, ` +
        `COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb)::text AS canonical_rows ` +
        `FROM public.${quotedName} AS t`,
      );
      const canonicalRows = rows[0]?.canonical_rows ?? '[]';
      if (Buffer.byteLength(canonicalRows) > MAX_CANONICAL_TABLE_BYTES) {
        throw new Error(`database table ${name} exceeds the private-beta restore verification limit`);
      }
      const rowCount = Number(rows[0]?.row_count);
      if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
        throw new Error(`database table ${name} returned an invalid row count`);
      }
      tables.push({
        name,
        rowCount,
        contentDigest: digest(canonicalRows),
      });
    }
    const totalRows = tables.reduce((sum, table) => sum + table.rowCount, 0);
    const stateBody = {
      postgresMajor,
      migrationVersions,
      schemaDigest,
      tables,
    };
    return {
      postgresMajor,
      migrationVersions,
      schemaDigest,
      tableCount: tables.length,
      totalRows,
      stateDigest: digest(JSON.stringify(stateBody)),
    };
  }) as Promise<DatabaseSnapshotEvidence>;
}

export function compareDatabaseSnapshots(
  source: DatabaseSnapshotEvidence,
  restored: DatabaseSnapshotEvidence,
): Array<{ name: string; ok: boolean }> {
  return [
    {
      name: 'source and restored databases run PostgreSQL 16 or newer',
      ok: source.postgresMajor >= 16 && restored.postgresMajor >= 16,
    },
    {
      name: 'source and restored databases contain the exact reviewed migration set',
      ok: JSON.stringify(source.migrationVersions) === JSON.stringify(EXPECTED_MIGRATION_VERSIONS) &&
        JSON.stringify(restored.migrationVersions) === JSON.stringify(EXPECTED_MIGRATION_VERSIONS),
    },
    {
      name: 'restored schema exactly matches the source schema',
      ok: source.schemaDigest === restored.schemaDigest && source.tableCount === restored.tableCount,
    },
    {
      name: 'every restored application table exactly matches the source rows',
      ok: source.stateDigest === restored.stateDigest && source.totalRows === restored.totalRows,
    },
  ];
}

async function captureSchemaDigest(tx: TransactionSql): Promise<string> {
  const columns = await tx<Array<Record<string, unknown>>>`
    SELECT table_name, ordinal_position, column_name, data_type, udt_schema, udt_name,
           is_nullable, column_default, identity_generation, is_generated, generation_expression
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `;
  const constraints = await tx<Array<Record<string, unknown>>>`
    SELECT c.conrelid::regclass::text AS table_name, c.conname AS name,
           c.contype AS type, pg_get_constraintdef(c.oid, true) AS definition
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'public'
    ORDER BY table_name, name
  `;
  const indexes = await tx<Array<Record<string, unknown>>>`
    SELECT tablename AS table_name, indexname AS name, indexdef AS definition
    FROM pg_catalog.pg_indexes
    WHERE schemaname = 'public'
    ORDER BY tablename, indexname
  `;
  const triggers = await tx<Array<Record<string, unknown>>>`
    SELECT t.tgrelid::regclass::text AS table_name, t.tgname AS name,
           pg_get_triggerdef(t.oid, true) AS definition
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
    ORDER BY table_name, name
  `;
  const routines = await tx<Array<Record<string, unknown>>>`
    SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS arguments,
           pg_get_functiondef(p.oid) AS definition
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
    ORDER BY name, arguments
  `;
  const enums = await tx<Array<Record<string, unknown>>>`
    SELECT t.typname AS type_name, e.enumsortorder::text AS sort_order, e.enumlabel AS label
    FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
    WHERE n.nspname = 'public'
    ORDER BY type_name, e.enumsortorder
  `;
  const sequences = await tx<Array<Record<string, unknown>>>`
    SELECT sequencename AS name, data_type, start_value::text, min_value::text,
           max_value::text, increment_by::text, cycle, cache_size::text,
           last_value::text
    FROM pg_catalog.pg_sequences
    WHERE schemaname = 'public'
    ORDER BY sequencename
  `;
  const views = await tx<Array<Record<string, unknown>>>`
    SELECT viewname AS name, definition
    FROM pg_catalog.pg_views
    WHERE schemaname = 'public'
    ORDER BY viewname
  `;
  const policies = await tx<Array<Record<string, unknown>>>`
    SELECT tablename AS table_name, policyname AS name, permissive, roles, cmd,
           qual, with_check
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
    ORDER BY tablename, policyname
  `;
  const extensions = await tx<Array<Record<string, unknown>>>`
    SELECT e.extname AS name, e.extversion AS version
    FROM pg_catalog.pg_extension e
    ORDER BY e.extname
  `;
  return digest(JSON.stringify({
    columns,
    constraints,
    indexes,
    triggers,
    routines,
    enums,
    sequences,
    views,
    policies,
    extensions,
  }));
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
