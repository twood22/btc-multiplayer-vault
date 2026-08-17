import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({
    ok: true,
    service: 'btc-multiplayer-vault',
    check: 'liveness',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
