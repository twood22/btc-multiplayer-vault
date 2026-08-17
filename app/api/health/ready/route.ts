import { NextResponse } from 'next/server';
import { EXPECTED_MIGRATION_VERSIONS } from '../../../../web/lib/migrations';
import { db } from '../../../../web/lib/server/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const migrations = await db()<Array<{ version: string }>>`
      SELECT version FROM schema_migrations ORDER BY version
    `;
    const applied = migrations.map((row) => row.version);
    const ok = JSON.stringify(applied) === JSON.stringify(EXPECTED_MIGRATION_VERSIONS);
    return NextResponse.json({
      ok,
      service: 'btc-multiplayer-vault',
      check: 'operational-readiness',
      database: 'reachable',
      migrations: {
        applied: applied.length,
        expected: EXPECTED_MIGRATION_VERSIONS.length,
      },
      fundingAuthorized: false,
    }, {
      status: ok ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({
      ok: false,
      service: 'btc-multiplayer-vault',
      check: 'operational-readiness',
      database: 'unavailable',
      fundingAuthorized: false,
    }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
