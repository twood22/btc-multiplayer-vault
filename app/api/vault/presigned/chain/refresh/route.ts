import { getPresignedChainStatus, pollPresignedVaultChains } from '@/web/lib/server/presigned-chain-store';
import { withChainWatcherLease } from '@/web/lib/server/watcher-lease';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import { consumeRateLimit } from '@/web/lib/server/rate-limit';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const userId = await requireSessionUser();
    await consumeRateLimit({ action: 'presigned_chain_refresh', subject: userId, limit: 60, windowSeconds: 900 });
    const membership = await getPresignedChainStatus(userId);
    const result = await withChainWatcherLease(() => pollPresignedVaultChains({ vaultId: membership.vaultId }));
    return Response.json({ leaseAcquired: result.acquired, chain: await getPresignedChainStatus(userId),
      result: result.acquired ? result.value : null }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return jsonError(error); }
}
