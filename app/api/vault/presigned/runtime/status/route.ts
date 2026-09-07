import { getPresignedRuntimeStatus } from '@/web/lib/server/presigned-runtime-store';
import { getPresignedChainStatus } from '@/web/lib/server/presigned-chain-store';
import { presignedBroadcastEnabled } from '@/web/lib/server/presigned-broadcast-store';
import { jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
export const runtime = 'nodejs';
export async function GET() {
  try {
    const userId = await requireSessionUser();
    const [status, chain] = await Promise.all([getPresignedRuntimeStatus(userId), getPresignedChainStatus(userId)]);
    return Response.json({ ...status, chain, broadcastAvailable: presignedBroadcastEnabled() }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return jsonError(error); }
}
