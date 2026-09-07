import { z } from 'zod';
import { preparePresignedBroadcast, submitPresignedBroadcast } from '@/web/lib/server/presigned-broadcast-store';
import { withChainWatcherLease } from '@/web/lib/server/watcher-lease';
import { readPresignedJson } from '@/web/lib/server/presigned-http';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
export const runtime = 'nodejs';
const Input = z.object({ epochId: z.string().uuid(), proposalId: z.string().uuid().nullable() }).strict();
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await readPresignedJson(request));
    const prepared = await preparePresignedBroadcast({ ...input, userId: await requireSessionUser() });
    const submitted = await withChainWatcherLease(() => submitPresignedBroadcast(prepared.intentId));
    return Response.json(submitted.acquired ? submitted.value : { ...prepared, status: 'prepared',
      reason: 'Exact bytes are retained for the private watcher; another watcher is active.' }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return jsonError(error); }
}
