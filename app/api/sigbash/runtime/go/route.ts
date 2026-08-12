import { createHash, timingSafeEqual } from 'node:crypto';
import { requireSessionUser } from '@/web/lib/server/session';
import { sigbashRuntimeConfig } from '@/web/lib/server/sigbash-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireSessionUser();
    const config = sigbashRuntimeConfig();
    const upstream = await fetch(config.wasmExecUrl, { cache: 'no-store' });
    if (!upstream.ok) throw new Error(`Sigbash Go runtime fetch failed (${upstream.status})`);
    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.length < 10_000 || body.length > 100_000) throw new Error('Sigbash Go runtime has an invalid size');
    const actual = createHash('sha384').update(body).digest();
    const expected = Buffer.from(config.wasmExecSha384, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error('Sigbash Go runtime integrity verification failed');
    }
    return new Response(body, {
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    return new Response('throw new Error("verified Sigbash Go runtime is unavailable");', {
      status: 503,
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  }
}
