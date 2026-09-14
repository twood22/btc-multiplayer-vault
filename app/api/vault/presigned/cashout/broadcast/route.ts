import { z } from 'zod';
import { queuePresignedCashout, submitPresignedCashout } from '@/web/lib/server/presigned-cashout-store';
import { readPresignedJson } from '@/web/lib/server/presigned-http';
import { withChainWatcherLease } from '@/web/lib/server/watcher-lease';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
export const runtime = 'nodejs';
const Input = z.object({ cashoutId: z.string().uuid() }).strict();
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const userId = await requireSessionUser();
    const { cashoutId } = Input.parse(await readPresignedJson(request));
    const queued = await queuePresignedCashout(userId, cashoutId);
    const submitted = await withChainWatcherLease(() => submitPresignedCashout(cashoutId));
    return Response.json(submitted.acquired ? submitted.value : { ...queued,
      reason: 'Your exact signed cash-out is retained; another private watcher is active, so this request did not refresh its last observed status.' }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return jsonError(error instanceof Error && error.message.startsWith('presigned-v2:') ? error
      : new Error('Cash-out submission could not be verified. Saved exact bytes remain available for retry.'));
  }
}
